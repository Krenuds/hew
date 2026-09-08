import { describe, expect, it } from 'vitest'
import {
  NEAR_RATIO,
  ZOOM_FLOOR_RATIO,
  dynamicClipPlanes,
  groundHitIsUsable,
  targetAtDepth,
  zoomFloorFor,
} from './cameraDepth'
import { MOUNT_FIT_DISTANCE, MOUNT_LIMITS } from './math'

describe('zoomFloorFor', () => {
  it('is 1 mm at the mount-time world far', () => {
    expect(zoomFloorFor(MOUNT_LIMITS.far)).toBeCloseTo(0.001, 9)
    expect(ZOOM_FLOOR_RATIO).toBe(1e-5)
  })
})

describe('dynamicClipPlanes', () => {
  const world = { ...MOUNT_LIMITS, minDistance: zoomFloorFor(MOUNT_LIMITS.far) }

  it('reproduces the mount-time near at the mount-time fit distance (within the ratio rounding)', () => {
    const { near, far } = dynamicClipPlanes(MOUNT_FIT_DISTANCE, world)
    expect(near).toBeCloseTo(MOUNT_FIT_DISTANCE * NEAR_RATIO, 12)
    expect(near).toBeGreaterThan(0.009)
    expect(near).toBeLessThan(0.012)
    expect(far).toBe(world.far)
  })

  it('tracks the distance downward so a 5 cm detail gets a 0.1 mm near plane', () => {
    const { near, far } = dynamicClipPlanes(0.05, world)
    expect(near).toBeCloseTo(0.0001, 9)
    expect(far).toBe(world.far)
  })

  it('keeps far at the world far even when near sits on its floor (ratio bounded at 1e6)', () => {
    const { near, far } = dynamicClipPlanes(0.002, world)
    expect(near).toBeCloseTo(world.minDistance / 10, 12)
    expect(far).toBe(world.far)
    expect(far / near).toBeLessThanOrEqual(1e6 + 1e-6)
  })

  it('never lets near fall below a tenth of the floor nor rise above far/1000', () => {
    const low = dynamicClipPlanes(1e-9, world)
    expect(low.near).toBeCloseTo(world.minDistance / 10, 12)
    const high = dynamicClipPlanes(1e9, world)
    expect(high.near).toBeCloseTo(world.far / 1000, 12)
    expect(high.far).toBe(world.far)
  })

  it('falls back to the static world limits for a degenerate distance', () => {
    expect(dynamicClipPlanes(Number.NaN, world)).toEqual({ near: world.near, far: world.far })
    expect(dynamicClipPlanes(0, world)).toEqual({ near: world.near, far: world.far })
    expect(dynamicClipPlanes(-1, world)).toEqual({ near: world.near, far: world.far })
  })

  it('scales with the world far the way the rest of the view state does', () => {
    const big = { near: 0.1, far: 1000, minDistance: zoomFloorFor(1000) }
    const { near } = dynamicClipPlanes(52.4, big)
    expect(near).toBeCloseTo(52.4 * NEAR_RATIO, 12)
    expect(zoomFloorFor(1000)).toBeCloseTo(0.01, 12)
  })
})

describe('targetAtDepth', () => {
  const eye = [0, -10, 0] as const
  const view = [0, 1, 0] as const

  it('projects the hit onto the view axis without moving the eye', () => {
    // A hit 3 units off-axis at depth 7 → target straight ahead at depth 7.
    const t = targetAtDepth(eye, view, [3, -3, 2], 0.001)
    expect(t).not.toBeNull()
    expect(t![0]).toBeCloseTo(0, 12)
    expect(t![1]).toBeCloseTo(-3, 12)
    expect(t![2]).toBeCloseTo(0, 12)
  })

  it('floors the depth at minDistance', () => {
    const t = targetAtDepth(eye, view, [0, -9.9999, 0], 0.01)
    expect(t![1]).toBeCloseTo(-9.99, 12)
  })

  it('refuses a hit behind the camera', () => {
    expect(targetAtDepth(eye, view, [0, -12, 0], 0.001)).toBeNull()
    expect(targetAtDepth(eye, view, [0, -10, 0], 0.001)).toBeNull()
  })
})

describe('groundHitIsUsable', () => {
  it('accepts a ground hit within 4× the current distance and rejects a grazing one', () => {
    expect(groundHitIsUsable(12, 5)).toBe(true)
    expect(groundHitIsUsable(20, 5)).toBe(true)
    expect(groundHitIsUsable(20.01, 5)).toBe(false)
    expect(groundHitIsUsable(500, 5)).toBe(false)
    expect(groundHitIsUsable(-1, 5)).toBe(false)
    expect(groundHitIsUsable(Number.POSITIVE_INFINITY, 5)).toBe(false)
  })
})
