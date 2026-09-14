/**
 * LineTool — face chains (maintainer playtest 2 of the inference fixes):
 * boundary-touching paths commit as one cut per sub-path, interior loops
 * imprint a sub-face, placed-but-uncommitted segments are drawn, a ground
 * chain's "projected" verdict does not outlive the chain, and Shift held
 * through the end of a chain never pins a plane by autorepeat.
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { LineTool } from './LineTool'
import type { Snap } from './types'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'

/** A ray straight down through world (x, y) — hits the z=1 top face. */
function rayThrough(x: number, y: number): Ray {
  return { origin: [x, y, 5], direction: [0, 0, -1] }
}

function makeSnap(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

function makePick(object: bigint, face: bigint) {
  return { object: () => object, face: () => face, depth: () => 1, instance: () => undefined, free: vi.fn() }
}

/** Object 7's top face 3: the unit square at z = 1. After a split, picks
 *  land on face 8 (the "new sub-face"), so a second cut is routed there. */
function makeScene() {
  let splits = 0
  let sketchCounter = 41n
  const scene = {
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
    pick_face: vi.fn((_ox: number, _oy: number, oz: number) => {
      if (oz > 4) return makePick(7n, 3n) // a cursor ray from the camera
      return makePick(7n, splits === 0 ? 3n : 8n) // a sub-face probe from just above the face
    }),
    pick_sketch: vi.fn(() => undefined),
    sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
    node_parent: vi.fn(() => undefined),
    face_normal: vi.fn(() => new Float64Array([0, 0, 1])),
    face_plane: vi.fn(() => new Float64Array([0, 0, 1, 0, 0, 1])),
    face_boundary: vi.fn(() => new Float32Array([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1])),
    split_face: vi.fn(() => {
      splits += 1
      return { new_faces: () => [8n, 9n], free: vi.fn() }
    }),
    split_face_in_instance: vi.fn(),
    split_face_inner: vi.fn(() => 55n),
    split_face_inner_in_instance: vi.fn(),
    instance_pose: vi.fn(() => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])),
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
    clear_transient_segments: vi.fn(),
    add_transient_segment: vi.fn(),
  }
  return scene as unknown as WasmScene & typeof scene
}

function makeTool(scene: WasmScene) {
  const preview = new THREE.Group()
  const onToast = vi.fn()
  const onFaceImprint = vi.fn()
  const tool = new LineTool(scene, preview, vi.fn(), onToast, onFaceImprint, vi.fn())
  return { tool, preview, onToast, onFaceImprint }
}

const onEdge = (x: number, y: number): Snap => makeSnap({ x, y, z: 1, kind: 'on-edge', object: 7n, element: 11n, elementKind: 'edge' })
const onFace = (x: number, y: number): Snap => makeSnap({ x, y, z: 1, kind: 'on-face', object: 7n, element: 3n, elementKind: 'face' })

describe('LineTool — face chains that touch the boundary partway commit one cut per sub-path', () => {
  it('a bisecting cut continued to a third boundary point splits twice, the second cut on the sub-face under it', () => {
    const scene = makeScene()
    const { tool, onToast } = makeTool(scene)
    tool.onPointerDown(onEdge(0, 0.5), rayThrough(0, 0.5)) // left edge
    tool.onPointerDown(onEdge(1, 0.5), rayThrough(1, 0.5)) // right edge
    tool.onPointerDown(onEdge(0.5, 0), rayThrough(0.5, 0)) // bottom edge
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(scene.split_face).toHaveBeenCalledTimes(2)
    const calls = (scene.split_face as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[][]
    const [first, second] = calls
    expect(first[1]).toBe(3n)
    expect(Array.from(first[2] as Float64Array)).toEqual([0, 0.5, 1, 1, 0.5, 1])
    expect(second[1]).toBe(8n) // the sub-face the probe found after the first cut
    expect(Array.from(second[2] as Float64Array)).toEqual([1, 0.5, 1, 0.5, 0, 1])
    expect(onToast).not.toHaveBeenCalled()
  })

  it('corner → top-edge midpoint → corner is two cuts (a triangle), not one refused path', () => {
    const scene = makeScene()
    const { tool, onToast } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 1, kind: 'endpoint', object: 7n, element: 1n, elementKind: 'vertex' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 0.5, y: 1, z: 1, kind: 'midpoint', object: 7n, element: 12n, elementKind: 'edge' }), rayThrough(0.5, 1))
    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 1, kind: 'endpoint', object: 7n, element: 2n, elementKind: 'vertex' }), rayThrough(1, 0))
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(scene.split_face).toHaveBeenCalledTimes(2)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('an interior point between two boundary points stays in ONE cut (the kernel accepts a bent edge-to-edge path)', () => {
    const scene = makeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(onEdge(0, 0.5), rayThrough(0, 0.5))
    tool.onPointerDown(onFace(0.5, 0.7), rayThrough(0.5, 0.7))
    tool.onPointerDown(onEdge(1, 0.5), rayThrough(1, 0.5))
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(scene.split_face).toHaveBeenCalledTimes(1)
    expect(Array.from((scene.split_face as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as Float64Array)).toEqual([0, 0.5, 1, 0.5, 0.7, 1, 1, 0.5, 1])
  })
})

describe('LineTool — a face chain closing on its own start inside the face imprints a sub-face', () => {
  it('clicking the start point again ends the chain and calls split_face_inner with the loop', () => {
    const scene = makeScene()
    const { tool, onFaceImprint } = makeTool(scene)
    tool.onPointerDown(onFace(0.2, 0.2), rayThrough(0.2, 0.2))
    tool.onPointerDown(onFace(0.8, 0.2), rayThrough(0.8, 0.2))
    tool.onPointerDown(onFace(0.5, 0.8), rayThrough(0.5, 0.8))
    tool.onPointerDown(onFace(0.2, 0.2), rayThrough(0.2, 0.2))
    expect(tool.capturingInput()).toBe(false) // the loop ended the chain by itself
    expect(scene.split_face_inner).toHaveBeenCalledTimes(1)
    expect(Array.from((scene.split_face_inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as Float64Array)).toEqual([0.2, 0.2, 1, 0.8, 0.2, 1, 0.5, 0.8, 1])
    expect(scene.split_face).not.toHaveBeenCalled()
    expect(onFaceImprint).toHaveBeenCalledWith(7n)
  })
})

describe('LineTool — placed face segments are drawn before the chain commits', () => {
  it('after two face clicks the preview holds the placed segment plus the rubber band', () => {
    const scene = makeScene()
    const { tool, preview } = makeTool(scene)
    tool.onPointerDown(onEdge(0, 0.5), rayThrough(0, 0.5))
    tool.onPointerDown(onFace(0.5, 0.5), rayThrough(0.5, 0.5))
    expect(preview.children.length).toBeGreaterThanOrEqual(1) // the placed segment, before any move
    tool.onPointerMove(onFace(0.7, 0.3), rayThrough(0.7, 0.3))
    expect(preview.children.length).toBeGreaterThanOrEqual(2) // placed + rubber band
  })
})

describe('LineTool — a ground chain\'s "projected" verdict ends with the chain', () => {
  it('snapProjected() is false again once the chain ends, and while idle', () => {
    const scene = makeScene()
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(() => undefined) // bare ground
    const { tool } = makeTool(scene)
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0, kind: 'ground' }), rayThrough(0, 0))
    tool.onPointerMove(makeSnap({ x: 1, y: 0, z: 1, kind: 'endpoint' }), rayThrough(1, 0))
    expect(tool.snapProjected()).toBe(true)
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(tool.snapProjected()).toBe(false)
    tool.onPointerMove(makeSnap({ x: 2, y: 0, z: 0, kind: 'ground' }), rayThrough(2, 0))
    expect(tool.snapProjected()).toBe(false)
  })
})

describe('LineTool — Shift held through the end of a chain never pins a plane by autorepeat', () => {
  it('a keydown repeat arriving after the chain ended does not toggle the pin; a fresh press does', () => {
    const scene = makeScene()
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation(() => undefined) // ground chain
    const { tool } = makeTool(scene)
    tool.onPointerMove(makeSnap({ x: 0, y: 0, z: 0, kind: 'ground' }), rayThrough(0, 0))
    tool.onPointerDown(makeSnap({ x: 0, y: 0, z: 0, kind: 'ground' }), rayThrough(0, 0))
    tool.onPointerMove(makeSnap({ x: 1, y: 0.01, z: 0, kind: 'ground' }), rayThrough(1, 0.01))
    tool.setShiftHeld(true) // mid-chain: the axis lock
    tool.onPointerDown(makeSnap({ x: 1, y: 0, z: 0, kind: 'ground' }), rayThrough(1, 0))
    tool.onKey({ key: 'Escape' } as KeyboardEvent) // chain ends with Shift still down
    tool.setShiftHeld(true) // keydown autorepeat reaches the now-idle tool
    tool.setShiftHeld(true)
    expect(tool.statusHint()).not.toMatch(/Pinned/)
    tool.setShiftHeld(false)
    tool.onPointerMove(makeSnap({ x: 2, y: 0, z: 0, kind: 'ground' }), rayThrough(2, 0))
    tool.setShiftHeld(true) // a genuine new press
    expect(tool.statusHint()).toMatch(/Pinned/)
  })
})

describe('LineTool — review fixes on the face-chain round', () => {
  it('re-picks a later sub-face at a SEGMENT midpoint, so a bent sub-path across a concave face is probed inside the face', () => {
    const scene = makeScene()
    const probes: [number, number][] = []
    ;(scene.pick_face as ReturnType<typeof vi.fn>).mockImplementation((ox: number, oy: number, oz: number) => {
      if (oz > 4) return makePick(7n, 3n)
      probes.push([ox, oy])
      return makePick(7n, 8n)
    })
    const { tool } = makeTool(scene)
    tool.onPointerDown(onEdge(0, 0.5), rayThrough(0, 0.5))
    tool.onPointerDown(onEdge(1, 0.5), rayThrough(1, 0.5)) // first cut: straight across
    tool.onPointerDown(onFace(0.95, 0.05), rayThrough(0.95, 0.05)) // a bend
    tool.onPointerDown(onEdge(0.5, 0), rayThrough(0.5, 0)) // back to the boundary
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(scene.split_face).toHaveBeenCalledTimes(2)
    // The probe for the bent sub-path [(1,0.5),(0.95,0.05),(0.5,0)] is its
    // first segment's midpoint, not the chord midpoint (0.75, 0.25).
    expect(probes[0][0]).toBeCloseTo(0.975)
    expect(probes[0][1]).toBeCloseTo(0.275)
  })

  it('a snapped edge point far from the origin still counts as a boundary point (the f32 boundary copy cannot say so)', () => {
    const scene = makeScene()
    const X = 200
    ;(scene.face_boundary as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Float32Array([X, 0, 1, X + 1, 0, 1, X + 1, 1, 1, X, 1, 1]))
    const { tool, onToast } = makeTool(scene)
    // f32(200.0000000123) rounds away; the snap says "edge", and that is exact.
    const edgePt = (x: number, y: number): Snap => makeSnap({ x, y, z: 1, kind: 'on-edge', object: 7n, element: 11n, elementKind: 'edge' })
    tool.onPointerDown(edgePt(X + 1.23e-5, 0.5), rayThrough(X, 0.5))
    tool.onPointerDown(edgePt(X + 1 - 1.23e-5, 0.5), rayThrough(X + 1, 0.5))
    tool.onPointerDown(edgePt(X + 0.5, 1.23e-5), rayThrough(X + 0.5, 0))
    tool.onKey({ key: 'Escape' } as KeyboardEvent)
    expect(scene.split_face).toHaveBeenCalledTimes(2)
    expect(onToast).not.toHaveBeenCalled()
  })

  it('the dblclick following a single click that closed a loop is consumed, not handed to the host', () => {
    const scene = makeScene()
    const { tool } = makeTool(scene)
    tool.onPointerDown(onFace(0.2, 0.2), rayThrough(0.2, 0.2))
    tool.onPointerDown(onFace(0.8, 0.2), rayThrough(0.8, 0.2))
    tool.onPointerDown(onFace(0.5, 0.8), rayThrough(0.5, 0.8))
    tool.onPointerDown(onFace(0.2, 0.2), rayThrough(0.2, 0.2)) // closes; the chain is already gone
    expect(tool.capturingInput()).toBe(false)
    expect(tool.onDoubleClick(onFace(0.2, 0.2), rayThrough(0.2, 0.2))).toBe(true) // the same gesture's dblclick
    expect(tool.onDoubleClick(onFace(0.2, 0.2), rayThrough(0.2, 0.2))).toBe(false) // a later one is the host's
    tool.onPointerDown(onFace(0.2, 0.2), rayThrough(0.2, 0.2))
    tool.onPointerDown(onFace(0.8, 0.2), rayThrough(0.8, 0.2))
    tool.onPointerDown(onFace(0.5, 0.8), rayThrough(0.5, 0.8))
    tool.onPointerDown(onFace(0.2, 0.2), rayThrough(0.2, 0.2))
    tool.onPointerMove(onFace(0.3, 0.3), rayThrough(0.3, 0.3)) // the pointer moved on: no dblclick is owed
    expect(tool.onDoubleClick(onFace(0.3, 0.3), rayThrough(0.3, 0.3))).toBe(false)
  })

  it('retyping a face segment\'s length redraws the placed chain instead of blanking it', () => {
    const scene = makeScene()
    const { tool, preview } = makeTool(scene)
    tool.onPointerDown(onEdge(0, 0.5), rayThrough(0, 0.5))
    tool.onPointerDown(onFace(0.5, 0.5), rayThrough(0.5, 0.5))
    expect(preview.children.length).toBeGreaterThanOrEqual(1)
    tool.onKey({ key: '0' } as KeyboardEvent)
    tool.onKey({ key: '.' } as KeyboardEvent)
    tool.onKey({ key: '3' } as KeyboardEvent)
    tool.onKey({ key: 'Enter' } as KeyboardEvent)
    expect(preview.children.length).toBeGreaterThanOrEqual(1)
  })
})
