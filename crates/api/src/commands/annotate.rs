//! Dimensions and leader text: hew.annotate.* (docs/agents/HEW_API.md §7).
//!
//! The kernel already owns every annotation entity — `Annotation`'s three
//! variants, geometric re-anchoring, the `detached` flag, exact undo/redo,
//! and the `.hew` round-trip. This namespace is the addressing and
//! parameter layer over `Document::add_linear_dimension` /
//! `add_leader_text` / `update_annotation` / `delete_annotation`; it
//! constructs kernel values and gets out of the way.
//!
//! `hew.annotate.radial` is declared but not implemented (§14's burn-down
//! list): the kernel takes a `CapturedCurve` — the exact analytic circle
//! the app captures from the curve the user picked — and the API has no
//! pick to capture one from. It answers the `unimplemented` refusal until
//! a curve locator exists to derive it.
//!
//! An annotation's public id is minted from its slotmap key rather than a
//! stable id (`ids::annotation_id`, §5.1): annotations are not entities
//! and the file format declines them a `sid` on purpose, so the id is
//! session-scoped exactly like a sketch region's or edge's.

use super::entity::resolve_node;
use super::{CmdError, Ctx, Handler};
use crate::ids;
use crate::locate;
use crate::refusal::Refusal;
use kernel::{Anchor, Annotation, DocumentError, Plane, Point3, Vec3};
use serde_json::{Value, json};

/// This namespace's slice of the handler table.
pub fn handler(name: &str) -> Option<Handler> {
    Some(match name {
        "hew.annotate.linear" => linear,
        "hew.annotate.leader" => leader,
        "hew.annotate.update" => update,
        "hew.annotate.delete" => delete,
        _ => return None,
    })
}

// ------------------------------------------------------------- addressing

/// The kernel's own `UnknownAnnotation` refusal, carrying the id that
/// missed. Minted from the `DocumentError` rather than by hand so the
/// machine name and the UI copy stay the ones every other surface uses.
fn unknown_annotation(id: &str) -> CmdError {
    CmdError::Refusal(
        Refusal::from_document_error(&DocumentError::UnknownAnnotation)
            .with_detail(json!({ "annotation": id })),
    )
}

/// Resolves an annotation's public id against the live (visible) set.
/// A stale, deleted, or malformed id gets the same typed refusal.
fn resolve_annotation(ctx: &Ctx, id: &str) -> Result<kernel::AnnotationId, CmdError> {
    let key = ids::resolve_annotation_id(id).ok_or_else(|| unknown_annotation(id))?;
    if ctx.doc.annotation(key).is_none() {
        return Err(unknown_annotation(id));
    }
    Ok(key)
}

// ------------------------------------------------------------ parameters

/// Parses an anchor: `{"at": <point locator>, "on": <entity id>}`, or a
/// bare point locator as shorthand for the same thing without `on`.
///
/// `on` is what makes the annotation follow the geometry — the kernel
/// re-anchors through the exact world-space map of any transform on that
/// node, and detaches the annotation when the node is deleted or consumed.
/// An anchor without it is free-floating: never re-anchored, never
/// detached. The key is `at` rather than `point` because a derived-point
/// locator (§5.3) is itself an object keyed `point`/`of`, which the
/// shorthand form has to stay able to carry.
fn parse_anchor(ctx: &Ctx, v: &Value) -> Result<Anchor, CmdError> {
    let Some(obj) = v.as_object().filter(|o| o.contains_key("at")) else {
        // Shorthand: the whole value is the point locator.
        return Ok(Anchor {
            node: None,
            point: locate::resolve_point(ctx, v)?,
        });
    };
    for key in obj.keys() {
        if key != "at" && key != "on" {
            return Err(CmdError::Params(format!(
                "unknown anchor field '{key}' — an anchor is {{\"at\": <point>, \"on\": <id>}}"
            )));
        }
    }
    let point = locate::resolve_point(ctx, &obj["at"])?;
    let node = match obj.get("on") {
        None | Some(Value::Null) => None,
        Some(on) => {
            let id = on.as_str().ok_or_else(|| {
                CmdError::Params("anchor \"on\" must be an entity id string".into())
            })?;
            Some(resolve_node(ctx, id)?)
        }
    };
    Ok(Anchor { node, point })
}

/// Parses an explicit `{origin, normal}` plane. Annotations draw in a
/// plane rather than on a sketch or a face, so this is deliberately not
/// `locate::resolve_plane`'s wider target vocabulary.
fn parse_plane(v: &Value) -> Result<Plane, CmdError> {
    let obj = v
        .as_object()
        .ok_or_else(|| CmdError::Params("plane must be {origin, normal}".into()))?;
    let (Some(origin), Some(normal)) = (obj.get("origin"), obj.get("normal")) else {
        return Err(CmdError::Params("plane must be {origin, normal}".into()));
    };
    let origin = locate::parse_xyz(origin)?;
    let normal = locate::parse_dir(normal)?;
    Plane::from_point_normal(origin, normal)
        .map_err(|_| CmdError::Params("degenerate plane normal".into()))
}

/// The plane a linear dimension is drawn in when the caller names none:
/// the one containing the `a`-`b` baseline and the drag-out `offset`.
///
/// Refused `degenerate_annotation` when `offset` is collinear with the
/// baseline — the same condition the kernel treats as an unrecoverable
/// placement in `Annotation::reanchor`, and the case where there is no
/// such plane to find.
fn derive_plane(a: Point3, b: Point3, offset: Vec3) -> Result<Plane, CmdError> {
    let baseline = b - a;
    let normal = baseline.cross(offset);
    Plane::from_point_normal(a, normal).map_err(|_| {
        CmdError::Refusal(
            Refusal::from_document_error(&DocumentError::DegenerateAnnotation).with_detail(json!({
                "reason": "offset is collinear with the a-b line, so it names no dimension plane"
            })),
        )
    })
}

// ---------------------------------------------------------------- create

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LinearParams {
    a: Value,
    b: Value,
    offset: Value,
    #[serde(default)]
    plane: Option<Value>,
    #[serde(default)]
    text: Option<String>,
}

fn linear(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    let p: LinearParams =
        serde_json::from_value(params.clone()).map_err(|e| CmdError::Params(e.to_string()))?;
    let a = parse_anchor(ctx, &p.a)?;
    let b = parse_anchor(ctx, &p.b)?;
    let offset = locate::parse_dir(&p.offset)?;
    let plane = match &p.plane {
        Some(v) => parse_plane(v)?,
        None => derive_plane(a.point, b.point, offset)?,
    };
    let id = ctx
        .doc
        .add_linear_dimension(a, b, offset, plane, p.text.clone())?;
    Ok(json!({ "annotation": ids::annotation_id(id) }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaderParams {
    anchor: Value,
    offset: Value,
    text: String,
}

fn leader(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    let p: LeaderParams =
        serde_json::from_value(params.clone()).map_err(|e| CmdError::Params(e.to_string()))?;
    let anchor = parse_anchor(ctx, &p.anchor)?;
    let offset = locate::parse_dir(&p.offset)?;
    let id = ctx.doc.add_leader_text(anchor, offset, p.text.clone())?;
    Ok(json!({ "annotation": ids::annotation_id(id) }))
}

// ---------------------------------------------------------------- update

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateParams {
    annotation: String,
    #[serde(default)]
    a: Option<Value>,
    #[serde(default)]
    b: Option<Value>,
    #[serde(default)]
    anchor: Option<Value>,
    #[serde(default)]
    offset: Option<Value>,
    #[serde(default)]
    plane: Option<Value>,
    #[serde(default)]
    leader_dir: Option<Value>,
    /// A string to set, or an explicit `null` to clear an override back to
    /// the computed measurement. Omitted leaves it alone.
    #[serde(default)]
    text: Option<Value>,
}

/// Refuses a field that belongs to a different annotation kind, naming
/// both — an `offset` on a radial dimension is a caller mistake worth
/// saying out loud rather than ignoring.
fn not_on_kind(field: &str, kind: &str) -> CmdError {
    CmdError::Params(format!("'{field}' does not apply to a {kind} annotation"))
}

/// A `text` update for a dimension's `text_override`: `null` clears it.
fn text_override_from(v: &Value) -> Result<Option<String>, CmdError> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(CmdError::Params(
            "text must be a string, or null to clear the override".into(),
        )),
    }
}

fn update(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    let p: UpdateParams =
        serde_json::from_value(params.clone()).map_err(|e| CmdError::Params(e.to_string()))?;
    let id = resolve_annotation(ctx, &p.annotation)?;
    let current = ctx
        .doc
        .annotation(id)
        .expect("resolve_annotation checked liveness")
        .clone();

    // Build the whole new value and hand it over: `Document::update_annotation`
    // decides text-only vs. geometry re-pick by comparing it against the
    // stored one (`Annotation::geometry_eq`), which is what keeps a stale
    // `detached` warning standing through a text edit and clears it on a
    // real re-anchor.
    let next = match current {
        Annotation::LinearDimension {
            a,
            b,
            offset,
            plane,
            text_override,
        } => {
            if p.anchor.is_some() {
                return Err(not_on_kind("anchor", "linear"));
            }
            if p.leader_dir.is_some() {
                return Err(not_on_kind("leader_dir", "linear"));
            }
            let a = match &p.a {
                Some(v) => parse_anchor(ctx, v)?,
                None => a,
            };
            let b = match &p.b {
                Some(v) => parse_anchor(ctx, v)?,
                None => b,
            };
            let offset = match &p.offset {
                Some(v) => locate::parse_dir(v)?,
                None => offset,
            };
            let plane = match (&p.plane, &p.a, &p.b, &p.offset) {
                (Some(v), _, _, _) => parse_plane(v)?,
                // A re-pick with no plane named re-derives it, the same way
                // creation does; an untouched placement keeps its plane.
                (None, None, None, None) => plane,
                _ => derive_plane(a.point, b.point, offset)?,
            };
            let text_override = match &p.text {
                Some(v) => text_override_from(v)?,
                None => text_override,
            };
            Annotation::LinearDimension {
                a,
                b,
                offset,
                plane,
                text_override,
            }
        }
        Annotation::RadialDimension {
            anchor,
            kind,
            curve,
            leader_dir,
            text_override,
        } => {
            for (field, given) in [("a", &p.a), ("b", &p.b), ("offset", &p.offset)] {
                if given.is_some() {
                    return Err(not_on_kind(field, "radial"));
                }
            }
            if p.plane.is_some() {
                return Err(not_on_kind("plane", "radial"));
            }
            let anchor = match &p.anchor {
                Some(v) => parse_anchor(ctx, v)?,
                None => anchor,
            };
            let leader_dir = match &p.leader_dir {
                Some(v) => locate::parse_dir(v)?,
                None => leader_dir,
            };
            let text_override = match &p.text {
                Some(v) => text_override_from(v)?,
                None => text_override,
            };
            Annotation::RadialDimension {
                anchor,
                kind,
                curve,
                leader_dir,
                text_override,
            }
        }
        Annotation::LeaderText {
            anchor,
            offset,
            text,
        } => {
            for (field, given) in [("a", &p.a), ("b", &p.b), ("plane", &p.plane)] {
                if given.is_some() {
                    return Err(not_on_kind(field, "leader"));
                }
            }
            if p.leader_dir.is_some() {
                return Err(not_on_kind("leader_dir", "leader"));
            }
            let anchor = match &p.anchor {
                Some(v) => parse_anchor(ctx, v)?,
                None => anchor,
            };
            let offset = match &p.offset {
                Some(v) => locate::parse_dir(v)?,
                None => offset,
            };
            // Leader text IS the content, not an override of a computed
            // measurement, so there is nothing for `null` to clear.
            let text = match &p.text {
                Some(Value::String(s)) => s.clone(),
                Some(_) => {
                    return Err(CmdError::Params(
                        "a leader's text must be a string — it has no computed value to fall back to"
                            .into(),
                    ));
                }
                None => text,
            };
            Annotation::LeaderText {
                anchor,
                offset,
                text,
            }
        }
    };

    ctx.doc.update_annotation(id, next)?;
    let detached = ctx.doc.annotation_detached(id).unwrap_or(false);
    Ok(json!({ "detached": detached }))
}

// ---------------------------------------------------------------- delete

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteParams {
    annotation: String,
}

fn delete(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    let p: DeleteParams =
        serde_json::from_value(params.clone()).map_err(|e| CmdError::Params(e.to_string()))?;
    let id = resolve_annotation(ctx, &p.annotation)?;
    ctx.doc.delete_annotation(id)?;
    Ok(json!({}))
}
