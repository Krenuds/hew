/**
 * ArcTool unit tests — mirrors CircleTool.test.ts' fake-WasmScene
 * pattern: drive the 3-click gesture (A, B, bulge) and assert the exact
 * kernel calls the tool commits.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { ArcTool } from './ArcTool'
import { makeSketchPlaneCache } from './sketchGesture'
import { groundDrawPlane, planeKey } from './drawPlane'
import { arcFromChord, arcSegmentCount } from './arcMath'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

// A ray straight down the -Z axis from above the origin (tuple-shaped, as the
// real Viewport supplies — the tool indexes ray.origin[0..2]).
const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

function makeKeyEvent(key: string, opts: { repeat?: boolean } = {}): KeyboardEvent {
  return { key, repeat: opts.repeat ?? false, preventDefault: () => {} } as unknown as KeyboardEvent
}

/** Feed each character of `s` through `onKey` (digits/'.'/'-' only — enough
 *  for the VCB tests below), mirroring how the Viewport forwards keydown. */
function typeDigits(tool: ArcTool, s: string): void {
  for (const ch of s) tool.onKey(makeKeyEvent(ch))
}

/** A fake `FacePickJs` returning the seeded handles. */
function makePick(object: bigint, face: bigint, instance?: bigint) {
  return {
    object: () => object,
    face: () => face,
    instance: () => instance,
    depth: () => 1,
    free: vi.fn(),
  }
}

type SegmentCall = [number, number, number, number, number, number]

/**
 * Minimal WasmScene stub — only the members ArcTool calls. Records every
 * sketch_add_segment endpoint pair and every split_face path.
 */
function makeWasmScene(opts: {
  pick?: ReturnType<typeof makePick>
  facePlane?: [number, number, number, number, number, number]
  faceNormal?: [number, number, number]
  addSegmentThrows?: boolean
  splitFaceThrows?: boolean
  /** Handles whose sketch has gone stale/hidden — `sketch_plane` reads
   *  `undefined` for them, so `runSketchGesture`'s pre-check retargets a
   *  fresh sketch (as after undoing the sketch's creating gesture). */
  staleSketchHandles?: bigint[]
} = {}) {
  const segments: SegmentCall[] = []
  const splitPaths: Float64Array[] = []
  const innerLoops: Float64Array[] = []
  let sketchCounter = 41n
  const scene = {
    history_generation: vi.fn(() => 1n),
    begin_ground_sketch: vi.fn(() => {
      sketchCounter += 1n
      return sketchCounter
    }),
    begin_sketch_on_plane: vi.fn(() => {
      sketchCounter += 1n
      return sketchCounter
    }),
    // Every picked object is plain/ungrouped by default (top-level eligibility).
    node_parent: vi.fn(() => undefined),
    // Every non-stale sketch lies on the ground plane (origin point, +Z).
    sketch_plane: vi.fn((sketch: bigint) =>
      (opts.staleSketchHandles ?? []).includes(sketch)
        ? undefined
        : new Float64Array([0, 0, 0, 0, 0, 1]),
    ),
    sketch_begin_gesture: vi.fn(),
    sketch_end_gesture: vi.fn(),
    sketch_begin_curve: vi.fn(() => 91n),
    sketch_begin_curve_with: vi.fn(() => 91n),
    sketch_end_curve: vi.fn(),
    sketch_add_segment: vi.fn((_sketch: bigint, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      if (opts.addSegmentThrows) throw new Error('PathNotSimple: edges cross')
      segments.push([ax, ay, az, bx, by, bz])
      return {
        new_edges: () => new BigUint64Array([]),
        regions_created: () => new BigUint64Array([]),
        regions_removed: () => new BigUint64Array([]),
        free: vi.fn(),
      }
    }),
    pick_face: vi.fn(() => opts.pick),
    pick_sketch: vi.fn(() => undefined), // no committed sketches in these fixtures
    face_normal: vi.fn(() => new Float64Array(opts.faceNormal ?? [0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array(opts.facePlane ?? [0, 0, 1, 0, 0, 1])),
    split_face: vi.fn((_object: bigint, _face: bigint, path: Float64Array) => {
      if (opts.splitFaceThrows) throw new Error('BadLoop: invalid cut path')
      splitPaths.push(path)
      return { free: vi.fn() }
    }),
    split_face_inner: vi.fn((_object: bigint, _face: bigint, loopPts: Float64Array) => {
      innerLoops.push(loopPts)
    }),
    split_face_in_instance: vi.fn((_instance: bigint, _object: bigint, _face: bigint, path: Float64Array) => {
      if (opts.splitFaceThrows) throw new Error('BadLoop: invalid cut path')
      splitPaths.push(path)
      return { free: vi.fn() }
    }),
    split_face_inner_in_instance: vi.fn((_instance: bigint, _object: bigint, _face: bigint, loopPts: Float64Array) => {
      innerLoops.push(loopPts)
    }),
    // Arc-carrying variants (editable-imprints): the face-mode commit path
    // prefers these whenever the arc's center resolves, falling back to the
    // plain calls above only when it can't (see `_commitFace`).
    split_face_with_arc: vi.fn((
      _object: bigint, _face: bigint, path: Float64Array,
      _center: Float64Array, _radius: number, _arcSegments: number,
    ) => {
      if (opts.splitFaceThrows) throw new Error('BadLoop: invalid cut path')
      splitPaths.push(path)
      return { free: vi.fn() }
    }),
    split_face_inner_with_arc: vi.fn((
      _object: bigint, _face: bigint, loopPts: Float64Array,
      _center: Float64Array, _radius: number, _arcSegments: number,
    ) => {
      innerLoops.push(loopPts)
    }),
    split_face_with_arc_in_instance: vi.fn((
      _instance: bigint, _object: bigint, _face: bigint, path: Float64Array,
      _center: Float64Array, _radius: number, _arcSegments: number,
    ) => {
      if (opts.splitFaceThrows) throw new Error('BadLoop: invalid cut path')
      splitPaths.push(path)
      return { free: vi.fn() }
    }),
    split_face_inner_with_arc_in_instance: vi.fn((
      _instance: bigint, _object: bigint, _face: bigint, loopPts: Float64Array,
      _center: Float64Array, _radius: number, _arcSegments: number,
    ) => {
      innerLoops.push(loopPts)
    }),
    begin_sketch_on_plane_in_instance: vi.fn(() => {
      sketchCounter += 1n
      return sketchCounter
    }),
    instance_pose: vi.fn(() => new Float64Array([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0])), // translated +5 in x
  }
  return { scene: scene as unknown as WasmScene, segments, splitPaths, innerLoops }
}

function makeTool(scene: WasmScene) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onFaceImprint = vi.fn()
  const onMeasurement = vi.fn()
  const tool = new ArcTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, preview, onCommit, onToast, onFaceImprint, onMeasurement }
}

describe('ArcTool — ground mode', () => {
  it('three clicks (A, B, bulge) commit a connected open chain with exact endpoints', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)   // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)   // B
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY) // pull the bulge
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY) // commit

    const arc = arcFromChord([0, 0], [2, 0], 0.5)!
    const expectSegs = arcSegmentCount(arc.sweep, arc.radius)
    expect(segments.length).toBe(expectSegs)

    // Exact endpoints — no float drift at the chain's ends.
    expect(segments[0][0]).toBe(0)
    expect(segments[0][1]).toBe(0)
    expect(segments[segments.length - 1][3]).toBe(2)
    expect(segments[segments.length - 1][4]).toBe(0)

    // The chain is connected: each segment starts where the previous ended.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i][0]).toBe(segments[i - 1][3])
      expect(segments[i][1]).toBe(segments[i - 1][4])
      expect(segments[i][2]).toBe(segments[i - 1][5])
    }

    // It is an OPEN chain — last endpoint differs from the first.
    expect(segments[segments.length - 1][3]).not.toBe(segments[0][0])

    // All vertices lie on the bulge side (y >= 0) and on the ground plane.
    for (const s of segments) {
      expect(s[1]).toBeGreaterThanOrEqual(0)
      expect(s[4]).toBeGreaterThanOrEqual(0)
      expect(s[2]).toBe(0)
      expect(s[5]).toBe(0)
    }

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onToast).not.toHaveBeenCalled()
    // The whole faceted-chain commit is bracketed in exactly one gesture.
    expect((scene as unknown as { sketch_begin_gesture: ReturnType<typeof vi.fn> }).sketch_begin_gesture).toHaveBeenCalledTimes(1)
    expect((scene as unknown as { sketch_end_gesture: ReturnType<typeof vi.fn> }).sketch_end_gesture).toHaveBeenCalledTimes(1)
  })

  it('a stale cached sketch handle (sketch_plane reads undefined) is retargeted onto a fresh sketch before the gesture opens', () => {
    const { scene, segments } = makeWasmScene({ staleSketchHandles: [7n] })
    const preview = new THREE.Group()
    const onCommit = vi.fn()
    const onToast = vi.fn()
    // Seed the shared cache with a handle whose creating gesture was undone.
    const cache = makeSketchPlaneCache()
    cache.set(planeKey(groundDrawPlane()), 7n)
    const tool = new ArcTool(scene, preview, onCommit, onToast, vi.fn(), vi.fn(), cache)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)   // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)   // B
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY) // commit

    const beginGroundSketch = (scene as unknown as { begin_ground_sketch: ReturnType<typeof vi.fn> }).begin_ground_sketch
    const beginGesture = (scene as unknown as { sketch_begin_gesture: ReturnType<typeof vi.fn> }).sketch_begin_gesture
    // The pre-check minted ONE fresh sketch up front; the stale handle never
    // even opened a gesture (no failure-driven retry).
    expect(beginGroundSketch).toHaveBeenCalledTimes(1)
    expect(beginGesture).toHaveBeenCalledTimes(1)
    expect(beginGesture).toHaveBeenCalledWith(42n)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(segments.length).toBeGreaterThan(0)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('refuses to commit a flat bulge (|sagitta| below tolerance) and hints instead', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY) // B
    tool.onPointerDown(makeSnap({ x: 1, y: 0 }), RAY) // collinear "bulge" — refused

    expect(segments.length).toBe(0)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onMeasurement).toHaveBeenLastCalledWith('Pull out the bulge')

    // A real bulge afterwards still commits (the gesture was not aborted).
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('ignores a degenerate B click (zero-length chord)', () => {
    const { scene } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY) // A
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY) // B on A — ignored
    // Still waiting for B: this click becomes B, not a bulge commit.
    tool.onPointerDown(makeSnap({ x: 3, y: 1 }), RAY)
    expect(onCommit).not.toHaveBeenCalled()
    // And now the bulge click commits.
    tool.onPointerDown(makeSnap({ x: 2, y: 2 }), RAY)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('Escape steps back one stage at a time (bulge → chord → idle)', () => {
    const { scene } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    expect(tool.capturingInput()).toBe(false)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY) // B
    expect(tool.capturingInput()).toBe(true)

    tool.onKey(makeKeyEvent('Escape')) // bulge → chord (A kept)
    expect(tool.capturingInput()).toBe(true)

    // The next click is a NEW B, then a bulge click commits — proving the
    // stage went back to "waiting for B" with A preserved, not to idle.
    tool.onPointerDown(makeSnap({ x: 0, y: 2 }), RAY)  // new B
    tool.onPointerDown(makeSnap({ x: -0.5, y: 1 }), RAY) // bulge → commit
    expect(onCommit).toHaveBeenCalledTimes(1)

    tool.onKey(makeKeyEvent('Escape')) // idle → full cancel (no-op)
    expect(tool.capturingInput()).toBe(false)
  })

  it('reuses the same ground sketch across commits', () => {
    const { scene } = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)

    tool.onPointerDown(makeSnap({ x: 4, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 6, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 5, y: 1 }), RAY)

    expect((scene as unknown as { begin_ground_sketch: ReturnType<typeof vi.fn> }).begin_ground_sketch).toHaveBeenCalledTimes(1)
  })

  it('drops the cached sketch handle on onDocumentReset', () => {
    const { scene } = makeWasmScene()
    const { tool } = makeTool(scene)
    const beginSketch = (scene as unknown as { begin_ground_sketch: ReturnType<typeof vi.fn> }).begin_ground_sketch

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)
    expect(beginSketch).toHaveBeenCalledTimes(1)

    tool.onDocumentReset()

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)
    expect(beginSketch).toHaveBeenCalledTimes(2)
  })

  it('surfaces a kernel error from sketch_add_segment as a toast', () => {
    const { scene } = makeWasmScene({ addSegmentThrows: true })
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)

    expect(onCommit).not.toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast.mock.calls[0][1]).toBe('PathNotSimple')
  })

  it('reports the radius through onMeasurement while pulling the bulge', () => {
    const { scene } = makeWasmScene()
    const { tool, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 1 }), RAY) // semicircle: r = 1 m

    const last = onMeasurement.mock.calls.at(-1)?.[0] as string
    expect(last.startsWith('R ')).toBe(true)
    expect(last).toContain('1') // 1 m in the default unit format
  })
})

describe('ArcTool — completion modes (Alt cycles open → pie → segment)', () => {
  // Shared geometry: A=(0,0), B=(2,0), bulge (1, 0.5) → s=0.5, r=1.25,
  // center=(1, −0.75) (on the side opposite the bulge).
  const ARC = arcFromChord([0, 0], [2, 0], 0.5)!
  const ARC_SEGS = arcSegmentCount(ARC.sweep, ARC.radius)

  function drawToBulge(tool: ArcTool): void {
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)   // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)   // B
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY) // pull the bulge
  }

  it('pie (one Alt) closes B → center → A: two extra segments, exact wrap to A', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    drawToBulge(tool)
    tool.onKey(makeKeyEvent('Alt'))                     // open → pie
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY) // commit

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(segments.length).toBe(ARC_SEGS + 2)

    // B → center.
    expect(segments[ARC_SEGS][0]).toBe(2)
    expect(segments[ARC_SEGS][1]).toBe(0)
    expect(segments[ARC_SEGS][3]).toBeCloseTo(ARC.center[0], 12)
    expect(segments[ARC_SEGS][4]).toBeCloseTo(ARC.center[1], 12)
    // center → A, closing exactly on the first vertex.
    const last = segments[segments.length - 1]
    expect(last[3]).toBe(segments[0][0])
    expect(last[4]).toBe(segments[0][1])
    expect(last[5]).toBe(segments[0][2])

    // Arc AND closing segments land in ONE gesture — a single undo step.
    expect((scene as unknown as { sketch_begin_gesture: ReturnType<typeof vi.fn> }).sketch_begin_gesture).toHaveBeenCalledTimes(1)
    expect((scene as unknown as { sketch_end_gesture: ReturnType<typeof vi.fn> }).sketch_end_gesture).toHaveBeenCalledTimes(1)
  })

  it('segment (two Alts) closes with the chord B → A as one extra segment', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    drawToBulge(tool)
    tool.onKey(makeKeyEvent('Alt')) // open → pie
    tool.onKey(makeKeyEvent('Alt')) // pie → segment
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(segments.length).toBe(ARC_SEGS + 1)
    const last = segments[segments.length - 1]
    expect([last[0], last[1], last[2]]).toEqual([2, 0, 0])
    expect([last[3], last[4], last[5]]).toEqual([0, 0, 0])
  })

  it('a third Alt wraps back to an open arc', () => {
    const { scene, segments } = makeWasmScene()
    const { tool } = makeTool(scene)

    drawToBulge(tool)
    tool.onKey(makeKeyEvent('Alt'))
    tool.onKey(makeKeyEvent('Alt'))
    tool.onKey(makeKeyEvent('Alt'))
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)

    expect(segments.length).toBe(ARC_SEGS)
    const last = segments[segments.length - 1]
    expect(last[3]).not.toBe(segments[0][0]) // still an OPEN chain
  })

  it('Alt autorepeat does not spin the cycle', () => {
    const { scene, segments } = makeWasmScene()
    const { tool } = makeTool(scene)

    drawToBulge(tool)
    tool.onKey(makeKeyEvent('Alt'))
    tool.onKey(makeKeyEvent('Alt', { repeat: true })) // held key — ignored
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)

    expect(segments.length).toBe(ARC_SEGS + 2) // still pie, not segment
  })

  it('Alt outside a gesture is ignored (a fresh arc still commits open)', () => {
    const { scene, segments } = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onKey(makeKeyEvent('Alt')) // idle — not capturing, ignored
    drawToBulge(tool)
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)

    expect(segments.length).toBe(ARC_SEGS)
  })

  it('the mode persists across commits within the tool activation', () => {
    const { scene, segments } = makeWasmScene()
    const { tool } = makeTool(scene)

    drawToBulge(tool)
    tool.onKey(makeKeyEvent('Alt'))
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)
    expect(segments.length).toBe(ARC_SEGS + 2)

    tool.onPointerDown(makeSnap({ x: 4, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 6, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 5, y: 0.5 }), RAY)
    expect(segments.length).toBe(2 * (ARC_SEGS + 2)) // second arc closed too
  })

  it('Alt while a length is typed keeps the buffer visible, with the mode as suffix', () => {
    const { scene } = makeWasmScene()
    const { tool, onMeasurement } = makeTool(scene)

    drawToBulge(tool)
    typeDigits(tool, '0.5')
    tool.onKey(makeKeyEvent('Alt')) // open → pie — must not hide the buffer

    const last = onMeasurement.mock.calls.at(-1)?.[0] as string
    expect(last).toContain('0.5')
    expect(last).toContain('· Pie')
  })

  it('a typed bulge commit closes with the current mode too (shared commit path)', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    drawToBulge(tool)                                   // cursor at (1, 0.5) — side established
    tool.onKey(makeKeyEvent('Alt'))                     // open → pie
    typeDigits(tool, '0.5')
    tool.onKey(makeKeyEvent('Enter'))                   // |sagitta| = 0.5 on the +y side

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(segments.length).toBe(ARC_SEGS + 2)          // pie close via the typed path
    const last = segments[segments.length - 1]
    expect(last[3]).toBe(segments[0][0])
    expect(last[4]).toBe(segments[0][1])
  })

  it('onDocumentReset restores the default open mode', () => {
    const { scene, segments } = makeWasmScene()
    const { tool } = makeTool(scene)

    drawToBulge(tool)
    tool.onKey(makeKeyEvent('Alt'))                     // open → pie
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)
    expect(segments.length).toBe(ARC_SEGS + 2)

    tool.onDocumentReset()                              // new/loaded document

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)
    expect(segments.length).toBe(2 * ARC_SEGS + 2)      // second arc committed open
  })

  it('the radius readout names the mode while a closed preview is live', () => {
    const { scene } = makeWasmScene()
    const { tool, onMeasurement } = makeTool(scene)

    drawToBulge(tool)
    tool.onKey(makeKeyEvent('Alt'))
    expect(onMeasurement).toHaveBeenLastCalledWith('Pie')

    // The Viewport re-fires onPointerMove after onKey; the full readout
    // then carries the mode suffix.
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY)
    const last = onMeasurement.mock.calls.at(-1)?.[0] as string
    expect(last.startsWith('R ')).toBe(true)
    expect(last).toContain('· Pie')
  })

  it('face mode: pie imprints a closed loop via split_face_inner_with_arc with the center appended', () => {
    const pick = makePick(7n, 3n)
    const { scene, splitPaths, innerLoops } = makeWasmScene({ pick, facePlane: [0, 0, 1, 0, 0, 1], faceNormal: [0, 0, 1] })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)  // A
    tool.onPointerDown(makeSnap({ x: 1.5, y: 2, z: 1 }), RAY)  // B
    tool.onPointerMove(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)  // bulge toward −y
    tool.onKey(makeKeyEvent('Alt'))                            // open → pie
    tool.onPointerDown(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)  // commit

    expect(splitPaths.length).toBe(0) // no boundary-to-boundary cut
    expect(innerLoops.length).toBe(1)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)

    const loop = innerLoops[0]
    const nPts = loop.length / 3
    // First point is exactly A; the appended last point is the arc center —
    // on the face plane, and past the chord on the side opposite the bulge.
    expect(loop[0]).toBe(0.5)
    expect(loop[1]).toBe(2)
    expect(loop[(nPts - 1) * 3 + 2]).toBeCloseTo(1, 10)
    expect(loop[(nPts - 1) * 3 + 1]).toBeGreaterThan(2)
  })

  it('face mode: segment imprints the bare arc loop via split_face_inner_with_arc (implicit chord close)', () => {
    const pick = makePick(7n, 3n)
    const { scene, splitPaths, innerLoops } = makeWasmScene({ pick, facePlane: [0, 0, 1, 0, 0, 1], faceNormal: [0, 0, 1] })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1.5, y: 2, z: 1 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)
    tool.onKey(makeKeyEvent('Alt'))
    tool.onKey(makeKeyEvent('Alt')) // pie → segment
    tool.onPointerDown(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)

    expect(splitPaths.length).toBe(0)
    expect(innerLoops.length).toBe(1)

    const loop = innerLoops[0]
    const nPts = loop.length / 3
    // The loop is the arc itself, A…B — the chord closes implicitly.
    expect(loop[0]).toBe(0.5)
    expect(loop[1]).toBe(2)
    expect(loop[(nPts - 1) * 3 + 0]).toBe(1.5)
    expect(loop[(nPts - 1) * 3 + 1]).toBe(2)
  })
})

describe('ArcTool — typed VCB entry ', () => {
  it('chord stage: typed length commits B at that distance along the live cursor direction', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)   // A
    tool.onPointerMove(makeSnap({ x: 1, y: 0 }), RAY)   // establish +X direction
    typeDigits(tool, '5')
    tool.onKey(makeKeyEvent('Enter'))                   // commits B = (5, 0)

    // Now in the bulge stage with a=(0,0), b=(5,0) — commit via pointer.
    tool.onPointerDown(makeSnap({ x: 2.5, y: 1 }), RAY)
    expect(onCommit).toHaveBeenCalledTimes(1)

    expect(segments[0][0]).toBe(0)
    expect(segments[0][1]).toBe(0)
    expect(segments[segments.length - 1][3]).toBe(5)
    expect(segments[segments.length - 1][4]).toBe(0)
  })

  it('chord stage: typed commit is refused with no live cursor direction yet', () => {
    const { scene } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A — no pointer move yet
    typeDigits(tool, '5')
    tool.onKey(makeKeyEvent('Enter'))

    // Still waiting for B: an ordinary click now becomes B, not a bulge commit.
    tool.onPointerDown(makeSnap({ x: 3, y: 0 }), RAY)
    expect(onCommit).not.toHaveBeenCalled()
    tool.onPointerDown(makeSnap({ x: 1.5, y: 1 }), RAY) // bulge → commits
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('chord stage: a typed distance below ARC_MIN_CHORD_M is refused', () => {
    const { scene } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 0 }), RAY)
    typeDigits(tool, '0')
    tool.onKey(makeKeyEvent('Enter'))

    // Still waiting for B.
    tool.onPointerDown(makeSnap({ x: 3, y: 0 }), RAY)
    expect(onCommit).not.toHaveBeenCalled()
    tool.onPointerDown(makeSnap({ x: 1.5, y: 1 }), RAY)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('bulge stage: typed length sets |sagitta| on the side the live cursor is currently on', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY) // B — chord (0,0)-(2,0)
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY) // cursor on the +y side
    typeDigits(tool, '1')
    tool.onKey(makeKeyEvent('Enter')) // commits sagitta = +1 (the typed magnitude, +y side)

    expect(onCommit).toHaveBeenCalledTimes(1)
    // Every vertex lands on the +y (bulge) side, matching the live cursor's side.
    for (const s of segments) {
      expect(s[1]).toBeGreaterThanOrEqual(0)
      expect(s[4]).toBeGreaterThanOrEqual(0)
    }
    // The sagitta really is ~1 (not the ~0.5 the cursor itself was at) — the
    // typed distance overrides the live cursor's distance, only its side.
    const ys = segments.flatMap((s) => [s[1], s[4]])
    expect(Math.max(...ys)).toBeCloseTo(1, 6)
  })

  it('bulge stage: cursor exactly on the chord falls back to the last nonzero side seen', () => {
    const { scene, segments } = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY) // B
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY) // establish +y side
    tool.onPointerMove(makeSnap({ x: 1, y: 0 }), RAY)   // cursor now ON the chord
    typeDigits(tool, '1')
    tool.onKey(makeKeyEvent('Enter'))

    expect(onCommit).toHaveBeenCalledTimes(1)
    const ys = segments.flatMap((s) => [s[1], s[4]])
    expect(Math.max(...ys)).toBeCloseTo(1, 6) // committed on the remembered +y side
  })

  it('bulge stage: no side ever established refuses the typed commit (same hint as a flat pointer commit)', () => {
    const { scene } = makeWasmScene()
    const { tool, onCommit, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY) // B — no pointer move since
    typeDigits(tool, '1')
    tool.onKey(makeKeyEvent('Enter'))

    expect(onCommit).not.toHaveBeenCalled()
    expect(onMeasurement).toHaveBeenLastCalledWith('Pull out the bulge')

    // The gesture is still alive — a real pointer bulge still commits.
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('the typed buffer readout replaces the live measurement until committed', () => {
    const { scene } = makeWasmScene()
    const { tool, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 0 }), RAY)
    onMeasurement.mockClear()

    typeDigits(tool, '5')
    expect(onMeasurement).toHaveBeenLastCalledWith(expect.stringContaining('5'))

    // Further pointer movement must NOT clobber the typed readout.
    tool.onPointerMove(makeSnap({ x: 3, y: 0 }), RAY)
    expect(onMeasurement).toHaveBeenLastCalledWith(expect.stringContaining('5'))
  })
})

describe('ArcTool — face mode', () => {
  const pick = () => makePick(7n, 3n)

  function primeFaceTool(opts: Parameters<typeof makeWasmScene>[0] = {}) {
    const made = makeWasmScene({ pick: pick(), facePlane: [0, 0, 1, 0, 0, 1], faceNormal: [0, 0, 1], ...opts })
    const t = makeTool(made.scene)
    t.tool.setEditContext({ kind: 'object', id: 7n })
    return { ...made, ...t }
  }

  it('three clicks commit one split_face_with_arc whose path endpoints are exactly A and B', () => {
    const { tool, onFaceImprint, splitPaths, scene } = primeFaceTool()

    // All snaps on the z=1 face plane.
    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)   // A on the boundary
    tool.onPointerDown(makeSnap({ x: 1.5, y: 2, z: 1 }), RAY)   // B on the boundary
    tool.onPointerDown(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)   // bulge into the face

    expect((scene as unknown as { split_face_with_arc: ReturnType<typeof vi.fn> }).split_face_with_arc).toHaveBeenCalledTimes(1)
    expect((scene as unknown as { split_face: ReturnType<typeof vi.fn> }).split_face).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)

    const path = splitPaths[0]
    expect(path.length % 3).toBe(0)
    const nPts = path.length / 3
    expect(nPts).toBeGreaterThanOrEqual(3)
    // Exact endpoints.
    expect(path[0]).toBe(0.5)
    expect(path[1]).toBe(2)
    expect(path[2]).toBe(1)
    expect(path[(nPts - 1) * 3 + 0]).toBe(1.5)
    expect(path[(nPts - 1) * 3 + 1]).toBe(2)
    expect(path[(nPts - 1) * 3 + 2]).toBe(1)
    // Every interior vertex stays on the face plane (z = 1) and bulges toward −y.
    for (let i = 1; i < nPts - 1; i++) {
      expect(path[i * 3 + 2]).toBeCloseTo(1, 10)
      expect(path[i * 3 + 1]).toBeLessThan(2)
    }
  })

  it('ignores a first click on a face of a different object', () => {
    const { scene } = makeWasmScene({ pick: makePick(9n, 3n) })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)
    expect(tool.capturingInput()).toBe(false)
  })

  it('surfaces a kernel error from split_face as a toast', () => {
    const { tool, onFaceImprint, onToast } = primeFaceTool({ splitFaceThrows: true })

    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1.5, y: 2, z: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)

    expect(onFaceImprint).not.toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast.mock.calls[0][1]).toBe('BadLoop')
  })

  it('snapConstraint locks to the face plane once the gesture starts', () => {
    const { tool } = primeFaceTool()

    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)
    const constraint = tool.snapConstraint(RAY)
    expect(constraint?.constraintPlane?.point).toEqual([0.5, 2, 1])
    expect(constraint?.constraintPlane?.normal).toEqual([0, 0, 1])
  })
})

describe('ArcTool — instance editing context (component-edit-parity.md phase A2)', () => {
  const INSTANCE = 42n
  const COMPONENT = 5n

  function primeInstanceFaceTool(opts: Parameters<typeof makeWasmScene>[0] = {}) {
    const made = makeWasmScene({
      pick: makePick(7n, 3n, INSTANCE),
      facePlane: [0, 0, 1, 0, 0, 1],
      faceNormal: [0, 0, 1],
      ...opts,
    })
    const t = makeTool(made.scene)
    t.tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })
    t.tool.setFaceEligibility((_object, instance) => instance === INSTANCE)
    return { ...made, ...t }
  }

  it('an OPEN (boundary-to-boundary) face cut routes to split_face_with_arc_in_instance, never the world split_face_with_arc', () => {
    const { tool, onFaceImprint, splitPaths, scene } = primeInstanceFaceTool()

    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1.5, y: 2, z: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)

    expect(scene.split_face_with_arc_in_instance).toHaveBeenCalledTimes(1)
    const [instance, object, face] = (scene.split_face_with_arc_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(instance).toBe(INSTANCE)
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    expect(scene.split_face_with_arc).not.toHaveBeenCalled()
    expect(scene.split_face_in_instance).not.toHaveBeenCalled()
    expect(scene.split_face).not.toHaveBeenCalled()
    expect(splitPaths.length).toBe(1)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('a CLOSED (pie) face cut routes to split_face_inner_with_arc_in_instance, never the world split_face_inner_with_arc', () => {
    const { tool, onFaceImprint, innerLoops, scene } = primeInstanceFaceTool()

    tool.onPointerDown(makeSnap({ x: 0.5, y: 2, z: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1.5, y: 2, z: 1 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)
    tool.onKey(makeKeyEvent('Alt')) // open → pie
    tool.onPointerDown(makeSnap({ x: 1, y: 1.6, z: 1 }), RAY)

    expect(scene.split_face_inner_with_arc_in_instance).toHaveBeenCalledTimes(1)
    const [instance, object, face] = (scene.split_face_inner_with_arc_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(instance).toBe(INSTANCE)
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    expect(scene.split_face_inner_with_arc).not.toHaveBeenCalled()
    expect(scene.split_face_inner_in_instance).not.toHaveBeenCalled()
    expect(scene.split_face_inner).not.toHaveBeenCalled()
    expect(innerLoops.length).toBe(1)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('plane mode on empty space mints a def-owned sketch via begin_sketch_on_plane_in_instance', () => {
    const { scene } = makeWasmScene()
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })

    tool.onPointerDown(makeSnap({ x: 6, y: 1, z: 0 }), { origin: [6, 1, 5], direction: [0, 0, -1] })
    tool.onPointerDown(makeSnap({ x: 9, y: 1, z: 0 }), { origin: [9, 1, 5], direction: [0, 0, -1] })
    tool.onPointerDown(makeSnap({ x: 7.5, y: 2, z: 0 }), { origin: [7.5, 2, 5], direction: [0, 0, -1] })

    expect(scene.begin_sketch_on_plane_in_instance).toHaveBeenCalledTimes(1)
    expect(scene.begin_ground_sketch).not.toHaveBeenCalled()
  })
})

describe('ArcTool — status hint', () => {
  it('tracks the gesture stage: first endpoint → second endpoint → bulge → idle again', () => {
    const { scene } = makeWasmScene()
    const { tool } = makeTool(scene)

    expect(tool.statusHint()).toContain('first endpoint')
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A
    expect(tool.statusHint()).toContain('second endpoint')
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY) // B
    expect(tool.statusHint()).toContain('Alt cycles')
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY) // commit
    // Committed: the retype window offers to redraw the arc at a typed
    // bulge; Escape closes it and the idle hint returns.
    expect(tool.statusHint()).toContain('redraw the arc')
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(tool.statusHint()).toContain('first endpoint')
  })
})

// Post-click bulge retype (retypeWindow.ts): a length typed after the third
// click redraws the arc at that sagitta, same chord, same side.
describe('ArcTool — retype the bulge after the third click', () => {
  function makeRetypeScene(opts: Parameters<typeof makeWasmScene>[0] = {}) {
    const base = makeWasmScene(opts).scene as unknown as Record<string, unknown>
    let gen = 1n
    let changed = 0
    const baseAdd = base.sketch_add_segment as (...args: unknown[]) => unknown
    const scene = {
      ...base,
      history_generation: vi.fn(() => gen),
      sketch_begin_gesture: vi.fn(() => { changed = 0 }),
      sketch_add_segment: vi.fn((...args: unknown[]) => { const r = baseAdd(...args); changed += 1; return r }),
      sketch_end_gesture: vi.fn(() => { if (changed > 0) gen += 1n }),
      scene_undo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
      scene_redo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
    }
    return scene as unknown as WasmScene
  }
  const key = (tool: ArcTool, k: string) => tool.onKey(makeKeyEvent(k))
  const typeIn = (tool: ArcTool, text: string) => { for (const ch of text) key(tool, ch); key(tool, 'Enter') }
  const addCalls = (scene: WasmScene) => (scene.sketch_add_segment as ReturnType<typeof vi.fn>).mock.calls
  /** Extreme y among the segment endpoints committed since `from` — the apex of a chord on y=0. */
  const apexY = (scene: WasmScene, from: number, sign: 1 | -1) => {
    const ys = addCalls(scene).slice(from).flatMap((k) => [k[2] as number, k[5] as number])
    return sign > 0 ? Math.max(...ys) : Math.min(...ys)
  }

  it('typing a bulge after the commit redraws the arc at that sagitta on the same side', () => {
    const scene = makeRetypeScene()
    const { tool, onCommit } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY) // A
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY) // B
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY) // commit, bulge toward +y
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(apexY(scene, 0, 1)).toBeCloseTo(0.5, 2)
    expect(tool.capturesKey('1')).toBe(true)
    const from = addCalls(scene).length
    typeIn(tool, '1')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(2)
    // Apex now ~1 above the chord, still on +y; chord endpoints unchanged.
    expect(apexY(scene, from, 1)).toBeCloseTo(1, 2)
    expect(apexY(scene, from, -1)).toBeCloseTo(0, 6)
    const xs = addCalls(scene).slice(from).flatMap((k) => [k[1] as number, k[4] as number])
    expect(Math.min(...xs)).toBeCloseTo(0, 6)
    expect(Math.max(...xs)).toBeCloseTo(2, 6)
  })

  it('an arc drawn to the −y side retypes to the −y side', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: -0.5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: -0.5 }), RAY)
    const from = addCalls(scene).length
    typeIn(tool, '0.8')
    expect(apexY(scene, from, -1)).toBeCloseTo(-0.8, 2)
    expect(apexY(scene, from, 1)).toBeCloseTo(0, 6)
  })

  it('a flat typed bulge is refused up front — nothing undone, the hint shows', () => {
    const scene = makeRetypeScene()
    const { tool, onMeasurement } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 1, y: 0.5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0.5 }), RAY)
    typeIn(tool, '0')
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(onMeasurement).toHaveBeenLastCalledWith(expect.stringContaining('bulge'))
  })
})

// Boundary-click fix: a click on an object's edge/vertex misses `pick_face`
// outright (strict polygon test at the boundary) — `_facePickAt` falls back
// to the ranked boundary pick (`FacePickCache.faceThrough`) instead of
// silently sending the whole gesture to the ground plane.
describe('ArcTool — boundary clicks (FacePickCache.faceThrough)', () => {
  function makeBoundaryScene(pick: ReturnType<typeof makePick>) {
    const made = makeWasmScene({ faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    ;(made.scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(
      (_ox: number, _oy: number, _oz: number, dx: number, dy: number, dz: number) =>
        dx === 0 && dy === 0 && dz === -1 ? undefined : pick,
    )
    return made
  }

  it('a click on a midpoint snap (pick_face misses the exact ray) still anchors FACE mode, not the ground', () => {
    const { scene, segments, splitPaths } = makeBoundaryScene(makePick(7n, 3n))
    const { tool, onFaceImprint, onCommit } = makeTool(scene)

    const boundarySnap = makeSnap({ x: 0.5, y: 2, z: 1, kind: 'midpoint', object: 7n, element: 5n, elementKind: 'edge' })
    tool.onPointerDown(boundarySnap, RAY) // A, exactly on the boundary
    expect(tool.capturingInput()).toBe(true) // anchored — not silently dropped

    tool.onPointerDown(makeSnap({ x: 1.5, y: 2, z: 1 }), { origin: [1.5, 2, 5], direction: [0, 0, -1] }) // B
    tool.onPointerDown(makeSnap({ x: 1, y: 1.6, z: 1 }), { origin: [1, 1.6, 5], direction: [0, 0, -1] }) // bulge → commit

    expect(splitPaths.length).toBe(1) // the FACE split path
    expect(segments.length).toBe(0) // never fell through to a ground/plane sketch
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

// Snapped face cursor fix: face mode used to project the ray onto the face
// plane unconditionally, ignoring whatever the snap chip claimed.
// `_faceCursor` now honours an on-plane snap exactly (this was ALREADY
// ArcTool's behaviour for a bare snap — the fix adds the on-plane guard so
// an off-plane snap still falls back to the ray, like the other draw tools).
describe('ArcTool — snapped face cursor (honours the chip, not ray∩plane)', () => {
  it('the chord endpoint B lands on the snap, not the sub-millimeter-off ray∩plane point', () => {
    const pick = makePick(7n, 3n)
    const { scene, splitPaths } = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1 }), RAY) // A
    // The chord endpoint's snap sits exactly at (4,0,1); the ray it
    // travelled along would land 5mm further out on the SAME plane — a
    // deliberately different point the fix must NOT use.
    tool.onPointerDown(
      makeSnap({ x: 4, y: 0, z: 1, kind: 'endpoint' }),
      { origin: [4.005, 0, 5], direction: [0, 0, -1] },
    ) // B
    tool.onPointerDown(makeSnap({ x: 2, y: 1, z: 1 }), { origin: [2, 1, 5], direction: [0, 0, -1] }) // bulge → commit

    expect(splitPaths.length).toBe(1)
    const path = splitPaths[0]
    const n = path.length / 3
    // `arcPolylineOnPlane` always ends the chain on the EXACT chord endpoint
    // it was built with, so the committed path's last vertex reflects
    // exactly what `_faceCursor` resolved B to.
    expect(path[(n - 1) * 3 + 0]).toBeCloseTo(4, 6)
    expect(path[(n - 1) * 3 + 1]).toBeCloseTo(0, 6)
  })
})

// Shift-pinned drawing plane (GitHub issue 14 / planePin.ts): pressing Shift
// while hovering a face pins that face's plane for the next gesture, even
// once the cursor leaves the face entirely.
describe('ArcTool — Shift-pinned drawing plane (GitHub issue 14)', () => {
  it('pins the hovered face plane; a later click over empty space anchors plane mode on it', () => {
    const pick = makePick(7n, 3n)
    // Face at z=1, normal +Z — a genuinely non-ground plane. `pick_face`
    // hits only under the original hover ray, so the later clicks are
    // genuinely over empty space, not merely ignored by the mode dispatch.
    const { scene, segments } = makeWasmScene({ faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(
      (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) =>
        ox === 0 && oy === 0 && oz === 5 && dx === 0 && dy === 0 && dz === -1 ? pick : undefined,
    )
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    const emptyRay: Ray = { origin: [10, 10, 5], direction: [0, 0, -1] }
    expect(tool.snapConstraint(emptyRay)?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })

    // A, B, bulge — all over empty space, all on the pinned plane.
    tool.onPointerDown(makeSnap({ x: 10, y: 10, z: 1 }), emptyRay) // A
    tool.onPointerDown(makeSnap({ x: 13, y: 10, z: 1 }), { origin: [13, 10, 5], direction: [0, 0, -1] }) // B
    tool.onPointerDown(makeSnap({ x: 11.5, y: 11, z: 1 }), { origin: [11.5, 11, 5], direction: [0, 0, -1] }) // bulge

    expect(scene.begin_ground_sketch).not.toHaveBeenCalled() // z=1 is not the ground plane
    expect(scene.begin_sketch_on_plane).toHaveBeenCalledTimes(1)
    expect(segments.length).toBeGreaterThan(0) // a real plane-mode chain committed
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a second Shift press releases the pin; autorepeat (Shift held) does not toggle twice', () => {
    const pick = makePick(7n, 3n)
    const { scene } = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.setShiftHeld(true)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.setShiftHeld(false)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).not.toContain('Pinned')
  })

  it('Escape while idle clears the pin', () => {
    const pick = makePick(7n, 3n)
    const { scene } = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.onKey(makeKeyEvent('Escape'))
    expect(tool.statusHint()).not.toContain('Pinned')
    expect(tool.hasArmedGesture()).toBe(false)
  })
})
