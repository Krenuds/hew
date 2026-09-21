/**
 * The cube's orientation math. Every case here poses a REAL
 * `THREE.PerspectiveCamera` at a standard view and reads its quaternion back,
 * rather than hand-writing quaternion literals: that is the same pose path
 * the viewport itself takes, so a sign convention that is wrong here is wrong
 * on screen too.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  cubeMatrix,
  faceMatrix,
  cssMatrix3d,
  applyToDirection,
  eyeDirFromQuaternion,
  visibleFaces,
  regionAtCubePoint,
} from './viewCubeMatrix'
import { CUBE_FACES, faceFrame, faceZones, regionById, type CubeFace } from './viewCubeRegions'
import { STANDARD_VIEWS, WORLD_UP, type StandardView } from './standardViews'

/** The camera quaternion the viewport ends up with at a given standard view. */
function quaternionAt(view: StandardView): [number, number, number, number] {
  const camera = new THREE.PerspectiveCamera()
  camera.up.set(WORLD_UP[0], WORLD_UP[1], WORLD_UP[2])
  const eye = STANDARD_VIEWS[view].eye
  camera.position.set(eye[0], eye[1], eye[2])
  camera.lookAt(0, 0, 0)
  const q = camera.quaternion
  return [q.x, q.y, q.z, q.w]
}

const IDENTITY_Q: [number, number, number, number] = [0, 0, 0, 1]

describe('cubeMatrix — world to CSS', () => {
  it('negates the Y row for the identity camera, and nothing else', () => {
    expect(cssMatrix3d(cubeMatrix(...IDENTITY_Q))).toBe(
      'matrix3d(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
    )
  })

  it.each(CUBE_FACES)('turns the %s face toward the viewer at its own standard view', (face) => {
    const m = cubeMatrix(...quaternionAt(face))
    const normal = faceFrame(face).normal
    const css = applyToDirection(m, normal)
    // CSS +Z is out of the screen toward the viewer.
    expect(css[2]).toBeCloseTo(1, 6)
  })

  it.each(CUBE_FACES)('puts the %s face label upright at its own standard view', (face) => {
    const m = cubeMatrix(...quaternionAt(face))
    const up = faceFrame(face).up
    const css = applyToDirection(m, up)
    // CSS +Y points DOWN the screen, so screen-up is a negative Y.
    expect(css[1]).toBeCloseTo(-1, 6)
    expect(css[0]).toBeCloseTo(0, 6)
  })

  it.each(CUBE_FACES)('puts the %s face right-hand axis to the right of the screen', (face) => {
    const m = cubeMatrix(...quaternionAt(face))
    const css = applyToDirection(m, faceFrame(face).right)
    expect(css[0]).toBeCloseTo(1, 6)
  })

  it('does not mirror: it is a proper rotation composed with exactly one flip', () => {
    const m = cubeMatrix(...quaternionAt('iso'))
    const x = applyToDirection(m, [1, 0, 0])
    const y = applyToDirection(m, [0, 1, 0])
    const z = applyToDirection(m, [0, 0, 1])
    const det =
      x[0] * (y[1] * z[2] - y[2] * z[1]) -
      y[0] * (x[1] * z[2] - x[2] * z[1]) +
      z[0] * (x[1] * y[2] - x[2] * y[1])
    // One row negated flips the sign; the per-face column flip cancels it.
    expect(det).toBeCloseTo(-1, 9)
  })

  it('stays orthonormal', () => {
    const m = cubeMatrix(...quaternionAt('iso'))
    const cols = [
      applyToDirection(m, [1, 0, 0]),
      applyToDirection(m, [0, 1, 0]),
      applyToDirection(m, [0, 0, 1]),
    ]
    for (const c of cols) expect(Math.hypot(...c)).toBeCloseTo(1, 9)
    expect(cols[0][0] * cols[1][0] + cols[0][1] * cols[1][1] + cols[0][2] * cols[1][2]).toBeCloseTo(0, 9)
  })

  it('answers identity on a degenerate quaternion instead of NaNs', () => {
    expect(cubeMatrix(0, 0, 0, 0)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(cubeMatrix(NaN, 0, 0, 1)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })

  it('emits no negative zero and no more than six decimals', () => {
    for (const face of CUBE_FACES) {
      const s = cssMatrix3d(cubeMatrix(...quaternionAt(face)))
      expect(s).not.toContain('-0,')
      expect(s).not.toContain('-0)')
      for (const n of s.slice('matrix3d('.length, -1).split(', ')) {
        const decimals = n.split('.')[1] ?? ''
        expect(decimals.length).toBeLessThanOrEqual(6)
      }
    }
  })
})

describe('eyeDirFromQuaternion', () => {
  it.each([...CUBE_FACES, 'iso' as const])(
    'recovers the %s eye direction from the camera pose',
    (view) => {
      const expected = regionById(view === 'iso' ? 'front-right-top' : view).eye
      const actual = eyeDirFromQuaternion(...quaternionAt(view as StandardView))
      for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 9)
    },
  )

  it('falls back to +Z rather than propagating a NaN', () => {
    expect(eyeDirFromQuaternion(NaN, 0, 0, 1)).toEqual([0, 0, 1])
  })
})

describe('visibleFaces', () => {
  it.each(['front', 'back', 'right', 'left'] as const)(
    'shows exactly the %s face at its own standard view',
    (face) => {
      expect(CUBE_FACES.filter((f) => visibleFaces(...quaternionAt(face))[f])).toEqual([face])
    },
  )

  it.each(['top', 'bottom'] as const)(
    'shows %s alone at its own standard view — POLE_TILT turns front toward you, but only by a sliver',
    (face) => {
      // Top's eye is [0, -POLE_TILT, 1]: a twentieth of a degree off the pole,
      // so the front face IS technically turned toward the viewer. A fifth of
      // a pixel of cube is not a click target, and leaving it interactive
      // would let it swallow clicks aimed at the top face behind it.
      expect(CUBE_FACES.filter((f) => visibleFaces(...quaternionAt(face))[f])).toEqual([face])
    },
  )

  it('needs a real angle, not just a positive dot, before a face takes clicks', () => {
    // Rotate about X so the front face comes gradually into view from the top
    // view. At 5° it is still a sliver; by 20° it is a target.
    const atTilt = (deg: number) => {
      const camera = new THREE.PerspectiveCamera()
      camera.up.set(0, 0, 1)
      const r = (deg * Math.PI) / 180
      camera.position.set(0, -Math.sin(r), Math.cos(r))
      camera.lookAt(0, 0, 0)
      const q = camera.quaternion
      return visibleFaces(q.x, q.y, q.z, q.w)
    }
    expect(atTilt(5).front).toBe(false)
    expect(atTilt(20).front).toBe(true)
    expect(atTilt(5).top).toBe(true)
  })

  it('shows the three faces meeting the near corner at the iso view', () => {
    const vis = visibleFaces(...quaternionAt('iso'))
    const shown = new Set(CUBE_FACES.filter((f) => vis[f]))
    expect(shown).toEqual(new Set<CubeFace>(['front', 'right', 'top']))
  })

  it('never shows a face and its opposite at once', () => {
    const vis = visibleFaces(...quaternionAt('iso'))
    expect(vis.front && vis.back).toBe(false)
    expect(vis.left && vis.right).toBe(false)
    expect(vis.top && vis.bottom).toBe(false)
  })
})

describe('faceMatrix', () => {
  const HALF = 42

  it.each(CUBE_FACES)('%s carries right, -up, normal and a normal-ward offset', (face) => {
    const { normal, right, up } = faceFrame(face)
    const m = faceMatrix(face, HALF)
    expect(m.slice(0, 4)).toEqual([right[0], right[1], right[2], 0])
    expect(m.slice(4, 8)).toEqual([-up[0] + 0, -up[1] + 0, -up[2] + 0, 0])
    expect(m.slice(8, 12)).toEqual([normal[0], normal[1], normal[2], 0])
    expect(m.slice(12, 16)).toEqual([normal[0] * HALF, normal[1] * HALF, normal[2] * HALF, 1])
  })

  it('places opposite faces a full cube apart', () => {
    const front = faceMatrix('front', HALF).slice(12, 15)
    const back = faceMatrix('back', HALF).slice(12, 15)
    expect(Math.hypot(front[0] - back[0], front[1] - back[1], front[2] - back[2])).toBe(2 * HALF)
  })

  it('composes with the camera matrix to face the viewer at that face own view', () => {
    // The full chain the DOM performs: cube matrix, then the face's own.
    for (const face of CUBE_FACES) {
      const cube = cubeMatrix(...quaternionAt(face))
      const fm = faceMatrix(face, HALF)
      // The face div's local +Z (out of the element) in world axes is column 2.
      const localZWorld: [number, number, number] = [fm[8], fm[9], fm[10]]
      const css = applyToDirection(cube, localZWorld)
      expect(css[2]).toBeCloseTo(1, 6)
    }
  })
})

describe('regionAtCubePoint — picking by inverting the projection', () => {
  const HALF = 36

  it('picks the face you are looking at, dead centre', () => {
    for (const face of CUBE_FACES) {
      expect(regionAtCubePoint(cubeMatrix(...quaternionAt(face)), 0, 0, HALF)).toBe(face)
    }
  })

  it('misses outside the silhouette', () => {
    const m = cubeMatrix(...quaternionAt('front'))
    expect(regionAtCubePoint(m, HALF * 1.5, HALF * 1.5, HALF)).toBeNull()
  })

  it('splits a face into its nine zones, with the top row toward screen-up', () => {
    const m = cubeMatrix(...quaternionAt('front'))
    const t = HALF * 0.7 // clear of the thirds boundaries
    // Screen y is DOWN, so -t is the top of the face.
    expect(regionAtCubePoint(m, 0, -t, HALF)).toBe('front-top')
    expect(regionAtCubePoint(m, 0, t, HALF)).toBe('front-bottom')
    expect(regionAtCubePoint(m, t, 0, HALF)).toBe('front-right')
    expect(regionAtCubePoint(m, -t, 0, HALF)).toBe('front-left')
    expect(regionAtCubePoint(m, t, -t, HALF)).toBe('front-right-top')
    expect(regionAtCubePoint(m, -t, t, HALF)).toBe('front-left-bottom')
  })

  it('agrees with the grid the markup is built from', () => {
    // Every zone of the front face, sampled at its own centre, must come back
    // as the id `faceZones` put in that cell — otherwise what you click and
    // what you see are different regions.
    const m = cubeMatrix(...quaternionAt('front'))
    const grid = faceZones('front')
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const sx = ((col - 1) * 2 * HALF) / 3
        const sy = ((row - 1) * 2 * HALF) / 3
        expect(regionAtCubePoint(m, sx, sy, HALF)).toBe(grid[row][col])
      }
    }
  })

  it('resolves an overlap in favour of the face nearer the viewer', () => {
    // At the iso view three faces overlap the silhouette; a point near the
    // centre must resolve to the near corner's own region, not to whichever
    // far face also happens to contain it.
    const m = cubeMatrix(...quaternionAt('iso'))
    expect(regionAtCubePoint(m, 0, 0, HALF)).toBe('front-right-top')
  })

  it('never answers a region on a face turned away from the viewer', () => {
    const m = cubeMatrix(...quaternionAt('front'))
    for (let sx = -HALF; sx <= HALF; sx += HALF / 4) {
      for (let sy = -HALF; sy <= HALF; sy += HALF / 4) {
        const id = regionAtCubePoint(m, sx, sy, HALF)
        if (id !== null) expect(id.startsWith('back')).toBe(false)
      }
    }
  })

  it('scales with the cube, so the same fraction of the widget picks the same zone', () => {
    const m = cubeMatrix(...quaternionAt('front'))
    expect(regionAtCubePoint(m, 20 * 0.7, 0, 20)).toBe(regionAtCubePoint(m, 90 * 0.7, 0, 90))
  })

  it('answers null on a degenerate size rather than dividing by zero', () => {
    expect(regionAtCubePoint(cubeMatrix(...quaternionAt('front')), 0, 0, 0)).toBeNull()
  })
})
