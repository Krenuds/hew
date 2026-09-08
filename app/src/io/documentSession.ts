/**
 * documentSession — pure document-lifecycle state helpers.
 *
 * This module holds the logic for tracking document state (currentRef, dirty)
 * and deriving the window title.  It is intentionally UI-free so it can be
 * unit-tested without a DOM or React.
 *
 * React-level integration is in App.tsx (useDocumentSession hook).
 *
 * `dirty` is DERIVED (Lane C, docs/design/v1.1-cycle.md): the kernel tracks
 * its own "saved mark" on the undo stack (`Document::at_saved_mark` /
 * `Scene::at_saved_mark` — crates/wasm-api), so undoing back to the exact
 * depth a save happened at is clean again, matching every other undo-aware
 * editor. This module stays wasm-free (no `Scene` import — see the module
 * doc above), so every function that needs the kernel's answer takes it as
 * an explicit `atSavedMark: boolean` parameter — App.tsx is the one place
 * that calls `scene.at_saved_mark()` and passes the result in. `dirty` is
 * still a plain stored field (recomputed at each write, not on every read)
 * so the many call sites that read `docSessionRef.current.dirty` stay cheap.
 *
 * Not everything that should count as "unsaved" lives on the kernel's undo
 * stack, though: Scenes, Library provenance stamps, and a few document
 * replacements the kernel itself considers clean (a crash-recovered
 * snapshot, an imported foreign-format file — both go through `Scene.load`,
 * which is clean-at-depth-0 by kernel default) all need to force dirty
 * regardless of `atSavedMark`. `nonUndoableReasons` tracks WHY, as a small
 * set of human-readable reason strings (not just a bool) — the
 * unsaved-changes dialog lists them alongside the undo-entry list so a
 * "why is this dirty, I didn't change any geometry" moment has an answer.
 */

import type { FileRef } from './fileHost'
import { formatRelativeTime } from './relativeTime'

/** Snapshot of document session state. */
export interface DocSessionState {
  /** Current file reference (null = unsaved / "Untitled"). */
  currentRef: FileRef | null
  /** True when the document has unsaved changes — derived from
   * `!atSavedMark || nonUndoableReasons.size > 0` at the moment this state
   * was produced (see the module doc comment). */
  dirty: boolean
  /**
   * Display name used when currentRef is null but the document was imported
   * from a named file (e.g. from a .dae import).  Used by deriveTitle and
   * saveAsDocument so the imported filename appears in the title and the
   * Save As dialog's suggested name, without a backing .hew handle.
   */
  importedName?: string
  /**
   * Epoch ms when the document most recently transitioned clean → dirty
   *. Null until the first edit of the session. Deliberately
   * NOT bumped on every subsequent mutation while already dirty — it marks
   * the start of the current unsaved-edit streak, matching `afterMutation`'s
   * existing no-op-when-already-dirty optimization (dragging Push/Pull etc.
   * can fire many mutations/sec; re-stamping this on each one would defeat
   * that and cause far more re-renders for a purely cosmetic label).
   */
  lastEditAt: number | null
  /** Epoch ms of the most recent successful save/open/import.
   * Null until the document has been saved (or opened/imported) at least once. */
  lastSavedAt: number | null
  /** Reasons the document is dirty that the kernel's own undo stack can't
   * see (so `atSavedMark` alone can't detect them) — see the module doc
   * comment. Cleared by `afterSave`/`afterOpen`. Order doesn't matter; the
   * dialog sorts however it likes. */
  nonUndoableReasons: ReadonlySet<string>
}

/** Shared empty-set instance — every clean state (INITIAL_SESSION,
 * afterSave, afterOpen) can point at the same one rather than allocating. */
const EMPTY_REASONS: ReadonlySet<string> = new Set()

/** The fixed non-undoable-dirty reason strings (Lane C). `imported` is a
 * template, not a constant — the dialog and title both want the specific
 * file name. */
export const NON_UNDOABLE_REASON = {
  scenesEdited: 'Scenes edited',
  libraryMaterials: 'Materials added from the Library',
  libraryMetadata: 'Library metadata',
  recovered: 'Recovered document',
} as const

/** `"Imported 'Kitchen.dae'"` — the reason stamped by `afterImport`. */
export function importedReason(name: string): string {
  return `Imported '${name}'`
}

/** Initial (blank) session state. */
export const INITIAL_SESSION: DocSessionState = {
  currentRef: null,
  dirty: false,
  lastEditAt: null,
  lastSavedAt: null,
  nonUndoableReasons: EMPTY_REASONS,
}

/** Just the bare document name (no dirty mark, no " — Hew" suffix) — used by
 * `TitleBar.tsx`/`MenuBar.tsx`'s Studio chrome, which render the
 * name and the `saveStateLabel` indicator as separate pieces rather than one
 * pre-formatted string. */
export function documentName(state: DocSessionState): string {
  return state.currentRef?.name ?? state.importedName ?? 'Untitled'
}

/**
 * Derive the window/document title for the current session state.
 *
 * Format: `[• ]<filename | importedName | 'Untitled'> — Hew`
 */
export function deriveTitle(state: DocSessionState): string {
  const dirtyMark = state.dirty ? '• ' : ''
  return `${dirtyMark}${documentName(state)} — Hew`
}

/**
 * Derive the passive save-state label shown beside the filename — replaces a
 * Save button as the primary save-state cue (`02_app_shell.md`):
 * "Edited <relative time>" while dirty, "Saved <relative time>" once clean.
 * Returns "" before the document has any edit/save history yet (a fresh
 * blank document — nothing to report).
 */
export function saveStateLabel(state: DocSessionState, now: number): string {
  if (state.dirty) {
    return state.lastEditAt === null ? 'Edited' : `Edited ${formatRelativeTime(state.lastEditAt, now)}`
  }
  return state.lastSavedAt === null ? '' : `Saved ${formatRelativeTime(state.lastSavedAt, now)}`
}

/** `!atSavedMark || reasons.size > 0` — the one formula both `afterMutation`
 * and `markNonUndoableDirty` derive `dirty` from (module doc comment). */
function deriveDirty(atSavedMark: boolean, reasons: ReadonlySet<string>): boolean {
  return !atSavedMark || reasons.size > 0
}

/**
 * Return the state after a document mutation. `atSavedMark` is the kernel's
 * own answer (`scene.at_saved_mark()`) — one wasm bool call at the caller's
 * single choke point (App.tsx's `handleDocumentChanged`), covering every
 * commit, undo, AND redo alike: undoing back to the saved depth returns
 * here with `atSavedMark: true` and cleans the document right back up.
 */
export function afterMutation(state: DocSessionState, now: number, atSavedMark: boolean): DocSessionState {
  const dirty = deriveDirty(atSavedMark, state.nonUndoableReasons)
  if (dirty === state.dirty) return state // no visible change — see lastEditAt's doc comment
  if (!dirty) return { ...state, dirty: false }
  return { ...state, dirty: true, lastEditAt: now }
}

/**
 * Return the state after a change the kernel's undo stack cannot see (so
 * `atSavedMark` alone would miss it) — Scenes edits, Library provenance
 * stamps, a material added to the palette. `reason` is one of
 * `NON_UNDOABLE_REASON`'s values, or `importedReason(name)`. Idempotent for
 * a reason already recorded while already dirty (a no-op, matching
 * `afterMutation`'s optimization); otherwise always dirties, since a
 * non-undoable change can never be un-done back to clean by the user.
 */
export function markNonUndoableDirty(state: DocSessionState, reason: string, now: number): DocSessionState {
  const known = state.nonUndoableReasons.has(reason)
  if (known && state.dirty) return state
  const reasons = known ? state.nonUndoableReasons : new Set(state.nonUndoableReasons).add(reason)
  return {
    ...state,
    nonUndoableReasons: reasons,
    dirty: true,
    // Only stamp the clean → dirty transition, exactly like afterMutation —
    // a second non-undoable reason landing while already dirty doesn't
    // restart the "Edited …" relative-time clock.
    lastEditAt: state.dirty ? state.lastEditAt : now,
  }
}

/** The library save's WRITE-THROUGH commit: apply `afterSave` only when
 * the session is still exactly the state the flow captured before its
 * awaits AND nothing dirtied it meanwhile — an edit landing during the
 * async file write must keep its dirty state (the written bytes predate
 * it; marking it clean would be silent, autosave-suppressed data loss).
 * Anything else returns `prev` unchanged. `atSavedMark` is the caller's
 * post-write `scene.at_saved_mark()` read (see `afterSave`). */
export function applyWriteThroughSave(
  prev: DocSessionState,
  capturedSession: DocSessionState,
  ref: FileRef,
  now: number,
  atSavedMark: boolean,
): DocSessionState {
  if (prev !== capturedSession || prev.dirty) return prev
  return afterSave(ref, now, atSavedMark)
}

/**
 * Return the state after a successful save. `ref` is the FileRef returned
 * by the host (may be a new ref for Save As). `atSavedMark` is the CALLER's
 * `scene.at_saved_mark()` read taken right after (conditionally) calling
 * `scene.mark_saved()` — see docs/agents/HEW_API.md §7's `hew.doc.save`
 * note: the kernel mark is only set when the write really did correspond to
 * the document's CURRENT undo depth (no edit raced ahead of the write), so
 * a caller that skipped `mark_saved()` for that reason passes `false` here
 * and this function honestly reports the document as still dirty rather
 * than silently losing the edit that raced ahead.
 */
export function afterSave(ref: FileRef, now: number, atSavedMark: boolean): DocSessionState {
  return {
    currentRef: ref,
    dirty: !atSavedMark,
    lastEditAt: atSavedMark ? null : now,
    lastSavedAt: now,
    nonUndoableReasons: EMPTY_REASONS,
  }
}

/**
 * Return the state after opening a file or creating a new document.
 * `ref` is null for New. Always clean: `Document::load` (and a blank
 * `Document::new`) are clean-at-depth-0 by kernel default (crates/kernel/
 * tests/saved_mark_specs.rs), so there is no `atSavedMark` parameter here —
 * the kernel state this lands on is unconditionally at its own saved mark.
 */
export function afterOpen(ref: FileRef | null, now: number): DocSessionState {
  return { currentRef: ref, dirty: false, lastEditAt: null, lastSavedAt: now, nonUndoableReasons: EMPTY_REASONS }
}

/**
 * Return the state after replacing the document with an imported foreign
 * file (.dae/.stl/.gltf/.skp/a Library item's Open-as-Document).
 *
 * `name` is the basename of the imported file (e.g. "Kitchen.dae").  The
 * ".dae" extension is stripped for display.
 *
 * Safety contract: currentRef is null so saveDocument() will call
 * save(bytes, null) → both WebFileHost and TauriFileHost treat a null ref as
 * "Save As" and always prompt the user.  This prevents silent overwrites of any
 * file handle.  The importedName flows through to deriveTitle (for the window
 * title) and to saveAsDocument's suggestedName (so the user sees a sensible
 * default filename in the Save As dialog).
 *
 * Always dirty, unconditionally — an `importedReason` non-undoable reason
 * is stamped rather than relying on `atSavedMark`: the import itself
 * usually pushes real, undoable actions (so `at_saved_mark()` would already
 * read false), but an import of a foreign file with no content imports zero
 * actions, and that edge case must still prompt to save (there is still no
 * `.hew` file behind this content) exactly like the non-empty case.
 */
export function afterImport(name: string, now: number): DocSessionState {
  // Strip the .dae extension (case-insensitive) for the display name.
  const displayName = name.replace(/\.dae$/i, '')
  return {
    currentRef: null,
    dirty: true,
    importedName: displayName,
    lastEditAt: now,
    lastSavedAt: null,
    nonUndoableReasons: new Set([importedReason(displayName)]),
  }
}

/**
 * Return the state after adopting a crash-recovery snapshot into this
 * window (`adoptSnapshot`, App.tsx). Like `afterImport`, always dirty via
 * an explicit reason rather than `atSavedMark`: `Scene.load` is
 * clean-at-depth-0 by kernel default, but a recovered snapshot has never
 * been written to `currentRef`'s actual file (only to the recovery slot) —
 * `lastSavedAt` stays null for the same reason. `currentRef`/`importedName`
 * mirror whatever the crashed session had (a named file recovers back to
 * that name; an unsaved document recovers as an import-shaped Untitled).
 */
export function afterRecovery(
  currentRef: FileRef | null,
  importedName: string | undefined,
  lastEditAt: number | null,
): DocSessionState {
  return {
    currentRef,
    dirty: true,
    importedName,
    lastEditAt,
    lastSavedAt: null,
    nonUndoableReasons: new Set([NON_UNDOABLE_REASON.recovered]),
  }
}
