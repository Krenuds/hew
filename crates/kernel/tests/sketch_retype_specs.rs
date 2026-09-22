//! Executable specs for RETYPING A NUMBER on a drawn sketch: a line's
//! length, a rectangle's size, a circle's radius — typed into Object Info
//! instead of redrawn. No solver: a line's second-drawn end moves along the
//! line, a rectangle grows from its first corner, a circle scales about its
//! centre. Each is one undo step, and anything the sketch's own rules would
//! refuse (a crossing, a merge) is refused whole.

use kernel::{CurveGeom, Document, DocumentError, Plane, Point3, SketchError, SketchId};

fn ground() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane is well-defined")
}

fn pt(x: f64, y: f64) -> Point3 {
    Point3::new(x, y, 0.0)
}

/// A 3 x 2 rectangle drawn from the origin, first edge along +x.
fn rect(doc: &mut Document) -> SketchId {
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).unwrap();
    {
        let sk = doc.sketch_mut(s).unwrap();
        for (a, b) in [
            (pt(0.0, 0.0), pt(3.0, 0.0)),
            (pt(3.0, 0.0), pt(3.0, 2.0)),
            (pt(3.0, 2.0), pt(0.0, 2.0)),
            (pt(0.0, 2.0), pt(0.0, 0.0)),
        ] {
            sk.add_segment(a, b).unwrap();
        }
    }
    doc.end_sketch_gesture(s).unwrap();
    s
}

fn edge_between(doc: &Document, s: SketchId, a: Point3, b: Point3) -> kernel::SketchEdgeId {
    doc.sketch(s)
        .unwrap()
        .edge_at_positions(a, b)
        .expect("edge")
}

fn edge_len(doc: &Document, s: SketchId, e: kernel::SketchEdgeId) -> f64 {
    let sk = doc.sketch(s).unwrap();
    let ed = sk.edges()[e];
    (sk.vertices()[ed.to].position - sk.vertices()[ed.from].position).length()
}

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

// ------------------------------------------------------------- line length

/// An 11'6" wall becomes 12' without redrawing: the far end slides out along
/// the wall, and the wall that met it there stretches to follow.
#[test]
fn a_line_becomes_the_typed_length_and_its_neighbour_follows() {
    let mut doc = Document::new();
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).unwrap();
    doc.sketch_mut(s)
        .unwrap()
        .add_segment(pt(0.0, 0.0), pt(3.5052, 0.0))
        .unwrap();
    doc.sketch_mut(s)
        .unwrap()
        .add_segment(pt(3.5052, 0.0), pt(3.5052, 2.0))
        .unwrap();
    doc.end_sketch_gesture(s).unwrap();
    let wall = edge_between(&doc, s, pt(0.0, 0.0), pt(3.5052, 0.0));

    undoes_exactly(&mut doc, "set_sketch_edge_length", |d| {
        d.set_sketch_edge_length(s, wall, 3.6576).unwrap();
    });

    assert!((edge_len(&doc, s, wall) - 3.6576).abs() < 1e-9);
    let sk = doc.sketch(s).unwrap();
    assert_eq!(sk.edges().len(), 2, "nothing split or merged");
    assert!(
        sk.edge_at_positions(pt(3.6576, 0.0), pt(3.5052, 2.0))
            .is_some(),
        "the return wall now runs from the moved corner"
    );
}

#[test]
fn a_length_that_would_cross_other_geometry_is_refused_whole() {
    let mut doc = Document::new();
    let s = rect(&mut doc);
    // A free line inside the rectangle, pointing at its right wall.
    doc.begin_sketch_gesture(s).unwrap();
    doc.sketch_mut(s)
        .unwrap()
        .add_segment(pt(1.0, 1.0), pt(2.0, 1.0))
        .unwrap();
    doc.end_sketch_gesture(s).unwrap();
    let line = edge_between(&doc, s, pt(1.0, 1.0), pt(2.0, 1.0));
    let before = doc.state_hash();

    assert!(matches!(
        doc.set_sketch_edge_length(s, line, 5.0),
        Err(DocumentError::Sketch(SketchError::WouldRetopologize))
    ));
    assert_eq!(doc.state_hash(), before, "refused, nothing changed");
    assert!(matches!(
        doc.set_sketch_edge_length(s, line, 0.0),
        Err(DocumentError::Sketch(SketchError::InvalidDimension))
    ));
}

#[test]
fn a_locked_sketch_refuses_a_retype() {
    let mut doc = Document::new();
    let s = rect(&mut doc);
    let e = edge_between(&doc, s, pt(0.0, 0.0), pt(3.0, 0.0));
    doc.set_sketch_locked(s, true).unwrap();
    assert_eq!(
        doc.set_sketch_edge_length(s, e, 4.0).unwrap_err(),
        DocumentError::SketchLocked
    );
}

// ---------------------------------------------------------- rectangle size

#[test]
fn a_rectangle_reads_and_takes_a_typed_size() {
    let mut doc = Document::new();
    let s = rect(&mut doc);
    let island = doc.sketch(s).unwrap().islands().keys().next().unwrap();
    assert_eq!(
        doc.sketch(s).unwrap().rectangle_size(island),
        Some((3.0, 2.0))
    );

    undoes_exactly(&mut doc, "set_sketch_rectangle_size", |d| {
        d.set_sketch_rectangle_size(s, island, 4.0, 1.0).unwrap();
    });

    let sk = doc.sketch(s).unwrap();
    assert_eq!(sk.rectangle_size(island), Some((4.0, 1.0)));
    assert!(
        sk.edge_at_positions(pt(0.0, 0.0), pt(4.0, 0.0)).is_some(),
        "the first corner stayed"
    );
    assert!(sk.edge_at_positions(pt(4.0, 1.0), pt(0.0, 1.0)).is_some());
    assert_eq!(sk.regions().len(), 1, "still one closed region");
}

#[test]
fn a_shape_that_is_not_a_rectangle_is_refused() {
    let mut doc = Document::new();
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).unwrap();
    {
        let sk = doc.sketch_mut(s).unwrap();
        sk.add_segment(pt(0.0, 0.0), pt(3.0, 0.0)).unwrap();
        sk.add_segment(pt(3.0, 0.0), pt(1.0, 2.0)).unwrap();
        sk.add_segment(pt(1.0, 2.0), pt(0.0, 0.0)).unwrap();
    }
    doc.end_sketch_gesture(s).unwrap();
    let island = doc.sketch(s).unwrap().islands().keys().next().unwrap();
    assert_eq!(doc.sketch(s).unwrap().rectangle_size(island), None);
    assert!(matches!(
        doc.set_sketch_rectangle_size(s, island, 4.0, 1.0),
        Err(DocumentError::Sketch(SketchError::NotARectangle))
    ));
}

// ------------------------------------------------------------ circle radius

fn circle(doc: &mut Document, center: Point3, radius: f64) -> (SketchId, kernel::SketchCurveId) {
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).unwrap();
    let cid = {
        let sk = doc.sketch_mut(s).unwrap();
        let cid = sk.begin_curve_with(CurveGeom { center, radius }).unwrap();
        let n = 24;
        let p = |i: usize| {
            let a = 2.0 * std::f64::consts::PI * (i as f64) / (n as f64);
            pt(center.x + radius * a.cos(), center.y + radius * a.sin())
        };
        for i in 0..n {
            sk.add_segment(p(i), p(i + 1)).unwrap();
        }
        sk.end_curve();
        cid
    };
    doc.end_sketch_gesture(s).unwrap();
    (s, cid)
}

#[test]
fn a_circle_takes_a_typed_radius_and_stays_a_true_circle() {
    let mut doc = Document::new();
    let (s, cid) = circle(&mut doc, pt(5.0, 5.0), 1.0);

    undoes_exactly(&mut doc, "set_sketch_circle_radius", |d| {
        d.set_sketch_circle_radius(s, cid, 2.5).unwrap();
    });

    let sk = doc.sketch(s).unwrap();
    let a = sk.curve_analytic(cid).expect("still analytic");
    assert!((a.geom.radius - 2.5).abs() < 1e-9);
    assert_eq!(a.geom.center, pt(5.0, 5.0), "scaled about its own centre");
    assert_eq!(sk.curve_edges(cid).len(), 24, "same facets, just bigger");
}

#[test]
fn a_circle_glued_to_other_geometry_refuses_a_radius() {
    let mut doc = Document::new();
    let (s, cid) = circle(&mut doc, pt(5.0, 5.0), 1.0);
    doc.begin_sketch_gesture(s).unwrap();
    doc.sketch_mut(s)
        .unwrap()
        .add_segment(pt(6.0, 5.0), pt(9.0, 5.0))
        .unwrap();
    doc.end_sketch_gesture(s).unwrap();
    assert!(matches!(
        doc.set_sketch_circle_radius(s, cid, 2.0),
        Err(DocumentError::Sketch(SketchError::CircleNotFree))
    ));
}
