/**
 * faceDraw — the shared "may this face be drawn on directly?" policy for the
 * draw tools (Line / Rectangle / Circle / Polygon / Arc), plus the per-pointer-event
 * pick cache they all use to avoid re-running the O(faces) `pick_face`
 * raycast two or three times for the same ray (snapConstraint and the
 * pointer-move/down dispatcher are called back-to-back by the Viewport).
 *
 * Policy ("plain objects are immediately editable"):
 *   - Inside an entered object context: only that object's faces.
 *   - Top level: any PLAIN object's face — ungrouped and not part of a
 *     component instance. Groups and Components keep their explicit
 *     double-click editing step, so a face belonging to instanced geometry
 *     or to an object nested in a group is not directly drawable.
 *
 * The Viewport can inject a richer predicate (via each tool's
 * `setFaceEligibility`) that also understands group/instance editing
 * contexts — the tools themselves only know the entered-object id.
 *
 * What happens on an INELIGIBLE face differs by tool class, deliberately:
 *
 * - The DRAW tools fall through to ground mode and draw on the plane
 *   beneath. Drawing is additive and fully previewed — the rubber-band
 *   shows exactly where the ink will land before anything commits — and
 *   drawing on the ground plane through whatever stands above it is these
 *   tools' long-standing top-level behavior (SketchUp's too). Pinned in
 *   RectangleTool.test.ts / LineTool.test.ts ("grouped → ground mode").
 * - PUSH/PULL instead CONSUMES the click with an explanatory toast
 *   (PushPullTool). Its fallthrough target would be an existing sketch
 *   region along the same ray — falling through would silently start a
 *   drag on, and then extrude, geometry the user did not aim at. A
 *   mutation of existing geometry must fail closed where new, previewed
 *   ink may fall through.
 */

import type { Ray } from '../viewport/math'
import type { Scene as WasmScene } from '../wasm/loader'
import type { V3 } from '../viewport/geoHelpers'
import { transformNormalThroughPose } from '../viewport/geoHelpers'

/** May the face on `object` (hit through `instance`, when the ray struck
 *  instanced geometry) be drawn on directly? */
export type FaceEligible = (object: bigint, instance: bigint | undefined) => boolean

/** An eligible face under the cursor: the pick's object + face handles. */
export interface EligibleFacePick {
  object: bigint
  face: bigint
}

/** The raw `pick_face` result under the cursor, regardless of eligibility —
 *  `object`/`instance`/`face` exactly as the WASM pick reported them before
 *  `FacePickCache.pickFor`'s eligibility filter ran. Lets a caller that
 *  needs the INELIGIBLE case too (PushPullTool's onPointerDown: the toast
 *  hint names the instance the rejected face belonged to) read it back from
 *  the SAME memoized pick instead of re-raycasting for it. */
export interface RawFacePick {
  object: bigint
  instance: bigint | undefined
  face: bigint
}

/**
 * The WORLD-space unit normal of `object`'s `face` — the mapping every draw
 * tool (Line/Rectangle/Circle/Polygon/Arc) and PushPullTool need before
 * using `face_normal`'s result in world-space math (`rayPlaneIntersect`,
 * the push/pull drag axis, …).
 *
 * `face_normal` is documented (`crates/wasm-api/src/lib.rs`) as answering in
 * the Object's OWN LOCAL frame — which equals world space for a world
 * object (identity-placed) or a Group member (Groups bake every transform
 * into member geometry, never carry their own pose), but NOT for a
 * component INSTANCE's member: an instance carries a real, un-baked pose
 * that may rotate, mirror, or non-uniformly scale (component-edit-parity.md
 * phase A2 — the first time these tools ever draw on a face inside such a
 * context). `activeInstance` is the tool's own entered-instance id (null at
 * top level, inside an object/group context, or when `object` isn't reached
 * through an instance at all) — when set, the local normal is posed forward
 * through `activeInstance`'s pose via the inverse-transpose (`
 * transformNormalThroughPose`), never the plain linear part, which would
 * silently mis-tilt the result under any non-uniform scale.
 *
 * Returns `null` for a stale instance or a degenerate/singular pose —
 * callers should treat that exactly like a missing/stale face pick (stay
 * idle), never fall back to the raw local normal.
 */
export function worldFaceNormal(
  wasmScene: WasmScene,
  object: bigint,
  face: bigint,
  activeInstance: bigint | null,
): V3 | null {
  const normalArr = wasmScene.face_normal(object, face)
  const local: V3 = [normalArr[0], normalArr[1], normalArr[2]]
  if (activeInstance === null) return local
  const pose = wasmScene.instance_pose(activeInstance)
  if (pose === undefined) return null
  return transformNormalThroughPose(pose, local)
}

/**
 * The default tool-local policy (used when the Viewport hasn't injected one):
 * scoped to the entered object inside a context; at top level, plain
 * (ungrouped, non-instanced) objects only.
 */
export function defaultFaceEligible(
  wasmScene: WasmScene,
  activeContext: bigint | null,
  object: bigint,
  instance: bigint | undefined,
): boolean {
  if (activeContext !== null) {
    return instance === undefined && object === activeContext
  }
  if (instance !== undefined) return false
  // kind 0 = object; a defined parent means it lives inside a group.
  return wasmScene.node_parent(0, object) === undefined
}

/**
 * Memoizes the single `pick_face` raycast for the CURRENT pointer event.
 * Keyed by reference equality on the `Ray` passed in (the Viewport builds one
 * Ray object per event); a miss just falls back to a fresh pick.
 * `eligible: null` means either nothing was hit, or a face was hit but the
 * eligibility predicate rejected it.
 */
/** Angular nudge of the boundary probes in `FacePickCache.pickFor` —
 *  about a pixel and a half of a 45° view on a 720 px canvas, so the probe
 *  lands on the face beside an edge without reaching anything a hand would
 *  not have aimed at. */
const PICK_NUDGE_RAD = 0.002

/** Four directions a hair off `dir`: screen-up-ish first (the face a top
 *  edge belongs to, seen from above), then down, then the two sides. */
function nudgedDirections(dir: V3): V3[] {
  const [dx, dy, dz] = dir
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-12) return []
  const d: V3 = [dx / len, dy / len, dz / len]
  // A perpendicular pair: `u` sideways (horizontal when possible), `v` the
  // remaining axis (roughly screen-vertical).
  const upRef: V3 = Math.abs(d[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0]
  let u: V3 = [d[1] * upRef[2] - d[2] * upRef[1], d[2] * upRef[0] - d[0] * upRef[2], d[0] * upRef[1] - d[1] * upRef[0]]
  const ul = Math.hypot(u[0], u[1], u[2])
  u = [u[0] / ul, u[1] / ul, u[2] / ul]
  const v: V3 = [u[1] * d[2] - u[2] * d[1], u[2] * d[0] - u[0] * d[2], u[0] * d[1] - u[1] * d[0]]
  const e = PICK_NUDGE_RAD
  return [
    [d[0] + v[0] * e, d[1] + v[1] * e, d[2] + v[2] * e],
    [d[0] - v[0] * e, d[1] - v[1] * e, d[2] - v[2] * e],
    [d[0] + u[0] * e, d[1] + u[1] * e, d[2] + u[2] * e],
    [d[0] - u[0] * e, d[1] - u[1] * e, d[2] - u[2] * e],
  ]
}

export class FacePickCache {
  private cache: { ray: Ray; probeEdges: boolean; raw: RawFacePick | null; eligible: EligibleFacePick | null } | null = null

  pickFor(
    wasmScene: WasmScene,
    ray: Ray,
    isEligible: FaceEligible,
    probeEdges = false,
  ): EligibleFacePick | null {
    if (this.cache !== null && this.cache.ray === ray && this.cache.probeEdges === probeEdges) {
      return this.cache.eligible
    }
    let pick = wasmScene.pick_face(
      ray.origin[0], ray.origin[1], ray.origin[2],
      ray.direction[0], ray.direction[1], ray.direction[2],
    )
    if (pick === undefined && probeEdges) {
      // A ray through a point ON an edge or corner misses both faces that
      // meet there (the polygon test is strict at the boundary), which is
      // exactly where a drawing gesture usually starts — a midpoint, a
      // corner. Probe a hair to each side of the ray and take the first
      // face hit, so "the face under the cursor" is answered at the
      // boundary too. Opt-in (`probeEdges`), and only worth asking for when
      // the snap under the cursor IS an edge or corner: a caller that would
      // then commit to whichever neighbour the probe found must be able to
      // correct that choice from its next point (the Line tool can; the
      // shape tools and Push/Pull keep the plain miss), and a miss over
      // empty space must not cost four more raycasts on every hover.
      for (const d of nudgedDirections(ray.direction)) {
        pick = wasmScene.pick_face(ray.origin[0], ray.origin[1], ray.origin[2], d[0], d[1], d[2])
        if (pick !== undefined) break
      }
    }
    let raw: RawFacePick | null = null
    let eligible: EligibleFacePick | null = null
    if (pick !== undefined) {
      try {
        const object = pick.object()
        const instance = pick.instance()
        const face = pick.face()
        raw = { object, instance, face }
        if (isEligible(object, instance)) {
          eligible = { object, face }
        }
      } finally {
        pick.free()
      }
    }
    this.cache = { ray, probeEdges, raw, eligible }
    return eligible
  }

  /**
   * The raw pick for the exact `ray` `pickFor` was last called with —
   * `object`/`instance`/`face` regardless of eligibility — so a caller that
   * also needs the INELIGIBLE case (PushPullTool.onPointerDown's fail-closed
   * toast, which names the rejected face's instance) can read it back from
   * this SAME memoized pick instead of re-raycasting. `null` when `pickFor`
   * hasn't been called for this `ray` yet (a cache miss — the caller must
   * call `pickFor` first) or found no face at all.
   *
   * Distinguishing "no face hit" (`rawPickFor` null after a `pickFor` call
   * for this ray) from "a face was hit but is ineligible" (`rawPickFor`
   * non-null, `pickFor`'s own return null) is exactly what lets a caller
   * fail closed on the latter instead of silently falling through to a
   * fallback target behind the ineligible face — see PushPullTool's
   * `snapConstraint` / `onPointerDown`, which must agree on this.
   */
  rawPickFor(ray: Ray): RawFacePick | null {
    if (this.cache !== null && this.cache.ray === ray) {
      return this.cache.raw
    }
    return null
  }

  clear(): void {
    this.cache = null
  }
}
