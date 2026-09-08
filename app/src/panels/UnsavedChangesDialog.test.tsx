/**
 * UnsavedChangesDialog — the in-app unsaved-changes prompt (Lane C, docs/
 * design/v1.1-cycle.md). Covers the entry list (capped at 12 + "and N
 * more"), the non-undoable-dirty reason lines, and the three-button
 * Save/Don't Save/Cancel flow — Save awaits its promise and only closes
 * (in App.tsx; here, only re-enables) on failure.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'
import type { Scene } from '../wasm/loader'

function fakeScene(json: unknown): Scene {
  return { history_entries_json: () => JSON.stringify(json) } as unknown as Scene
}

const EMPTY_HISTORY = { undo: [], redo: [], savedDepth: 0 }

describe('UnsavedChangesDialog', () => {
  it('has the expected ARIA dialog role and label', () => {
    render(
      <UnsavedChangesDialog
        scene={fakeScene(EMPTY_HISTORY)}
        reasons={new Set()}
        onSave={vi.fn()}
        onDontSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog', { name: /unsaved changes/i })).toBeInTheDocument()
  })

  it('lists the undo entries since the saved mark, oldest first', () => {
    const scene = fakeScene({
      undo: [{ label: 'Draw', origin: 'user' }, { label: 'Push/Pull', origin: 'user' }],
      redo: [],
      savedDepth: 0,
    })
    render(<UnsavedChangesDialog scene={scene} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />)
    const list = screen.getByRole('list')
    expect(list.textContent?.indexOf('Draw')).toBeLessThan(list.textContent?.indexOf('Push/Pull') ?? -1)
    expect(screen.getByText('2 changes since last save.')).toBeInTheDocument()
  })

  // Backward case (adversarial review finding): the document was undone
  // PAST the saved mark, with no matching redo — the saved state is only
  // reachable by REDOING. This is a real, reachable dirty state (kernel's
  // `mark_saved_makes_the_current_depth_clean_and_undo_past_it_dirties`),
  // not a defensive edge case, and it must not silently report "no
  // changes."
  describe('backward case — undone past the saved mark', () => {
    it('words the intro as "undone" and marks each listed entry with ↺', () => {
      const scene = fakeScene({
        undo: [{ label: 'Draw', origin: 'user' }],
        redo: [{ label: 'Extrude', origin: 'user' }, { label: 'Move', origin: 'user' }],
        savedDepth: 3,
      })
      render(<UnsavedChangesDialog scene={scene} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />)
      expect(screen.getByText('2 changes undone since last save.')).toBeInTheDocument()
      expect(screen.getByText('↺ Extrude')).toBeInTheDocument()
      expect(screen.getByText('↺ Move')).toBeInTheDocument()
      // Undone entries are struck through, matching ChangesPanel's own
      // dimmed-and-struck-through treatment of the same entries.
      expect(screen.getByText('↺ Extrude')).toHaveStyle({ textDecoration: 'line-through' })
      expect(screen.getByText('↺ Move')).toHaveStyle({ textDecoration: 'line-through' })
    })

    it('does not strike through the ordinary (forward) case — those entries are still live, just done', () => {
      const scene = fakeScene({
        undo: [{ label: 'Draw', origin: 'user' }, { label: 'Push/Pull', origin: 'user' }],
        redo: [],
        savedDepth: 0,
      })
      render(<UnsavedChangesDialog scene={scene} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />)
      const li = screen.getByText('Push/Pull')
      expect(li.style.textDecoration).not.toBe('line-through')
    })

    it('singularizes the intro for exactly one undone entry', () => {
      const scene = fakeScene({
        undo: [{ label: 'Draw', origin: 'user' }],
        redo: [{ label: 'Extrude', origin: 'user' }],
        savedDepth: 2,
      })
      render(<UnsavedChangesDialog scene={scene} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />)
      expect(screen.getByText('1 change undone since last save.')).toBeInTheDocument()
      expect(screen.getByText('↺ Extrude')).toBeInTheDocument()
    })

    it('caps the undone list too, with an "(undone)" suffix on the more line', () => {
      const redo = Array.from({ length: 15 }, (_, i) => ({ label: `Move ${i}`, origin: 'user' as const }))
      const scene = fakeScene({ undo: [], redo, savedDepth: 15 })
      render(<UnsavedChangesDialog scene={scene} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />)
      expect(screen.getByText('and 3 more (undone)')).toBeInTheDocument()
      expect(screen.getByText('↺ Move 0')).toBeInTheDocument() // closest to current, kept
      expect(screen.queryByText(/Move 14/)).not.toBeInTheDocument() // farthest, dropped
    })

    it('lists non-undoable reasons alongside the undone entries', () => {
      const scene = fakeScene({
        undo: [{ label: 'Draw', origin: 'user' }],
        redo: [{ label: 'Extrude', origin: 'user' }],
        savedDepth: 2,
      })
      render(
        <UnsavedChangesDialog
          scene={scene}
          reasons={new Set(['Scenes edited'])}
          onSave={vi.fn()}
          onDontSave={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
      expect(screen.getByText('↺ Extrude')).toBeInTheDocument()
      expect(screen.getByText('Scenes edited')).toBeInTheDocument()
    })
  })

  it('caps the list at 12 with an "and N more" line', () => {
    const undo = Array.from({ length: 15 }, (_, i) => ({ label: `Move ${i}`, origin: 'user' as const }))
    const scene = fakeScene({ undo, redo: [], savedDepth: 0 })
    render(<UnsavedChangesDialog scene={scene} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('and 3 more')).toBeInTheDocument()
    // The 12 most RECENT entries are shown — the earliest 3 are the ones
    // folded into "and N more" (entriesSinceSaved's own contract).
    expect(screen.queryByText('Move 0')).not.toBeInTheDocument()
    expect(screen.getByText('Move 14')).toBeInTheDocument()
  })

  // Session bookkeeping (Lane C follow-up, maintainer playtest): entering/
  // leaving a group or component edit session is a real, undoable entry,
  // but it never dirties the document and must never appear in the "what
  // would be lost" list (changesModel.ts's `HistoryEntry.bookkeeping`).
  it('never lists a bookkeeping entry, even though it is a real undo entry', () => {
    const scene = fakeScene({
      undo: [
        { label: 'Draw', origin: 'user' },
        { label: 'Push/Pull', origin: 'user' },
        // Entered a group edit AFTER the save (doesn't count as content)…
        { label: 'Edit group', origin: 'user', bookkeeping: true },
        // …then made a real edit inside the session.
        { label: 'Move', origin: 'user' },
      ],
      redo: [],
      savedDepth: 2, // content depth at save time: Draw + Push/Pull
    })
    render(<UnsavedChangesDialog scene={scene} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('1 change since last save.')).toBeInTheDocument()
    expect(screen.getByText('Move')).toBeInTheDocument()
    expect(screen.queryByText('Edit group')).not.toBeInTheDocument()
  })

  it('lists non-undoable-dirty reasons alongside the undo entries', () => {
    render(
      <UnsavedChangesDialog
        scene={fakeScene(EMPTY_HISTORY)}
        reasons={new Set(['Scenes edited', 'Library metadata'])}
        onSave={vi.fn()}
        onDontSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('Scenes edited')).toBeInTheDocument()
    expect(screen.getByText('Library metadata')).toBeInTheDocument()
  })

  it('shows no list when there is nothing to report (defensive — dirty should imply something to show)', () => {
    render(
      <UnsavedChangesDialog scene={fakeScene(EMPTY_HISTORY)} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('calls onDontSave when Don\'t Save is clicked', () => {
    const onDontSave = vi.fn()
    render(
      <UnsavedChangesDialog scene={fakeScene(EMPTY_HISTORY)} reasons={new Set()} onSave={vi.fn()} onDontSave={onDontSave} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /don.t save/i }))
    expect(onDontSave).toHaveBeenCalledOnce()
  })

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn()
    render(
      <UnsavedChangesDialog scene={fakeScene(EMPTY_HISTORY)} reasons={new Set()} onSave={vi.fn()} onDontSave={vi.fn()} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('calls onCancel — never onDontSave — when Escape is pressed', () => {
    const onCancel = vi.fn()
    const onDontSave = vi.fn()
    render(
      <UnsavedChangesDialog scene={fakeScene(EMPTY_HISTORY)} reasons={new Set()} onSave={vi.fn()} onDontSave={onDontSave} onCancel={onCancel} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onDontSave).not.toHaveBeenCalled()
  })

  it('calls onSave when Save is clicked, showing a Saving… state while pending', async () => {
    let resolveSave: (ok: boolean) => void = () => {}
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = resolve }))
    render(
      <UnsavedChangesDialog scene={fakeScene(EMPTY_HISTORY)} reasons={new Set()} onSave={onSave} onDontSave={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(await screen.findByRole('button', { name: /saving/i })).toBeInTheDocument()
    resolveSave(true)
    // The dialog itself doesn't unmount on success (that's the caller's
    // job, via the resolved discard-decision promise) — but this confirms
    // the pending promise was awaited without throwing.
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  })

  it('re-enables the buttons after a failed/cancelled save', async () => {
    const onSave = vi.fn(() => Promise.resolve(false))
    render(
      <UnsavedChangesDialog scene={fakeScene(EMPTY_HISTORY)} reasons={new Set()} onSave={onSave} onDontSave={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled())
    expect(screen.getByRole('button', { name: /^cancel$/i })).not.toBeDisabled()
  })

  it('disables Cancel/Don\'t Save while a save is in flight', () => {
    const onSave = vi.fn(() => new Promise<boolean>(() => {})) // never resolves
    render(
      <UnsavedChangesDialog scene={fakeScene(EMPTY_HISTORY)} reasons={new Set()} onSave={onSave} onDontSave={vi.fn()} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /don.t save/i })).toBeDisabled()
  })
})
