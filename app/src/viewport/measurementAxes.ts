/**
 * measurementAxes — which drawing axis each dimension in the Measurements box
 * runs along.
 *
 * The VCB shows a tool's typed value as one formatted string ("3 m × 5 m"),
 * and nothing in it says which direction each number drives. That ordering is
 * not guessable: a rectangle drawn on the ground runs world X then Y, but on
 * any other plane the two directions come from `facePlaneBasis(normal)`, whose
 * result depends on the plane and on nothing the user chose. On a wall facing
 * +X it resolves to +Z then −Y — the first number you type is the height.
 *
 * So each tool that knows its directions reports them alongside the text, as
 * axis INDICES against the current drawing-axes frame, and `MeasurementBox`
 * paints a dot per dimension. Indices, not colours: the component resolves
 * `var(--axis-red|green|blue)` itself, so theming stays in CSS and this module
 * stays DOM-free and testable in Node — the same split `inferenceColor.ts`
 * already uses for the inference chip and the snap marker.
 */
import type { V3 } from './geoHelpers'
import type { DrawingAxes } from '../tools/drawingAxes'
import { axisColorForDirection, AXIS_LABEL_TOL_DOT } from './axisColors'

/** 0 = the frame's X (red), 1 = Y (green), 2 = Z (blue). */
export type AxisIndex = 0 | 1 | 2

/**
 * One entry per dimension the readout prints, in the order it prints them.
 * `null` means that dimension runs along no drawing axis — an oblique plane,
 * a free drag. The array length is the tool's dimension count, NOT how many
 * the user has typed so far, so the dots are all present from the first
 * keystroke and the box never changes width mid-entry.
 */
export type MeasurementAxes = readonly (AxisIndex | null)[]

/** Axis index → the `--axis-*` token suffix. Mirrors `inferenceColor.ts`. */
export const AXIS_NAME = ['red', 'green', 'blue'] as const

/**
 * The axis `dir` reads as within `frame`, or null when it lies along none of
 * them. Polarity-blind (−Y is the green axis just as +Y is), so a tool can
 * resolve this from its plane alone, before the cursor has picked a side.
 */
export function measurementAxisFor(dir: V3, frame: DrawingAxes): AxisIndex | null {
  const match = axisColorForDirection(dir, AXIS_LABEL_TOL_DOT, undefined, frame)
  return match === null ? null : match.axis
}

/**
 * Element-wise equality, so a consumer holding this in React state can keep
 * the previous array when nothing changed. The text channel already bails out
 * of a re-render on a repeated string; a freshly built array never would.
 */
export function sameMeasurementAxes(
  a: MeasurementAxes | undefined,
  b: MeasurementAxes | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * The dot's accessible name. The dots are colour-only information and Hew has
 * no colourblind mode, so each one carries this as `aria-label` and `title` —
 * a tooltip for the sighted user who cannot separate the reds and greens, and
 * a name for a screen reader. Wording matches the inference chip's own
 * "on red axis".
 */
export function axisAriaLabel(axis: AxisIndex | null): string {
  return axis === null ? 'off axis' : `on ${AXIS_NAME[axis]} axis`
}
