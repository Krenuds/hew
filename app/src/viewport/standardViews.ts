/**
 * standardViews — the seven SketchUp-style standard camera framings and the
 * pole margin they share with free orbit (docs/design/camera.md).
 *
 * Lifted out of `Viewport.tsx` so the ViewCube (`viewCubeRegions.ts`, design
 * §8) can build its six face regions from the SAME eye table the Camera menu
 * and `setStandardView` use, rather than restating the vectors. Restating
 * them would put the cube's Top a hair off the viewport's Top — the two would
 * agree on screen and disagree in the numbers, which is exactly the drift
 * `POLE_TILT`'s own doc warns about.
 *
 * No three.js and no React import: pure data, so the cube's node-env suites
 * can read it without pulling the viewport in.
 */

/** One of the seven SketchUp-style standard camera framings. */
export type StandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'

/**
 * A hair of tilt off the ±Z pole for Top/Bottom (≈0.06°, visually imperceptible).
 * Looking *exactly* straight down with world-up +Z is gimbal-degenerate (the
 * look direction is parallel to up), which both breaks the view's roll and — the
 * real problem — would force a horizontal up, so orbiting from a top view pivots
 * around the wrong axis. Nudging the eye a touch off the pole lets every view
 * keep world-up +Z, so orbit always pivots around Z (natural in a Z-up world).
 *
 * The same constant also floors FREE orbit via the OrbitControls polar-angle
 * clamp (see the controls setup): near-pole poses are ill-conditioned (basis
 * roll amplifies position jitter into whole-frame shimmer), and the safe
 * margin for the baked views and for orbiting must be one value so they
 * can't drift apart.
 */
export const POLE_TILT = 0.001

/**
 * Eye direction (target→camera) for each standard view, in the Z-up world (X
 * red, Y green, Z blue). Every view keeps world-up +Z (see {@link POLE_TILT});
 * Iso is the SketchUp front-right-top corner.
 */
export const STANDARD_VIEWS: Record<StandardView, { eye: [number, number, number] }> = {
  top:    { eye: [0, -POLE_TILT, 1] },
  bottom: { eye: [0, -POLE_TILT, -1] },
  front:  { eye: [0, -1, 0] },
  back:   { eye: [0, 1, 0] },
  right:  { eye: [1, 0, 0] },
  left:   { eye: [-1, 0, 0] },
  iso:    { eye: [1, -1, 1] },
}

/** World-up for every standard view and every ViewCube region — the Z-up
 * world's own up. Top/Bottom stay safe through {@link POLE_TILT}, not through
 * a different up. */
export const WORLD_UP: [number, number, number] = [0, 0, 1]
