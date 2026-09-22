/**
 * MoveTool logic tests: the durable copy toggle (Option on macOS, Ctrl on
 * Windows/Linux — `platform.ts`'s `COPY_MODIFIER_KEY`) and the ×N / /N array
 * refinement, driven through the tool's public event surface against a
 * mocked WasmScene (no three.js meshes — objectsGroup stays null, matching
 * RotateTool.test.ts's approach).
 *
 * `isMac` is a load-time constant read from `navigator.platform`, so this
 * whole file mocks `../platform` to `isMac: true` (macOS) rather than relying
 * on the CI host's actual OS — every test below except the "Windows/Linux"
 * describe near the copy-toggle tests assumes that mock. That one test needs
 * the OTHER platform instead, so it overrides the mock with a scoped
 * `vi.doMock` + `vi.resetModules()` + dynamic re-import (same pattern
 * `trayLayout.test.ts` uses for its module-load-time state) — the
 * statically-imported `MoveTool` above is a different module instance and is
 * unaffected by that reset.
 */

import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { MoveTool } from './MoveTool'
import { CleanModifierTap } from '../viewport/cleanModifierTap'
import type { Snap } from './types'
import type { Ray } from '../viewport/math'
import type { NodeRef } from '../panels/treeModel'

vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>()
  return { ...actual, isMac: true, COPY_MODIFIER_KEY: 'Alt', COPY_MODIFIER_LABEL: 'Option' }
})

/** A ray straight down through world (x, y) — MoveTool ignores it. */
function rayThrough(x: number, y: number): Ray {
  return { origin: [x, y, 5], direction: [0, 0, -1] }
}

function makeSnap(x = 0, y = 0, z = 0): Snap {
  return { x, y, z, kind: 'ground' }
}

/** Minimal KeyboardEvent-shaped fake — onKey reads .key/.repeat/.preventDefault. */
function makeKeyEvent(key: string, opts: { repeat?: boolean } = {}): KeyboardEvent {
  return {
    key,
    repeat: opts.repeat ?? false,
    preventDefault: () => { /* no-op */ },
  } as unknown as KeyboardEvent
}

/** Type a string one key at a time, then Enter. */
function typeKeys(tool: MoveTool, text: string): void {
  for (const ch of text) tool.onKey(makeKeyEvent(ch))
}

/**
 * Minimal WasmScene stub — only the members MoveTool calls. The stub hands
 * out fresh object handles per clone and models the kernel's two identity
 * tokens separately: `hash` (content) and `gen` (history generation — bumps
 * on every commit/undo/redo, never on view-state edits). Tests mutate them
 * independently to simulate the two classes of external change.
 */
/** World-identity drawing axes (tool-parity §4) — the default frame every
 *  test exercises unless it explicitly overrides `frame`. */
const WORLD_FRAME_FLAT = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]

function makeWasmScene(frame: number[] = WORLD_FRAME_FLAT) {
  let nextId = 100n
  let nextEdge = 500n
  const state = { hash: 1n, gen: 1n }
  const scene = {
    axes: vi.fn(() => new Float64Array(frame)),
    // --- sketch replay surface (Move+Alt sketch copies). One sketch with
    // two single-edge islands: 40 (edge 10) and 41 (edge 20); replayed
    // edges get fresh ids >= 500 and land in island 77.
    sketch_island_ids: vi.fn(() => [40n, 41n]),
    sketch_island_edges: vi.fn((_s: bigint, island: bigint) =>
      island === 40n ? [10n] : island === 41n ? [20n] : [],
    ),
    sketch_edge_island: vi.fn((_s: bigint, edge: bigint) =>
      edge >= 500n ? 77n : edge === 10n ? 40n : 41n,
    ),
    sketch_edge_endpoints: vi.fn((_s: bigint, e: bigint) =>
      e === 10n ? [0, 0, 0, 1, 0, 0] : e === 20n ? [5, 5, 0, 6, 5, 0] : undefined,
    ),
    sketch_edge_curve: vi.fn(() => undefined),
    sketch_curve_geom: vi.fn(() => undefined),
    sketch_locked: () => false,
    sketch_plane: vi.fn(() => [0, 0, 0, 0, 0, 1]),
    sketch_island_lines: vi.fn(() => new Float32Array(0)),
    sketch_begin_gesture: vi.fn(),
    sketch_end_gesture: vi.fn(() => { state.hash++; state.gen++ }),
    sketch_cancel_gesture: vi.fn(),
    sketch_begin_curve: vi.fn(() => 8n),
    sketch_begin_curve_with: vi.fn(() => 8n),
    sketch_end_curve: vi.fn(),
    sketch_add_segment: vi.fn(() => {
      const id = nextEdge++
      return { new_edges: () => [id], free: () => { /* no-op */ } }
    }),
    transform_sketch: vi.fn(() => { state.hash++; state.gen++ }),
    transform_sketch_island: vi.fn(() => { state.hash++; state.gen++ }),
    can_transform_sketch_island: vi.fn(() => true),
    duplicate_selection_array: vi.fn(
      (_kinds: Uint8Array, ids: BigUint64Array, _affine: Float64Array, count: number) => {
        const out: { kind: string; id: bigint }[] = []
        for (let k = 0; k < count; k++) {
          for (let i = 0; i < ids.length; i++) {
            out.push({ kind: 'object', id: nextId++ })
          }
        }
        // Every commit moves both tokens, as the kernel's would.
        state.hash++
        state.gen++
        return out
      },
    ),
    transform_selection: vi.fn(
      (_kinds: Uint8Array, _ids: BigUint64Array, _sketches: BigUint64Array, _affine: Float64Array) => {
        state.hash++
        state.gen++
      },
    ),
    state_hash: vi.fn(() => state.hash),
    history_generation: vi.fn(() => state.gen),
    max_array_count: vi.fn(() => 1000),
    array_sketch_islands: vi.fn(() => { state.hash++; state.gen++ }),
    scene_undo: vi.fn(() => { state.hash++; state.gen++; return { free: () => { /* no-op */ } } }),
    scene_redo: vi.fn(() => { state.hash++; state.gen++; return { free: () => { /* no-op */ } } }),
  }
  return { scene, state }
}

function makeTool(selection?: NodeRef[], frame?: number[]) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onArrayCommit = vi.fn()
  const onToast = vi.fn()
  const onMeasurement = vi.fn()
  const onCopyModeChange = vi.fn()
  const { scene, state } = makeWasmScene(frame)
  const tool = new MoveTool(
    scene as never,
    preview,
    null, // objectsGroup — no ghost mesh in logic tests
    selection ?? [{ kind: 'object', id: 1n }],
    onCommit,
    onToast,
    onMeasurement,
    null,
    onCopyModeChange,
    onArrayCommit,
  )
  return { tool, scene, state, onCommit, onArrayCommit, onToast, onMeasurement, onCopyModeChange }
}

/** Start a gesture at the origin and lock the X axis. */
function beginGestureLockedX(tool: MoveTool): void {
  tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
  tool.onKey(makeKeyEvent('ArrowRight'))
}

/** The translation column [tx, ty, tz] of a row-major 3×4 affine. */
function translationOf(affine: Float64Array): [number, number, number] {
  return [affine[3], affine[7], affine[11]]
}

describe('MoveTool — movable drawing axes (arrow-key lock)', () => {
  it('ArrowRight locks to the CURRENT frame\'s red axis, not literal world X, under a moved frame', () => {
    // Frame with red/green swapped relative to world: x=[0,1,0], y=[-1,0,0],
    // z=[0,0,1] — an orthonormal, right-handed frame (tool-parity §4).
    const frame = [0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 1]
    const { tool, scene } = makeTool(undefined, frame)
    beginGestureLockedX(tool)
    typeKeys(tool, '2')
    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.transform_selection).toHaveBeenCalledTimes(1)
    const [, , , affine] = scene.transform_selection.mock.calls[0]
    // 2 units along the frame's red axis [0,1,0] — NOT world X [1,0,0].
    expect(translationOf(affine as Float64Array)).toEqual([0, 2, 0])
  })
})

describe('MoveTool — the axis behind the distance readout', () => {
  it('an explicit lock reports that axis', () => {
    const { tool, onMeasurement } = makeTool()
    beginGestureLockedX(tool)
    tool.onPointerMove(makeSnap(3, 0, 0), rayThrough(3, 0))
    expect(onMeasurement.mock.calls.at(-1)?.[1]).toEqual([0])
  })

  it('an unlocked drag along an axis still reports it', () => {
    const { tool, onMeasurement } = makeTool()
    tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
    tool.onPointerMove(makeSnap(0, 4, 0), rayThrough(0, 4))
    expect(onMeasurement.mock.calls.at(-1)?.[1]).toEqual([1])
  })

  it('a drag along no axis reports neutral', () => {
    const { tool, onMeasurement } = makeTool()
    tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
    tool.onPointerMove(makeSnap(3, 3, 0), rayThrough(3, 3))
    expect(onMeasurement.mock.calls.at(-1)?.[1]).toEqual([null])
  })

  // Under a moved frame the lock IS a frame axis, so the dot follows the
  // frame rather than the world direction the move happens to travel.
  it('a lock under a moved frame reports the frame axis, not the world one', () => {
    // Red is world +Y in this frame.
    const { tool, onMeasurement } = makeTool(undefined, [0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 1])
    beginGestureLockedX(tool)
    tool.onPointerMove(makeSnap(0, 3, 0), rayThrough(0, 3))
    expect(onMeasurement.mock.calls.at(-1)?.[1]).toEqual([0])
  })

  // The array buffer ("3×5") is a copy count, not a distance — nothing
  // there has an axis, and a two-entry list would make the box try to split
  // it into two dimensions.
  it('the array readout carries no axes at all', () => {
    const { tool, onMeasurement } = makeTool()
    tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
    tool.onPointerMove(makeSnap(3, 0, 0), rayThrough(3, 0))
    tool.onPointerDown(makeSnap(3, 0, 0), rayThrough(3, 0)) // commits; the array window opens
    onMeasurement.mockClear()
    typeKeys(tool, '3x')
    const call = onMeasurement.mock.calls.at(-1)
    expect(call?.[0]).toContain('3')
    expect(call?.[1]).toBeUndefined()
  })
})

describe('MoveTool — locked typed-entry direction (signed by the cursor\'s side of the base)', () => {
  // The typed commit's direction under a lock is `sign((dest - base) ·
  // lockDir) * lockDir`, with the sign defaulting POSITIVE when dest sits
  // exactly on the base. These three pin the whole contract the inference
  // engine's locked resolve feeds: hovering the base resolves the base
  // EXACTLY (never a noise-signed station — the Move+Alt donut e2e's
  // wrong-way copy), so the zero-displacement default must be +lock; and a
  // genuine dest on either side must sign the typed distance toward it.

  /** Begin at the origin, lock Z, and (optionally) track a locked dest. */
  function lockZAt(tool: MoveTool, dest?: [number, number, number]): void {
    tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
    tool.onKey(makeKeyEvent('ArrowUp'))
    if (dest !== undefined) {
      tool.onPointerMove(makeSnap(...dest), rayThrough(dest[0], dest[1]))
    }
  }

  it('dest exactly on the base (hovering the grab point): typed distance goes +lock', () => {
    const { tool, scene } = makeTool()
    lockZAt(tool) // no pointer move: dest === base, the on-anchor resolve
    typeKeys(tool, '0.5')
    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.transform_selection).toHaveBeenCalledTimes(1)
    const [, , , affine] = scene.transform_selection.mock.calls[0]
    expect(translationOf(affine as Float64Array)).toEqual([0, 0, 0.5])
  })

  it('dest on the NEGATIVE side (real geometry below the base): typed distance follows it down', () => {
    const { tool, scene } = makeTool()
    lockZAt(tool, [0, 0, -2]) // e.g. a hovered edge 2 m below, Z-locked
    typeKeys(tool, '0.5')
    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.transform_selection).toHaveBeenCalledTimes(1)
    const [, , , affine] = scene.transform_selection.mock.calls[0]
    expect(translationOf(affine as Float64Array)).toEqual([0, 0, -0.5])
  })

  it('dest on the POSITIVE side: typed distance follows it up', () => {
    const { tool, scene } = makeTool()
    lockZAt(tool, [0, 0, 2])
    typeKeys(tool, '0.5')
    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.transform_selection).toHaveBeenCalledTimes(1)
    const [, , , affine] = scene.transform_selection.mock.calls[0]
    expect(translationOf(affine as Float64Array)).toEqual([0, 0, 0.5])
  })
})

describe('MoveTool — durable Alt copy toggle', () => {
  it('tapping Alt toggles copy mode on and off (not hold-to-copy)', () => {
    const { tool, onCopyModeChange } = makeTool()
    expect(tool.statusHint()).toContain('start the move')

    tool.onKey(makeKeyEvent('Alt'))
    expect(onCopyModeChange).toHaveBeenLastCalledWith(true)
    expect(tool.statusHint()).toContain('Copy is on')

    tool.onKey(makeKeyEvent('Alt'))
    expect(onCopyModeChange).toHaveBeenLastCalledWith(false)
    expect(tool.statusHint()).toContain('start the move')
  })

  it('ignores Alt autorepeat (a held Alt toggles exactly once)', () => {
    const { tool, onCopyModeChange } = makeTool()
    tool.onKey(makeKeyEvent('Alt'))
    tool.onKey(makeKeyEvent('Alt', { repeat: true }))
    tool.onKey(makeKeyEvent('Alt', { repeat: true }))
    expect(onCopyModeChange).toHaveBeenCalledTimes(1)
    expect(onCopyModeChange).toHaveBeenLastCalledWith(true)
  })

  it('typed exact distance commits a COPY while toggled on — Alt long released', () => {
    const { tool, scene, onCommit } = makeTool()
    tool.onKey(makeKeyEvent('Alt')) // tap, release — durable
    beginGestureLockedX(tool)
    typeKeys(tool, '2')
    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    const [kinds, ids, affine, count] = scene.duplicate_selection_array.mock.calls[0]
    expect(Array.from(kinds as Uint8Array)).toEqual([0])
    expect(Array.from(ids as BigUint64Array)).toEqual([1n])
    expect(translationOf(affine as Float64Array)).toEqual([2, 0, 0])
    expect(count).toBe(1)
    expect(scene.transform_selection).not.toHaveBeenCalled()
    // The fresh clone becomes the committed selection.
    expect(onCommit).toHaveBeenCalledWith([{ kind: 'object', id: 100n }])
  })

  it('typed exact distance commits a plain MOVE after toggling back off', () => {
    const { tool, scene } = makeTool()
    tool.onKey(makeKeyEvent('Alt'))
    tool.onKey(makeKeyEvent('Alt')) // back off
    beginGestureLockedX(tool)
    typeKeys(tool, '2')
    tool.onKey(makeKeyEvent('Enter'))

    expect(scene.transform_selection).toHaveBeenCalledTimes(1)
    expect(scene.duplicate_selection_array).not.toHaveBeenCalled()
  })

  it('prefixes the readout with "Copy ·" while toggled on', () => {
    const { tool, onMeasurement } = makeTool()
    tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
    tool.onKey(makeKeyEvent('Alt'))
    const last = onMeasurement.mock.calls.at(-1)?.[0] as string
    expect(last.startsWith('Copy ·')).toBe(true)
  })
})

describe('MoveTool — copy modifier is platform-specific (Option on macOS, Ctrl elsewhere)', () => {
  it('toggleCopyMode() flips copy mode directly — the method a Windows/Linux Control clean tap calls', () => {
    const { tool, onCopyModeChange } = makeTool()
    tool.toggleCopyMode()
    expect(onCopyModeChange).toHaveBeenLastCalledWith(true)
    expect(tool.statusHint()).toContain('Copy is on')
    tool.toggleCopyMode()
    expect(onCopyModeChange).toHaveBeenLastCalledWith(false)
  })

  it('a bare Control keydown does NOT toggle copy mode on macOS — Option owns it here', () => {
    // Bare Control never reaches onKey via the real generic dispatch either
    // (Viewport gates it behind `!isMod`) — this pins that even a direct
    // call can't mistake Control for the mac copy modifier.
    const { tool, onCopyModeChange } = makeTool()
    tool.onKey(makeKeyEvent('Control'))
    expect(onCopyModeChange).not.toHaveBeenCalled()
  })

  it('a Windows/Linux Control clean tap toggles copy mode via toggleCopyMode, exactly as the Viewport calls it', () => {
    // Mirrors Viewport.tsx's onCtrlKeyUp branch: CleanModifierTap arms on a
    // bare Control keydown and fires toggleCopyMode on a clean keyup.
    const { tool, onCopyModeChange } = makeTool()
    const tap = new CleanModifierTap<{ toggleCopyMode(): void }>((key) => key === 'Control')

    tap.onKeyDown({ key: 'Control', repeat: false }, tool)
    const armed = tap.onKeyUp({ key: 'Control' }, tool)
    expect(armed).not.toBeNull()
    armed!.toggleCopyMode()
    expect(onCopyModeChange).toHaveBeenLastCalledWith(true)
  })

  it('a Ctrl+Z chord does NOT toggle copy mode (the clean-tap combo guard)', () => {
    const { tool, onCopyModeChange } = makeTool()
    const tap = new CleanModifierTap<{ toggleCopyMode(): void }>((key) => key === 'Control')

    tap.onKeyDown({ key: 'Control', repeat: false }, tool)
    tap.onKeyDown({ key: 'z', repeat: false }, tool) // Ctrl+Z joins the press
    const armed = tap.onKeyUp({ key: 'Control' }, tool)
    expect(armed).toBeNull()
    expect(onCopyModeChange).not.toHaveBeenCalled()
  })

  it('a Ctrl+C chord does NOT toggle copy mode either', () => {
    const { tool, onCopyModeChange } = makeTool()
    const tap = new CleanModifierTap<{ toggleCopyMode(): void }>((key) => key === 'Control')

    tap.onKeyDown({ key: 'Control', repeat: false }, tool)
    tap.onKeyDown({ key: 'c', repeat: false }, tool) // Ctrl+C joins the press
    expect(tap.onKeyUp({ key: 'Control' }, tool)).toBeNull()
    expect(onCopyModeChange).not.toHaveBeenCalled()
  })
})

describe('MoveTool — on Windows/Linux, Alt is NOT the copy modifier (Ctrl is)', () => {
  it('a bare Alt keydown does nothing when isMac is false — toggleCopyMode is still reachable directly', async () => {
    vi.resetModules()
    vi.doMock('../platform', () => ({
      isMac: false,
      isLinux: false,
      isWindows: true,
      modLabel: 'Ctrl+',
      COPY_MODIFIER_KEY: 'Control',
      COPY_MODIFIER_LABEL: 'Ctrl',
      isCoarsePointer: () => false,
      prefersReducedMotion: () => false,
    }))
    const { MoveTool: MoveToolOnWindows } = await import('./MoveTool')
    const { scene } = makeWasmScene()
    const onCopyModeChange = vi.fn()
    const tool = new MoveToolOnWindows(
      scene as never,
      new THREE.Group(),
      null,
      [{ kind: 'object', id: 1n }],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      null,
      onCopyModeChange,
      vi.fn(),
    )

    tool.onKey(makeKeyEvent('Alt'))
    expect(onCopyModeChange).not.toHaveBeenCalled()
    expect(tool.statusHint()).not.toContain('Copy is on')

    // The Viewport's Control clean tap calls this directly on this platform.
    tool.toggleCopyMode()
    expect(onCopyModeChange).toHaveBeenLastCalledWith(true)
    expect(tool.statusHint()).toContain('Copy is on')
    expect(tool.statusHint()).toContain('Ctrl')
  })
})

describe('MoveTool — sketch copy (playtest: "you can\'t Copy a Sketch")', () => {
  it('Alt copy of a sketch island REPLAYS it at the offset instead of moving it', () => {
    const t = makeTool([{ kind: 'sketch-island', id: 40n, sketch: 3n }])
    t.tool.onKey(makeKeyEvent('Alt'))
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))

    // One gesture bracket, the island's edge re-drawn translated by +2 X.
    expect(t.scene.sketch_begin_gesture).toHaveBeenCalledTimes(1)
    expect(t.scene.sketch_add_segment).toHaveBeenCalledTimes(1)
    expect(t.scene.sketch_add_segment).toHaveBeenCalledWith(3n, 2, 0, 0, 3, 0, 0)
    expect(t.scene.sketch_end_gesture).toHaveBeenCalledTimes(1)
    // A COPY, not a move — and no object-duplicate call for a pure sketch
    // selection.
    expect(t.scene.transform_sketch_island).not.toHaveBeenCalled()
    expect(t.scene.transform_sketch).not.toHaveBeenCalled()
    expect(t.scene.duplicate_selection_array).not.toHaveBeenCalled()
    // The new island becomes the committed selection.
    expect(t.onCommit).toHaveBeenCalledWith([{ kind: 'sketch-island', id: 77n, sketch: 3n }])
    expect(t.onToast).not.toHaveBeenCalled()
  })

  it('a sketch copy arms the ×N array window: the copy gesture retracts and array_sketch_islands lays the array down', () => {
    const t = makeTool([{ kind: 'sketch-island', id: 40n, sketch: 3n }])
    t.tool.onKey(makeKeyEvent('Alt'))
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.sketch_end_gesture).toHaveBeenCalledTimes(1)

    typeKeys(t.tool, 'x3')
    t.tool.onKey(makeKeyEvent('Enter'))
    // One gesture step to retract, then one array call for the sketch.
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(t.scene.array_sketch_islands).toHaveBeenCalledTimes(1)
    const [sketch, islands, sx, sy, sz, count] = (t.scene.array_sketch_islands as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sketch).toBe(3n)
    expect(Array.from(islands as BigUint64Array)).toEqual([40n])
    expect([sx, sy, sz, count]).toEqual([2, 0, 0, 3])
    expect(t.scene.duplicate_selection_array).not.toHaveBeenCalled()
  })

  it('a mixed selection duplicates objects AND replays sketches, and arrays both', () => {
    const t = makeTool([
      { kind: 'object', id: 1n },
      { kind: 'sketch-island', id: 40n, sketch: 3n },
    ])
    t.tool.onKey(makeKeyEvent('Alt'))
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))

    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    expect(t.scene.sketch_end_gesture).toHaveBeenCalledTimes(1)
    expect(t.onCommit).toHaveBeenCalledWith([
      { kind: 'sketch-island', id: 77n, sketch: 3n },
      { kind: 'object', id: 100n },
    ])

    typeKeys(t.tool, 'x3')
    t.tool.onKey(makeKeyEvent('Enter'))
    // Both steps of the copy retract (the sketch gesture and the node
    // array), then the sketch array and a 3-count node array land.
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(2)
    expect(t.scene.array_sketch_islands).toHaveBeenCalledTimes(1)
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(2)
    expect((t.scene.duplicate_selection_array as ReturnType<typeof vi.fn>).mock.calls[1][3]).toBe(3)
  })
})

describe('MoveTool — ×N / /N array copy', () => {
  /** Tap Alt, move 1 selected object 2 m along X via the VCB — the copy
   * commit that arms the array refinement. */
  function commitOneCopy(t: ReturnType<typeof makeTool>): void {
    t.tool.onKey(makeKeyEvent('Alt'))
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
  }

  it('teaches the refinement in the status hint after a copy commits (SketchUp 3x form first)', () => {
    const t = makeTool()
    commitOneCopy(t)
    expect(t.tool.statusHint()).toContain('3x')
    expect(t.tool.statusHint()).toContain('3/')
  })

  it('the SketchUp trailing form 3x + Enter resolves exactly like x3', () => {
    const t = makeTool()
    commitOneCopy(t)

    typeKeys(t.tool, '3x')
    // The trailing form's leading digit is buffer input, and it reads back
    // with the display glyph: "3×".
    // No axes: a copy count has no direction (viewport/measurementAxes.ts).
    expect(t.onMeasurement).toHaveBeenLastCalledWith('3×', undefined)
    t.tool.onKey(makeKeyEvent('Enter'))

    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    const [, ids, affine, count] = t.scene.duplicate_selection_array.mock.calls[1]
    expect(Array.from(ids as BigUint64Array)).toEqual([1n])
    expect(translationOf(affine as Float64Array)).toEqual([2, 0, 0])
    expect(count).toBe(3)
  })

  it('the trailing divide form 4/ + Enter divides the committed distance', () => {
    const t = makeTool()
    commitOneCopy(t)

    typeKeys(t.tool, '4/')
    t.tool.onKey(makeKeyEvent('Enter'))
    const call = t.scene.duplicate_selection_array.mock.calls.at(-1)!
    expect(translationOf(call[2] as Float64Array)).toEqual([0.5, 0, 0])
    expect(call[3]).toBe(4)
  })

  it('x3 + Enter re-resolves into 3 copies at the SAME spacing (one undo retracts the single copy first)', () => {
    const t = makeTool()
    commitOneCopy(t)

    typeKeys(t.tool, 'x3')
    expect(t.tool.capturingInput()).toBe(true) // digits must not switch tools
    t.tool.onKey(makeKeyEvent('Enter'))

    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(2)
    const [kinds, ids, affine, count] = t.scene.duplicate_selection_array.mock.calls[1]
    expect(Array.from(kinds as Uint8Array)).toEqual([0])
    expect(Array.from(ids as BigUint64Array)).toEqual([1n]) // the ORIGINAL source
    expect(translationOf(affine as Float64Array)).toEqual([2, 0, 0])
    expect(count).toBe(3)
    // All three clones become the selection via the full-refresh commit path.
    expect(t.onArrayCommit).toHaveBeenCalledTimes(1)
    expect((t.onArrayCommit.mock.calls[0][0] as NodeRef[]).length).toBe(3)
  })

  it('*N works like xN; /N divides the committed distance', () => {
    const t = makeTool()
    commitOneCopy(t)

    typeKeys(t.tool, '*4')
    t.tool.onKey(makeKeyEvent('Enter'))
    let call = t.scene.duplicate_selection_array.mock.calls.at(-1)!
    expect(translationOf(call[2] as Float64Array)).toEqual([2, 0, 0])
    expect(call[3]).toBe(4)

    // Still hot — refine again, this time dividing: step = 2 m / 4.
    typeKeys(t.tool, '/4')
    t.tool.onKey(makeKeyEvent('Enter'))
    call = t.scene.duplicate_selection_array.mock.calls.at(-1)!
    expect(translationOf(call[2] as Float64Array)).toEqual([0.5, 0, 0])
    expect(call[3]).toBe(4)
    // Each refinement retracted the previous commit with ONE undo.
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(2)
  })

  it('refuses the refinement when the HISTORY moved even though the content hash did not (net-zero edit pair)', () => {
    // The adversarial-review reproduction: a tag added then removed leaves
    // state_hash identical while pushing two real undo actions. A hash
    // guard passes here — and its undo would silently eat the tag edit,
    // then stack a second array on the still-committed first.
    const t = makeTool()
    commitOneCopy(t)

    t.state.gen += 2n // two pushed actions, content restored (hash untouched)
    typeKeys(t.tool, 'x3')
    t.tool.onKey(makeKeyEvent('Enter'))

    expect(t.scene.scene_undo).not.toHaveBeenCalled()
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    // Closing the window is announced, not a silent no-op Enter.
    expect(t.onToast).toHaveBeenCalledWith(
      expect.stringContaining('the model changed'),
    )
    // The window is over: further array input is inert.
    typeKeys(t.tool, 'x3')
    expect(t.tool.capturingInput()).toBe(false)
  })

  it('survives view-state changes that move the hash but not the history (hide/eye toggles)', () => {
    // The inverse failure: set_tag_hidden / set_node_user_hidden change the
    // content hash but are deliberately not undoable — the undo stack (and
    // generation) are untouched, so an innocent declutter-hide must NOT
    // kill the refinement window.
    const t = makeTool()
    commitOneCopy(t)

    t.state.hash += 100n // view-state toggle: hash moves, generation doesn't
    typeKeys(t.tool, 'x3')
    t.tool.onKey(makeKeyEvent('Enter'))

    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    const call = t.scene.duplicate_selection_array.mock.calls.at(-1)!
    expect(call[3]).toBe(3)
    expect(t.onArrayCommit).toHaveBeenCalledTimes(1)
  })

  it('the armed window captures input, so Delete/Backspace cannot destroy the copies (App defers to capturingInput)', () => {
    const t = makeTool()
    commitOneCopy(t)

    // Armed but nothing typed yet — the status bar is inviting "Type ×3…";
    // App.tsx's Delete/Backspace handler checks exactly this flag before
    // firing edit-delete on the selection (which IS the just-made copies).
    expect(t.tool.capturingInput()).toBe(true)

    // Backspace routes to the tool and edits the (empty) buffer harmlessly.
    t.tool.onKey(makeKeyEvent('Backspace'))
    expect(t.tool.capturingInput()).toBe(true)

    // Esc remains the way out of the window.
    t.tool.onKey(makeKeyEvent('Escape'))
    expect(t.tool.capturingInput()).toBe(false)
  })

  it('the armed window captures only its buffer keys — Space and letters fall through (per-key capture)', () => {
    const t = makeTool()
    commitOneCopy(t)

    // Armed: the buffer needs digits, mode tokens, Backspace, Enter — plus
    // the bare Delete keystroke guard over the just-made copies.
    for (const key of ['0', '9', 'x', 'X', '*', '/', 'Backspace', 'Delete', 'Enter']) {
      expect(t.tool.capturesKey(key), `armed must capture ${JSON.stringify(key)}`).toBe(true)
    }
    // Space must NEVER be captured (it always resets to Select — the
    // Viewport's fall-through does the switch and the switch cancels the
    // tool, quietly ending the window). Tab and letter shortcuts fall
    // through to their global meanings too.
    for (const key of [' ', 'Tab', 'm', 'q', 'r', 'Escape']) {
      expect(t.tool.capturesKey(key), `armed must not capture ${JSON.stringify(key)}`).toBe(false)
    }
  })

  it('a mid-gesture VCB still captures the whole keyboard (Space is length grammar)', () => {
    const t = makeTool()
    beginGestureLockedX(t.tool)
    // "5' 3" needs the space; unit suffixes need letters.
    for (const key of [' ', '5', 'm', 'c', 'Backspace', 'Enter']) {
      expect(t.tool.capturesKey(key)).toBe(true)
    }
  })

  it('Space exit is quiet: the tool-switch cancel disarms without undoing the copies', () => {
    const t = makeTool()
    commitOneCopy(t)
    typeKeys(t.tool, '5') // even with a partial buffer typed
    expect(t.tool.capturesKey(' ')).toBe(false)

    // What the Viewport does on the fall-through: switch tools, which
    // cancels the outgoing MoveTool.
    t.tool.cancel()

    expect(t.tool.capturingInput()).toBe(false)
    // The committed copy is untouched — no retraction, no toast.
    expect(t.scene.scene_undo).not.toHaveBeenCalled()
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    expect(t.onToast).not.toHaveBeenCalled()
    // A stray Enter afterwards is inert.
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).not.toHaveBeenCalled()
  })

  it('garbage input resolves to nothing and a new gesture ends the window', () => {
    const t = makeTool()
    commitOneCopy(t)

    // A bare mode token is not a valid spec.
    typeKeys(t.tool, 'x')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).not.toHaveBeenCalled()

    // Starting another gesture closes the refinement window entirely.
    t.tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
    typeKeys(t.tool, 'x3')
    t.tool.onKey(makeKeyEvent('Escape')) // cancel the gesture
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).not.toHaveBeenCalled()
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
  })

  it('a refused refinement restores the retracted copies with redo and keeps the window hot', () => {
    const t = makeTool()
    commitOneCopy(t)

    t.scene.duplicate_selection_array.mockImplementationOnce(() => {
      throw new Error('Transform: refused')
    })
    typeKeys(t.tool, 'x3')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(t.scene.scene_redo).toHaveBeenCalledTimes(1)
    expect(t.onToast).toHaveBeenCalled()

    // The recovery undo+redo moved the history generation; the window
    // re-stamped its token, so a fresh count still resolves.
    typeKeys(t.tool, 'x2')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(2)
    const call = t.scene.duplicate_selection_array.mock.calls.at(-1)!
    expect(call[3]).toBe(2)
    expect(t.onArrayCommit).toHaveBeenCalledTimes(1)
  })

  it('disarmArray (explicit delete/undo/redo commands) closes the window cleanly: capture released, later Enter quietly inert', () => {
    const t = makeTool()
    commitOneCopy(t)
    t.onToast.mockClear()
    expect(t.tool.capturingInput()).toBe(true)

    // The Viewport calls this from runDelete AND runUndo/runRedo — every
    // explicit document command ends the window before executing, so the
    // keyboard capture releases and tool shortcuts route normally again.
    t.tool.disarmArray()

    // Window gone: the keyboard guard releases (Delete works again) ...
    expect(t.tool.capturingInput()).toBe(false)
    // ... and a later x3 + Enter does nothing — no wrong-action undo, no
    // second array, and no toast spam (the user asked for the delete).
    typeKeys(t.tool, 'x3')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).not.toHaveBeenCalled()
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    expect(t.onToast).not.toHaveBeenCalled()
  })

  it('refuses a count above the kernel cap with a toast, before any undo fires', () => {
    const t = makeTool()
    commitOneCopy(t)

    typeKeys(t.tool, 'x1001')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.onToast).toHaveBeenCalledWith(expect.stringContaining('1000'))
    expect(t.scene.scene_undo).not.toHaveBeenCalled()
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    // The cap comes from the scene — the single source of truth.
    expect(t.scene.max_array_count).toHaveBeenCalled()
  })
})

// ---- select-and-transform acquirer coverage (select-ux branch) ----

/** A ray straight down (−Z) through world (x, y). */
function rayThroughSel(x: number, y: number): Ray {
  return { origin: [x, y, 5], direction: [0, 0, -1] }
}

function makeSnapSel(overrides: Partial<Snap> = {}): Snap {
  return { x: 0, y: 0, z: 0, kind: 'ground', ...overrides }
}

/** Minimal WasmScene stub — only the members MoveTool calls in these paths. */
function makeWasmSceneSel() {
  return {
    history_generation: vi.fn(() => 1n),
    transform_selection: vi.fn(),
    /** The document's drawing axes, world identity. */
    axes: vi.fn(() => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])),
  }
}

function makeToolSel(selection: NodeRef[] = []) {
  const preview = new THREE.Group()
  const onCommit = vi.fn()
  const onToast = vi.fn()
  const onMeasurement = vi.fn()
  const wasmScene = makeWasmSceneSel()
  const tool = new MoveTool(
    wasmScene as never,
    preview,
    null, // objectsGroup — null means no ghost mesh is cloned (fine for logic tests)
    selection,
    onCommit,
    onToast,
    onMeasurement,
    null,
  )
  return { tool, preview, onCommit, onToast, onMeasurement, wasmScene }
}

describe('MoveTool — auto-select on click', () => {
  // Deliberate contract change (selection-UX overhaul): moving an object no
  // longer requires a two-step Select-then-Move — an empty-selection click
  // acquires the node under the cursor and starts the move on it.
  it('empty selection: the first click acquires the node under the cursor and sets the base point', () => {
    const { tool, onToast } = makeToolSel([])
    const acquire = vi.fn(() => [{ kind: 'object', id: 7n } as NodeRef])
    tool.setSelectionAcquirer(acquire)

    tool.onPointerDown(makeSnapSel({ x: 1, y: 1, z: 0 }), rayThroughSel(1, 1))

    expect(acquire).toHaveBeenCalledTimes(1)
    expect(acquire).toHaveBeenCalledWith(rayThroughSel(1, 1))
    expect(onToast).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(true) // in 'base' stage — the move began
  })

  it('the acquired node is what the second click commits (one fluid select-and-move)', () => {
    const { tool, wasmScene, onCommit } = makeToolSel([])
    tool.setSelectionAcquirer(() => [{ kind: 'object', id: 7n }])

    tool.onPointerDown(makeSnapSel({ x: 0, y: 0, z: 0 }), rayThroughSel(0, 0)) // base (auto-select)
    tool.onPointerMove(makeSnapSel({ x: 2, y: 0, z: 0 }), rayThroughSel(2, 0))
    tool.onPointerDown(makeSnapSel({ x: 2, y: 0, z: 0 }), rayThroughSel(2, 0)) // destination

    expect(wasmScene.transform_selection).toHaveBeenCalledTimes(1)
    const [kinds, ids, , affine] = (wasmScene.transform_selection as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(Array.from(kinds as Uint8Array)).toEqual([0]) // one object
    expect(Array.from(ids as BigUint64Array)).toEqual([7n])
    expect((affine as Float64Array)[3]).toBeCloseTo(2) // tx = 2
    expect(onCommit).toHaveBeenCalledWith([{ kind: 'object', id: 7n }])
    expect(tool.capturingInput()).toBe(false) // reset to idle after commit
  })

  it('a genuine miss (acquirer returns null) toasts and stays idle', () => {
    const { tool, onToast } = makeToolSel([])
    tool.setSelectionAcquirer(() => null)
    tool.onPointerDown(makeSnapSel(), rayThroughSel(0, 0))
    expect(onToast).toHaveBeenCalledWith('Click an object to move it')
    expect(tool.capturingInput()).toBe(false)
  })

  it('an existing selection is never re-acquired — the click is the base point as before', () => {
    const { tool, onToast } = makeToolSel([{ kind: 'object', id: 3n }])
    const acquire = vi.fn(() => [{ kind: 'object', id: 7n } as NodeRef])
    tool.setSelectionAcquirer(acquire)

    tool.onPointerDown(makeSnapSel({ x: 1, y: 1, z: 0 }), rayThroughSel(1, 1))
    expect(acquire).not.toHaveBeenCalled()
    expect(onToast).not.toHaveBeenCalled()
    expect(tool.capturingInput()).toBe(true)
  })
})

describe('MoveTool — live selection sync (setSelection)', () => {
  it('setSelection replaces the cached targets so the next gesture commits against live handles', () => {
    // The maintainer's repro tail: after Undo killed the two array copies,
    // MoveTool's cached targets still pointed at the dead clones and the
    // next 8cm copy failed with UnknownObject. The Viewport pushes every
    // app-selection change (undo pruning included) into the active tool.
    const t = makeTool([
      { kind: 'object', id: 101n },
      { kind: 'object', id: 102n },
      { kind: 'object', id: 103n },
    ])
    t.tool.setSelection([{ kind: 'object', id: 1n }])

    t.tool.onKey(makeKeyEvent('Alt')) // copy mode
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))

    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    const [, ids] = t.scene.duplicate_selection_array.mock.calls[0]
    expect(Array.from(ids as BigUint64Array)).toEqual([1n])
    expect(t.onToast).not.toHaveBeenCalled()
  })

  it('an emptied selection falls back to the auto-acquire path instead of a dead-handle commit', () => {
    const t = makeTool([{ kind: 'object', id: 101n }])
    t.tool.setSelection([])
    t.tool.onPointerDown(makeSnap(0, 0, 0), rayThrough(0, 0))
    // No acquirer injected: the tool hints and stays idle — no kernel call.
    expect(t.onToast).toHaveBeenCalledWith('Click an object to move it')
    expect(t.tool.capturingInput()).toBe(false)
  })
})

describe('MoveTool — setEditContext aborts an armed gesture on a genuine change (component-edit-parity.md phase A2)', () => {
  it('a genuine context change cancels an armed drag instead of silently retargeting its eventual commit', () => {
    const t = makeTool()
    t.tool.setEditContext({ kind: 'instance', id: 9n, component: 90n })
    beginGestureLockedX(t.tool)
    expect(t.tool.capturingInput()).toBe(true)

    t.tool.setEditContext({ kind: 'top' })

    expect(t.tool.capturingInput()).toBe(false)
  })

  it('re-pushing the SAME context is a no-op — an armed drag survives it untouched', () => {
    const t = makeTool()
    const ctx = { kind: 'instance' as const, id: 9n, component: 90n }
    t.tool.setEditContext(ctx)
    beginGestureLockedX(t.tool)
    expect(t.tool.capturingInput()).toBe(true)

    t.tool.setEditContext({ kind: 'instance', id: 9n, component: 90n })

    expect(t.tool.capturingInput()).toBe(true)
  })
})

// Post-commit distance retype (retypeWindow.ts): type a distance after a
// move or copy commits and it is redone at that distance along the same
// direction. Shares the idle buffer with the ×N / /N array window.
describe('MoveTool — retype the distance after the commit', () => {
  const lastTranslation = (t: ReturnType<typeof makeTool>) => {
    const calls = t.scene.transform_selection.mock.calls
    return translationOf(calls[calls.length - 1][3] as Float64Array)
  }

  it('a plain move redone at a typed distance: one undo, the same nodes moved the new distance along X', () => {
    const t = makeTool()
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.transform_selection).toHaveBeenCalledTimes(1)
    expect(lastTranslation(t)).toEqual([2, 0, 0])
    expect(t.tool.statusHint()).toContain('redo the move')
    expect(t.tool.capturesKey('3')).toBe(true)
    expect(t.tool.capturesKey('m')).toBe(false) // shortcuts still work with an empty buffer
    expect(t.tool.capturesKey(' ')).toBe(false)

    typeKeys(t.tool, '3')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(t.scene.transform_selection).toHaveBeenCalledTimes(2)
    expect(lastTranslation(t)).toEqual([3, 0, 0])
    expect(t.onCommit).toHaveBeenCalledTimes(2)

    // Negative flips; Space is never captured even with a buffer open.
    typeKeys(t.tool, '-1')
    expect(t.tool.capturesKey(' ')).toBe(false)
    t.tool.onKey(makeKeyEvent('Enter'))
    const tr = lastTranslation(t)
    expect(tr[0]).toBeCloseTo(-1, 9)
    expect(tr[1]).toBeCloseTo(0, 9)
    expect(tr[2]).toBeCloseTo(0, 9)
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(2)
  })

  it('a copy redone at a typed distance re-duplicates from the originals; 3x afterwards still arrays', () => {
    const t = makeTool()
    t.tool.onKey(makeKeyEvent('Alt')) // copy on
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(1)
    expect(t.tool.statusHint()).toContain('redo the copy')

    typeKeys(t.tool, '3')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(2)
    const dupCalls = t.scene.duplicate_selection_array.mock.calls
    const affine = dupCalls[1][2] as Float64Array
    expect(translationOf(affine)).toEqual([3, 0, 0])

    // The array window rides along: 3x now makes three copies at 3 m spacing.
    typeKeys(t.tool, '3x')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.duplicate_selection_array).toHaveBeenCalledTimes(3)
    expect(dupCalls[2][3]).toBe(3)
  })

  it('Escape closes the window; a stale generation is reported', () => {
    const t = makeTool()
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    typeKeys(t.tool, '4')
    t.tool.onKey(makeKeyEvent('Escape'))
    expect(t.tool.capturesKey('4')).toBe(false)

    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    t.state.gen++ // something else recorded
    typeKeys(t.tool, '4')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).not.toHaveBeenCalled()
    expect(t.onToast).toHaveBeenCalledWith(expect.stringContaining('move'))
  })
})

describe('MoveTool — retype window edge cases', () => {
  it('a half-typed post-commit value does not leak into the next gesture', () => {
    const t = makeTool()
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    typeKeys(t.tool, '7') // starts a retype, never finished
    beginGestureLockedX(t.tool) // new gesture
    typeKeys(t.tool, '1')
    t.tool.onKey(makeKeyEvent('Enter'))
    const calls = t.scene.transform_selection.mock.calls
    expect(translationOf(calls[calls.length - 1][3] as Float64Array)[0]).toBeCloseTo(1, 9) // not 71
  })

  it('after a PLAIN move, a slash is an imperial fraction bar, not an array token', () => {
    const t = makeTool()
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2')
    t.tool.onKey(makeKeyEvent('Enter'))
    typeKeys(t.tool, '1/2"')
    t.tool.onKey(makeKeyEvent('Enter'))
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(1)
    const calls = t.scene.transform_selection.mock.calls
    expect(translationOf(calls[calls.length - 1][3] as Float64Array)[0]).toBeCloseTo(0.0127, 6)
  })
})

describe('MoveTool — a typed distance after an array re-spaces the array', () => {
  it('copy 2, then 3x, then 3 → three copies at 3 m; then 5x → five at 3 m; then 1.5 → five at 1.5 m', () => {
    const t = makeTool()
    t.tool.onKey(makeKeyEvent('Alt'))
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2'); t.tool.onKey(makeKeyEvent('Enter'))
    const dup = t.scene.duplicate_selection_array.mock.calls
    typeKeys(t.tool, '3x'); t.tool.onKey(makeKeyEvent('Enter'))
    expect(dup.length).toBe(2)
    expect(dup[1][3]).toBe(3)
    expect(translationOf(dup[1][2] as Float64Array)[0]).toBeCloseTo(2, 9)

    typeKeys(t.tool, '3'); t.tool.onKey(makeKeyEvent('Enter'))
    expect(dup.length).toBe(3)
    expect(dup[2][3]).toBe(3)
    expect(translationOf(dup[2][2] as Float64Array)[0]).toBeCloseTo(3, 9)

    typeKeys(t.tool, '5x'); t.tool.onKey(makeKeyEvent('Enter'))
    expect(dup.length).toBe(4)
    expect(dup[3][3]).toBe(5)
    expect(translationOf(dup[3][2] as Float64Array)[0]).toBeCloseTo(3, 9)

    typeKeys(t.tool, '1.5'); t.tool.onKey(makeKeyEvent('Enter'))
    expect(dup.length).toBe(5)
    expect(dup[4][3]).toBe(5)
    expect(translationOf(dup[4][2] as Float64Array)[0]).toBeCloseTo(1.5, 9)
    // Every re-space retracted exactly the previous array (one step each).
    expect(t.scene.scene_undo).toHaveBeenCalledTimes(4)
  })

  it('a divide array re-spaced keeps dividing the NEW distance', () => {
    const t = makeTool()
    t.tool.onKey(makeKeyEvent('Alt'))
    beginGestureLockedX(t.tool)
    typeKeys(t.tool, '2'); t.tool.onKey(makeKeyEvent('Enter'))
    typeKeys(t.tool, '4/'); t.tool.onKey(makeKeyEvent('Enter'))
    typeKeys(t.tool, '8'); t.tool.onKey(makeKeyEvent('Enter'))
    const dup = t.scene.duplicate_selection_array.mock.calls
    expect(dup[dup.length - 1][3]).toBe(4)
    expect(translationOf(dup[dup.length - 1][2] as Float64Array)[0]).toBeCloseTo(2, 9) // 8 / 4
  })
})
