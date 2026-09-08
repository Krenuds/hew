/**
 * ChangesPanel — the Changes tray section (Lane C, docs/design/
 * v1.1-cycle.md). Covers the reconstructed chronological timeline (undo
 * oldest-first, the redo tail — already chronologically forward in the
 * wire shape, no reversal — appended and dimmed), the Saved marker (both
 * the ordinary and the "undone past the save" backward case), the row cap,
 * the origin badge, non-undoable reasons, and the footer count.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChangesPanel } from './ChangesPanel'
import type { Scene } from '../wasm/loader'

function fakeScene(json: unknown): Scene {
  return { history_entries_json: () => JSON.stringify(json) } as unknown as Scene
}

const NO_REASONS = new Set<string>()
const entry = (label: string, origin: 'user' | { connection: string } = 'user', bookkeeping = false) => ({
  label,
  origin,
  bookkeeping,
})

describe('ChangesPanel', () => {
  it('shows a placeholder when there is no history yet', () => {
    render(<ChangesPanel scene={fakeScene({ undo: [], redo: [], savedDepth: 0 })} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText(/no changes yet this session/i)).toBeInTheDocument()
  })

  it('renders undo entries oldest first', () => {
    const scene = fakeScene({
      undo: [entry('Draw'), entry('Push/Pull')],
      redo: [],
      savedDepth: 2,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    const draw = screen.getByText('Draw')
    const pushPull = screen.getByText('Push/Pull')
    // Draw precedes Push/Pull in document order (oldest first).
    expect(draw.compareDocumentPosition(pushPull) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('appends the undone tail from redo (already chronological — no reversal) and dims it', () => {
    // undo: [Draw, Extrude] (current position). Two undos happened from a
    // 4-action sequence (Draw, Extrude, Move1, Move2) — the FIRST undo
    // popped Move2 (newest), the SECOND popped Move1. So Move1 was undone
    // MOST recently — it's the next redo, i.e. `redo[0]` — and
    // `Document::history_entries`'s wire order (redo_entries_list_in_
    // replay_order, kernel/tests/saved_mark_specs.rs) already lists it
    // that way: closest-to-current first, which for a run of consecutive
    // undos also happens to be chronological order (Move1 before Move2).
    const scene = fakeScene({
      undo: [entry('Draw'), entry('Extrude')],
      redo: [entry('Move1'), entry('Move2')],
      savedDepth: 4,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    const move1 = screen.getByText('Move1')
    const move2 = screen.getByText('Move2')
    // Chronological order in the DOM: Move1 before Move2.
    expect(move1.compareDocumentPosition(move2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The undone tail (both Move1 and Move2) renders dimmed (tertiary
    // text, on the row) AND struck through (on the label span itself),
    // not the primary-text color/plain decoration the still-live undo
    // entries get.
    expect(move1.parentElement).toHaveStyle({ color: 'var(--text-tertiary)' })
    expect(move1).toHaveStyle({ textDecoration: 'line-through' })
    expect(move2.parentElement).toHaveStyle({ color: 'var(--text-tertiary)' })
    expect(move2).toHaveStyle({ textDecoration: 'line-through' })
    const draw = screen.getByText('Draw')
    expect(draw.parentElement).toHaveStyle({ color: 'var(--text-primary)' })
    expect(draw).toHaveStyle({ textDecoration: 'none' })
  })

  it('shows a Saved marker at the saved depth', () => {
    const scene = fakeScene({
      undo: [entry('Draw')],
      redo: [],
      savedDepth: 1,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('shows no Saved marker when the saved mark was discarded (savedDepth: null)', () => {
    const scene = fakeScene({
      undo: [entry('Draw')],
      redo: [],
      savedDepth: null,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  // The backward case (adversarial review finding): undone PAST the saved
  // mark without redoing back. The marker still renders — inside the
  // dimmed (redo) portion of the timeline, since that's genuinely where
  // the saved state now sits: entries needed to REACH it come before the
  // marker (still dimmed — they haven't been redone yet), and anything
  // redone PAST it would leave the document dirty again in the ordinary
  // (forward) direction — exactly kernel's `mark_saved_makes_the_current_
  // depth_clean_and_undo_past_it_dirties` scenario.
  it('shows the Saved marker inside the dimmed redo tail when undone past the save', () => {
    const scene = fakeScene({
      undo: [entry('Draw')],
      // Extrude is the one redo needed to reach the save; Paint is a
      // further redo BEYOND the saved state.
      redo: [entry('Extrude'), entry('Paint')],
      savedDepth: 2, // undo.length (1) + 1 needed redo (Extrude) = 2
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    const marker = screen.getByText('Saved')
    const extrude = screen.getByText('Extrude')
    const paint = screen.getByText('Paint')
    expect(extrude.parentElement).toHaveStyle({ color: 'var(--text-tertiary)' })
    expect(paint.parentElement).toHaveStyle({ color: 'var(--text-tertiary)' })
    // Extrude (needed to reach the save) comes before the marker; Paint
    // (beyond the saved state) comes after it.
    expect(extrude.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(marker.compareDocumentPosition(paint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows an API connection badge for a non-user entry', () => {
    const scene = fakeScene({
      undo: [entry('Draw rectangle', { connection: 'mcp:hew' })],
      redo: [],
      savedDepth: 1,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText('API')).toBeInTheDocument()
  })

  it('reports the footer count of changes since the last save', () => {
    const scene = fakeScene({
      undo: [entry('Draw'), entry('Extrude'), entry('Move')],
      redo: [],
      savedDepth: 1,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText('2 changes since last save.')).toBeInTheDocument()
  })

  it('singularizes the footer for exactly one change', () => {
    const scene = fakeScene({
      undo: [entry('Draw')],
      redo: [],
      savedDepth: 0,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText('1 change since last save.')).toBeInTheDocument()
  })

  it('reports no changes since the last save when at the saved mark', () => {
    const scene = fakeScene({
      undo: [entry('Draw')],
      redo: [],
      savedDepth: 1,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText('No changes since last save.')).toBeInTheDocument()
  })

  // Backward-case footer wording (adversarial review finding): undone
  // past the save must NOT report "no changes" — it's dirty, in the
  // other direction.
  it('reports the footer as "undone" when undone past the saved mark', () => {
    const scene = fakeScene({
      undo: [entry('Draw')],
      redo: [entry('Extrude'), entry('Move')],
      savedDepth: 3,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText('2 changes undone since last save.')).toBeInTheDocument()
  })

  it('singularizes the "undone" footer for exactly one entry', () => {
    const scene = fakeScene({
      undo: [entry('Draw')],
      redo: [entry('Extrude')],
      savedDepth: 2,
    })
    render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText('1 change undone since last save.')).toBeInTheDocument()
  })

  it('handles a null scene without crashing', () => {
    render(<ChangesPanel scene={null} docRev={0} reasons={NO_REASONS} />)
    expect(screen.getByText(/no changes yet this session/i)).toBeInTheDocument()
  })

  // Row cap (adversarial review finding): an unbounded timeline must not
  // render an unbounded DOM.
  describe('row cap', () => {
    it('renders every row when under the cap, with no "and N more" line', () => {
      const undo = Array.from({ length: 50 }, (_, i) => entry(`Move ${i}`))
      const scene = fakeScene({ undo, redo: [], savedDepth: 50 })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      expect(screen.getByText('Move 0')).toBeInTheDocument()
      expect(screen.getByText('Move 49')).toBeInTheDocument()
      expect(screen.queryByText(/and \d+ more/)).not.toBeInTheDocument()
    })

    it('collapses everything past 200 rows into a single "and N more" line, keeping the most recent', () => {
      const undo = Array.from({ length: 250 }, (_, i) => entry(`Move ${i}`))
      const scene = fakeScene({ undo, redo: [], savedDepth: 250 })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      expect(screen.getByText('and 50 more')).toBeInTheDocument()
      // The 200 most recent (closest to current) are kept…
      expect(screen.getByText('Move 249')).toBeInTheDocument()
      expect(screen.getByText('Move 50')).toBeInTheDocument()
      // …the 50 oldest are folded away.
      expect(screen.queryByText('Move 49')).not.toBeInTheDocument()
      expect(screen.queryByText('Move 0')).not.toBeInTheDocument()
    })

    it('keeps the Saved marker correctly placed among the visible rows under the cap', () => {
      const undo = Array.from({ length: 250 }, (_, i) => entry(`Move ${i}`))
      // Saved at depth 210 — well within the visible (most-recent-200) window.
      const scene = fakeScene({ undo, redo: [], savedDepth: 210 })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      const marker = screen.getByText('Saved')
      const move209 = screen.getByText('Move 209') // last entry before the mark
      const move210 = screen.getByText('Move 210') // first entry after the mark
      expect(move209.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(marker.compareDocumentPosition(move210) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('notes when the saved mark is hidden inside the collapsed prefix', () => {
      const undo = Array.from({ length: 250 }, (_, i) => entry(`Move ${i}`))
      // Saved at depth 10 — inside the collapsed (oldest-50) prefix.
      const scene = fakeScene({ undo, redo: [], savedDepth: 10 })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      expect(screen.getByText('and 50 more (including the last save)')).toBeInTheDocument()
    })
  })

  // Session bookkeeping (Lane C follow-up, maintainer playtest): entering/
  // leaving a group or component edit session is a real, undoable history
  // entry, but never a "change" — it must not appear in the timeline or
  // count toward the footer (changesModel.ts's `HistoryEntry.bookkeeping`).
  describe('bookkeeping entries', () => {
    it('never renders a bookkeeping entry, even though it is a real undo/redo entry', () => {
      const scene = fakeScene({
        undo: [entry('Draw'), entry('Edit group', 'user', true)],
        redo: [],
        savedDepth: 1, // content depth: only "Draw" counts
      })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      expect(screen.getByText('Draw')).toBeInTheDocument()
      expect(screen.queryByText('Edit group')).not.toBeInTheDocument()
    })

    it('reports "No changes since last save" when the only new entry since the save is bookkeeping', () => {
      const scene = fakeScene({
        undo: [entry('Draw'), entry('Edit group', 'user', true)],
        redo: [],
        savedDepth: 1, // content depth: "Draw" is the saved state; the group-edit entry doesn't count
      })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      expect(screen.getByText('No changes since last save.')).toBeInTheDocument()
    })

    it('treats a session with ONLY a bookkeeping entry as having no changes yet', () => {
      const scene = fakeScene({
        undo: [entry('Edit group', 'user', true)],
        redo: [],
        savedDepth: 0,
      })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      expect(screen.getByText(/no changes yet this session/i)).toBeInTheDocument()
    })
  })

  // Non-undoable-dirty reasons (adversarial review finding, matches
  // files-and-saving.md's claim that the panel names them).
  describe('non-undoable reasons', () => {
    it('renders reasons even when the kernel history is empty', () => {
      const scene = fakeScene({ undo: [], redo: [], savedDepth: 0 })
      render(<ChangesPanel scene={scene} docRev={0} reasons={new Set(['Scenes edited'])} />)
      expect(screen.getByText(/no changes yet this session/i)).toBeInTheDocument()
      expect(screen.getByText('Scenes edited')).toBeInTheDocument()
    })

    it('renders reasons alongside a real timeline, with the same wording as the dialog', () => {
      const scene = fakeScene({ undo: [entry('Draw')], redo: [], savedDepth: 1 })
      render(
        <ChangesPanel
          scene={scene}
          docRev={0}
          reasons={new Set(['Scenes edited', 'Materials added from the Library'])}
        />,
      )
      expect(screen.getByText('Scenes edited')).toBeInTheDocument()
      expect(screen.getByText('Materials added from the Library')).toBeInTheDocument()
    })

    it('renders nothing extra when there are no reasons', () => {
      const scene = fakeScene({ undo: [entry('Draw')], redo: [], savedDepth: 1 })
      render(<ChangesPanel scene={scene} docRev={0} reasons={NO_REASONS} />)
      expect(screen.queryByText('Scenes edited')).not.toBeInTheDocument()
    })
  })
})
