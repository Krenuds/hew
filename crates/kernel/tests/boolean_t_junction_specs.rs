//! A union whose seam continuation degenerates to a point: a prism resting
//! exactly on a step's top face and reaching past the step's far edge. The
//! prism's side cuts the top face along a line that ends ON the top face's
//! far boundary, but the prism's side meets the step's far wall only at that
//! edge's endpoint, so no seam reaches the wall and its top edge would stay
//! whole while the top face's copy of the same edge is split — a T-junction
//! the weld cannot pair. Assembly now splits every edge at any kept vertex
//! lying on it, so the result welds watertight.

use kernel::{BooleanOp, Object, Plane, Point3, Profile, Transform, Vec3, WatertightState};

fn boxed(lo: Point3, hi: Point3) -> Object {
    let plane = Plane::from_point_normal(lo, Vec3::new(0.0, 0.0, 1.0)).unwrap();
    let pts = vec![
        Point3::new(lo.x, lo.y, lo.z),
        Point3::new(hi.x, lo.y, lo.z),
        Point3::new(hi.x, hi.y, lo.z),
        Point3::new(lo.x, hi.y, lo.z),
    ];
    let profile = Profile::new(plane, pts, vec![]).unwrap();
    Object::from_extrusion(&profile, hi.z - lo.z).unwrap()
}

/// A tall block (x 0..1, y 0..2, z 0..0.85) with a low, wider step in front
/// of it (x 0..3, y 2..4, z 0..0.44).
fn stepped() -> Object {
    let block = boxed(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 2.0, 0.85));
    let step = boxed(Point3::new(0.0, 2.0, 0.0), Point3::new(3.0, 4.0, 0.44));
    Object::boolean(BooleanOp::Union, &block, &step, &Transform::IDENTITY).unwrap()
}

fn bbox(obj: &Object) -> (Point3, Point3) {
    let mut lo = Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let mut hi = Point3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for v in obj.vertices().values() {
        let p = v.position;
        lo = Point3::new(lo.x.min(p.x), lo.y.min(p.y), lo.z.min(p.z));
        hi = Point3::new(hi.x.max(p.x), hi.y.max(p.y), hi.z.max(p.z));
    }
    (lo, hi)
}

#[test]
fn a_prism_on_a_step_reaching_past_its_far_edge_unions_watertight() {
    let base = stepped();
    assert_eq!(base.watertight(), WatertightState::Watertight);
    for overhang in [0.0, 0.0001, 0.1, 1.0] {
        let prism = boxed(
            Point3::new(0.0, 2.0, 0.44),
            Point3::new(1.0, 4.0 + overhang, 0.85),
        );
        let out = Object::boolean(BooleanOp::Union, &base, &prism, &Transform::IDENTITY)
            .unwrap_or_else(|e| panic!("overhang {overhang}: {e:?}"));
        assert_eq!(out.watertight(), WatertightState::Watertight);
        assert!(out.validate().is_ok(), "overhang {overhang}");
        let (lo, hi) = bbox(&out);
        assert!(lo.x.abs() < 1e-9 && lo.y.abs() < 1e-9 && lo.z.abs() < 1e-9);
        assert!(
            (hi.y - (4.0 + overhang)).abs() < 1e-9,
            "overhang {overhang}: {hi:?}"
        );
        assert!((hi.z - 0.85).abs() < 1e-9);
        // The added vertices are collinear with the edges they split: every
        // face is still exactly planar.
        for (_, f) in out.faces() {
            for p in out.loop_positions(f.outer_loop) {
                assert!(f.plane.signed_distance(p).abs() < 1e-9);
            }
        }
    }
}

#[test]
fn a_prism_that_stops_short_of_the_far_edge_still_unions() {
    let base = stepped();
    let prism = boxed(Point3::new(0.0, 2.0, 0.44), Point3::new(1.0, 3.0, 0.85));
    let out = Object::boolean(BooleanOp::Union, &base, &prism, &Transform::IDENTITY).unwrap();
    assert_eq!(out.watertight(), WatertightState::Watertight);
    assert!(out.validate().is_ok());
}

#[test]
fn a_prism_touching_only_along_an_edge_is_still_refused() {
    // Measure-zero contact: the prism shares one edge line with the block and
    // no face area — nothing to weld, refused as before.
    let base = stepped();
    let prism = boxed(Point3::new(1.0, 0.0, 0.85), Point3::new(2.0, 2.0, 1.5));
    assert!(Object::boolean(BooleanOp::Union, &base, &prism, &Transform::IDENTITY).is_err());
}
