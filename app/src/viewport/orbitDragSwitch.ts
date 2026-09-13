/**
 * orbitDragSwitch — the two things OrbitControls decides once, at
 * pointerdown, that Hew needs to change WHILE a drag is live:
 *
 * 1. **Shift mid-drag inverts orbit ↔ pan** (and back on release).
 *    OrbitControls reads `shiftKey` only in its pointerdown handler;
 *    pressing Shift halfway through an orbit changed nothing but the
 *    cursor, which promised a pan that never came. `switchDragTo` flips the
 *    live gesture the way a fresh press would have started it: the drag
 *    state changes, the new gesture's origin is re-seeded at the CURRENT
 *    pointer so the view doesn't jump, and the old gesture's pending delta
 *    is zeroed so an orbit stops turning the instant Shift lands instead of
 *    coasting on inertia under the pan. The rule is symmetric and
 *    button-agnostic — `desiredDragState(base, shiftHeld)`: a button's own
 *    binding (`baseBindingFor`) while Shift is up, the other one while it
 *    is held — so it also returns a Shift-started pan to an orbit when Shift
 *    is released, and inverts the Pan tool's left-drag the same way.
 *
 * 2. **Precise orbit** (no inertia) on Ctrl/⌘. `enableDamping` is what
 *    gives the camera its coasting tail — and, less obviously, its lag while
 *    the pointer is still moving (each frame applies only `dampingFactor`
 *    of the pending delta). `setPreciseOrbit(on)` turns damping off for as
 *    long as the modifier is held and drops whatever tail is in flight, so
 *    the camera tracks the pointer 1:1 and stops dead when it does.
 *    OrbitControls itself treats a Ctrl/⌘ press as another "invert the
 *    button" modifier; `forceBaseAfterPress` undoes that right after its
 *    pointerdown handler ran, so Ctrl/⌘ means precision, and only Shift
 *    means invert.
 *
 * Both reach into OrbitControls' underscore-private fields. three.js does
 * not declare them (`OrbitControls.d.ts` exposes neither `state` nor the
 * `_rotateStart`/`_panStart`/`_sphericalDelta`/`_panOffset` scratch
 * vectors), so this module is the ONE place that names them, behind a
 * typed view, with the enum values pinned to `_STATE` in OrbitControls.js.
 * A three.js upgrade that renames any of these fails the feature — never
 * the build — which is why `orbitDragState` answers `'unsupported'` rather
 * than guessing when the shape isn't recognised, and every switch reports
 * whether it actually happened. `orbitDragSwitch.test.ts` constructs a real
 * OrbitControls to pin the field names against the installed three.js.
 */

import type { Vector2, Vector3, Spherical } from 'three'
import { MOUSE } from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** `_STATE` in OrbitControls.js (r185): the mouse drag states this module
 * cares about. Touch states (3–6) are never switched — a two-finger gesture
 * has no Shift key. */
export const ORBIT_STATE = { NONE: -1, ROTATE: 0, DOLLY: 1, PAN: 2 } as const

/** The private surface, as a structural type — see the module doc. */
interface OrbitControlsInternals {
  state: number
  enableDamping: boolean
  _rotateStart: Vector2
  _panStart: Vector2
  _sphericalDelta: Spherical
  _panOffset: Vector3
}

function internals(controls: OrbitControls): OrbitControlsInternals | null {
  const c = controls as unknown as Partial<OrbitControlsInternals>
  if (
    typeof c.state !== 'number' ||
    typeof c.enableDamping !== 'boolean' ||
    c._rotateStart === undefined ||
    c._panStart === undefined ||
    c._sphericalDelta === undefined ||
    c._panOffset === undefined
  ) {
    return null
  }
  return c as OrbitControlsInternals
}

/** A drag OrbitControls can be switched between. */
export type SwitchableDrag = 'rotate' | 'pan'

export type OrbitDragState = 'none' | SwitchableDrag | 'dolly' | 'other' | 'unsupported'

/** Which mouse drag OrbitControls currently has in flight. */
export function orbitDragState(controls: OrbitControls): OrbitDragState {
  const c = internals(controls)
  if (c === null) return 'unsupported'
  switch (c.state) {
    case ORBIT_STATE.NONE: return 'none'
    case ORBIT_STATE.ROTATE: return 'rotate'
    case ORBIT_STATE.PAN: return 'pan'
    case ORBIT_STATE.DOLLY: return 'dolly'
    default: return 'other'
  }
}

/**
 * The gesture a pressed button is bound to with no modifier held — the
 * "base" a Shift press inverts. `leftBinding` is the live
 * `controls.mouseButtons.LEFT` (null under Select and the draw tools, ROTATE
 * under Orbit, PAN under Pan, DOLLY under Zoom). Middle is always orbit and
 * right always pan (`configureControls`). Null when the button starts no
 * switchable drag at all.
 */
export function baseBindingFor(button: number, leftBinding: MOUSE | null | undefined): SwitchableDrag | null {
  if (button === 1) return 'rotate'
  if (button === 2) return 'pan'
  if (button !== 0) return null
  if (leftBinding === MOUSE.ROTATE) return 'rotate'
  if (leftBinding === MOUSE.PAN) return 'pan'
  return null
}

/** The drag a button SHOULD be running right now: its base binding, or the
 * other one while Shift is held. */
export function desiredDragState(base: SwitchableDrag, shiftHeld: boolean): SwitchableDrag {
  if (!shiftHeld) return base
  return base === 'rotate' ? 'pan' : 'rotate'
}

/**
 * Switch a live rotate/pan drag to `want` at the pointer's current client
 * position. Returns false (and touches nothing) unless a rotate or pan drag
 * is actually in flight and differs from `want`.
 */
export function switchDragTo(controls: OrbitControls, want: SwitchableDrag, clientX: number, clientY: number): boolean {
  const c = internals(controls)
  if (c === null) return false
  if (want === 'pan') {
    if (c.state !== ORBIT_STATE.ROTATE) return false
    c._panStart.set(clientX, clientY)
    // Stop turning NOW: a pan that starts while the previous orbit's tail is
    // still coasting reads as the camera ignoring Shift for another half
    // second. Only the rotate delta is dropped — a pan has none pending yet.
    c._sphericalDelta.set(0, 0, 0)
    c.state = ORBIT_STATE.PAN
    return true
  }
  if (c.state !== ORBIT_STATE.PAN) return false
  c._rotateStart.set(clientX, clientY)
  c._panOffset.set(0, 0, 0)
  c.state = ORBIT_STATE.ROTATE
  return true
}

/** Drop whatever orbit/pan motion is still coasting under damping, so the
 * next `update()` leaves the camera exactly where it is. */
export function stopInertia(controls: OrbitControls): void {
  const c = internals(controls)
  if (c === null) return
  c._sphericalDelta.set(0, 0, 0)
  c._panOffset.set(0, 0, 0)
}

/**
 * Precise mode: damping off (1:1 tracking, no tail) while `on`; the default
 * inertia back when it ends. Entering it also stops any tail in flight —
 * pressing the modifier during a coast is the most direct "stop" there is.
 */
export function setPreciseOrbit(controls: OrbitControls, on: boolean): void {
  const c = internals(controls)
  if (c === null) return
  if (on) stopInertia(controls)
  c.enableDamping = !on
}

/** The slice of a pointerdown `forceBaseAfterPress` reads. */
export interface OrbitPressKeys {
  button: number
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  clientX: number
  clientY: number
}

/**
 * Re-decide a press OrbitControls has already handled: a press with only
 * Ctrl/⌘ held (no Shift) asked for PRECISION, but OrbitControls' built-in
 * "any modifier inverts the button" rule started the inverted gesture. Put
 * it back on the button's base binding at the press position. Returns true
 * when it switched. A Shift press — with or without Ctrl/⌘ — is a genuine
 * invert request and is left alone.
 */
export function forceBaseAfterPress(controls: OrbitControls, ev: OrbitPressKeys, leftBinding: MOUSE | null | undefined): boolean {
  if (ev.shiftKey || !(ev.ctrlKey || ev.metaKey)) return false
  const base = baseBindingFor(ev.button, leftBinding)
  if (base === null) return false
  return switchDragTo(controls, base, ev.clientX, ev.clientY)
}
