/**
 * ChangesPanel — the Changes tray section (Lane C, docs/design/
 * v1.1-cycle.md): this session's undo/redo entries since the last save.
 *
 * Renders the FULL chronological timeline reconstructed from `Scene::
 * history_entries_json()`'s two stacks: `undo` (oldest-first, ending at the
 * current position) followed directly by `redo` (ALSO closest-to-current →
 * chronologically forward from there — `Document::history_entries`'s wire
 * order already lists `redo` that way, see `redo_entries_list_in_replay_
 * order` in crates/kernel/tests/saved_mark_specs.rs; no reversal needed) —
 * one continuous list, the undone tail rendered dimmed rather than as a
 * separate section. A "Saved" marker line sits at the saved depth; when the
 * document was undone PAST that depth (the marker lands in the dimmed
 * redo tail — the "backward" case `entriesSinceSaved` also handles), the
 * marker still shows correctly, it's just further down than the current
 * position. Rows are capped at `MAX_ROWS`, oldest collapsed into a single
 * "and N more" line at the top, so an old document with thousands of
 * entries never renders an unbounded DOM. Origin-tagged (API-authored)
 * entries carry a small connection badge. Non-undoable-dirty reasons
 * (Scenes edited, Library metadata, …) list below the timeline in the same
 * wording as the unsaved-changes dialog. Clicking an entry does nothing at
 * 1.1 — no jump-to-that-point-in-history.
 */

import type React from 'react'
import { parseContentHistoryEntries, originConnection, entriesSinceSaved, describeChangeCount, type HistoryEntry } from './changesModel'
import type { Scene } from '../wasm/loader'

export interface ChangesPanelProps {
  scene: Scene | null
  /** Bumped on every document mutation/undo/redo — the panel's re-render
   *  trigger, matching every other tray section's `docRev` prop. */
  docRev: number
  /** Non-undoable-dirty reasons (`NON_UNDOABLE_REASON`/`importedReason` —
   *  documentSession.ts) — rendered below the timeline, same wording as
   *  the unsaved-changes dialog. */
  reasons: ReadonlySet<string>
}

/** Most rows the timeline renders before folding the oldest into a
 * collapsed "and N more" line — an old, long-lived document's session
 * history must never render an unbounded DOM. */
const MAX_ROWS = 200

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '3px 0',
  fontSize: '12px',
  lineHeight: 1.3,
}

const SAVED_MARKER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  margin: '2px 0',
  fontSize: '10px',
  color: 'var(--text-tertiary)',
}

const SAVED_MARKER_LINE_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
  height: '1px',
  background: 'var(--border-hairline)',
}

function SavedMarker() {
  return (
    <div style={SAVED_MARKER_STYLE}>
      <span style={SAVED_MARKER_LINE_STYLE} />
      <span>Saved</span>
      <span style={SAVED_MARKER_LINE_STYLE} />
    </div>
  )
}

function OriginBadge({ connection }: { connection: string }) {
  return (
    <span
      title={`API connection: ${connection}`}
      style={{
        flexShrink: 0,
        fontSize: '9px',
        fontFamily: 'var(--font-family-mono)',
        padding: '1px 4px',
        borderRadius: '3px',
        background: 'var(--badge-bg, rgba(127,127,127,0.18))',
        color: 'var(--text-tertiary)',
        letterSpacing: '0.02em',
      }}
    >
      API
    </span>
  )
}

function EntryRow({ entry, dimmed }: { entry: HistoryEntry; dimmed: boolean }) {
  const connection = originConnection(entry.origin)
  return (
    <div style={{ ...ROW_STYLE, color: dimmed ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          // A dimmed row is one that's been undone (it lives in the redo
          // tail) — struck through in addition to dimmed, matching the
          // dialog's own undone-entry treatment.
          textDecoration: dimmed ? 'line-through' : 'none',
        }}
      >
        {entry.label}
      </span>
      {connection !== null && <OriginBadge connection={connection} />}
    </div>
  )
}

export function ChangesPanel({ scene, docRev: _docRev, reasons }: ChangesPanelProps) {
  // Content entries only (bookkeeping — group/component edit-session
  // open/close markers — filtered out): they never dirty the document, so
  // they're not "changes" this panel should list (changesModel.ts's
  // `HistoryEntry.bookkeeping` doc comment).
  const entries = parseContentHistoryEntries(scene?.history_entries_json())
  const timeline = [...entries.undo, ...entries.redo]
  const savedAt = entries.savedDepth

  // Cap: keep the MOST RECENT MAX_ROWS entries (closest to the current
  // position), collapsing the oldest into one line at the top.
  const dropped = Math.max(0, timeline.length - MAX_ROWS)
  const visible = timeline.slice(dropped)
  // Remap the Saved marker's index into the visible slice. When it falls
  // strictly within the collapsed prefix, it renders at the very top of
  // the visible rows instead (clamped to 0) — the "and N more" line notes
  // that the save point is back there, so the boundary is never silently
  // dropped, just imprecisely placed.
  const savedAtVisible = savedAt === null ? null : Math.max(0, savedAt - dropped)
  const savedMarkerHidden = savedAt !== null && savedAt < dropped

  // Footer count: entriesSinceSaved handles BOTH directions dirty can come
  // from — forward (edits made since the save) and backward (undone PAST
  // the save, so redoing is what gets back to clean) — uncapped (Infinity)
  // since this is a total count, not a rendered list.
  const { shown: sinceSaved, undone } = entriesSinceSaved(entries, Infinity)
  const footerText = describeChangeCount(sinceSaved.length, undone)

  const reasonList = Array.from(reasons)

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {timeline.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '4px 0' }}>
          No changes yet this session.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {dropped > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontStyle: 'italic', padding: '2px 0' }}>
              and {dropped} more{savedMarkerHidden ? ' (including the last save)' : ''}
            </div>
          )}
          {visible.map((entry, i) => (
            <div key={dropped + i}>
              {savedAtVisible !== null && i === savedAtVisible && <SavedMarker />}
              <EntryRow entry={entry} dimmed={dropped + i >= entries.undo.length} />
            </div>
          ))}
          {savedAtVisible !== null && savedAtVisible === visible.length && <SavedMarker />}
        </div>
      )}
      {reasonList.length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {reasonList.map((reason) => (
            <div key={reason}>{reason}</div>
          ))}
        </div>
      )}
      <div
        style={{
          marginTop: '8px',
          paddingTop: '8px',
          borderTop: '1px solid var(--border-hairline)',
          fontSize: '11px',
          color: 'var(--text-tertiary)',
        }}
      >
        {footerText}
      </div>
    </div>
  )
}
