//! Executable specs for LOCKED SKETCHES: a sketch you draw *against* rather
//! than *into* — a chalk line.
//!
//! The four guarantees, one section each:
//!
//! 1. It never welds. Drawing over it snaps and infers against it but never
//!    splits its edges or merges into its islands.
//! 2. Nothing is ever consumed out of it. Extrude and Follow Me build from it
//!    by copy: the solid is born and the outline stays.
//! 3. It stays fully live for inference — every snap source survives.
//! 4. Unlocking returns it to an ordinary sketch; deleting works normally.
//!
//! "Locked sketch" is durable entity state. It is NOT the axis/plane lock the
//! drawing tools apply to a gesture — that one is a transient cursor
//! constraint and lives entirely above the kernel.

use std::io::{Cursor, Read, Write};

use kernel::{Document, DocumentError, LoadError, Plane, Point3, Transform, Vec3};

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

/// Draw an axis-aligned rectangle into `doc`'s sketch `s` at z = 0.
fn draw_rect(doc: &mut Document, s: kernel::SketchId, x0: f64, y0: f64, x1: f64, y1: f64) {
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

/// A fresh ground sketch carrying one rectangle.
fn rect_sketch(doc: &mut Document, x0: f64, y0: f64, x1: f64, y1: f64) -> kernel::SketchId {
    let s = doc.add_sketch(ground());
    draw_rect(doc, s, x0, y0, x1, y1);
    s
}

/// The single extrudable region of a sketch (panics unless exactly one).
fn only_region(doc: &Document, s: kernel::SketchId) -> kernel::SketchRegionId {
    let regions = doc.extrudable_regions(s).expect("sketch is live");
    assert_eq!(regions.len(), 1, "expected exactly one extrudable region");
    regions[0]
}

fn edge_count(doc: &Document, s: kernel::SketchId) -> usize {
    doc.sketch(s).expect("sketch is live").edges().len()
}

fn region_count(doc: &Document, s: kernel::SketchId) -> usize {
    doc.sketch(s).expect("sketch is live").regions().len()
}

/// The area of a sketch's one region — the "is my reference dimension still
/// what I drew?" check, stated the way a tape measure would state it.
fn only_region_area(doc: &Document, s: kernel::SketchId) -> f64 {
    let r = only_region(doc, s);
    doc.sketch(s)
        .expect("sketch is live")
        .region_area(r)
        .expect("region is live")
}

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
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut buf = Vec::new();
    zip.by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut buf)
        .unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&buf).unwrap();
    edit(&mut manifest);
    let patched = serde_json::to_vec_pretty(&manifest).unwrap();

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
        let mut b = Vec::new();
        entry.read_to_end(&mut b).unwrap();
        out.start_file(&name, opts).unwrap();
        out.write_all(&b).unwrap();
    }
    out.finish().unwrap().into_inner()
}

// ==================================================== 1. it never welds

/// The bug this feature exists to fix, pinned as a spec so it cannot come
/// back by accident: an UNLOCKED footprint is eaten by the boards laid on it.
///
/// Frame a 20x20 deck. The 20x20 footprint and a 3.5"-wide joist share a
/// sketch, so the joist outline welds in and splits the footprint. Three of
/// the joist region's four edges are footprint perimeter and bound no
/// surviving region, so extruding the joist takes them — and the reference
/// dimension the whole layout was measured from is gone.
#[test]
fn an_unlocked_footprint_is_consumed_by_the_joists_laid_on_it() {
    let mut doc = Document::new();
    let footprint = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    assert_eq!(only_region_area(&doc, footprint), 400.0);

    // A joist along the y = 0 edge, drawn into the SAME sketch: it welds.
    draw_rect(&mut doc, footprint, 0.0, 0.0, 20.0, 0.2917);
    assert_eq!(
        region_count(&doc, footprint),
        2,
        "the joist outline split the footprint in two"
    );

    // Extrude the joist. Its three perimeter edges bound nothing else.
    let joist = doc
        .extrudable_regions(footprint)
        .unwrap()
        .into_iter()
        .min_by(|&a, &b| {
            let sk = doc.sketch(footprint).unwrap();
            sk.region_area(a)
                .unwrap()
                .partial_cmp(&sk.region_area(b).unwrap())
                .unwrap()
        })
        .unwrap();
    doc.extrude_region(footprint, joist, 0.2917)
        .expect("the joist extrudes");

    // The footprint is now short by the joist's width. This is the disease.
    let left = only_region_area(&doc, footprint);
    assert!(
        (left - 20.0 * (20.0 - 0.2917)).abs() < 1e-9,
        "the footprint shrank to the remainder: {left}"
    );
}

/// The cure. Lock the footprint and the joists cannot reach it: they land in
/// their own sketches, extrude out of those, and the 20x20 is still 20x20 six
/// boards later.
#[test]
fn a_locked_footprint_survives_six_joists() {
    let mut doc = Document::new();
    let footprint = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    doc.set_sketch_locked(footprint, true)
        .expect("the footprint locks");

    // Six 3-1/2" joists, 16" on centre, each on its own sketch — which is
    // what the draw tools do once the plane's cached handle is locked.
    let width = 0.2917;
    for i in 0..6 {
        let y = f64::from(i) * 0.4064;
        let s = rect_sketch(&mut doc, 0.0, y, 20.0, y + width);
        let r = only_region(&doc, s);
        doc.extrude_region(s, r, 0.2917)
            .expect("the joist extrudes");
    }

    assert_eq!(doc.visible_object_ids().len(), 6, "six boards stand");
    assert_eq!(
        edge_count(&doc, footprint),
        4,
        "the footprint kept all four of its edges"
    );
    assert_eq!(
        region_count(&doc, footprint),
        1,
        "nothing split the footprint"
    );
    assert_eq!(
        only_region_area(&doc, footprint),
        400.0,
        "the reference dimension is still 20 x 20"
    );
}

/// The mechanism, stated directly: a locked sketch hands out no `&mut`, so
/// every welding path — `add_segment` and its siblings — is closed at once.
#[test]
fn a_locked_sketch_hands_out_no_mutable_handle() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    assert!(doc.sketch_mut(s).is_some(), "an ordinary sketch is mutable");

    doc.set_sketch_locked(s, true).unwrap();
    assert!(doc.sketch_mut(s).is_none(), "a locked sketch is not");
    assert!(
        doc.sketch(s).is_some(),
        "but it is still readable — reads are never refused"
    );
}

/// A gesture cannot open on a locked sketch: the refusal is at the door, so
/// no partial edit can be stranded inside an open bracket.
#[test]
fn no_gesture_opens_on_a_locked_sketch() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    doc.set_sketch_locked(s, true).unwrap();

    assert_eq!(
        doc.begin_sketch_gesture(s),
        Err(DocumentError::SketchLocked),
        "the gesture is refused before it opens"
    );
}

/// A coplanar sketch drawn over a locked one is fully independent: same
/// plane, overlapping outlines, zero interaction. (Welding was never
/// cross-sketch — this pins that the lock does not need it to be.)
#[test]
fn a_sketch_over_a_locked_one_is_wholly_independent() {
    let mut doc = Document::new();
    let chalk = rect_sketch(&mut doc, 0.0, 0.0, 10.0, 10.0);
    doc.set_sketch_locked(chalk, true).unwrap();

    // A rectangle straddling the locked outline's own corner.
    let stock = rect_sketch(&mut doc, 5.0, 5.0, 15.0, 15.0);

    assert_eq!(edge_count(&doc, chalk), 4);
    assert_eq!(region_count(&doc, chalk), 1);
    assert_eq!(edge_count(&doc, stock), 4);
    assert_eq!(region_count(&doc, stock), 1);
}

// ============================================ 2. nothing is consumed out

/// A locked sketch is a drawing, not stock: the solid is born from a COPY of
/// the profile, and the sketch is exactly what it was.
#[test]
fn a_locked_region_extrudes_by_copy() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    let r = only_region(&doc, s);
    doc.set_sketch_locked(s, true).unwrap();
    let drawn = doc.sketch(s).unwrap().clone();

    doc.extrude_region(s, r, 1.0)
        .expect("a locked region builds a solid");

    assert_eq!(doc.visible_object_ids().len(), 1, "the solid was born");
    assert_eq!(
        doc.sketch(s).expect("the sketch is still in the document"),
        &drawn,
        "and nothing left the sketch — not an edge, a region, or a vertex"
    );
    assert_eq!(only_region(&doc, s), r, "the region keeps its handle");
}

/// Building from EVERY region of an ordinary sketch empties it and removes
/// it. A locked one is never emptied, so it never leaves — and the same
/// region can be built from again.
#[test]
fn building_from_every_region_never_removes_a_locked_sketch() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 4.0, 4.0);
    draw_rect(&mut doc, s, 10.0, 0.0, 14.0, 4.0);
    doc.set_sketch_locked(s, true).unwrap();

    for r in doc.extrudable_regions(s).unwrap() {
        doc.extrude_region(s, r, 1.0).expect("each room goes up");
    }
    assert_eq!(doc.visible_object_ids().len(), 2);
    assert!(doc.sketch(s).is_some(), "the plan is still on the table");
    assert_eq!(region_count(&doc, s), 2);
    assert_eq!(edge_count(&doc, s), 8);

    let again = doc.extrudable_regions(s).unwrap()[0];
    doc.extrude_region(s, again, 2.0)
        .expect("a drawing can be built from twice");
    assert_eq!(doc.visible_object_ids().len(), 3);
}

/// Undo of a locked extrude has no outline to put back: it hides the solid
/// and leaves the sketch identical. Redo brings the solid back and still
/// takes nothing.
#[test]
fn a_locked_extrude_undoes_and_redoes_around_an_untouched_sketch() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    let r = only_region(&doc, s);
    doc.set_sketch_locked(s, true).unwrap();
    let drawn = doc.sketch(s).unwrap().clone();
    doc.extrude_region(s, r, 1.0).unwrap();

    doc.undo().expect("undo the extrude");
    assert_eq!(doc.visible_object_ids().len(), 0);
    assert_eq!(doc.sketch(s).unwrap(), &drawn);
    assert!(doc.is_sketch_locked(s), "only the extrude was undone");

    doc.redo().expect("redo the extrude");
    assert_eq!(doc.visible_object_ids().len(), 1);
    assert_eq!(doc.sketch(s).unwrap(), &drawn);
}

/// The two lifecycles interleave on ONE sketch and unwind exactly: built
/// from by copy while locked, consumed as stock once unlocked.
#[test]
fn a_copy_extrude_and_a_consuming_extrude_unwind_in_order() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    let r = only_region(&doc, s);

    doc.set_sketch_locked(s, true).unwrap();
    doc.extrude_region(s, r, 1.0).expect("by copy");
    doc.set_sketch_locked(s, false).unwrap();
    doc.extrude_region(s, r, 2.0).expect("as stock");
    assert_eq!(doc.visible_object_ids().len(), 2);
    assert!(
        doc.sketch(s).is_none(),
        "the unlocked extrude consumed the outline, and the sketch with it"
    );

    for _ in 0..4 {
        doc.undo().expect("each step unwinds");
    }
    assert_eq!(doc.visible_object_ids().len(), 0);
    // The consuming extrude's undo re-inserts the outline under fresh
    // handles, so the comparison is by geometry rather than by identity.
    assert_eq!(edge_count(&doc, s), 4, "the sketch is back");
    assert_eq!(only_region_area(&doc, s), 400.0);
    assert!(!doc.is_sketch_locked(s));

    for _ in 0..4 {
        doc.redo().expect("and replays");
    }
    assert_eq!(doc.visible_object_ids().len(), 2);
    assert!(doc.sketch(s).is_none());
}

/// A drawn circle's analytic identity rides the copy: the walls of a solid
/// built from a locked circle carry the cylinder, and the circle keeps its
/// curve chain.
#[test]
fn a_locked_circle_builds_a_claimed_cylinder_and_keeps_its_curve() {
    let mut doc = Document::new();
    let s = doc.add_sketch(ground());
    {
        let sk = doc.sketch_mut(s).unwrap();
        sk.begin_curve_with(kernel::CurveGeom {
            center: Point3::new(0.0, 0.0, 0.0),
            radius: 2.0,
        })
        .expect("a fresh curve chain opens");
        let n = 16;
        for i in 0..n {
            let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
            let b = std::f64::consts::TAU * f64::from(i + 1) / f64::from(n);
            sk.add_segment(
                Point3::new(2.0 * a.cos(), 2.0 * a.sin(), 0.0),
                Point3::new(2.0 * b.cos(), 2.0 * b.sin(), 0.0),
            )
            .unwrap();
        }
        sk.end_curve();
    }
    let r = only_region(&doc, s);
    doc.set_sketch_locked(s, true).unwrap();
    let drawn = doc.sketch(s).unwrap().clone();

    let (post, _) = doc.extrude_region(s, r, 3.0).expect("a post goes up");

    let radius = doc
        .object(post)
        .expect("live")
        .faces()
        .values()
        .find_map(|f| match f.surface {
            Some(kernel::SurfaceRef::Cylinder { radius, .. }) => Some(radius),
            _ => None,
        })
        .expect("a wall face carries the cylinder");
    assert!((radius - 2.0).abs() < 1e-12);
    assert_eq!(
        doc.sketch(s).unwrap(),
        &drawn,
        "the circle is still a circle"
    );
}

/// Follow Me commits through the same door as extrude: a locked PROFILE is
/// swept by copy.
#[test]
fn a_locked_profile_sweeps_by_copy() {
    let mut doc = Document::new();
    let path = doc.add_sketch(ground());
    {
        let sk = doc.sketch_mut(path).unwrap();
        sk.add_segment(Point3::new(0.0, 0.0, 0.0), Point3::new(0.0, 4.0, 0.0))
            .unwrap();
    }
    let path_edges: Vec<_> = doc.sketch(path).unwrap().edges().keys().collect();

    let profile_plane = Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 0.0, 1.0),
    ])
    .unwrap();
    let profile = doc.add_sketch(profile_plane);
    {
        let sk = doc.sketch_mut(profile).unwrap();
        for (a, b) in [
            (Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 0.0, 0.0)),
            (Point3::new(1.0, 0.0, 0.0), Point3::new(1.0, 0.0, 1.0)),
            (Point3::new(1.0, 0.0, 1.0), Point3::new(0.0, 0.0, 1.0)),
            (Point3::new(0.0, 0.0, 1.0), Point3::new(0.0, 0.0, 0.0)),
        ] {
            sk.add_segment(a, b).unwrap();
        }
    }
    let region = only_region(&doc, profile);
    doc.set_sketch_locked(profile, true).unwrap();
    let drawn = doc.sketch(profile).unwrap().clone();

    doc.follow_me(
        profile,
        region,
        &kernel::FollowMePath::SketchEdges {
            sketch: path,
            edges: path_edges,
        },
    )
    .expect("a locked profile sweeps");

    assert_eq!(doc.visible_object_ids().len(), 1);
    assert_eq!(doc.sketch(profile).unwrap(), &drawn);

    doc.undo().expect("undo the sweep");
    assert_eq!(doc.visible_object_ids().len(), 0);
    assert_eq!(doc.sketch(profile).unwrap(), &drawn);
}

/// `SketchLocked`, never `UnknownSketch`: a locked sketch is present,
/// findable, and snappable. Calling it unknown would be the silent lie
/// DEVELOPMENT.md rule 4 exists to prevent.
#[test]
fn the_refusal_names_the_lock_rather_than_pretending_the_sketch_is_gone() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    doc.set_sketch_locked(s, true).unwrap();

    let err = doc.begin_sketch_gesture(s).unwrap_err();
    assert_eq!(err, DocumentError::SketchLocked);
    assert_ne!(err, DocumentError::UnknownSketch);
    assert!(
        err.to_string().contains("locked"),
        "the message says so too: {err}"
    );
}

/// Locking freezes SHAPE, not POSE. Sliding the whole chalk line over to line
/// up with a foundation corner is exactly what you want to be able to do.
#[test]
fn a_locked_sketch_moves_as_a_rigid_whole_but_its_vertices_are_frozen() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    doc.set_sketch_locked(s, true).unwrap();

    let vertex = doc
        .sketch(s)
        .unwrap()
        .vertices()
        .keys()
        .next()
        .expect("the rectangle has vertices");
    assert_eq!(
        doc.move_sketch_vertex(s, vertex, Point3::new(1.0, 1.0, 0.0)),
        Err(DocumentError::SketchLocked),
        "dragging one corner is a shape edit"
    );

    doc.transform_sketch(s, &Transform::translation(Vec3::new(3.0, 0.0, 0.0)))
        .expect("moving the whole chalk line is a pose change, and allowed");
    assert_eq!(
        only_region_area(&doc, s),
        400.0,
        "a rigid move leaves the dimension alone"
    );
}

/// A locked sketch is a fine Follow Me PATH — a sweep rides along the chalk
/// line without consuming it. A path is never consumed, locked or not.
#[test]
fn a_locked_sketch_serves_as_a_follow_me_path() {
    let mut doc = Document::new();
    let path = doc.add_sketch(ground());
    {
        let sk = doc.sketch_mut(path).unwrap();
        sk.add_segment(Point3::new(0.0, 0.0, 0.0), Point3::new(0.0, 4.0, 0.0))
            .unwrap();
    }
    let path_edges: Vec<_> = doc.sketch(path).unwrap().edges().keys().collect();
    doc.set_sketch_locked(path, true).unwrap();

    // A profile on a plane the path leaves, swept along the locked path.
    let profile_plane = Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 0.0, 1.0),
    ])
    .unwrap();
    let profile = doc.add_sketch(profile_plane);
    {
        let sk = doc.sketch_mut(profile).unwrap();
        for (a, b) in [
            (Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 0.0, 0.0)),
            (Point3::new(1.0, 0.0, 0.0), Point3::new(1.0, 0.0, 1.0)),
            (Point3::new(1.0, 0.0, 1.0), Point3::new(0.0, 0.0, 1.0)),
            (Point3::new(0.0, 0.0, 1.0), Point3::new(0.0, 0.0, 0.0)),
        ] {
            sk.add_segment(a, b).unwrap();
        }
    }
    let region = only_region(&doc, profile);
    doc.follow_me(
        profile,
        region,
        &kernel::FollowMePath::SketchEdges {
            sketch: path,
            edges: path_edges,
        },
    )
    .expect("a sweep rides the locked path");

    assert_eq!(
        edge_count(&doc, path),
        1,
        "the chalk line is untouched by the sweep that rode it"
    );
}

// ================================================ 3. fully live for inference

/// Everything inference is fed from a sketch comes through the READ path, so
/// locking subtracts nothing: the sketch stays listed, its plane, edges,
/// vertices, regions and curve chains all still answer.
#[test]
fn a_locked_sketch_stays_a_full_snap_source() {
    let mut doc = Document::new();
    let s = doc.add_sketch(ground());
    {
        let sk = doc.sketch_mut(s).unwrap();
        sk.begin_curve_with(kernel::CurveGeom {
            center: Point3::new(0.0, 0.0, 0.0),
            radius: 1.0,
        })
        .expect("a fresh curve chain opens");
        let n = 16;
        for i in 0..n {
            let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
            let b = std::f64::consts::TAU * f64::from(i + 1) / f64::from(n);
            sk.add_segment(
                Point3::new(a.cos(), a.sin(), 0.0),
                Point3::new(b.cos(), b.sin(), 0.0),
            )
            .unwrap();
        }
        sk.end_curve();
    }
    let before_rims = doc.sketch(s).unwrap().curve_rims().len();
    let before_edges = edge_count(&doc, s);

    doc.set_sketch_locked(s, true).unwrap();

    assert!(
        doc.sketch_ids().contains(&s),
        "still listed — inference registration walks this list"
    );
    let sk = doc.sketch(s).expect("still readable");
    assert_eq!(sk.edges().len(), before_edges, "edge snaps survive");
    assert!(!sk.vertices().is_empty(), "endpoint snaps survive");
    assert_eq!(
        sk.curve_rims().len(),
        before_rims,
        "centre, quadrant and tangent snaps survive"
    );
    assert_eq!(sk.regions().len(), 1, "the region is still there");
}

// ========================================== 4. unlock, delete, and undo

#[test]
fn unlocking_returns_an_ordinary_sketch() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    doc.set_sketch_locked(s, true).unwrap();
    doc.set_sketch_locked(s, false).unwrap();

    assert!(!doc.is_sketch_locked(s));
    draw_rect(&mut doc, s, 0.0, 0.0, 20.0, 1.0);
    assert_eq!(region_count(&doc, s), 2, "it welds again, with no residue");
    let r = only_region_smallest(&doc, s);
    doc.extrude_region(s, r, 1.0)
        .expect("and its regions extrude again");
}

/// The smallest extrudable region of `s` — the joist, when a sketch holds a
/// footprint split by one.
fn only_region_smallest(doc: &Document, s: kernel::SketchId) -> kernel::SketchRegionId {
    let sk = doc.sketch(s).unwrap();
    doc.extrudable_regions(s)
        .unwrap()
        .into_iter()
        .min_by(|&a, &b| {
            sk.region_area(a)
                .unwrap()
                .partial_cmp(&sk.region_area(b).unwrap())
                .unwrap()
        })
        .unwrap()
}

#[test]
fn a_locked_sketch_deletes_normally() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    doc.set_sketch_locked(s, true).unwrap();

    doc.delete_sketch(s)
        .expect("deletion is a whole-entity act");
    assert!(doc.sketch(s).is_none());
    assert!(!doc.sketch_ids().contains(&s));

    doc.undo().expect("and it undoes");
    assert!(doc.sketch(s).is_some());
    assert!(
        doc.is_sketch_locked(s),
        "coming back still locked — the flag rode the tombstone"
    );
}

#[test]
fn locking_undoes_and_redoes() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);

    doc.set_sketch_locked(s, true).unwrap();
    assert!(doc.is_sketch_locked(s));

    doc.undo().unwrap();
    assert!(!doc.is_sketch_locked(s), "undo unlocks");

    doc.redo().unwrap();
    assert!(doc.is_sketch_locked(s), "redo re-locks");
}

/// Setting the flag to what it already is must not cost an undo step —
/// a UI that re-asserts state on every render would otherwise fill the log.
#[test]
fn a_redundant_set_records_nothing() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    doc.set_sketch_locked(s, true).unwrap();

    let change = doc.set_sketch_locked(s, true).unwrap();
    assert!(change.sketches_touched.is_empty(), "nothing was touched");

    doc.undo().expect("one undo");
    assert!(
        !doc.is_sketch_locked(s),
        "and that one undo reached the real lock, not a no-op on top of it"
    );
}

#[test]
fn locking_refuses_on_a_stale_or_deleted_handle() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    doc.delete_sketch(s).unwrap();
    assert_eq!(
        doc.set_sketch_locked(s, true),
        Err(DocumentError::UnknownSketch),
        "a deleted sketch is genuinely unknown — that one IS the right error"
    );
}

// ================================================= persistence (manifest v17)

#[test]
fn the_locked_flag_round_trips() {
    let mut doc = Document::new();
    let chalk = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    let stock = rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    doc.set_sketch_locked(chalk, true).unwrap();

    let bytes = doc.save();
    let reloaded = Document::load(&bytes).expect("round trip");

    let ids = reloaded.sketch_ids();
    assert_eq!(ids.len(), 2);
    let locked: Vec<_> = ids
        .iter()
        .filter(|&&id| reloaded.is_sketch_locked(id))
        .collect();
    assert_eq!(locked.len(), 1, "exactly one sketch came back locked");

    // And the one that came back locked is the 20x20, not the 1x1.
    let area = only_region_area(&reloaded, *locked[0]);
    assert_eq!(area, 400.0);
    let _ = stock;
}

/// A document with no locked sketch writes no `locked` key anywhere, so the
/// v16→v17 bump changes exactly one number in the file and nothing else.
#[test]
fn a_document_with_no_locked_sketch_writes_no_locked_key() {
    let mut doc = Document::new();
    rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    rect_sketch(&mut doc, 2.0, 2.0, 3.0, 3.0);

    let m = manifest_json(&doc.save());
    assert!(
        m["format_version"].as_u64().unwrap() >= 17,
        "the key exists from v17 on"
    );
    for sk in m["sketches"].as_array().unwrap() {
        assert!(
            sk.get("locked").is_none(),
            "an unlocked sketch writes nothing: {sk}"
        );
    }
}

#[test]
fn a_locked_sketch_writes_the_key() {
    let mut doc = Document::new();
    let s = rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);
    doc.set_sketch_locked(s, true).unwrap();

    let m = manifest_json(&doc.save());
    assert_eq!(m["sketches"][0]["locked"], true);
}

/// Reject-not-repair: no pre-v17 writer ever emitted `locked`, so one in an
/// older manifest is hand-edited or broken. Honoring it would hand a sketch a
/// protection its own declared version says cannot exist.
#[test]
fn a_locked_flag_smuggled_into_a_pre_v17_manifest_is_rejected() {
    let mut doc = Document::new();
    rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);

    let smuggled = patch_manifest(&doc.save(), |m| {
        m["format_version"] = serde_json::json!(16);
        m["sketches"][0]["locked"] = serde_json::json!(true);
    });

    match Document::load(&smuggled) {
        Err(LoadError::MalformedManifest { what }) => {
            assert!(what.contains("locked"), "the error says what: {what}");
        }
        other => panic!("expected a malformed-manifest refusal, got {other:?}"),
    }
}

/// A pre-v17 file simply has no such flag: every sketch loads unlocked, and
/// an old file never fails to load over this.
#[test]
fn a_pre_v17_file_loads_with_every_sketch_unlocked() {
    let mut doc = Document::new();
    rect_sketch(&mut doc, 0.0, 0.0, 1.0, 1.0);

    let old = patch_manifest(&doc.save(), |m| {
        m["format_version"] = serde_json::json!(16);
    });
    let loaded = Document::load(&old).expect("an old file still loads");
    for id in loaded.sketch_ids() {
        assert!(!loaded.is_sketch_locked(id));
    }
}

// ====================================== the flag rides every sketch COPY

/// A box-shaped placeholder so `make_component` has something to fold in.
fn placeholder_box(doc: &mut Document) -> kernel::ObjectId {
    let s = rect_sketch(doc, 0.0, 0.0, 1.0, 1.0);
    let r = only_region(doc, s);
    let (id, _) = doc.extrude_region(s, r, 1.0).expect("placeholder box");
    id
}

/// A definition holding one box, plus its first instance, with one LOCKED
/// definition-owned sketch drawn into it.
fn definition_with_a_locked_sketch(
    doc: &mut Document,
) -> (kernel::ComponentId, kernel::InstanceId, kernel::SketchId) {
    let o = placeholder_box(doc);
    let (comp, inst, _) = doc
        .make_component(&[kernel::NodeId::Object(o)])
        .expect("make_component");
    let (sid, _) = doc
        .begin_sketch_on_plane_in_instance(inst, ground())
        .expect("a sketch inside the instance");
    {
        let sk = doc.sketch_mut(sid).expect("fresh and unlocked");
        for (a, b) in [
            (Point3::new(0.0, 0.0, 0.0), Point3::new(3.0, 0.0, 0.0)),
            (Point3::new(3.0, 0.0, 0.0), Point3::new(3.0, 3.0, 0.0)),
            (Point3::new(3.0, 3.0, 0.0), Point3::new(0.0, 3.0, 0.0)),
            (Point3::new(0.0, 3.0, 0.0), Point3::new(0.0, 0.0, 0.0)),
        ] {
            sk.add_segment(a, b).expect("definition rectangle");
        }
    }
    doc.set_sketch_locked(sid, true).expect("locks");
    (comp, inst, sid)
}

/// `make_unique` deep-copies a definition's sketches into a private copy. A
/// copy of a chalk line is still a chalk line — losing the flag here would
/// quietly hand one instance's reference geometry back as stock.
#[test]
fn make_unique_carries_the_locked_flag_onto_the_private_copy() {
    let mut doc = Document::new();
    let (_comp, inst, source) = definition_with_a_locked_sketch(&mut doc);

    let (new_def, _) = doc.make_unique(inst).expect("make_unique");
    let copies = doc
        .def_member_sketches(new_def)
        .expect("the private definition has sketches");
    assert_eq!(copies.len(), 1, "one sketch came across");
    assert_ne!(copies[0], source, "and it is a fresh handle");
    assert!(
        doc.is_sketch_locked(copies[0]),
        "the copy is still a locked sketch"
    );
    assert!(doc.is_sketch_locked(source), "and so is the original");
}

/// `explode_instance` bakes a definition's sketches into independent WORLD
/// sketches. Same rule: the baked copy stays locked.
#[test]
fn explode_instance_carries_the_locked_flag_onto_the_baked_world_sketch() {
    let mut doc = Document::new();
    let (_comp, inst, source) = definition_with_a_locked_sketch(&mut doc);

    let before: std::collections::BTreeSet<_> = doc.sketch_ids().into_iter().collect();
    doc.explode_instance(inst).expect("explode");
    let after: std::collections::BTreeSet<_> = doc.sketch_ids().into_iter().collect();

    let baked: Vec<_> = after.difference(&before).copied().collect();
    assert_eq!(baked.len(), 1, "one world sketch was baked out");
    assert!(
        doc.is_sketch_locked(baked[0]),
        "the baked copy is still a locked sketch"
    );
    assert!(
        doc.is_sketch_locked(source),
        "and the definition's own is untouched"
    );
}

/// The in-instance door builds by copy too: a locked definition-owned sketch
/// births a new member of the definition and stays exactly as drawn.
#[test]
fn a_locked_definition_sketch_extrudes_by_copy() {
    let mut doc = Document::new();
    let (comp, inst, sid) = definition_with_a_locked_sketch(&mut doc);
    let r = only_region(&doc, sid);
    let drawn = doc.sketch(sid).unwrap().clone();
    let members_before = doc.def_members(comp).unwrap().len();

    doc.extrude_region_in_instance(inst, sid, r, 1.0)
        .expect("a locked definition sketch builds a member");

    assert_eq!(doc.def_members(comp).unwrap().len(), members_before + 1);
    assert_eq!(doc.sketch(sid).unwrap(), &drawn);
    assert!(doc.is_sketch_locked(sid));
}

/// `copy_sketch_islands` deliberately does NOT carry the flag: copying
/// geometry OFF a chalk line is how you get ordinary stock to build from,
/// and a locked copy would defeat the point.
#[test]
fn copying_islands_off_a_locked_sketch_yields_ordinary_stock() {
    let mut doc = Document::new();
    let chalk = rect_sketch(&mut doc, 0.0, 0.0, 20.0, 20.0);
    doc.set_sketch_locked(chalk, true).unwrap();

    let islands: Vec<_> = doc.sketch(chalk).unwrap().islands().keys().collect();
    let (copy, _) = doc
        .copy_sketch_islands(
            chalk,
            &islands,
            &Transform::translation(Vec3::new(0.0, 25.0, 0.0)),
        )
        .expect("copying off a locked sketch is allowed — it is a READ");

    assert!(!doc.is_sketch_locked(copy), "the copy is ordinary stock");
    let r = only_region(&doc, copy);
    doc.extrude_region(copy, r, 1.0)
        .expect("and it extrudes like anything else");
    assert!(doc.is_sketch_locked(chalk), "the chalk line is untouched");
    assert_eq!(only_region_area(&doc, chalk), 400.0);
}

// =================================================== property: by copy

proptest::proptest! {
    /// Property: whatever two rectangles are drawn into a locked sketch —
    /// apart, touching, or overlapping into several regions — building from
    /// any one region leaves the sketch identical, in memory and in the
    /// saved manifest.
    #[test]
    fn building_from_any_region_of_a_locked_sketch_leaves_it_identical(
        w in 1.0..20.0f64,
        h in 1.0..20.0f64,
        dx in -15.0..25.0f64,
        dy in -15.0..25.0f64,
        pick in 0usize..8,
        distance in 0.1..10.0f64,
    ) {
        let mut doc = Document::new();
        let s = rect_sketch(&mut doc, 0.0, 0.0, 10.0, 10.0);
        draw_rect(&mut doc, s, dx, dy, dx + w, dy + h);
        doc.set_sketch_locked(s, true).unwrap();

        let drawn = doc.sketch(s).unwrap().clone();
        let saved = manifest_json(&doc.save())["sketches"].clone();
        let regions = doc.extrudable_regions(s).unwrap();
        let region = regions[pick % regions.len()];

        doc.extrude_region(s, region, distance).expect("any region builds");

        proptest::prop_assert_eq!(doc.sketch(s).unwrap(), &drawn);
        proptest::prop_assert_eq!(&manifest_json(&doc.save())["sketches"], &saved);
    }
}
