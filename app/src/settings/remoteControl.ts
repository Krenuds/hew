/**
 * Remote Control setting — module-level singleton (docs/dev/DEVELOPMENT.md).
 *
 * The consent gate docs/agents/HEW_API.md §11.5 requires: off by default, and
 * nothing about a hosted tab's document is reachable from the network until
 * the user turns it on. Enabling it is what fetches the bridge's session
 * token and opens the WebSocket (api/wsTransport.ts); disabling it closes
 * the socket, after which a `--live` client sees the same honest "no running
 * instance" a closed desktop app gives.
 *
 * Persistence + cross-window sync mirrors settings/debugMode.ts:
 *   - Persisted to localStorage under `hew.settings.remoteControl`.
 *   - Broadcast on the shared 'settings-changed' Tauri global event under its
 *     own payload key (`remoteControl`), so separate webview windows stay in
 *     step — the desktop has no bridge of its own, but the Settings window
 *     must still show the truth.
 *   - The browser 'storage' event covers same-origin web tabs.
 *
 * One thing this module has that the other settings do not: subscribers are
 * told WHERE a change came from. Attaching is per-tab — a session belongs to
 * one document (§11.5 "Ownership") — so a second tab learning through the
 * storage event that remote control is allowed must show that, and must NOT
 * quietly open a socket of its own and take the session from the tab the
 * user was actually looking at. `'local'` means this tab's user asked;
 * `'external'` means another window did.
 */

import { isTauri } from '../io/fileHost'

const STORAGE_KEY = 'hew.settings.remoteControl'
const DEFAULT_REMOTE_CONTROL = false

/** Where a change came from — see this module's doc comment. */
export type ChangeSource = 'local' | 'external'

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
  return DEFAULT_REMOTE_CONTROL
}

let currentRemoteControl: boolean = loadInitial()
const subscribers = new Set<(on: boolean, source: ChangeSource) => void>()

function notify(source: ChangeSource): void {
  for (const cb of subscribers) cb(currentRemoteControl, source)
}

/** Read the current Remote Control setting. */
export function getRemoteControl(): boolean {
  return currentRemoteControl
}

/**
 * Set Remote Control. Persists to localStorage, notifies local subscribers,
 * and broadcasts to other windows (Tauri global event; the 'storage' event
 * covers same-origin web tabs automatically).
 */
export function setRemoteControl(on: boolean): void {
  currentRemoteControl = on
  try {
    localStorage.setItem(STORAGE_KEY, String(on))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  notify('local')
  broadcastTauri(on)
}

/** Subscribe to Remote Control changes (local + cross-window). Returns an unsubscribe fn. */
export function subscribe(cb: (on: boolean, source: ChangeSource) => void): () => void {
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
    tauriEmit('settings-changed', { remoteControl: on }).catch(() => { /* ignore */ })
    return
  }
  import('@tauri-apps/api/event').then(({ emit }) => {
    tauriEmit = emit
    return emit('settings-changed', { remoteControl: on })
  }).catch(() => { /* ignore */ })
}

function applyExternal(next: unknown): void {
  if (typeof next !== 'boolean' || next === currentRemoteControl) return
  currentRemoteControl = next
  notify('external')
}

// Refresh the singleton + notify subscribers when the OTHER window changes
// the setting. Two channels:
//   - Tauri global event 'settings-changed' (separate webview windows).
//   - Browser 'storage' event (same-origin web tabs).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return
    if (isBoolString(ev.newValue)) {
      applyExternal(ev.newValue === 'true')
    }
  })

  if (isTauri) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      return listen<{ remoteControl?: unknown }>('settings-changed', (event) => {
        applyExternal(event.payload?.remoteControl)
      })
    }).catch(() => { /* ignore */ })
  }
}
