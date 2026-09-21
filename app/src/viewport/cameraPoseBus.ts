/**
 * cameraPoseBus — a per-frame camera-orientation feed for viewport chrome
 * that has to keep facing the right way (docs/design/camera.md §8; today only
 * the ViewCube).
 *
 * The viewport publishes the live camera's quaternion once per rendered
 * frame; anything that needs it subscribes. That single publish covers every
 * way the camera can move, because nothing the user SEES happens without a
 * render: an OrbitControls drag and its damping tail both re-arm the pump
 * through `changed`, `tweenCameraState` calls `scheduleRender()` on each of
 * its own rAF steps, and `setStandardView`/`zoomExtents`/`applyCameraState`
 * all end in one.
 *
 * Why a module and not a `ViewportApi` member: `apiRef.current` stays null
 * until the giant `wasmScene`-keyed effect in `Viewport.tsx` assembles it, and
 * a child's mount effect has no ordering guarantee against that. A subscriber
 * would have to poll for the API to appear. The bus has no such window — and
 * `subscribe` replays the last published pose synchronously, so chrome that
 * mounts late (the View ▸ View Cube toggle switching back on, mid-session) is
 * oriented correctly on its very first paint rather than after the next
 * camera move.
 *
 * One viewport per document, so one pose is the whole state. Separate Tauri
 * webview windows load separate module instances and do not share it, which
 * is what you want — each window has its own camera.
 *
 * Pure and DOM-free, so it unit-tests in the node env.
 */

export type CameraPoseListener = (qx: number, qy: number, qz: number, qw: number) => void

/**
 * Per-component change gate. A unit quaternion's components live in [-1, 1],
 * so an absolute epsilon is well conditioned here — no relative comparison
 * needed. This is well below a pixel of rotation on a cube this size, and it
 * is what keeps a still camera from writing `style.transform` on every frame
 * of a fade or a loupe animation that re-renders for unrelated reasons.
 */
const POSE_EPSILON = 1e-7

const listeners = new Set<CameraPoseListener>()
let last: [number, number, number, number] | null = null

/**
 * Listen for camera orientation. The callback fires immediately with the last
 * published pose if there is one, then on every subsequent change. Returns
 * the unsubscribe, which is safe to call more than once.
 */
export function subscribeCameraPose(listener: CameraPoseListener): () => void {
  listeners.add(listener)
  if (last !== null) listener(last[0], last[1], last[2], last[3])
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Publish the live camera's world quaternion. Called once per rendered frame
 * from the viewport's render loop, so it stays allocation-free: four scalars,
 * never an object or an array argument.
 *
 * Unchanged poses are dropped, so a frame rendered for some other reason (a
 * material fade, the tape loupe) costs subscribers nothing.
 */
export function publishCameraPose(qx: number, qy: number, qz: number, qw: number): void {
  if (last !== null && !moved(last, qx, qy, qz, qw)) return
  if (last === null) last = [qx, qy, qz, qw]
  else {
    last[0] = qx
    last[1] = qy
    last[2] = qz
    last[3] = qw
  }
  for (const listener of listeners) listener(qx, qy, qz, qw)
}

function moved(
  prev: readonly [number, number, number, number],
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): boolean {
  return (
    Math.abs(prev[0] - qx) > POSE_EPSILON ||
    Math.abs(prev[1] - qy) > POSE_EPSILON ||
    Math.abs(prev[2] - qz) > POSE_EPSILON ||
    Math.abs(prev[3] - qw) > POSE_EPSILON
  )
}

/**
 * Drop the retained pose. The viewport calls this on teardown so a remounting
 * viewport (a new document, a `wasmScene` change) cannot hand a subscriber the
 * previous document's camera for one frame. Listeners are NOT dropped —
 * they own their own unsubscribe and outlive a viewport remount.
 */
export function resetCameraPoseBus(): void {
  last = null
}

/** The retained pose, or `null` before the first publish. For tests. */
export function lastCameraPose(): readonly [number, number, number, number] | null {
  return last
}
