/**
 * DocumentTree — imprint child rows (imprints.ts): a plain object row lists
 * its drawn-but-not-yet-pushed face shapes as indented child rows, clicking
 * one selects the imprint ref through the same `onSelect` every other row
 * uses.
 *
 * A plain JS object stands in for the wasm Scene (the panel imports the type
 * only, erased at runtime — the same convention ComponentsPanel.test.tsx /
 * scenePanels.test.tsx use), so no wasm/loader mock is required.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DocumentTree } from './DocumentTree'
import type { Scene as WasmScene } from '../wasm/loader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeScene(overrides: Record<string, any> = {}): WasmScene {
  return {
    top_level_nodes: () => [],
    group_members: () => [],
    sketch_ids: () => [],
    sketch_island_ids: () => [],
    node_parent: () => undefined,
    object_name: () => undefined,
    group_name: () => undefined,
    instance_name: () => undefined,
    instance_def: () => undefined,
    component_name: () => undefined,
    face_features: () => '[]',
    ...overrides,
  } as unknown as WasmScene
}

const baseProps = {
  docRev: 0,
  docGeneration: 0,
  watertightMap: new Map<bigint, boolean>(),
  selectedIds: [],
  activeContext: [],
  sessionStack: [],
  sessionMembers: null,
  onEnterContext: vi.fn(),
  onExitContext: vi.fn(),
  onSetContextDepth: vi.fn(),
  hiddenKeys: new Set<string>(),
  onToggleHidden: vi.fn(),
  onSetHiddenMany: vi.fn(),
  onReparent: vi.fn(),
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

describe('DocumentTree — imprint child rows', () => {
  it("lists an object's single circle imprint as a child row under it", () => {
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: (id: bigint) => (id === 1n ? 'Panel' : undefined),
      face_features: (object: bigint) => (object === 1n ? CIRCLE_JSON : '[]'),
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Panel')).toBeInTheDocument()
    expect(screen.getByText('Circle')).toBeInTheDocument()
  })

  it('clicking the imprint child row selects the imprint ref via onSelect', () => {
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: () => 'Panel',
      face_features: (object: bigint) => (object === 1n ? CIRCLE_JSON : '[]'),
    })
    const onSelect = vi.fn()
    render(<DocumentTree {...baseProps} scene={scene} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Circle'))
    expect(onSelect).toHaveBeenCalledWith({ kind: 'imprint', id: 10n, object: 1n }, false)
  })

  it('an object with no imprints shows no imprint child row', () => {
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: () => 'Panel',
      face_features: () => '[]',
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Panel')).toBeInTheDocument()
    expect(screen.queryByText('Circle')).not.toBeInTheDocument()
  })

  it('numbers two same-named imprints on one object ("Circle 1" / "Circle 2")', () => {
    const twoCircles = JSON.stringify([
      { kind: 'sub_face', face: 10, parent: 1, loop: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], curve: [0.5, 0.5, 0, 0.5], nested: [] },
      { kind: 'sub_face', face: 11, parent: 1, loop: [2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0], curve: [2.5, 0.5, 0, 0.5], nested: [] },
    ])
    const scene = makeScene({
      top_level_nodes: () => [{ kind: 'object', id: 1n }],
      object_name: () => 'Panel',
      face_features: (object: bigint) => (object === 1n ? twoCircles : '[]'),
    })
    render(<DocumentTree {...baseProps} scene={scene} onSelect={vi.fn()} />)
    expect(screen.getByText('Circle 1')).toBeInTheDocument()
    expect(screen.getByText('Circle 2')).toBeInTheDocument()
  })
})
