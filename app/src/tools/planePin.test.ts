import { describe, it, expect } from 'vitest'
import { PlanePin } from './planePin'
import { groundDrawPlane, drawPlaneThrough } from './drawPlane'
import type { DrawPlane } from './drawPlane'
import type { EditContext } from './types'
import type { V3 } from '../viewport/geoHelpers'

const TOP: EditContext = { kind: 'top' }
const INSTANCE: EditContext = { kind: 'instance', id: 42n, component: 5n }

const PLANE_A = groundDrawPlane()
// A genuinely non-ground plane (z = 1, normal +Z) — distinct from PLANE_A so
// tests can tell which one a pin actually holds.
const PLANE_B = drawPlaneThrough([0, 0, 1], [0, 0, 1]) as DrawPlane
const THROUGH_A: V3 = [1, 2, 0]
const THROUGH_B: V3 = [5, 6, 1]

describe('PlanePin — unpinned', () => {
  it('current, clickTarget, and constraint are all null before any pin', () => {
    const pin = new PlanePin()
    expect(pin.current).toBeNull()
    expect(pin.clickTarget(TOP)).toBeNull()
    expect(pin.constraint()).toBeNull()
  })

  it('a Shift press with no tracked hover does nothing (nothing to pin)', () => {
    const pin = new PlanePin()
    expect(pin.setShiftHeld(true)).toBe(false)
    expect(pin.current).toBeNull()
  })
})

describe('PlanePin — toggle', () => {
  it('trackHover then Shift pins the hovered plane, reported as changed', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_A, THROUGH_A)
    expect(pin.setShiftHeld(true)).toBe(true)
    expect(pin.current).toEqual({ plane: PLANE_A, through: THROUGH_A })
  })

  it('a second Shift press (after a release) unpins, reported as changed', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_A, THROUGH_A)
    pin.setShiftHeld(true)
    expect(pin.current).not.toBeNull()

    pin.setShiftHeld(false) // physical key-up
    expect(pin.setShiftHeld(true)).toBe(true) // second physical press: releases
    expect(pin.current).toBeNull()
  })
})

describe('PlanePin — keydown-autorepeat guard', () => {
  it('repeated true calls without an intervening false do not toggle again', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_A, THROUGH_A)
    expect(pin.setShiftHeld(true)).toBe(true) // pins
    expect(pin.setShiftHeld(true)).toBe(false) // autorepeat — no-op
    expect(pin.setShiftHeld(true)).toBe(false) // autorepeat — no-op
    expect(pin.current).toEqual({ plane: PLANE_A, through: THROUGH_A }) // still pinned, unchanged
  })

  it('a false call always clears the guard, even redundantly', () => {
    const pin = new PlanePin()
    expect(pin.setShiftHeld(false)).toBe(false) // no-op, but harmless
    pin.trackHover(PLANE_A, THROUGH_A)
    expect(pin.setShiftHeld(true)).toBe(true)
  })
})

describe('PlanePin — trackHover while pinned', () => {
  it('is ignored: the pin IS the plane, so a later hover never displaces it', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_A, THROUGH_A)
    pin.setShiftHeld(true)
    expect(pin.current).toEqual({ plane: PLANE_A, through: THROUGH_A })

    pin.trackHover(PLANE_B, THROUGH_B) // ignored while pinned
    expect(pin.current).toEqual({ plane: PLANE_A, through: THROUGH_A })
  })

  it('releasing the pin never re-pins the stale hover it had before pinning', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_A, THROUGH_A)
    pin.setShiftHeld(true) // pins A
    pin.trackHover(PLANE_B, THROUGH_B) // ignored — ineffective while pinned

    pin.setShiftHeld(false)
    pin.setShiftHeld(true) // releases — hover is cleared alongside the pin
    expect(pin.current).toBeNull()

    // A further press with no fresh hover pins nothing.
    pin.setShiftHeld(false)
    expect(pin.setShiftHeld(true)).toBe(false)
    expect(pin.current).toBeNull()
  })
})

describe('PlanePin — clear', () => {
  it('drops the pin (Escape / an arrow lock / cancel()) without touching the Shift-down guard', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_A, THROUGH_A)
    pin.setShiftHeld(true) // pins, and leaves shiftDown = true
    expect(pin.current).not.toBeNull()

    pin.clear()
    expect(pin.current).toBeNull()
    expect(pin.clickTarget(TOP)).toBeNull()
    expect(pin.constraint()).toBeNull()

    // The guard is untouched by clear(): shiftDown is still true from the
    // earlier press, so a same-physical-press repeat is still a no-op —
    // a release must arrive before Shift can pin anything again.
    expect(pin.setShiftHeld(true)).toBe(false)
    expect(pin.current).toBeNull()
  })
})

describe('PlanePin — clickTarget', () => {
  it('null when unpinned, regardless of edit context', () => {
    const pin = new PlanePin()
    expect(pin.clickTarget(TOP)).toBeNull()
    expect(pin.clickTarget(INSTANCE)).toBeNull()
  })

  it('a top-level pin targets the plane with a null instance', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_B, THROUGH_B)
    pin.setShiftHeld(true)
    expect(pin.clickTarget(TOP)).toEqual({
      plane: PLANE_B,
      target: { kind: 'plane', plane: PLANE_B, instance: null },
    })
  })

  it('a pin while inside a component instance namespaces the target to it', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_B, THROUGH_B)
    pin.setShiftHeld(true)
    expect(pin.clickTarget(INSTANCE)).toEqual({
      plane: PLANE_B,
      target: { kind: 'plane', plane: PLANE_B, instance: 42n },
    })
  })
})

describe('PlanePin — constraint', () => {
  it('null when unpinned', () => {
    const pin = new PlanePin()
    expect(pin.constraint()).toBeNull()
  })

  it('a pin constrains to the plane\'s own point and normal', () => {
    const pin = new PlanePin()
    pin.trackHover(PLANE_B, THROUGH_B)
    pin.setShiftHeld(true)
    expect(pin.constraint()).toEqual({
      constraintPlane: { point: PLANE_B.origin, normal: PLANE_B.normal },
    })
  })
})
