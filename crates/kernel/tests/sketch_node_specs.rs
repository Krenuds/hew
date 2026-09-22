//! Executable specs for the SKETCH NODE: `NodeId::Sketch`.
//!
//! A sketch is a node — the unit a name, tags and visibility hang on. It can
//! sit in a group (`sketch_in_group_specs.rs`), but `top_level_nodes` does
//! not return it and no stored member list names it. The ops that cannot
//! carry one refuse it with a typed `SketchNodeUnsupported` and leave the
//! document untouched.
//!
//! Sections:
//!
//! 1. What a sketch node answers: liveness, parent, leaves.
//! 2. The ops that cannot carry it refuse, touching nothing.
//! 3. The sketch-specific paths are unaffected.
//! 4. Name, tags and user-hidden: set, undone, swept with the tag registry.
//! 5. Persistence: written only when set, gated one way at manifest v18.
//! 6. Name and tags ride every whole-sketch copy.
//! 7. Scenes capture and restore a hidden sketch.

use std::io::{Cursor, Read, Write};
use std::num::NonZeroU32;

use kernel::{
    Anchor, BooleanOp, Document, DocumentError, LoadError, NodeId, ObjectId, Plane, Point3,
    SceneProps, SketchId, Transform, Vec3,
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

/// A document holding one box and one drawn-but-unextruded sketch.
fn box_and_sketch() -> (Document, ObjectId, SketchId) {
    let mut doc = Document::new();
    let o = a_box(&mut doc, 0.0);
    let s = rect_sketch(&mut doc, 5.0, 5.0, 8.0, 8.0);
    (doc, o, s)
}

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
        "{what} refuses a sketch node, typed"
    );
    assert_eq!(doc.state_hash(), before, "{what} left the document alone");
}

// ================================================ 1. what the node answers

#[test]
fn a_loose_sketch_node_has_no_parent_and_no_leaves() {
    let (doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);

    assert_eq!(doc.node_parent(node), None);
    assert!(doc.leaf_objects_under(node).is_empty());
    assert!(doc.leaf_instances_under(node).is_empty());
}

/// The top-level listing names objects, groups and instances; sketches are
/// listed as sketches, whether or not a group holds them.
#[test]
fn the_top_level_listing_does_not_name_sketches() {
    let (doc, o, s) = box_and_sketch();

    assert_eq!(doc.top_level_nodes(), vec![NodeId::Object(o)]);
    assert!(doc.sketch_ids().contains(&s), "it is listed as a sketch");
}

// ================================= 2. ops that cannot carry it refuse

/// A sketch is deleted as a sketch. The node-delete door refuses it, alone
/// or in a batch — and a refused batch rolls back the members before it.
#[test]
fn node_delete_refuses_a_sketch_and_rolls_back_the_batch() {
    let (mut doc, o, s) = box_and_sketch();
    refuses_untouched(&mut doc, "delete_node", |d| {
        d.delete_node(NodeId::Sketch(s))
    });
    refuses_untouched(&mut doc, "delete_selection", |d| {
        d.delete_selection(&[NodeId::Object(o), NodeId::Sketch(s)])
    });
    assert!(
        doc.object(o).is_some(),
        "the box before it in the batch is back"
    );
}

#[test]
fn duplicating_refuses_a_sketch() {
    let (mut doc, o, s) = box_and_sketch();
    let step = Transform::translation(Vec3::new(0.0, 3.0, 0.0));
    refuses_untouched(&mut doc, "duplicate_node", |d| {
        d.duplicate_node(NodeId::Sketch(s), &step)
    });
    refuses_untouched(&mut doc, "duplicate_nodes_array", |d| {
        d.duplicate_nodes_array(
            &[NodeId::Object(o), NodeId::Sketch(s)],
            &step,
            NonZeroU32::new(2).unwrap(),
        )
    });
}

#[test]
fn a_boolean_refuses_a_sketch_operand_on_either_side() {
    let (mut doc, o, s) = box_and_sketch();
    refuses_untouched(&mut doc, "boolean_nodes (b)", |d| {
        d.boolean_nodes(BooleanOp::Union, NodeId::Object(o), NodeId::Sketch(s))
    });
    refuses_untouched(&mut doc, "boolean_nodes (a)", |d| {
        d.boolean_nodes(BooleanOp::Union, NodeId::Sketch(s), NodeId::Object(o))
    });
}

#[test]
fn library_extract_refuses_a_sketch_root() {
    let (mut doc, o, s) = box_and_sketch();
    refuses_untouched(&mut doc, "extract_item", |d| {
        d.extract_item(&[NodeId::Object(o), NodeId::Sketch(s)], false)
            .map(|_| ())
    });
}

/// A sketch is an anchor (`sketch_anchor_specs.rs`); a stale one is refused
/// like any other stale node.
#[test]
fn an_annotation_refuses_a_stale_sketch_anchor() {
    let (mut doc, _, s) = box_and_sketch();
    doc.delete_sketch(s).unwrap();
    let before = doc.state_hash();
    assert_eq!(
        doc.add_leader_text(
            Anchor {
                node: Some(NodeId::Sketch(s)),
                point: Point3::new(5.0, 5.0, 0.0),
            },
            Vec3::new(1.0, 1.0, 0.0),
            "plan".to_string(),
        )
        .unwrap_err(),
        DocumentError::UnknownSketch
    );
    assert_eq!(doc.state_hash(), before);
}

// ===================================== 3. the sketch paths are unaffected

/// The selection transform takes whole sketches through its own list. A
/// sketch in the NODE list is refused; the same sketch in the sketch list
/// moves, exactly as before.
#[test]
fn a_whole_sketch_moves_through_the_sketch_list_not_the_node_list() {
    let (mut doc, o, s) = box_and_sketch();
    let t = Transform::translation(Vec3::new(10.0, 0.0, 0.0));

    refuses_untouched(&mut doc, "transform_selection", |d| {
        d.transform_selection(&[NodeId::Object(o), NodeId::Sketch(s)], &[], &t)
    });

    doc.transform_selection(&[NodeId::Object(o)], &[s], &t)
        .expect("a box and a sketch move together");
    let moved = doc.sketch(s).unwrap();
    let min_x = moved
        .vertices()
        .values()
        .map(|v| v.position.x)
        .fold(f64::INFINITY, f64::min);
    assert_eq!(min_x, 15.0);
}

#[test]
fn delete_sketch_still_deletes_it() {
    let (mut doc, _, s) = box_and_sketch();
    doc.delete_sketch(s).expect("the sketch door is open");
    assert!(doc.sketch(s).is_none());
    doc.undo().expect("undo");
    assert!(doc.sketch(s).is_some());
}

// ===================================== 4. name, tags and user-hidden

fn tag(path: &[&str]) -> Vec<String> {
    path.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_sketch_is_named_and_the_name_undoes() {
    let (mut doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);

    doc.set_node_name(node, Some("Ground floor".to_string()))
        .expect("a sketch takes a name");
    assert_eq!(doc.sketch_name(s), Some("Ground floor"));

    doc.undo().expect("undo the rename");
    assert_eq!(doc.sketch_name(s), None);
    doc.redo().expect("redo the rename");
    assert_eq!(doc.sketch_name(s), Some("Ground floor"));

    doc.set_node_name(node, None).expect("and gives it up");
    assert_eq!(doc.sketch_name(s), None);
}

#[test]
fn a_sketch_is_tagged_and_untagged() {
    let (mut doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);

    doc.add_node_tag(node, tag(&["Plans", "Ground"])).unwrap();
    assert_eq!(doc.node_tags(node), &[tag(&["Plans", "Ground"])]);

    let depth = doc.undo_depth();
    doc.add_node_tag(node, tag(&["Plans", "Ground"])).unwrap();
    assert_eq!(
        doc.undo_depth(),
        depth,
        "a tag it already has costs no step"
    );

    doc.remove_node_tag(node, &tag(&["Plans", "Ground"]))
        .unwrap();
    assert!(doc.node_tags(node).is_empty());
    doc.undo().unwrap();
    assert_eq!(doc.node_tags(node), &[tag(&["Plans", "Ground"])]);
}

/// The registry sweeps reach sketches: renaming or deleting a tag rewrites it
/// on a sketch exactly as on an object, in the same undo step.
#[test]
fn tag_rename_and_delete_sweep_sketches() {
    let (mut doc, o, s) = box_and_sketch();
    let (sk, ob) = (NodeId::Sketch(s), NodeId::Object(o));
    doc.add_node_tag(sk, tag(&["Plans", "Ground"])).unwrap();
    doc.add_node_tag(ob, tag(&["Plans", "Ground"])).unwrap();

    doc.rename_tag(&tag(&["Plans"]), tag(&["Drawings"]))
        .expect("rename the parent");
    assert_eq!(doc.node_tags(sk), &[tag(&["Drawings", "Ground"])]);
    assert_eq!(doc.node_tags(ob), &[tag(&["Drawings", "Ground"])]);
    doc.undo().unwrap();
    assert_eq!(doc.node_tags(sk), &[tag(&["Plans", "Ground"])]);

    doc.delete_tag(&tag(&["Plans"])).expect("delete the parent");
    assert!(doc.node_tags(sk).is_empty());
    assert!(doc.node_tags(ob).is_empty());
    doc.undo().unwrap();
    assert_eq!(doc.node_tags(sk), &[tag(&["Plans", "Ground"])]);
}

/// A tag rename that would collide with a path only a SKETCH carries is
/// refused like any other collision.
#[test]
fn a_tag_carried_only_by_a_sketch_still_blocks_a_colliding_rename() {
    let (mut doc, o, s) = box_and_sketch();
    doc.add_node_tag(NodeId::Sketch(s), tag(&["B"])).unwrap();
    doc.add_node_tag(NodeId::Object(o), tag(&["A"])).unwrap();

    assert_eq!(
        doc.rename_tag(&tag(&["A"]), tag(&["B"])).unwrap_err(),
        DocumentError::DuplicateTag
    );
}

/// User-hidden is view state, like every other node's: set, read back,
/// listed, and deliberately not an undo step.
#[test]
fn a_sketch_is_user_hidden_as_view_state() {
    let (mut doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);
    let depth = doc.undo_depth();

    doc.set_node_user_hidden(node, true);
    assert!(doc.node_user_hidden(node));
    assert!(doc.user_hidden_nodes().contains(&node));
    assert_eq!(doc.undo_depth(), depth, "hiding is not an undo step");
    assert!(doc.sketch(s).is_some(), "hidden from view, not deleted");

    doc.set_node_user_hidden(node, false);
    assert!(!doc.node_user_hidden(node));
}

/// A deleted sketch is not a live node: naming it refuses with the honest
/// error, and undoing the delete brings it back still named.
#[test]
fn a_deleted_sketch_refuses_a_name_and_returns_with_its_own() {
    let (mut doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);
    doc.set_node_name(node, Some("Ground floor".to_string()))
        .unwrap();
    doc.delete_sketch(s).unwrap();

    assert_eq!(
        doc.set_node_name(node, Some("x".to_string())).unwrap_err(),
        DocumentError::UnknownSketch
    );
    doc.undo().expect("undo the delete");
    assert_eq!(doc.sketch_name(s), Some("Ground floor"));
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
fn name_tags_and_hidden_round_trip() {
    let (mut doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);
    doc.set_node_name(node, Some("Ground floor".to_string()))
        .unwrap();
    doc.add_node_tag(node, tag(&["Plans"])).unwrap();
    doc.set_node_user_hidden(node, true);

    let loaded = Document::load(&doc.save()).expect("v18 loads");
    let s2 = loaded.sketch_ids()[0];
    let node2 = NodeId::Sketch(s2);
    assert_eq!(loaded.sketch_name(s2), Some("Ground floor"));
    assert_eq!(loaded.node_tags(node2), &[tag(&["Plans"])]);
    assert!(loaded.node_user_hidden(node2));
    assert_eq!(loaded.save(), doc.save(), "and saves back byte-identical");
}

/// Written only when set: a sketch with no name, no tags and not hidden
/// writes none of the three keys, so such a document differs from its v17
/// output in the version number alone.
#[test]
fn an_unnamed_visible_sketch_writes_no_new_keys() {
    let (doc, _, _) = box_and_sketch();
    let manifest = manifest_json(&doc.save());

    assert_eq!(manifest["format_version"], kernel::MANIFEST_FORMAT_VERSION);
    let sketch = &manifest["sketches"][0];
    for key in ["name", "tags", "hidden"] {
        assert!(sketch.get(key).is_none(), "`{key}` is absent when unset");
    }
}

/// Clearing the last of a sketch's metadata leaves no trace: the document
/// saves exactly as one that never had any.
#[test]
fn cleared_metadata_saves_like_none_ever_set() {
    let (mut doc, _, s) = box_and_sketch();
    let pristine = doc.save();
    let node = NodeId::Sketch(s);

    doc.set_node_name(node, Some("x".to_string())).unwrap();
    doc.add_node_tag(node, tag(&["T"])).unwrap();
    doc.delete_tag(&tag(&["T"])).unwrap();
    doc.set_node_name(node, None).unwrap();

    assert_eq!(
        manifest_json(&doc.save())["sketches"],
        manifest_json(&pristine)["sketches"]
    );
}

/// Gated one way: a v17 manifest carrying any of the three fields is
/// malformed for its own declared version and rejected, never honored.
#[test]
fn sketch_metadata_smuggled_into_a_v17_manifest_is_rejected() {
    let (doc, _, _) = box_and_sketch();
    let bytes = doc.save();
    let smuggle = |key: &'static str, value: serde_json::Value| {
        patch_manifest(&bytes, move |m| {
            m["format_version"] = 17.into();
            m["sketches"][0][key] = value;
        })
    };

    for (key, value) in [
        ("name", serde_json::json!("Ground floor")),
        ("tags", serde_json::json!([["Plans"]])),
        ("hidden", serde_json::json!(true)),
    ] {
        assert!(
            matches!(
                Document::load(&smuggle(key, value)),
                Err(LoadError::MalformedManifest { .. })
            ),
            "`{key}` in a v17 manifest is rejected"
        );
    }
}

#[test]
fn a_v17_file_loads_with_every_sketch_unnamed_and_visible() {
    let (doc, _, _) = box_and_sketch();
    let v17 = patch_manifest(&doc.save(), |m| m["format_version"] = 17.into());

    let loaded = Document::load(&v17).expect("an honest v17 file loads");
    let s = loaded.sketch_ids()[0];
    assert_eq!(loaded.sketch_name(s), None);
    assert!(loaded.node_tags(NodeId::Sketch(s)).is_empty());
    assert!(!loaded.node_user_hidden(NodeId::Sketch(s)));
}

// ============================== 6. name and tags ride whole-sketch copies

/// A named, tagged sketch drawn inside a component definition.
fn definition_with_a_named_sketch(
    doc: &mut Document,
) -> (kernel::ComponentId, kernel::InstanceId, SketchId) {
    let o = a_box(doc, 0.0);
    let (comp, inst, _) = doc.make_component(&[NodeId::Object(o)]).unwrap();
    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(inst, ground())
        .unwrap();
    {
        let sk = doc.sketch_mut(sid).unwrap();
        for (a, b) in [
            (Point3::new(0.0, 0.0, 0.0), Point3::new(3.0, 0.0, 0.0)),
            (Point3::new(3.0, 0.0, 0.0), Point3::new(3.0, 3.0, 0.0)),
            (Point3::new(3.0, 3.0, 0.0), Point3::new(0.0, 3.0, 0.0)),
            (Point3::new(0.0, 3.0, 0.0), Point3::new(0.0, 0.0, 0.0)),
        ] {
            sk.add_segment(a, b).unwrap();
        }
    }
    doc.set_node_name(NodeId::Sketch(sid), Some("Layout".to_string()))
        .expect("a definition-owned sketch takes a name");
    doc.add_node_tag(NodeId::Sketch(sid), tag(&["Plans"]))
        .unwrap();
    (comp, inst, sid)
}

#[test]
fn explode_instance_carries_the_name_onto_the_baked_sketch() {
    let mut doc = Document::new();
    let (_, inst, _) = definition_with_a_named_sketch(&mut doc);

    let before: std::collections::BTreeSet<_> = doc.sketch_ids().into_iter().collect();
    doc.explode_instance(inst).expect("explode");
    let baked: Vec<_> = doc
        .sketch_ids()
        .into_iter()
        .filter(|s| !before.contains(s))
        .collect();

    assert_eq!(baked.len(), 1);
    assert_eq!(doc.sketch_name(baked[0]), Some("Layout"));
    assert_eq!(doc.node_tags(NodeId::Sketch(baked[0])), &[tag(&["Plans"])]);
}

/// Copying geometry OFF a sketch yields fresh, unnamed stock — the same rule
/// the locked flag follows.
#[test]
fn copying_islands_off_a_named_sketch_yields_an_unnamed_one() {
    let (mut doc, _, s) = box_and_sketch();
    doc.set_node_name(NodeId::Sketch(s), Some("Ground floor".to_string()))
        .unwrap();
    let islands: Vec<_> = doc.sketch(s).unwrap().islands().keys().collect();

    let (copy, _) = doc
        .copy_sketch_islands(
            s,
            &islands,
            &Transform::translation(Vec3::new(0.0, 9.0, 0.0)),
        )
        .unwrap();
    assert_eq!(doc.sketch_name(copy), None);
}

// ===================================================== 7. scenes

/// A Scene captures the user-hidden nodes by stable id, and a hidden sketch
/// is one of them. The writer prunes ids that name nothing live, so a sketch
/// it did not count as a node would be dropped from the Scene on save without
/// a word; this pins that it survives, and that applying the Scene hides the
/// sketch again.
#[test]
fn a_scene_captures_and_restores_a_hidden_sketch() {
    let (mut doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);
    doc.set_node_user_hidden(node, true);
    let scene = doc
        .add_scene(None, SceneProps::ALL, None, None, None)
        .expect("a scene capturing the hidden sketch");
    doc.set_node_user_hidden(node, false);

    let mut loaded = Document::load(&doc.save()).expect("the file reopens");
    let s2 = loaded.sketch_ids()[0];
    assert!(!loaded.node_user_hidden(NodeId::Sketch(s2)));

    let resolved = loaded.apply_scene(scene).expect("the scene applies");
    assert!(loaded.node_user_hidden(NodeId::Sketch(s2)));
    assert_eq!(resolved.hidden_nodes, Some(vec![NodeId::Sketch(s2)]));
    assert_eq!(resolved.hidden_sketch_ids, Some(vec![s2]));
}

/// Hiding a TAG hides the sketches that carry it, in the resolved leaf sets
/// the renderer and inference are fed.
#[test]
fn a_scene_with_a_hidden_tag_hides_the_sketches_carrying_it() {
    let (mut doc, _, s) = box_and_sketch();
    doc.add_node_tag(NodeId::Sketch(s), tag(&["Plans"]))
        .unwrap();
    doc.set_tag_hidden(tag(&["Plans"]), true);
    let scene = doc
        .add_scene(None, SceneProps::ALL, None, None, None)
        .unwrap();

    let resolved = doc.apply_scene(scene).unwrap();
    assert_eq!(resolved.hidden_sketch_ids, Some(vec![s]));
}

/// Gated like the rest of the sketch-as-node format: in a manifest older than
/// v18 a Scene that names a sketch's id is a dangling reference, exactly as
/// it was when that version was current.
#[test]
fn a_scene_hiding_a_sketch_in_a_v17_manifest_is_rejected() {
    let (mut doc, _, s) = box_and_sketch();
    doc.set_node_user_hidden(NodeId::Sketch(s), true);
    doc.add_scene(None, SceneProps::ALL, None, None, None)
        .unwrap();
    doc.set_node_user_hidden(NodeId::Sketch(s), false);

    let v17 = patch_manifest(&doc.save(), |m| m["format_version"] = 17.into());
    assert!(matches!(
        Document::load(&v17),
        Err(LoadError::DanglingReference { .. })
    ));
}
