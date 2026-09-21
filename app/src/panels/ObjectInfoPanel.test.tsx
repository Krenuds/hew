/**
 * ObjectInfoPanel — imprint (drawn-but-not-yet-pushed shape on a solid
 * face — imprints.ts) selection: a read-only entry, checked BEFORE the
 * sketch-scoped branch it would otherwise fall into (a stale imprint carries
 * no `node.sketch`, so `node.sketch ?? id` would misread its FACE handle as
 * a sketch handle).
 *
 * A plain JS object stands in for the wasm Scene (the panel imports the type
 * only, erased at runtime — the same convention ComponentsPanel.test.tsx /
 * scenePanels.test.tsx use), so no wasm/loader mock is required.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ObjectInfoPanel } from './ObjectInfoPanel'
import type { Scene as WasmScene } from '../wasm/loader'
import type { NodeRef } from './treeModel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeScene(overrides: Record<string, any> = {}): WasmScene {
  return {
    top_level_nodes: () => [],
    group_members: () => [],
    object_name: () => undefined,
    sketch_name: () => undefined,
    face_features: () => '[]',
    ...overrides,
  } as unknown as WasmScene
}

const baseProps = {
  docRev: 0,
  onDocumentChanged: vi.fn(),
  onSelectMany: vi.fn(),
}

const CIRCLE_JSON = JSON.stringify([
  {
    kind: 'sub_face',
    face: 10,
    parent: 1,
    loop: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    curve: [0.5, 0.5, 0, 0.5],
    nested: [],
  },
])

describe('ObjectInfoPanel — imprint selection', () => {
  it('shows "Shape on face" as Type and "Circle on <object>" as Name, with a Points row', () => {
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: (id: bigint) => (id === 1n ? 'Panel' : undefined),
      face_features: (object: bigint) => (object === 1n ? CIRCLE_JSON : '[]'),
    })
    const selectedIds: NodeRef[] = [{ kind: 'imprint', id: 10n, object: 1n }]
    render(<ObjectInfoPanel {...baseProps} scene={scene} selectedIds={selectedIds} />)
    expect(screen.getByText('Shape on face')).toBeInTheDocument()
    expect(screen.getByText('Circle on Panel')).toBeInTheDocument()
    expect(screen.getByText('Points')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument() // the loop's 4 vertices
  })

  it('names a chord (imprint-chord) selection "Line on face" too', () => {
    const chordJson = JSON.stringify([{ kind: 'chord', edge: 5, faces: [1, 2], path: [0, 0, 0, 1, 0, 0] }])
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: () => 'Panel',
      face_features: (object: bigint) => (object === 1n ? chordJson : '[]'),
    })
    const selectedIds: NodeRef[] = [{ kind: 'imprint-chord', id: 5n, object: 1n }]
    render(<ObjectInfoPanel {...baseProps} scene={scene} selectedIds={selectedIds} />)
    expect(screen.getByText('Line on Panel')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument() // the path's 2 vertices
  })

  it('renders only the kind label — no Points row — for a stale imprint ref', () => {
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: () => 'Panel',
      face_features: () => '[]', // the imprint is gone (pushed, dissolved, re-cut)
    })
    const selectedIds: NodeRef[] = [{ kind: 'imprint', id: 999n, object: 1n }]
    render(<ObjectInfoPanel {...baseProps} scene={scene} selectedIds={selectedIds} />)
    expect(screen.getAllByText('Shape on face').length).toBeGreaterThan(0)
    expect(screen.queryByText('Points')).not.toBeInTheDocument()
  })

  it('renders nothing editable for an imprint — no Tags section', () => {
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: () => 'Panel',
      face_features: (object: bigint) => (object === 1n ? CIRCLE_JSON : '[]'),
    })
    const selectedIds: NodeRef[] = [{ kind: 'imprint', id: 10n, object: 1n }]
    render(<ObjectInfoPanel {...baseProps} scene={scene} selectedIds={selectedIds} />)
    expect(screen.queryByText('Tags')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Add tag')).not.toBeInTheDocument()
  })
})

/**
 * The Locked-sketch checkbox: a sketch's one toggle in this panel, and the
 * only UI affordance for the whole feature. Reads straight off the scene
 * each render (no local mirror), so the row is also the place a refused
 * flip must visibly not take.
 */
describe('ObjectInfoPanel — locked sketches', () => {
  /** A scene holding one sketch (`1n`) with a single island and edge. */
  function sketchScene(locked: boolean, overrides: Record<string, unknown> = {}): WasmScene {
    return makeScene({
      sketch_ids: () => BigUint64Array.from([1n]),
      sketch_island_ids: () => BigUint64Array.from([7n]),
      sketch_edge_island: () => 7n,
      sketch_locked: () => locked,
      set_sketch_locked: vi.fn(),
      ...overrides,
    })
  }

  const SKETCH: NodeRef[] = [{ kind: 'sketch-island', id: 7n, sketch: 1n }]

  it('shows an unlocked sketch as Stock, unchecked', () => {
    render(<ObjectInfoPanel {...baseProps} scene={sketchScene(false)} selectedIds={SKETCH} />)
    const box = screen.getByLabelText('Locked sketch') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByText('Stock')).toBeInTheDocument()
  })

  it('shows a locked sketch as Reference, checked', () => {
    render(<ObjectInfoPanel {...baseProps} scene={sketchScene(true)} selectedIds={SKETCH} />)
    const box = screen.getByLabelText('Locked sketch') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(screen.getByText('Reference')).toBeInTheDocument()
  })

  it('flips the flag on the OWNING sketch and reports the change', async () => {
    const setLocked = vi.fn()
    const onDocumentChanged = vi.fn()
    const scene = sketchScene(false, { set_sketch_locked: setLocked })
    render(
      <ObjectInfoPanel
        {...baseProps}
        onDocumentChanged={onDocumentChanged}
        scene={scene}
        selectedIds={SKETCH}
      />,
    )
    // Selecting ONE line of a sketch still locks the whole sketch — the flag
    // lives on the owner, not the sub-entity.
    screen.getByLabelText('Locked sketch').click()
    expect(setLocked).toHaveBeenCalledWith(1n, true)
    expect(onDocumentChanged).toHaveBeenCalled()
  })

  it('surfaces a refusal as a toast and does not report a change', () => {
    const onDocumentChanged = vi.fn()
    const onToast = vi.fn()
    const scene = sketchScene(false, {
      set_sketch_locked: () => {
        throw new Error('UnknownSketch: no such sketch')
      },
    })
    render(
      <ObjectInfoPanel
        {...baseProps}
        onDocumentChanged={onDocumentChanged}
        onToast={onToast}
        scene={scene}
        selectedIds={SKETCH}
      />,
    )
    screen.getByLabelText('Locked sketch').click()
    expect(onToast).toHaveBeenCalled()
    expect(onDocumentChanged).not.toHaveBeenCalled()
  })

  it('offers no Locked row for a non-sketch selection', () => {
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: () => 'Panel',
      object_solid: () => true,
      node_tags: () => [],
    })
    render(
      <ObjectInfoPanel {...baseProps} scene={scene} selectedIds={[{ kind: 'object', id: 1n }]} />,
    )
    expect(screen.queryByLabelText('Locked sketch')).toBeNull()
  })
})
