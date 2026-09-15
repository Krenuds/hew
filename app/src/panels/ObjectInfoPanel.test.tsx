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
