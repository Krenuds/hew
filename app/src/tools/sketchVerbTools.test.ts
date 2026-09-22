import { describe, it, expect, vi } from 'vitest'
import type { Scene as WasmScene } from '../wasm/loader'
import type { Ray } from '../viewport/math'
import type { Snap } from './types'
import { FilletTool, DEFAULT_FILLET_SIZE } from './FilletTool'
import { ExtendTool } from './ExtendTool'
import { MirrorTool, mirrorTargets } from './MirrorTool'

const RAY: Ray = { origin: [0, 0, 5], direction: [0, 0, -1] }
const snapAt = (x: number, y: number): Snap => ({ x, y, z: 0, kind: 'ground' } as Snap)
const key = (k: string): KeyboardEvent => ({ key: k, preventDefault: () => {} } as unknown as KeyboardEvent)

function vertexPick(sketch: bigint, vertex: bigint) {
  return { sketch: () => sketch, vertex: () => vertex, x: () => 0, y: () => 0, z: () => 0, free: vi.fn() }
}
function edgePick(sketch: bigint, edge: bigint) {
  return { sketch: () => sketch, edge: () => edge, depth: () => 1, free: vi.fn() }
}

describe('FilletTool', () => {
  function scene(opts: { pick?: ReturnType<typeof vertexPick>; refuse?: boolean } = {}) {
    let gen = 0n
    return {
      pick_sketch_vertex: vi.fn(() => opts.pick),
      fillet_sketch_corner: vi.fn(() => {
        if (opts.refuse) throw new Error('CornerTooSmall: that size does not fit')
        gen += 1n
      }),
      chamfer_sketch_corner: vi.fn(() => {
        gen += 1n
      }),
      history_generation: () => gen,
      scene_undo: vi.fn(() => {
        gen += 1n
        return { free() {} }
      }),
      scene_redo: vi.fn(() => ({ free() {} })),
    } as unknown as WasmScene
  }

  it('clicking a corner rounds it at the current size and reports the commit', () => {
    const s = scene({ pick: vertexPick(5n, 9n) })
    const onCommit = vi.fn()
    const tool = new FilletTool(s, onCommit, vi.fn())
    tool.onPointerDown(snapAt(0, 0), RAY)
    expect(s.fillet_sketch_corner).toHaveBeenCalledWith(5n, 9n, DEFAULT_FILLET_SIZE)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('with Alt held the click cuts the corner straight instead', () => {
    const s = scene({ pick: vertexPick(5n, 9n) })
    const tool = new FilletTool(s, vi.fn(), vi.fn())
    tool.chamfer = true
    tool.onPointerDown(snapAt(0, 0), RAY)
    expect(s.chamfer_sketch_corner).toHaveBeenCalledWith(5n, 9n, DEFAULT_FILLET_SIZE)
    expect(s.fillet_sketch_corner).not.toHaveBeenCalled()
  })

  it('a size typed before the click sets the next size; typed after, it redoes the corner', () => {
    const s = scene({ pick: vertexPick(5n, 9n) })
    const tool = new FilletTool(s, vi.fn(), vi.fn())
    for (const k of ['2', '5', '0', 'm', 'm']) tool.onKey(key(k))
    tool.onKey(key('Enter'))
    expect(tool.size).toBeCloseTo(0.25, 9)
    tool.onPointerDown(snapAt(0, 0), RAY)
    expect(s.fillet_sketch_corner).toHaveBeenLastCalledWith(5n, 9n, 0.25)

    for (const k of ['1', '0', '0', 'm', 'm']) tool.onKey(key(k))
    tool.onKey(key('Enter'))
    expect(s.scene_undo).toHaveBeenCalledTimes(1)
    expect(s.fillet_sketch_corner).toHaveBeenLastCalledWith(5n, 9n, 0.1)
  })

  it('a refused corner toasts and reports nothing', () => {
    const s = scene({ pick: vertexPick(5n, 9n), refuse: true })
    const onCommit = vi.fn()
    const onToast = vi.fn()
    new FilletTool(s, onCommit, onToast).onPointerDown(snapAt(0, 0), RAY)
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onToast.mock.calls[0][1]).toBe('CornerTooSmall')
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('ExtendTool', () => {
  function scene(picks: (ReturnType<typeof edgePick> | undefined)[], refuse = false) {
    let i = 0
    return {
      pick_sketch_edge: vi.fn(() => picks[i++]),
      extend_sketch_edge: vi.fn(() => {
        if (refuse) throw new Error("NothingToExtendTo: the line does not reach that edge")
      }),
    } as unknown as WasmScene
  }

  it('the first click arms a line near the clicked end, the second extends it to the target', () => {
    const s = scene([edgePick(5n, 7n), edgePick(5n, 8n)])
    const onCommit = vi.fn()
    const tool = new ExtendTool(s, onCommit, vi.fn())
    tool.onPointerDown(snapAt(1.8, 0), RAY)
    expect(tool.hasArmedGesture()).toBe(true)
    tool.onPointerDown(snapAt(4, 0), RAY)
    expect(s.extend_sketch_edge).toHaveBeenCalledWith(5n, 7n, 1.8, 0, 0, 8n)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(tool.hasArmedGesture()).toBe(false)
  })

  it('a refused target toasts and keeps the first pick armed for another try', () => {
    const s = scene([edgePick(5n, 7n), edgePick(5n, 8n)], true)
    const onToast = vi.fn()
    const tool = new ExtendTool(s, vi.fn(), onToast)
    tool.onPointerDown(snapAt(1.8, 0), RAY)
    tool.onPointerDown(snapAt(4, 0), RAY)
    expect(onToast.mock.calls[0][1]).toBe('NothingToExtendTo')
    expect(tool.hasArmedGesture()).toBe(true)
    tool.onKey(key('Escape'))
    expect(tool.hasArmedGesture()).toBe(false)
  })
})

describe('MirrorTool', () => {
  function scene() {
    return {
      sketch_island_ids: vi.fn(() => new BigUint64Array([50n, 51n])),
      sketch_edge_island: vi.fn(() => 50n),
      sketch_plane: vi.fn(() => new Float64Array([0, 0, 0, 0, 0, 1])),
      mirror_sketch_islands: vi.fn(),
    } as unknown as WasmScene
  }

  it('resolves a selection of shapes, lines and a whole sketch to one sketch’s islands', () => {
    const s = scene()
    expect(mirrorTargets(s, [{ kind: 'sketch-island', id: 50n, sketch: 5n }, { kind: 'sketch-edge', id: 3n, sketch: 5n }])).toEqual({
      sketch: 5n,
      islands: [50n],
    })
    expect(mirrorTargets(s, [{ kind: 'sketch', id: 5n }])).toEqual({ sketch: 5n, islands: [50n, 51n] })
    expect('error' in mirrorTargets(s, [])).toBe(true)
    expect('error' in mirrorTargets(s, [{ kind: 'sketch-island', id: 50n, sketch: 5n }, { kind: 'sketch-island', id: 60n, sketch: 6n }])).toBe(true)
  })

  it('two clicks define the axis and mirror the selected islands in one call', () => {
    const s = scene()
    const onCommit = vi.fn()
    const tool = new MirrorTool(s, () => [{ kind: 'sketch-island', id: 50n, sketch: 5n }], onCommit, vi.fn())
    tool.onPointerDown(snapAt(0, 0), RAY)
    expect(tool.snapConstraint()?.constraintPlane.normal).toEqual([0, 0, 1])
    tool.onPointerDown(snapAt(0, 3), RAY)
    expect(s.mirror_sketch_islands).toHaveBeenCalledTimes(1)
    const [sketch, islands, ax, ay, az, dx, dy, dz] = (s.mirror_sketch_islands as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sketch).toBe(5n)
    expect(Array.from(islands as BigUint64Array)).toEqual([50n])
    expect([ax, ay, az, dx, dy, dz]).toEqual([0, 0, 0, 0, 3, 0])
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('with nothing selected the first click toasts and stays idle', () => {
    const s = scene()
    const onToast = vi.fn()
    const tool = new MirrorTool(s, () => [], vi.fn(), onToast)
    tool.onPointerDown(snapAt(0, 0), RAY)
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(tool.hasArmedGesture()).toBe(false)
  })
})
