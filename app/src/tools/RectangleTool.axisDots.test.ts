/**
 * RectangleTool — the axis each typed dimension runs along, reported
 * alongside the readout for the Measurements box's dots
 * (`viewport/measurementAxes.ts`).
 *
 * The pair is derived from the anchored plane, never from the cursor, so it
 * is right from the anchoring click and survives a typed buffer leaving the
 * rubber band behind. What it must never do is name a direction the commit
 * would not use — see `_dimensionDirections`, which forks exactly as
 * `_commitTyped` does.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { RectangleTool } from './RectangleTool'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

const IDENTITY_FRAME = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])

/** The drawing axes turned 30° about Z — far enough off every world axis
 *  that nothing world-aligned lands inside the 10° labeling tolerance. */
const TURNED_30 = (() => {
  const c = Math.cos(Math.PI / 6)
  const s = Math.sin(Math.PI / 6)
  return new Float64Array([0, 0, 0, c, s, 0, -s, c, 0, 0, 0, 1])
})()

function makePick(object: bigint, face: bigint) {
  return { object: () => object, face: () => face, depth: () => 1, instance: () => undefined, free: vi.fn() }
}

function makeWasmScene(opts: {
  /** The picked face's outward normal — null means nothing is pickable, so
   *  a click lands on the ground plane instead. */
  faceNormal?: [number, number, number] | null
  frame?: Float64Array
} = {}): WasmScene {
  const n = opts.faceNormal ?? null
  let sketchCounter = 41n
  return {
    history_generation: vi.fn(() => 1n),
    axes: vi.fn(() => opts.frame ?? IDENTITY_FRAME),
    begin_ground_sketch: vi.fn(() => { sketchCounter += 1n; return sketchCounter }),
    begin_sketch_on_plane: vi.fn(() => { sketchCounter += 1n; return sketchCounter }),
    sketch_begin_gesture: vi.fn(),
    sketch_end_gesture: vi.fn(),
    sketch_add_segment: vi.fn(() => ({
      new_edges: () => new BigUint64Array([]),
      regions_created: () => new BigUint64Array([]),
      regions_removed: () => new BigUint64Array([]),
      free: vi.fn(),
    })),
    pick_face: vi.fn(() => (n === null ? undefined : makePick(7n, 3n))),
    pick_sketch: vi.fn(() => undefined),
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    node_parent: vi.fn(() => undefined),
    face_normal: vi.fn(() => new Float64Array(n ?? [0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array([0, 0, 0, ...(n ?? [0, 0, 1])])),
    split_face_inner: vi.fn(() => 99n),
  } as unknown as WasmScene
}

function makeTool(scene: WasmScene) {
  const onMeasurement = vi.fn()
  const tool = new RectangleTool(scene, new THREE.Group(), vi.fn(), vi.fn(), vi.fn(), onMeasurement)
  return { tool, onMeasurement }
}

function snap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

/** A ray straight down (−Z) through world (x, y). */
function down(x: number, y: number): Ray {
  return { origin: [x, y, 5], direction: [0, 0, -1] }
}

/**
 * Anchor, then press a digit. The typed-buffer emit carries the axes, and
 * reaching them this way — without a pointer move — is itself the check that
 * they exist from the anchoring click.
 */
function axesAfterAnchoring(scene: WasmScene, at: Partial<Snap>, ray: Ray) {
  const { tool, onMeasurement } = makeTool(scene)
  tool.onPointerDown(snap(at), ray)
  tool.onKey({ key: '3' } as KeyboardEvent)
  const last = onMeasurement.mock.calls.at(-1)
  return { axes: last?.[1], tool, onMeasurement }
}

describe('RectangleTool — dimension axes', () => {
  it('ground: world X then world Y, red then green', () => {
    const { axes } = axesAfterAnchoring(makeWasmScene(), { x: 1, y: 1 }, down(1, 1))
    expect(axes).toEqual([0, 1])
  })

  // The case the whole feature exists for: `facePlaneBasis([1,0,0])` resolves
  // to u = +Z, v = −Y, so on a wall facing +X the FIRST number you type is
  // the height. Nothing in "3, 5" says so; the dots do.
  it('a wall facing +X: blue then green — the first dimension is the height', () => {
    const scene = makeWasmScene({ faceNormal: [1, 0, 0] })
    const { axes } = axesAfterAnchoring(scene, { x: 0, y: 1, z: 1, kind: 'face' }, { origin: [5, 1, 1], direction: [-1, 0, 0] })
    expect(axes).toEqual([2, 1])
  })

  it('a face lying flat: the basis of its +Z normal', () => {
    const scene = makeWasmScene({ faceNormal: [0, 0, 1] })
    const { axes } = axesAfterAnchoring(scene, { x: 0, y: 0, z: 0, kind: 'face' }, down(0, 0))
    // facePlaneBasis([0,0,1]) → u = [0,1,0] (green), v = [-1,0,0] (red).
    expect(axes).toEqual([1, 0])
  })

  // Still two entries, so the box does not change width between planes.
  it('an oblique plane: both neutral, and still a pair', () => {
    const k = 1 / Math.sqrt(3)
    const scene = makeWasmScene({ faceNormal: [k, k, k] })
    const { axes } = axesAfterAnchoring(scene, { x: 0, y: 0, z: 0, kind: 'face' }, down(0, 0))
    expect(axes).toEqual([null, null])
  })

  it('the pair does not change as the cursor moves', () => {
    const { tool, onMeasurement } = makeTool(makeWasmScene())
    tool.onPointerDown(snap({ x: 0, y: 0 }), down(0, 0))
    tool.onPointerMove(snap({ x: 2, y: 5 }), down(2, 5))
    const dragging = onMeasurement.mock.calls.at(-1)?.[1]
    tool.onPointerMove(snap({ x: -4, y: -1 }), down(-4, -1))
    expect(onMeasurement.mock.calls.at(-1)?.[1]).toEqual(dragging)
    expect(dragging).toEqual([0, 1])
  })

  it('a typed buffer reports the same pair as the live readout it replaced', () => {
    const { tool, onMeasurement } = makeTool(makeWasmScene())
    tool.onPointerDown(snap({ x: 0, y: 0 }), down(0, 0))
    tool.onPointerMove(snap({ x: 2, y: 5 }), down(2, 5))
    const live = onMeasurement.mock.calls.at(-1)?.[1]
    tool.onKey({ key: '4' } as KeyboardEvent)
    expect(onMeasurement.mock.calls.at(-1)?.[1]).toEqual(live)
  })

  it('the post-commit retype window reports the pair of the gesture that committed', () => {
    const { tool, onMeasurement } = makeTool(makeWasmScene())
    tool.onPointerDown(snap({ x: 0, y: 0 }), down(0, 0))
    tool.onPointerDown(snap({ x: 2, y: 3 }), down(2, 3)) // commits, arms the retype window
    onMeasurement.mockClear()
    tool.onKey({ key: '5' } as KeyboardEvent)
    expect(onMeasurement.mock.calls.at(-1)?.[1]).toEqual([0, 1])
  })

  // The ground fast path is hardcoded to world X/Y and deliberately never
  // consults the frame, which is what keeps ground coordinates bit-identical.
  // So under a turned frame those dimensions genuinely run along neither the
  // frame's red nor its green, and neutral is the honest answer — painting
  // them red and green would be exactly the lie the dots exist to prevent.
  it('a moved drawing-axes frame leaves a ground rectangle neutral', () => {
    const scene = makeWasmScene({ frame: TURNED_30 })
    const { axes } = axesAfterAnchoring(scene, { x: 1, y: 1 }, down(1, 1))
    expect(axes).toEqual([null, null])
  })
})
