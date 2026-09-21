import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { CircleTool } from './CircleTool'
import { makeSketchPlaneCache } from './sketchGesture'
import { groundDrawPlane, planeKey } from './drawPlane'
import { segmentsPerTurn } from './arcMath'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

// A ray straight down the -Z axis from above the origin (tuple-shaped, as the
// real Viewport supplies — the tool indexes ray.origin[0..2]).
const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

function makeKeyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: () => {} } as unknown as KeyboardEvent
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

/**
 * Minimal WasmScene stub — only the members CircleTool calls.
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
} = {}): WasmScene {
  let sketchCounter = 41n
  return {
    history_generation: vi.fn(() => 1n),
    begin_ground_sketch: vi.fn(() => {
      sketchCounter += 1n
      return sketchCounter
    }),
    begin_sketch_on_plane: vi.fn(() => {
      sketchCounter += 1n
      return sketchCounter
    }),
    // Every non-stale sketch lies on the ground plane (origin point, +Z).
    sketch_locked: () => false,
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
    sketch_add_segment: vi.fn(() => {
      if (opts.addSegmentThrows) throw new Error('PathNotSimple: edges cross')
      return {
        new_edges: () => new BigUint64Array([]),
        regions_created: () => new BigUint64Array([]),
        regions_removed: () => new BigUint64Array([]),
        free: vi.fn(),
      }
    }),
    pick_face: vi.fn(() => opts.pick),
    pick_sketch: vi.fn(() => undefined), // no committed sketches in these fixtures
    // Every picked object is plain/ungrouped by default (top-level eligibility).
    node_parent: vi.fn(() => undefined),
    face_normal: vi.fn(() => new Float64Array(opts.faceNormal ?? [0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array(opts.facePlane ?? [0, 0, 0, 0, 0, 1])),
    split_face_inner: vi.fn(() => {
      if (opts.splitFaceThrows) throw new Error('LoopSelfIntersects: edges cross')
      return 99n
    }),
    split_face_inner_with_curve: vi.fn(() => {
      if (opts.splitFaceThrows) throw new Error('LoopSelfIntersects: edges cross')
      return 99n
    }),
    split_face_inner_in_instance: vi.fn(() => 99n),
    split_face_inner_with_curve_in_instance: vi.fn(() => 99n),
    begin_sketch_on_plane_in_instance: vi.fn(() => {
      sketchCounter += 1n
      return sketchCounter
    }),
    instance_pose: vi.fn(() => new Float64Array([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0])), // translated +5 in x
  } as unknown as WasmScene
}

function makeTool(scene: WasmScene) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onFaceImprint = vi.fn()
  const onMeasurement = vi.fn()
  const tool = new CircleTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, preview, onCommit, onToast, onFaceImprint, onMeasurement }
}

describe('CircleTool — ground mode', () => {
  it('two clicks (center, rim) commit N chained segments and call onCommit', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // rim, radius 3

    expect(scene.begin_ground_sketch).toHaveBeenCalledTimes(1)
    // Adaptive facet count (true-curves §6): radius 3 caps at 96 per turn.
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(segmentsPerTurn(3))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: 42n, regionsCreated: [] })
    expect(onToast).not.toHaveBeenCalled()
    // The whole N-segment commit is bracketed in exactly one gesture.
    expect(scene.sketch_begin_gesture).toHaveBeenCalledTimes(1)
    expect(scene.sketch_begin_gesture).toHaveBeenCalledWith(42n)
    expect(scene.sketch_end_gesture).toHaveBeenCalledTimes(1)
    expect(scene.sketch_end_gesture).toHaveBeenCalledWith(42n)
  })

  it('the last segment closes back to the exact stored vertex 0 coordinates', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 5, y: 0, z: 0 }), RAY)

    const calls = (scene.sketch_add_segment as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(segmentsPerTurn(5))
    // First call's "p" (args 1-3) is vertex 0; last call's "q" (args 4-6) must match exactly.
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    const lastQ = [calls[calls.length - 1][4], calls[calls.length - 1][5], calls[calls.length - 1][6]]
    expect(lastQ).toEqual(firstP)
    // Vertex 0 is exactly the rim point (5, 0, 0).
    expect(firstP).toEqual([5, 0, 0])
  })

  it('a degenerate (zero-radius) second click is skipped — no segments, no commit', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 1, y: 1, z: 0 }), RAY) // same point — degenerate

    expect(scene.sketch_add_segment).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    // Still anchored (first click stands) — capturingInput stays true.
    expect(tool.capturingInput()).toBe(true)
  })

  it('reuses the cached sketch handle across multiple circles', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 10, y: 10, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 12, y: 10, z: 0 }), RAY)

    expect(scene.begin_ground_sketch).toHaveBeenCalledTimes(1)
  })

  it('a refused commit (kernel throws) toasts and does not call onCommit', () => {
    const scene = makeWasmScene({ addSegmentThrows: true })
    const { tool, onCommit, onToast } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY)

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a stale cached sketch handle (sketch_plane reads undefined) is retargeted onto a fresh sketch before the gesture opens', () => {
    const scene = makeWasmScene({ staleSketchHandles: [7n] })
    const preview = new THREE.Group()
    const onCommit = vi.fn()
    const onToast = vi.fn()
    // Seed the shared cache with a handle whose creating gesture was undone.
    const cache = makeSketchPlaneCache()
    cache.set(planeKey(groundDrawPlane()), 7n)
    const tool = new CircleTool(scene, preview, onCommit, onToast, vi.fn(), vi.fn(), cache)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), RAY) // rim — commits

    // The pre-check minted ONE fresh sketch up front; the stale handle never
    // even opened a gesture (no failure-driven retry).
    expect(scene.begin_ground_sketch).toHaveBeenCalledTimes(1)
    expect(scene.sketch_begin_gesture).toHaveBeenCalledTimes(1)
    expect(scene.sketch_begin_gesture).toHaveBeenCalledWith(42n)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ sketchHandle: 42n, regionsCreated: [] })
    expect(scene.sketch_end_gesture).toHaveBeenCalledWith(42n)
    expect(onToast).not.toHaveBeenCalled()
  })
})

describe('CircleTool — typed VCB radius entry', () => {
  it('typing a radius and pressing Enter commits an exact-radius circle', () => {
    const scene = makeWasmScene()
    const { tool, onCommit, onMeasurement } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    expect(tool.capturingInput()).toBe(true)

    tool.onKey(makeKeyEvent('5'))
    expect(onMeasurement).toHaveBeenCalled()

    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(segmentsPerTurn(5))
    expect(onCommit).toHaveBeenCalledTimes(1)
    // Default direction (+X) since cursor hasn't moved: vertex 0 should be (5, 0, 0).
    const calls = (scene.sketch_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    expect(firstP[0]).toBeCloseTo(5)
    expect(firstP[1]).toBeCloseTo(0)
  })

  it('typed radius follows the last rubber-band cursor direction', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center
    tool.onPointerMove(makeSnap({ x: 0, y: -1, z: 0 }), RAY) // cursor toward -Y

    tool.onKey(makeKeyEvent('2'))
    tool.onKey(makeKeyEvent('Enter'))

    const calls = (scene.sketch_add_segment as ReturnType<typeof vi.fn>).mock.calls
    const firstP = [calls[0][1], calls[0][2], calls[0][3]]
    expect(firstP[0]).toBeCloseTo(0)
    expect(firstP[1]).toBeCloseTo(-2)
  })

  it('Enter with an empty buffer does nothing (no commit)', () => {
    const scene = makeWasmScene()
    const { tool, onCommit } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onKey(makeKeyEvent('Enter'))

    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('CircleTool — face mode', () => {
  it('two clicks on an entered object face call split_face_inner_with_curve carrying the circle', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    const { tool, onFaceImprint, onToast } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // center on face
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] }) // rim click

    // Plain imprint is NOT used — the identity-carrying variant is.
    expect(scene.split_face_inner).not.toHaveBeenCalled()
    expect(scene.split_face_inner_with_curve).toHaveBeenCalledTimes(1)
    const callArgs = (scene.split_face_inner_with_curve as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe(7n)
    expect(callArgs[1]).toBe(3n)
    const loopPts = callArgs[2] as Float64Array
    expect(loopPts.length).toBe(segmentsPerTurn(3) * 3)
    // center (0,0,0) and radius 3 travel with the imprint.
    const centerArg = callArgs[3] as Float64Array
    expect(Array.from(centerArg)).toEqual([0, 0, 0])
    expect(callArgs[4]).toBeCloseTo(3)
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a pick on a different object than the active context is ignored', () => {
    const pick = makePick(999n, 3n) // not the active context (7n)
    const scene = makeWasmScene({ pick })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    expect(tool.capturingInput()).toBe(false)
  })

  it('a refused split_face_inner toasts the kernel error and does not call onFaceImprint', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, splitFaceThrows: true })
    const { tool, onFaceImprint, onToast } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] })

    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onFaceImprint).not.toHaveBeenCalled()
  })
})

describe('CircleTool — cancel', () => {
  it('Escape after the first click cancels and clears the preview', () => {
    const scene = makeWasmScene()
    const { tool, preview } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerMove(makeSnap({ x: 3, y: 0, z: 0 }), RAY)
    expect(preview.children.length).toBeGreaterThan(0)

    tool.onKey(makeKeyEvent('Escape'))

    expect(tool.capturingInput()).toBe(false)
    expect(preview.children).toHaveLength(0)
  })

  it('Escape before any click is a no-op cancel (idle stays idle)', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    tool.onKey(makeKeyEvent('Escape'))
    expect(tool.capturingInput()).toBe(false)
  })
})

describe('CircleTool — capturingInput scoping', () => {
  it('is false when idle (so tool-switch shortcuts are not swallowed)', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    expect(tool.capturingInput()).toBe(false)
  })

  it('becomes true only after a center is anchored', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    expect(tool.capturingInput()).toBe(false)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    expect(tool.capturingInput()).toBe(true)
  })
})

describe('CircleTool — instance editing context (component-edit-parity.md phase A2)', () => {
  const INSTANCE = 42n
  const COMPONENT = 5n

  it('face mode routes to split_face_inner_with_curve_in_instance, never the world variant', () => {
    const pick = makePick(7n, 3n, INSTANCE)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })
    tool.setFaceEligibility((_object, instance) => instance === INSTANCE)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] })

    expect(scene.split_face_inner_with_curve_in_instance).toHaveBeenCalledTimes(1)
    const callArgs = (scene.split_face_inner_with_curve_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe(INSTANCE)
    expect(callArgs[1]).toBe(7n)
    expect(callArgs[2]).toBe(3n)
    expect(scene.split_face_inner_with_curve).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('plane mode on empty space mints a def-owned sketch, mapping the curve center into local space', () => {
    const scene = makeWasmScene()
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })

    // Center at world (6,1,0), rim 3 away — identity-plane (ground), so no
    // idle lock needed to reach plane mode inside the instance context.
    tool.onPointerDown(makeSnap({ x: 6, y: 1, z: 0 }), { origin: [6, 1, 5], direction: [0, 0, -1] })
    tool.onPointerDown(makeSnap({ x: 9, y: 1, z: 0 }), { origin: [9, 1, 5], direction: [0, 0, -1] })

    expect(scene.begin_sketch_on_plane_in_instance).toHaveBeenCalledTimes(1)
    expect(scene.begin_ground_sketch).not.toHaveBeenCalled()
    // The curve's analytic center travels mapped into LOCAL space: world
    // (6,1,0) → local (1,1,0) under the pose⁻¹ of a +5-in-x translation.
    expect(scene.sketch_begin_curve_with).toHaveBeenCalledWith(
      expect.any(BigInt), 1, 1, 0, expect.closeTo(3, 6),
    )
  })
})

// Post-click radius retype (retypeWindow.ts): type a radius after the rim
// click and the circle just drawn redraws at that radius.
describe('CircleTool — retype the radius after the rim click', () => {
  function makeRetypeScene(opts: Parameters<typeof makeWasmScene>[0] = {}) {
    const base = makeWasmScene(opts) as unknown as Record<string, unknown>
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
      __bump: () => { gen += 1n },
    }
    return scene as unknown as WasmScene & { __bump(): void }
  }
  const key = (tool: CircleTool, k: string) => tool.onKey(makeKeyEvent(k))
  const typeLen = (tool: CircleTool, text: string) => { for (const ch of text) key(tool, ch); key(tool, 'Enter') }
  const addCalls = (scene: WasmScene) => (scene.sketch_add_segment as ReturnType<typeof vi.fn>).mock.calls
  /** Max distance of the segment endpoints committed since call index `from`
   *  to `center` — the radius actually drawn by that commit. */
  function drawnRadius(scene: WasmScene, from: number, center: [number, number]): number {
    const calls = addCalls(scene).slice(from)
    return Math.max(...calls.map((c) => Math.hypot((c[1] as number) - center[0], (c[2] as number) - center[1])))
  }

  it('two clicks then a typed radius: one undo, then the circle redrawn at that radius around the same centre, keeping its direction', () => {
    const scene = makeRetypeScene()
    const { tool, onCommit } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 1, y: 1 }), RAY)
    tool.onPointerDown(makeSnap({ x: 2, y: 1 }), RAY) // rim toward +x, radius 1
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(tool.statusHint()).toContain('resize the circle')
    expect(tool.capturesKey('3')).toBe(true)
    expect(tool.capturesKey('c')).toBe(false) // empty buffer: shortcuts still work
    let from = addCalls(scene).length
    typeLen(tool, '3')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(drawnRadius(scene, from, [1, 1])).toBeCloseTo(3, 6)
    // The rim vertex (vertex 0 of the chain) still sits on the +x side of the centre.
    const first = addCalls(scene)[from]
    expect(first[1]).toBeCloseTo(4, 6)
    expect(first[2]).toBeCloseTo(1, 6)
    // Still open: a second radius goes through too.
    from = addCalls(scene).length
    typeLen(tool, '0.5')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(drawnRadius(scene, from, [1, 1])).toBeCloseTo(0.5, 6)
  })

  it('a typed (Enter) rim commit arms the window as well', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    typeLen(tool, '2')
    const from = addCalls(scene).length
    typeLen(tool, '1')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(drawnRadius(scene, from, [0, 0])).toBeCloseTo(1, 6)
  })

  it('Escape drops an open buffer and closes the window; a new click closes it too', () => {
    const scene = makeRetypeScene()
    const { tool, onMeasurement } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0 }), RAY)
    key(tool, '3')
    expect(tool.hasArmedGesture()).toBe(true)
    key(tool, 'Escape')
    expect(onMeasurement).toHaveBeenLastCalledWith('')
    expect(tool.capturesKey('3')).toBe(false)
    tool.onPointerDown(makeSnap({ x: 5, y: 5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 6, y: 5 }), RAY)
    tool.onPointerDown(makeSnap({ x: 9, y: 9 }), RAY) // first click of a third circle
    expect(tool.capturingInput()).toBe(true)
    typeLen(tool, '2')
    expect(scene.scene_undo).not.toHaveBeenCalled() // a fresh commit, not a retype
  })

  it('an intervening action makes the retype stale: a toast, nothing undone', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0 }), RAY)
    tool.onPointerDown(makeSnap({ x: 1, y: 0 }), RAY)
    scene.__bump()
    typeLen(tool, '3')
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('circle'))
  })

  it('a face circle retypes through split_face_inner_with_curve with the new radius', () => {
    const scene = makeRetypeScene({ pick: makePick(7n, 3n), faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), RAY) // centre
    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 0 }), { origin: [1, 0, 5], direction: [0, 0, -1] }) // rim, radius 1
    expect(scene.split_face_inner_with_curve).toHaveBeenCalledTimes(1)
    typeLen(tool, '2.5')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.split_face_inner_with_curve).toHaveBeenCalledTimes(2)
    const call = (scene.split_face_inner_with_curve as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(call[4]).toBeCloseTo(2.5, 6) // radius argument
    expect(onFaceImprint).toHaveBeenCalledTimes(2)
  })
})

// Boundary-click fix: a click on an object's edge/vertex misses `pick_face`
// outright (strict polygon test at the boundary) — `_facePickAt` falls back
// to the ranked boundary pick (`FacePickCache.faceThrough`) instead of
// silently sending the whole gesture to the ground plane.
describe('CircleTool — boundary clicks (FacePickCache.faceThrough)', () => {
  /** `pick_face` misses on the exact base-ray direction (the boundary click)
   *  but hits `pick` on any other (nudged) direction — mirrors a real
   *  boundary miss where the ring probes around the ray find the face. */
  function makeBoundaryScene(pick: ReturnType<typeof makePick>) {
    const scene = makeWasmScene({ faceNormal: [0, 0, 1], facePlane: [0, 0, 0, 0, 0, 1] })
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(
      (_ox: number, _oy: number, _oz: number, dx: number, dy: number, dz: number) =>
        dx === 0 && dy === 0 && dz === -1 ? undefined : pick,
    )
    return scene
  }

  it('a click on a midpoint snap (pick_face misses the exact ray) still anchors FACE mode, not the ground', () => {
    const scene = makeBoundaryScene(makePick(7n, 3n))
    const { tool, onCommit, onFaceImprint } = makeTool(scene)

    const boundarySnap = makeSnap({ x: 0, y: 0, z: 0, kind: 'midpoint', object: 7n, element: 5n, elementKind: 'edge' })
    tool.onPointerDown(boundarySnap, RAY) // first click, exactly on the boundary
    expect(tool.capturingInput()).toBe(true) // anchored — not silently dropped

    tool.onPointerDown(makeSnap({ x: 3, y: 0, z: 0 }), { origin: [3, 0, 5], direction: [0, 0, -1] }) // rim

    // The commit went through the FACE split path, never a ground sketch.
    expect(scene.split_face_inner_with_curve).toHaveBeenCalledTimes(1)
    expect(scene.begin_ground_sketch).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

// Snapped face cursor fix: face mode used to project the ray onto the face
// plane unconditionally for the rubber band AND the commit, ignoring
// whatever the snap chip claimed. `_faceCursor` now honours an on-plane snap
// exactly.
describe('CircleTool — snapped face cursor (honours the chip, not ray∩plane)', () => {
  it('the rim commit lands on the snap, not the sub-millimeter-off ray∩plane point', () => {
    // Face at z=1, normal +Z.
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1 }), RAY) // centre
    // The rim click's snap sits exactly 3m out; the ray it travelled along
    // would land 5mm further out on the SAME plane — a deliberately
    // different point the fix must NOT use.
    tool.onPointerDown(
      makeSnap({ x: 3, y: 0, z: 1, kind: 'endpoint' }),
      { origin: [3.005, 0, 5], direction: [0, 0, -1] },
    )

    expect(scene.split_face_inner_with_curve).toHaveBeenCalledTimes(1)
    const call = (scene.split_face_inner_with_curve as ReturnType<typeof vi.fn>).mock.calls[0]
    // Radius argument: exactly 3 (the snap), not ~3.005 (the ray∩plane miss).
    expect(call[4]).toBeCloseTo(3, 6)
    const loopPts = call[2] as Float64Array
    // vertex 0 of the loop is the rim point itself.
    expect(loopPts[0]).toBeCloseTo(3, 6)
    expect(loopPts[1]).toBeCloseTo(0, 6)
  })
})

// Shift-pinned drawing plane (GitHub issue 14 / planePin.ts): pressing Shift
// while hovering a face pins that face's plane for the next gesture, even
// once the cursor leaves the face entirely.
describe('CircleTool — Shift-pinned drawing plane (GitHub issue 14)', () => {
  it('pins the hovered face plane; a later click over empty space anchors plane mode on it', () => {
    const pick = makePick(7n, 3n)
    // Face at z=1, normal +Z — a genuinely non-ground plane. `pick_face`
    // hits only under the original hover ray, so the later clicks are
    // genuinely over empty space, not merely ignored by the mode dispatch.
    const scene = makeWasmScene({ faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(
      (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) =>
        ox === 0 && oy === 0 && oz === 5 && dx === 0 && dy === 0 && dz === -1 ? pick : undefined,
    )
    const { tool, onCommit } = makeTool(scene)

    // Idle hover over the face.
    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    // The pin constrains the snap even over empty space, far from the face.
    const emptyRay: Ray = { origin: [10, 10, 5], direction: [0, 0, -1] }
    expect(tool.snapConstraint(emptyRay)?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })

    // A first click over empty space anchors PLANE mode on the pinned plane
    // — never the face-split path.
    tool.onPointerDown(makeSnap({ x: 10, y: 10, z: 1 }), emptyRay)
    tool.onPointerDown(makeSnap({ x: 13, y: 10, z: 1 }), { origin: [13, 10, 5], direction: [0, 0, -1] })

    expect(scene.split_face_inner_with_curve).not.toHaveBeenCalled()
    expect(scene.begin_ground_sketch).not.toHaveBeenCalled() // z=1 is not the ground plane
    expect(scene.begin_sketch_on_plane).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a second Shift press releases the pin; autorepeat (Shift held) does not toggle twice', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    // Autorepeat: further `true` calls without a `false` in between are inert.
    tool.setShiftHeld(true)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.setShiftHeld(false) // physical key-up
    tool.setShiftHeld(true) // second physical press: releases the pin
    expect(tool.statusHint()).not.toContain('Pinned')
  })

  it('Escape while idle clears the pin', () => {
    const pick = makePick(7n, 3n)
    const scene = makeWasmScene({ pick, faceNormal: [0, 0, 1], facePlane: [0, 0, 1, 0, 0, 1] })
    const { tool } = makeTool(scene)

    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), RAY)
    tool.setShiftHeld(true)
    expect(tool.statusHint()).toContain('Pinned')

    tool.onKey(makeKeyEvent('Escape'))
    expect(tool.statusHint()).not.toContain('Pinned')
    expect(tool.hasArmedGesture()).toBe(false)
  })
})
