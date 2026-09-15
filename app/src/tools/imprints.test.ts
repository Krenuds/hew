/**
 * imprints — the app-side counterpart to the kernel's `face_features` query
 * (see the module doc comment in imprints.ts). Pins the JSON parsing
 * contract (including "never throw on one odd entry"), the selection ref
 * mint/round-trip, the chord matching helpers, the line-work derivation
 * (closed loop vs. open path, posed vs. unposed), and the display-name
 * heuristics (circle / rectangle / generic shape / chord).
 */
import { describe, it, expect } from 'vitest'
import {
  parseFaceFeatures,
  readImprints,
  imprintRef,
  isImprintRef,
  findImprint,
  subFaceImprint,
  chordThroughSegment,
  chordNearPoint,
  imprintSegments,
  imprintFace,
  imprintName,
  imprintNodes,
  type ImprintFeature,
  type SubFaceImprint,
  type ChordImprint,
} from './imprints'
import { nodeKey } from '../panels/treeModel'

// ---------------------------------------------------------------------------
// parseFaceFeatures
// ---------------------------------------------------------------------------

describe('parseFaceFeatures', () => {
  it('parses a sub_face entry with a curve', () => {
    const json = JSON.stringify([
      {
        kind: 'sub_face',
        face: 10,
        parent: 1,
        loop: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        curve: [0.5, 0.5, 0, 0.5],
        nested: [],
      },
    ])
    const out = parseFaceFeatures(json)
    expect(out).toHaveLength(1)
    const f = out[0] as SubFaceImprint
    expect(f.kind).toBe('sub_face')
    expect(f.face).toBe(10n)
    expect(f.parent).toBe(1n)
    expect(f.loop).toEqual([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])
    expect(f.curve).toEqual({ center: [0.5, 0.5, 0], radius: 0.5 })
    expect(f.nested).toEqual([])
  })

  it('parses a sub_face entry with curve: null and non-empty nested', () => {
    const json = JSON.stringify([
      {
        kind: 'sub_face',
        face: 10,
        parent: 1,
        loop: [0, 0, 0, 1, 0, 0, 1, 1, 0],
        curve: null,
        nested: [11, 12],
      },
    ])
    const out = parseFaceFeatures(json)
    const f = out[0] as SubFaceImprint
    expect(f.curve).toBeNull()
    expect(f.nested).toEqual([11n, 12n])
  })

  it('parses a chord entry', () => {
    const json = JSON.stringify([
      { kind: 'chord', edge: 5, faces: [2, 3], path: [0, 0, 0, 1, 0, 0, 2, 0, 0] },
    ])
    const out = parseFaceFeatures(json)
    expect(out).toHaveLength(1)
    const f = out[0] as ChordImprint
    expect(f.kind).toBe('chord')
    expect(f.edge).toBe(5n)
    expect(f.faces).toEqual([2n, 3n])
    expect(f.path).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0]])
  })

  it('parses per-edge "curves" on a chord entry, mixing arc edges and plain lines', () => {
    const json = JSON.stringify([
      {
        kind: 'chord',
        edge: 5,
        faces: [2, 3],
        path: [0, 0, 0, 1, 0, 0, 2, 0, 0],
        curves: [[0.5, 0.5, 0, 0.5], null],
      },
    ])
    const f = parseFaceFeatures(json)[0] as ChordImprint
    expect(f.curves).toEqual([{ center: [0.5, 0.5, 0], radius: 0.5 }, null])
  })

  it('parses per-edge "curves" on a sub_face entry, and defaults to [] when absent', () => {
    const withCurves = JSON.stringify([
      {
        kind: 'sub_face',
        face: 10,
        parent: 1,
        loop: [0, 0, 0, 1, 0, 0, 1, 1, 0],
        curve: null,
        nested: [],
        curves: [null, [0, 0, 0, 1], null],
      },
    ])
    const withoutCurves = JSON.stringify([
      { kind: 'sub_face', face: 10, parent: 1, loop: [0, 0, 0, 1, 0, 0, 1, 1, 0], curve: null, nested: [] },
    ])
    const f = parseFaceFeatures(withCurves)[0] as SubFaceImprint
    expect(f.curves).toEqual([null, { center: [0, 0, 0], radius: 1 }, null])
    const g = parseFaceFeatures(withoutCurves)[0] as SubFaceImprint
    expect(g.curves).toEqual([])
  })

  it('returns [] for invalid JSON rather than throwing', () => {
    expect(parseFaceFeatures('not json')).toEqual([])
    expect(parseFaceFeatures('')).toEqual([])
  })

  it('returns [] when the top level is not an array', () => {
    expect(parseFaceFeatures(JSON.stringify({ kind: 'sub_face' }))).toEqual([])
  })

  it('skips malformed entries without throwing, keeping the valid ones', () => {
    const json = JSON.stringify([
      'garbage', // not an object
      null, // null entry
      { kind: 'bogus' }, // unrecognized kind
      { kind: 'chord', edge: 1, faces: [1], path: [] }, // wrong-length faces
      { kind: 'chord', edge: 7, faces: [2, 3], path: [0, 0, 0, 1, 0, 0] }, // valid
    ])
    const out = parseFaceFeatures(json)
    expect(out).toHaveLength(1)
    expect((out[0] as ChordImprint).edge).toBe(7n)
  })
})

// ---------------------------------------------------------------------------
// readImprints
// ---------------------------------------------------------------------------

describe('readImprints', () => {
  it('parses the scene\'s face_features JSON for the given object', () => {
    const scene = {
      face_features: (object: bigint) =>
        object === 1n
          ? JSON.stringify([{ kind: 'chord', edge: 9, faces: [1, 2], path: [0, 0, 0, 1, 0, 0] }])
          : '[]',
    }
    expect(readImprints(scene, 1n)).toHaveLength(1)
    expect(readImprints(scene, 2n)).toEqual([])
  })

  it('returns [] rather than throwing when face_features itself throws', () => {
    const scene = {
      face_features: () => {
        throw new Error('UnknownObject')
      },
    }
    expect(readImprints(scene, 1n)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// imprintRef / nodeKey round trip, isImprintRef, imprintNodes
// ---------------------------------------------------------------------------

describe('imprintRef', () => {
  const subFace: SubFaceImprint = {
    kind: 'sub_face',
    face: 10n,
    parent: 1n,
    loop: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
    curve: null,
    curves: [],
    nested: [], holes: [],
  }
  const chord: ChordImprint = {
    kind: 'chord',
    edge: 5n,
    faces: [2n, 3n],
    path: [[0, 0, 0], [1, 0, 0]],
    curves: [],
  }

  it('mints an imprint ref keyed by the face handle for a sub_face', () => {
    const ref = imprintRef(1n, subFace)
    expect(ref).toEqual({ kind: 'imprint', id: 10n, object: 1n })
  })

  it('mints an imprint-chord ref keyed by the run\'s first edge for a chord', () => {
    const ref = imprintRef(1n, chord)
    expect(ref).toEqual({ kind: 'imprint-chord', id: 5n, object: 1n })
  })

  it('round-trips through nodeKey: same object+feature -> same key, different object -> different key', () => {
    const a = imprintRef(1n, subFace)
    const b = imprintRef(1n, subFace)
    const c = imprintRef(2n, subFace)
    expect(nodeKey(a)).toBe(nodeKey(b))
    expect(nodeKey(a)).not.toBe(nodeKey(c))
  })

  it('isImprintRef is true only for imprint kinds with an object set', () => {
    expect(isImprintRef(imprintRef(1n, subFace))).toBe(true)
    expect(isImprintRef(imprintRef(1n, chord))).toBe(true)
    expect(isImprintRef({ kind: 'object', id: 1n })).toBe(false)
    expect(isImprintRef({ kind: 'imprint', id: 10n })).toBe(false) // no object
  })

  it('imprintNodes filters a mixed selection down to the imprint refs, keeping their object', () => {
    const sel = [
      { kind: 'object' as const, id: 1n },
      imprintRef(1n, subFace),
      { kind: 'sketch' as const, id: 2n },
      imprintRef(1n, chord),
    ]
    expect(imprintNodes(sel)).toEqual([imprintRef(1n, subFace), imprintRef(1n, chord)])
  })
})

// ---------------------------------------------------------------------------
// findImprint
// ---------------------------------------------------------------------------

describe('findImprint', () => {
  const subFaceJson = JSON.stringify([
    { kind: 'sub_face', face: 10, parent: 1, loop: [0, 0, 0, 1, 0, 0, 1, 1, 0], curve: null, nested: [] },
  ])

  it('resolves a live imprint ref to its current feature', () => {
    const scene = { face_features: () => subFaceJson }
    const ref = { kind: 'imprint' as const, id: 10n, object: 1n }
    const f = findImprint(scene, ref)
    expect(f).not.toBeNull()
    expect(f?.kind).toBe('sub_face')
  })

  it('returns null for a stale ref (handle no longer listed)', () => {
    const scene = { face_features: () => subFaceJson }
    const stale = { kind: 'imprint' as const, id: 999n, object: 1n }
    expect(findImprint(scene, stale)).toBeNull()
  })

  it('returns null for a non-imprint ref', () => {
    const scene = { face_features: () => subFaceJson }
    expect(findImprint(scene, { kind: 'object', id: 1n })).toBeNull()
  })

  it('returns null when the ref carries no object', () => {
    const scene = { face_features: () => subFaceJson }
    expect(findImprint(scene, { kind: 'imprint', id: 10n })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// subFaceImprint
// ---------------------------------------------------------------------------

describe('subFaceImprint', () => {
  it('finds the sub_face feature by face handle among a mixed feature list', () => {
    const features: ImprintFeature[] = [
      { kind: 'chord', edge: 1n, faces: [1n, 2n], path: [[0, 0, 0], [1, 0, 0]], curves: [] },
      { kind: 'sub_face', face: 10n, parent: 1n, loop: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], curve: null, curves: [], nested: [], holes: [] },
    ]
    expect(subFaceImprint(features, 10n)?.kind).toBe('sub_face')
    expect(subFaceImprint(features, 999n)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// chordThroughSegment
// ---------------------------------------------------------------------------

describe('chordThroughSegment', () => {
  const run: ChordImprint = {
    kind: 'chord',
    edge: 5n,
    faces: [2n, 3n],
    path: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    curves: [],
  }
  const features: ImprintFeature[] = [run]

  it('matches a segment given in path order', () => {
    expect(chordThroughSegment(features, [0, 0, 0], [1, 0, 0])).toBe(run)
  })

  it('matches the same segment given in reverse order', () => {
    expect(chordThroughSegment(features, [1, 0, 0], [0, 0, 0])).toBe(run)
  })

  it('matches a later segment of the same run, either order', () => {
    expect(chordThroughSegment(features, [1, 0, 0], [2, 0, 0])).toBe(run)
    expect(chordThroughSegment(features, [2, 0, 0], [1, 0, 0])).toBe(run)
  })

  it('returns null for a segment not on any run', () => {
    expect(chordThroughSegment(features, [5, 5, 5], [6, 6, 6])).toBeNull()
  })

  it('never matches a sub_face feature', () => {
    const subFace: ImprintFeature = {
      kind: 'sub_face', face: 10n, parent: 1n, loop: [[0, 0, 0], [1, 0, 0]], curve: null, curves: [], nested: [], holes: [],
    }
    expect(chordThroughSegment([subFace], [0, 0, 0], [1, 0, 0])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// chordNearPoint
// ---------------------------------------------------------------------------

describe('chordNearPoint', () => {
  const near: ChordImprint = { kind: 'chord', edge: 1n, faces: [1n, 2n], path: [[0, 0, 0], [1, 0, 0]], curves: [] }
  const far: ChordImprint = { kind: 'chord', edge: 2n, faces: [3n, 4n], path: [[10, 10, 0], [11, 10, 0]], curves: [] }
  const features: ImprintFeature[] = [near, far]

  it('returns the run within maxDist of the point', () => {
    expect(chordNearPoint(features, [0.5, 0.001, 0], 0.01)).toBe(near)
  })

  it('returns the nearest run when more than one is in range', () => {
    const closerFar: ChordImprint = { kind: 'chord', edge: 3n, faces: [5n, 6n], path: [[0.5, 0.5, 0], [1.5, 0.5, 0]], curves: [] }
    const both = [near, closerFar]
    // Point sits exactly on `near`'s segment; `closerFar` is further away.
    expect(chordNearPoint(both, [0.5, 0, 0], 1)).toBe(near)
  })

  it('returns null when nothing is within maxDist', () => {
    expect(chordNearPoint(features, [0.5, 5, 0], 0.01)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// imprintSegments
// ---------------------------------------------------------------------------

describe('imprintSegments', () => {
  it('closes the loop for a sub_face: N points -> N segments, last wraps to first', () => {
    const tri: ImprintFeature = {
      kind: 'sub_face',
      face: 10n,
      parent: 1n,
      loop: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      curve: null,
      curves: [],
      nested: [], holes: [],
    }
    const segs = imprintSegments(tri)
    expect(segs.length).toBe(3 * 6) // 3 segments, 6 floats each
    // Segment 0: p0 -> p1
    expect(Array.from(segs.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0])
    // Segment 2 (last): p2 -> p0 (the wrap-around close)
    expect(Array.from(segs.slice(12, 18))).toEqual([0, 1, 0, 0, 0, 0])
  })

  it('leaves the path open for a chord: N points -> N-1 segments, no wrap', () => {
    const chord: ImprintFeature = {
      kind: 'chord',
      edge: 1n,
      faces: [1n, 2n],
      path: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
      curves: [],
    }
    const segs = imprintSegments(chord)
    expect(segs.length).toBe(2 * 6) // 2 segments for 3 points
    expect(Array.from(segs.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0])
    expect(Array.from(segs.slice(6, 12))).toEqual([1, 0, 0, 2, 0, 0])
  })

  it('returns unposed coordinates when no pose is given', () => {
    const chord: ImprintFeature = { kind: 'chord', edge: 1n, faces: [1n, 2n], path: [[1, 2, 3], [4, 5, 6]], curves: [] }
    const segs = imprintSegments(chord)
    expect(Array.from(segs)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('poses every point through a 3x4 row-major affine when given', () => {
    const chord: ImprintFeature = { kind: 'chord', edge: 1n, faces: [1n, 2n], path: [[1, 0, 0], [0, 1, 0]], curves: [] }
    // Translate by (10, 20, 30) — identity linear part, translation column.
    const pose = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30]
    const segs = imprintSegments(chord, pose)
    expect(Array.from(segs)).toEqual([11, 20, 30, 10, 21, 30])
  })
})

// ---------------------------------------------------------------------------
// imprintFace
// ---------------------------------------------------------------------------

describe('imprintFace', () => {
  it('is the feature\'s own face for a sub_face', () => {
    const f: ImprintFeature = { kind: 'sub_face', face: 10n, parent: 1n, loop: [], curve: null, curves: [], nested: [], holes: [] }
    expect(imprintFace(f)).toBe(10n)
  })

  it('is the run\'s first face for a chord', () => {
    const f: ImprintFeature = { kind: 'chord', edge: 1n, faces: [7n, 8n], path: [], curves: [] }
    expect(imprintFace(f)).toBe(7n)
  })
})

// ---------------------------------------------------------------------------
// imprintName
// ---------------------------------------------------------------------------

describe('imprintName', () => {
  it('names a sub_face with a curve "Circle"', () => {
    const f: ImprintFeature = {
      kind: 'sub_face',
      face: 10n,
      parent: 1n,
      loop: [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]],
      curve: { center: [0, 0, 0], radius: 1 },
      curves: [],
      nested: [], holes: [],
    }
    expect(imprintName(f)).toBe('Circle')
  })

  it('names an axis-aligned 4-point rectangle loop "Rectangle"', () => {
    const f: ImprintFeature = {
      kind: 'sub_face',
      face: 10n,
      parent: 1n,
      loop: [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]],
      curve: null,
      curves: [],
      nested: [], holes: [],
    }
    expect(imprintName(f)).toBe('Rectangle')
  })

  it('names a rotated 4-point rectangle loop "Rectangle" too (no axis-alignment requirement)', () => {
    // A 2x1 rectangle centered at the origin, rotated 45 degrees about Z.
    const c = Math.SQRT1_2
    const corners: [number, number][] = [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]]
    const loop = corners.map(([x, y]) => [x * c - y * c, x * c + y * c, 0] as [number, number, number])
    const f: ImprintFeature = { kind: 'sub_face', face: 10n, parent: 1n, loop, curve: null, curves: [], nested: [], holes: [] }
    expect(imprintName(f)).toBe('Rectangle')
  })

  it('names a 3-point loop (triangle) "Shape"', () => {
    const f: ImprintFeature = {
      kind: 'sub_face',
      face: 10n,
      parent: 1n,
      loop: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      curve: null,
      curves: [],
      nested: [], holes: [],
    }
    expect(imprintName(f)).toBe('Shape')
  })

  it('names a sub_face loop with no whole-loop curve but a per-edge arc "Arc shape"', () => {
    // A pie/segment closure: the loop as a whole isn't one circle (curve is
    // null), but one edge (say the leading arc edge) carries a drawn arc.
    const f: ImprintFeature = {
      kind: 'sub_face',
      face: 10n,
      parent: 1n,
      loop: [[1, 0, 0], [0, 1, 0], [0, 0, 0]],
      curve: null,
      curves: [{ center: [0, 0, 0], radius: 1 }, null, null],
      nested: [], holes: [],
    }
    expect(imprintName(f)).toBe('Arc shape')
  })

  it('names a 2-point chord "Line on face"', () => {
    const f: ImprintFeature = { kind: 'chord', edge: 1n, faces: [1n, 2n], path: [[0, 0, 0], [1, 0, 0]], curves: [] }
    expect(imprintName(f)).toBe('Line')
  })

  it('names a longer chord (e.g. 4 points) "Shape on edge"', () => {
    const f: ImprintFeature = {
      kind: 'chord',
      edge: 1n,
      faces: [1n, 2n],
      path: [[0, 0, 0], [1, 0, 0], [2, 1, 0], [3, 0, 0]],
      curves: [],
    }
    expect(imprintName(f)).toBe('Edge shape')
  })

  it('names a chord carrying a drawn arc "Arc", regardless of edge count', () => {
    const twoPoint: ImprintFeature = {
      kind: 'chord',
      edge: 1n,
      faces: [1n, 2n],
      path: [[0, 0, 0], [1, 0, 0]],
      curves: [{ center: [0.5, 0.5, 0], radius: 0.5 }],
    }
    expect(imprintName(twoPoint)).toBe('Arc')

    const multiPoint: ImprintFeature = {
      kind: 'chord',
      edge: 1n,
      faces: [1n, 2n],
      path: [[0, 0, 0], [1, 0, 0], [2, 1, 0]],
      curves: [{ center: [0.5, 0.5, 0], radius: 0.5 }, null],
    }
    expect(imprintName(multiPoint)).toBe('Arc')
  })
})

describe('parseFaceFeatures — hole rings', () => {
  it('reads every hole ring of a sub-face, and defaults to none when absent', () => {
    const json = JSON.stringify([
      {
        kind: 'sub_face', face: 1, parent: 2, loop: [0, 0, 0, 1, 0, 0, 1, 1, 0], curve: null, nested: [],
        holes: [[0.2, 0.2, 0, 0.4, 0.2, 0, 0.4, 0.4, 0]],
      },
      { kind: 'sub_face', face: 3, parent: 2, loop: [0, 0, 0, 1, 0, 0, 1, 1, 0], curve: null, nested: [] },
    ])
    const [a, b] = parseFaceFeatures(json)
    expect(a.kind === 'sub_face' ? a.holes : null).toEqual([[[0.2, 0.2, 0], [0.4, 0.2, 0], [0.4, 0.4, 0]]])
    expect(b.kind === 'sub_face' ? b.holes : null).toEqual([])
  })
})
