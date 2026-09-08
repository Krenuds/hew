/**
 * changesModel — pure helpers over `Scene::history_entries_json` /
 * `hew.history.status.entries`'s wire shape (crates/wasm-api/src/lib.rs,
 * crates/api/src/commands/history.rs — Lane C, docs/design/v1.1-cycle.md).
 *
 * Shared by the Changes tray section (`ChangesPanel.tsx`) and the
 * unsaved-changes dialog (`UnsavedChangesDialog.tsx`), so both read the
 * same entry list the same way. Intentionally UI-free (no React, no wasm
 * import) so it can be unit-tested in isolation — the wasm boundary is
 * crossed once, in App.tsx, via `scene.history_entries_json()`.
 */

/** One undo/redo entry: a human-readable label the kernel derives from the
 * action itself, and who authored it. */
export interface HistoryEntry {
  label: string
  /** `'user'` for a UI-authored edit; `{ connection: id }` for an API
   * envelope, `id` being the connection's own identity string. */
  origin: 'user' | { connection: string }
  /** True for a session open/close marker — "Edit group", "Finish editing
   * group", "Edit component 'X'", "Finish editing component 'X'"
   * (`DocAction::is_bookkeeping`, crates/kernel/src/document.rs). These are
   * real, undoable steps — undoing one really does leave the edit session
   * — but they change nothing a save would write, so the kernel never
   * counts them as a "change": they don't dirty the document and
   * `savedDepth` is computed as if they weren't on the stack at all
   * (`Document::content_depth`). Any "what changed since the last save"
   * surface must filter them out with `filterContentEntries` (or
   * `parseContentHistoryEntries`) rather than reading `undo`/`redo`
   * directly — the Undo/Redo MENU labels are the one exception (App.tsx's
   * `undoRedoMenuLabels` reads the raw, unfiltered shape from
   * `parseHistoryEntries`, deliberately: undoing "Edit group" really does
   * leave the edit, so the menu should say so). */
  bookkeeping: boolean
}

/** Both stacks plus the saved mark — `Scene::history_entries_json`'s
 * exact shape. `undo` is oldest-first; `redo` is in replay order (index 0
 * is what the next redo would apply). `savedDepth` is the CONTENT depth at
 * which the document is clean (`Document::content_depth` — bookkeeping
 * entries filtered out, so it is NOT a plain index into the raw `undo`
 * array above), or `null` once that state was discarded by a new action
 * overwriting the redo branch that held it (`Document::commit_new_action`).
 * Code comparing `savedDepth` against `undo.length` (`entriesSinceSaved`)
 * must first run this through `filterContentEntries`/
 * `parseContentHistoryEntries` so both sides count the same way. */
export interface HistoryEntries {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
  savedDepth: number | null
}

const EMPTY_ENTRIES: HistoryEntries = { undo: [], redo: [], savedDepth: null }

/** Parses `scene.history_entries_json()`. Tolerant of a missing/malformed
 * payload (a scene that isn't ready yet, or defensive-only — the kernel
 * always returns well-formed JSON) by falling back to an empty history
 * rather than throwing into a render. */
export function parseHistoryEntries(json: string | undefined | null): HistoryEntries {
  if (json === undefined || json === null) return EMPTY_ENTRIES
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_ENTRIES
    const obj = parsed as Record<string, unknown>
    return {
      undo: Array.isArray(obj.undo) ? (obj.undo as HistoryEntry[]) : [],
      redo: Array.isArray(obj.redo) ? (obj.redo as HistoryEntry[]) : [],
      savedDepth: typeof obj.savedDepth === 'number' ? obj.savedDepth : null,
    }
  } catch {
    return EMPTY_ENTRIES
  }
}

/** Drops bookkeeping entries (`HistoryEntry.bookkeeping`) from both stacks.
 * `savedDepth` is left untouched: the kernel already computes it as a
 * CONTENT depth — an index that treats the undo stack as if bookkeeping
 * entries were never pushed (`Document::content_depth`) — so once `undo`/
 * `redo` are filtered down to the same content-only entries, `savedDepth`
 * lines up against them exactly the way `entriesSinceSaved` already
 * assumes. Every "what changed since the last save" surface
 * (ChangesPanel, UnsavedChangesDialog) must read this filtered shape, not
 * raw `parseHistoryEntries` output — see `HistoryEntry.bookkeeping`'s doc
 * comment for the one exception (the Undo/Redo menu labels). */
export function filterContentEntries(entries: HistoryEntries): HistoryEntries {
  const undo = entries.undo.filter((e) => !e.bookkeeping)
  const redo = entries.redo.filter((e) => !e.bookkeeping)
  if (undo.length === entries.undo.length && redo.length === entries.redo.length) return entries
  return { undo, redo, savedDepth: entries.savedDepth }
}

/** `filterContentEntries(parseHistoryEntries(json))` — the one call every
 * "what changed" surface (ChangesPanel, UnsavedChangesDialog) should make;
 * `parseHistoryEntries` itself stays raw for the one consumer that wants
 * bookkeeping entries too (the Undo/Redo menu labels, App.tsx). */
export function parseContentHistoryEntries(json: string | undefined | null): HistoryEntries {
  return filterContentEntries(parseHistoryEntries(json))
}

/** The connection id for an API-authored entry, `null` for a user edit —
 * the Changes panel's origin badge and the dialog's entry list share this. */
export function originConnection(origin: HistoryEntry['origin']): string | null {
  return origin === 'user' ? null : origin.connection
}

/** `entriesSinceSaved`'s result: the entries relevant to reaching the saved
 * state, closest-to-the-current-position first, capped with a `more`
 * count — plus which DIRECTION they'd need to move. */
export interface EntriesSinceSaved {
  /** The relevant entries. Ordered closest-to-current-position first in
   * both directions (so a cap always drops the entries FARTHEST from
   * where the user is right now): forward case, that's the most recently
   * made changes; backward case, that's the changes closest to being
   * redone. */
  shown: HistoryEntry[]
  /** How many further relevant entries the cap dropped. */
  more: number
  /** `false` (forward): these are `undo` entries made SINCE the save —
   * undo them to reach clean. `true` (backward): the document was undone
   * PAST the saved mark (kernel: `savedDepth > undo.length`) — these are
   * `redo` entries that must be REDONE to reach the saved state. Both
   * report a dirty document; only the direction back to clean differs. */
  undone: boolean
}

/** The entries between the document's current position and its saved
 * mark, closest-to-current first, capped at `limit` with a count of how
 * many more were dropped — the unsaved-changes dialog's "cap 12 + and N
 * more" list, and the Changes panel's footer count.
 *
 * Two directions, both meaning "dirty":
 * - Forward (the ordinary case, `undone: false`): edits were made since
 *   the save (`savedDepth <= undo.length`, or `savedDepth` is `null` —
 *   the saved state was discarded by a new action overwriting the redo
 *   branch that held it, so EVERY undo entry counts as "since the save",
 *   matching `at_saved_mark`'s own "there is no path back to clean"
 *   reading). The relevant entries are the tail of `undo`.
 * - Backward (`undone: true`): the document was undone PAST the saved
 *   mark (`savedDepth > undo.length`) without a matching redo — the
 *   saved state is still reachable, but only by REDOING back up to it.
 *   The relevant entries are the head of `redo` (`Document::
 *   history_entries`'s wire order already lists `redo` closest-to-current
 *   first — see `crates/kernel/tests/saved_mark_specs.rs`'s
 *   `redo_entries_list_in_replay_order`), so no reversal is needed.
 */
export function entriesSinceSaved(entries: HistoryEntries, limit = 12): EntriesSinceSaved {
  const { undo, redo, savedDepth } = entries
  if (savedDepth !== null && savedDepth > undo.length) {
    const count = savedDepth - undo.length
    const relevant = redo.slice(0, count)
    if (relevant.length <= limit) return { shown: relevant, more: 0, undone: true }
    return { shown: relevant.slice(0, limit), more: relevant.length - limit, undone: true }
  }
  const from = savedDepth === null ? 0 : Math.min(savedDepth, undo.length)
  const since = undo.slice(from)
  if (since.length <= limit) return { shown: since, more: 0, undone: false }
  return { shown: since.slice(since.length - limit), more: since.length - limit, undone: false }
}

/** "2 changes since last save." / "2 changes undone since last save." /
 * "No changes since last save." — the Changes panel footer's exact
 * wording; the unsaved-changes dialog's intro line is phrased around the
 * same `undone` distinction so the two surfaces never disagree. */
export function describeChangeCount(count: number, undone: boolean): string {
  if (count === 0) return 'No changes since last save.'
  const noun = count === 1 ? 'change' : 'changes'
  return undone ? `${count} ${noun} undone since last save.` : `${count} ${noun} since last save.`
}
