//! Executable specs for a SKETCH IN A GROUP.
//!
//! A world sketch can sit in a group: a plan grouped with the walls drawn
//! over it. The membership is recorded on the sketch alone — a group's stored
//! member list never names one — so a sketch that is consumed or deleted
//! drops out of its group and returns to it through undo with nothing to
//! splice.
//!
//! Sections:
//!
//! 1. Into and out of a group: reparent, group, ungroup, each exact on undo.
//! 2. Deleting the group takes the sketch; a consumed sketch comes back in.
//! 3. Editing the group: the sketch surfaces with the members and returns.
//! 4. The ops that cannot carry a sketch refuse the whole group.
//! 5. Persistence: manifest v19, written only when grouped, gated one way.
//! 6. The group carries its sketches: move, duplicate, array copy.

use std::io::{Cursor, Read, Write};

use std::num::NonZeroU32;

use kernel::{
    BooleanOp, Document, DocumentError, GroupId, LoadError, NodeId, ObjectId, Plane, Point3,
    SketchId, Transform, Vec3,
};

// ----------------------------------------------------------------- helpers

/// The ground (z = 0) plane.
fn ground() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane is well-defined")
}

/// A fresh ground sketch carrying one axis-aligned rectangle.
fn rect_sketch(doc: &mut Document, x0: f64, y0: f64, x1: f64, y1: f64) -> SketchId {
    let s = doc.add_sketch(ground());
    let sk = doc.sketch_mut(s).expect("sketch is live and unlocked");
    for (a, b) in [
        (Point3::new(x0, y0, 0.0), Point3::new(x1, y0, 0.0)),
        (Point3::new(x1, y0, 0.0), Point3::new(x1, y1, 0.0)),
        (Point3::new(x1, y1, 0.0), Point3::new(x0, y1, 0.0)),
        (Point3::new(x0, y1, 0.0), Point3::new(x0, y0, 0.0)),
    ] {
        sk.add_segment(a, b).expect("rectangle segment");
    }
    s
}

/// A unit box standing at `x`, born from its own sketch.
fn a_box(doc: &mut Document, x: f64) -> ObjectId {
    let s = rect_sketch(doc, x, 0.0, x + 1.0, 1.0);
    let r = doc.extrudable_regions(s).unwrap()[0];
    doc.extrude_region(s, r, 1.0).expect("box").0
}

/// Two boxes in a group, and a plan drawn beside them at the top level.
fn walls_and_a_plan() -> (Document, GroupId, [ObjectId; 2], SketchId) {
    let mut doc = Document::new();
    let a = a_box(&mut doc, 0.0);
    let b = a_box(&mut doc, 2.0);
    let (g, _) = doc
        .group_nodes(&[NodeId::Object(a), NodeId::Object(b)])
        .expect("walls group");
    let plan = rect_sketch(&mut doc, 5.0, 5.0, 8.0, 8.0);
    (doc, g, [a, b], plan)
}

/// The same, with the plan already moved into the group.
fn walls_holding_a_plan() -> (Document, GroupId, [ObjectId; 2], SketchId) {
    let (mut doc, g, walls, plan) = walls_and_a_plan();
    doc.reparent_nodes(&[NodeId::Sketch(plan)], Some(g))
        .expect("the plan moves into the group");
    (doc, g, walls, plan)
}

/// Asserts `op` undoes to exactly the state before it and redoes to exactly
/// the state after it.
fn undoes_exactly(doc: &mut Document, what: &str, op: impl FnOnce(&mut Document)) {
    let before = doc.state_hash();
    op(doc);
    let after = doc.state_hash();
    assert_ne!(before, after, "{what} changed the saved document");
    doc.undo().expect("undo");
    assert_eq!(doc.state_hash(), before, "{what} undoes exactly");
    doc.redo().expect("redo");
    assert_eq!(doc.state_hash(), after, "{what} redoes exactly");
}

// ============================================ 1. into and out of a group

#[test]
fn a_sketch_moves_into_a_group_and_the_group_lists_it_last() {
    let (mut doc, g, [a, b], plan) = walls_and_a_plan();

    undoes_exactly(&mut doc, "reparent_nodes", |d| {
        d.reparent_nodes(&[NodeId::Sketch(plan)], Some(g)).unwrap();
    });

    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));
    assert_eq!(doc.group_sketches(g), vec![plan]);
    assert_eq!(
        doc.group_members(g).unwrap(),
        vec![NodeId::Object(a), NodeId::Object(b), NodeId::Sketch(plan)],
        "members in their stored order, then the group's sketches"
    );
    assert!(doc.sketch_ids().contains(&plan), "and it is still a sketch");
}

#[test]
fn a_sketch_moves_back_out_to_the_top_level() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();

    undoes_exactly(&mut doc, "reparent_nodes out", |d| {
        d.reparent_nodes(&[NodeId::Sketch(plan)], None).unwrap();
    });

    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), None);
    assert!(doc.group_sketches(g).is_empty());
}

#[test]
fn a_box_and_a_sketch_group_together() {
    let mut doc = Document::new();
    let o = a_box(&mut doc, 0.0);
    let plan = rect_sketch(&mut doc, 5.0, 5.0, 8.0, 8.0);

    let mut group = None;
    undoes_exactly(&mut doc, "group_nodes", |d| {
        group = Some(
            d.group_nodes(&[NodeId::Object(o), NodeId::Sketch(plan)])
                .unwrap()
                .0,
        );
    });
    let g = group.unwrap();

    assert_eq!(
        doc.group_members(g).unwrap(),
        vec![NodeId::Object(o), NodeId::Sketch(plan)]
    );
    assert_eq!(doc.top_level_nodes(), vec![NodeId::Group(g)]);
}

/// A group of sketches alone is a group: nothing in its stored member list,
/// and still live, listed and nestable.
#[test]
fn sketches_alone_make_a_group_and_it_nests() {
    let (mut doc, walls, _, plan) = walls_holding_a_plan();
    let upstairs = rect_sketch(&mut doc, 5.0, 10.0, 8.0, 13.0);
    doc.reparent_nodes(&[NodeId::Sketch(upstairs)], Some(walls))
        .unwrap();

    let mut group = None;
    undoes_exactly(&mut doc, "group_nodes (sketches only)", |d| {
        group = Some(
            d.group_nodes(&[NodeId::Sketch(plan), NodeId::Sketch(upstairs)])
                .unwrap()
                .0,
        );
    });
    let plans = group.unwrap();

    assert_eq!(doc.node_parent(NodeId::Group(plans)), Some(walls));
    assert_eq!(
        doc.group_members(plans).unwrap(),
        vec![NodeId::Sketch(plan), NodeId::Sketch(upstairs)]
    );
    assert!(
        doc.group_members(walls)
            .unwrap()
            .contains(&NodeId::Group(plans))
    );
}

#[test]
fn grouping_across_parents_is_still_refused() {
    let (mut doc, _, [a, _], plan) = walls_and_a_plan();
    assert_eq!(
        doc.group_nodes(&[NodeId::Object(a), NodeId::Sketch(plan)])
            .unwrap_err(),
        DocumentError::MixedParents
    );
}

#[test]
fn ungrouping_releases_the_sketch_to_the_groups_parent() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();

    undoes_exactly(&mut doc, "ungroup", |d| {
        d.ungroup(g).unwrap();
    });

    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), None);
    assert!(doc.sketch(plan).is_some());
}

// ===================================== 2. delete, consume, and coming back

#[test]
fn deleting_the_group_takes_the_sketch_and_undo_returns_it_inside() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();

    undoes_exactly(&mut doc, "delete_node", |d| {
        d.delete_node(NodeId::Group(g)).unwrap();
    });
    assert!(doc.sketch(plan).is_none(), "the plan went with its group");

    doc.undo().expect("undo the delete");
    assert!(doc.sketch(plan).is_some());
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));
}

#[test]
fn a_deleted_sketch_leaves_its_group_and_undo_returns_it_inside() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();

    undoes_exactly(&mut doc, "delete_sketch", |d| {
        d.delete_sketch(plan).unwrap();
    });
    assert!(doc.group_sketches(g).is_empty());

    doc.undo().expect("undo the delete");
    assert_eq!(doc.group_sketches(g), vec![plan]);
}

/// An unlocked sketch is consumed by the extrusion that empties it. Inside a
/// group that is the same event: it drops out, and undo puts it back in.
#[test]
fn a_consumed_sketch_leaves_its_group_and_undo_returns_it_inside() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    let region = doc.extrudable_regions(plan).unwrap()[0];

    doc.extrude_region(plan, region, 1.0)
        .expect("extrude the plan");
    assert!(doc.sketch(plan).is_none(), "the extrusion consumed it");
    assert!(doc.group_sketches(g).is_empty());

    doc.undo().expect("undo the extrusion");
    assert_eq!(doc.group_sketches(g), vec![plan]);
}

// ================================================ 3. editing the group

/// Entering a group lifts its members to the top level for the session; the
/// plan comes up with them and goes back in when the session closes.
#[test]
fn a_group_session_surfaces_the_sketch_and_returns_it() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    let closed = doc.state_hash();

    doc.open_group_session(g).expect("enter the group");
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), None);
    assert!(
        doc.session_direct_members()
            .unwrap()
            .contains(&NodeId::Sketch(plan)),
        "the plan is session content"
    );

    doc.close_group_session().expect("leave the group");
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));
    assert_eq!(doc.state_hash(), closed, "in and out changes nothing saved");

    doc.undo().expect("undo the close");
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), None);
    doc.undo().expect("undo the open");
    assert_eq!(doc.node_parent(NodeId::Sketch(plan)), Some(g));
    doc.redo().expect("redo the open");
    doc.redo().expect("redo the close");
    assert_eq!(doc.state_hash(), closed);
}

/// A group whose walls are all deleted mid-session still holds its plan, so
/// it survives the close.
#[test]
fn a_group_left_holding_only_its_sketch_survives_the_session() {
    let (mut doc, g, [a, b], plan) = walls_holding_a_plan();

    doc.open_group_session(g).unwrap();
    doc.delete_node(NodeId::Object(a)).unwrap();
    doc.delete_node(NodeId::Object(b)).unwrap();
    doc.close_group_session().unwrap();

    assert_eq!(doc.group_members(g).unwrap(), vec![NodeId::Sketch(plan)]);
}

// ===================================== 4. ops that cannot carry a sketch

/// Asserts `op` refuses with `SketchNodeUnsupported` and changes nothing the
/// saved document records.
fn refuses_untouched<T: std::fmt::Debug>(
    doc: &mut Document,
    what: &str,
    op: impl FnOnce(&mut Document) -> Result<T, DocumentError>,
) {
    let before = doc.state_hash();
    assert_eq!(
        op(doc).unwrap_err(),
        DocumentError::SketchNodeUnsupported,
        "{what} refuses a group holding a sketch, typed"
    );
    assert_eq!(doc.state_hash(), before, "{what} left the document alone");
}

/// A boolean consumes its operands. It refuses a group holding a plan rather
/// than union the walls and drop the plan on the floor. (Make Component
/// takes the plan along — `sketch_component_specs.rs`.)
#[test]
fn a_boolean_refuses_a_group_holding_a_sketch() {
    let (mut doc, g, _, _) = walls_holding_a_plan();
    let other = a_box(&mut doc, 0.5);

    refuses_untouched(&mut doc, "boolean_nodes", |d| {
        d.boolean_nodes(BooleanOp::Union, NodeId::Group(g), NodeId::Object(other))
    });
}

#[test]
fn library_extract_refuses_a_group_holding_a_sketch() {
    let (mut doc, g, _, _) = walls_holding_a_plan();
    refuses_untouched(&mut doc, "extract_item", |d| {
        d.extract_item(&[NodeId::Group(g)], false).map(|_| ())
    });
}

// ======================================================== 5. persistence

fn manifest_json(bytes: &[u8]) -> serde_json::Value {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut buf = Vec::new();
    zip.by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut buf)
        .unwrap();
    serde_json::from_slice(&buf).unwrap()
}

/// Re-write `manifest.json` inside `.hew` bytes through `edit`.
fn patch_manifest(bytes: &[u8], edit: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
    let mut manifest = manifest_json(bytes);
    edit(&mut manifest);
    let patched = serde_json::to_vec_pretty(&manifest).unwrap();

    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .last_modified_time(zip::DateTime::default());
    out.start_file("manifest.json", opts).unwrap();
    out.write_all(&patched).unwrap();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).unwrap();
        if entry.name() == "manifest.json" {
            continue;
        }
        let name = entry.name().to_string();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        out.start_file(name, opts).unwrap();
        out.write_all(&data).unwrap();
    }
    out.finish().unwrap().into_inner()
}

#[test]
fn a_grouped_sketch_round_trips_inside_its_group() {
    let (doc, _, _, _) = walls_holding_a_plan();

    let loaded = Document::load(&doc.save()).expect("v19 loads");
    let g = match loaded.top_level_nodes()[..] {
        [NodeId::Group(g)] => g,
        ref other => panic!("expected the one group, got {other:?}"),
    };
    let plan = loaded.sketch_ids()[0];
    assert_eq!(loaded.group_sketches(g), vec![plan]);
    assert_eq!(loaded.node_parent(NodeId::Sketch(plan)), Some(g));
    assert_eq!(loaded.save(), doc.save(), "and saves back byte-identical");
}

/// The membership is written on the sketch alone: the group's member list
/// and the roots name no sketch, and a top-level sketch writes no key.
#[test]
fn the_parent_is_written_on_the_sketch_and_only_when_grouped() {
    let (doc, _, _, _) = walls_and_a_plan();
    let loose = manifest_json(&doc.save());
    assert_eq!(loose["format_version"], kernel::MANIFEST_FORMAT_VERSION);
    assert!(loose["sketches"][0].get("parent").is_none());

    let (doc, _, _, _) = walls_holding_a_plan();
    let grouped = manifest_json(&doc.save());
    assert_eq!(grouped["sketches"][0]["parent"], 0);
    assert_eq!(grouped["groups"], loose["groups"]);
    assert_eq!(grouped["roots"], loose["roots"]);
}

/// Gated one way: a v18 manifest carrying a sketch parent is malformed for
/// its own declared version and rejected, never honored.
#[test]
fn a_sketch_parent_smuggled_into_a_v18_manifest_is_rejected() {
    let (doc, _, _, _) = walls_holding_a_plan();
    let v18 = patch_manifest(&doc.save(), |m| m["format_version"] = 18.into());
    assert!(matches!(
        Document::load(&v18),
        Err(LoadError::MalformedManifest { .. })
    ));
}

#[test]
fn a_v18_file_loads_with_every_sketch_at_the_top_level() {
    let (doc, _, _, _) = walls_and_a_plan();
    let v18 = patch_manifest(&doc.save(), |m| m["format_version"] = 18.into());

    let loaded = Document::load(&v18).expect("an honest v18 file loads");
    let plan = loaded.sketch_ids()[0];
    assert_eq!(loaded.node_parent(NodeId::Sketch(plan)), None);
}

#[test]
fn a_parent_that_names_no_group_is_rejected() {
    let (doc, _, _, _) = walls_holding_a_plan();
    let dangling = patch_manifest(&doc.save(), |m| m["sketches"][0]["parent"] = 7.into());
    assert!(matches!(
        Document::load(&dangling),
        Err(LoadError::DanglingReference { .. })
    ));
}

// ================================== 6. the group carries its sketches

/// The least x any vertex of `sketch` sits at.
fn min_x(doc: &Document, sketch: SketchId) -> f64 {
    doc.sketch(sketch)
        .expect("sketch is live")
        .vertices()
        .values()
        .map(|v| v.position.x)
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn moving_the_group_moves_the_sketch_it_holds() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    let t = Transform::translation(Vec3::new(10.0, 0.0, 0.0));

    undoes_exactly(&mut doc, "transform_group", |d| {
        d.transform_group(g, &t).unwrap();
    });

    assert_eq!(min_x(&doc, plan), 15.0, "the plan went with its walls");
    assert_eq!(doc.leaf_sketches_under(NodeId::Group(g)), vec![plan]);
}

/// A plan in a nested group rides a move of the outer one, and a sketch both
/// held by a listed group and listed by hand moves once, not twice.
#[test]
fn a_selection_move_carries_nested_sketches_once() {
    let (mut doc, walls, _, plan) = walls_holding_a_plan();
    let (plans, _) = doc.group_nodes(&[NodeId::Sketch(plan)]).unwrap();
    assert_eq!(doc.node_parent(NodeId::Group(plans)), Some(walls));
    let t = Transform::translation(Vec3::new(10.0, 0.0, 0.0));

    undoes_exactly(&mut doc, "transform_selection", |d| {
        d.transform_selection(&[NodeId::Group(walls)], &[plan], &t)
            .unwrap();
    });

    assert_eq!(min_x(&doc, plan), 15.0);
}

/// A locked plan is a drawing to build from, not stock — it still moves with
/// the group that holds it.
#[test]
fn a_locked_sketch_moves_with_its_group() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    doc.set_sketch_locked(plan, true).unwrap();

    doc.transform_group(g, &Transform::translation(Vec3::new(10.0, 0.0, 0.0)))
        .unwrap();

    assert_eq!(min_x(&doc, plan), 15.0);
}

/// A sketch cannot be mirrored, so a mirroring move of the group refuses as a
/// whole rather than flip the walls and leave the plan behind.
#[test]
fn a_move_the_sketch_cannot_follow_refuses_and_touches_nothing() {
    let (mut doc, g, _, _) = walls_holding_a_plan();
    let before = doc.state_hash();
    let mirror = Transform::from_affine(&[
        -1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0,
    ]);

    assert!(matches!(
        doc.transform_group(g, &mirror),
        Err(DocumentError::Transform(_))
    ));
    assert_eq!(doc.state_hash(), before);
}

#[test]
fn duplicating_the_group_copies_the_sketch_into_the_copy() {
    let (mut doc, g, _, plan) = walls_holding_a_plan();
    doc.set_node_name(NodeId::Sketch(plan), Some("Ground floor".to_string()))
        .unwrap();
    doc.set_sketch_locked(plan, true).unwrap();
    let step = Transform::translation(Vec3::new(0.0, 20.0, 0.0));

    let mut copy = None;
    undoes_exactly(&mut doc, "duplicate_node", |d| {
        copy = Some(d.duplicate_node(NodeId::Group(g), &step).unwrap().0);
    });
    let NodeId::Group(copy) = copy.unwrap() else {
        panic!("a group duplicates to a group");
    };

    let [plan_copy] = doc.group_sketches(copy)[..] else {
        panic!("the copy holds one sketch");
    };
    assert_ne!(plan_copy, plan);
    assert_eq!(
        doc.group_sketches(g),
        vec![plan],
        "the source keeps its own"
    );
    assert_eq!(doc.sketch_name(plan_copy), Some("Ground floor"));
    assert!(doc.is_sketch_locked(plan_copy));
    assert_eq!(min_x(&doc, plan_copy), min_x(&doc, plan));
    let y = |s: SketchId| {
        doc.sketch(s)
            .unwrap()
            .vertices()
            .values()
            .map(|v| v.position.y)
            .fold(f64::INFINITY, f64::min)
    };
    assert_eq!(y(plan_copy), y(plan) + 20.0);
}

#[test]
fn an_array_copy_carries_the_sketch_into_every_copy() {
    let (mut doc, g, _, _) = walls_holding_a_plan();
    let step = Transform::translation(Vec3::new(0.0, 20.0, 0.0));

    let mut copies = Vec::new();
    undoes_exactly(&mut doc, "duplicate_nodes_array", |d| {
        copies = d
            .duplicate_nodes_array(&[NodeId::Group(g)], &step, NonZeroU32::new(3).unwrap())
            .unwrap()
            .0;
    });

    assert_eq!(copies.len(), 3);
    for c in copies {
        let NodeId::Group(c) = c else {
            panic!("a group duplicates to a group");
        };
        assert_eq!(doc.group_sketches(c).len(), 1);
    }
    assert_eq!(doc.sketch_ids().len(), 4, "the plan and its three copies");
}

/// A copy the placement cannot reach leaves nothing behind — not the group
/// shell, not the boxes, not a half-made sketch.
#[test]
fn a_refused_duplicate_leaves_no_trace() {
    let (mut doc, g, _, _) = walls_holding_a_plan();
    let before = doc.state_hash();
    let sketches_before = doc.sketch_ids();
    let mirror = Transform::from_affine(&[
        -1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0,
    ]);

    assert!(doc.duplicate_node(NodeId::Group(g), &mirror).is_err());
    assert_eq!(doc.state_hash(), before);
    assert_eq!(doc.sketch_ids(), sketches_before);
}
