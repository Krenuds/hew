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
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { V3 } from '../viewport/geoHelpers'
import { applyAffine3x4, transformNormalThroughPose } from '../viewport/geoHelpers'
import { parseKernelErrorCode } from '../kernelErrors'

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
 *  `FacePickCache.pickFor`'s eligibility filter ran, plus the hit's ray
 *  `depth` (metres along the normalized ray). Lets a caller that needs the
 *  INELIGIBLE case too (PushPullTool's onPointerDown: the toast hint names
 *  the instance the rejected face belonged to) read it back from the SAME
 *  memoized pick instead of re-raycasting for it, and lets a caller with a
 *  competing pick (PushPullTool's sketch-region pick) compare depths so a
 *  drawn region IN FRONT of the face wins the hover, not the face behind it. */
export interface RawFacePick {
  object: bigint
  instance: bigint | undefined
  face: bigint
  depth: number
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
  let normalArr: ReturnType<WasmScene['face_normal']>
  try {
    normalArr = wasmScene.face_normal(object, face)
  } catch (err) {
    if (isStaleHandle(err)) return null
    throw err
  }
  const local: V3 = [normalArr[0], normalArr[1], normalArr[2]]
  if (activeInstance === null) return local
  const pose = wasmScene.instance_pose(activeInstance)
  if (pose === undefined) return null
  return transformNormalThroughPose(pose, local)
}

/**
 * Whether a kernel throw says the handle names nothing any more — the one
 * failure `worldFaceNormal`/`worldFacePlane` promise to answer with `null`.
 * A memoized face pick can outlive its face between pointer events: a
 * typed retype undoes and recommits the imprint under a stationary cursor,
 * and the next key press re-resolves the snap against the cached ray, so
 * the pick still names the sub-face the undo removed. Any other kernel
 * error is a real fault and still propagates.
 */
function isStaleHandle(err: unknown): boolean {
  const code = parseKernelErrorCode(err)
  return code === 'UnknownObject' || code === 'UnknownFace'
}

/** Metres off a face's plane a point may sit and still count as ON that
 *  face for every face-adoption test in the draw tools (`FacePickCache.
 *  faceThrough`, LineTool's re-adoption) — the kernel's own plane tolerance
 *  scale (`GROUND_PLANE_EPS`), well below any drawn feature. */
export const FACE_PLANE_EPS_M = 1e-6

/** A face's world-space plane: a point on it and its unit normal, mapped
 *  through the active instance's pose when drawing inside one (the same
 *  mapping `worldFaceNormal` applies to the normal). `null` for a stale
 *  handle or a singular pose — callers treat that exactly like a miss. */
export function worldFacePlane(
  wasmScene: WasmScene,
  object: bigint,
  face: bigint,
  activeInstance: bigint | null,
): { point: V3; normal: V3 } | null {
  const normal = worldFaceNormal(wasmScene, object, face, activeInstance)
  if (normal === null) return null
  let planeArr: ReturnType<WasmScene['face_plane']>
  try {
    planeArr = wasmScene.face_plane(object, face)
  } catch (err) {
    if (isStaleHandle(err)) return null
    throw err
  }
  let point: V3 = [planeArr[0], planeArr[1], planeArr[2]]
  if (activeInstance !== null) {
    const pose = wasmScene.instance_pose(activeInstance)
    if (pose === undefined) return null
    point = applyAffine3x4(pose, point)
  }
  return { point, normal }
}

/** Whether `snap` sits on an OBJECT's edge or corner — the one place a pick
 *  ray misses the faces under it (strict polygon test at the boundary), so
 *  the ranked boundary pick (`FacePickCache.faceThrough`) must answer which
 *  face the point belongs to. A type guard: the snap is non-null past it. */
export function snapOnObjectBoundary(
  snap: Snap | null,
): snap is Snap & { object: bigint; elementKind: 'vertex' | 'edge' } {
  return (
    snap !== null &&
    snap.object !== undefined &&
    (snap.elementKind === 'vertex' || snap.elementKind === 'edge')
  )
}

/** Signed distance of `p` off the plane through `point` with unit `normal`. */
export function distanceOffPlane(p: V3, point: V3, normal: V3): number {
  return normal[0] * (p[0] - point[0]) + normal[1] * (p[1] - point[1]) + normal[2] * (p[2] - point[2])
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

/** Angular nudge of the boundary probes in `FacePickCache.faceThrough` —
 *  about a pixel and a half of a 45° view on a 720 px canvas, so a probe
 *  lands on the face beside an edge without reaching anything a hand would
 *  not have aimed at. */
const PICK_NUDGE_RAD = 0.002

/** Eight directions a hair off `dir`, evenly spaced around it: the four
 *  screen-axis nudges (up, down, left, right) and the four diagonals. A ray
 *  through a point ON an edge or corner misses both faces that meet there
 *  (the polygon test is strict at the boundary), and a single nudge can miss
 *  too — sliding along a vertical edge, say — so the probe is a full ring. */
function ringDirections(dir: V3): V3[] {
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
  const out: V3[] = []
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4
    const cu = Math.cos(a) * e
    const sv = Math.sin(a) * e
    out.push([d[0] + u[0] * cu + v[0] * sv, d[1] + u[1] * cu + v[1] * sv, d[2] + u[2] * cu + v[2] * sv])
  }
  return out
}

/** An eligible face found by `FacePickCache.faceThrough`, with its world
 *  plane (already mapped through the active instance's pose). */
export interface FaceThroughPick extends EligibleFacePick {
  point: V3
  normal: V3
}

/**
 * Memoizes the single `pick_face` raycast for the CURRENT pointer event.
 * Keyed by reference equality on the `Ray` passed in (the Viewport builds one
 * Ray object per event); a miss just falls back to a fresh pick.
 * `eligible: null` means either nothing was hit, or a face was hit but the
 * eligibility predicate rejected it.
 */
export class FacePickCache {
  private cache: { ray: Ray; raw: RawFacePick | null; eligible: EligibleFacePick | null } | null = null
  private throughCache: { ray: Ray; key: string; pick: FaceThroughPick | null } | null = null

  pickFor(
    wasmScene: WasmScene,
    ray: Ray,
    isEligible: FaceEligible,
  ): EligibleFacePick | null {
    if (this.cache !== null && this.cache.ray === ray) {
      return this.cache.eligible
    }
    const raw = rawPick(wasmScene, ray.origin, ray.direction)
    let eligible: EligibleFacePick | null = null
    if (raw !== null && isEligible(raw.object, raw.instance)) {
      eligible = { object: raw.object, face: raw.face }
    }
    this.cache = { ray, raw, eligible }
    return eligible
  }

  /**
   * The eligible face under `ray` whose plane holds every point in
   * `through` — the answer to "which face did a click ON an edge or corner
   * mean?", where the plain `pickFor` is blind: a ray through a point on
   * the boundary misses both faces meeting there (strict polygon test), and
   * even a ray a sub-pixel to one side lands on whichever neighbour the
   * rounding favours — a coin toss the user cannot see, and one that put a
   * Rectangle started on a vertical edge's midpoint onto the ground plane.
   *
   * Candidates are the plain ray hit plus a ring of eight probes a hair
   * around it (`ringDirections`), deduplicated, eligibility-filtered, and
   * kept only when their plane contains every `through` point within
   * `FACE_PLANE_EPS_M` (the snapped point itself; for a Line chain's second
   * point, the anchor as well — the face the user is drawing ACROSS holds
   * both). Ties between the surviving neighbours — a vertical edge shared by
   * two visible walls — go to the face most squarely facing the camera
   * (largest `normal · −ray`): the one the user sees most of, and the one a
   * SketchUp user expects the edge click to land on. `null` when no
   * eligible face through those points is under or beside the cursor.
   *
   * Memoized per `ray` reference AND `through` set, like `pickFor`; a
   * caller pairs it with the snap under the cursor (an object vertex or
   * edge — see LineTool's `_snapOnBoundary`), never with a free point, so
   * the nine raycasts run only for boundary hovers/clicks.
   */
  faceThrough(
    wasmScene: WasmScene,
    ray: Ray,
    isEligible: FaceEligible,
    activeInstance: bigint | null,
    through: readonly V3[],
  ): FaceThroughPick | null {
    const key = through.map((p) => p.join(',')).join(';') + `|${activeInstance ?? ''}`
    if (this.throughCache !== null && this.throughCache.ray === ray && this.throughCache.key === key) {
      return this.throughCache.pick
    }
    const seen = new Set<string>()
    const candidates: { pick: FaceThroughPick; facing: number }[] = []
    const dirLen = Math.hypot(ray.direction[0], ray.direction[1], ray.direction[2])
    const consider = (raw: RawFacePick | null) => {
      if (raw === null) return
      const id = `${raw.object}:${raw.face}:${raw.instance ?? ''}`
      if (seen.has(id)) return
      seen.add(id)
      if (!isEligible(raw.object, raw.instance)) return
      const plane = worldFacePlane(wasmScene, raw.object, raw.face, activeInstance)
      if (plane === null) return
      for (const p of through) {
        if (Math.abs(distanceOffPlane(p, plane.point, plane.normal)) > FACE_PLANE_EPS_M) return
      }
      const facing = dirLen < 1e-12
        ? 0
        : -(plane.normal[0] * ray.direction[0] + plane.normal[1] * ray.direction[1] + plane.normal[2] * ray.direction[2]) / dirLen
      candidates.push({ pick: { object: raw.object, face: raw.face, point: plane.point, normal: plane.normal }, facing })
    }
    // The plain ray first (reusing `pickFor`'s memo when it already ran for
    // this ray), then the ring.
    if (this.cache !== null && this.cache.ray === ray) {
      consider(this.cache.raw)
    } else {
      consider(rawPick(wasmScene, ray.origin, ray.direction))
    }
    for (const d of ringDirections(ray.direction)) {
      consider(rawPick(wasmScene, ray.origin, d))
    }
    // Most camera-facing first; a tie keeps probe order (plain ray, then
    // the ring from screen-right counter-clockwise), which is deterministic.
    candidates.sort((a, b) => b.facing - a.facing)
    const pick = candidates.length > 0 ? candidates[0].pick : null
    this.throughCache = { ray, key, pick }
    return pick
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
    this.throughCache = null
  }
}

/** One `pick_face` raycast, with the wasm handle freed. */
function rawPick(wasmScene: WasmScene, origin: V3, direction: V3): RawFacePick | null {
  const pick = wasmScene.pick_face(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2])
  if (pick === undefined) return null
  try {
    return { object: pick.object(), instance: pick.instance(), face: pick.face(), depth: pick.depth() }
  } finally {
    pick.free()
  }
}
