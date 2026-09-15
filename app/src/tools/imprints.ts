/**
 * Imprints — the drawn-but-not-yet-pushed shapes on a solid's faces, as the
 * app sees them (docs/design/editable-face-sketches.md).
 *
 * The kernel keeps a drawn shape as real topology (a coplanar sub-face
 * twinned with a hole in its parent, or a chord run between two coplanar
 * faces) and recovers "the drawing" structurally on demand
 * (`face_features`, mirroring how sketch islands are derived from sketch
 * edges). This module is the app-side counterpart: parse that query, mint
 * the selection refs (`'imprint'` for a sub-face keyed by its face handle,
 * `'imprint-chord'` for a run keyed by its first edge), and derive the
 * line work, plane, and display name every consumer (Select, the
 * renderer's fill/highlight, Move/Rotate/Scale, Delete, the Outliner)
 * agrees on.
 *
 * Handles: a sub-face keeps its `FaceId` across a move (the kernel moves
 * its vertices in place), so an `'imprint'` ref survives its own edit. A
 * chord run is re-cut on move (fresh edges), so the commit path re-keys
 * the selection from the handle the kernel returns.
 *
 * Coordinates: `face_features` answers in the OBJECT's own frame —
 * world space for a world object, definition-local for a component
 * member. Callers editing inside an instance pose the points through
 * the instance's affine exactly as the sketch highlight does.
 */

import type { NodeRef } from '../panels/treeModel'
import type { V3 } from '../viewport/geoHelpers'

/** One loop/run edge's analytic circle, or `null` when that edge is a plain
 *  line — see the module doc's `face_features` `"curves"` field. */
export type EdgeCurve = { center: V3; radius: number } | null

export interface SubFaceImprint {
  kind: 'sub_face'
  face: bigint
  parent: bigint
  /** The outer loop's positions in cycle order. */
  loop: V3[]
  /** The drawn circle behind the loop, when the whole loop was one. */
  curve: { center: V3; radius: number } | null
  /** Per-loop-edge analytic circle (edge k is loop[k]→loop[k+1], last
   *  closing to first), or `null` per edge that is a plain line — an arc
   *  drawn on a face carries this on its own leading edges even when the
   *  loop as a whole isn't one circle (`curve` is null). */
  curves: EdgeCurve[]
  /** Direct nested imprint faces inside this one. */
  nested: bigint[]
  /** Every hole ring of this shape: nested shapes, and any boss, recess, or
   *  hole it was drawn around (a shape drawn around another adopts it). */
  holes: V3[][]
}

export interface ChordImprint {
  kind: 'chord'
  /** The run's first edge — the handle the kernel keys the run by. */
  edge: bigint
  faces: [bigint, bigint]
  /** The run's vertex positions, first to last. */
  path: V3[]
  /** Per-run-edge analytic circle (edge k is path[k]→path[k+1]), or `null`
   *  per edge that is a plain line. */
  curves: EdgeCurve[]
}

export type ImprintFeature = SubFaceImprint | ChordImprint

/** The wasm surface this module reads. */
export interface ImprintScene {
  face_features(object: bigint): string
}

function triples(flat: unknown): V3[] {
  if (!Array.isArray(flat)) return []
  const out: V3[] = []
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push([Number(flat[i]), Number(flat[i + 1]), Number(flat[i + 2])])
  }
  return out
}

/** Parse `face_features`' `"curves"` array: one entry per loop/run edge,
 *  each `[cx, cy, cz, r]` or `null`. Malformed entries fall back to `null`. */
function parseCurves(raw: unknown): EdgeCurve[] {
  if (!Array.isArray(raw)) return []
  return raw.map((e) => {
    if (!Array.isArray(e) || e.length !== 4) return null
    return { center: [Number(e[0]), Number(e[1]), Number(e[2])] as V3, radius: Number(e[3]) }
  })
}

/** Parse `face_features`' JSON. Malformed entries are skipped, never thrown
 *  on — a render or pick must not die on one odd feature. */
export function parseFaceFeatures(json: string): ImprintFeature[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: ImprintFeature[] = []
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue
    const r = e as Record<string, unknown>
    if (r.kind === 'sub_face') {
      const curve = Array.isArray(r.curve) && r.curve.length === 4
        ? { center: [Number(r.curve[0]), Number(r.curve[1]), Number(r.curve[2])] as V3, radius: Number(r.curve[3]) }
        : null
      out.push({
        kind: 'sub_face',
        face: BigInt(r.face as number),
        parent: BigInt(r.parent as number),
        loop: triples(r.loop),
        curve,
        curves: parseCurves(r.curves),
        nested: Array.isArray(r.nested) ? r.nested.map((n) => BigInt(n as number)) : [],
        holes: Array.isArray(r.holes) ? r.holes.map((h) => triples(h)) : [],
      })
    } else if (r.kind === 'chord') {
      const faces = Array.isArray(r.faces) && r.faces.length === 2
        ? ([BigInt(r.faces[0] as number), BigInt(r.faces[1] as number)] as [bigint, bigint])
        : null
      if (faces === null) continue
      out.push({
        kind: 'chord', edge: BigInt(r.edge as number), faces, path: triples(r.path),
        curves: parseCurves(r.curves),
      })
    }
  }
  return out
}

/** Every imprint `object` carries; `[]` for a stale handle. */
export function readImprints(scene: ImprintScene, object: bigint): ImprintFeature[] {
  try {
    return parseFaceFeatures(scene.face_features(object))
  } catch {
    return []
  }
}

/** The selection ref for a feature of `object`. */
export function imprintRef(object: bigint, feature: ImprintFeature): NodeRef {
  return feature.kind === 'sub_face'
    ? { kind: 'imprint', id: feature.face, object }
    : { kind: 'imprint-chord', id: feature.edge, object }
}

export function isImprintRef(node: NodeRef): node is NodeRef & { object: bigint } {
  return (node.kind === 'imprint' || node.kind === 'imprint-chord') && node.object !== undefined
}

/** The live feature an `'imprint'` / `'imprint-chord'` ref names, or null
 *  when it is stale (dissolved, pushed into a boss, re-cut). */
export function findImprint(scene: ImprintScene, node: NodeRef): ImprintFeature | null {
  if (!isImprintRef(node)) return null
  for (const f of readImprints(scene, node.object)) {
    if (node.kind === 'imprint' && f.kind === 'sub_face' && f.face === node.id) return f
    if (node.kind === 'imprint-chord' && f.kind === 'chord' && f.edge === node.id) return f
  }
  return null
}

/** The sub-face feature whose face is `face`, if it is an imprint. */
export function subFaceImprint(features: readonly ImprintFeature[], face: bigint): SubFaceImprint | null {
  for (const f of features) if (f.kind === 'sub_face' && f.face === face) return f
  return null
}

/** The chord run one of whose edges has the endpoints `a`–`b` (either
 *  order, within `eps`), if any. A solid edge snap names an edge handle the
 *  run may not be keyed by, so runs are matched by geometry. */
export function chordThroughSegment(
  features: readonly ImprintFeature[],
  a: V3,
  b: V3,
  eps = 1e-6,
): ChordImprint | null {
  const near = (p: V3, q: V3) =>
    Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps && Math.abs(p[2] - q[2]) <= eps
  for (const f of features) {
    if (f.kind !== 'chord') continue
    for (let i = 0; i + 1 < f.path.length; i++) {
      const p = f.path[i], q = f.path[i + 1]
      if ((near(p, a) && near(q, b)) || (near(p, b) && near(q, a))) return f
    }
  }
  return null
}

/** The chord run nearest to `point` within `maxDist`, by distance to its
 *  segments — the click test for a run when the snap carries no edge. */
export function chordNearPoint(
  features: readonly ImprintFeature[],
  point: V3,
  maxDist: number,
): ChordImprint | null {
  let best: ChordImprint | null = null
  let bestD = maxDist
  for (const f of features) {
    if (f.kind !== 'chord') continue
    for (let i = 0; i + 1 < f.path.length; i++) {
      const d = Math.sqrt(pointSegmentDistSq(point, f.path[i], f.path[i + 1]))
      if (d < bestD) {
        bestD = d
        best = f
      }
    }
  }
  return best
}

function pointSegmentDistSq(p: V3, a: V3, b: V3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
  const len2 = abx * abx + aby * aby + abz * abz
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2]
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0
  const dx = p[0] - (a[0] + abx * t), dy = p[1] - (a[1] + aby * t), dz = p[2] - (a[2] + abz * t)
  return dx * dx + dy * dy + dz * dz
}

/** The feature's line work as flat segment endpoints `[x0,y0,z0,x1,y1,z1,…]`
 *  (a closed loop for a sub-face, an open polyline for a chord), optionally
 *  posed through a 3x4 row-major affine. */
export function imprintSegments(feature: ImprintFeature, pose?: ArrayLike<number>): Float32Array {
  const pts = feature.kind === 'sub_face' ? feature.loop : feature.path
  const closed = feature.kind === 'sub_face'
  const n = pts.length
  const segs = closed ? n : Math.max(0, n - 1)
  const out = new Float32Array(segs * 6)
  const put = (k: number, p: V3) => {
    let [x, y, z] = p
    if (pose !== undefined) {
      const px = pose[0] * x + pose[1] * y + pose[2] * z + pose[3]
      const py = pose[4] * x + pose[5] * y + pose[6] * z + pose[7]
      const pz = pose[8] * x + pose[9] * y + pose[10] * z + pose[11]
      x = px; y = py; z = pz
    }
    out[k] = x; out[k + 1] = y; out[k + 2] = z
  }
  for (let i = 0; i < segs; i++) {
    put(i * 6, pts[i])
    put(i * 6 + 3, pts[(i + 1) % n])
  }
  return out
}

/** The face an imprint lies on — the sub-face itself, or a chord's first
 *  face — for plane/normal queries. */
export function imprintFace(feature: ImprintFeature): bigint {
  return feature.kind === 'sub_face' ? feature.face : feature.faces[0]
}

/** Whether four points form a rectangle: consecutive sides perpendicular
 *  and opposite sides equal, within a relative tolerance. */
function isRectangle(pts: readonly V3[]): boolean {
  if (pts.length !== 4) return false
  const side = (i: number): V3 => {
    const a = pts[i], b = pts[(i + 1) % 4]
    return [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  }
  const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const len = (u: V3) => Math.sqrt(dot(u, u))
  const s = [side(0), side(1), side(2), side(3)]
  const scale = Math.max(len(s[0]), len(s[1]))
  if (scale <= 0) return false
  const tol = 1e-6 * scale
  for (let i = 0; i < 4; i++) {
    if (Math.abs(dot(s[i], s[(i + 1) % 4])) > tol * scale) return false
  }
  return Math.abs(len(s[0]) - len(s[2])) <= tol && Math.abs(len(s[1]) - len(s[3])) <= tol
}

/** The Outliner / Object Info name for a feature — a plain shape word,
 *  derived: nothing stores what tool drew an imprint. */
export function imprintName(feature: ImprintFeature): string {
  const hasCurve = feature.curves.some((c) => c !== null)
  // Chord names are bare nouns so Object Info's "<name> on <object>"
  // composes: a single cut is a Line, a run of several is an Edge shape —
  // unless one of its edges carries a drawn arc's circle, which names it
  // an Arc regardless of edge count.
  if (feature.kind === 'chord') {
    if (hasCurve) return 'Arc'
    return feature.path.length === 2 ? 'Line' : 'Edge shape'
  }
  if (feature.curve !== null) return 'Circle'
  // A loop that isn't one whole circle but carries a drawn arc on some of
  // its edges (a pie/segment closure) is an Arc shape.
  if (hasCurve) return 'Arc shape'
  if (isRectangle(feature.loop)) return 'Rectangle'
  return 'Shape'
}

/** The imprint refs among `nodes`, with their owning object. */
export function imprintNodes(nodes: readonly NodeRef[]): (NodeRef & { object: bigint })[] {
  return nodes.filter(isImprintRef)
}
