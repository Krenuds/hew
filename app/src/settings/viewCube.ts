/**
 * ViewCube visibility setting — module-level singleton
 * (docs/design/camera.md §8).
 *
 * One boolean: whether the orientation cube is drawn in the top-right of the
 * viewport. Default ON — it is the primary way to tell where the camera is
 * pointing, and a navigation aid nobody can find is no navigation aid. Hidden
 * from View ▸ View Cube for people who want the whole canvas.
 *
 * Persistence + cross-window sync mirrors settings/sceneTransitions.ts
 * exactly:
 *   - Persisted to localStorage under `hew.settings.viewCube`.
 *   - Under Tauri, separate webview windows do NOT share a `storage` event,
 *     so changes are ALSO broadcast on the same 'settings-changed' Tauri
 *     global event the other settings use (a distinct payload key, so every
 *     listener coexists on the one channel).
 *   - The browser 'storage' event covers same-origin web tabs.
 */

import { isTauri } from '../io/fileHost'

const STORAGE_KEY = 'hew.settings.viewCube'
const DEFAULT_VIEW_CUBE = true

function isBoolString(v: unknown): v is string {
  return v === 'true' || v === 'false'
}

function loadInitial(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (isBoolString(raw)) return raw === 'true'
  } catch {
    /* ignore — privacy mode / unavailable storage */
  }
  return DEFAULT_VIEW_CUBE
}

let currentViewCube: boolean = loadInitial()
const subscribers = new Set<(on: boolean) => void>()

function notify(): void {
  for (const cb of subscribers) cb(currentViewCube)
}

/** Is the ViewCube currently shown? */
export function getViewCube(): boolean {
  return currentViewCube
}

/**
 * Show or hide the ViewCube. Persists to localStorage, notifies local
 * subscribers, and broadcasts to other windows (Tauri global event; the
 * 'storage' event covers same-origin web tabs automatically).
 */
export function setViewCube(on: boolean): void {
  currentViewCube = on
  try {
    localStorage.setItem(STORAGE_KEY, String(on))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  notify()
  broadcastTauri(on)
}

/** Subscribe to ViewCube visibility changes (local + cross-window). Returns an unsubscribe fn. */
export function subscribe(cb: (on: boolean) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

// ---------------------------------------------------------------------------
// Cross-window sync
// ---------------------------------------------------------------------------

let tauriEmit: ((event: string, payload?: unknown) => Promise<void>) | null = null

function broadcastTauri(on: boolean): void {
  if (!isTauri) return
  if (tauriEmit !== null) {
    tauriEmit('settings-changed', { viewCube: on }).catch(() => { /* ignore */ })
    return
  }
  import('@tauri-apps/api/event').then(({ emit }) => {
    tauriEmit = emit
    return emit('settings-changed', { viewCube: on })
  }).catch(() => { /* ignore */ })
}

function applyExternal(next: unknown): void {
  if (typeof next !== 'boolean' || next === currentViewCube) return
  currentViewCube = next
  notify()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return
    if (isBoolString(ev.newValue)) {
      applyExternal(ev.newValue === 'true')
    }
  })

  if (isTauri) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      return listen<{ viewCube?: unknown }>('settings-changed', (event) => {
        applyExternal(event.payload?.viewCube)
      })
    }).catch(() => { /* ignore */ })
  }
}
