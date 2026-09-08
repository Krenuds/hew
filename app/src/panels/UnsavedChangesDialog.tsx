/**
 * UnsavedChangesDialog — the in-app "unsaved changes" prompt (Lane C, docs/
 * design/v1.1-cycle.md), replacing the native `ask`/`window.confirm` every
 * discard-triggering gesture (File ▸ Close, ▸ New, ▸ Open, ▸ Import, and the
 * Tauri window close guard) used to show.
 *
 * Unlike a bare yes/no confirm, this lists WHAT would be lost: the entries
 * between the current position and the saved mark (`entriesSinceSaved`,
 * capped at 12 with an "and N more" tail) plus any non-undoable-dirty
 * reasons (Scenes edited, Library metadata, …) the kernel's own undo stack
 * can't see. `entriesSinceSaved` covers BOTH directions dirty can come
 * from: the ordinary case (edits made since the save — undo them to reach
 * clean) and the "undone past the save" case (the document was undone
 * further than the save point, with no matching redo — the saved state is
 * still reachable, but only by REDOING; those entries are marked with a
 * "↺" and worded as "undone" rather than "changed"). Three choices: Save
 * (runs the caller's current save flow and only proceeds on success — a
 * failed or cancelled save leaves the dialog up), Don't Save (discard),
 * Cancel (back out, nothing happens). Styling follows the
 * RescaleConfirmDialog/StlUnitsDialog family.
 */

import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import type { Scene } from '../wasm/loader'
import { parseContentHistoryEntries, entriesSinceSaved, describeChangeCount } from './changesModel'

export type UnsavedChangesDecision = 'save' | 'dont-save' | 'cancel'

export interface UnsavedChangesDialogProps {
  scene: Scene | null
  /** Non-undoable-dirty reasons (`NON_UNDOABLE_REASON`/`importedReason` —
   *  documentSession.ts) — listed alongside the undo entries since neither
   *  the kernel's history nor `entriesSinceSaved` can see them. */
  reasons: ReadonlySet<string>
  /** Runs the caller's current save flow (`saveDocument`/`saveAsDocument`
   *  as appropriate) and resolves `true` iff the write actually landed. */
  onSave: () => Promise<boolean>
  onDontSave: () => void
  onCancel: () => void
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--backdrop-dim, rgba(0,0,0,0.6))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2000,
}

const DIALOG_STYLE: React.CSSProperties = {
  background: 'var(--surface-overlay, #2a2a2a)',
  border: '1px solid var(--border-strong, #4a4a4a)',
  borderRadius: 'var(--radius-control, 6px)',
  boxShadow: 'var(--shadow-palette, 0 8px 32px rgba(0,0,0,0.6))',
  padding: '20px 24px',
  minWidth: '360px',
  maxWidth: '480px',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  color: 'var(--text-secondary, #ddd)',
}

const HEADING_STYLE: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: 'var(--text-primary, #eee)',
  marginBottom: '12px',
}

const BODY_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-size-body, 13px)',
  color: 'var(--text-tertiary, #ccc)',
  marginBottom: '8px',
  lineHeight: '1.5',
}

const LIST_STYLE: React.CSSProperties = {
  margin: '0 0 16px',
  padding: '8px 12px',
  background: 'var(--surface-input, rgba(0,0,0,0.2))',
  borderRadius: 'var(--radius-control, 4px)',
  maxHeight: '220px',
  overflowY: 'auto',
  fontSize: 'var(--font-size-body, 13px)',
  lineHeight: '1.6',
  listStylePosition: 'inside',
}

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '10px',
}

const CANCEL_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, transparent)',
  borderRadius: 'var(--radius-control, 4px)',
  fontSize: 'var(--font-size-menu-item, 13px)',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  cursor: 'pointer',
}

const DONT_SAVE_BUTTON_STYLE: React.CSSProperties = {
  ...CANCEL_BUTTON_STYLE,
  color: 'var(--danger-text, #e88)',
}

const SAVE_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--accent-base, #3a5e9e)',
  color: 'var(--accent-text-strong, #fff)',
  border: 'none',
  borderRadius: 'var(--radius-control, 4px)',
  fontSize: 'var(--font-size-menu-item, 13px)',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  cursor: 'pointer',
}

export function UnsavedChangesDialog({ scene, reasons, onSave, onDontSave, onCancel }: UnsavedChangesDialogProps) {
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(() => {
    setSaving(true)
    void onSave().then((ok) => {
      // On success the caller's own awaited flow continues past this
      // dialog (App.tsx's discard-triggering action proceeds); on
      // failure/cancel (the file host's own dialog was itself cancelled,
      // or the write errored — already toasted by the save flow), leave
      // this dialog up so the user can retry Save or fall back to Don't
      // Save/Cancel instead of silently losing the prompt.
      setSaving(false)
    })
  }, [onSave])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    },
    [onCancel, saving],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Content entries only — bookkeeping (group/component edit-session
  // open/close markers) filtered out, same as ChangesPanel: they never
  // dirty the document, so they never belong in a list of what would be
  // lost (changesModel.ts's `HistoryEntry.bookkeeping` doc comment).
  const entries = parseContentHistoryEntries(scene?.history_entries_json())
  const { shown, more, undone } = entriesSinceSaved(entries, 12)
  // `shown.length + more` is the TRUE total (entriesSinceSaved's cap only
  // trims what's rendered, not what it counts) — no separate uncapped call
  // needed, unlike ChangesPanel's footer (which also needs the total when
  // the capped list is empty in a different way — see its own comment).
  const totalCount = shown.length + more
  const reasonList = Array.from(reasons)
  const hasList = shown.length > 0 || more > 0 || reasonList.length > 0
  const introText = totalCount > 0 ? describeChangeCount(totalCount, undone) : 'This document has unsaved changes.'

  return (
    <div style={OVERLAY_STYLE} onClick={saving ? undefined : onCancel}>
      <div
        style={DIALOG_STYLE}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Unsaved changes"
      >
        <div style={HEADING_STYLE}>Unsaved changes</div>
        <div style={BODY_STYLE}>{introText}</div>
        {hasList && (
          <ul style={LIST_STYLE}>
            {shown.map((entry, i) => (
              // A "↺" prefix marks an entry that must be REDONE (not
              // undone) to reach the saved state — the document was
              // undone PAST the save point (`undone`, entriesSinceSaved's
              // own doc comment). Struck through, like ChangesPanel's own
              // undone-entry treatment.
              <li key={`e${i}`} style={undone ? { textDecoration: 'line-through' } : undefined}>
                {undone ? `↺ ${entry.label}` : entry.label}
              </li>
            ))}
            {more > 0 && (
              <li style={{ fontStyle: 'italic', opacity: 0.8, textDecoration: undone ? 'line-through' : 'none' }}>
                and {more} more{undone ? ' (undone)' : ''}
              </li>
            )}
            {reasonList.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <div style={BUTTON_ROW_STYLE}>
          <button style={CANCEL_BUTTON_STYLE} onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button style={DONT_SAVE_BUTTON_STYLE} onClick={onDontSave} disabled={saving}>
            Don&rsquo;t Save
          </button>
          <button style={SAVE_BUTTON_STYLE} onClick={handleSave} disabled={saving} autoFocus>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
