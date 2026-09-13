// @vitest-environment jsdom
// (the real-OrbitControls shape check below constructs the controls on a DOM element)
import { describe, it, expect } from 'vitest'
import { MOUSE, Vector2, Vector3, Spherical, PerspectiveCamera } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  ORBIT_STATE,
  orbitDragState,
  baseBindingFor,
  desiredDragState,
  switchDragTo,
  stopInertia,
  setPreciseOrbit,
  forceBaseAfterPress,
} from './orbitDragSwitch'

/** A stand-in with exactly OrbitControls' private drag surface. */
function fakeControls(state: number = ORBIT_STATE.NONE) {
  const c = {
    state,
    enableDamping: true,
    _rotateStart: new Vector2(-1, -1),
    _panStart: new Vector2(-1, -1),
    _sphericalDelta: new Spherical(0, 0.2, 0.3),
    _panOffset: new Vector3(1, 2, 3),
  }
  return c as unknown as OrbitControls & typeof c
}

describe('orbitDragSwitch — the installed OrbitControls still has the shape this relies on', () => {
  it('a live three.js OrbitControls exposes state + the four scratch fields', () => {
    // jsdom has no layout, but constructing the controls needs only an
    // element with event listeners — enough to prove the private field
    // names this module pins are the ones the installed three.js uses.
    const el = document.createElement('div')
    Object.assign(el, { setPointerCapture: () => {}, releasePointerCapture: () => {} })
    const controls = new OrbitControls(new PerspectiveCamera(), el)
    expect(orbitDragState(controls)).toBe('none')
    // And that its idle enum value is the one ORBIT_STATE pins.
    expect((controls as unknown as { state: number }).state).toBe(ORBIT_STATE.NONE)
    controls.dispose()
  })
})

describe('orbitDragState', () => {
  it('maps the private enum', () => {
    expect(orbitDragState(fakeControls(ORBIT_STATE.NONE))).toBe('none')
    expect(orbitDragState(fakeControls(ORBIT_STATE.ROTATE))).toBe('rotate')
    expect(orbitDragState(fakeControls(ORBIT_STATE.PAN))).toBe('pan')
    expect(orbitDragState(fakeControls(ORBIT_STATE.DOLLY))).toBe('dolly')
    expect(orbitDragState(fakeControls(5))).toBe('other')
  })

  it('reports unsupported for an object without the private surface', () => {
    expect(orbitDragState({} as unknown as OrbitControls)).toBe('unsupported')
  })
})

describe('baseBindingFor / desiredDragState', () => {
  it('middle is always orbit, right always pan', () => {
    expect(baseBindingFor(1, null)).toBe('rotate')
    expect(baseBindingFor(2, null)).toBe('pan')
    expect(baseBindingFor(1, MOUSE.PAN)).toBe('rotate')
  })

  it('left follows the live LEFT binding: Orbit → rotate, Pan → pan, otherwise nothing', () => {
    expect(baseBindingFor(0, MOUSE.ROTATE)).toBe('rotate')
    expect(baseBindingFor(0, MOUSE.PAN)).toBe('pan')
    expect(baseBindingFor(0, MOUSE.DOLLY)).toBe(null)
    expect(baseBindingFor(0, null)).toBe(null)
    expect(baseBindingFor(0, undefined)).toBe(null)
  })

  it('other buttons start no switchable drag', () => {
    expect(baseBindingFor(3, MOUSE.ROTATE)).toBe(null)
  })

  it('Shift inverts the base, in both directions', () => {
    expect(desiredDragState('rotate', false)).toBe('rotate')
    expect(desiredDragState('rotate', true)).toBe('pan')
    expect(desiredDragState('pan', false)).toBe('pan')
    expect(desiredDragState('pan', true)).toBe('rotate')
  })
})

describe('switchDragTo', () => {
  it('flips a live rotate into a pan seeded at the pointer and drops the orbit tail', () => {
    const c = fakeControls(ORBIT_STATE.ROTATE)
    expect(switchDragTo(c, 'pan', 40, 50)).toBe(true)
    expect(c.state).toBe(ORBIT_STATE.PAN)
    expect(c._panStart.x).toBe(40)
    expect(c._panStart.y).toBe(50)
    expect(c._sphericalDelta.theta).toBe(0)
    expect(c._sphericalDelta.phi).toBe(0)
    // The pan's own pending offset is untouched — there was none from this gesture.
    expect(c._panOffset.x).toBe(1)
  })

  it('refuses to switch anything but a rotate drag to a pan', () => {
    for (const s of [ORBIT_STATE.NONE, ORBIT_STATE.PAN, ORBIT_STATE.DOLLY, 4]) {
      const c = fakeControls(s)
      expect(switchDragTo(c, 'pan', 1, 1)).toBe(false)
      expect(c.state).toBe(s)
      expect(c._panStart.x).toBe(-1)
    }
  })

  it('flips a live pan back into a rotate seeded at the pointer and drops the pan offset', () => {
    const c = fakeControls(ORBIT_STATE.PAN)
    expect(switchDragTo(c, 'rotate', 7, 8)).toBe(true)
    expect(c.state).toBe(ORBIT_STATE.ROTATE)
    expect(c._rotateStart.x).toBe(7)
    expect(c._rotateStart.y).toBe(8)
    expect(c._panOffset.length()).toBe(0)
  })

  it('refuses to switch anything but a pan drag to a rotate', () => {
    for (const s of [ORBIT_STATE.NONE, ORBIT_STATE.ROTATE, ORBIT_STATE.DOLLY]) {
      const c = fakeControls(s)
      expect(switchDragTo(c, 'rotate', 1, 1)).toBe(false)
      expect(c.state).toBe(s)
    }
  })

  it('is a no-op on an unsupported controls object', () => {
    expect(switchDragTo({} as unknown as OrbitControls, 'pan', 1, 1)).toBe(false)
  })
})

describe('precise orbit', () => {
  it('stopInertia zeroes both pending deltas', () => {
    const c = fakeControls(ORBIT_STATE.NONE)
    stopInertia(c)
    expect(c._sphericalDelta.theta).toBe(0)
    expect(c._sphericalDelta.phi).toBe(0)
    expect(c._panOffset.length()).toBe(0)
  })

  it('setPreciseOrbit(true) disables damping and stops the tail; (false) restores damping', () => {
    const c = fakeControls(ORBIT_STATE.ROTATE)
    setPreciseOrbit(c, true)
    expect(c.enableDamping).toBe(false)
    expect(c._sphericalDelta.theta).toBe(0)
    setPreciseOrbit(c, false)
    expect(c.enableDamping).toBe(true)
  })
})

describe('forceBaseAfterPress — Ctrl/⌘ means precise, only Shift inverts', () => {
  const press = (o: Partial<Parameters<typeof forceBaseAfterPress>[1]>) => ({
    button: 0, shiftKey: false, ctrlKey: false, metaKey: false, clientX: 11, clientY: 12, ...o,
  })

  it('left button under the Orbit tool with Ctrl or ⌘: the pan OrbitControls started becomes a rotate at the press point', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const c = fakeControls(ORBIT_STATE.PAN)
      expect(forceBaseAfterPress(c, press(mod), MOUSE.ROTATE)).toBe(true)
      expect(c.state).toBe(ORBIT_STATE.ROTATE)
      expect(c._rotateStart.x).toBe(11)
      expect(c._rotateStart.y).toBe(12)
    }
  })

  it('middle button with Ctrl/⌘ under any tool', () => {
    const c = fakeControls(ORBIT_STATE.PAN)
    expect(forceBaseAfterPress(c, press({ button: 1, ctrlKey: true }), null)).toBe(true)
    expect(c.state).toBe(ORBIT_STATE.ROTATE)
  })

  it('left button under the Pan tool with Ctrl/⌘: the inverted rotate goes back to a pan', () => {
    const c = fakeControls(ORBIT_STATE.ROTATE)
    expect(forceBaseAfterPress(c, press({ ctrlKey: true }), MOUSE.PAN)).toBe(true)
    expect(c.state).toBe(ORBIT_STATE.PAN)
  })

  it('left button when left starts no switchable drag (Select, Zoom) — never', () => {
    const c = fakeControls(ORBIT_STATE.PAN)
    expect(forceBaseAfterPress(c, press({ ctrlKey: true }), null)).toBe(false)
    expect(forceBaseAfterPress(c, press({ ctrlKey: true }), MOUSE.DOLLY)).toBe(false)
    expect(c.state).toBe(ORBIT_STATE.PAN)
  })

  it('Shift held (with or without Ctrl/⌘) is a real invert and is left alone', () => {
    const c = fakeControls(ORBIT_STATE.PAN)
    expect(forceBaseAfterPress(c, press({ shiftKey: true }), MOUSE.ROTATE)).toBe(false)
    expect(forceBaseAfterPress(c, press({ shiftKey: true, ctrlKey: true }), MOUSE.ROTATE)).toBe(false)
    expect(c.state).toBe(ORBIT_STATE.PAN)
  })

  it('no modifier — nothing to undo', () => {
    const c = fakeControls(ORBIT_STATE.ROTATE)
    expect(forceBaseAfterPress(c, press({}), MOUSE.ROTATE)).toBe(false)
  })
})
