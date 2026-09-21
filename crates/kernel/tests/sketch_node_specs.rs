//! Executable specs for the SKETCH NODE: `NodeId::Sketch`.
//!
//! A sketch is a node — the unit a name, tags and visibility hang on — but it
//! is not a member of the tree. No group or definition lists one, it has no
//! parent, and `top_level_nodes` does not return it. Every op that would make
//! it a member, or that works on the tree below a node, refuses it with a
//! typed `SketchNodeUnsupported` and leaves the document untouched.
//!
//! Sections:
//!
//! 1. What a sketch node answers: liveness, parent, leaves.
//! 2. Every structural op refuses it, touching nothing.
//! 3. The sketch-specific paths are unaffected.

use std::num::NonZeroU32;

use kernel::{
    Anchor, BooleanOp, Document, DocumentError, NodeId, ObjectId, Plane, Point3, SketchId,
    Transform, Vec3,
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
fn a_sketch_node_has_no_parent_and_no_leaves() {
    let (doc, _, s) = box_and_sketch();
    let node = NodeId::Sketch(s);

    assert_eq!(doc.node_parent(node), None);
    assert!(doc.leaf_objects_under(node).is_empty());
    assert!(doc.leaf_instances_under(node).is_empty());
}

/// Not a tree member: the tree's own listing does not return it, so nothing
/// that walks the tree — save, the outliner, a scene — can meet one.
#[test]
fn the_tree_does_not_list_sketches() {
    let (doc, o, s) = box_and_sketch();

    assert_eq!(doc.top_level_nodes(), vec![NodeId::Object(o)]);
    assert!(doc.sketch_ids().contains(&s), "it is listed as a sketch");
}

// ============================================ 2. structural ops refuse it

#[test]
fn grouping_refuses_a_sketch() {
    let (mut doc, o, s) = box_and_sketch();
    refuses_untouched(&mut doc, "group_nodes", |d| {
        d.group_nodes(&[NodeId::Object(o), NodeId::Sketch(s)])
    });
}

#[test]
fn reparenting_refuses_a_sketch() {
    let (mut doc, o, s) = box_and_sketch();
    let o2 = a_box(&mut doc, 2.0);
    let (g, _) = doc
        .group_nodes(&[NodeId::Object(o), NodeId::Object(o2)])
        .expect("a group to move into");
    refuses_untouched(&mut doc, "reparent_nodes", |d| {
        d.reparent_nodes(&[NodeId::Sketch(s)], Some(g))
    });
}

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
fn make_component_refuses_a_sketch() {
    let (mut doc, o, s) = box_and_sketch();
    refuses_untouched(&mut doc, "make_component", |d| {
        d.make_component(&[NodeId::Object(o), NodeId::Sketch(s)])
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

/// Nothing re-anchors an annotation when a sketch moves, so a live sketch is
/// still refused as an anchor rather than accepted and left to go stale.
#[test]
fn an_annotation_refuses_a_sketch_anchor() {
    let (mut doc, _, s) = box_and_sketch();
    refuses_untouched(&mut doc, "add_leader_text", |d| {
        d.add_leader_text(
            Anchor {
                node: Some(NodeId::Sketch(s)),
                point: Point3::new(5.0, 5.0, 0.0),
            },
            Vec3::new(1.0, 1.0, 0.0),
            "plan".to_string(),
        )
    });
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
