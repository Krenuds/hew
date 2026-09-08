import { describe, expect, it, vi } from 'vitest'
import { RenderScheduler } from './renderScheduler'

/** A fake rAF: `flush()` runs every callback requested since the last
 * flush, in request order, mirroring how the real one dispatches within a
 * frame. Handles are just incrementing counters — good enough for a fake
 * that only needs to identify a pending callback for `cancelFrame`. */
function fakeRaf() {
  let nextHandle = 1
  const pending = new Map<number, (time: number) => void>()
  return {
    requestFrame: (cb: (time: number) => void): number => {
      const handle = nextHandle++
      pending.set(handle, cb)
      return handle
    },
    cancelFrame: (handle: number): void => {
      pending.delete(handle)
    },
    /** Run every callback pending right now (a single simulated frame). */
    flush(time = 0): void {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const cb of callbacks) cb(time)
    },
    pendingCount(): number {
      return pending.size
    },
  }
}

describe('RenderScheduler', () => {
  it('does not arm a frame until request() is called', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    new RenderScheduler(raf, runFrame)
    expect(raf.pendingCount()).toBe(0)
    expect(runFrame).not.toHaveBeenCalled()
  })

  it('request() arms exactly one frame', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.request()
    expect(raf.pendingCount()).toBe(1)
    expect(scheduler.pending).toBe(true)
  })

  it('request() coalesces — repeated calls before the frame runs do not stack up more frames', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.request()
    scheduler.request()
    scheduler.request()
    expect(raf.pendingCount()).toBe(1)
    raf.flush()
    expect(runFrame).toHaveBeenCalledTimes(1)
  })

  it('runFrame runs on flush and the pump goes idle again (no auto re-arm)', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.request()
    raf.flush()
    expect(runFrame).toHaveBeenCalledTimes(1)
    expect(scheduler.pending).toBe(false)
    expect(raf.pendingCount()).toBe(0)
  })

  it('onFrame(true) re-arms; onFrame(false) leaves the pump idle', () => {
    const raf = fakeRaf()
    const scheduler = new RenderScheduler(raf, (_time) => {
      // still animating this particular frame
      scheduler.onFrame(true)
    })
    scheduler.request()
    raf.flush()
    expect(scheduler.pending).toBe(true) // re-armed by onFrame(true)

    raf.flush() // second frame — same callback re-arms again
    expect(scheduler.pending).toBe(true)
  })

  it('onFrame(false) does not re-arm', () => {
    const raf = fakeRaf()
    const scheduler = new RenderScheduler(raf, () => {
      scheduler.onFrame(false)
    })
    scheduler.request()
    raf.flush()
    expect(scheduler.pending).toBe(false)
  })

  it('counts frames that actually ran', () => {
    const raf = fakeRaf()
    let animate = true
    const scheduler = new RenderScheduler(raf, () => {
      scheduler.onFrame(animate)
    })
    scheduler.request()
    raf.flush()
    raf.flush()
    animate = false
    raf.flush() // this one still runs (was armed by the previous onFrame(true))
    expect(scheduler.frameCount).toBe(3)
    expect(scheduler.pending).toBe(false)
  })

  it('setVisible(false) cancels a pending frame', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.request()
    expect(raf.pendingCount()).toBe(1)
    scheduler.setVisible(false)
    expect(raf.pendingCount()).toBe(0)
    expect(scheduler.pending).toBe(false)
  })

  it('setVisible(false) blocks further request() calls', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.setVisible(false)
    scheduler.request()
    expect(raf.pendingCount()).toBe(0)
    expect(runFrame).not.toHaveBeenCalled()
  })

  it('setVisible(true) alone does not request a frame', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.setVisible(false)
    scheduler.setVisible(true)
    expect(raf.pendingCount()).toBe(0)
    expect(runFrame).not.toHaveBeenCalled()
  })

  it('setVisible(true) allows a subsequent request() to arm again', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.setVisible(false)
    scheduler.setVisible(true)
    scheduler.request()
    expect(raf.pendingCount()).toBe(1)
  })

  it('cancel() clears a pending frame and is idempotent', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.request()
    scheduler.cancel()
    expect(raf.pendingCount()).toBe(0)
    expect(() => scheduler.cancel()).not.toThrow()
  })

  it('cancel() does not block a later request()', () => {
    const raf = fakeRaf()
    const runFrame = vi.fn()
    const scheduler = new RenderScheduler(raf, runFrame)
    scheduler.request()
    scheduler.cancel()
    scheduler.request()
    expect(raf.pendingCount()).toBe(1)
  })
})
