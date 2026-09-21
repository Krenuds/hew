import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getViewportSettings,
  setViewportSettings,
  getSnapDotScale,
  setSnapDotScale,
  getShowViewCube,
  setShowViewCube,
  subscribe,
  formatScalePercent,
  DEFAULT_VIEWPORT_SETTINGS,
  SNAP_DOT_SCALE_MIN,
  SNAP_DOT_SCALE_MAX,
  type ViewportSettings,
} from './viewport'

const STORAGE_KEY = 'hew.settings.viewport'

// This project's vitest environment is 'node' for .test.ts (no jsdom), so
// there is no real `localStorage` global — viewport.ts already guards every
// access in try/catch (privacy-mode / unavailable storage), which is exactly
// what lets it run at all under plain Node. Mirrors trayLayout.test.ts's stub.
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
  setViewportSettings(DEFAULT_VIEWPORT_SETTINGS)
})

afterEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage
})

describe('viewport settings', () => {
  it('defaults the snap-dot scale to 1 (the marker as designed)', () => {
    expect(DEFAULT_VIEWPORT_SETTINGS).toEqual({ snapDotScale: 1, showViewCube: true })
    expect(getViewportSettings()).toEqual(DEFAULT_VIEWPORT_SETTINGS)
    expect(getSnapDotScale()).toBe(1)
  })

  it('set/get round-trips a scale', () => {
    setSnapDotScale(0.7)
    expect(getSnapDotScale()).toBe(0.7)
    setSnapDotScale(1.3)
    expect(getViewportSettings()).toEqual({ snapDotScale: 1.3, showViewCube: true })
  })

  it('clamps a scale below the slider minimum', () => {
    setSnapDotScale(0.01)
    expect(getSnapDotScale()).toBe(SNAP_DOT_SCALE_MIN)
  })

  it('clamps a scale above the slider maximum', () => {
    setSnapDotScale(99)
    expect(getSnapDotScale()).toBe(SNAP_DOT_SCALE_MAX)
  })

  it('falls back to the default on a non-finite scale', () => {
    setSnapDotScale(Number.NaN)
    expect(getSnapDotScale()).toBe(DEFAULT_VIEWPORT_SETTINGS.snapDotScale)
  })

  it('quantizes float drift to the slider step', () => {
    // 0.6 + 0.1 in binary floating point — what an <input type="range">
    // hands back when the user drags, before it round-trips through storage.
    setSnapDotScale(0.7000000000000001)
    expect(getSnapDotScale()).toBe(0.7)
  })

  it('set copies its argument (later caller-side mutation does not leak in)', () => {
    const settings: ViewportSettings = { snapDotScale: 0.8, showViewCube: true }
    setViewportSettings(settings)
    settings.snapDotScale = 1.5
    expect(getSnapDotScale()).toBe(0.8)
  })

  it('subscribe fires on change with the new value', () => {
    const seen: ViewportSettings[] = []
    const unsub = subscribe((s) => seen.push(s))
    setSnapDotScale(0.9)
    expect(seen).toEqual([{ snapDotScale: 0.9, showViewCube: true }])
    unsub()
  })

  it('unsubscribe stops further notifications', () => {
    const seen: ViewportSettings[] = []
    const unsub = subscribe((s) => seen.push(s))
    setSnapDotScale(0.9)
    unsub()
    setSnapDotScale(1.2)
    expect(seen).toEqual([{ snapDotScale: 0.9, showViewCube: true }])
  })

  it('persists to localStorage as JSON under the settings naming scheme', () => {
    setSnapDotScale(0.8)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      snapDotScale: 0.8,
      showViewCube: true,
    })
  })
})

describe('formatScalePercent', () => {
  it('renders the scale as a whole percentage', () => {
    expect(formatScalePercent(1)).toBe('100%')
    expect(formatScalePercent(0.6)).toBe('60%')
    expect(formatScalePercent(1.5)).toBe('150%')
  })
})

describe('showViewCube', () => {
  it('defaults to shown', () => {
    expect(getShowViewCube()).toBe(true)
    expect(DEFAULT_VIEWPORT_SETTINGS.showViewCube).toBe(true)
  })

  it('round-trips through the convenience setter', () => {
    setShowViewCube(false)
    expect(getShowViewCube()).toBe(false)
    setShowViewCube(true)
    expect(getShowViewCube()).toBe(true)
  })

  it('survives a write that only names the other field', () => {
    // `setViewportSettings` rebuilds the object field by field, so a field it
    // forgets is dropped on every write — including writes made by an
    // unrelated knob. This is the guard for that.
    setShowViewCube(false)
    setSnapDotScale(0.8)
    expect(getShowViewCube()).toBe(false)
    expect(getSnapDotScale()).toBe(0.8)
  })

  it('persists alongside the other field', () => {
    setShowViewCube(false)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      snapDotScale: 1,
      showViewCube: false,
    })
  })

  it('notifies subscribers when only the cube changes', () => {
    // `applyExternal` early-returns when `sameSettings` says nothing moved,
    // so a dedup helper that still compares only the old field would make a
    // cross-window change to this one vanish with no error anywhere.
    const seen: ViewportSettings[] = []
    const unsub = subscribe((v) => seen.push(v))
    setShowViewCube(false)
    expect(seen).toEqual([{ snapDotScale: 1, showViewCube: false }])
    unsub()
  })
})

// loadInitial runs at module-evaluation time, so restoring-from-storage needs
// a FRESH module instance per case (vi.resetModules + dynamic import); the
// statically-imported instance above is unaffected.
describe('viewport settings restore on load', () => {
  it('restores a persisted scale', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapDotScale: 0.8 }))
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getSnapDotScale()).toBe(0.8)
  })

  it('falls back per-field on a mistyped scale', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapDotScale: 'big' }))
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getViewportSettings()).toEqual(DEFAULT_VIEWPORT_SETTINGS)
  })

  it('clamps an out-of-range persisted scale instead of resetting it', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapDotScale: 4 }))
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getSnapDotScale()).toBe(SNAP_DOT_SCALE_MAX)
  })

  it('tolerates an unknown field written by a newer build', async () => {
    // The whole point of the object-shaped key: a future knob must not
    // invalidate the fields this build DOES understand.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapDotScale: 0.8, gridWeight: 3 }))
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getSnapDotScale()).toBe(0.8)
  })

  it('restores a persisted cube visibility', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ showViewCube: false }))
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getShowViewCube()).toBe(false)
    // The field it was not told about still comes back as its default.
    expect(fresh.getSnapDotScale()).toBe(DEFAULT_VIEWPORT_SETTINGS.snapDotScale)
  })

  it('falls back per-field on a mistyped cube visibility', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ showViewCube: 'yes', snapDotScale: 0.8 }))
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getShowViewCube()).toBe(true)
    expect(fresh.getSnapDotScale()).toBe(0.8)
  })

  it('falls back to the defaults on malformed JSON', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getViewportSettings()).toEqual(DEFAULT_VIEWPORT_SETTINGS)
  })

  it('falls back to the defaults on a non-object value', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42))
    vi.resetModules()
    const fresh = await import('./viewport')
    expect(fresh.getViewportSettings()).toEqual(DEFAULT_VIEWPORT_SETTINGS)
  })
})
