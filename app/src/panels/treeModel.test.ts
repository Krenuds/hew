import { describe, it, expect } from 'vitest'
import {
  entityLabel,
  resolveLabel,
  breadcrumb,
  isTreeRowDimmed,
  nextSelection,
  mergeSelection,
  canBoolean,
  canGroup,
  canUngroup,
  nodeEq,
  nodeRefFromJs,
  nodeKindToNumber,
  isTreeMemberKind,
  shapeLabel,
  selectedSketchOf,
  canMakeComponent,
  canPlaceInstance,
  canExplodeInstance,
  canMakeUnique,
  canBooleanInComponent,
  stripTagSuffix,
  collectLeafIds,
  buildTreeIndexMap,
  nodeKey,
  structuralSelection,
  pruneDeadSelection,
  collectDescendants,
  filterTreeKeys,
  dropTargetFor,
  type NodeRef,
} from './treeModel'

describe('nodeEq / nodeKey — sketch-edge scoping', () => {
  it('two edges with the same id in DIFFERENT sketches are distinct', () => {
    const a: NodeRef = { kind: 'sketch-edge', id: 5n, sketch: 1n }
    const b: NodeRef = { kind: 'sketch-edge', id: 5n, sketch: 2n }
    expect(nodeEq(a, b)).toBe(false)
    expect(nodeKey(a)).not.toBe(nodeKey(b))
  })

  it('the same edge equals itself and keys stably', () => {
    const a: NodeRef = { kind: 'sketch-edge', id: 5n, sketch: 1n }
    const b: NodeRef = { kind: 'sketch-edge', id: 5n, sketch: 1n }
    expect(nodeEq(a, b)).toBe(true)
    expect(nodeKey(a)).toBe(nodeKey(b))
  })

  it('an edge never equals its owning sketch or an object with the same id', () => {
    const edge: NodeRef = { kind: 'sketch-edge', id: 5n, sketch: 1n }
    expect(nodeEq(edge, { kind: 'sketch', id: 1n })).toBe(false)
    expect(nodeEq(edge, { kind: 'object', id: 5n })).toBe(false)
    expect(nodeKey(edge)).not.toBe(nodeKey({ kind: 'sketch', id: 1n }))
  })

  it('plain node keys are unchanged by the optional sketch field being absent', () => {
    expect(nodeKey({ kind: 'object', id: 3n })).toBe('object:3')
  })
})

describe('nodeEq / nodeKey — imprint object scoping', () => {
  it('two imprints with the same face id on DIFFERENT objects are distinct', () => {
    const a: NodeRef = { kind: 'imprint', id: 10n, object: 1n }
    const b: NodeRef = { kind: 'imprint', id: 10n, object: 2n }
    expect(nodeEq(a, b)).toBe(false)
    expect(nodeKey(a)).not.toBe(nodeKey(b))
  })

  it('the same imprint equals itself and keys stably', () => {
    const a: NodeRef = { kind: 'imprint', id: 10n, object: 1n }
    const b: NodeRef = { kind: 'imprint', id: 10n, object: 1n }
    expect(nodeEq(a, b)).toBe(true)
    expect(nodeKey(a)).toBe(nodeKey(b))
  })

  it('an imprint-chord never equals an imprint with the same id/object (kind differs)', () => {
    const subFace: NodeRef = { kind: 'imprint', id: 5n, object: 1n }
    const chord: NodeRef = { kind: 'imprint-chord', id: 5n, object: 1n }
    expect(nodeEq(subFace, chord)).toBe(false)
    expect(nodeKey(subFace)).not.toBe(nodeKey(chord))
  })

  it('an imprint never equals a plain object with the same id (object-scoped vs unscoped keys differ)', () => {
    const imprint: NodeRef = { kind: 'imprint', id: 5n, object: 1n }
    expect(nodeEq(imprint, { kind: 'object', id: 5n })).toBe(false)
    expect(nodeKey(imprint)).not.toBe(nodeKey({ kind: 'object', id: 5n }))
  })
})

describe('stripTagSuffix', () => {
  it('returns the name unchanged when there is no tag suffix', () => {
    expect(stripTagSuffix('Counter Base')).toBe('Counter Base')
    expect(stripTagSuffix('')).toBe('')
  })

  it('strips the __HEWTAG__ portion and everything after it', () => {
    expect(stripTagSuffix('Roof Truss A__HEWTAG__Structure')).toBe('Roof Truss A')
    expect(stripTagSuffix('Wall__HEWTAG__Exterior')).toBe('Wall')
  })

  it('handles the underscore-mangled delimiter SketchUp exports', () => {
    // Empty display (unnamed group) → empty string.
    expect(stripTagSuffix('___HEWTAG__Exterior_Foundation')).toBe('')
    expect(stripTagSuffix('Wall___HEWTAG__Roof_Framing')).toBe('Wall')
  })
})

describe('entityLabel', () => {
  it('is 1-based per kind', () => {
    expect(entityLabel('object', 0)).toBe('Object 1')
    expect(entityLabel('object', 2)).toBe('Object 3')
    expect(entityLabel('sketch', 0)).toBe('Sketch 1')
    expect(entityLabel('group', 0)).toBe('Group 1')
    expect(entityLabel('group', 2)).toBe('Group 3')
    expect(entityLabel('instance', 0)).toBe('Component 1')
    expect(entityLabel('instance', 2)).toBe('Component 3')
  })
})

describe('resolveLabel', () => {
  it('returns the kernel name when present', () => {
    expect(resolveLabel('Counter_Base', undefined, 'object', 0)).toBe('Counter_Base')
    expect(resolveLabel('My Group', undefined, 'group', 2)).toBe('My Group')
    expect(resolveLabel('Chair', undefined, 'instance', 0)).toBe('Chair')
  })

  it('strips __HEWTAG__ suffix from kernel names for display', () => {
    expect(resolveLabel('Roof Truss A__HEWTAG__Structure', undefined, 'object', 0)).toBe('Roof Truss A')
    expect(resolveLabel('Wall__HEWTAG__Exterior', undefined, 'group', 0)).toBe('Wall')
  })

  it('falls back to entityLabel when kernel name is absent', () => {
    expect(resolveLabel(undefined, undefined, 'object', 0)).toBe('Object 1')
    expect(resolveLabel(undefined, undefined, 'group', 2)).toBe('Group 3')
    expect(resolveLabel(undefined, undefined, 'instance', 0)).toBe('Component 1')
  })

  it('uses the def name for an instance with no own name', () => {
    expect(resolveLabel(undefined, 'TableDef', 'instance', 0)).toBe('TableDef')
  })

  it('shows "Instance Name (Definition Name)" when an instance has its own name', () => {
    expect(resolveLabel('My Table', 'TableDef', 'instance', 0)).toBe('My Table (TableDef)')
  })

  it('drops the parenthetical when instance and definition names coincide', () => {
    expect(resolveLabel('Table', 'Table', 'instance', 0)).toBe('Table')
  })

  it('shows just the instance name when the definition is unnamed', () => {
    expect(resolveLabel('My Table', undefined, 'instance', 0)).toBe('My Table')
  })

  it('ignores defName for non-instance kinds (falls through to entityLabel)', () => {
    // defName is only meaningful for instances; other kinds fall back to positional
    expect(resolveLabel(undefined, 'SomeDefName', 'object', 1)).toBe('Object 2')
    expect(resolveLabel(undefined, 'SomeDefName', 'group', 1)).toBe('Group 2')
  })

  it('falls back to positional when instance has neither own name nor def name', () => {
    expect(resolveLabel(undefined, undefined, 'instance', 3)).toBe('Component 4')
  })
})

describe('nodeKindToNumber', () => {
  it('maps object → 0, group → 1, instance → 2', () => {
    expect(nodeKindToNumber('object')).toBe(0)
    expect(nodeKindToNumber('group')).toBe(1)
    expect(nodeKindToNumber('instance')).toBe(2)
  })

  it('maps a whole sketch to kernel node kind 3', () => {
    expect(nodeKindToNumber('sketch')).toBe(3)
  })

  it('gives the sketch-scoped and imprint kinds the -1 sentinel (no kernel NodeId)', () => {
    for (const kind of ['sketch-island', 'sketch-curve', 'sketch-edge', 'imprint', 'imprint-chord'] as const) {
      expect(nodeKindToNumber(kind)).toBe(-1)
    }
  })
})

describe('isTreeMemberKind', () => {
  it('is true for exactly the kinds the structural kernel calls take', () => {
    expect(isTreeMemberKind('object')).toBe(true)
    expect(isTreeMemberKind('group')).toBe(true)
    expect(isTreeMemberKind('instance')).toBe(true)
  })

  it('is false for a whole sketch even though it has a kernel node kind', () => {
    // The trap this predicate exists for: `nodeKindToNumber('sketch') >= 0`,
    // but the kernel refuses a sketch in every structural call.
    expect(isTreeMemberKind('sketch')).toBe(false)
    expect(isTreeMemberKind('sketch-island')).toBe(false)
    expect(isTreeMemberKind('imprint')).toBe(false)
  })

  it('keeps a whole sketch out of every structural gate', () => {
    const o: NodeRef = { kind: 'object', id: 1n }
    const sk: NodeRef = { kind: 'sketch', id: 5n }
    const noParent = () => undefined
    expect(structuralSelection([o, sk])).toBeNull()
    expect(canGroup([o, sk], noParent)).toBe(false)
    expect(canMakeComponent([o, sk], noParent)).toBe(false)
    expect(
      dropTargetFor([sk], 'root', { getGroupMembers: () => [], sessionOpen: false }),
    ).toBeNull()
  })
})

describe('shapeLabel', () => {
  it('numbers the shapes of a sketch from 1', () => {
    expect(shapeLabel(0)).toBe('Shape 1')
    expect(shapeLabel(2)).toBe('Shape 3')
  })
})

describe('canMakeComponent', () => {
  const a: NodeRef = { kind: 'object', id: 1n }
  const b: NodeRef = { kind: 'object', id: 2n }
  const g: NodeRef = { kind: 'group', id: 3n }
  const inst: NodeRef = { kind: 'instance', id: 4n }

  const noParent = (_n: NodeRef) => undefined

  it('true for 2 sibling objects', () => {
    expect(canMakeComponent([a, b], noParent)).toBe(true)
  })

  it('true for object + group at top level', () => {
    expect(canMakeComponent([a, g], noParent)).toBe(true)
  })

  // Nested components: a selected instance folds in as a nested member of
  // the new definition (the kernel accepts it), so the gate must open —
  // this used to refuse while nested definitions were unsupported.
  it('true when an instance is in the selection (it becomes a nested member)', () => {
    expect(canMakeComponent([a, inst], noParent)).toBe(true)
  })

  it('true for a single object (the common case)', () => {
    expect(canMakeComponent([a], noParent)).toBe(true)
  })

  it('false for an empty selection', () => {
    expect(canMakeComponent([], noParent)).toBe(false)
  })

  it('true for a single instance (wrapping one component in another)', () => {
    expect(canMakeComponent([inst], noParent)).toBe(true)
  })

  it('false for nodes with different parents', () => {
    const mixedParent = (n: NodeRef) => n.id === 1n ? 99n : 100n
    expect(canMakeComponent([a, b], mixedParent)).toBe(false)
  })

  // Sketch-scoped NodeRefs have no kernel NodeId: letting one through the
  // gate forwards its id into the object handle space downstream, where the
  // slotmaps' reused bit patterns can silently alias an unrelated live node.
  it('false for any sketch-kind selection (no kernel NodeId — id-space guard)', () => {
    const sk: NodeRef = { kind: 'sketch', id: 5n }
    const island: NodeRef = { kind: 'sketch-island', id: 6n, sketch: 5n }
    const edge: NodeRef = { kind: 'sketch-edge', id: 7n, sketch: 5n }
    expect(canMakeComponent([sk], noParent)).toBe(false)
    expect(canMakeComponent([island], noParent)).toBe(false)
    expect(canMakeComponent([a, sk], noParent)).toBe(false)
    expect(canMakeComponent([a, edge], noParent)).toBe(false)
  })
})

describe('canGroup — sketch-kind guard', () => {
  const a: NodeRef = { kind: 'object', id: 1n }
  const b: NodeRef = { kind: 'object', id: 2n }
  const noParent = (_n: NodeRef) => undefined

  it('false when any sketch-kind node is in the selection', () => {
    const sk: NodeRef = { kind: 'sketch', id: 5n }
    const curve: NodeRef = { kind: 'sketch-curve', id: 6n, sketch: 5n }
    expect(canGroup([a, sk], noParent)).toBe(false)
    expect(canGroup([a, b, curve], noParent)).toBe(false)
  })
})

describe('structuralSelection — the node-id-space boundary', () => {
  it('collapses object/group/instance selections to parallel kind/id arrays', () => {
    const sel = structuralSelection([
      { kind: 'object', id: 1n },
      { kind: 'group', id: 2n },
      { kind: 'instance', id: 3n },
    ])
    expect(sel).not.toBeNull()
    expect(Array.from(sel!.kinds)).toEqual([0, 1, 2])
    expect(Array.from(sel!.ids)).toEqual([1n, 2n, 3n])
  })

  it('refuses (null) when ANY node is sketch-scoped — a sketch id must never enter the node-id handle space', () => {
    expect(structuralSelection([{ kind: 'sketch', id: 5n }])).toBeNull()
    expect(structuralSelection([
      { kind: 'object', id: 1n },
      { kind: 'sketch-island', id: 6n, sketch: 5n },
    ])).toBeNull()
    expect(structuralSelection([
      { kind: 'sketch-edge', id: 7n, sketch: 5n },
    ])).toBeNull()
    expect(structuralSelection([
      { kind: 'sketch-curve', id: 8n, sketch: 5n },
    ])).toBeNull()
  })

  it('an empty selection collapses to empty arrays (caller guards emptiness itself)', () => {
    const sel = structuralSelection([])
    expect(sel).not.toBeNull()
    expect(sel!.kinds.length).toBe(0)
  })
})

describe('canPlaceInstance', () => {
  const inst: NodeRef = { kind: 'instance', id: 1n }
  const obj: NodeRef = { kind: 'object', id: 2n }

  it('true for exactly one selected instance', () => {
    expect(canPlaceInstance([inst])).toBe(true)
  })

  it('false for an object', () => {
    expect(canPlaceInstance([obj])).toBe(false)
  })

  it('false for empty selection', () => {
    expect(canPlaceInstance([])).toBe(false)
  })

  it('false for two instances', () => {
    const inst2: NodeRef = { kind: 'instance', id: 3n }
    expect(canPlaceInstance([inst, inst2])).toBe(false)
  })
})

describe('canExplodeInstance', () => {
  const inst: NodeRef = { kind: 'instance', id: 1n }
  const obj: NodeRef = { kind: 'object', id: 2n }
  const grp: NodeRef = { kind: 'group', id: 3n }

  it('true for exactly one selected instance', () => {
    expect(canExplodeInstance([inst])).toBe(true)
  })

  it('false for an object', () => {
    expect(canExplodeInstance([obj])).toBe(false)
  })

  it('false for a group', () => {
    expect(canExplodeInstance([grp])).toBe(false)
  })

  it('false for empty selection', () => {
    expect(canExplodeInstance([])).toBe(false)
  })

  it('false for two instances', () => {
    const inst2: NodeRef = { kind: 'instance', id: 4n }
    expect(canExplodeInstance([inst, inst2])).toBe(false)
  })
})

describe('canMakeUnique', () => {
  const inst: NodeRef = { kind: 'instance', id: 1n }
  const obj: NodeRef = { kind: 'object', id: 2n }
  const grp: NodeRef = { kind: 'group', id: 3n }

  it('true for exactly one selected instance', () => {
    expect(canMakeUnique([inst])).toBe(true)
  })

  it('false for an object', () => {
    expect(canMakeUnique([obj])).toBe(false)
  })

  it('false for a group', () => {
    expect(canMakeUnique([grp])).toBe(false)
  })

  it('false for empty selection', () => {
    expect(canMakeUnique([])).toBe(false)
  })

  it('false for two instances', () => {
    const inst2: NodeRef = { kind: 'instance', id: 4n }
    expect(canMakeUnique([inst, inst2])).toBe(false)
  })
})

describe('nodeEq', () => {
  it('matches same kind and id', () => {
    expect(nodeEq({ kind: 'object', id: 1n }, { kind: 'object', id: 1n })).toBe(true)
  })
  it('does not match different kind', () => {
    expect(nodeEq({ kind: 'object', id: 1n }, { kind: 'group', id: 1n })).toBe(false)
  })
  it('does not match different id', () => {
    expect(nodeEq({ kind: 'object', id: 1n }, { kind: 'object', id: 2n })).toBe(false)
  })
})

describe('nodeRefFromJs', () => {
  it('converts a NodeJs-like value to NodeRef', () => {
    const js = { kind: 'group', id: 5n }
    const ref = nodeRefFromJs(js)
    expect(ref).toEqual({ kind: 'group', id: 5n })
  })
})

describe('collectLeafIds', () => {
  it('a plain object is its own leaf', () => {
    const result = collectLeafIds({ kind: 'object', id: 1n }, () => [])
    expect(result).toEqual({ objectIds: [1n], instanceIds: [] })
  })

  it('a plain instance is its own leaf', () => {
    const result = collectLeafIds({ kind: 'instance', id: 5n }, () => [])
    expect(result).toEqual({ objectIds: [], instanceIds: [5n] })
  })

  it('a sketch contributes no leaves', () => {
    const result = collectLeafIds({ kind: 'sketch', id: 9n }, () => [])
    expect(result).toEqual({ objectIds: [], instanceIds: [] })
  })

  it('a group expands to its direct object and instance members', () => {
    const members: Record<string, NodeRef[]> = {
      '10': [{ kind: 'object', id: 1n }, { kind: 'instance', id: 2n }],
    }
    const result = collectLeafIds({ kind: 'group', id: 10n }, (id) => members[String(id)] ?? [])
    expect(result.objectIds).toEqual([1n])
    expect(result.instanceIds).toEqual([2n])
  })

  it('recurses through nested subgroups (imported components arrive as a group-of-groups)', () => {
    // group 10 -> [object 1, group 20 -> [instance 2, group 30 -> [object 3]]]
    const members: Record<string, NodeRef[]> = {
      '10': [{ kind: 'object', id: 1n }, { kind: 'group', id: 20n }],
      '20': [{ kind: 'instance', id: 2n }, { kind: 'group', id: 30n }],
      '30': [{ kind: 'object', id: 3n }],
    }
    const result = collectLeafIds({ kind: 'group', id: 10n }, (id) => members[String(id)] ?? [])
    expect(result.objectIds.sort()).toEqual([1n, 3n].sort())
    expect(result.instanceIds).toEqual([2n])
  })

  it('an empty group contributes no leaves', () => {
    const result = collectLeafIds({ kind: 'group', id: 10n }, () => [])
    expect(result).toEqual({ objectIds: [], instanceIds: [] })
  })
})

describe('breadcrumb', () => {
  const labelFor = (n: NodeRef) =>
    n.kind === 'object' ? `Object ${n.id}` : `Group ${n.id}`

  it('is just Model at top level (empty path)', () => {
    expect(breadcrumb([], labelFor)).toEqual([{ label: 'Model', depth: -1 }])
  })

  it('appends path nodes with their labels and depths', () => {
    const g: NodeRef = { kind: 'group', id: 10n }
    const o: NodeRef = { kind: 'object', id: 20n }
    expect(breadcrumb([g, o], labelFor)).toEqual([
      { label: 'Model', depth: -1 },
      { label: 'Group 10', depth: 0 },
      { label: 'Object 20', depth: 1 },
    ])
  })
})

describe('isTreeRowDimmed', () => {
  const g: NodeRef = { kind: 'group', id: 10n }
  const o: NodeRef = { kind: 'object', id: 20n }
  const other: NodeRef = { kind: 'object', id: 30n }

  it('dims nothing at top level (empty path)', () => {
    expect(isTreeRowDimmed([], g, 0)).toBe(false)
    expect(isTreeRowDimmed([], o, 0)).toBe(false)
  })

  it('dims rows not matching the context node at depth 0', () => {
    expect(isTreeRowDimmed([g], other, 0)).toBe(true)
    expect(isTreeRowDimmed([g], g, 0)).toBe(false)
  })

  it('does not dim rows deeper than the path (they are inside the context)', () => {
    // path has 1 node; rows at depth 1 are children of the context → not dimmed
    expect(isTreeRowDimmed([g], o, 1)).toBe(false)
  })

  it('dims a sibling at depth 1 inside a group context', () => {
    expect(isTreeRowDimmed([g, o], other, 1)).toBe(true)
    expect(isTreeRowDimmed([g, o], o, 1)).toBe(false)
  })
})

describe('canGroup', () => {
  const a: NodeRef = { kind: 'object', id: 1n }
  const b: NodeRef = { kind: 'object', id: 2n }
  const c: NodeRef = { kind: 'group', id: 3n }

  const noParent = (_n: NodeRef) => undefined
  const parentGroup = (_n: NodeRef) => 99n

  it('requires at least 2 distinct nodes', () => {
    expect(canGroup([a], noParent)).toBe(false)
    expect(canGroup([a, a], noParent)).toBe(false)
  })

  it('true for 2 top-level nodes', () => {
    expect(canGroup([a, b], noParent)).toBe(true)
  })

  it('true for 2 nodes sharing the same parent group', () => {
    expect(canGroup([a, b], parentGroup)).toBe(true)
  })

  it('false when nodes have different parents', () => {
    const mixedParent = (n: NodeRef) => n.id === 1n ? 99n : 100n
    expect(canGroup([a, b], mixedParent)).toBe(false)
  })

  it('true for object + group at top level', () => {
    expect(canGroup([a, c], noParent)).toBe(true)
  })
})

describe('canBoolean', () => {
  const a: NodeRef = { kind: 'object', id: 1n }
  const b: NodeRef = { kind: 'object', id: 2n }
  const g: NodeRef = { kind: 'group', id: 3n }
  const inst: NodeRef = { kind: 'instance', id: 4n }

  const topLevel = (_n: NodeRef) => undefined
  const live = (_n: NodeRef) => true

  it('true for two top-level objects, object+group, two groups, and an instance operand', () => {
    expect(canBoolean([a, b], topLevel, live)).toBe(true)
    expect(canBoolean([a, g], topLevel, live)).toBe(true)
    expect(canBoolean([g, { kind: 'group', id: 5n }], topLevel, live)).toBe(true)
    // A component instance is a valid operand (playtest finding 4): the
    // kernel refuses it directly, but the app transparently explodes it and
    // retries (Viewport.tsx's runBoolean) — the gate must not disable the
    // command for a selection that flow can actually handle.
    expect(canBoolean([a, inst], topLevel, live)).toBe(true)
    expect(canBoolean([inst, { kind: 'instance', id: 6n }], topLevel, live)).toBe(true)
  })

  it('requires exactly two distinct operands', () => {
    expect(canBoolean([a], topLevel, live)).toBe(false)
    expect(canBoolean([a, a], topLevel, live)).toBe(false)
    expect(canBoolean([a, b, g], topLevel, live)).toBe(false)
  })

  it('false when either operand is NESTED inside a group — the gate must match the kernel GroupedOperand refusal', () => {
    const nestedFirst = (n: NodeRef) => (n.id === 1n ? 99n : undefined)
    expect(canBoolean([a, b], nestedFirst, live)).toBe(false)
    const nestedSecond = (n: NodeRef) => (n.id === 3n ? 99n : undefined)
    expect(canBoolean([a, g], nestedSecond, live)).toBe(false)
    const bothNested = (_n: NodeRef) => 99n
    expect(canBoolean([a, b], bothNested, live)).toBe(false)
  })

  it('false for non-live operands (a stale/hidden id, whatever the kind)', () => {
    const bStale = (n: NodeRef) => n.id !== 2n
    expect(canBoolean([a, b], topLevel, bStale)).toBe(false)
    const instStale = (n: NodeRef) => n.id !== 4n
    expect(canBoolean([a, inst], topLevel, instStale)).toBe(false)
  })
})

// component-edit-parity.md phase A2.
describe('canBooleanInComponent', () => {
  const a: NodeRef = { kind: 'object', id: 1n }
  const b: NodeRef = { kind: 'object', id: 2n }
  const g: NodeRef = { kind: 'group', id: 3n }
  const inst: NodeRef = { kind: 'instance', id: 4n }
  const member = (n: NodeRef) => n.id === 1n || n.id === 2n

  it('true for two distinct member objects', () => {
    expect(canBooleanInComponent([a, b], member)).toBe(true)
  })

  it('requires exactly two distinct operands', () => {
    expect(canBooleanInComponent([a], member)).toBe(false)
    expect(canBooleanInComponent([a, a], member)).toBe(false)
  })

  it('false for a group or instance operand — a definition has no nested groups/instances', () => {
    expect(canBooleanInComponent([a, g], member)).toBe(false)
    expect(canBooleanInComponent([a, inst], member)).toBe(false)
  })

  it('false when either operand is not a member of the entered definition', () => {
    const notMember: NodeRef = { kind: 'object', id: 99n }
    expect(canBooleanInComponent([a, notMember], member)).toBe(false)
  })
})

describe('canUngroup', () => {
  const g: NodeRef = { kind: 'group', id: 1n }
  const o: NodeRef = { kind: 'object', id: 2n }

  it('true for exactly one selected group', () => {
    expect(canUngroup([g])).toBe(true)
  })

  it('false for an object', () => {
    expect(canUngroup([o])).toBe(false)
  })

  it('false for zero selection', () => {
    expect(canUngroup([])).toBe(false)
  })

  it('false for two groups', () => {
    const g2: NodeRef = { kind: 'group', id: 3n }
    expect(canUngroup([g, g2])).toBe(false)
  })
})

describe('nextSelection (NodeRef)', () => {
  const a: NodeRef = { kind: 'object', id: 10n }
  const b: NodeRef = { kind: 'object', id: 20n }
  const g: NodeRef = { kind: 'group', id: 30n }

  it('replaces on a plain click', () => {
    expect(nextSelection([a], b, 'replace')).toEqual([b])
  })

  it('clears on an empty click', () => {
    expect(nextSelection([a, b], null, 'replace')).toEqual([])
  })

  it('keeps the selection on a modified empty click (toggle/add/subtract on air)', () => {
    expect(nextSelection([a, b], null, 'toggle')).toEqual([a, b])
    expect(nextSelection([a, b], null, 'add')).toEqual([a, b])
    expect(nextSelection([a, b], null, 'subtract')).toEqual([a, b])
  })

  it('toggle appends a new node, preserving order', () => {
    expect(nextSelection([a], b, 'toggle')).toEqual([a, b])
  })

  it('toggle removes an already-selected node', () => {
    expect(nextSelection([a, b], a, 'toggle')).toEqual([b])
  })

  it('add appends a new node and never removes a selected one', () => {
    expect(nextSelection([a], b, 'add')).toEqual([a, b])
    expect(nextSelection([a, b], a, 'add')).toEqual([a, b])
  })

  it('subtract removes a selected node and never adds an unselected one', () => {
    expect(nextSelection([a, b], a, 'subtract')).toEqual([b])
    expect(nextSelection([a], b, 'subtract')).toEqual([a])
  })

  it('treats object and group with same id as distinct', () => {
    const sameIdGroup: NodeRef = { kind: 'group', id: 10n }
    // a is {object,10n}; sameIdGroup is {group,10n} — different nodes
    expect(nextSelection([a], sameIdGroup, 'toggle')).toEqual([a, sameIdGroup])
    expect(nextSelection([a, g], g, 'subtract')).toEqual([a])
  })
})

describe('mergeSelection (marquee / Select All / Invert)', () => {
  const a: NodeRef = { kind: 'object', id: 10n }
  const b: NodeRef = { kind: 'object', id: 20n }
  const c: NodeRef = { kind: 'group', id: 30n }
  const e: NodeRef = { kind: 'sketch-edge', id: 4n, sketch: 9n }

  it('replace hands back the picked nodes (an empty pick clears)', () => {
    expect(mergeSelection([a], [b, c], 'replace')).toEqual([b, c])
    expect(mergeSelection([a], [], 'replace')).toEqual([])
  })

  it('add merges without duplicates, keeping the existing order first', () => {
    expect(mergeSelection([a, b], [b, c], 'add')).toEqual([a, b, c])
  })

  it('add returns the same array when every picked node is already selected', () => {
    const cur = [a, b]
    expect(mergeSelection(cur, [b, a], 'add')).toBe(cur)
  })

  it('subtract drops the picked nodes and keeps the rest in order', () => {
    expect(mergeSelection([a, b, c], [b], 'subtract')).toEqual([a, c])
    const cur = [a]
    expect(mergeSelection(cur, [b], 'subtract')).toBe(cur)
  })

  it('toggle flips each picked node: selected ones leave, unselected ones join', () => {
    expect(mergeSelection([a, b], [b, c], 'toggle')).toEqual([a, c])
  })

  it('toggle with nothing picked leaves the selection untouched', () => {
    const cur = [a, b]
    expect(mergeSelection(cur, [], 'toggle')).toBe(cur)
  })

  it('keys sketch sub-entities by owning sketch too', () => {
    const eOther: NodeRef = { kind: 'sketch-edge', id: 4n, sketch: 8n }
    expect(mergeSelection([e], [eOther], 'add')).toEqual([e, eOther])
    expect(mergeSelection([e], [eOther], 'subtract')).toEqual([e])
  })
})

describe('buildTreeIndexMap', () => {
  const obj = (id: bigint): NodeRef => ({ kind: 'object', id })
  const grp = (id: bigint): NodeRef => ({ kind: 'group', id })
  const inst = (id: bigint): NodeRef => ({ kind: 'instance', id })

  it('indexes top-level nodes by their position in the tree, not per kind', () => {
    // Top level: [object 1n, group 2n, object 3n] — the Outliner numbers
    // rows by container position, so object 3n is index 2, not "second object".
    const map = buildTreeIndexMap([obj(1n), grp(2n), obj(3n)], () => [])
    expect(map.get(nodeKey(obj(1n)))).toBe(0)
    expect(map.get(nodeKey(grp(2n)))).toBe(1)
    expect(map.get(nodeKey(obj(3n)))).toBe(2)
  })

  it('numbers group members within the group, restarting from 0', () => {
    const members = new Map<bigint, NodeRef[]>([[2n, [inst(4n), obj(5n)]]])
    const map = buildTreeIndexMap(
      [obj(1n), grp(2n)],
      (id) => members.get(id) ?? [],
    )
    // The nested object is "Object 2" in the Outliner (position 1 in its
    // group) even though it is the second object globally too — the flat
    // object_ids() list would call it index 1 only by coincidence here; the
    // instance before it is what forces the container-relative answer.
    expect(map.get(nodeKey(inst(4n)))).toBe(0)
    expect(map.get(nodeKey(obj(5n)))).toBe(1)
  })

  it('recurses through nested groups', () => {
    const members = new Map<bigint, NodeRef[]>([
      [2n, [grp(6n)]],
      [6n, [obj(7n)]],
    ])
    const map = buildTreeIndexMap([grp(2n)], (id) => members.get(id) ?? [])
    expect(map.get(nodeKey(grp(6n)))).toBe(0)
    expect(map.get(nodeKey(obj(7n)))).toBe(0)
  })

  it('returns an empty map for an empty document', () => {
    expect(buildTreeIndexMap([], () => []).size).toBe(0)
  })
})

describe('collectDescendants', () => {
  const obj = (id: bigint): NodeRef => ({ kind: 'object', id })
  const grp = (id: bigint): NodeRef => ({ kind: 'group', id })

  it('returns the direct children of a leaf-only container', () => {
    const out = collectDescendants([obj(1n), obj(2n)], () => [])
    expect(out).toEqual([obj(1n), obj(2n)])
  })

  it('recurses through nested groups, including the intermediate groups themselves', () => {
    const members = new Map<bigint, NodeRef[]>([
      [10n, [grp(11n)]],
      [11n, [obj(1n)]],
    ])
    const out = collectDescendants([grp(10n)], (id) => members.get(id) ?? [])
    // Every level, not just the leaves: the intermediate group (11n) is
    // itself a descendant, since it can carry its own independent hidden
    // key (App.tsx's `handleSetHiddenMany`/`toggleContainerVisibility`
    // needs exactly this to clear a hidden grandchild).
    expect(out).toEqual([grp(10n), grp(11n), obj(1n)])
  })

  it('returns an empty array for no children', () => {
    expect(collectDescendants([], () => [])).toEqual([])
  })
})

describe('filterTreeKeys', () => {
  const obj = (id: bigint): NodeRef => ({ kind: 'object', id })
  const grp = (id: bigint): NodeRef => ({ kind: 'group', id })
  const labels = new Map<string, string>([
    [nodeKey(grp(10n)), 'Chassis'],
    [nodeKey(obj(1n)), 'Bridge Arch'],
    [nodeKey(obj(2n)), 'Wheel'],
  ])
  const getLabel = (n: NodeRef): string => labels.get(nodeKey(n)) ?? ''
  const members = new Map<bigint, NodeRef[]>([[10n, [obj(1n), obj(2n)]]])
  const getChildren = (n: NodeRef): NodeRef[] => (n.kind === 'group' ? members.get(n.id) ?? [] : [])
  const topNodes = [grp(10n)]

  it('returns null for a blank query — "no filter active"', () => {
    expect(filterTreeKeys(topNodes, getChildren, getLabel, '')).toBeNull()
    expect(filterTreeKeys(topNodes, getChildren, getLabel, '   ')).toBeNull()
  })

  it('matches case-insensitively on the same label text the row renders', () => {
    const result = filterTreeKeys(topNodes, getChildren, getLabel, 'bridge')
    expect(result).not.toBeNull()
    expect(result?.matches.has(nodeKey(obj(1n)))).toBe(true)
    expect(result?.matches.has(nodeKey(obj(2n)))).toBe(false)
  })

  it('marks a non-matching ancestor of a match as an ancestor, not a match', () => {
    const result = filterTreeKeys(topNodes, getChildren, getLabel, 'bridge')
    expect(result?.matches.has(nodeKey(grp(10n)))).toBe(false)
    expect(result?.ancestors.has(nodeKey(grp(10n)))).toBe(true)
  })

  it('a group that matches by its own name does not pull in its non-matching children', () => {
    const result = filterTreeKeys(topNodes, getChildren, getLabel, 'chassis')
    expect(result?.matches.has(nodeKey(grp(10n)))).toBe(true)
    expect(result?.matches.has(nodeKey(obj(1n)))).toBe(false)
    expect(result?.ancestors.has(nodeKey(obj(1n)))).toBe(false)
  })

  it('an empty result carries empty match/ancestor sets, not null', () => {
    const result = filterTreeKeys(topNodes, getChildren, getLabel, 'nonexistent')
    expect(result).not.toBeNull()
    expect(result?.matches.size).toBe(0)
    expect(result?.ancestors.size).toBe(0)
  })
})

describe('pruneDeadSelection — drop handles the document no longer holds', () => {
  /** Minimal liveness view over plain arrays; sketch sub-entity queries
   * throw on a dead sketch like the kernel's typed errors do. */
  function view(opts: {
    objects?: bigint[]
    groups?: bigint[]
    instances?: bigint[]
    sketches?: bigint[]
    edges?: Record<string, bigint[]>       // sketch id -> live edge ids
    islands?: Record<string, bigint[]>     // sketch id -> live island ids
  }) {
    const sketches = opts.sketches ?? []
    return {
      object_ids: () => opts.objects ?? [],
      group_ids: () => opts.groups ?? [],
      instance_ids: () => opts.instances ?? [],
      sketch_ids: () => sketches,
      sketch_edge_island: (s: bigint, e: bigint) =>
        (opts.edges?.[s.toString()] ?? []).includes(e) ? 1n : undefined,
      sketch_curve_chain: (s: bigint, e: bigint) => {
        if (!sketches.includes(s)) throw new Error('UnknownSketch')
        const live = opts.edges?.[s.toString()] ?? []
        if (!live.includes(e)) throw new Error('UnknownEdge')
        return BigUint64Array.from([e])
      },
      sketch_island_edges: (s: bigint, i: bigint) => {
        if (!sketches.includes(s)) throw new Error('UnknownSketch')
        const live = opts.islands?.[s.toString()] ?? []
        if (!live.includes(i)) throw new Error('UnknownIsland')
        return BigUint64Array.from([1n])
      },
    }
  }

  const obj = (id: bigint): NodeRef => ({ kind: 'object', id })
  const grp = (id: bigint): NodeRef => ({ kind: 'group', id })
  const inst = (id: bigint): NodeRef => ({ kind: 'instance', id })
  const sk = (id: bigint): NodeRef => ({ kind: 'sketch', id })

  it('keeps live nodes of every structural kind and drops dead ones', () => {
    const v = view({ objects: [1n], groups: [2n], instances: [3n], sketches: [4n] })
    const sel = [obj(1n), obj(9n), grp(2n), grp(8n), inst(3n), inst(7n), sk(4n), sk(6n)]
    expect(pruneDeadSelection(v, sel)).toEqual([obj(1n), grp(2n), inst(3n), sk(4n)])
  })

  it('returns the SAME array when nothing died (no render churn)', () => {
    const v = view({ objects: [1n, 2n] })
    const sel = [obj(1n), obj(2n)]
    expect(pruneDeadSelection(v, sel)).toBe(sel)
  })

  it('keeps live component-definition objects and sketches supplied by the active scope', () => {
    const v = view({ edges: { '12': [13n] } })
    const sel: NodeRef[] = [
      obj(11n),
      sk(12n),
      { kind: 'sketch-edge', id: 13n, sketch: 12n },
    ]
    expect(pruneDeadSelection(v, sel, [11n], [12n])).toBe(sel)
    expect(pruneDeadSelection(v, sel)).toEqual([])
  })

  it('prunes sketch-scoped kinds: dead edges, curves, and islands go; live ones stay', () => {
    const v = view({ sketches: [4n], edges: { '4': [10n] }, islands: { '4': [20n] } })
    const sel: NodeRef[] = [
      { kind: 'sketch-edge', id: 10n, sketch: 4n },
      { kind: 'sketch-edge', id: 11n, sketch: 4n },   // dead edge
      { kind: 'sketch-edge', id: 10n, sketch: 5n },   // dead sketch
      { kind: 'sketch-curve', id: 10n, sketch: 4n },
      { kind: 'sketch-curve', id: 12n, sketch: 4n },  // dead (throws)
      { kind: 'sketch-island', id: 20n, sketch: 4n },
      { kind: 'sketch-island', id: 21n, sketch: 4n }, // dead (throws)
    ]
    expect(pruneDeadSelection(v, sel)).toEqual([
      { kind: 'sketch-edge', id: 10n, sketch: 4n },
      { kind: 'sketch-curve', id: 10n, sketch: 4n },
      { kind: 'sketch-island', id: 20n, sketch: 4n },
    ])
  })

  it('an empty selection passes through untouched', () => {
    const sel: NodeRef[] = []
    expect(pruneDeadSelection(view({}), sel)).toBe(sel)
  })
})

describe('pruneDeadSelection — imprint liveness', () => {
  /** A liveness view carrying live objects plus each one's `face_features`
   *  JSON (imprints.ts), mirroring the kernel's own contract: an imprint is
   *  alive exactly while its object still lists its handle. */
  function view(objects: bigint[], faceFeatures: Record<string, string> = {}) {
    return {
      object_ids: () => objects,
      group_ids: () => [],
      instance_ids: () => [],
      sketch_ids: () => [],
      sketch_edge_island: () => undefined,
      sketch_curve_chain: () => [],
      sketch_island_edges: () => [],
      face_features: (object: bigint) => faceFeatures[object.toString()] ?? '[]',
    }
  }

  const subFaceFeature = (face: number) =>
    JSON.stringify([{ kind: 'sub_face', face, parent: 1, loop: [0, 0, 0, 1, 0, 0, 1, 1, 0], curve: null, nested: [] }])
  const chordFeature = (edge: number) =>
    JSON.stringify([{ kind: 'chord', edge, faces: [1, 2], path: [0, 0, 0, 1, 0, 0] }])

  it('keeps a live sub_face imprint whose face handle is still listed', () => {
    const v = view([1n], { '1': subFaceFeature(10) })
    const sel: NodeRef[] = [{ kind: 'imprint', id: 10n, object: 1n }]
    expect(pruneDeadSelection(v, sel)).toBe(sel)
  })

  it('keeps a live chord imprint whose first-edge handle is still listed', () => {
    const v = view([1n], { '1': chordFeature(5) })
    const sel: NodeRef[] = [{ kind: 'imprint-chord', id: 5n, object: 1n }]
    expect(pruneDeadSelection(v, sel)).toBe(sel)
  })

  it('drops an imprint whose handle is no longer in face_features (pushed into a boss, or a chord re-cut)', () => {
    const v = view([1n], { '1': subFaceFeature(10) })
    const sel: NodeRef[] = [
      { kind: 'imprint', id: 10n, object: 1n },
      { kind: 'imprint', id: 999n, object: 1n }, // no longer listed
    ]
    expect(pruneDeadSelection(v, sel)).toEqual([{ kind: 'imprint', id: 10n, object: 1n }])
  })

  it('drops an imprint whose owning object is gone', () => {
    const v = view([], { '1': subFaceFeature(10) })
    const sel: NodeRef[] = [{ kind: 'imprint', id: 10n, object: 1n }]
    expect(pruneDeadSelection(v, sel)).toEqual([])
  })

  it('drops every imprint when the scene double lacks face_features entirely', () => {
    const bare = {
      object_ids: () => [1n],
      group_ids: () => [],
      instance_ids: () => [],
      sketch_ids: () => [],
      sketch_edge_island: () => undefined,
      sketch_curve_chain: () => [],
      sketch_island_edges: () => [],
      // face_features intentionally omitted.
    }
    const sel: NodeRef[] = [{ kind: 'imprint', id: 10n, object: 1n }]
    expect(pruneDeadSelection(bare, sel)).toEqual([])
  })
})

describe('dropTargetFor', () => {
  // g contains b and h (nested); h contains c.
  const a: NodeRef = { kind: 'object', id: 1n }
  const b: NodeRef = { kind: 'object', id: 2n }
  const c: NodeRef = { kind: 'object', id: 3n }
  const g: NodeRef = { kind: 'group', id: 10n }
  const h: NodeRef = { kind: 'group', id: 11n }
  const inst: NodeRef = { kind: 'instance', id: 20n }
  const sk: NodeRef = { kind: 'sketch-island', id: 30n, sketch: 5n }

  const members: Record<string, NodeRef[]> = {
    '10': [b, h],
    '11': [c],
  }
  const getGroupMembers = (groupId: bigint): NodeRef[] => members[groupId.toString()] ?? []
  const view = (sessionOpen = false) => ({ getGroupMembers, sessionOpen })

  it('moving an object into a group resolves to that group', () => {
    expect(dropTargetFor([a], g, view())).toEqual({ group: 10n })
  })

  it('moving to the Model root resolves to undefined (top level)', () => {
    expect(dropTargetFor([a], 'root', view())).toEqual({ group: undefined })
  })

  it('refuses dropping a group onto itself', () => {
    expect(dropTargetFor([g], g, view())).toBeNull()
  })

  it('refuses dropping a group onto its own descendant', () => {
    expect(dropTargetFor([g], h, view())).toBeNull()
  })

  it('allows dropping an already-nested node back onto its current parent (a no-op move)', () => {
    expect(dropTargetFor([h], g, view())).toEqual({ group: 10n })
  })

  it('refuses a target that is neither a group nor root (an instance row)', () => {
    expect(dropTargetFor([a], inst, view())).toBeNull()
  })

  it('refuses a target that is a sketch row', () => {
    expect(dropTargetFor([a], sk, view())).toBeNull()
  })

  it('refuses dragging a sketch-scoped node — it has no kernel NodeId', () => {
    expect(dropTargetFor([sk], g, view())).toBeNull()
  })

  it('refuses every drop while a group/component session is open', () => {
    expect(dropTargetFor([a], g, view(true))).toBeNull()
    expect(dropTargetFor([a], 'root', view(true))).toBeNull()
  })

  it('refuses an empty drag', () => {
    expect(dropTargetFor([], g, view())).toBeNull()
  })

  it('refuses a multi-node drag when one of the dragged groups would contain the target', () => {
    expect(dropTargetFor([a, g], h, view())).toBeNull()
  })
})

describe('selectedSketchOf', () => {
  const sk: NodeRef = { kind: 'sketch', id: 5n }
  const shape: NodeRef = { kind: 'sketch-island', id: 105n, sketch: 5n }
  const line: NodeRef = { kind: 'sketch-edge', id: 9n, sketch: 5n }

  it('names the sketch for a whole-sketch selection', () => {
    expect(selectedSketchOf([sk])).toBe(5n)
  })

  it('names the owning sketch for shapes, lines and curves of one sketch', () => {
    expect(selectedSketchOf([shape, line])).toBe(5n)
    expect(selectedSketchOf([sk, shape])).toBe(5n)
  })

  it('names nothing for an empty, mixed, or two-sketch selection', () => {
    expect(selectedSketchOf([])).toBeUndefined()
    expect(selectedSketchOf([shape, { kind: 'object', id: 1n }])).toBeUndefined()
    expect(selectedSketchOf([shape, { kind: 'sketch-island', id: 1n, sketch: 6n }])).toBeUndefined()
    expect(selectedSketchOf([{ kind: 'imprint', id: 1n, object: 2n }])).toBeUndefined()
  })
})
