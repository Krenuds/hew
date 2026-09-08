import { describe, it, expect } from 'vitest'
import {
  parseHistoryEntries,
  parseContentHistoryEntries,
  filterContentEntries,
  originConnection,
  entriesSinceSaved,
  describeChangeCount,
  type HistoryEntries,
} from './changesModel'

describe('parseHistoryEntries', () => {
  it('returns an empty history for null/undefined', () => {
    expect(parseHistoryEntries(null)).toEqual({ undo: [], redo: [], savedDepth: null })
    expect(parseHistoryEntries(undefined)).toEqual({ undo: [], redo: [], savedDepth: null })
  })

  it('returns an empty history for malformed JSON', () => {
    expect(parseHistoryEntries('{not json')).toEqual({ undo: [], redo: [], savedDepth: null })
  })

  it('returns an empty history for a non-object payload', () => {
    expect(parseHistoryEntries('42')).toEqual({ undo: [], redo: [], savedDepth: null })
  })

  it('parses the real wire shape', () => {
    const json = JSON.stringify({
      undo: [{ label: 'Draw', origin: 'user', bookkeeping: false }],
      redo: [{ label: 'Push/Pull', origin: { connection: 'mcp:hew' }, bookkeeping: false }],
      savedDepth: 1,
    })
    expect(parseHistoryEntries(json)).toEqual({
      undo: [{ label: 'Draw', origin: 'user', bookkeeping: false }],
      redo: [{ label: 'Push/Pull', origin: { connection: 'mcp:hew' }, bookkeeping: false }],
      savedDepth: 1,
    })
  })

  it('falls back to empty arrays/null for missing fields', () => {
    expect(parseHistoryEntries('{}')).toEqual({ undo: [], redo: [], savedDepth: null })
  })
})

describe('filterContentEntries / parseContentHistoryEntries', () => {
  const content = (label: string) => ({ label, origin: 'user' as const, bookkeeping: false })
  const bookkeeping = (label: string) => ({ label, origin: 'user' as const, bookkeeping: true })

  it('drops bookkeeping entries from both stacks, leaving savedDepth untouched', () => {
    const entries: HistoryEntries = {
      undo: [content('Draw'), bookkeeping('Edit group'), content('Push/Pull')],
      redo: [bookkeeping('Finish editing group')],
      savedDepth: 2,
    }
    expect(filterContentEntries(entries)).toEqual({
      undo: [content('Draw'), content('Push/Pull')],
      redo: [],
      savedDepth: 2,
    })
  })

  it('returns the same reference when nothing was filtered (no bookkeeping entries)', () => {
    const entries: HistoryEntries = { undo: [content('Draw')], redo: [], savedDepth: 1 }
    expect(filterContentEntries(entries)).toBe(entries)
  })

  it('treats an all-bookkeeping session (e.g. only entering a group edit) as empty content, saved at depth 0', () => {
    // Mirrors the kernel: entering a group edit right after a save pushes
    // ONE undo entry that is pure bookkeeping — content_depth is 0 both
    // before and after, so savedDepth (a content depth) is 0.
    const entries: HistoryEntries = {
      undo: [bookkeeping('Edit group')],
      redo: [],
      savedDepth: 0,
    }
    const filtered = filterContentEntries(entries)
    expect(filtered).toEqual({ undo: [], redo: [], savedDepth: 0 })
    const { shown, more, undone } = entriesSinceSaved(filtered)
    expect(shown).toEqual([])
    expect(more).toBe(0)
    expect(undone).toBe(false)
    expect(describeChangeCount(shown.length, undone)).toBe('No changes since last save.')
  })

  it('parseContentHistoryEntries is parseHistoryEntries + filterContentEntries in one call', () => {
    const json = JSON.stringify({
      undo: [
        { label: 'Draw', origin: 'user', bookkeeping: false },
        { label: 'Edit group', origin: 'user', bookkeeping: true },
      ],
      redo: [],
      savedDepth: 1,
    })
    expect(parseContentHistoryEntries(json)).toEqual({
      undo: [{ label: 'Draw', origin: 'user', bookkeeping: false }],
      redo: [],
      savedDepth: 1,
    })
  })
})

describe('originConnection', () => {
  it('is null for a user-authored entry', () => {
    expect(originConnection('user')).toBeNull()
  })

  it('is the connection id for an API-authored entry', () => {
    expect(originConnection({ connection: 'mcp:hew' })).toBe('mcp:hew')
  })
})

describe('entriesSinceSaved', () => {
  const entry = (label: string) => ({ label, origin: 'user' as const, bookkeeping: false })

  it('returns everything since the saved depth, unedited when under the cap', () => {
    const entries: HistoryEntries = {
      undo: [entry('Draw'), entry('Extrude'), entry('Move')],
      redo: [],
      savedDepth: 1,
    }
    const { shown, more, undone } = entriesSinceSaved(entries)
    expect(shown).toEqual([entry('Extrude'), entry('Move')])
    expect(more).toBe(0)
    expect(undone).toBe(false)
  })

  it('returns everything (from depth 0) when savedDepth is null — the mark was discarded', () => {
    const entries: HistoryEntries = {
      undo: [entry('Draw'), entry('Extrude')],
      redo: [],
      savedDepth: null,
    }
    const { shown, more, undone } = entriesSinceSaved(entries)
    expect(shown).toEqual([entry('Draw'), entry('Extrude')])
    expect(more).toBe(0)
    expect(undone).toBe(false)
  })

  it('caps at the given limit, keeping the most recent entries, with a more count', () => {
    const undo = Array.from({ length: 15 }, (_, i) => entry(`Move ${i}`))
    const entries: HistoryEntries = { undo, redo: [], savedDepth: 0 }
    const { shown, more, undone } = entriesSinceSaved(entries, 12)
    expect(shown).toHaveLength(12)
    expect(shown[0]).toEqual(entry('Move 3'))
    expect(shown[11]).toEqual(entry('Move 14'))
    expect(more).toBe(3)
    expect(undone).toBe(false)
  })

  it('is empty at the saved mark', () => {
    const entries: HistoryEntries = { undo: [entry('Draw')], redo: [], savedDepth: 1 }
    const { shown, more, undone } = entriesSinceSaved(entries)
    expect(shown).toEqual([])
    expect(more).toBe(0)
    expect(undone).toBe(false)
  })

  // Backward case: the document was undone PAST the saved mark
  // (savedDepth > undo.length) without redoing back — this is a REAL,
  // reachable state (mark_saved_makes_the_current_depth_clean_and_undo_
  // past_it_dirties in kernel/tests/saved_mark_specs.rs), not a defensive
  // clamp. The saved state is still reachable, but only by REDOING —
  // those entries live in `redo`, closest-to-current first.
  describe('backward case — undone past the saved mark', () => {
    it('lists the redo entries needed to reach the saved state, marked undone', () => {
      const entries: HistoryEntries = {
        undo: [entry('Draw')],
        // redo is closest-to-current first (redo_entries_list_in_replay_order):
        // Extrude is adjacent to the current position, Move is farther.
        redo: [entry('Extrude'), entry('Move')],
        savedDepth: 3, // undo.length (1) + 2 redo entries = depth 3
      }
      const { shown, more, undone } = entriesSinceSaved(entries)
      expect(shown).toEqual([entry('Extrude'), entry('Move')])
      expect(more).toBe(0)
      expect(undone).toBe(true)
    })

    it('only takes as many redo entries as the gap to savedDepth requires', () => {
      const entries: HistoryEntries = {
        undo: [entry('Draw')],
        redo: [entry('Extrude'), entry('Move'), entry('Paint')],
        savedDepth: 2, // only 1 redo entry (Extrude) stands between here and clean
      }
      const { shown, undone } = entriesSinceSaved(entries)
      expect(shown).toEqual([entry('Extrude')])
      expect(undone).toBe(true)
    })

    it('caps the backward list too, dropping the entries FARTHEST from current', () => {
      const redo = Array.from({ length: 15 }, (_, i) => entry(`Move ${i}`))
      const entries: HistoryEntries = { undo: [], redo, savedDepth: 15 }
      const { shown, more, undone } = entriesSinceSaved(entries, 12)
      expect(shown).toHaveLength(12)
      expect(shown[0]).toEqual(entry('Move 0')) // closest to current, kept
      expect(shown[11]).toEqual(entry('Move 11'))
      expect(more).toBe(3) // Move 12/13/14 — farthest from current — dropped
      expect(undone).toBe(true)
    })

    it('is the single-step case: one undo past a save is one entry to redo', () => {
      // Exactly the kernel spec's own scenario: mark_saved at depth 2 (Draw,
      // Extrude), then undo once — the saved state is one redo away.
      const entries: HistoryEntries = {
        undo: [entry('Draw')],
        redo: [entry('Extrude')],
        savedDepth: 2,
      }
      const { shown, more, undone } = entriesSinceSaved(entries)
      expect(shown).toEqual([entry('Extrude')])
      expect(more).toBe(0)
      expect(undone).toBe(true)
    })
  })
})

describe('describeChangeCount', () => {
  it('reports no changes at zero', () => {
    expect(describeChangeCount(0, false)).toBe('No changes since last save.')
    expect(describeChangeCount(0, true)).toBe('No changes since last save.')
  })

  it('singularizes exactly one change, forward', () => {
    expect(describeChangeCount(1, false)).toBe('1 change since last save.')
  })

  it('pluralizes multiple changes, forward', () => {
    expect(describeChangeCount(3, false)).toBe('3 changes since last save.')
  })

  it('singularizes exactly one change, undone', () => {
    expect(describeChangeCount(1, true)).toBe('1 change undone since last save.')
  })

  it('pluralizes multiple changes, undone', () => {
    expect(describeChangeCount(2, true)).toBe('2 changes undone since last save.')
  })
})
