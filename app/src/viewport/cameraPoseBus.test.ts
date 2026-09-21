import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  subscribeCameraPose,
  publishCameraPose,
  resetCameraPoseBus,
  lastCameraPose,
} from './cameraPoseBus'

describe('cameraPoseBus', () => {
  beforeEach(() => resetCameraPoseBus())

  it('delivers a published pose to every subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeCameraPose(a)
    subscribeCameraPose(b)
    publishCameraPose(0, 0, 0, 1)
    expect(a).toHaveBeenCalledWith(0, 0, 0, 1)
    expect(b).toHaveBeenCalledWith(0, 0, 0, 1)
  })

  it('replays the last pose to a subscriber that arrives afterwards — chrome toggled back on mid-session is oriented on its first paint', () => {
    publishCameraPose(0.1, 0.2, 0.3, 0.9)
    const late = vi.fn()
    subscribeCameraPose(late)
    expect(late).toHaveBeenCalledOnce()
    expect(late).toHaveBeenCalledWith(0.1, 0.2, 0.3, 0.9)
  })

  it('does not call a subscriber before anything has been published', () => {
    const early = vi.fn()
    subscribeCameraPose(early)
    expect(early).not.toHaveBeenCalled()
  })

  it('drops an unchanged pose, so a frame rendered for some other reason costs nothing', () => {
    const cb = vi.fn()
    subscribeCameraPose(cb)
    publishCameraPose(0, 0, 0, 1)
    publishCameraPose(0, 0, 0, 1)
    publishCameraPose(0, 0, 0, 1)
    expect(cb).toHaveBeenCalledOnce()
  })

  it('ignores motion below the epsilon and reports motion above it', () => {
    const cb = vi.fn()
    subscribeCameraPose(cb)
    publishCameraPose(0, 0, 0, 1)
    cb.mockClear()

    publishCameraPose(1e-9, 0, 0, 1)
    expect(cb).not.toHaveBeenCalled()

    publishCameraPose(1e-6, 0, 0, 1)
    expect(cb).toHaveBeenCalledOnce()
  })

  it('does not let a sub-epsilon drift accumulate silently into a stale retained pose', () => {
    // Each step is dropped, so the retained pose must still be the published
    // one — not a running sum.
    publishCameraPose(0, 0, 0, 1)
    for (let i = 0; i < 100; i++) publishCameraPose(1e-9, 0, 0, 1)
    expect(lastCameraPose()).toEqual([0, 0, 0, 1])
  })

  it('retains the pose even with nobody listening, so the first subscriber still gets it', () => {
    publishCameraPose(0, 0.7071, 0, 0.7071)
    expect(lastCameraPose()).toEqual([0, 0.7071, 0, 0.7071])
    const cb = vi.fn()
    subscribeCameraPose(cb)
    expect(cb).toHaveBeenCalledWith(0, 0.7071, 0, 0.7071)
  })

  it('stops delivering after unsubscribe, and unsubscribing twice is a no-op', () => {
    const cb = vi.fn()
    const off = subscribeCameraPose(cb)
    off()
    off()
    publishCameraPose(0, 0, 0, 1)
    expect(cb).not.toHaveBeenCalled()
  })

  it('leaves the other subscribers alone when one unsubscribes', () => {
    const stay = vi.fn()
    const go = vi.fn()
    subscribeCameraPose(stay)
    const off = subscribeCameraPose(go)
    off()
    publishCameraPose(0, 0, 0, 1)
    expect(stay).toHaveBeenCalledOnce()
    expect(go).not.toHaveBeenCalled()
  })

  it('reset drops the retained pose so a remounting viewport cannot hand over the previous document camera', () => {
    publishCameraPose(0.5, 0.5, 0.5, 0.5)
    resetCameraPoseBus()
    expect(lastCameraPose()).toBeNull()
    const cb = vi.fn()
    subscribeCameraPose(cb)
    expect(cb).not.toHaveBeenCalled()
  })

  it('keeps listeners across a reset — they own their own unsubscribe and outlive a viewport remount', () => {
    const cb = vi.fn()
    subscribeCameraPose(cb)
    publishCameraPose(0, 0, 0, 1)
    resetCameraPoseBus()
    cb.mockClear()
    publishCameraPose(0, 0, 0, 1)
    expect(cb).toHaveBeenCalledOnce()
  })
})
