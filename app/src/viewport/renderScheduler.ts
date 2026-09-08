/**
 * RenderScheduler — the on-demand animation-frame pump (Lane F, "Render loop
 * on demand").
 *
 * Before this, Viewport's `render()` re-armed `requestAnimationFrame`
 * unconditionally as its first statement: a permanent 60Hz (or display
 * refresh rate) callback that ran for the entire life of the viewport,
 * whether or not anything was actually changing on screen. Idle CPU never
 * reached zero even sitting on a static, unedited document.
 *
 * This class owns only the frame-request bookkeeping — WHEN a frame is
 * requested, not what happens inside one. Viewport.tsx still does the actual
 * per-frame work (controls.update(), fades, the renderer.render() call
 * itself); this class just decides whether `requestAnimationFrame` should be
 * armed right now:
 *
 *   - `request()` — coalescing: arms a frame only if one isn't already
 *     pending and the document is visible. Every mutation site that used to
 *     rely on the free-running pump now calls this (indirectly, via
 *     Viewport's `scheduleRender()`) instead.
 *   - `onFrame(stillAnimating)` — called by the frame callback right after
 *     it finishes its per-frame work, with whatever it determined about
 *     ongoing motion (OrbitControls damping still in flight, a Shop Mode
 *     fade tween, the tape loupe engaged). Re-arms via `request()` iff true;
 *     otherwise the pump goes fully idle until the next `request()`.
 *   - `setVisible(visible)` — `document.visibilitychange` gate: hidden
 *     cancels any pending frame and blocks further `request()` calls until
 *     visible again; becoming visible does NOT itself schedule a frame (the
 *     caller follows up with an explicit `request()`/`scheduleRender()`, so
 *     a document that happened to be mid-animation when it was hidden
 *     doesn't silently keep animating behind a `setVisible(true)` alone).
 *
 * Pure and DOM-free (`requestFrame`/`cancelFrame` are injected) so it can be
 * unit-tested without a browser.
 */

export interface RenderSchedulerDeps {
  /** Normally `window.requestAnimationFrame.bind(window)`. */
  requestFrame: (callback: (time: number) => void) => number
  /** Normally `window.cancelAnimationFrame.bind(window)`. */
  cancelFrame: (handle: number) => void
}

export class RenderScheduler {
  private handle = 0
  private visible = true
  private frames = 0

  constructor(
    private readonly deps: RenderSchedulerDeps,
    /** The per-frame work. Called with no return value — the caller reports
     *  whether to keep animating via a follow-up `onFrame()` call, not a
     *  return value, so a frame can decide "still animating" from state
     *  (controls.update()'s result, fade/loupe flags) gathered DURING the
     *  same frame this callback runs in. */
    private readonly runFrame: (time: number) => void,
  ) {}

  /**
   * Request a frame if one isn't already pending and the document is
   * currently visible. Idempotent — safe to call from every mutation site
   * unconditionally; only the first call between frames actually arms
   * `requestAnimationFrame`.
   */
  request(): void {
    if (this.handle !== 0 || !this.visible) return
    this.handle = this.deps.requestFrame(this.onRaf)
  }

  private onRaf = (time: number): void => {
    this.handle = 0
    this.frames += 1
    this.runFrame(time)
  }

  /**
   * Called by the frame callback (`runFrame`) after it finishes its
   * per-frame work, reporting whether something is still actively
   * animating (OrbitControls damping in flight, a fade tween, the loupe
   * engaged). Re-arms iff true; a frame that renders once and settles does
   * NOT keep the pump running.
   */
  onFrame(stillAnimating: boolean): void {
    if (stillAnimating) this.request()
  }

  /**
   * `document.visibilitychange` gate. Hidden cancels any pending frame and
   * blocks `request()` until visible again — a backgrounded/minimized
   * window has no reason to keep rendering. Becoming visible does NOT
   * itself request a frame; the caller (Viewport's `visibilitychange`
   * handler) follows up with its own `scheduleRender()` so the transition
   * is explicit at the call site rather than implicit here.
   */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible && this.handle !== 0) {
      this.deps.cancelFrame(this.handle)
      this.handle = 0
    }
  }

  /** Force-cancel any pending frame (context loss, unmount). Idempotent. */
  cancel(): void {
    if (this.handle !== 0) {
      this.deps.cancelFrame(this.handle)
      this.handle = 0
    }
  }

  /** True while a frame is currently armed (rAF has been requested but
   *  hasn't run yet). Exposed for tests. */
  get pending(): boolean {
    return this.handle !== 0
  }

  /** Count of rAF callbacks that have actually run — `__hew_test.
   *  frameCount()`'s source, and unit-testable directly here. */
  get frameCount(): number {
    return this.frames
  }
}
