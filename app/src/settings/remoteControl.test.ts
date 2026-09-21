import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getRemoteControl, setRemoteControl, subscribe } from './remoteControl'

const STORAGE_KEY = 'hew.settings.remoteControl'

// This suite's vitest environment is 'node' (`.test.ts`), so there is no real
// `localStorage` — remoteControl.ts already guards every access in try/catch
// (privacy mode / unavailable storage), which is what lets it run here at
// all. Install a minimal in-memory stub to exercise persistence itself; the
// block is copied verbatim from debugMode.test.ts, the nearest twin.
class FakeStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
}

let originalLocalStorage: unknown

beforeEach(() => {
  originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = new FakeStorage()
  setRemoteControl(false)
})

afterEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage
})

describe('remoteControl', () => {
  it('is off by default — the consent gate HEW_API.md §11.5 requires', () => {
    expect(getRemoteControl()).toBe(false)
  })

  it('set/get round-trips', () => {
    setRemoteControl(true)
    expect(getRemoteControl()).toBe(true)
    setRemoteControl(false)
    expect(getRemoteControl()).toBe(false)
  })

  it('subscribe fires on change with the new value, marked as this tab', () => {
    const seen: Array<[boolean, string]> = []
    const unsub = subscribe((on, source) => seen.push([on, source]))
    setRemoteControl(true)
    setRemoteControl(false)
    expect(seen).toEqual([
      [true, 'local'],
      [false, 'local'],
    ])
    unsub()
  })

  it('unsubscribe stops further notifications', () => {
    const seen: boolean[] = []
    const unsub = subscribe((on) => seen.push(on))
    setRemoteControl(true)
    unsub()
    setRemoteControl(false)
    expect(seen).toEqual([true])
  })

  it('persists to localStorage', () => {
    setRemoteControl(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
    setRemoteControl(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false')
  })
})

// The storage-event path is what a SECOND tab sees. It must reach
// subscribers — the Settings UI has to show the truth — but marked
// 'external', because a session belongs to one document (§11.5
// "Ownership") and App.tsx uses exactly this to decide not to open a socket
// of its own.
describe('remoteControl, changed by another tab', () => {
  it('reports a change it learned through the storage event as external', async () => {
    vi.resetModules()
    const listeners: Array<(ev: { key: string; newValue: string | null }) => void> = []
    const fakeWindow = {
      addEventListener: (type: string, cb: (ev: { key: string; newValue: string | null }) => void) => {
        if (type === 'storage') listeners.push(cb)
      },
    }
    const original = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = fakeWindow
    try {
      const m = await import('./remoteControl')
      const seen: Array<[boolean, string]> = []
      m.subscribe((on, source) => seen.push([on, source]))
      expect(listeners).toHaveLength(1)

      listeners[0]({ key: STORAGE_KEY, newValue: 'true' })
      expect(seen).toEqual([[true, 'external']])
      expect(m.getRemoteControl()).toBe(true)

      // An unrelated key, and a repeat of the value already held, are both
      // ignored — no spurious attach/detach for a subscriber.
      listeners[0]({ key: 'hew.settings.theme', newValue: 'false' })
      listeners[0]({ key: STORAGE_KEY, newValue: 'true' })
      expect(seen).toHaveLength(1)

      listeners[0]({ key: STORAGE_KEY, newValue: 'false' })
      expect(seen).toEqual([
        [true, 'external'],
        [false, 'external'],
      ])
    } finally {
      ;(globalThis as { window?: unknown }).window = original
      vi.resetModules()
    }
  })
})
