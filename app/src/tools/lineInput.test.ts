import { describe, it, expect } from 'vitest'
import { segmentLength, directionBetween, crossV3, dotV3, rehomePlaneNormal, fromPointCandidate, type V3 } from './lineInput'

/** The ground plane's own orthonormal basis — origin at world zero, u = red
 *  (X), v = green (Y) — used by every `fromPointCandidate` test below. */
const GROUND_ORIGIN: V3 = [0, 0, 0]
const U: V3 = [1, 0, 0]
const V: V3 = [0, 1, 0]

describe('segmentLength', () => {
  it('computes Euclidean distance in 3D', () => {
    expect(segmentLength([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 9)
    expect(segmentLength([1, 1, 1], [1, 1, 1])).toBe(0)
    expect(segmentLength([0, 0, 0], [1, 2, 2])).toBeCloseTo(3, 9)
  })

  it('is symmetric', () => {
    const a: [number, number, number] = [1, 2, 3]
    const b: [number, number, number] = [4, 0, -1]
    expect(segmentLength(a, b)).toBeCloseTo(segmentLength(b, a), 9)
  })
})

describe('directionBetween', () => {
  it('returns the unit vector from a to b', () => {
    const dir = directionBetween([0, 0, 0], [5, 0, 0])
    expect(dir).not.toBeNull()
    expect(dir![0]).toBeCloseTo(1, 9)
    expect(dir![1]).toBeCloseTo(0, 9)
    expect(dir![2]).toBeCloseTo(0, 9)
  })

  it('normalizes a diagonal vector', () => {
    const dir = directionBetween([0, 0, 0], [1, 1, 0])
    expect(dir).not.toBeNull()
    const len = Math.hypot(dir![0], dir![1], dir![2])
    expect(len).toBeCloseTo(1, 9)
    expect(dir![0]).toBeCloseTo(Math.SQRT1_2, 9)
    expect(dir![1]).toBeCloseTo(Math.SQRT1_2, 9)
  })

  it('returns null for coincident points', () => {
    expect(directionBetween([1, 2, 3], [1, 2, 3])).toBeNull()
  })

  it('returns null when points are within epsilon', () => {
    expect(directionBetween([0, 0, 0], [1e-10, 0, 0])).toBeNull()
  })

  it('respects a custom epsilon', () => {
    expect(directionBetween([0, 0, 0], [0.5, 0, 0], 1)).toBeNull()
    expect(directionBetween([0, 0, 0], [2, 0, 0], 1)).not.toBeNull()
  })
})

describe('crossV3', () => {
  it('X × Y = Z (right-handed)', () => {
    expect(crossV3([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
  })

  it('Y × Z = X', () => {
    expect(crossV3([0, 1, 0], [0, 0, 1])).toEqual([1, 0, 0])
  })

  it('is anticommutative', () => {
    const a: V3 = [1, 2, 3]
    const b: V3 = [4, -1, 2]
    const ab = crossV3(a, b)
    const ba = crossV3(b, a)
    expect(ba).toEqual([-ab[0], -ab[1], -ab[2]])
  })

  it('is zero for parallel vectors', () => {
    expect(crossV3([2, 0, 0], [5, 0, 0])).toEqual([0, 0, 0])
  })
})

describe('dotV3', () => {
  it('computes the dot product', () => {
    expect(dotV3([1, 2, 3], [4, 5, 6])).toBe(1 * 4 + 2 * 5 + 3 * 6)
  })

  it('is zero for perpendicular vectors', () => {
    expect(dotV3([1, 0, 0], [0, 1, 0])).toBe(0)
  })
})

/** Unit-length check with a generous tolerance for the arithmetic below. */
function expectUnit(v: V3): void {
  expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 9)
}

describe('rehomePlaneNormal', () => {
  it('spans the previous and new segment directions when they are not parallel', () => {
    const segDir: V3 = [1, 0, 0]
    const prevDir: V3 = [0, 0, 1]
    const normal = rehomePlaneNormal(segDir, prevDir, [0, -1, 0])
    expectUnit(normal)
    // The plane must contain BOTH directions — normal is perpendicular to each.
    expect(dotV3(normal, segDir)).toBeCloseTo(0, 9)
    expect(dotV3(normal, prevDir)).toBeCloseTo(0, 9)
    // The exact cross-product order this implementation uses.
    expect(normal).toEqual(crossV3(prevDir, segDir))
  })

  it('falls back to the view-facing plane when there is no previous segment', () => {
    const segDir: V3 = [0, 1, 0]
    const viewDir: V3 = [0, 0, -1] // looking straight down −Z
    const normal = rehomePlaneNormal(segDir, null, viewDir)
    expectUnit(normal)
    expect(dotV3(normal, segDir)).toBeCloseTo(0, 9)
    // normal is the (normalized) rejection of viewDir from segDir — since
    // viewDir is already ⊥ segDir here, normal is exactly viewDir.
    expect(normal[0]).toBeCloseTo(viewDir[0], 9)
    expect(normal[1]).toBeCloseTo(viewDir[1], 9)
    expect(normal[2]).toBeCloseTo(viewDir[2], 9)
  })

  it('falls back to the view-facing plane when the previous segment is parallel to the new one', () => {
    const segDir: V3 = [1, 0, 0]
    const prevDir: V3 = [-1, 0, 0] // parallel (opposite sign) — no plane spanned
    const viewDir: V3 = [0, 1, 0]
    const normal = rehomePlaneNormal(segDir, prevDir, viewDir)
    expectUnit(normal)
    expect(dotV3(normal, segDir)).toBeCloseTo(0, 9)
    // Falls all the way through to the view-facing branch, not the (unusable) span.
    expect(normal[0]).toBeCloseTo(0, 9)
    expect(normal[1]).toBeCloseTo(1, 9)
    expect(normal[2]).toBeCloseTo(0, 9)
  })

  it('the view-facing rejection removes exactly the along-segment component of viewDir', () => {
    const segDir: V3 = [1, 0, 0]
    const viewDir: V3 = [0.5, 0.5, 0] // 45°, half along the locked line
    const normal = rehomePlaneNormal(segDir, null, viewDir)
    expectUnit(normal)
    expect(dotV3(normal, segDir)).toBeCloseTo(0, 9)
    // viewDir rejected from X leaves only its Y component, normalized.
    expect(normal[0]).toBeCloseTo(0, 9)
    expect(normal[1]).toBeCloseTo(1, 9)
    expect(normal[2]).toBeCloseTo(0, 9)
  })

  it('never degenerates even when BOTH the previous segment and the view direction are parallel to the new segment', () => {
    const segDir: V3 = [1, 0, 0]
    const prevDir: V3 = [1, 0, 0] // parallel
    const viewDir: V3 = [-1, 0, 0] // ALSO parallel (camera sighting straight down the line)
    const normal = rehomePlaneNormal(segDir, prevDir, viewDir)
    expectUnit(normal)
    expect(Number.isFinite(normal[0])).toBe(true)
    expect(Number.isFinite(normal[1])).toBe(true)
    expect(Number.isFinite(normal[2])).toBe(true)
    expect(dotV3(normal, segDir)).toBeCloseTo(0, 9)
  })

  it('is deterministic (same inputs, same output) — no hidden randomness in the degenerate fallback', () => {
    const segDir: V3 = [0, 0, 1]
    const normal1 = rehomePlaneNormal(segDir, segDir, segDir)
    const normal2 = rehomePlaneNormal(segDir, segDir, segDir)
    expect(normal1).toEqual(normal2)
  })

  it('near-parallel (but not EXACTLY parallel) previous/new directions route to the stable view-facing fallback, not the numerically ill-conditioned cross-product plane (playtest-2 review finding C)', () => {
    const prevDir: V3 = [1, 0, 0]
    // Two "continue nearly straight ahead" directions — about 0.006° off
    // parallel, an angle no user could deliberately aim for — that differ
    // only in WHICH axis the tiny deviation happens to land on (Y vs Z).
    // That axis is not a meaningful design choice; it is exactly the kind
    // of imperceptible difference ordinary pixel/inference imprecision
    // produces.
    const segDirA = directionBetween([0, 0, 0], [1, 1e-4, 0]) as V3
    const segDirB = directionBetween([0, 0, 0], [1, 0, 1e-4]) as V3
    const viewDir: V3 = [0, 0, -1]

    const normalA = rehomePlaneNormal(segDirA, prevDir, viewDir)
    const normalB = rehomePlaneNormal(segDirB, prevDir, viewDir)

    // The re-homed plane must not swing wildly (here: all the way to
    // ORTHOGONAL, dot ~ 0) between two inputs that are, for any practical
    // purpose, the same "continue straight" gesture.
    expect(dotV3(normalA, normalB)).toBeGreaterThan(0.9)
  })
})

describe('fromPointCandidate', () => {
  // The classic SketchUp square-close: A(0,0,0) -> B(0,2,0) [green, +Y] ->
  // C(2,2,0) [red, +X], now heading back from C toward A along green (-Y).
  // The closing point is (2,0,0): where the current (locked) segment meets
  // the line through A along red.
  const A: V3 = [0, 0, 0]

  it('locked: intersects the current segment ray with the line through p', () => {
    const segStart: V3 = [2, 2, 0] // C
    const cursor: V3 = [2, 1, 0] // heading toward -Y, not there yet
    const lockDir: V3 = [0, -1, 0] // locked toward -Y
    const axisDir: V3 = [1, 0, 0] // red, through A
    const candidate = fromPointCandidate(A, axisDir, segStart, cursor, lockDir, GROUND_ORIGIN, U, V)
    expect(candidate).not.toBeNull()
    expect(candidate![0]).toBeCloseTo(2, 9)
    expect(candidate![1]).toBeCloseTo(0, 9)
    expect(candidate![2]).toBeCloseTo(0, 9)
  })

  it('locked: rejects a candidate behind segStart (s <= 0)', () => {
    const segStart: V3 = [2, 2, 0]
    const cursor: V3 = [2, 3, 0] // heading the WRONG way (+Y, away from A's line)
    const lockDir: V3 = [0, 1, 0]
    const axisDir: V3 = [1, 0, 0]
    expect(fromPointCandidate(A, axisDir, segStart, cursor, lockDir, GROUND_ORIGIN, U, V)).toBeNull()
  })

  it('locked: rejects parallel lines (no unique intersection)', () => {
    const segStart: V3 = [2, 2, 0]
    const cursor: V3 = [2, 1, 0]
    const lockDir: V3 = [0, -1, 0]
    const axisDir: V3 = [0, 1, 0] // parallel to lockDir
    expect(fromPointCandidate(A, axisDir, segStart, cursor, lockDir, GROUND_ORIGIN, U, V)).toBeNull()
  })

  it('unlocked: the foot of the perpendicular from the cursor onto the line', () => {
    const segStart: V3 = [2, 2, 0]
    // p = A = (0,0,0), axisDir = Y (the line x=0): the foot of the
    // perpendicular from any cursor is (0, cursor.y, 0).
    const cursor: V3 = [2.1, 0.3, 0]
    const axisDir: V3 = [0, 1, 0]
    const candidate = fromPointCandidate(A, axisDir, segStart, cursor, null, GROUND_ORIGIN, U, V)
    expect(candidate).not.toBeNull()
    expect(candidate![0]).toBeCloseTo(0, 9)
    expect(candidate![1]).toBeCloseTo(0.3, 9)
    expect(candidate![2]).toBeCloseTo(0, 9)
  })

  it('rejects an axis direction with no usable in-plane component', () => {
    // The plane basis here is the ground plane (u=X, v=Y); an axisDir along
    // the plane's own NORMAL (Z) projects to zero in-plane and must be
    // rejected — the same treatment as a literally parallel line.
    const segStart: V3 = [2, 2, 0]
    const cursor: V3 = [2, 1, 0]
    const lockDir: V3 = [0, -1, 0]
    const axisDir: V3 = [0, 0, 1] // blue, perpendicular to the ground plane
    expect(fromPointCandidate(A, axisDir, segStart, cursor, lockDir, GROUND_ORIGIN, U, V)).toBeNull()
  })

  it('rejects an earlier vertex that is not on the current plane (a chain that re-homed after two segments)', () => {
    // A(0,0,0) -> B(1,0,0) -> C(1,1,0) on the ground, then C -> D straight
    // up re-homes the chain onto the plane x = 1. A is a metre off that
    // plane; its shadow must not be offered as a closing point.
    const origin: V3 = [1, 1, 0]
    const u: V3 = [0, 0, 1]
    const v: V3 = [0, -1, 0]
    const segStart: V3 = [1, 1, 1] // D
    const cursor: V3 = [1, 0.5, 1]
    expect(fromPointCandidate(A, [0, 1, 0], segStart, cursor, null, origin, u, v)).toBeNull()
    // B is on x = 1 and does qualify.
    expect(fromPointCandidate([1, 0, 0], [0, 0, 1], segStart, cursor, null, origin, u, v)).not.toBeNull()
  })

  it('rejects a lock or axis direction that leaves the plane', () => {
    // A tilted plane through the origin with normal (1,0,1)/sqrt2: the blue
    // axis is oblique to it, so a segment locked to blue leaves the plane
    // and the line through p along red does not lie in it either.
    const s = Math.SQRT1_2
    const u: V3 = [0, 1, 0]
    const v: V3 = [-s, 0, s]
    const segStart: V3 = [-1, 1, 1] // on the plane: x + z = 0
    const cursor: V3 = [-1, 0.5, 1]
    expect(fromPointCandidate(A, [0, 1, 0], segStart, cursor, [0, 0, 1], GROUND_ORIGIN, u, v)).toBeNull()
    expect(fromPointCandidate(A, [1, 0, 0], segStart, cursor, null, GROUND_ORIGIN, u, v)).toBeNull()
    // The same query with an in-plane lock (toward -Y) against the in-plane
    // line through A along v has a real intersection at (-1, 0, 1).
    const hit = fromPointCandidate(A, v, segStart, cursor, [0, -1, 0], GROUND_ORIGIN, u, v)
    expect(hit).not.toBeNull()
    expect(hit![0]).toBeCloseTo(-1, 9)
    expect(hit![1]).toBeCloseTo(0, 9)
    expect(hit![2]).toBeCloseTo(1, 9)
  })

  it('works on a non-ground plane via its own (u, v) basis', () => {
    // A vertical plane: origin (0,0,0), u = X, v = Z (so "up" in this
    // plane's 2D coordinates is world Z). A = (0,0,0); segment locked along
    // v (world Z) from segStart (2,0,2), heading down (-Z); axisDir = u
    // (world X) through A. Expected closing point: (2, 0, 0).
    const planeU: V3 = [1, 0, 0]
    const planeV: V3 = [0, 0, 1]
    const origin: V3 = [0, 0, 0]
    const segStart: V3 = [2, 0, 2]
    const cursor: V3 = [2, 0, 1]
    const lockDir: V3 = [0, 0, -1]
    const axisDir: V3 = [1, 0, 0]
    const candidate = fromPointCandidate(A, axisDir, segStart, cursor, lockDir, origin, planeU, planeV)
    expect(candidate).not.toBeNull()
    expect(candidate![0]).toBeCloseTo(2, 9)
    expect(candidate![1]).toBeCloseTo(0, 9)
    expect(candidate![2]).toBeCloseTo(0, 9)
  })
})
