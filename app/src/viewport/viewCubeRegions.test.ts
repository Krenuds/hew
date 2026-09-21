import { describe, it, expect } from 'vitest'
import {
  VIEW_CUBE_REGIONS,
  CUBE_FACES,
  regionById,
  regionAtDirection,
  faceZones,
  faceFrame,
  type CubeFace,
} from './viewCubeRegions'
import { STANDARD_VIEWS, POLE_TILT } from './standardViews'

function unit(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2])
  return [v[0] / len, v[1] / len, v[2] / len]
}

/** Cross product, with `-0` folded to `0`: the sign-triple inputs make signed
 * zeros fall out of the arithmetic, and `toEqual` distinguishes them. */
function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  return c.map((n) => n + 0) as [number, number, number]
}

describe('the 26 regions', () => {
  it('enumerates every sign triple except the origin, exactly once', () => {
    expect(VIEW_CUBE_REGIONS).toHaveLength(26)
    const seen = new Set(VIEW_CUBE_REGIONS.map((r) => r.triple.join(',')))
    expect(seen.size).toBe(26)
    expect(seen.has('0,0,0')).toBe(false)
  })

  it('splits 6 faces / 12 edges / 8 corners', () => {
    const count = (kind: string) => VIEW_CUBE_REGIONS.filter((r) => r.kind === kind).length
    expect(count('face')).toBe(6)
    expect(count('edge')).toBe(12)
    expect(count('corner')).toBe(8)
  })

  it('gives every region a unique id', () => {
    expect(new Set(VIEW_CUBE_REGIONS.map((r) => r.id)).size).toBe(26)
  })

  it('names regions front/back, left/right, top/bottom in that reading order', () => {
    expect(regionById('front').triple).toEqual([0, -1, 0])
    expect(regionById('front-right').triple).toEqual([1, -1, 0])
    expect(regionById('front-right-top').triple).toEqual([1, -1, 1])
    expect(regionById('back-left-bottom').triple).toEqual([-1, 1, -1])
  })

  it('throws on an unknown id rather than answering undefined', () => {
    expect(() => regionById('sideways')).toThrow(/unknown ViewCube region/)
  })

  it('makes every eye direction unit length', () => {
    for (const r of VIEW_CUBE_REGIONS) {
      expect(Math.hypot(r.eye[0], r.eye[1], r.eye[2])).toBeCloseTo(1, 12)
    }
  })
})

describe('faces agree with the viewport standard views', () => {
  it.each(CUBE_FACES)('%s reads its eye off STANDARD_VIEWS', (face) => {
    const expected = unit(STANDARD_VIEWS[face].eye)
    const actual = regionById(face).eye
    expect(actual[0]).toBe(expected[0])
    expect(actual[1]).toBe(expected[1])
    expect(actual[2]).toBe(expected[2])
  })

  it('carries POLE_TILT into Top and Bottom, so the cube cannot park the camera on the pole', () => {
    // The Y component is the tilt: were it zero, orbiting away from Top would
    // pivot around the wrong axis (see POLE_TILT's own doc).
    for (const face of ['top', 'bottom'] as const) {
      const eye = regionById(face).eye
      expect(eye[1]).toBeLessThan(0)
      expect(eye[1]).toBeCloseTo(-POLE_TILT / Math.hypot(POLE_TILT, 1), 12)
    }
  })

  it('reports the matching setStandardView argument for the six faces', () => {
    for (const face of CUBE_FACES) expect(regionById(face).standardView).toBe(face)
  })

  it('recognises the front-right-top corner as the Iso the Camera menu already has', () => {
    const iso = regionById('front-right-top')
    expect(iso.standardView).toBe('iso')
    expect(iso.eye).toEqual(unit(STANDARD_VIEWS.iso.eye))
  })

  it('leaves the other 19 regions without a standard view', () => {
    const named = VIEW_CUBE_REGIONS.filter((r) => r.standardView !== null)
    expect(named).toHaveLength(7)
  })
})

describe('regionAtDirection — the "you are here" lookup', () => {
  it('round-trips every region', () => {
    for (const r of VIEW_CUBE_REGIONS) {
      expect(regionAtDirection(r.eye)?.id).toBe(r.id)
    }
  })

  it('does not need a unit-length direction', () => {
    expect(regionAtDirection([0, -37, 0])?.id).toBe('front')
  })

  it('answers null between regions', () => {
    // Halfway from the front face to the front-right edge — 22.5° from each,
    // far outside the 3° window.
    const between = unit([Math.sin(Math.PI / 8), -Math.cos(Math.PI / 8), 0])
    expect(regionAtDirection(between)).toBeNull()
  })

  it('answers null on a zero direction instead of dividing by zero', () => {
    expect(regionAtDirection([0, 0, 0])).toBeNull()
  })

  it('still locks on a couple of degrees off, and lets go past the window', () => {
    const nudge = (deg: number): [number, number, number] =>
      unit([Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180), 0])
    expect(regionAtDirection(nudge(2))?.id).toBe('front')
    expect(regionAtDirection(nudge(5))).toBeNull()
  })

  it('widens with an explicit tolerance', () => {
    const off = unit([Math.sin((5 * Math.PI) / 180), -Math.cos((5 * Math.PI) / 180), 0])
    expect(regionAtDirection(off, 10)?.id).toBe('front')
  })
})

describe('face frames and hit zones', () => {
  it.each(CUBE_FACES)('%s has a right-handed frame whose right x up is the outward normal', (face) => {
    const { normal, right, up } = faceFrame(face)
    expect(cross(right, up)).toEqual([...normal])
  })

  it.each(CUBE_FACES)('%s lays out a 3x3 grid with the face itself at the centre', (face: CubeFace) => {
    const zones = faceZones(face)
    expect(zones).toHaveLength(3)
    for (const row of zones) expect(row).toHaveLength(3)
    expect(zones[1][1]).toBe(face)
  })

  it.each(CUBE_FACES)('%s surrounds the centre with 4 edges and 4 corners', (face: CubeFace) => {
    const zones = faceZones(face).flat()
    const kinds = zones.map((id) => regionById(id).kind)
    expect(kinds.filter((k) => k === 'face')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'edge')).toHaveLength(4)
    expect(kinds.filter((k) => k === 'corner')).toHaveLength(4)
    expect(new Set(zones).size).toBe(9)
  })

  it('puts the top-left zone of the front face on the front-left-top corner', () => {
    expect(faceZones('front')[0][0]).toBe('front-left-top')
    expect(faceZones('front')[0][2]).toBe('front-right-top')
    expect(faceZones('front')[2][0]).toBe('front-left-bottom')
    expect(faceZones('front')[1][2]).toBe('front-right')
  })

  it('reaches all 26 regions across the six faces — 6 centres, and every edge/corner shared', () => {
    const all = new Set(CUBE_FACES.flatMap((f) => faceZones(f).flat()))
    expect(all.size).toBe(26)
  })

  it('shares each edge between exactly 2 faces and each corner between exactly 3', () => {
    const hits = new Map<string, number>()
    for (const face of CUBE_FACES) {
      for (const id of faceZones(face).flat()) hits.set(id, (hits.get(id) ?? 0) + 1)
    }
    for (const r of VIEW_CUBE_REGIONS) {
      expect(hits.get(r.id)).toBe(r.kind === 'face' ? 1 : r.kind === 'edge' ? 2 : 3)
    }
  })
})
