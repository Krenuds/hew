/**
 * MirrorTool — draw the mirror image of the selected sketch shapes across a
 * line you click.
 *
 * Gesture:
 *   1. With shapes, lines or curves of one sketch selected, click the first
 *      point of the mirror line, then the second. Both must land on that
 *      sketch's plane (snaps are constrained to it once the first point is
 *      down).
 *   2. The kernel draws the image into the same sketch as ordinary geometry
 *      — it welds where it touches, a drawn circle stays a circle — and the
 *      originals stay (`mirror_sketch_islands`), one undo step.
 *   3. Escape drops the first point.
 *
 * Nothing selected, or a selection spanning several sketches, is toasted on
 * the first click rather than guessed at.
 */

import type { Tool, Snap } from './types'
import type { Ray } from '../viewport/math'
import type { Scene as WasmScene } from '../wasm/loader'
import type { NodeRef } from '../panels/treeModel'
import { parseKernelErrorCode, kernelErrorMessage } from '../kernelErrors'
import { resolveSketchIsland } from './transformSelection'

export type OnMirrorCommit = () => void
export type OnToast = (message: string, code?: string) => void

type V3 = [number, number, number]

type Stage =
  | { kind: 'idle' }
  | { kind: 'first'; sketch: bigint; islands: bigint[]; a: V3; plane: { point: V3; normal: V3 } }

/** The one sketch's islands a selection names, or `null` with a reason. */
export function mirrorTargets(
  wasmScene: WasmScene,
  selection: readonly NodeRef[],
): { sketch: bigint; islands: bigint[] } | { error: string } {
  let sketch: bigint | null = null
  const islands: bigint[] = []
  for (const node of selection) {
    let hits: { sketch: bigint; island: bigint }[] = []
    if (node.kind === 'sketch') {
      hits = Array.from(wasmScene.sketch_island_ids(node.id)).map((island) => ({
        sketch: node.id,
        island,
      }))
    } else {
      const one = resolveSketchIsland(wasmScene, node)
      if (one !== null) hits = [one]
    }
    for (const hit of hits) {
      if (sketch !== null && hit.sketch !== sketch) {
        return { error: 'Mirror works within one sketch. Select shapes of a single sketch.' }
      }
      sketch = hit.sketch
      if (!islands.includes(hit.island)) islands.push(hit.island)
    }
  }
  if (sketch === null) return { error: 'Select the sketch shapes to mirror first.' }
  return { sketch, islands }
}

export class MirrorTool implements Tool {
  readonly name = 'Mirror'
  private stage: Stage = { kind: 'idle' }
  lastSnap: Snap | null = null

  constructor(
    private readonly wasmScene: WasmScene,
    private readonly selection: () => readonly NodeRef[],
    private readonly onCommit: OnMirrorCommit,
    private readonly onToast: OnToast,
  ) {}

  statusHint(): string {
    return this.stage.kind === 'idle'
      ? 'Click the first point of the mirror line.'
      : 'Click the second point of the mirror line. Escape to start over.'
  }

  hasArmedGesture(): boolean {
    return this.stage.kind === 'first'
  }

  snapConstraint(): { constraintPlane: { point: V3; normal: V3 } } | null {
    return this.stage.kind === 'first' ? { constraintPlane: this.stage.plane } : null
  }

  onPointerMove(snap: Snap | null, _ray: Ray): void {
    this.lastSnap = snap
  }

  onPointerDown(snap: Snap | null, _ray: Ray): void {
    if (snap === null) return
    const p: V3 = [snap.x, snap.y, snap.z]
    if (this.stage.kind === 'idle') {
      const targets = mirrorTargets(this.wasmScene, this.selection())
      if ('error' in targets) {
        this.onToast(targets.error)
        return
      }
      const planeArr = this.wasmScene.sketch_plane(targets.sketch)
      if (planeArr === undefined) return
      const plane = {
        point: [planeArr[0], planeArr[1], planeArr[2]] as V3,
        normal: [planeArr[3], planeArr[4], planeArr[5]] as V3,
      }
      this.stage = { kind: 'first', sketch: targets.sketch, islands: targets.islands, a: p, plane }
      return
    }
    const { sketch, islands, a } = this.stage
    const d: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
    if (Math.hypot(d[0], d[1], d[2]) < 1e-9) return
    try {
      this.wasmScene.mirror_sketch_islands(
        sketch, new BigUint64Array(islands), a[0], a[1], a[2], d[0], d[1], d[2],
      )
    } catch (err) {
      const code = parseKernelErrorCode(err)
      const rawMsg = err instanceof Error ? err.message : String(err)
      this.onToast(kernelErrorMessage(code ?? 'Unknown', rawMsg), code ?? undefined)
      this.stage = { kind: 'idle' }
      return
    }
    this.stage = { kind: 'idle' }
    this.onCommit()
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.cancel()
  }

  cancel(): void {
    this.stage = { kind: 'idle' }
  }
}
