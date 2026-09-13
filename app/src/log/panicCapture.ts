/**
 * panicCapture — reads the in-memory record the wasm panic hook leaves on
 * `globalThis.__hewLastPanic` (crates/wasm-api/src/lib.rs's panic hook,
 * docs/dev/DIAGNOSTICS.md). A Rust panic poisons the wasm instance, so by the
 * time React's ErrorBoundary or a catch block sees the resulting
 * "recursive use of an object" throw, every `Scene` method (`save()`,
 * `state_hash()`, `take_recording()`) throws too — the hook is the last
 * point the panic message and the recorder's buffered calls can be read at
 * all, and it hands them straight to the page rather than through a `Scene`
 * call that would itself throw.
 *
 * In-memory only (unlike the `localStorage['hew:lastPanic']` companion
 * record, which is message-only and survives a reload): it does not survive
 * a reload, but it carries the recording a crash reproducer needs.
 */

/**
 * The page event the wasm panic hook fires once the capture is written.
 * ErrorBoundary listens for it to show the crash screen at once, since the
 * handler whose `Scene` call panicked usually catches the trap and carries on.
 */
export const KERNEL_PANIC_EVENT = 'hew:kernel-panic'

/** A panic capture as the wasm panic hook writes it to `globalThis.__hewLastPanic`. */
export interface PanicCapture {
  /** ISO timestamp of the panic. */
  at: string
  /** The panic message (`info.to_string()` — includes the source location). */
  message: string
  /**
   * Recording JSON (docs/dev/DIAGNOSTICS.md) captured from inside the
   * panicking frame, or null if nothing had been recorded yet. Its
   * `golden_hash` is always 0 — a panicking frame can't hash the document —
   * so treat it as a reproducer, never a regression oracle. Never
   * `JSON.parse` it: see sessionRecording.ts for why.
   */
  recording: string | null
}

/**
 * Defensively read `globalThis.__hewLastPanic`, validating every field's
 * type. Never throws; returns null when the global is absent or malformed
 * rather than trusting a shape a future refactor of the hook might change
 * out from under this reader.
 */
export function getPanicCapture(): PanicCapture | null {
  try {
    const raw = (globalThis as { __hewLastPanic?: unknown }).__hewLastPanic
    if (raw === null || typeof raw !== 'object') return null
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.at !== 'string') return null
    if (typeof candidate.message !== 'string') return null
    if (candidate.recording !== null && typeof candidate.recording !== 'string') return null
    return { at: candidate.at, message: candidate.message, recording: candidate.recording }
  } catch {
    return null
  }
}
