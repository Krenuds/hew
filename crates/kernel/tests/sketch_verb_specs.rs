//! Executable specs for the 2D VERBS on a drawn sketch: extend, fillet,
//! chamfer, mirror, array. Trim is Erase — the sticky rules already split a
//! line at every crossing, so the piece between two crossings is its own edge
//! and erasing it is the trim. Each verb here is drawn geometry through the
//! same sticky rules a hand stroke goes through, one undo step, refused
//! whole when the sketch's rules would refuse it.

use kernel::{CurveGeom, Document, DocumentError, Plane, Point3, SketchError, SketchId, Vec3};

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

/// Draws `segments` as one gesture into a fresh ground sketch.
fn drawn(doc: &mut Document, segments: &[(Point3, Point3)]) -> SketchId {
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).unwrap();
    for &(a, b) in segments {
        doc.sketch_mut(s).unwrap().add_segment(a, b).unwrap();
    }
    doc.end_sketch_gesture(s).unwrap();
    s
}

fn edge(doc: &Document, s: SketchId, a: Point3, b: Point3) -> kernel::SketchEdgeId {
    doc.sketch(s)
        .unwrap()
        .edge_at_positions(a, b)
        .expect("edge")
}

fn has_edge(doc: &Document, s: SketchId, a: Point3, b: Point3) -> bool {
    doc.sketch(s).unwrap().edge_at_positions(a, b).is_some()
}

fn vertex_at(doc: &Document, s: SketchId, p: Point3) -> kernel::SketchVertexId {
    doc.sketch(s)
        .unwrap()
        .vertices()
        .iter()
        .find(|(_, v)| (v.position - p).length() < 1e-9)
        .map(|(id, _)| id)
        .expect("vertex")
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

// ------------------------------------------------------------------ extend

#[test]
fn a_line_extends_to_meet_another_and_splits_it() {
    let mut doc = Document::new();
    let s = drawn(
        &mut doc,
        &[(pt(0.0, 0.0), pt(2.0, 0.0)), (pt(4.0, -1.0), pt(4.0, 1.0))],
    );
    let line = edge(&doc, s, pt(0.0, 0.0), pt(2.0, 0.0));
    let wall = edge(&doc, s, pt(4.0, -1.0), pt(4.0, 1.0));

    undoes_exactly(&mut doc, "extend_sketch_edge", |d| {
        d.extend_sketch_edge(s, line, pt(1.8, 0.0), wall).unwrap();
    });

    assert!(
        has_edge(&doc, s, pt(2.0, 0.0), pt(4.0, 0.0)),
        "the missing piece"
    );
    assert!(
        has_edge(&doc, s, pt(4.0, -1.0), pt(4.0, 0.0)),
        "the wall split where it was met"
    );
    assert!(has_edge(&doc, s, pt(4.0, 0.0), pt(4.0, 1.0)));
}

#[test]
fn extending_away_from_or_beside_a_target_is_refused() {
    let mut doc = Document::new();
    let s = drawn(
        &mut doc,
        &[(pt(0.0, 0.0), pt(2.0, 0.0)), (pt(4.0, 1.0), pt(4.0, 3.0))],
    );
    let line = edge(&doc, s, pt(0.0, 0.0), pt(2.0, 0.0));
    let wall = edge(&doc, s, pt(4.0, 1.0), pt(4.0, 3.0));
    let before = doc.state_hash();
    assert!(matches!(
        doc.extend_sketch_edge(s, line, pt(1.8, 0.0), wall),
        Err(DocumentError::Sketch(SketchError::NothingToExtendTo))
    ));
    assert!(matches!(
        doc.extend_sketch_edge(s, line, pt(0.2, 0.0), wall),
        Err(DocumentError::Sketch(SketchError::NothingToExtendTo))
    ));
    assert_eq!(doc.state_hash(), before);
}

// ------------------------------------------------------ fillet and chamfer

/// An L: two lines meeting at the origin.
fn corner(doc: &mut Document) -> SketchId {
    drawn(
        doc,
        &[(pt(3.0, 0.0), pt(0.0, 0.0)), (pt(0.0, 0.0), pt(0.0, 3.0))],
    )
}

#[test]
fn a_corner_chamfers_to_a_straight_cut() {
    let mut doc = Document::new();
    let s = corner(&mut doc);
    let v = vertex_at(&doc, s, pt(0.0, 0.0));

    undoes_exactly(&mut doc, "chamfer_sketch_corner", |d| {
        d.chamfer_sketch_corner(s, v, 1.0).unwrap();
    });

    assert!(has_edge(&doc, s, pt(3.0, 0.0), pt(1.0, 0.0)));
    assert!(has_edge(&doc, s, pt(1.0, 0.0), pt(0.0, 1.0)), "the cut");
    assert!(has_edge(&doc, s, pt(0.0, 1.0), pt(0.0, 3.0)));
    assert_eq!(doc.sketch(s).unwrap().edges().len(), 3);
}

#[test]
fn a_corner_fillets_to_a_true_arc_tangent_to_both_lines() {
    let mut doc = Document::new();
    let s = corner(&mut doc);
    let v = vertex_at(&doc, s, pt(0.0, 0.0));

    undoes_exactly(&mut doc, "fillet_sketch_corner", |d| {
        d.fillet_sketch_corner(s, v, 1.0).unwrap();
    });

    let sk = doc.sketch(s).unwrap();
    assert!(
        sk.edge_at_positions(pt(3.0, 0.0), pt(1.0, 0.0)).is_some(),
        "arm cut back by r"
    );
    assert!(sk.edge_at_positions(pt(0.0, 1.0), pt(0.0, 3.0)).is_some());
    // The arc is a curve chain about (1, 1) with radius 1, every facet
    // vertex on that circle, ending exactly at the tangent points.
    let arc_edge = sk
        .edges()
        .iter()
        .find(|(_, e)| e.curve.is_some())
        .map(|(_, e)| e.curve.unwrap())
        .expect("an arc chain");
    let a = sk.curve_analytic(arc_edge).expect("analytic");
    assert!((a.geom.center - pt(1.0, 1.0)).length() < 1e-9);
    assert!((a.geom.radius - 1.0).abs() < 1e-9);
    for eid in sk.curve_edges(arc_edge) {
        let e = sk.edges()[eid];
        for vid in [e.from, e.to] {
            let p = sk.vertices()[vid].position;
            assert!(
                ((p - a.geom.center).length() - 1.0).abs() < 1e-9,
                "facet vertex on the circle"
            );
        }
    }
    assert!(
        sk.curve_edges(arc_edge).len() >= 6,
        "a quarter turn gets its share of facets"
    );
    assert!(
        sk.vertices()
            .iter()
            .all(|(_, v)| (v.position - pt(0.0, 0.0)).length() > 1e-9),
        "the corner is gone"
    );
}

#[test]
fn a_fillet_that_does_not_fit_and_a_non_corner_are_refused() {
    let mut doc = Document::new();
    let s = corner(&mut doc);
    let v = vertex_at(&doc, s, pt(0.0, 0.0));
    let before = doc.state_hash();
    assert!(matches!(
        doc.fillet_sketch_corner(s, v, 5.0),
        Err(DocumentError::Sketch(SketchError::CornerTooSmall))
    ));
    let free_end = vertex_at(&doc, s, pt(3.0, 0.0));
    assert!(matches!(
        doc.fillet_sketch_corner(s, free_end, 0.5),
        Err(DocumentError::Sketch(SketchError::NotACorner))
    ));
    assert!(matches!(
        doc.chamfer_sketch_corner(s, v, -1.0),
        Err(DocumentError::Sketch(SketchError::InvalidDimension))
    ));
    assert_eq!(doc.state_hash(), before);
}

// ------------------------------------------------------------------ mirror

#[test]
fn a_shape_mirrors_across_a_line_and_the_original_stays() {
    let mut doc = Document::new();
    let s = drawn(
        &mut doc,
        &[
            (pt(1.0, 0.0), pt(3.0, 0.0)),
            (pt(3.0, 0.0), pt(3.0, 1.0)),
            (pt(3.0, 1.0), pt(1.0, 0.0)),
        ],
    );
    let island = doc.sketch(s).unwrap().islands().keys().next().unwrap();

    undoes_exactly(&mut doc, "mirror_sketch_islands", |d| {
        d.mirror_sketch_islands(s, &[island], pt(0.0, 0.0), Vec3::new(0.0, 1.0, 0.0))
            .unwrap();
    });

    assert!(
        has_edge(&doc, s, pt(1.0, 0.0), pt(3.0, 0.0)),
        "the original"
    );
    assert!(has_edge(&doc, s, pt(-1.0, 0.0), pt(-3.0, 0.0)), "its image");
    assert!(has_edge(&doc, s, pt(-3.0, 1.0), pt(-1.0, 0.0)));
    assert_eq!(
        doc.sketch(s).unwrap().regions().len(),
        2,
        "two closed shapes now"
    );
}

#[test]
fn a_mirrored_circle_is_still_a_circle() {
    let mut doc = Document::new();
    let s = doc.add_sketch(ground());
    doc.begin_sketch_gesture(s).unwrap();
    let (center, radius) = (pt(2.0, 0.0), 0.5);
    {
        let sk = doc.sketch_mut(s).unwrap();
        sk.begin_curve_with(CurveGeom { center, radius }).unwrap();
        let n = 24;
        let p = |i: usize| {
            let a = std::f64::consts::TAU * (i as f64) / (n as f64);
            pt(center.x + radius * a.cos(), center.y + radius * a.sin())
        };
        for i in 0..n {
            sk.add_segment(p(i), p(i + 1)).unwrap();
        }
        sk.end_curve();
    }
    doc.end_sketch_gesture(s).unwrap();
    let island = doc.sketch(s).unwrap().islands().keys().next().unwrap();

    doc.mirror_sketch_islands(s, &[island], pt(0.0, 0.0), Vec3::new(0.0, 1.0, 0.0))
        .unwrap();

    let sk = doc.sketch(s).unwrap();
    let centers: Vec<Point3> = sk
        .edges()
        .values()
        .filter_map(|e| e.curve)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter_map(|c| sk.curve_analytic(c).map(|a| a.geom.center))
        .collect();
    assert_eq!(centers.len(), 2);
    assert!(
        centers.iter().any(|c| (*c - pt(-2.0, 0.0)).length() < 1e-9),
        "the image keeps its analytic circle"
    );
}

// ------------------------------------------------------------------- array

#[test]
fn an_array_draws_the_copies_along_the_step() {
    let mut doc = Document::new();
    let s = drawn(
        &mut doc,
        &[
            (pt(0.0, 0.0), pt(1.0, 0.0)),
            (pt(1.0, 0.0), pt(1.0, 1.0)),
            (pt(1.0, 1.0), pt(0.0, 1.0)),
            (pt(0.0, 1.0), pt(0.0, 0.0)),
        ],
    );
    let island = doc.sketch(s).unwrap().islands().keys().next().unwrap();

    undoes_exactly(&mut doc, "array_sketch_islands", |d| {
        d.array_sketch_islands(s, &[island], Vec3::new(2.0, 0.0, 0.0), 3)
            .unwrap();
    });

    let sk = doc.sketch(s).unwrap();
    assert_eq!(sk.regions().len(), 4, "the original and three copies");
    assert!(
        sk.edge_at_positions(pt(6.0, 0.0), pt(7.0, 0.0)).is_some(),
        "the third copy"
    );
}

#[test]
fn an_array_step_off_the_plane_is_refused() {
    let mut doc = Document::new();
    let s = drawn(&mut doc, &[(pt(0.0, 0.0), pt(1.0, 0.0))]);
    let island = doc.sketch(s).unwrap().islands().keys().next().unwrap();
    assert!(matches!(
        doc.array_sketch_islands(s, &[island], Vec3::new(0.0, 0.0, 1.0), 2),
        Err(DocumentError::Sketch(SketchError::PointOffPlane {
            which: 0
        }))
    ));
}
