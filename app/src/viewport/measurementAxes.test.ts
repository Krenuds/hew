import { describe, it, expect } from 'vitest'
import { measurementAxisFor, axisAriaLabel, AXIS_NAME } from './measurementAxes'
import { WORLD_DRAWING_AXES, type DrawingAxes } from '../tools/drawingAxes'

const W = WORLD_DRAWING_AXES

describe('measurementAxisFor', () => {
  it('names the three world axes', () => {
    expect(measurementAxisFor([1, 0, 0], W)).toBe(0)
    expect(measurementAxisFor([0, 1, 0], W)).toBe(1)
    expect(measurementAxisFor([0, 0, 1], W)).toBe(2)
  })

  // A tool resolves its dimensions from the anchored plane, before the cursor
  // has picked a side to grow toward. Matching either polarity is what makes
  // that possible — and what makes the dot stable for the whole gesture.
  it('is polarity-blind', () => {
    expect(measurementAxisFor([-1, 0, 0], W)).toBe(0)
    expect(measurementAxisFor([0, -1, 0], W)).toBe(1)
    expect(measurementAxisFor([0, 0, -1], W)).toBe(2)
  })

  it('does not require a normalized direction', () => {
    expect(measurementAxisFor([0, 12.5, 0], W)).toBe(1)
  })

  it('admits a direction within the 10° labeling tolerance and rejects one outside it', () => {
    const rad = (deg: number) => (deg * Math.PI) / 180
    expect(measurementAxisFor([Math.cos(rad(9)), Math.sin(rad(9)), 0], W)).toBe(0)
    expect(measurementAxisFor([Math.cos(rad(11)), Math.sin(rad(11)), 0], W)).toBeNull()
  })

  it('returns null for an oblique direction', () => {
    expect(measurementAxisFor([1, 1, 0], W)).toBeNull()
    expect(measurementAxisFor([1, 1, 1], W)).toBeNull()
  })

  it('returns null for a degenerate direction', () => {
    expect(measurementAxisFor([0, 0, 0], W)).toBeNull()
  })

  // The document's drawing axes can be moved, and red follows the frame's X
  // rather than the world's. A dot painted from the world frame would claim an
  // alignment the model does not have.
  it('matches the given frame, not the world', () => {
    // The frame turned 90° about Z: its X is world +Y, its Y is world −X.
    const turned: DrawingAxes = {
      origin: [0, 0, 0],
      x: [0, 1, 0],
      y: [-1, 0, 0],
      z: [0, 0, 1],
    }
    expect(measurementAxisFor([0, 1, 0], turned)).toBe(0)
    expect(measurementAxisFor([1, 0, 0], turned)).toBe(1)
  })
})

describe('axisAriaLabel', () => {
  it('names each axis the way the inference chip does', () => {
    expect(axisAriaLabel(0)).toBe('on red axis')
    expect(axisAriaLabel(1)).toBe('on green axis')
    expect(axisAriaLabel(2)).toBe('on blue axis')
  })

  it('says off axis for a dimension that runs along none', () => {
    expect(axisAriaLabel(null)).toBe('off axis')
  })

  it('covers every axis name', () => {
    expect(AXIS_NAME).toEqual(['red', 'green', 'blue'])
  })
})
