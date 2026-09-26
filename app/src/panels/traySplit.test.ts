import { describe, it, expect } from 'vitest'
import { DEFAULT_TRAY_SECTION_WEIGHTS, parseTraySectionWeights, splitPair } from './traySplit'

describe('splitPair', () => {
  it('moves weight toward the upper section on a downward drag and keeps the total', () => {
    const [a, b] = splitPair(1, 1, 200, 200, 100)
    expect(a + b).toBeCloseTo(2)
    expect(a / b).toBeCloseTo(300 / 100)
  })

  it('clamps so neither section drops below the minimum', () => {
    const [downA, downB] = splitPair(1, 3, 100, 300, 1000, 60)
    expect(downA / (downA + downB)).toBeCloseTo(340 / 400)
    const [upA, upB] = splitPair(1, 3, 100, 300, -1000, 60)
    expect(upA / (upA + upB)).toBeCloseTo(60 / 400)
  })

  it('leaves a pair with no height alone', () => {
    expect(splitPair(2, 5, 0, 0, 50)).toEqual([2, 5])
  })
})

describe('parseTraySectionWeights', () => {
  it('falls back to 1 for missing, bad, or non-positive entries', () => {
    expect(parseTraySectionWeights(null)).toEqual(DEFAULT_TRAY_SECTION_WEIGHTS)
    expect(parseTraySectionWeights('not json')).toEqual(DEFAULT_TRAY_SECTION_WEIGHTS)
    const w = parseTraySectionWeights(JSON.stringify({ modelInfo: 2.5, components: -1, tags: 'x', scenes: null }))
    expect(w).toEqual({ ...DEFAULT_TRAY_SECTION_WEIGHTS, modelInfo: 2.5 })
  })
})
