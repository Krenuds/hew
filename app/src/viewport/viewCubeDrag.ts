/**
 * viewCubeDrag — click-vs-drag on the ViewCube, and the pixel-to-radian
 * conversion that makes dragging it feel exactly like a middle-drag in the
 * viewport (docs/design/camera.md §8).
 *
 * Pure data in, pure data out, in the shape `zoomWindowDrag.ts`/`dragMove.ts`/
 * `fovDrag.ts` already use: the component owns the pointer events, this owns
 * the decisions, and the decisions are testable without a browser.
 *
 * **The conversion is OrbitControls', not ours.** Its rotate handler is
 * `_rotateLeft(2π · Δx / element.clientHeight)` and
 * `_rotateUp(2π · Δy / element.clientHeight)` — height on BOTH axes, which is
 * deliberate on three.js' part and which its source flags with a "yes,
 * height" comment. Restating it here rather than importing is unavoidable
 * (the constants are inlined in a private method), so `viewCubeDrag.test.ts`
 * pins the numbers, and the height that goes in is the VIEWPORT's, never the
 * cube's own box — feed it the cube's 88px and the same hand movement would
 * spin the camera nine times as far as the identical drag on the canvas.
 *
 * Deltas are incremental (previous sample → current), matching OrbitControls'
 * own re-seeding of `_rotateStart` on every move, so a caller hands each
 * result straight to `orbitBy` and never accumulates.
 */

/**
 * Pixels of travel that turn a press on the cube into an orbit instead of a
 * region click. The same 5px the marquee, drag-move and zoom-window gestures
 * use, so "click" means one thing everywhere in the viewport.
 */
export const VIEW_CUBE_DRAG_THRESHOLD_PX = 5

/**
 * Multiplier on the OrbitControls-matched rate. 1 is a true 1:1 with a
 * viewport middle-drag — a 100px drag across an 800px-tall viewport turns the
 * camera 45°, which is the same arc that drag would sweep on the canvas.
 * Named rather than inlined because it is the one number worth reaching for
 * if the cube ever feels sluggish for its size; changing it is a deliberate
 * break from canvas parity, not a tuning nit.
 */
export const VIEW_CUBE_DRAG_GAIN = 1

export interface ViewCubeDragState {
  readonly startX: number
  readonly startY: number
  readonly lastX: number
  readonly lastY: number
  /** True once the pointer has traveled past the threshold. Never goes back
   * to false: a gesture that became an orbit stays an orbit even if the
   * pointer returns to where it started. */
  readonly dragging: boolean
}

/** Orbit deltas in radians, in OrbitControls' own sense: `deltaTheta` feeds
 * `rotateLeft`, `deltaPhi` feeds `rotateUp`. */
export interface ViewCubeOrbitDelta {
  readonly deltaTheta: number
  readonly deltaPhi: number
}

export function beginViewCubeDrag(x: number, y: number): ViewCubeDragState {
  return { startX: x, startY: y, lastX: x, lastY: y, dragging: false }
}

/**
 * Advance a live gesture. Answers `orbit: null` while the travel is still
 * under the threshold — the press is still a potential click.
 *
 * On the frame the threshold is crossed the delta is measured from the PRESS,
 * not from the previous sample, so the first few pixels of travel are not
 * silently dropped; a fast flick that clears the threshold in one event still
 * turns the camera by everything the hand actually moved.
 */
export function updateViewCubeDrag(
  state: ViewCubeDragState,
  x: number,
  y: number,
  viewportHeightPx: number,
): { state: ViewCubeDragState; orbit: ViewCubeOrbitDelta | null } {
  if (!state.dragging) {
    if (Math.hypot(x - state.startX, y - state.startY) < VIEW_CUBE_DRAG_THRESHOLD_PX) {
      return { state: { ...state, lastX: x, lastY: y }, orbit: null }
    }
    return {
      state: { ...state, lastX: x, lastY: y, dragging: true },
      orbit: orbitDelta(x - state.startX, y - state.startY, viewportHeightPx),
    }
  }
  return {
    state: { ...state, lastX: x, lastY: y },
    orbit: orbitDelta(x - state.lastX, y - state.lastY, viewportHeightPx),
  }
}

/** What a release means: a click activates the region under the pointer, a
 * finished drag does nothing further (the camera already moved). */
export function endViewCubeDrag(state: ViewCubeDragState): { click: boolean } {
  return { click: !state.dragging }
}

function orbitDelta(dx: number, dy: number, viewportHeightPx: number): ViewCubeOrbitDelta {
  // A zero height means the viewport has not been laid out yet (or a test
  // handed us one). Floor at 1 rather than emitting Infinity, which would
  // send the camera to NaN and never recover.
  const height = viewportHeightPx > 0 ? viewportHeightPx : 1
  const rate = (2 * Math.PI * VIEW_CUBE_DRAG_GAIN) / height
  return { deltaTheta: dx * rate, deltaPhi: dy * rate }
}
