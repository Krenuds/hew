/**
 * viewCubeMatrix — the camera pose the ViewCube is drawn with
 * (docs/design/camera.md §8).
 *
 * The cube is DOM, not GL (see `ViewCube.tsx` for why), so its orientation is
 * a CSS `matrix3d`. Two transforms compose to place a face:
 *
 *   parent (the cube)  →  `cubeMatrix(q)`           — world → CSS, per frame
 *   child  (one face)  →  `faceMatrix(face, half)`  — that face's own square,
 *                          expressed in WORLD axes, constant
 *
 * Splitting it that way means the per-face transforms are computed once at
 * module scope and only the parent's 16 numbers change as the camera moves:
 * one `style.transform` write per frame, no React render.
 *
 * The one thing worth stating plainly, because every sign in here follows
 * from it: three.js view space is X right, Y **up**, −Z forward, while CSS 3D
 * space is X right, Y **down**, +Z toward the viewer. So world → CSS is the
 * inverse camera rotation with its middle ROW negated, and each face's own
 * frame is (right, −up, normal) — its middle COLUMN negated — to match. The
 * two flips cancel, which is why the cube reads unmirrored rather than as its
 * own mirror image. three.js' `CSS3DRenderer` makes the same pair of
 * negations for the same reason.
 *
 * This module also PICKS — `regionAtCubePoint` answers which region a pointer
 * is over, by inverting the same projection it draws with. The cube does not
 * ask the browser, and that is not a preference: Chromium routes a pointer
 * event inside a `preserve-3d` subtree to a different element than
 * `elementsFromPoint` reports for the very same pixel, so at a zone's own
 * centre `ev.target` comes back as the face rather than the zone. Neither
 * answer can be relied on, and engines need not agree with each other. The
 * projection is ours, the inverse is four lines, and doing it here makes
 * picking exact, identical across browsers, and testable without a browser
 * at all.
 *
 * Uses only `THREE`'s math classes (no renderer, no scene), so this runs in
 * the node test env like the rest of the viewport's pure modules.
 */
import * as THREE from 'three'
import { CUBE_FACES, faceFrame, faceZones, type CubeFace } from './viewCubeRegions'

/** A 4×4 in CSS/`THREE.Matrix4` column-major order. */
export type Matrix3dElements = readonly number[]

const IDENTITY: Matrix3dElements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

// Hoisted scratch: `cubeMatrix` runs on every camera frame and must not
// allocate (the pose bus calls it straight out of the render loop).
const SCRATCH_Q = new THREE.Quaternion()
const SCRATCH_M = new THREE.Matrix4()
const SCRATCH_V = new THREE.Vector3()

/**
 * World → CSS rotation for a camera orientation, given as the camera's world
 * quaternion — the payload the pose bus carries. Apply it to the cube and
 * each face lands where that face of the model is on screen.
 *
 * A non-finite or zero-length quaternion answers identity rather than NaNs:
 * the cube freezes for that one frame instead of vanishing.
 */
export function cubeMatrix(qx: number, qy: number, qz: number, qw: number): Matrix3dElements {
  if (!Number.isFinite(qx + qy + qz + qw)) return IDENTITY
  if (qx === 0 && qy === 0 && qz === 0 && qw === 0) return IDENTITY

  // Inverting the camera's rotation gives world → view.
  SCRATCH_Q.set(qx, qy, qz, qw).normalize().invert()
  const el = SCRATCH_M.makeRotationFromQuaternion(SCRATCH_Q).elements

  // Negate the middle ROW (view Y is up, CSS Y is down). In column-major
  // storage that row is elements 1, 5, 9, 13.
  const out = [...el]
  out[1] = -out[1]
  out[5] = -out[5]
  out[9] = -out[9]
  out[13] = -out[13]
  return out
}

/**
 * The direction from the orbit target toward the camera, for the cube's
 * "you are here" lookup — a camera's own +Z axis in world space, which is
 * exactly that direction in three.js' convention (a camera looks down −Z).
 */
export function eyeDirFromQuaternion(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): [number, number, number] {
  if (!Number.isFinite(qx + qy + qz + qw)) return [0, 0, 1]
  SCRATCH_Q.set(qx, qy, qz, qw).normalize()
  SCRATCH_V.set(0, 0, 1).applyQuaternion(SCRATCH_Q)
  return [SCRATCH_V.x, SCRATCH_V.y, SCRATCH_V.z]
}

/**
 * How far a face must be turned toward the viewer before it accepts clicks:
 * `cos 80°`, so at least 10° of facing.
 *
 * Not `> 0`. A face barely past edge-on presents a sliver — at the Top view
 * the front face is turned toward you by all of `POLE_TILT`'s 0.057°, which
 * is a fifth of a pixel of cube — and a sliver that still hit-tests is a trap:
 * it sits exactly where the user is aiming at the face behind it, and it
 * catches the click. At the threshold a face is ~15px wide, so its zones are
 * a ~5px target, which is the smallest thing worth calling clickable.
 *
 * Nothing becomes unreachable. Every region on a near-edge-on face is also a
 * region of the well-facing face it shares that silhouette edge with — which
 * is the whole reason each face carries its neighbours' edges and corners.
 */
const FACE_INTERACTIVE_DOT = Math.cos((80 * Math.PI) / 180)

/**
 * Which faces are turned toward the viewer far enough to accept a click.
 *
 * The cube switches `pointer-events` off on the rest rather than leaning on
 * `backface-visibility: hidden` to suppress hit-testing — whether a
 * back-facing element stays clickable is exactly the kind of thing engines
 * have historically disagreed about, and the cube's correctness should not
 * ride on it. `backface-visibility` stays set, but only as a paint hint.
 */
export function visibleFaces(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): Record<CubeFace, boolean> {
  const view = eyeDirFromQuaternion(qx, qy, qz, qw)
  const out = {} as Record<CubeFace, boolean>
  for (const face of CUBE_FACES) {
    const n = faceFrame(face).normal
    out[face] = n[0] * view[0] + n[1] * view[1] + n[2] * view[2] > FACE_INTERACTIVE_DOT
  }
  return out
}

/**
 * One face's placement on the cube, in world axes: its square pushed out to
 * `halfPx` along its own normal, with the div's local +X on the face's right
 * and local +Y on the face's −up (a DOM element's local Y points down).
 *
 * Constant per face — `FACE_MATRICES` below calls this once, at module scope.
 */
export function faceMatrix(face: CubeFace, halfPx: number): Matrix3dElements {
  const { normal, right, up } = faceFrame(face)
  // Column-major: [ right | -up | normal | normal*half ]. The translation
  // column is NOT negated — the camera matrix's row flip already handles it.
  // `+ 0` folds the `-0` that negating a zero component produces, so a face's
  // matrix is one canonical array however it was built.
  return [
    right[0], right[1], right[2], 0,
    -up[0] + 0, -up[1] + 0, -up[2] + 0, 0,
    normal[0], normal[1], normal[2], 0,
    normal[0] * halfPx + 0, normal[1] * halfPx + 0, normal[2] * halfPx + 0, 1,
  ]
}

/** Format for a `style.transform`. */
export function cssMatrix3d(elements: Matrix3dElements): string {
  return `matrix3d(${elements.map(round).join(', ')})`
}

/** Six decimals is far finer than a pixel at cube scale, and `+ 0` folds the
 * `-0` that falls out of negating a zero row so the same pose always produces
 * the same string. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6 + 0
}

/**
 * Apply a world→CSS matrix to a world direction — what the tests use to ask
 * "where did this axis end up on screen". CSS space: +X right, +Y down,
 * +Z toward the viewer.
 */
export function applyToDirection(
  elements: Matrix3dElements,
  dir: readonly [number, number, number],
): [number, number, number] {
  return [
    elements[0] * dir[0] + elements[4] * dir[1] + elements[8] * dir[2],
    elements[1] * dir[0] + elements[5] * dir[1] + elements[9] * dir[2],
    elements[2] * dir[0] + elements[6] * dir[1] + elements[10] * dir[2],
  ]
}

/**
 * Which region is under a point on the cube, or `null` for a miss (the
 * corners of the widget's box, outside the cube's silhouette).
 *
 * `sx`/`sy` are CSS pixels from the cube's CENTRE, y down — the same frame
 * the cube is drawn in. `elements` is the live `cubeMatrix`.
 *
 * The cube draws with no `perspective`, so its projection is orthographic and
 * inverting it is a 2x2 solve. A point on face `f` at face-local (u, v), both
 * in [-1, 1] along the face's own right and up, sits at world
 * `(normal + right*u + up*v) * half`; pushing that through `elements` gives
 * its screen position, so screen position back to (u, v) is the inverse of a
 * 2x2. A face whose 2x2 is singular is edge-on and is skipped. Of the faces
 * that contain the point, the nearest to the viewer wins — which is what
 * makes overlapping silhouette zones resolve the way they look.
 */
export function regionAtCubePoint(
  elements: Matrix3dElements,
  sx: number,
  sy: number,
  halfPx: number,
): string | null {
  if (halfPx <= 0) return null
  const x = sx / halfPx
  const y = sy / halfPx

  let bestRegion: string | null = null
  let bestDepth = -Infinity

  for (const face of CUBE_FACES) {
    const { normal, right, up } = faceFrame(face)
    const n = applyToDirection(elements, normal)
    const r = applyToDirection(elements, right)
    const p = applyToDirection(elements, up)

    // [ r.x p.x ] [u]   [x - n.x]
    // [ r.y p.y ] [v] = [y - n.y]
    // Turned away from the viewer — never pick a region through the cube.
    // Depth ordering alone is not enough at the silhouette, where a point
    // sits exactly on both the near face's edge and the far one's: rounding
    // decides which of the two passes its own |u| <= 1 test, and the far one
    // can be the survivor.
    if (n[2] <= 0) continue
    const det = r[0] * p[1] - p[0] * r[1]
    if (Math.abs(det) < 1e-9) continue // edge-on: no area to hit
    const dx = x - n[0]
    const dy = y - n[1]
    const u = (dx * p[1] - p[0] * dy) / det
    const v = (r[0] * dy - dx * r[1]) / det
    if (u < -1 || u > 1 || v < -1 || v > 1) continue

    const depth = n[2] + r[2] * u + p[2] * v
    if (depth <= bestDepth) continue
    bestDepth = depth
    // Thirds, in the same order `faceZones` emits: row 0 is the TOP row, so
    // it is the one at the positive end of the face's up axis.
    const col = u < -1 / 3 ? 0 : u < 1 / 3 ? 1 : 2
    const rowFromTop = v > 1 / 3 ? 0 : v < -1 / 3 ? 2 : 1
    bestRegion = faceZones(face)[rowFromTop][col]
  }
  return bestRegion
}
