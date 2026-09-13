import { describe, it, expect, afterEach } from 'vitest'
import { getPanicCapture } from './panicCapture'

function setGlobal(value: unknown): void {
  ;(globalThis as { __hewLastPanic?: unknown }).__hewLastPanic = value
}

afterEach(() => {
  delete (globalThis as { __hewLastPanic?: unknown }).__hewLastPanic
})

describe('getPanicCapture', () => {
  it('returns null when the global is absent', () => {
    expect(getPanicCapture()).toBeNull()
  })

  it('reads a well-formed capture with a recording', () => {
    setGlobal({ at: '2026-01-01T00:00:00.000Z', message: 'panicked at foo.rs:1', recording: '{"version":2,"calls":[],"golden_hash":0}' })
    expect(getPanicCapture()).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      message: 'panicked at foo.rs:1',
      recording: '{"version":2,"calls":[],"golden_hash":0}',
    })
  })

  it('reads a well-formed capture with a null recording', () => {
    setGlobal({ at: '2026-01-01T00:00:00.000Z', message: 'panicked at foo.rs:1', recording: null })
    expect(getPanicCapture()).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      message: 'panicked at foo.rs:1',
      recording: null,
    })
  })

  it.each([
    ['null', null],
    ['a string', 'not an object'],
    ['a number', 42],
    ['missing at', { message: 'm', recording: null }],
    ['missing message', { at: 'a', recording: null }],
    ['non-string at', { at: 1, message: 'm', recording: null }],
    ['non-string message', { at: 'a', message: 1, recording: null }],
    ['non-string/non-null recording', { at: 'a', message: 'm', recording: 1 }],
  ])('returns null for a malformed capture (%s)', (_label, value) => {
    setGlobal(value)
    expect(getPanicCapture()).toBeNull()
  })

  it('never throws even if reading the global itself misbehaves', () => {
    Object.defineProperty(globalThis, '__hewLastPanic', {
      configurable: true,
      get() {
        throw new Error('boom')
      },
    })
    expect(() => getPanicCapture()).not.toThrow()
    expect(getPanicCapture()).toBeNull()
    // Restore a plain writable property so afterEach's delete works cleanly.
    Object.defineProperty(globalThis, '__hewLastPanic', {
      configurable: true,
      writable: true,
      value: undefined,
    })
  })
})
