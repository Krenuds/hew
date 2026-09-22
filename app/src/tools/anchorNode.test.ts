import { describe, it, expect } from 'vitest'
import { anchorNodeFromSnap } from './anchorNode'
import type { Snap } from './types'

const base: Snap = { x: 0, y: 0, z: 0, kind: 'free' } as Snap

describe('anchorNodeFromSnap', () => {
  it('names the instance over the object inside it', () => {
    expect(anchorNodeFromSnap({ ...base, object: 4n, instance: 9n })).toEqual({ kind: 2, id: 9n })
    expect(anchorNodeFromSnap({ ...base, object: 4n })).toEqual({ kind: 0, id: 4n })
  })

  it("names the sketch for a snap on its line work", () => {
    expect(anchorNodeFromSnap({ ...base, sketch: 7n, elementKind: 'sketch-edge' })).toEqual({
      kind: 3,
      id: 7n,
    })
    expect(anchorNodeFromSnap({ ...base, sketch: 7n, elementKind: 'sketch-curve' })).toEqual({
      kind: 3,
      id: 7n,
    })
    expect(anchorNodeFromSnap({ ...base, sketch: 7n, elementKind: 'sketch-vertex' })).toEqual({
      kind: 3,
      id: 7n,
    })
  })

  it("stays free on a region's fill and on empty space", () => {
    expect(anchorNodeFromSnap({ ...base, sketch: 7n, elementKind: 'sketch-region', sketchRegion: 1n })).toBeNull()
    expect(anchorNodeFromSnap(base)).toBeNull()
  })
})
