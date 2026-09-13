import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { RectangleTool } from './RectangleTool'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

/** A ray straight down (−Z) through world (x, y) — hits a z=1 top face at (x, y, 1). */
function rayThrough(x: number, y: number): Ray {
  return { origin: [x, y, 5], direction: [0, 0, -1] }
}

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

function makePick(object: bigint, face: bigint, instance?: bigint) {
  return {
    object: () => object,
    face: () => face,
    instance: () => instance,
    free: vi.fn(),
  }
}

/** Minimal WasmScene stub — only the members RectangleTool calls. */
function makeWasmScene(opts: {
  pick?: () => ReturnType<typeof makePick> | undefined
  /** node_parent(0, id) result per object (a grouped object's group id). */
  parents?: Map<bigint, bigint>
} = {}): WasmScene {
  let sketchCounter = 41n
  return {
    history_generation: vi.fn(() => 1n),
    begin_ground_sketch: vi.fn(() => {
      sketchCounter += 1n
      return sketchCounter
    }),
    sketch_begin_gesture: vi.fn(),
    sketch_end_gesture: vi.fn(),
    sketch_add_segment: vi.fn(() => ({
      new_edges: () => new BigUint64Array([]),
      regions_created: () => new BigUint64Array([]),
      regions_removed: () => new BigUint64Array([]),
      free: vi.fn(),
    })),
    pick_face: vi.fn(() => opts.pick?.()),
    pick_sketch: vi.fn(() => undefined), // no committed sketches in these fixtures
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])), // every minted sketch is on the ground plane
    node_parent: vi.fn((_kind: number, id: bigint) => opts.parents?.get(id)),
    // A top face at z=1, normal +Z.
    face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array([0, 0, 1, 0, 0, 1])),
    split_face_inner: vi.fn(() => 99n),
    split_face_inner_in_instance: vi.fn(() => 99n),
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
  const tool = new RectangleTool(scene, preview, onCommit, onToast, onFaceImprint, onMeasurement)
  return { tool, preview, onCommit, onToast, onFaceImprint, onMeasurement }
}

// Deliberate contract change (selection-UX overhaul): drawing on a PLAIN
// solid's face at the top level no longer requires double-clicking into the
// object first — clicking its face with a draw tool means "draw on that
// face". Groups and Components keep the explicit edit step.
describe('RectangleTool — top-level draw-on-face', () => {
  it('two clicks on a plain object\'s face imprint it via split_face_inner (no edit context)', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    const { tool, onFaceImprint, onToast } = makeTool(scene)

    // First corner on the face, then the opposite corner 1×2 away.
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))

    expect(scene.split_face_inner).toHaveBeenCalledTimes(1)
    const [object, face, loopPts] = (scene.split_face_inner as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    expect((loopPts as Float64Array).length).toBe(12) // 4 corners × xyz
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
    // No ground sketch was created or touched.
    expect(scene.begin_ground_sketch).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).not.toHaveBeenCalled()
    expect(onToast).not.toHaveBeenCalled()
  })

  it('a face of a GROUPED object falls back to ground mode (groups keep the edit step)', () => {
    const scene = makeWasmScene({
      pick: () => makePick(7n, 3n),
      parents: new Map([[7n, 5n]]), // object 7 lives inside group 5
    })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 0 }), rayThrough(1, 2))

    expect(scene.split_face_inner).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(4) // ground rectangle
  })

  it('instanced (component) geometry falls back to ground mode (components keep the edit step)', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n, 12n) })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 0 }), rayThrough(1, 2))

    expect(scene.split_face_inner).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(4)
  })

  it('idle snapConstraint locks to a plain object\'s face plane so the first corner lands on it', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n) })
    const { tool } = makeTool(scene)

    const constraint = tool.snapConstraint(rayThrough(0, 0))
    expect(constraint?.constraintPlane).toEqual({ point: [0, 0, 1], normal: [0, 0, 1] })
  })

  it('a mid-gesture GROUND rectangle is not hijacked by hovering a face for the second corner', () => {
    let hovering = false
    const scene = makeWasmScene({ pick: () => (hovering ? makePick(7n, 3n) : undefined) })
    const { tool } = makeTool(scene)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), rayThrough(0, 0)) // ground anchor
    hovering = true // cursor drifts over a solid mid-gesture
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 0 }), rayThrough(1, 2))

    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(4) // stayed a ground rectangle
    expect(scene.split_face_inner).not.toHaveBeenCalled()
  })

  it('inside an entered object context only that object\'s faces are drawable (unchanged)', () => {
    const scene = makeWasmScene({ pick: () => makePick(999n, 3n) })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'object', id: 7n })

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1 }), rayThrough(0, 0))

    // Ignored outright — no face anchor, and no ground sketch either.
    expect(tool.capturingInput()).toBe(false)
    expect(scene.begin_ground_sketch).not.toHaveBeenCalled()
  })
})

describe('RectangleTool — instance editing context (component-edit-parity.md phase A2)', () => {
  const INSTANCE = 42n
  const COMPONENT = 5n

  it('face mode routes to split_face_inner_in_instance, never the world split_face_inner', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n, INSTANCE) })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })
    tool.setFaceEligibility((_object, instance) => instance === INSTANCE)

    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))

    expect(scene.split_face_inner_in_instance).toHaveBeenCalledTimes(1)
    const [instance, object, face] = (scene.split_face_inner_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(instance).toBe(INSTANCE)
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    expect(scene.split_face_inner).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })

  it('plane mode on empty space mints a def-owned sketch via begin_sketch_on_plane_in_instance', () => {
    const scene = makeWasmScene({ pick: () => undefined })
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })

    tool.onPointerDown(makeSnap({ x: 6, y: 1, z: 0 }), rayThrough(6, 1))
    tool.onPointerDown(makeSnap({ x: 7, y: 3, z: 0 }), rayThrough(7, 3))

    expect(scene.begin_sketch_on_plane_in_instance).toHaveBeenCalledTimes(1)
    expect(scene.begin_ground_sketch).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(4)
    // Points are mapped into DEFINITION-local space (pose⁻¹ of +5-in-x).
    for (const call of (scene.sketch_add_segment as ReturnType<typeof vi.fn>).mock.calls) {
      const [, ax] = call
      const [, , , , bx] = call
      expect(ax).toBeLessThan(6) // world x=6/7 maps to local x=1/2
      expect(bx).toBeLessThan(6)
    }
  })

  // The face_normal-as-world-space finding: every OTHER instance-context test
  // in this file uses a translation-only pose, where the LOCAL normal
  // face_normal reports happens to equal the WORLD one — a mapping bug would
  // go unnoticed. This one genuinely rotates the instance (90° about X),
  // turning the member face's local +Z normal into world −Y — before the
  // fix, the tool used the raw local (0,0,1) normal directly and would have
  // drawn the loop into the WRONG (Z-constant) plane; after it, the loop
  // lands in the correctly posed (Y-constant) plane.
  it('face mode poses the LOCAL face_normal into WORLD space through a rotated instance pose', () => {
    const scene = makeWasmScene({ pick: () => makePick(7n, 3n, INSTANCE) })
    ;(scene.instance_pose as ReturnType<typeof vi.fn>).mockReturnValue(
      new Float64Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0]),
    )
    const { tool } = makeTool(scene)
    tool.setEditContext({ kind: 'instance', id: INSTANCE, component: COMPONENT })
    tool.setFaceEligibility((_object, instance) => instance === INSTANCE)

    // Anchor at world (0,5,1) — on the posed (Y=5) plane. Second click's ray
    // travels along +Y from (2,0,3), landing on the SAME plane at (2,5,3):
    // a nonzero, non-degenerate rectangle in BOTH in-plane directions.
    tool.onPointerDown(makeSnap({ x: 0, y: 5, z: 1, kind: 'face' }), {
      origin: [0, 0, 1],
      direction: [0, 1, 0],
    })
    tool.onPointerDown(makeSnap({ x: 2, y: 5, z: 3, kind: 'face' }), {
      origin: [2, 0, 3],
      direction: [0, 1, 0],
    })

    expect(scene.split_face_inner_in_instance).toHaveBeenCalledTimes(1)
    const [, , , loopPts] = (scene.split_face_inner_in_instance as ReturnType<typeof vi.fn>).mock.calls[0]
    const ys: number[] = []
    for (let i = 1; i < (loopPts as Float64Array).length; i += 3) ys.push((loopPts as Float64Array)[i])
    // Every corner lies in the posed Y=5 plane — proof the normal was
    // actually mapped through the pose, not left at the raw local (0,0,1).
    for (const y of ys) expect(y).toBeCloseTo(5, 9)
  })
})

// Post-commit dimension retype (SketchUp: click both corners, then type
// `W,D` + Enter and the rectangle you just drew redraws to that size).
describe('RectangleTool — retype dimensions after the second click', () => {
  /** The base stub plus the history surface the retype window uses: a
   *  generation that moves on every recorded action, undo, and redo, like
   *  the kernel's. `sketch_add_segment` bumps it once per gesture is more
   *  than the tool needs — one bump per commit is what matters. */
  function makeRetypeScene(opts: Parameters<typeof makeWasmScene>[0] = {}) {
    const base = makeWasmScene(opts) as unknown as Record<string, unknown>
    let gen = 1n
    // Like the kernel: a gesture records a step (and moves the generation)
    // only if it changed something — an all-refused gesture records nothing.
    let changedInGesture = 0
    let addCalls = 0
    let failAddAt = -1
    const baseAdd = base.sketch_add_segment as (...args: unknown[]) => unknown
    const scene = {
      ...base,
      history_generation: vi.fn(() => gen),
      sketch_begin_gesture: vi.fn(() => { changedInGesture = 0 }),
      sketch_add_segment: vi.fn((...args: unknown[]) => {
        addCalls += 1
        if (addCalls === failAddAt) throw new Error('PointOffPlane: nope')
        const r = baseAdd(...args)
        changedInGesture += 1
        return r
      }),
      /** Test hook: the Nth `sketch_add_segment` call overall is refused. */
      __failAddAt: (n: number) => { failAddAt = n },
      sketch_end_gesture: vi.fn(() => { if (changedInGesture > 0) gen += 1n }),
      split_face_inner: vi.fn(() => { gen += 1n; return 99n }),
      scene_undo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
      scene_redo: vi.fn(() => { gen += 1n; return { free: vi.fn() } }),
      /** Test hook: an unrelated recorded action. */
      __bump: () => { gen += 1n },
    }
    return scene as unknown as WasmScene & { __bump(): void; __failAddAt(n: number): void }
  }

  function key(tool: RectangleTool, k: string) {
    tool.onKey({ key: k } as KeyboardEvent)
  }

  function typeDims(tool: RectangleTool, text: string) {
    for (const ch of text) key(tool, ch)
    key(tool, 'Enter')
  }

  /** The (x, y) corners of the last four `sketch_add_segment` calls. */
  function lastRectangle(scene: WasmScene): [number, number][] {
    const calls = (scene.sketch_add_segment as ReturnType<typeof vi.fn>).mock.calls
    return calls.slice(-4).map((c) => [c[1] as number, c[2] as number])
  }

  function drawGround(tool: RectangleTool, a: [number, number], b: [number, number]) {
    tool.onPointerDown(makeSnap({ x: a[0], y: a[1], z: 0 }), rayThrough(a[0], a[1]))
    tool.onPointerDown(makeSnap({ x: b[0], y: b[1], z: 0 }), rayThrough(b[0], b[1]))
  }

  it('is closed before any rectangle exists — digits are not captured', () => {
    const { tool } = makeTool(makeRetypeScene())
    expect(tool.capturesKey('5')).toBe(false)
    expect(tool.hasArmedGesture()).toBe(false)
  })

  it('after a two-click ground rectangle, typing W,D + Enter undoes it once and redraws it at that size, growing the same way', () => {
    const scene = makeRetypeScene()
    const { tool, onCommit, onMeasurement } = makeTool(scene)
    // Second corner toward −x, −y: the retyped rectangle must grow that way too.
    drawGround(tool, [1, 1], [0, -1])
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(4)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(tool.statusHint()).toContain('resize')

    // A digit opens the window; the readout shows the buffer.
    expect(tool.capturesKey('2')).toBe(true)
    typeDims(tool, '2,3')
    expect(onMeasurement).toHaveBeenCalledWith(expect.stringContaining('2'))

    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.scene_redo).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(8)
    // Anchor (1,1), far corner (1−2, 1−3) = (−1, −2).
    const xs = lastRectangle(scene).map((c) => c[0])
    const ys = lastRectangle(scene).map((c) => c[1])
    expect(Math.min(...xs)).toBeCloseTo(-1, 9)
    expect(Math.max(...xs)).toBeCloseTo(1, 9)
    expect(Math.min(...ys)).toBeCloseTo(-2, 9)
    expect(Math.max(...ys)).toBeCloseTo(1, 9)
    expect(onCommit).toHaveBeenCalledTimes(2)
    // Readout cleared after the commit.
    expect(onMeasurement).toHaveBeenLastCalledWith('')
  })

  it('a single value makes a square; the window stays open so a second size can be typed', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 2])
    typeDims(tool, '5')
    let xs = lastRectangle(scene).map((c) => c[0])
    let ys = lastRectangle(scene).map((c) => c[1])
    expect(Math.max(...xs)).toBeCloseTo(5, 9)
    expect(Math.max(...ys)).toBeCloseTo(5, 9)

    typeDims(tool, '1,4')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    xs = lastRectangle(scene).map((c) => c[0])
    ys = lastRectangle(scene).map((c) => c[1])
    expect(Math.max(...xs)).toBeCloseTo(1, 9)
    expect(Math.max(...ys)).toBeCloseTo(4, 9)
  })

  it('with an empty buffer, letters and Space keep their global meaning; once a digit is in, the dimension grammar is captured', () => {
    const { tool } = makeTool(makeRetypeScene())
    drawGround(tool, [0, 0], [1, 1])
    for (const k of ['m', 'c', 'p', 'f', ' ', 'Enter', 'Backspace', ',']) {
      expect(tool.capturesKey(k)).toBe(false)
    }
    key(tool, '2')
    for (const k of ['m', ',', 'x', "'", '"', '/', 'Backspace', 'Enter', '5']) {
      expect(tool.capturesKey(k)).toBe(true)
    }
    // Space is the global reset-to-Select even with a buffer open.
    expect(tool.capturesKey(' ')).toBe(false)
    // Still not a tool-switch-blocking letter for keys outside the grammar.
    expect(tool.capturesKey('p')).toBe(false)
    expect(tool.capturesKey('q')).toBe(false)
    // An open buffer is an armed gesture for Escape's purposes.
    expect(tool.hasArmedGesture()).toBe(true)
  })

  it('the idle hover re-run after each captured key keeps the typed readout (the key router re-hovers)', () => {
    const scene = makeRetypeScene()
    const { tool, onMeasurement } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    key(tool, '3')
    onMeasurement.mockClear()
    tool.onPointerMove(makeSnap({ x: 2, y: 2, z: 0 }), rayThrough(2, 2))
    expect(onMeasurement).not.toHaveBeenCalledWith('')
    // Face-mode idle hover too.
    const faceScene = makeRetypeScene({ pick: () => makePick(7n, 3n) })
    const f = makeTool(faceScene)
    f.tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    f.tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))
    key(f.tool, '3')
    f.onMeasurement.mockClear()
    f.tool.onPointerMove(makeSnap({ x: 0.5, y: 0.5, z: 1, kind: 'face' }), rayThrough(0.5, 0.5))
    expect(f.onMeasurement).not.toHaveBeenCalledWith('')
  })

  it('Escape closes the window without touching the rectangle', () => {
    const scene = makeRetypeScene()
    const { tool, onMeasurement } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    key(tool, '3')
    key(tool, 'Escape')
    expect(onMeasurement).toHaveBeenLastCalledWith('')
    expect(tool.capturesKey('5')).toBe(false)
    expect(tool.hasArmedGesture()).toBe(false)
    // A stray Enter now does nothing.
    key(tool, 'Enter')
    expect(scene.scene_undo).not.toHaveBeenCalled()
  })

  it('a new first click closes the window; the digits then belong to the new rectangle', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    key(tool, '3')
    tool.onPointerDown(makeSnap({ x: 5, y: 5, z: 0 }), rayThrough(5, 5))
    expect(tool.capturingInput()).toBe(true) // anchored on the next rectangle
    typeDims(tool, '1,1')
    // The typed commit is a fresh rectangle from (5,5), not a retype.
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(8)
    expect(Math.min(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(5, 9)
  })

  it('disarmRetype (the host\'s explicit undo/redo/delete hook) closes the window quietly', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    tool.disarmRetype()
    expect(tool.capturesKey('5')).toBe(false)
  })

  it('refuses the retype when the history generation moved (an intervening action) and says so', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    scene.__bump() // something else was recorded meanwhile
    typeDims(tool, '2,2')
    expect(scene.scene_undo).not.toHaveBeenCalled()
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(4)
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('model changed'))
    // The window is gone.
    expect(tool.capturesKey('5')).toBe(false)
  })

  it('a refused re-commit is rolled forward with a redo, so the original rectangle survives', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    const add = scene.sketch_add_segment as ReturnType<typeof vi.fn>
    add.mockImplementationOnce(() => { throw new Error('PointOffPlane: nope') })
    typeDims(tool, '2,2')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.scene_redo).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledTimes(1)
    // Still open, re-stamped: a second attempt goes through.
    typeDims(tool, '2,2')
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(Math.max(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(2, 9)
  })

  it('a PARTIALLY applied re-commit (a later segment refused) is undone and the original redrawn — never a redo of a cleared stack', () => {
    const scene = makeRetypeScene()
    const { tool, onToast } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    // First segment of the retry lands, the second (6th call overall, after
    // the 4 of the original draw) is refused: the gesture bracket still
    // closes (runSketchGesture's finally) and records a step.
    scene.__failAddAt(6)
    typeDims(tool, '2,2')
    expect(onToast).toHaveBeenCalledTimes(1)
    // Retract the rectangle, then retract the partial step: two undos, no redo.
    expect(scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(scene.scene_redo).not.toHaveBeenCalled()
    // The original 1×1 was redrawn as a fresh commit.
    const rect = lastRectangle(scene)
    expect(Math.max(...rect.map((c) => c[0]))).toBeCloseTo(1, 9)
    expect(Math.max(...rect.map((c) => c[1]))).toBeCloseTo(1, 9)
    // Still open: a good retype now goes through.
    typeDims(tool, '3,3')
    expect(scene.scene_undo).toHaveBeenCalledTimes(3)
    expect(Math.max(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(3, 9)
  })

  it('Escape with an open but untyped window is not armed: it closes the window quietly and is not consumed', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    drawGround(tool, [0, 0], [1, 1])
    expect(tool.hasArmedGesture()).toBe(false)
    key(tool, 'Escape')
    expect(tool.capturesKey('5')).toBe(false)
  })

  it('a face rectangle retypes through split_face_inner with the loop rebuilt on the face plane', () => {
    const scene = makeRetypeScene({ pick: () => makePick(7n, 3n) })
    const { tool, onFaceImprint } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'face' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 1, y: 2, z: 1, kind: 'face' }), rayThrough(1, 2))
    expect(scene.split_face_inner).toHaveBeenCalledTimes(1)

    typeDims(tool, '3,4')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(scene.split_face_inner).toHaveBeenCalledTimes(2)
    const [object, face, loopPts] = (scene.split_face_inner as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(object).toBe(7n)
    expect(face).toBe(3n)
    const pts = loopPts as Float64Array
    const xs = [pts[0], pts[3], pts[6], pts[9]]
    const ys = [pts[1], pts[4], pts[7], pts[10]]
    const zs = [pts[2], pts[5], pts[8], pts[11]]
    expect(Math.min(...xs)).toBeCloseTo(0, 9)
    expect(Math.min(...ys)).toBeCloseTo(0, 9)
    // 3 × 4 on the +Z face: one extent is 3 and the other 4 (the face basis
    // fixes which axis is which; the growth direction is preserved either way).
    const extents = [Math.max(...xs), Math.max(...ys)].sort((a, b) => a - b)
    expect(extents[0]).toBeCloseTo(3, 9)
    expect(extents[1]).toBeCloseTo(4, 9)
    for (const z of zs) expect(z).toBeCloseTo(1, 9)
    expect(onFaceImprint).toHaveBeenCalledTimes(2)
  })

  it('a typed (Enter) commit arms the window too', () => {
    const scene = makeRetypeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0 }), rayThrough(0, 0))
    typeDims(tool, '1,1')
    expect(scene.sketch_add_segment).toHaveBeenCalledTimes(4)
    typeDims(tool, '2,2')
    expect(scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(Math.max(...lastRectangle(scene).map((c) => c[0]))).toBeCloseTo(2, 9)
  })
})
