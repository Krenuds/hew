import { describe, expect, it } from 'vitest'
import { formatRelativeTime, nextRelativeTimeBoundary } from './relativeTime'

const AT = 1_000_000_000

/** The defining property `nextRelativeTimeBoundary` must hold: the label is
 * unchanged for every ms up to (but not including) the boundary, and
 * DIFFERENT at the boundary itself. */
function expectExactBoundary(now: number): void {
  const before = formatRelativeTime(AT, now)
  const boundary = nextRelativeTimeBoundary(AT, now)
  expect(boundary).not.toBeNull()
  const b = boundary as number
  expect(formatRelativeTime(AT, b - 1)).toBe(before)
  expect(formatRelativeTime(AT, b)).not.toBe(before)
}

describe('nextRelativeTimeBoundary', () => {
  it('"just now" boundary is at 45s', () => {
    expect(nextRelativeTimeBoundary(AT, AT)).toBe(AT + 45_000)
    expectExactBoundary(AT)
    expectExactBoundary(AT + 20_000)
  })

  it('minute buckets change at the rounded half-minute', () => {
    expectExactBoundary(AT + 45_000) // just crossed into "1 minute ago"
    expectExactBoundary(AT + 90_000) // "2 minutes ago" territory
    expectExactBoundary(AT + 30 * 60_000) // "30 minutes ago"
  })

  it('hour buckets change at the rounded half-hour', () => {
    expectExactBoundary(AT + 3600_000) // "1 hour ago"
    expectExactBoundary(AT + 5 * 3600_000) // "5 hours ago"
  })

  it('returns null once the label has settled on a fixed date string (24h+)', () => {
    expect(nextRelativeTimeBoundary(AT, AT + 25 * 3600_000)).toBeNull()
  })

  it('is always strictly in the future relative to `now` (never a spin loop)', () => {
    for (const now of [AT, AT + 44_000, AT + 45_000, AT + 3_599_000, AT + 3600_000, AT + 23 * 3600_000]) {
      const boundary = nextRelativeTimeBoundary(AT, now)
      expect(boundary).not.toBeNull()
      expect(boundary as number).toBeGreaterThan(now)
    }
  })
})
