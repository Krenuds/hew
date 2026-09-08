/**
 * Camera depth policy: where the orbit pivot sits, how close the eye may
 * get, and how the clipping planes follow the eye — the pure math behind
 * Viewport.tsx's "orbit and zoom around what you point at" behavior
 * (docs/design/v1.1-cycle.md, Lane F).
 *
 * Why this exists. `OrbitControls` keeps ONE point, `target`, doing two
 * jobs: the orbit pivot and the dolly reference. With `zoomToCursor` +
 * `screenSpacePanning` it re-places `target` at the clamped dolly radius
 * straight down the view axis on every wheel tick, and the radius decays
 * multiplicatively toward `minDistance` no matter where the model actually
 * is. Once it hits that floor — a fixed fraction of the LAST Zoom Extents'
 * fit distance, i.e. of the whole model's size — three things break at
 * once: the wheel stops moving the eye (`radiusDelta === 0`), Zoom Window
 * can't shrink the distance either, and orbiting pivots about a point a
 * few centimetres in front of the eye while the geometry is metres away,
 * so a tiny orbit swings the whole scene across the screen. A 5 cm detail
 * of a 30 m model was unreachable by construction.
 *
 * The fix has two halves, both pure functions here:
 *
 * 1. **Pivot at the cursor's depth.** Before the wheel or a middle-button
 *    orbit starts, the point under the cursor is picked and `target` is
 *    moved along the CURRENT view axis to that point's depth
 *    (`targetAtDepth`). The eye and the view direction do not change, so
 *    nothing on screen moves — but the dolly radius is now the real
 *    distance to the surface (so each wheel notch covers a fixed fraction
 *    of what is left and converges on the surface instead of on a floor),
 *    and the orbit pivots at the surface's depth, which is what a user
 *    means by "orbit around the thing I'm looking at".
 *
 * 2. **A near-absolute zoom floor with clipping planes that follow the
 *    eye.** `minDistance` becomes a small fraction of the world-length
 *    `far` (`ZOOM_FLOOR_RATIO` — 1 mm at the default mount scale) rather
 *    than ~2 % of the fit distance, and each frame the perspective
 *    camera's `near`/`far` are re-derived from the current eye→target
 *    distance (`dynamicClipPlanes`): `near` tracks the distance so depth
 *    precision at the thing being looked at stays what it was at mount
 *    (`NEAR_RATIO` reproduces the mount-time near/fit ratio) and never
 *    drops below a tenth of the floor, so the near/far ratio the depth
 *    buffer has to span is bounded at `1 / (ZOOM_FLOOR_RATIO / 10)` = 1e6
 *    by construction — a 24-bit depth buffer still resolves ~0.1 % of the
 *    depth at the far plane's distance at that ratio, so z-fighting only
 *    appears on geometry millions of times farther than the surface being
 *    looked at.
 *
 * The world-length state (`far` for the grid footprint and axes half-
 * length, `maxDistance`, and the ratio-scaling `syncWorldLengthViewState`
 * applies to all of it) is untouched by this module; only the camera's own
 * clip planes and the dolly floor are derived from it.
 */

import type { CameraViewLimits } from './math'

/** `minDistance = far_world × ZOOM_FLOOR_RATIO` — 1 mm at the mount-time
 * `far` of 100 m. Small enough for jewelry-scale work; still a hard floor
 * so the dolly can never reach distance 0 (a degenerate spherical). */
export const ZOOM_FLOOR_RATIO = 1e-5

/** `near = distance × NEAR_RATIO`. The mount-time limits put `near` at
 * 0.01 m for a fit distance of ≈5.24 m (≈1/524); 1/500 keeps that same
 * depth precision at the target wherever the eye is. Geometry closer to
 * the eye than 0.2 % of the way to the target clips — negligible. */
export const NEAR_RATIO = 1 / 500

/** The dolly floor for a world-length `far` (see `ZOOM_FLOOR_RATIO`). */
export function zoomFloorFor(worldFar: number): number {
  return worldFar * ZOOM_FLOOR_RATIO
}

/**
 * Perspective clip planes for the current eye→target `distance` against
 * the world-length `far` and the dolly floor `minDistance`.
 *
 * - `near` never drops below a tenth of the floor (so the projection stays
 *   well-conditioned even if a caller hands a distance below the floor —
 *   `OrbitControls.update()` clamps it on the next frame anyway) and never
 *   rises above `worldFar / 1000`, so a far-away eye still sees the whole
 *   world.
 * - `far` is always the world-length `far`: the grid footprint and the
 *   axes are sized to it, and the near floor above already bounds the
 *   depth ratio (see the module doc).
 *
 * A non-finite or non-positive `distance` (a degenerate pose mid-rebuild)
 * yields the static world limits rather than poisoning the projection.
 */
export function dynamicClipPlanes(
  distance: number,
  world: Pick<CameraViewLimits, 'near' | 'far' | 'minDistance'>,
): { near: number; far: number } {
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(world.far) || world.far <= 0) {
    return { near: world.near, far: world.far }
  }
  const floor = world.minDistance / 10
  const ceiling = world.far / 1000
  const near = Math.min(Math.max(distance * NEAR_RATIO, floor), ceiling)
  return { near, far: world.far }
}

/**
 * The orbit target that keeps the eye and the view direction exactly where
 * they are but sits at `hit`'s depth along the view axis — `eye + viewDir ·
 * depth`, where `depth` is `hit`'s projection onto the (unit) view
 * direction, floored at `minDistance` so the pivot can never land behind
 * or on the eye. Returns `null` when `hit` is behind the camera: a pick
 * that cannot be in front of the eye is not a pivot.
 */
export function targetAtDepth(
  eye: readonly [number, number, number],
  viewDir: readonly [number, number, number],
  hit: readonly [number, number, number],
  minDistance: number,
): [number, number, number] | null {
  const dx = hit[0] - eye[0]
  const dy = hit[1] - eye[1]
  const dz = hit[2] - eye[2]
  const depth = dx * viewDir[0] + dy * viewDir[1] + dz * viewDir[2]
  if (!Number.isFinite(depth) || depth <= 0) return null
  const d = Math.max(depth, minDistance)
  return [eye[0] + viewDir[0] * d, eye[1] + viewDir[1] * d, eye[2] + viewDir[2] * d]
}

/**
 * Whether a ground-plane hit is an acceptable pivot fallback when nothing
 * solid is under the cursor: only when it is not absurdly far compared to
 * where the camera is already looking (`GROUND_FALLBACK_MAX_RATIO` × the
 * current target distance). A grazing ray meets z = 0 hundreds of metres
 * away; pivoting there is exactly the "pole off-screen" the fix removes.
 */
export const GROUND_FALLBACK_MAX_RATIO = 4

export function groundHitIsUsable(hitDepth: number, currentDistance: number): boolean {
  return Number.isFinite(hitDepth) && hitDepth > 0 && hitDepth <= currentDistance * GROUND_FALLBACK_MAX_RATIO
}
