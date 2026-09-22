import type { Snap } from './types'

/**
 * The document node an annotation anchor should track for the point `snap`
 * landed on, as the `(kind, id)` pair `add_linear_dimension` /
 * `add_leader_text` take, or `null` for a free anchor.
 *
 * An instance wins over the object inside it (the pose is what moves). A
 * snap on a sketch's line work — a corner, an edge, or a drawn curve's
 * analytic point — names the sketch (kind 3), so the annotation follows the
 * whole sketch and detaches when the line under it goes. A snap on a
 * region's fill is not on a line and stays free: the kernel refuses an
 * anchor off a sketch's lines (`AnchorOffSketch`).
 */
export function anchorNodeFromSnap(snap: Snap): { kind: number; id: bigint } | null {
  if (snap.instance !== undefined) return { kind: 2, id: snap.instance }
  if (snap.object !== undefined) return { kind: 0, id: snap.object }
  if (
    snap.sketch !== undefined &&
    (snap.elementKind === 'sketch-vertex' ||
      snap.elementKind === 'sketch-edge' ||
      snap.elementKind === 'sketch-curve')
  ) {
    return { kind: 3, id: snap.sketch }
  }
  return null
}
