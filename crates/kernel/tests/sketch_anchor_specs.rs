//! Executable specs for a DIMENSION ON A SKETCH.
//!
//! A dimension or leader anchored to a sketch's line work follows the sketch
//! when the whole sketch moves — alone, or inside its group — and detaches,
//! visibly and undoably, when the line under it is redrawn, moved away,
//! consumed by an extrusion, or deleted. It never re-attaches on its own.
//!
//! Sections:
//!
//! 1. Anchoring: on the line work yes, off it no.
//! 2. Whole-sketch moves carry the anchor.
//! 3. Edits the anchor cannot follow detach it, exactly on undo.
//! 4. Persistence: manifest v20, gated one way.

use std::io::{Cursor, Read, Write};

use kernel::{
    Anchor, Annotation, Document, DocumentError, LoadError, NodeId, Plane, Point3, SketchId,
    Transform, Vec3,
};

// ----------------------------------------------------------------- helpers

fn ground() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane is well-defined")
}

/// A ground sketch carrying one axis-aligned rectangle, drawn as a gesture.
fn rect_sketch(doc: &mut Document, x0: f64, y0: f64, x1: f64, y1: f64) -> SketchId {
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).unwrap();
    {
        let sk = doc.sketch_mut(s).expect("sketch is live and unlocked");
        for (a, b) in [
            (Point3::new(x0, y0, 0.0), Point3::new(x1, y0, 0.0)),
            (Point3::new(x1, y0, 0.0), Point3::new(x1, y1, 0.0)),
            (Point3::new(x1, y1, 0.0), Point3::new(x0, y1, 0.0)),
            (Point3::new(x0, y1, 0.0), Point3::new(x0, y0, 0.0)),
        ] {
            sk.add_segment(a, b).expect("rectangle segment");
        }
    }
    doc.end_sketch_gesture(s).unwrap();
    s
}

fn on(sketch: SketchId, x: f64, y: f64) -> Anchor {
    Anchor {
        node: Some(NodeId::Sketch(sketch)),
        point: Point3::new(x, y, 0.0),
    }
}

/// A 3 x 2 plan at the origin with a dimension along its bottom wall
/// (0,0)-(3,0) and a leader on its right wall.
fn plan_with_dimension() -> (
    Document,
    SketchId,
    kernel::AnnotationId,
    kernel::AnnotationId,
) {
    let mut doc = Document::new();
    let plan = rect_sketch(&mut doc, 0.0, 0.0, 3.0, 2.0);
    let dim = doc
        .add_linear_dimension(
            on(plan, 0.0, 0.0),
            on(plan, 3.0, 0.0),
            Vec3::new(0.0, -0.5, 0.0),
            ground(),
            None,
        )
        .expect("a dimension on the plan's bottom wall");
    let note = doc
        .add_leader_text(
            on(plan, 3.0, 1.0),
            Vec3::new(1.0, 0.0, 0.0),
            "east wall".into(),
        )
        .expect("a leader on the plan's right wall");
    (doc, plan, dim, note)
}

/// One gesture removing the bottom (0,0)-(3,0) and left (0,0)-(0,2) walls,
/// so the corner at the origin — where the dimension starts — is gone.
/// Erasing one wall alone leaves both its corners standing on the walls
/// beside them, and a dimension between two standing corners stays valid.
fn erase_south_west_corner(doc: &mut Document, plan: SketchId) {
    doc.begin_sketch_gesture(plan).unwrap();
    for (a, b) in [
        (Point3::new(0.0, 0.0, 0.0), Point3::new(3.0, 0.0, 0.0)),
        (Point3::new(0.0, 0.0, 0.0), Point3::new(0.0, 2.0, 0.0)),
    ] {
        let e = doc
            .sketch(plan)
            .unwrap()
            .edge_at_positions(a, b)
            .expect("a wall of the plan");
        doc.sketch_mut(plan).unwrap().remove_edge(e).unwrap();
    }
    doc.end_sketch_gesture(plan).unwrap();
}

fn a_point(doc: &Document, id: kernel::AnnotationId) -> Point3 {
    match doc.annotation(id).unwrap() {
        Annotation::LinearDimension { a, .. } => a.point,
        Annotation::LeaderText { anchor, .. } | Annotation::RadialDimension { anchor, .. } => {
            anchor.point
        }
    }
}

fn detached(doc: &Document, id: kernel::AnnotationId) -> bool {
    doc.annotation_detached(id).unwrap()
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

// ================================================ 1. anchoring

#[test]
fn a_dimension_anchors_to_a_sketch_on_its_lines() {
    let (doc, _, dim, note) = plan_with_dimension();
    assert!(!detached(&doc, dim));
    assert!(!detached(&doc, note));
}

#[test]
fn an_anchor_off_the_sketch_lines_is_refused() {
    let mut doc = Document::new();
    let plan = rect_sketch(&mut doc, 0.0, 0.0, 3.0, 2.0);
    assert_eq!(
        doc.add_leader_text(on(plan, 1.5, 1.0), Vec3::new(1.0, 0.0, 0.0), "x".into())
            .unwrap_err(),
        DocumentError::AnchorOffSketch,
        "the middle of the plan has no line to anchor to"
    );
    doc.delete_sketch(plan).unwrap();
    assert_eq!(
        doc.add_leader_text(on(plan, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0), "x".into())
            .unwrap_err(),
        DocumentError::UnknownSketch
    );
}

// ================================================ 2. whole-sketch moves

#[test]
fn a_sketch_move_carries_the_dimension_and_undoes_exactly() {
    let (mut doc, plan, dim, note) = plan_with_dimension();
    let t = Transform::translation(Vec3::new(10.0, 0.0, 0.0));

    undoes_exactly(&mut doc, "transform_sketch", |d| {
        d.transform_sketch(plan, &t).unwrap();
    });

    assert_eq!(a_point(&doc, dim), Point3::new(10.0, 0.0, 0.0));
    assert_eq!(a_point(&doc, note), Point3::new(13.0, 1.0, 0.0));
    assert!(!detached(&doc, dim));
    doc.undo().unwrap();
    assert_eq!(a_point(&doc, dim), Point3::new(0.0, 0.0, 0.0));
}

/// A plan moved with the group that holds it, and a plan moved through the
/// selection list, both carry their dimensions.
#[test]
fn a_group_move_and_a_selection_move_carry_the_dimension() {
    let (mut doc, plan, dim, _) = plan_with_dimension();
    let (g, _) = doc.group_nodes(&[NodeId::Sketch(plan)]).unwrap();
    let t = Transform::translation(Vec3::new(0.0, 5.0, 0.0));

    doc.transform_group(g, &t).unwrap();
    assert_eq!(a_point(&doc, dim), Point3::new(0.0, 5.0, 0.0));
    doc.transform_selection(&[], &[plan], &t).unwrap();
    assert_eq!(a_point(&doc, dim), Point3::new(0.0, 10.0, 0.0));
    assert!(!detached(&doc, dim));
    doc.undo().unwrap();
    doc.undo().unwrap();
    assert_eq!(a_point(&doc, dim), Point3::new(0.0, 0.0, 0.0));
}

// ================================================ 3. edits detach it

#[test]
fn redrawing_the_wall_under_the_dimension_detaches_it() {
    let (mut doc, plan, dim, note) = plan_with_dimension();

    // Erase the bottom and left walls in one gesture: the corner the
    // dimension starts from is gone, the leader's wall is untouched.
    undoes_exactly(&mut doc, "gesture erasing the south-west corner", |d| {
        erase_south_west_corner(d, plan);
    });

    assert!(detached(&doc, dim), "no line under the dimension any more");
    assert!(!detached(&doc, note), "the leader's wall is still there");
    doc.undo().unwrap();
    assert!(
        !detached(&doc, dim),
        "undo re-attaches what the edit detached"
    );
}

/// A gesture that only adds lines elsewhere leaves the anchor alone.
#[test]
fn drawing_elsewhere_in_the_sketch_keeps_the_dimension() {
    let (mut doc, plan, dim, _) = plan_with_dimension();
    doc.begin_sketch_gesture(plan).unwrap();
    doc.sketch_mut(plan)
        .unwrap()
        .add_segment(Point3::new(0.0, 1.0, 0.0), Point3::new(3.0, 1.0, 0.0))
        .unwrap();
    doc.end_sketch_gesture(plan).unwrap();
    assert!(!detached(&doc, dim));
}

#[test]
fn dragging_the_corner_away_detaches_and_undo_reattaches() {
    let (mut doc, plan, dim, _) = plan_with_dimension();
    let corner = *doc
        .sketch(plan)
        .unwrap()
        .vertices()
        .iter()
        .find(|(_, v)| v.position == Point3::new(0.0, 0.0, 0.0))
        .map(|(id, _)| id)
        .as_ref()
        .unwrap();

    undoes_exactly(&mut doc, "move_sketch_vertex", |d| {
        d.move_sketch_vertex(plan, corner, Point3::new(-1.0, -1.0, 0.0))
            .unwrap();
    });
    assert!(detached(&doc, dim));
    doc.undo().unwrap();
    assert!(!detached(&doc, dim));
}

#[test]
fn moving_the_island_away_detaches_the_dimension() {
    let (mut doc, plan, dim, _) = plan_with_dimension();
    // A second island so the move is an island move, not a whole-sketch one.
    doc.begin_sketch_gesture(plan).unwrap();
    doc.sketch_mut(plan)
        .unwrap()
        .add_segment(Point3::new(10.0, 10.0, 0.0), Point3::new(11.0, 10.0, 0.0))
        .unwrap();
    doc.end_sketch_gesture(plan).unwrap();
    let island = *doc
        .sketch(plan)
        .unwrap()
        .islands()
        .iter()
        .find(|(_, isl)| isl.edges.len() == 4)
        .map(|(id, _)| id)
        .as_ref()
        .unwrap();

    undoes_exactly(&mut doc, "transform_sketch_island", |d| {
        d.transform_sketch_island(
            plan,
            island,
            &Transform::translation(Vec3::new(1.0, 0.0, 0.0)),
        )
        .unwrap();
    });
    assert!(detached(&doc, dim));
}

#[test]
fn extruding_the_plan_detaches_its_dimension() {
    let (mut doc, plan, dim, note) = plan_with_dimension();
    let region = doc.extrudable_regions(plan).unwrap()[0];

    undoes_exactly(&mut doc, "extrude_region", |d| {
        d.extrude_region(plan, region, 1.0).unwrap();
    });
    assert!(detached(&doc, dim));
    assert!(detached(&doc, note));
    doc.undo().unwrap();
    assert!(!detached(&doc, dim));
    assert!(!detached(&doc, note));
}

#[test]
fn deleting_the_sketch_detaches_and_undo_reattaches() {
    let (mut doc, plan, dim, _) = plan_with_dimension();
    undoes_exactly(&mut doc, "delete_sketch", |d| {
        d.delete_sketch(plan).unwrap();
    });
    assert!(detached(&doc, dim));
    doc.undo().unwrap();
    assert!(!detached(&doc, dim));
}

#[test]
fn deleting_the_group_holding_the_sketch_detaches_it() {
    let (mut doc, plan, dim, _) = plan_with_dimension();
    let (g, _) = doc.group_nodes(&[NodeId::Sketch(plan)]).unwrap();
    doc.delete_node(NodeId::Group(g)).unwrap();
    assert!(detached(&doc, dim));
    doc.undo().unwrap();
    assert!(!detached(&doc, dim));
}

/// Detached is sticky: a later move of the sketch does not re-attach.
#[test]
fn a_detached_dimension_stays_detached_through_a_later_move() {
    let (mut doc, plan, dim, _) = plan_with_dimension();
    erase_south_west_corner(&mut doc, plan);
    assert!(detached(&doc, dim));

    let frozen = a_point(&doc, dim);
    doc.transform_sketch(plan, &Transform::translation(Vec3::new(5.0, 0.0, 0.0)))
        .unwrap();
    assert!(detached(&doc, dim));
    assert_eq!(
        a_point(&doc, dim),
        frozen,
        "a detached dimension is frozen in place"
    );
}

// ======================================================== 4. persistence

fn manifest_json(bytes: &[u8]) -> serde_json::Value {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut buf = Vec::new();
    zip.by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut buf)
        .unwrap();
    serde_json::from_slice(&buf).unwrap()
}

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
fn a_sketch_anchor_round_trips_and_still_follows_the_sketch() {
    let (doc, _, _, _) = plan_with_dimension();
    let manifest = manifest_json(&doc.save());
    assert_eq!(manifest["format_version"], kernel::MANIFEST_FORMAT_VERSION);
    assert_eq!(manifest["annotations"][0]["a"]["node"]["kind"], "sketch");

    let mut loaded = Document::load(&doc.save()).expect("v20 loads");
    assert_eq!(loaded.save(), doc.save(), "and saves back byte-identical");
    let plan = loaded.sketch_ids()[0];
    let dim = loaded.annotation_ids()[0];
    loaded
        .transform_sketch(plan, &Transform::translation(Vec3::new(1.0, 0.0, 0.0)))
        .unwrap();
    assert_eq!(a_point(&loaded, dim), Point3::new(1.0, 0.0, 0.0));
}

#[test]
fn a_sketch_anchor_smuggled_into_a_v19_manifest_is_rejected() {
    let (doc, _, _, _) = plan_with_dimension();
    let v19 = patch_manifest(&doc.save(), |m| m["format_version"] = 19.into());
    assert!(matches!(
        Document::load(&v19),
        Err(LoadError::MalformedManifest { .. })
    ));
}

#[test]
fn a_sketch_anchor_naming_no_sketch_is_rejected() {
    let (doc, _, _, _) = plan_with_dimension();
    let dangling = patch_manifest(&doc.save(), |m| {
        m["annotations"][0]["a"]["node"]["id"] = 7.into()
    });
    assert!(matches!(
        Document::load(&dangling),
        Err(LoadError::DanglingReference { .. })
    ));
}
