//! Executable specs for two push/pull-and-draw behaviors users hit on a
//! P-shaped slab (a stem plus a wider bowl):
//!
//! - Pushing the bowl's east face inward PAST the plane of the stem's east
//!   face (a co-facing wall) must carve the stem rather than refuse: the
//!   overshoot classifier now counts co-facing walls whose footprint
//!   touches the pushed face's, so the push routes to the subtract path.
//! - A rectangle drawn on the top face from one edge's midpoint to
//!   another's — two of its sides lying ON the boundary — must imprint as a
//!   boundary-to-boundary chord instead of being refused as "not strictly
//!   inside" ([`Object::plan_loop_imprint`]).

use kernel::{Document, KernelOp, LoopImprintPlan, Object, Plane, Point3, Vec3};

fn ground() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("ground plane is well-defined")
}

/// The P slab in metres: stem x 0..0.0213 × y 0..0.1015, bowl x 0.0213..0.0369
/// × y 0.053..0.1015, 8.5 mm thick — the exact proportions of the reported
/// file.
const SX: f64 = 0.0213;
const BX: f64 = 0.0369;
const BY: f64 = 0.053;
const NY: f64 = 0.1015;
const H: f64 = 0.0085;

fn p_slab(doc: &mut Document) -> kernel::ObjectId {
    let s = doc.add_sketch(ground());
    let pts = [
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(SX, 0.0, 0.0),
        Point3::new(SX, BY, 0.0),
        Point3::new(BX, BY, 0.0),
        Point3::new(BX, NY, 0.0),
        Point3::new(0.0, NY, 0.0),
    ];
    {
        let sk = doc.sketch_mut(s).expect("sketch");
        for i in 0..pts.len() {
            sk.add_segment(pts[i], pts[(i + 1) % pts.len()])
                .expect("segment");
        }
    }
    let regions = doc.extrudable_regions(s).expect("regions");
    assert_eq!(regions.len(), 1);
    doc.extrude_region(s, regions[0], H).expect("extrude").0
}

/// The face of `obj` with outward normal `n` whose plane passes through `p`.
fn face_at(obj: &Object, n: Vec3, p: Point3) -> kernel::FaceId {
    obj.faces()
        .iter()
        .find(|(_, f)| {
            f.plane.normal().approx_eq(n, 1e-9) && f.plane.signed_distance(p).abs() < 1e-9
        })
        .map(|(id, _)| id)
        .expect("face exists")
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

// ------------------------------------------------------------ push past

#[test]
fn pushing_past_a_co_facing_wall_routes_to_the_subtract_and_carves_the_stem() {
    let mut doc = Document::new();
    let id = p_slab(&mut doc);
    let bowl_east = face_at(
        doc.object(id).unwrap(),
        Vec3::new(1.0, 0.0, 0.0),
        Point3::new(BX, 0.08, 0.004),
    );

    // Short of the stem face plane: the flat path stays in charge.
    assert!(
        !doc.object(id)
            .unwrap()
            .push_pull_overshoots(bowl_east, -0.010)
    );
    // Past it: the subtract path.
    assert!(
        doc.object(id)
            .unwrap()
            .push_pull_overshoots(bowl_east, -0.020)
    );

    let (results, _) = doc
        .push_pull_through(id, bowl_east, -0.020)
        .expect("push past the stem face carves rather than refuses");
    assert_eq!(results.len(), 1, "one solid comes back");
    let out = doc.object(results[0]).unwrap();
    assert!(out.validate().is_ok());
    assert_eq!(out.watertight(), kernel::WatertightState::Watertight);
    // The bowl now ends 20 mm west of where it was, notching into the stem.
    let east_now = BX - 0.020;
    assert!(
        out.faces().iter().any(|(_, f)| {
            f.plane.normal().approx_eq(Vec3::new(1.0, 0.0, 0.0), 1e-9)
                && f.plane
                    .signed_distance(Point3::new(east_now, 0.08, 0.004))
                    .abs()
                    < 1e-9
        }),
        "the pushed face sits at its new depth"
    );
    let (lo, hi) = bbox(out);
    assert!(
        (hi.x - SX).abs() < 1e-9,
        "the stem's east face is still the outermost x"
    );
    assert!((lo.x).abs() < 1e-9 && (hi.y - NY).abs() < 1e-9);
    // Nothing above y = BY reaches past the new bowl depth.
    for v in out.vertices().values() {
        if v.position.y > BY + 1e-9 {
            assert!(
                v.position.x <= east_now + 1e-9,
                "stem material past the notch is gone"
            );
        }
    }
    // Undo restores the original object verbatim.
    let before = doc.save();
    doc.undo().expect("undo");
    doc.redo().expect("redo");
    assert_eq!(doc.save(), before);
}

#[test]
fn a_push_that_stays_inside_its_own_bowl_keeps_the_flat_path() {
    let mut doc = Document::new();
    let id = p_slab(&mut doc);
    let bowl_east = face_at(
        doc.object(id).unwrap(),
        Vec3::new(1.0, 0.0, 0.0),
        Point3::new(BX, 0.08, 0.004),
    );
    doc.apply_object_op(
        id,
        KernelOp::PushPull {
            face: bowl_east,
            distance: -0.010,
        },
    )
    .expect("flat push within the bowl");
    let (_, hi) = bbox(doc.object(id).unwrap());
    assert!((hi.x - (BX - 0.010)).abs() < 1e-9);
}

// --------------------------------------------------------- loop imprint

#[test]
fn a_rectangle_from_edge_midpoint_to_edge_midpoint_plans_as_one_chord() {
    let mut doc = Document::new();
    let id = p_slab(&mut doc);
    let top = face_at(
        doc.object(id).unwrap(),
        Vec3::new(0.0, 0.0, 1.0),
        Point3::new(0.01, 0.01, H),
    );
    let west_mid = Point3::new(0.0, NY / 2.0, H);
    let north_mid = Point3::new(BX / 2.0, NY, H);
    // The rectangle spanned by those two points: two sides on the boundary.
    let rect = [
        west_mid,
        Point3::new(north_mid.x, west_mid.y, H),
        north_mid,
        Point3::new(0.0, NY, H),
    ];
    let plan = doc
        .object(id)
        .unwrap()
        .plan_loop_imprint(top, &rect)
        .expect("plan");
    match plan {
        LoopImprintPlan::Chords(chords) => {
            assert_eq!(chords.len(), 1);
            assert_eq!(chords[0].len(), 3, "north-mid → inner corner → west-mid");
            let ends = [chords[0][0], chords[0][2]];
            assert!(ends.contains(&north_mid) && ends.contains(&west_mid));
            assert_eq!(chords[0][1], Point3::new(north_mid.x, west_mid.y, H));
            // And it actually cuts: the top face becomes two faces, the
            // rectangle being one of them.
            let faces_before = doc.object(id).unwrap().faces().len();
            let (report, _) = doc
                .apply_object_op(
                    id,
                    KernelOp::SplitFace {
                        face: top,
                        path: chords[0].clone(),
                        restore: None,
                    },
                )
                .expect("chord split");
            let kernel::KernelOpReport::FaceSplit(r) = report else {
                panic!("split report")
            };
            assert_eq!(doc.object(id).unwrap().faces().len(), faces_before + 1);
            let out = doc.object(id).unwrap();
            assert!(out.validate().is_ok());
            let inner = Point3::new(north_mid.x / 2.0, (west_mid.y + NY) / 2.0, H);
            assert!(r.new_faces.iter().any(|&nf| {
                let f = &out.faces()[nf];
                f.plane.signed_distance(inner).abs() < 1e-9
            }));
        }
        other => panic!("expected a chord plan, got {other:?}"),
    }
}

#[test]
fn loops_clear_of_the_boundary_stay_inner_and_a_spanning_rectangle_plans_two_chords() {
    let mut doc = Document::new();
    let id = p_slab(&mut doc);
    let obj = doc.object(id).unwrap();
    let top = face_at(obj, Vec3::new(0.0, 0.0, 1.0), Point3::new(0.01, 0.01, H));
    let inner = [
        Point3::new(0.005, 0.01, H),
        Point3::new(0.015, 0.01, H),
        Point3::new(0.015, 0.03, H),
        Point3::new(0.005, 0.03, H),
    ];
    assert!(matches!(
        obj.plan_loop_imprint(top, &inner),
        Ok(LoopImprintPlan::Inner(_))
    ));
    // West edge to the stem's east edge, across the stem: two straight chords.
    let spanning = [
        Point3::new(0.0, 0.01, H),
        Point3::new(SX, 0.01, H),
        Point3::new(SX, 0.03, H),
        Point3::new(0.0, 0.03, H),
    ];
    match obj.plan_loop_imprint(top, &spanning).expect("plan") {
        LoopImprintPlan::Chords(chords) => {
            assert_eq!(chords.len(), 2);
            assert!(chords.iter().all(|c| c.len() == 2));
        }
        other => panic!("expected two chords, got {other:?}"),
    }
    // A loop that only TOUCHES the boundary at a corner has no shared side:
    // still the inner plan (and that path's own strictness applies).
    let touching = [
        Point3::new(0.0, 0.01, H),
        Point3::new(0.01, 0.01, H),
        Point3::new(0.01, 0.02, H),
        Point3::new(0.0, 0.02, H),
    ];
    // Its west side (x = 0 from y 0.01 to 0.02) lies ON the west edge: one
    // chord of three points, not a touching corner.
    match obj.plan_loop_imprint(top, &touching).expect("plan") {
        LoopImprintPlan::Chords(chords) => assert_eq!((chords.len(), chords[0].len()), (1, 4)),
        other => panic!("expected one chord, got {other:?}"),
    }
}

// ------------------------------------------------- orchestrated imprint

#[test]
fn imprint_loop_on_face_routes_an_edge_hugging_rectangle_to_a_chord_and_the_region_pushes() {
    let mut doc = Document::new();
    let id = p_slab(&mut doc);
    let top = face_at(
        doc.object(id).unwrap(),
        Vec3::new(0.0, 0.0, 1.0),
        Point3::new(0.01, 0.01, H),
    );
    let west_mid = Point3::new(0.0, NY / 2.0, H);
    let north_mid = Point3::new(BX / 2.0, NY, H);
    let rect = vec![
        west_mid,
        Point3::new(north_mid.x, west_mid.y, H),
        north_mid,
        Point3::new(0.0, NY, H),
    ];
    let depth = doc.undo_depth();
    let (report, _) = doc
        .imprint_loop_on_face(None, id, top, rect, None)
        .expect("edge-hugging rectangle imprints");
    assert_eq!(report.route, kernel::LoopImprintRoute::Chords(1));
    assert_eq!(doc.undo_depth(), depth + 1);
    let obj = doc.object(id).unwrap();
    let centroid = Point3::new(north_mid.x / 2.0, (west_mid.y + NY) / 2.0, H);
    assert!(obj.face_contains_point(report.region, centroid));
    assert!(!obj.face_contains_point(report.other, centroid));
    // The region is a real face: pull it up 5 mm and the solid stays solid.
    doc.apply_object_op(
        id,
        KernelOp::PushPull {
            face: report.region,
            distance: 0.005,
        },
    )
    .expect("push/pull the drawn region");
    let obj = doc.object(id).unwrap();
    assert!(obj.validate().is_ok());
    assert!(obj.faces().iter().any(|(_, f)| {
        f.plane.normal().approx_eq(Vec3::new(0.0, 0.0, 1.0), 1e-9)
            && f.plane
                .signed_distance(Point3::new(centroid.x, centroid.y, H + 0.005))
                .abs()
                < 1e-9
    }));
    doc.undo().expect("undo pull");
    doc.undo().expect("undo imprint");
    assert_eq!(doc.undo_depth(), depth);
    assert_eq!(doc.object(id).unwrap().faces().len(), 8);
}

#[test]
fn a_concave_loop_hugging_one_edge_still_names_its_own_region() {
    // A C shape whose back runs along the west edge: its vertex average
    // sits in the C's notch, OUTSIDE the loop, so a centroid-based pick
    // would hand back the notch as the drawn region.
    let mut doc = Document::new();
    let id = p_slab(&mut doc);
    let top = face_at(
        doc.object(id).unwrap(),
        Vec3::new(0.0, 0.0, 1.0),
        Point3::new(0.01, 0.01, H),
    );
    let c_loop = vec![
        Point3::new(0.0, 0.02, H),
        Point3::new(0.012, 0.02, H),
        Point3::new(0.012, 0.03, H),
        Point3::new(0.003, 0.03, H),
        Point3::new(0.003, 0.06, H),
        Point3::new(0.012, 0.06, H),
        Point3::new(0.012, 0.07, H),
        Point3::new(0.0, 0.07, H),
    ];
    let n = c_loop.len() as f64;
    let vertex_average = c_loop.iter().fold(Point3::new(0.0, 0.0, 0.0), |acc, p| {
        Point3::new(acc.x + p.x / n, acc.y + p.y / n, acc.z + p.z / n)
    });
    let in_notch = Point3::new(0.0075, 0.045, H);
    let in_back = Point3::new(0.0015, 0.045, H);
    let in_arm = Point3::new(0.0075, 0.025, H);
    assert!(
        (vertex_average.x - in_notch.x).abs() < 1e-3
            && (vertex_average.y - in_notch.y).abs() < 1e-9
    );

    let (report, _) = doc
        .imprint_loop_on_face(None, id, top, c_loop, None)
        .expect("edge-hugging C imprints");
    assert_eq!(report.route, kernel::LoopImprintRoute::Chords(1));
    let obj = doc.object(id).unwrap();
    assert!(obj.validate().is_ok());
    assert!(obj.face_contains_point(report.region, in_back));
    assert!(obj.face_contains_point(report.region, in_arm));
    assert!(!obj.face_contains_point(report.region, in_notch));
    assert!(obj.face_contains_point(report.other, in_notch));
    assert!(!obj.face_contains_point(report.other, in_back));
}

#[test]
fn imprint_loop_on_face_bundles_two_chords_into_one_undo_entry() {
    let mut doc = Document::new();
    let id = p_slab(&mut doc);
    let top = face_at(
        doc.object(id).unwrap(),
        Vec3::new(0.0, 0.0, 1.0),
        Point3::new(0.01, 0.01, H),
    );
    let spanning = vec![
        Point3::new(0.0, 0.01, H),
        Point3::new(SX, 0.01, H),
        Point3::new(SX, 0.03, H),
        Point3::new(0.0, 0.03, H),
    ];
    let depth = doc.undo_depth();
    let (report, _) = doc
        .imprint_loop_on_face(None, id, top, spanning, None)
        .expect("spanning rectangle imprints");
    assert_eq!(report.route, kernel::LoopImprintRoute::Chords(2));
    assert_eq!(doc.undo_depth(), depth + 1, "two chords, one entry");
    let obj = doc.object(id).unwrap();
    assert_eq!(obj.faces().len(), 10);
    assert!(obj.face_contains_point(report.region, Point3::new(0.01, 0.02, H)));
    doc.undo().expect("undo");
    assert_eq!(doc.object(id).unwrap().faces().len(), 8);
}
