import { describe, it, expect } from 'vitest'
import {
  beginViewCubeDrag,
  updateViewCubeDrag,
  endViewCubeDrag,
  VIEW_CUBE_DRAG_THRESHOLD_PX,
  VIEW_CUBE_DRAG_GAIN,
} from './viewCubeDrag'
import { DRAG_MOVE_THRESHOLD_PX } from './dragMove'

const H = 800

describe('click vs drag', () => {
  it('uses the same threshold as every other viewport drag gesture', () => {
    expect(VIEW_CUBE_DRAG_THRESHOLD_PX).toBe(DRAG_MOVE_THRESHOLD_PX)
  })

  it('treats a press with no movement as a click', () => {
    const s = beginViewCubeDrag(100, 100)
    expect(endViewCubeDrag(s).click).toBe(true)
  })

  it('treats a jiggle under the threshold as a click, and orbits nothing', () => {
    let s = beginViewCubeDrag(100, 100)
    for (const [x, y] of [[101, 100], [102, 101], [103, 102]]) {
      const r = updateViewCubeDrag(s, x, y, H)
      expect(r.orbit).toBeNull()
      s = r.state
    }
    expect(s.dragging).toBe(false)
    expect(endViewCubeDrag(s).click).toBe(true)
  })

  it('becomes an orbit exactly at the threshold', () => {
    const s = beginViewCubeDrag(0, 0)
    expect(updateViewCubeDrag(s, VIEW_CUBE_DRAG_THRESHOLD_PX - 1, 0, H).orbit).toBeNull()
    expect(updateViewCubeDrag(s, VIEW_CUBE_DRAG_THRESHOLD_PX, 0, H).orbit).not.toBeNull()
  })

  it('stays a drag once it is one, even if the pointer comes back to the press', () => {
    let s = beginViewCubeDrag(100, 100)
    s = updateViewCubeDrag(s, 140, 100, H).state
    s = updateViewCubeDrag(s, 100, 100, H).state
    expect(s.dragging).toBe(true)
    expect(endViewCubeDrag(s).click).toBe(false)
  })
})

describe('pixel to radian — OrbitControls parity', () => {
  it('matches OrbitControls exactly: 2pi * dx / viewport HEIGHT', () => {
    const s = beginViewCubeDrag(0, 0)
    const { orbit } = updateViewCubeDrag(s, 10, 0, H)
    expect(orbit!.deltaTheta).toBe((2 * Math.PI * 10) / H)
    expect(orbit!.deltaPhi).toBe(0)
  })

  it('uses height for the VERTICAL axis too — three.js does, deliberately', () => {
    const s = beginViewCubeDrag(0, 0)
    const { orbit } = updateViewCubeDrag(s, 0, 10, H)
    expect(orbit!.deltaPhi).toBe((2 * Math.PI * 10) / H)
    expect(orbit!.deltaTheta).toBe(0)
  })

  it('is width-independent: the same drag on a wider viewport of equal height turns the same amount', () => {
    const a = updateViewCubeDrag(beginViewCubeDrag(0, 0), 30, 0, H).orbit
    const b = updateViewCubeDrag(beginViewCubeDrag(0, 0), 30, 0, H).orbit
    expect(a).toEqual(b)
  })

  it('turns a 100px drag on an 800px viewport through 45 degrees', () => {
    const { orbit } = updateViewCubeDrag(beginViewCubeDrag(0, 0), 100, 0, 800)
    expect((orbit!.deltaTheta * 180) / Math.PI).toBeCloseTo(45, 9)
  })

  it('passes signs straight through, so the cube follows the hand', () => {
    const right = updateViewCubeDrag(beginViewCubeDrag(0, 0), 20, 0, H).orbit!
    const left = updateViewCubeDrag(beginViewCubeDrag(0, 0), -20, 0, H).orbit!
    expect(right.deltaTheta).toBeGreaterThan(0)
    expect(left.deltaTheta).toBe(-right.deltaTheta)
  })

  it('ships at true 1:1 with a viewport middle-drag', () => {
    expect(VIEW_CUBE_DRAG_GAIN).toBe(1)
  })
})

describe('incremental deltas', () => {
  it('emits the travel since the PRESS on the frame it crosses the threshold, dropping nothing', () => {
    // A flick that clears the threshold in one event must still count all 40px.
    const { orbit } = updateViewCubeDrag(beginViewCubeDrag(0, 0), 40, 0, H)
    expect(orbit!.deltaTheta).toBe((2 * Math.PI * 40) / H)
  })

  it('emits the travel since the PREVIOUS sample once dragging', () => {
    let s = beginViewCubeDrag(0, 0)
    s = updateViewCubeDrag(s, 40, 0, H).state
    const { orbit } = updateViewCubeDrag(s, 50, 0, H)
    expect(orbit!.deltaTheta).toBe((2 * Math.PI * 10) / H)
  })

  it('sums to the same total however finely the pointer is sampled', () => {
    const oneJump = updateViewCubeDrag(beginViewCubeDrag(0, 0), 90, 60, H).orbit!

    let s = beginViewCubeDrag(0, 0)
    let theta = 0
    let phi = 0
    for (let i = 1; i <= 9; i++) {
      const r = updateViewCubeDrag(s, i * 10, i * (60 / 9), H)
      s = r.state
      if (r.orbit !== null) {
        theta += r.orbit.deltaTheta
        phi += r.orbit.deltaPhi
      }
    }
    expect(theta).toBeCloseTo(oneJump.deltaTheta, 12)
    expect(phi).toBeCloseTo(oneJump.deltaPhi, 12)
  })

  it('does not drop the sub-threshold travel when the crossing happens late', () => {
    // Two samples inside the threshold, then one that clears it: the emitted
    // delta must be the whole 20px, not just the last hop.
    let s = beginViewCubeDrag(0, 0)
    s = updateViewCubeDrag(s, 2, 0, H).state
    s = updateViewCubeDrag(s, 4, 0, H).state
    const { orbit } = updateViewCubeDrag(s, 20, 0, H)
    expect(orbit!.deltaTheta).toBe((2 * Math.PI * 20) / H)
  })
})

describe('degenerate input', () => {
  it('floors a zero viewport height instead of sending the camera to Infinity', () => {
    const { orbit } = updateViewCubeDrag(beginViewCubeDrag(0, 0), 10, 0, 0)
    expect(Number.isFinite(orbit!.deltaTheta)).toBe(true)
    expect(Number.isFinite(orbit!.deltaPhi)).toBe(true)
  })

  it('floors a negative viewport height the same way', () => {
    const { orbit } = updateViewCubeDrag(beginViewCubeDrag(0, 0), 10, 0, -5)
    expect(Number.isFinite(orbit!.deltaTheta)).toBe(true)
  })
})
