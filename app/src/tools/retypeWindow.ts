/**
 * retypeWindow — the shared engine behind "type the size after the click".
 *
 * SketchUp's idiom: draw a shape roughly, then type its exact measurement
 * and it redraws — as often as you like, until the next action. Every tool
 * that takes a typed measurement BEFORE its committing click offers the
 * same entry AFTER it through one of these windows: the draw tools
 * (Rectangle's `W,D`, Circle's and Polygon's radius, Arc's bulge, Line's
 * segment length) and the modify tools (Push/Pull's and Offset's distance,
 * Move's distance, Rotate's angle, Scale's factor or dimension). The tool
 * owns its buffer and grammar; this class owns the part
 * that must be identical everywhere — the record of what was just
 * committed and the guarded undo → re-commit → restore cycle:
 *
 * - `arm(spec)` remembers the committed geometry (`spec`, tool-defined)
 *   together with the document's HISTORY GENERATION right after the commit
 *   — the undo-stack identity that proves a later `scene_undo()` retracts
 *   exactly this commit. A content hash could not stand in (MoveTool's
 *   array window is the precedent — see its `arrayHot` doc): a net-zero
 *   pair of edits restores the hash while burying the commit two entries
 *   deep, and a view-state toggle changes it without invalidating anything.
 * - `apply(...)`: if the generation still matches, ONE `scene_undo()`
 *   retracts the commit and `recommit(spec)` lays the new geometry down
 *   through the tool's ordinary commit path, so the result is exactly what
 *   a click at the new size would have produced, and one undo step. If the
 *   generation moved, the window is over ('stale') and nothing is touched.
 * - A REFUSED re-commit is rolled back so a bad size never loses the shape
 *   that was there. Two cases, told apart by the generation: the refusal
 *   recorded nothing (a face split is one atomic op; a gesture whose first
 *   segment was refused) → `scene_redo()` restores the original
 *   bit-for-bit. The refusal recorded a PARTIAL step (a multi-segment
 *   gesture that got some segments in — `sketch_end_gesture` pushes
 *   whatever changed, and any new step clears the redo stack) → undo that
 *   partial step, then `restore(spec)` redraws the ORIGINAL geometry as a
 *   fresh commit, since there is nothing left to redo.
 * - After either outcome the window stays open, re-stamped, so another
 *   size can be typed; only a failure to restore at all closes it.
 *
 * The window closes on any pointer action, Escape, tool switch (tools are
 * recreated per activation), `cancel()`, and the host's
 * `disarmActivePostCommitWindow` (explicit undo/redo/delete) — each tool
 * routes those through `close()`. The "first gesture on a fresh sketch
 * folds the sketch's creation into that step" contract (wasm-api
 * `sketch_begin_gesture`) is what makes one undo exactly the shape even on
 * a brand-new plane.
 */

export interface RetypeScene {
  history_generation(): bigint
  scene_undo(): { free(): void }
  scene_redo(): { free(): void }
}

export type RetypeOutcome = 'ok' | 'stale' | 'failed' | 'closed'

export class RetypeWindow<Spec> {
  private hot: { spec: Spec; historyGen: string; entries: number } | null = null

  constructor(private readonly scene: RetypeScene) {}

  /** The committed geometry the window would retype, or null when closed. */
  get spec(): Spec | null {
    return this.hot === null ? null : this.hot.spec
  }

  get isOpen(): boolean {
    return this.hot !== null
  }

  /** Open (or re-open) the window on geometry that just committed.
   *  `entries` is how many history steps that commit recorded (a Move or
   *  Rotate copy of mixed sketch + object sources records more than one) —
   *  how many undos retract it. Prefer `armFrom` when the generation before
   *  the commit is at hand. */
  arm(spec: Spec, entries = 1): void {
    this.hot = { spec, historyGen: this.gen(), entries: Math.max(1, entries) }
  }

  /** `arm` with the entry count measured as the generation delta since
   *  `genBefore` (read just before the commit) — every recorded action moves
   *  the generation by one, so the delta IS the step count. */
  armFrom(spec: Spec, genBefore: bigint): void {
    this.arm(spec, Number(this.genN() - genBefore))
  }

  close(): void {
    this.hot = null
  }

  /**
   * Retract the committed steps without re-committing anything — the retype
   * that asks for "no change" (a Scale factor of 1). Same generation guard
   * as `apply`; the window closes either way, since nothing is left to
   * retype. Returns 'ok' when the steps were undone, 'stale' when the
   * generation had moved (nothing touched), 'closed' when no window was open.
   */
  retract(): RetypeOutcome {
    const hot = this.hot
    if (hot === null) return 'closed'
    this.hot = null
    if (this.gen() !== hot.historyGen) return 'stale'
    for (let i = 0; i < hot.entries; i += 1) this.scene.scene_undo().free()
    return 'ok'
  }

  /**
   * Retype: guarded undo, re-commit, rollback on refusal (see the module
   * doc). `recommit` lays the NEW geometry down and returns whether the
   * kernel accepted it (the tool's commit helpers toast a refusal
   * themselves); `restore` lays the ORIGINAL geometry down the same way;
   * `next` is the spec to remember on success (typically the old one with
   * the new far point / rim / endpoint).
   */
  apply(
    recommit: (spec: Spec) => boolean,
    restore: (spec: Spec) => boolean,
    next: (spec: Spec) => Spec,
  ): RetypeOutcome {
    const hot = this.hot
    if (hot === null) return 'closed'
    if (this.gen() !== hot.historyGen) {
      this.hot = null
      return 'stale'
    }
    for (let i = 0; i < hot.entries; i += 1) this.scene.scene_undo().free()
    const genAfterUndo = this.genN()
    if (recommit(hot.spec)) {
      this.hot = { spec: next(hot.spec), historyGen: this.gen(), entries: Math.max(1, Number(this.genN() - genAfterUndo)) }
      return 'ok'
    }
    try {
      const recorded = Number(this.genN() - genAfterUndo)
      let entries = hot.entries
      if (recorded === 0) {
        for (let i = 0; i < hot.entries; i += 1) this.scene.scene_redo().free()
      } else {
        for (let i = 0; i < recorded; i += 1) this.scene.scene_undo().free()
        const genBeforeRestore = this.genN()
        if (!restore(hot.spec)) {
          this.hot = null
          return 'failed'
        }
        entries = Math.max(1, Number(this.genN() - genBeforeRestore))
      }
      this.hot = { spec: hot.spec, historyGen: this.gen(), entries }
    } catch {
      this.hot = null
    }
    return 'failed'
  }

  private gen(): string {
    return this.scene.history_generation().toString()
  }

  private genN(): bigint {
    return this.scene.history_generation()
  }
}

/** The toast every tool shows when `apply` answers 'stale'. */
export function retypeStaleMessage(shape: string): string {
  return `Dimension entry ended — the model changed since the ${shape} was drawn`
}

/**
 * The shared capture policy for an IDLE tool with an open window (see
 * Tool.capturesKey): a digit (or a leading `-`/`.`) always opens the entry
 * — the SketchUp reflex is to type the size straight after the click — and
 * once something is in
 * the buffer the rest of the tool's own grammar (`isBufferKey`) and Enter
 * follow. With the buffer EMPTY every letter keeps its global meaning, so
 * `m`/`c`/`p`/`f` still switch tools right after a shape; Space always
 * resets to Select, buffer or not.
 */
export function idleRetypeCapturesKey(
  key: string,
  buffer: string,
  isBufferKey: (key: string) => boolean,
): boolean {
  // A digit, a leading minus (a flipped value), or a leading point opens it.
  if ((key >= '0' && key <= '9') || key === '-' || key === '.') return true
  if (buffer === '') return false
  // Space is NEVER taken while idle: it is the global reset-to-Select, and
  // the tool switch it triggers closes the window quietly (MoveTool's array
  // window pinned this contract first). Feet-and-inches still type as 5'3".
  if (key === ' ') return false
  return key === 'Enter' || isBufferKey(key)
}
