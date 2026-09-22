/**
 * ExtendTool — lengthen a drawn sketch line until it meets another.
 *
 * Gesture:
 *   1. Click a line near the end to extend (`pick_sketch_edge`; the end
 *      nearer the click is the one that grows).
 *   2. Click the line it should reach. The kernel draws the missing piece
 *      along the first line's own direction and welds it into the target,
 *      splitting it (`extend_sketch_edge`) — one undo step. A target the
 *      line never reaches (parallel, behind the end, beside it) is refused
 *      typed (`NothingToExtendTo`) and toasted; the first pick stays armed
 *      so another target can be tried.
 *   3. Escape drops the first pick.
 *
 * Trim needs no tool of its own: a line is already split at every crossing
 * as it is drawn, so the piece between two crossings is an edge, and Erase
 * on it is the trim.
 */

import type { Tool, Snap } from './types'
import type { Ray } from '../viewport/math'
import type { Scene as WasmScene } from '../wasm/loader'
import { parseKernelErrorCode, kernelErrorMessage } from '../kernelErrors'

export type OnExtendCommit = () => void
export type OnToast = (message: string, code?: string) => void

type Stage =
  | { kind: 'idle' }
  | { kind: 'armed'; sketch: bigint; edge: bigint; near: [number, number, number] }

export class ExtendTool implements Tool {
  readonly name = 'Extend'
  private stage: Stage = { kind: 'idle' }
  lastSnap: Snap | null = null

  constructor(
    private readonly wasmScene: WasmScene,
    private readonly onCommit: OnExtendCommit,
    private readonly onToast: OnToast,
  ) {}

  statusHint(): string {
    return this.stage.kind === 'idle'
      ? 'Click a line near the end you want to extend.'
      : 'Click the line it should reach. Escape to start over.'
  }

  hasArmedGesture(): boolean {
    return this.stage.kind === 'armed'
  }

  onPointerMove(snap: Snap | null, _ray: Ray): void {
    this.lastSnap = snap
  }

  onPointerDown(snap: Snap | null, ray: Ray): void {
    const pick = this.wasmScene.pick_sketch_edge(
      ray.origin[0], ray.origin[1], ray.origin[2],
      ray.direction[0], ray.direction[1], ray.direction[2],
    )
    if (pick === undefined) return
    let sketch: bigint
    let edge: bigint
    try {
      sketch = pick.sketch()
      edge = pick.edge()
    } finally {
      pick.free()
    }
    if (this.stage.kind === 'idle') {
      const near: [number, number, number] =
        snap !== null ? [snap.x, snap.y, snap.z] : [ray.origin[0], ray.origin[1], ray.origin[2]]
      this.stage = { kind: 'armed', sketch, edge, near }
      return
    }
    const armed = this.stage
    if (sketch !== armed.sketch) {
      this.onToast('Pick a line in the same sketch.')
      return
    }
    if (edge === armed.edge) return
    try {
      this.wasmScene.extend_sketch_edge(
        armed.sketch, armed.edge, armed.near[0], armed.near[1], armed.near[2], edge,
      )
    } catch (err) {
      const code = parseKernelErrorCode(err)
      const rawMsg = err instanceof Error ? err.message : String(err)
      this.onToast(kernelErrorMessage(code ?? 'Unknown', rawMsg), code ?? undefined)
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
