/**
 * Viewport settings — module-level singleton.
 *
 * The viewport's look-and-feel knobs, as ONE persisted object rather than a
 * key per knob (same call as `trayLayout.ts`: several small display
 * preferences that belong to one surface are one logical setting — one
 * module, one `subscribe`, one broadcast payload key, instead of N
 * near-identical singleton files each re-implementing the storage + Tauri +
 * 'storage'-event triple).
 *
 * Today it carries two fields:
 *
 *   `showViewCube` — whether the orientation cube draws in the corner of
 *   the viewport (`viewport/ViewCube.tsx`). Shown by default. Surfaced as a
 *   View ▸ View Cube checkmark rather than a Settings row, the same posture
 *   `sceneTransitions` takes: it is chrome you flick on and off next to
 *   Axes/Grid/Guides, not a value you go and tune.
 *
 *   `snapDotScale` — how big the on-cursor inference marker draws
 *   (`viewport/SnapDot.tsx`), as a UNITLESS multiple of the shipped size.
 *   1.0 is the design default; the slider in Settings ▸ Viewport spans
 *   0.6–1.5 in 0.1 steps. A scale rather than a pixel count so a future
 *   redesign of the marker keeps every persisted value meaningful ("30%
 *   smaller than whatever Hew ships"), and so the knobs that follow —
 *   grid density, orbit sensitivity — which have no pixel to name, share
 *   one control and one readout format with it.
 *
 * NOTE this is a DISPLAY size and has nothing to do with the snap
 * TOLERANCE: how near the cursor must come before a point is acquired is
 * `SNAP_RADIUS_PX`/`SNAP_BREAK_RADIUS_PX` in `viewport/snapService.ts`, and
 * the two are deliberately decoupled — shrinking the marker must not make
 * snapping harder.
 *
 * Persistence + cross-window sync mirrors settings/trayLayout.ts exactly:
 *   - Persisted to localStorage under `hew.settings.viewport` (one JSON
 *     object).
 *   - Under Tauri, separate webview windows (main + Settings) do NOT share a
 *     `storage` event, so changes are ALSO broadcast via the same
 *     'settings-changed' Tauri global event theme.ts/units.ts/trayLayout.ts
 *     use (different payload key — `viewport` — so all listeners coexist on
 *     one event channel without colliding).
 *   - The browser 'storage' event covers same-origin web tabs.
 */

import { isTauri } from '../io/fileHost'

/** The viewport display preferences. */
export interface ViewportSettings {
  /** Whether the orientation cube is drawn (docs/design/camera.md §8). */
  showViewCube: boolean
  /** Snap-marker size as a multiple of the shipped size (1 = as designed). */
  snapDotScale: number
}

const STORAGE_KEY = 'hew.settings.viewport'

/** Slider bounds for `snapDotScale`, shared by both settings surfaces (the
 * macOS `ViewportPane` and the Windows `FluentSettingsPage`) so the two can
 * never disagree on the range. */
export const SNAP_DOT_SCALE_MIN = 0.6
export const SNAP_DOT_SCALE_MAX = 1.5
/** 0.1 steps: with the marker's 10px base core, every stop lands on a whole
 * CSS pixel (6…15px), so no setting renders a half-pixel — and therefore
 * blurry — core. */
export const SNAP_DOT_SCALE_STEP = 0.1

export const DEFAULT_VIEWPORT_SETTINGS: ViewportSettings = {
  // On by default: an orientation aid nobody can find is no orientation aid.
  showViewCube: true,
  snapDotScale: 1,
}

/** A unitless scale reads naturally as a percentage — and it's what the
 * slider announces to screen readers (`aria-valuetext`), since a bare
 * `aria-valuenow` of 0.8 would be read out as "zero point eight". */
export function formatScalePercent(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** Clamp to the slider's range and quantize to its step. Floats at 0.1 steps
 * otherwise persist as 0.7000000000000001 and defeat equality everywhere. */
function normalizeScale(v: number): number {
  const clamped = Math.min(SNAP_DOT_SCALE_MAX, Math.max(SNAP_DOT_SCALE_MIN, v))
  return Math.round(clamped * 100) / 100
}

/**
 * Parse a persisted/broadcast value. Unknown shapes return null; an
 * individual missing/mistyped field falls back to its default, and an
 * out-of-range number is clamped rather than rejected — so a value written
 * by a newer build (a wider slider, an extra knob) degrades to something
 * sane instead of resetting the whole object.
 */
function parseViewportSettings(v: unknown): ViewportSettings | null {
  let obj: unknown = v
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (typeof obj !== 'object' || obj === null) return null
  const out = { ...DEFAULT_VIEWPORT_SETTINGS }
  const fields = obj as Record<string, unknown>
  const scale = fields.snapDotScale
  if (typeof scale === 'number' && Number.isFinite(scale)) {
    out.snapDotScale = normalizeScale(scale)
  }
  if (typeof fields.showViewCube === 'boolean') {
    out.showViewCube = fields.showViewCube
  }
  return out
}

function loadInitial(): ViewportSettings {
  try {
    const parsed = parseViewportSettings(localStorage.getItem(STORAGE_KEY))
    if (parsed !== null) return parsed
  } catch {
    /* ignore — privacy mode / unavailable storage */
  }
  return { ...DEFAULT_VIEWPORT_SETTINGS }
}

let currentViewportSettings: ViewportSettings = loadInitial()
const subscribers = new Set<(settings: ViewportSettings) => void>()

function notify(): void {
  for (const cb of subscribers) cb(currentViewportSettings)
}

/** Read the current viewport settings. */
export function getViewportSettings(): ViewportSettings {
  return currentViewportSettings
}

/** Convenience: just the snap-marker scale. */
export function getSnapDotScale(): number {
  return currentViewportSettings.snapDotScale
}

/**
 * Set the viewport settings. Persists to localStorage, notifies local
 * subscribers, and broadcasts to other windows (Tauri global event; the
 * 'storage' event covers same-origin web tabs automatically).
 */
export function setViewportSettings(next: ViewportSettings): void {
  currentViewportSettings = {
    showViewCube:
      typeof next.showViewCube === 'boolean'
        ? next.showViewCube
        : DEFAULT_VIEWPORT_SETTINGS.showViewCube,
    snapDotScale: Number.isFinite(next.snapDotScale)
      ? normalizeScale(next.snapDotScale)
      : DEFAULT_VIEWPORT_SETTINGS.snapDotScale,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentViewportSettings))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  notify()
  broadcastTauri(currentViewportSettings)
}

/** Convenience: set just the snap-marker scale (clamped + quantized). */
export function setSnapDotScale(next: number): void {
  setViewportSettings({ ...currentViewportSettings, snapDotScale: next })
}

/** Convenience: is the orientation cube shown? */
export function getShowViewCube(): boolean {
  return currentViewportSettings.showViewCube
}

/** Convenience: show or hide the orientation cube. */
export function setShowViewCube(next: boolean): void {
  setViewportSettings({ ...currentViewportSettings, showViewCube: next })
}

/** Subscribe to viewport-settings changes (local + cross-window). Returns an unsubscribe fn. */
export function subscribe(cb: (settings: ViewportSettings) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

// ---------------------------------------------------------------------------
// Cross-window sync
// ---------------------------------------------------------------------------

let tauriEmit: ((event: string, payload?: unknown) => Promise<void>) | null = null

function broadcastTauri(settings: ViewportSettings): void {
  if (!isTauri) return
  if (tauriEmit !== null) {
    tauriEmit('settings-changed', { viewport: settings }).catch(() => { /* ignore */ })
    return
  }
  import('@tauri-apps/api/event').then(({ emit }) => {
    tauriEmit = emit
    return emit('settings-changed', { viewport: settings })
  }).catch(() => { /* ignore */ })
}

function sameSettings(a: ViewportSettings, b: ViewportSettings): boolean {
  return a.snapDotScale === b.snapDotScale && a.showViewCube === b.showViewCube
}

function applyExternal(next: unknown): void {
  const parsed = parseViewportSettings(next)
  if (parsed === null || sameSettings(parsed, currentViewportSettings)) return
  currentViewportSettings = parsed
  notify()
}

// Refresh the singleton + notify subscribers when the OTHER window changes
// the setting. Two channels:
//   - Tauri global event 'settings-changed' (separate webview windows).
//   - Browser 'storage' event (same-origin web tabs).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return
    applyExternal(ev.newValue)
  })

  if (isTauri) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      return listen<{ viewport?: unknown }>('settings-changed', (event) => {
        applyExternal(event.payload?.viewport)
      })
    }).catch(() => { /* ignore */ })
  }
}
