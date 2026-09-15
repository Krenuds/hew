//! Solid operations: hew.solid.* (docs/agents/HEW_API.md §7, §7 semantics
//! notes; the kernel-surface recipes are api-kernel-map.md §1.3/§1.4).
//!
//! `push_pull` reproduces the wasm boundary's three-way branch exactly
//! (api-kernel-map.md §1.3, `Scene::push_pull`): a through push or pull
//! (past an opposing or co-facing wall) routes to
//! [`kernel::Document::push_pull_through`], a flat imprinted sub-face
//! routes to `KernelOp::ExtrudeSubFace`, everything else to
//! `KernelOp::PushPull` — both of the latter through
//! [`kernel::Document::apply_object_op`]. When the resolved face's
//! object is a component-DEFINITION member, each of these three routes
//! through its def-scoped sibling instead
//! ([`kernel::Document::push_pull_through_in_component`] /
//! [`kernel::Document::apply_def_op`]) — the shared-geometry edit is
//! then seen by every instance of the component at once, mirroring
//! `commands/sketch.rs`'s face-imprint routing (see that module's doc
//! comment for the coordinate-frame decision: always the definition's
//! own frame, never remapped through an instance's pose).
//!
//! **Editable imprints** (`imprints`, `move_imprint`, `rotate_imprint`,
//! `scale_imprint`, `delete_imprint`): a drawn-but-not-yet-pushed shape
//! ([`kernel::FaceFeature`], recovered structurally, never stored) can be
//! listed, moved, turned, scaled, or deleted before it is ever pushed —
//! the API surface over [`kernel::Document::face_features`],
//! `transform_imprint`, `transform_chord`, and `dissolve_imprint`.
//! `imprints` is `ReadOnly` (a pure query, like `hew.query.faces`); the
//! other four are `ModelMutating`, one undo entry each. All four transform
//! commands share one **imprint locator**: a face locator (§5.2 —
//! `{object, at}` / `{object, ray}` / `{"$face": …}`) for a sub-face
//! imprint, OR a point on one of a chord's lines for a chord — see
//! [`resolve_imprint`], which tries the face reading first (as a
//! sub-face) and falls back to an edge reading (as a chord) exactly the
//! way a person's click is ambiguous between "the face I landed on" and
//! "the line I landed on" until the kernel says which imprint is there.
//! No face tokens are minted by `imprints`: unlike `extrude`/`push_pull`,
//! it neither creates nor reshapes a face (§5.4's contract for minting),
//! and every one of its listed features is already reachable by a plain
//! point locator — a token would be redundant ergonomics, not a new
//! capability.

use super::{CmdError, Ctx, Handler};
use crate::geom;
use crate::locate;
use crate::refusal::Refusal;
use kernel::{
    DocumentError, EdgeId, EntityRef, FaceFeature, FaceId, FollowMePath, KernelOp, NodeId,
    ObjectId, Point3, Transform, Vec3,
};
use serde_json::{Value, json};

/// This namespace's slice of the handler table.
pub fn handler(name: &str) -> Option<Handler> {
    Some(match name {
        "hew.solid.extrude" => extrude,
        "hew.solid.push_pull" => push_pull,
        "hew.solid.union" => union,
        "hew.solid.subtract" => subtract,
        "hew.solid.intersect" => intersect,
        "hew.solid.slice" => slice,
        "hew.solid.follow_me" => follow_me,
        "hew.solid.imprints" => imprints,
        "hew.solid.move_imprint" => move_imprint,
        "hew.solid.rotate_imprint" => rotate_imprint,
        "hew.solid.scale_imprint" => scale_imprint,
        "hew.solid.delete_imprint" => delete_imprint,
        _ => return None,
    })
}

// ------------------------------------------------------------- plumbing

fn parse_params<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, CmdError> {
    serde_json::from_value(params.clone()).map_err(|e| CmdError::Params(e.to_string()))
}

fn unknown_entity(id: &str) -> CmdError {
    CmdError::Refusal(
        Refusal::api(
            "unknown_entity",
            &format!("'{id}' does not name a live entity of the required kind in this document."),
        )
        .with_detail(serde_json::json!({ "id": id })),
    )
}

fn public_id_of(ctx: &Ctx, entity: EntityRef) -> String {
    let sid = ctx
        .doc
        .sid_of(&entity)
        .expect("an entity this command just touched always carries a stable id");
    crate::ids::public_id(&entity, sid)
}

/// A public id resolved to a tree node (Object/Group/Instance) — the
/// operand shape [`kernel::Document::boolean_nodes`] takes.
fn resolve_node(ctx: &Ctx, public: &str) -> Result<NodeId, CmdError> {
    match ctx.resolver().resolve(public) {
        Some(EntityRef::Object(id)) => Ok(NodeId::Object(id)),
        Some(EntityRef::Group(id)) => Ok(NodeId::Group(id)),
        Some(EntityRef::Instance(id)) => Ok(NodeId::Instance(id)),
        Some(_) => Err(CmdError::Params(format!(
            "'{public}' does not name an object, group, or instance"
        ))),
        None => Err(unknown_entity(public)),
    }
}

/// [`kernel::Document::apply_object_op`]/`push_pull_through` route every
/// [`kernel::PushPullError`] through `DocumentError::Op(KernelOpError::PushPull(_))`
/// — a SECOND level of delegation `Refusal::from_document_error`'s
/// variant-name extraction does not unwrap (it takes the leading
/// alphanumeric run of the *first* level's `Debug`, i.e. `KernelOpError`'s
/// own variant name "PushPull", not the `PushPullError` inside it). Left
/// alone, every push/pull refusal — `ObjectNotSolid`, `WouldVanish`,
/// `NonManifoldResult`, … — would surface under the same generic
/// `"push_pull"` machine name, losing exactly the distinction
/// docs/agents/HEW_API.md §4.4 promises. Unwrapped here, locally, one level
/// deeper, without touching the shared `refusal` module another wave
/// owns; `DocumentError`'s own `Display` (used for the explanation) was
/// never affected — only the machine `name` was.
// Push/pull refusals nest two levels deep (`Op(PushPull(..))`);
// `Refusal::from_document_error` unwraps them to the innermost name.
fn push_pull_refusal(e: DocumentError) -> CmdError {
    CmdError::Refusal(Refusal::from_document_error(&e))
}

// -------------------------------------------------------------- commands

pub(super) fn extrude(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        region: String,
        distance: f64,
    }
    let p: P = parse_params(params)?;
    let (sketch, region) = ctx
        .resolver()
        .resolve_region(&p.region)
        .ok_or_else(|| unknown_entity(&p.region))?;
    let sketch_normal = ctx
        .doc
        .sketch(sketch)
        .ok_or_else(|| unknown_entity(&p.region))?
        .plane()
        .normal();

    let (object, _change) = ctx.doc.extrude_region(sketch, region, p.distance)?;

    // Face tokens (docs/agents/HEW_API.md §5.4, normative here): the cap facing
    // the sketch's own normal is "top", the opposite cap "base", the
    // rest "side.<n>" in face-iteration order. Defined by alignment with
    // the ORIGINAL sketch normal, not by the sign of `distance` — a
    // negative-distance extrude (sweeping opposite the sketch normal)
    // still names its caps this way, which is the simplest single rule
    // that needs no case split on sign; see the wave report for the
    // tradeoff this glosses over.
    let plan: Vec<(kernel::FaceId, String)> = {
        let obj = ctx
            .doc
            .object(object)
            .expect("the object extrude_region just created is live");
        let mut sides = 0usize;
        obj.faces()
            .iter()
            .map(|(fid, face)| {
                let dot = face.plane.normal().dot(sketch_normal);
                let key = if dot > 0.999 {
                    "top".to_string()
                } else if dot < -0.999 {
                    "base".to_string()
                } else {
                    sides += 1;
                    format!("side.{sides}")
                };
                (fid, key)
            })
            .collect()
    };
    for (fid, key) in plan {
        ctx.mint_face_token(&key, object, fid);
    }

    Ok(serde_json::json!({ "object_id": public_id_of(ctx, EntityRef::Object(object)) }))
}

pub(super) fn push_pull(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        face: Value,
        distance: f64,
    }
    let p: P = parse_params(params)?;
    let face_ref = locate::resolve_face(ctx, &p.face)?;

    // A face resolving to a component-DEFINITION member routes through
    // the def-scoped kernel methods below instead of the plain world
    // ones — same three-way branch, shared-geometry edit, so every
    // instance of the component picks it up at once (module doc
    // comment; mirrors `commands/sketch.rs`'s `apply_face_op`).
    let component = ctx.doc.object_owner_component(face_ref.object);

    let overshoots = ctx
        .doc
        .object(face_ref.object)
        .is_some_and(|o| o.push_pull_overshoots(face_ref.face, p.distance));
    if overshoots {
        let (objects, _change) = match component {
            Some(c) => ctx
                .doc
                .push_pull_through_in_component(c, face_ref.object, face_ref.face, p.distance)
                .map_err(push_pull_refusal)?,
            None => ctx
                .doc
                .push_pull_through(face_ref.object, face_ref.face, p.distance)
                .map_err(push_pull_refusal)?,
        };
        let object_ids: Vec<String> = objects
            .iter()
            .map(|&id| public_id_of(ctx, EntityRef::Object(id)))
            .collect();
        return Ok(serde_json::json!({ "object_ids": object_ids }));
    }

    let is_sub = ctx
        .doc
        .object(face_ref.object)
        .is_some_and(|o| o.is_flat_sub_face(face_ref.face));
    let op = if is_sub {
        KernelOp::ExtrudeSubFace {
            sub_face: face_ref.face,
            distance: p.distance,
        }
    } else {
        KernelOp::PushPull {
            face: face_ref.face,
            distance: p.distance,
        }
    };
    let (_report, _change) = match component {
        Some(c) => ctx
            .doc
            .apply_def_op(c, face_ref.object, op)
            .map_err(push_pull_refusal)?,
        None => ctx
            .doc
            .apply_object_op(face_ref.object, op)
            .map_err(push_pull_refusal)?,
    };

    Ok(serde_json::json!({ "object_id": public_id_of(ctx, EntityRef::Object(face_ref.object)) }))
}

fn boolean_op(ctx: &mut Ctx, params: &Value, op: kernel::BooleanOp) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        a: String,
        b: String,
    }
    let p: P = parse_params(params)?;
    let a = resolve_node(ctx, &p.a)?;
    let b = resolve_node(ctx, &p.b)?;
    let (result, _change) = ctx.doc.boolean_nodes(op, a, b)?;
    let entity = match result {
        NodeId::Object(id) => EntityRef::Object(id),
        NodeId::Group(id) => EntityRef::Group(id),
        NodeId::Instance(id) => EntityRef::Instance(id),
    };
    Ok(serde_json::json!({ "result": public_id_of(ctx, entity) }))
}

pub(super) fn union(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    boolean_op(ctx, params, kernel::BooleanOp::Union)
}

pub(super) fn subtract(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    boolean_op(ctx, params, kernel::BooleanOp::Subtract)
}

pub(super) fn intersect(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    boolean_op(ctx, params, kernel::BooleanOp::Intersect)
}

pub(super) fn slice(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct PlaneSpec {
        origin: Value,
        normal: Value,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        object: String,
        plane: PlaneSpec,
    }
    let p: P = parse_params(params)?;
    let Some(EntityRef::Object(object)) = ctx.resolver().resolve(&p.object) else {
        return Err(unknown_entity(&p.object));
    };
    let origin = locate::resolve_point(ctx, &p.plane.origin)?;
    let normal = locate::parse_dir(&p.plane.normal)?;
    let plane = kernel::Plane::from_point_normal(origin, normal)
        .map_err(|_| CmdError::Params("degenerate plane normal".into()))?;

    let ((positive, negative), _change) = ctx.doc.slice_node(object, &plane)?;
    Ok(serde_json::json!({
        "positive": public_id_of(ctx, EntityRef::Object(positive)),
        "negative": public_id_of(ctx, EntityRef::Object(negative)),
    }))
}

/// Follow Me has no definition-scoped kernel path yet (`follow_me_face`
/// is world-only), so a face resolving to a component-definition member
/// refuses TYPED — not `unknown_object`, which would falsely tell the
/// caller the id is stale when the very same locator succeeds in
/// `hew.solid.push_pull` and the `hew.sketch.draw_*` face modes.
fn require_world_follow_me_face(ctx: &Ctx, object: kernel::ObjectId) -> Result<(), CmdError> {
    if ctx.doc.object_owner_component(object).is_some() {
        return Err(CmdError::Refusal(Refusal::api(
            "follow_me_in_component_unsupported",
            "Follow Me on a face inside a component definition isn't supported yet — sweep a \
             world object's face instead, or explode the instance first.",
        )));
    }
    Ok(())
}

pub(super) fn follow_me(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        profile: Value,
        path: Value,
    }
    let p: P = parse_params(params)?;

    let path_obj = p
        .path
        .as_object()
        .ok_or_else(|| CmdError::Params("path needs an object".into()))?;
    let path = if let Some(face_locator) = path_obj.get("face") {
        if path_obj.len() != 1 {
            return Err(CmdError::Params("path.face takes no sibling keys".into()));
        }
        let f = locate::resolve_face(ctx, face_locator)?;
        require_world_follow_me_face(ctx, f.object)?;
        FollowMePath::FaceLoop {
            object: f.object,
            face: f.face,
        }
    } else if let Some(curve_val) = path_obj.get("curve") {
        if path_obj.len() != 1 {
            return Err(CmdError::Params("path.curve takes no sibling keys".into()));
        }
        let curve_pub = curve_val
            .as_str()
            .ok_or_else(|| CmdError::Params("path.curve must be a string".into()))?;
        let (sketch, curve) = ctx
            .resolver()
            .resolve_curve(curve_pub)
            .ok_or_else(|| unknown_entity(curve_pub))?;
        let edges = ctx
            .doc
            .sketch(sketch)
            .ok_or_else(|| unknown_entity(curve_pub))?
            .curve_edges(curve);
        FollowMePath::SketchEdges { sketch, edges }
    } else if path_obj.contains_key("edges") {
        // A solid-edge-chain path has no kernel mapping: FollowMePath's
        // edge-chain variant (SketchEdges) takes SKETCH edges, and a
        // resolved solid EdgeId cannot be turned into one — see the wave
        // report.
        return Err(CmdError::Refusal(Refusal::api(
            "unimplemented",
            "an explicit solid-edge-chain path lands after v0 — use path.face (a face's boundary loop) or path.curve (a sketch curve)",
        )));
    } else {
        return Err(CmdError::Params(
            "path needs \"edges\", \"face\", or \"curve\"".into(),
        ));
    };

    if let Some(profile_pub) = p.profile.as_str() {
        let (sketch, region) = ctx
            .resolver()
            .resolve_region(profile_pub)
            .ok_or_else(|| unknown_entity(profile_pub))?;
        let (object, _change) = ctx.doc.follow_me(sketch, region, &path)?;
        Ok(serde_json::json!({ "object_id": public_id_of(ctx, EntityRef::Object(object)) }))
    } else if let Some(profile_obj) = p.profile.as_object() {
        let face_val = profile_obj
            .get("face")
            .ok_or_else(|| CmdError::Params("profile object needs \"face\"".into()))?;
        if profile_obj.len() != 1 {
            return Err(CmdError::Params(
                "profile.face takes no sibling keys".into(),
            ));
        }
        let f = locate::resolve_face(ctx, face_val)?;
        require_world_follow_me_face(ctx, f.object)?;
        let (object, _change) = ctx.doc.follow_me_face(f.object, f.face, &path, None)?;
        Ok(serde_json::json!({ "object_id": public_id_of(ctx, EntityRef::Object(object)) }))
    } else {
        Err(CmdError::Params(
            "profile needs a region id or {\"face\": <locator>}".into(),
        ))
    }
}

// ------------------------------------------------------- editable imprints
// (module doc comment; docs/agents/HEW_API.md's `hew.solid` semantics notes)

fn point_json(p: Point3) -> Value {
    json!([p.x, p.y, p.z])
}

fn midpoint(a: Point3, b: Point3) -> Point3 {
    Point3::new((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5)
}

fn finite_vec3(v: [f64; 3]) -> Result<Vec3, CmdError> {
    if v.iter().any(|c| !c.is_finite()) {
        return Err(CmdError::Params("offset components must be finite".into()));
    }
    Ok(Vec3::new(v[0], v[1], v[2]))
}

fn not_an_imprint() -> CmdError {
    CmdError::Refusal(Refusal::api(
        "not_an_imprint",
        "That locator names neither an imprinted sub-face (a shape drawn inside a face, not yet \
         pushed or pulled) nor a chord (a shape drawn up to a face's edge). Only a \
         drawn-but-unpushed imprint can be moved, turned, scaled, or deleted this way.",
    ))
}

/// The face-plane normal of a live face — a sub-face's own plane, or (for
/// a chord) either of its two faces, which [`kernel::FaceFeature::Chord`]
/// guarantees are coplanar. `None` only for a face that vanished between
/// resolution and use (a caller bug this module never triggers itself).
fn face_normal(ctx: &Ctx, object: ObjectId, face: FaceId) -> Option<Vec3> {
    Some(ctx.doc.object(object)?.faces().get(face)?.plane.normal())
}

/// What an imprint locator (module doc comment) resolved to.
#[derive(Clone, Copy)]
enum ImprintKind {
    SubFace(FaceId),
    Chord(EdgeId),
}

#[derive(Clone, Copy)]
struct ImprintTarget {
    object: ObjectId,
    /// Precomputed at resolution time (via [`face_normal`]) so
    /// `rotate_imprint`/`scale_imprint` need not re-walk `face_features`
    /// for it.
    normal: Vec3,
    kind: ImprintKind,
}

/// Whether `path` (a [`kernel::FaceFeature::Chord`]'s run, first vertex to
/// last) contains the segment `(a, b)` as one of its consecutive pairs, in
/// either direction — how [`resolve_imprint`] matches a resolved solid
/// edge back to the chord run it belongs to. `a`/`b` come from the same
/// live document read as `path` (no JSON round-trip in between), so a
/// tight tolerance is appropriate.
fn chord_path_contains_edge(path: &[Point3], a: Point3, b: Point3) -> bool {
    path.windows(2).any(|w| {
        (points_close(w[0], a) && points_close(w[1], b))
            || (points_close(w[0], b) && points_close(w[1], a))
    })
}

fn points_close(p: Point3, q: Point3) -> bool {
    (p - q).length() <= geom::API_SURFACE_TOL
}

/// Resolves an **imprint locator** (module doc comment): a face locator
/// (§5.2) naming a sub-face imprint directly, or — for a chord, which has
/// no face id of its own — the same locator shape read instead as a point
/// on one of the chord's lines. Tries the face reading first; ANY failure
/// or non-imprint success of it falls through to the edge reading, not
/// only the "resolved but not a sub-face" case, because a chord's shared
/// edge sits exactly on the boundary between its two coplanar faces,
/// where `locate::resolve_face`'s strict inside/outside test is
/// inherently a coin flip (a clean miss, an accidental hit on either
/// side, or even an ambiguous tie) — robust to whichever way that lands.
/// A genuine parameter defect from the face reading (an unknown object
/// id) still surfaces as itself rather than the generic `not_an_imprint`,
/// since that is real, actionable signal the fallback would otherwise
/// bury; a locator that merely missed or tied on the face reading, and
/// then finds no chord either, collapses to the one clear refusal.
fn resolve_imprint(ctx: &Ctx, locator: &Value) -> Result<ImprintTarget, CmdError> {
    let face_result = locate::resolve_face(ctx, locator);
    if let Ok(face_ref) = &face_result {
        let features = ctx.doc.face_features(face_ref.object).unwrap_or_default();
        let sub_face = features
            .iter()
            .any(|f| matches!(f, FaceFeature::SubFace { face, .. } if *face == face_ref.face));
        if sub_face && let Some(normal) = face_normal(ctx, face_ref.object, face_ref.face) {
            return Ok(ImprintTarget {
                object: face_ref.object,
                normal,
                kind: ImprintKind::SubFace(face_ref.face),
            });
        }
    }

    if let Ok(edge_ref) = locate::resolve_edge(ctx, locator) {
        let features = ctx.doc.face_features(edge_ref.object).unwrap_or_default();
        let (a, b) = edge_ref.endpoints;
        for f in features {
            if let FaceFeature::Chord {
                edge, faces, path, ..
            } = f
                && chord_path_contains_edge(&path, a, b)
                && let Some(normal) = face_normal(ctx, edge_ref.object, faces[0])
            {
                return Ok(ImprintTarget {
                    object: edge_ref.object,
                    normal,
                    kind: ImprintKind::Chord(edge),
                });
            }
        }
    }

    match face_result {
        // A genuine identity failure surfaces as itself; only the two
        // geometry-miss outcomes of a face reading collapse to "not an
        // imprint" (a chord's shared edge sits ON the boundary between its
        // two faces, so a face reading there is an honest coin-flip).
        Err(CmdError::Refusal(r))
            if matches!(
                r.name.as_str(),
                "unknown_entity" | "face_token_unknown" | "face_token_stale"
            ) =>
        {
            Err(CmdError::Refusal(r))
        }
        Err(CmdError::Params(msg)) => Err(CmdError::Params(msg)),
        Err(CmdError::Internal(msg)) => Err(CmdError::Internal(msg)),
        _ => Err(not_an_imprint()),
    }
}

/// Applies `xf` to a resolved imprint (module doc comment) — the shared
/// tail of `move_imprint`/`rotate_imprint`/`scale_imprint` — routing
/// through the def-scoped kernel methods when the imprint's object is a
/// component-definition member, exactly like `push_pull`/the face-imprint
/// drawing path above.
fn apply_imprint_op(
    ctx: &mut Ctx,
    target: ImprintTarget,
    xf: Transform,
) -> Result<Value, CmdError> {
    let scope = ctx.doc.object_owner_component(target.object);
    match target.kind {
        ImprintKind::SubFace(face) => {
            ctx.doc.transform_imprint(scope, target.object, face, xf)?;
        }
        ImprintKind::Chord(edge) => {
            ctx.doc.transform_chord(scope, target.object, edge, xf)?;
        }
    }
    Ok(json!({ "object_id": public_id_of(ctx, EntityRef::Object(target.object)) }))
}

pub(super) fn imprints(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        object: String,
    }
    let p: P = parse_params(params)?;
    let Some(EntityRef::Object(object_id)) = ctx.resolver().resolve(&p.object) else {
        return Err(unknown_entity(&p.object));
    };
    let features = ctx
        .doc
        .face_features(object_id)
        .ok_or_else(|| unknown_entity(&p.object))?;

    let mut list = Vec::with_capacity(features.len());
    for f in &features {
        match f {
            FaceFeature::SubFace {
                face,
                loop_path,
                curve,
                curves,
                nested,
                holes,
                ..
            } => {
                let normal =
                    face_normal(ctx, object_id, *face).unwrap_or_else(|| Vec3::new(0.0, 0.0, 1.0));
                // `at`: a point strictly inside the loop, clear of every hole
                // it holds — a nested imprint, or a boss, recess, or hole the
                // shape was drawn around (documented choice — module doc comment /
                // HEW_API.md's imprints semantics note): an interior-point
                // scanline (`geom::interior_point_of_loops`), not a plain
                // vertex or area centroid, so the point still names THIS
                // face — never a nested one — when a centroid would
                // otherwise land in a hole. Falls back to the outer area
                // centroid only for a degenerate loop (fewer than 3
                // points), which cannot arise from live kernel geometry.
                let at = geom::interior_point_of_loops(loop_path, holes, normal)
                    .unwrap_or_else(|| geom::face_centroid(loop_path, &[]));
                list.push(json!({
                    "kind": "sub_face",
                    "at": point_json(at),
                    "loop": loop_path.iter().map(|&p| point_json(p)).collect::<Vec<_>>(),
                    "curve": curve.map(|c| json!({ "center": point_json(c.center), "radius": c.radius })),
                    "curves": claims_json(curves),
                    "nested": nested.len(),
                }));
            }
            FaceFeature::Chord { path, curves, .. } => {
                // `at`: the midpoint of the run's FIRST segment
                // (documented choice — module doc comment / HEW_API.md):
                // always exactly on the chord's own line, and — unlike
                // the run's own midpoint for a multi-edge run — never
                // needs arc-length walking to compute.
                let at = match path.as_slice() {
                    [a, b, ..] => midpoint(*a, *b),
                    [a] => *a,
                    [] => Point3::new(0.0, 0.0, 0.0),
                };
                list.push(json!({
                    "kind": "chord",
                    "at": point_json(at),
                    "path": path.iter().map(|&p| point_json(p)).collect::<Vec<_>>(),
                    "curves": claims_json(curves),
                }));
            }
        }
    }
    Ok(json!({ "imprints": list }))
}

/// Per-edge circle claims of an imprint's loop or run, in edge order:
/// `{ center, radius }` for an arc's facet, `null` for a plain edge — how a
/// pie, segment, or edge-to-edge arc reports the arc it keeps.
fn claims_json(curves: &[Option<kernel::CurveGeom>]) -> Vec<Value> {
    curves
        .iter()
        .map(|c| match c {
            Some(g) => json!({ "center": point_json(g.center), "radius": g.radius }),
            None => Value::Null,
        })
        .collect()
}

pub(super) fn move_imprint(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        imprint: Value,
        offset: [f64; 3],
    }
    let p: P = parse_params(params)?;
    let offset = finite_vec3(p.offset)?;
    let target = resolve_imprint(ctx, &p.imprint)?;
    apply_imprint_op(ctx, target, Transform::translation(offset))
}

pub(super) fn rotate_imprint(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        imprint: Value,
        angle: f64,
        about: Value,
    }
    let p: P = parse_params(params)?;
    if !p.angle.is_finite() {
        return Err(CmdError::Params("angle must be finite".into()));
    }
    // Resolved before the imprint (mirrors `hew.entity.rotate`): a
    // derived-point locator failure should read as its own error, not get
    // masked by an unrelated imprint-resolution refusal.
    let about = locate::resolve_point(ctx, &p.about)?;
    let target = resolve_imprint(ctx, &p.imprint)?;
    // The axis is the imprint's own face normal through `about` — this
    // preserves the imprint's plane for ANY `about` (on-plane or not):
    // rotation about an axis leaves the component along the axis
    // unchanged and never mixes it into the perpendicular ones, so the
    // plane equation `normal·p = d` holds for the rotated points exactly
    // as it did before, regardless of where along that normal line
    // `about` sits.
    let r = Transform::rotation(target.normal, p.angle)
        .map_err(|_| CmdError::Internal("imprint face normal is degenerate".into()))?;
    let about_v = about.to_vec();
    let xf = Transform::translation(-about_v)
        .then(&r)
        .then(&Transform::translation(about_v));
    apply_imprint_op(ctx, target, xf)
}

pub(super) fn scale_imprint(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        imprint: Value,
        factor: f64,
        about: Value,
    }
    let p: P = parse_params(params)?;
    if !p.factor.is_finite() || p.factor <= 0.0 {
        return Err(CmdError::Params(
            "scale factor must be finite and positive".into(),
        ));
    }
    let about = locate::resolve_point(ctx, &p.about)?;
    let target = resolve_imprint(ctx, &p.imprint)?;
    // Uniform scale about `about`; the kernel refuses `not_in_plane` when
    // `about` is off the imprint's plane (a non-uniform-looking result on
    // that plane — see `kernel::Object::transform_sub_face`'s doc
    // comment), so no plane check is duplicated here.
    let about_v = about.to_vec();
    let s = Transform::scale(Vec3::new(p.factor, p.factor, p.factor));
    let xf = Transform::translation(-about_v)
        .then(&s)
        .then(&Transform::translation(about_v));
    apply_imprint_op(ctx, target, xf)
}

pub(super) fn delete_imprint(ctx: &mut Ctx, params: &Value) -> Result<Value, CmdError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct P {
        imprint: Value,
    }
    let p: P = parse_params(params)?;
    let target = resolve_imprint(ctx, &p.imprint)?;
    let object = target.object;
    let scope = ctx.doc.object_owner_component(object);
    match target.kind {
        ImprintKind::SubFace(face) => {
            ctx.doc.dissolve_imprint(scope, object, face)?;
        }
        ImprintKind::Chord(edge) => match scope {
            Some(component) => {
                ctx.doc
                    .apply_def_op(component, object, KernelOp::MergeFaces { edge })?;
            }
            None => {
                ctx.doc
                    .apply_object_op(object, KernelOp::MergeFaces { edge })?;
            }
        },
    }
    Ok(json!({ "object_id": public_id_of(ctx, EntityRef::Object(object)) }))
}
