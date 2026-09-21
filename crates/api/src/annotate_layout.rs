//! The world-space line work and labels a document's annotations draw —
//! the Rust side of `SceneRenderer._buildAnnotationBase` and
//! `collectAnnotationDrawing` (`app/src/viewport/SceneRenderer.ts`).
//!
//! The kernel stores an annotation's anchors, offset and captured curve;
//! what a dimension actually DRAWS — extension lines with their overshoot,
//! the arrowheads, a radial's measured run and centre tick, and where the
//! label sits — is derived. In the app that derivation lives in the
//! renderer, which is why headless output has never had dimensions in it.
//!
//! This is the camera-independent half, and deliberately only that half.
//! The live viewport also runs a screen-space gap layout that breaks the
//! dimension line around the label; a vector page draws the label with a
//! paper halo over the line instead and skips it entirely, which is what
//! makes a port possible at all. `collectAnnotationDrawing` is the app's
//! own entry point for exactly this and takes the same shortcut.
//!
//! All three kinds are covered, including radial — `hew.annotate.radial`
//! is still a declared gap, but a document authored in the app can carry
//! radial dimensions and a drawing of it has to show them.

use crate::units::{LengthFormat, format_length};
use kernel::{Annotation, Document, Plane, Point3, RadialKind, Vec3};

// The constants below are the app's, from
// `app/src/viewport/annotationStyle.ts`, and are `pub` so
// `tests/annotation_style_golden.rs` can hold them against the fixture
// that module publishes. Tuning an arrowhead on one side only would make
// a printed sheet disagree with the screen; this makes that a build
// failure instead.

/// How far an extension line runs past the dimension line, as a fraction
/// of the offset — the small CAD-drafting overshoot.
pub const EXTENSION_OVERSHOOT_FRAC: f64 = 0.12;
/// Arrowhead length as a fraction of the dimension line, clamped.
pub const ARROW_LEN_FRAC: f64 = 0.06;
pub const ARROW_LEN_MIN: f64 = 0.02;
pub const ARROW_LEN_MAX: f64 = 0.12;
/// Half-width of an arrowhead's wings, as a fraction of its length.
pub const ARROW_WIDTH_FRAC: f64 = 0.35;
/// Half-extent of a radial dimension's centre tick.
pub const CENTER_TICK_HALF: f64 = 0.03;

/// One label, at the world point it is centred on.
#[derive(Debug, Clone, PartialEq)]
pub struct Label {
    pub position: Point3,
    /// Already formatted: the override where the user set one, otherwise
    /// the measurement in the requested unit format.
    pub text: String,
    /// The annotation has lost the geometry it measured. The app draws
    /// these in its warning colour; a page can do the same.
    pub detached: bool,
}

/// Every annotation's drawing, in world space.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Drawing {
    /// Line work as `[from, to]` pairs.
    pub segments: Vec<[Point3; 2]>,
    pub labels: Vec<Label>,
}

impl Drawing {
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty() && self.labels.is_empty()
    }
}

fn add(p: Point3, v: Vec3) -> Point3 {
    Point3::new(p.x + v.x, p.y + v.y, p.z + v.z)
}

fn scale(v: Vec3, k: f64) -> Vec3 {
    Vec3::new(v.x * k, v.y * k, v.z * k)
}

/// `geoHelpers.ts`'s `normalizeV3`: `None` below its own 1e-9 floor,
/// which is the threshold the drawing decisions are written against.
fn unit(v: Vec3) -> Option<Vec3> {
    let len = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
    if len < 1e-9 {
        return None;
    }
    Some(scale(v, 1.0 / len))
}

fn between(a: Point3, b: Point3) -> Vec3 {
    Vec3::new(b.x - a.x, b.y - a.y, b.z - a.z)
}

fn length(v: Vec3) -> f64 {
    (v.x * v.x + v.y * v.y + v.z * v.z).sqrt()
}

fn arrow_size(run: f64) -> (f64, f64) {
    let len = (run * ARROW_LEN_FRAC).clamp(ARROW_LEN_MIN, ARROW_LEN_MAX);
    (len, len * ARROW_WIDTH_FRAC)
}

/// A two-segment chevron with its tip at `tip`, wings opening along
/// `dir` and spread along `perp` — `geoHelpers.ts`'s `pushArrowChevron`.
fn push_arrow(
    out: &mut Vec<[Point3; 2]>,
    tip: Point3,
    dir: Vec3,
    perp: Vec3,
    len: f64,
    width: f64,
) {
    let along = scale(dir, len);
    let spread = scale(perp, width);
    let wing1 = add(add(tip, along), spread);
    let wing2 = add(add(tip, along), scale(spread, -1.0));
    out.push([tip, wing1]);
    out.push([tip, wing2]);
}

/// A small cross at a radius dimension's centre, in the curve's own plane
/// — `annotationLayout.ts`'s `pushCenterTick`.
fn push_center_tick(out: &mut Vec<[Point3; 2]>, center: Point3, plane_normal: Vec3, half: f64) {
    let arbitrary = if plane_normal.x.abs() < 0.9 {
        Vec3::new(1.0, 0.0, 0.0)
    } else {
        Vec3::new(0.0, 1.0, 0.0)
    };
    let k = arbitrary.dot(plane_normal);
    let perp_component = Vec3::new(
        arbitrary.x - plane_normal.x * k,
        arbitrary.y - plane_normal.y * k,
        arbitrary.z - plane_normal.z * k,
    );
    let Some(u) = unit(perp_component) else {
        return;
    };
    let v = plane_normal.cross(u);
    out.push([add(center, scale(u, -half)), add(center, scale(u, half))]);
    out.push([add(center, scale(v, -half)), add(center, scale(v, half))]);
}

/// The whole document's annotation drawing, in the unit `format` the
/// caller asked for. Hidden and deleted annotations are already excluded
/// — `Document::annotations` returns only the live ones.
pub fn drawing(doc: &Document, format: LengthFormat) -> Drawing {
    let mut out = Drawing::default();
    for (_, annotation, detached) in doc.annotations() {
        one(&mut out, &annotation, detached, format);
    }
    out
}

fn one(out: &mut Drawing, annotation: &Annotation, detached: bool, format: LengthFormat) {
    let (label_text, position) = match annotation {
        Annotation::LinearDimension {
            a,
            b,
            offset,
            plane,
            text_override,
        } => linear(out, a.point, b.point, *offset, plane, text_override, format),
        Annotation::RadialDimension {
            anchor,
            kind,
            curve,
            leader_dir,
            text_override,
        } => radial(
            out,
            anchor.point,
            *kind,
            curve.center,
            curve.radius,
            &curve.plane,
            *leader_dir,
            text_override,
            format,
        ),
        Annotation::LeaderText {
            anchor,
            offset,
            text,
        } => {
            let end = add(anchor.point, *offset);
            out.segments.push([anchor.point, end]);
            (text.clone(), end)
        }
    };
    if !label_text.trim().is_empty() {
        out.labels.push(Label {
            position,
            text: label_text,
            detached,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn linear(
    out: &mut Drawing,
    a: Point3,
    b: Point3,
    offset: Vec3,
    plane: &Plane,
    text_override: &Option<String>,
    format: LengthFormat,
) -> (String, Point3) {
    let a1 = add(a, offset);
    let b1 = add(b, offset);

    // Extension lines: anchor out to just past the dimension line.
    let over = scale(offset, 1.0 + EXTENSION_OVERSHOOT_FRAC);
    out.segments.push([a, add(a, over)]);
    out.segments.push([b, add(b, over)]);

    // The dimension line itself, then an arrowhead into each end.
    out.segments.push([a1, b1]);
    let span = between(a1, b1);
    let run = length(span);
    if run > 1e-9 {
        let dir = scale(span, 1.0 / run);
        if let Some(perp) = unit(plane.normal().cross(dir)) {
            let (len, width) = arrow_size(run);
            push_arrow(&mut out.segments, a1, dir, perp, len, width);
            push_arrow(&mut out.segments, b1, scale(dir, -1.0), perp, len, width);
        }
    }

    let text = text_override
        .clone()
        .unwrap_or_else(|| format_length(length(between(a, b)), format));
    let mid = Point3::new(
        (a1.x + b1.x) * 0.5,
        (a1.y + b1.y) * 0.5,
        (a1.z + b1.z) * 0.5,
    );
    (text, mid)
}

#[allow(clippy::too_many_arguments)]
fn radial(
    out: &mut Drawing,
    anchor: Point3,
    kind: RadialKind,
    center: Point3,
    radius: f64,
    plane: &Plane,
    leader_dir: Vec3,
    text_override: &Option<String>,
    format: LengthFormat,
) -> (String, Point3) {
    let plane_normal = plane.normal();
    let end = add(anchor, leader_dir);

    // The measured run has to SHOW the measurement: centre-to-rim for a
    // radius, rim-to-rim through the centre for a diameter.
    let far_end = match kind {
        RadialKind::Diameter => Point3::new(
            2.0 * center.x - anchor.x,
            2.0 * center.y - anchor.y,
            2.0 * center.z - anchor.z,
        ),
        RadialKind::Radius => center,
    };
    out.segments.push([far_end, anchor]);
    // The leader, continuing outward from the rim to the label.
    out.segments.push([anchor, end]);

    let measured = between(anchor, far_end);
    let measured_len = length(measured);
    if measured_len > 1e-9 {
        let toward_far = scale(measured, 1.0 / measured_len);
        if let Some(perp) = unit(plane_normal.cross(toward_far)) {
            let (len, width) = arrow_size(measured_len);
            push_arrow(&mut out.segments, anchor, toward_far, perp, len, width);
            if kind == RadialKind::Diameter {
                // A diameter's far end is a rim point too.
                push_arrow(
                    &mut out.segments,
                    far_end,
                    scale(toward_far, -1.0),
                    perp,
                    len,
                    width,
                );
            }
        }
    }
    if kind == RadialKind::Radius {
        // A diameter has no single centre endpoint to mark — its run
        // passes through the centre rather than terminating there.
        push_center_tick(&mut out.segments, center, plane_normal, CENTER_TICK_HALF);
    }

    let (prefix, value) = match kind {
        RadialKind::Diameter => ("\u{d8} ", radius * 2.0),
        RadialKind::Radius => ("R ", radius),
    };
    let text = text_override
        .clone()
        .unwrap_or_else(|| format!("{prefix}{}", format_length(value, format)));
    (text, end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kernel::{Anchor, CapturedCurve};

    fn plane_xy() -> Plane {
        Plane::from_point_normal(Point3::new(0.0, 0.0, 0.0), Vec3::new(0.0, 0.0, 1.0))
            .expect("well-formed")
    }

    fn free(x: f64, y: f64, z: f64) -> Anchor {
        Anchor {
            node: None,
            point: Point3::new(x, y, z),
        }
    }

    #[test]
    fn a_linear_dimension_draws_extensions_a_line_and_two_arrowheads() {
        let mut out = Drawing::default();
        let a = Annotation::LinearDimension {
            a: free(0.0, 0.0, 0.0),
            b: free(1.0, 0.0, 0.0),
            offset: Vec3::new(0.0, -0.2, 0.0),
            plane: plane_xy(),
            text_override: None,
        };
        one(&mut out, &a, false, LengthFormat::Meters);

        // 2 extension lines + 1 dimension line + 2 chevrons of 2 each.
        assert_eq!(out.segments.len(), 7);
        assert_eq!(out.labels.len(), 1);
        assert_eq!(out.labels[0].text, "1 m");
        assert_eq!(out.labels[0].position, Point3::new(0.5, -0.2, 0.0));

        // The extension line overshoots the dimension line by 12%.
        let tip = out.segments[0][1];
        assert!(
            (tip.y - -0.224).abs() < 1e-12,
            "extension overshoots to -0.224, got {}",
            tip.y
        );
    }

    #[test]
    fn an_override_replaces_the_measurement_verbatim() {
        let mut out = Drawing::default();
        let a = Annotation::LinearDimension {
            a: free(0.0, 0.0, 0.0),
            b: free(1.0, 0.0, 0.0),
            offset: Vec3::new(0.0, -0.2, 0.0),
            plane: plane_xy(),
            text_override: Some("TYP".into()),
        };
        one(&mut out, &a, true, LengthFormat::Meters);
        assert_eq!(out.labels[0].text, "TYP");
        assert!(out.labels[0].detached, "a detached annotation says so");
    }

    #[test]
    fn a_degenerate_dimension_still_draws_its_line_without_arrowheads() {
        let mut out = Drawing::default();
        let a = Annotation::LinearDimension {
            a: free(0.0, 0.0, 0.0),
            b: free(0.0, 0.0, 0.0),
            offset: Vec3::new(0.0, -0.2, 0.0),
            plane: plane_xy(),
            text_override: None,
        };
        one(&mut out, &a, false, LengthFormat::Meters);
        assert_eq!(out.segments.len(), 3, "no chevrons off a zero-length run");
    }

    #[test]
    fn a_radius_marks_its_centre_and_a_diameter_does_not() {
        let curve = CapturedCurve {
            center: Point3::new(0.0, 0.0, 0.0),
            radius: 0.5,
            plane: plane_xy(),
        };
        let leader = Vec3::new(0.3, 0.0, 0.0);

        let mut radius = Drawing::default();
        one(
            &mut radius,
            &Annotation::RadialDimension {
                anchor: free(0.5, 0.0, 0.0),
                kind: RadialKind::Radius,
                curve,
                leader_dir: leader,
                text_override: None,
            },
            false,
            LengthFormat::Meters,
        );
        assert_eq!(radius.labels[0].text, "R 0.5 m");
        // measured + leader + 1 chevron (2) + centre tick (2).
        assert_eq!(radius.segments.len(), 6);

        let mut diameter = Drawing::default();
        one(
            &mut diameter,
            &Annotation::RadialDimension {
                anchor: free(0.5, 0.0, 0.0),
                kind: RadialKind::Diameter,
                curve,
                leader_dir: leader,
                text_override: None,
            },
            false,
            LengthFormat::Meters,
        );
        assert_eq!(diameter.labels[0].text, "\u{d8} 1 m");
        // measured + leader + 2 chevrons (4), no centre tick.
        assert_eq!(diameter.segments.len(), 6);
        assert_eq!(
            diameter.segments[0][0],
            Point3::new(-0.5, 0.0, 0.0),
            "a diameter measures rim to rim through the centre"
        );
    }

    #[test]
    fn leader_text_is_one_segment_and_its_own_words() {
        let mut out = Drawing::default();
        one(
            &mut out,
            &Annotation::LeaderText {
                anchor: free(1.0, 1.0, 1.0),
                offset: Vec3::new(0.2, 0.2, 0.0),
                text: "cut to fit".into(),
            },
            false,
            LengthFormat::Meters,
        );
        assert_eq!(out.segments.len(), 1);
        assert_eq!(out.labels[0].text, "cut to fit");
        assert_eq!(out.labels[0].position, Point3::new(1.2, 1.2, 1.0));
    }

    #[test]
    fn empty_leader_text_draws_its_leader_but_no_label() {
        let mut out = Drawing::default();
        one(
            &mut out,
            &Annotation::LeaderText {
                anchor: free(0.0, 0.0, 0.0),
                offset: Vec3::new(0.1, 0.0, 0.0),
                text: "   ".into(),
            },
            false,
            LengthFormat::Meters,
        );
        assert_eq!(out.segments.len(), 1);
        assert!(out.labels.is_empty());
    }
}
