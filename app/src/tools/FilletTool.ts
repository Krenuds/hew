/**
 * FilletTool — round (or, with Alt, cut) a corner of a drawn sketch.
 *
 * Gesture:
 *   1. Type a radius (or chamfer distance) any time; the last one is kept.
 *   2. Click a corner where two straight lines of a sketch meet
 *      (`pick_sketch_vertex`). The corner is replaced in one undo step:
 *      a fillet draws a true arc tangent to both lines
 *      (`fillet_sketch_corner`); Alt-click cuts the corner straight
 *      (`chamfer_sketch_corner`).
 *   3. After the click, a typed size redoes that corner at the new size
 *      through the shared retype window (retypeWindow.ts).
 *
 * The kernel owns the geometry and refuses typed: a free end, a junction of
 * three, a curve's facet (`NotACorner`), or a size the two lines cannot
 * carry (`CornerTooSmall`) leaves the sketch untouched and toasts.
 */

import type { Tool, Snap } from './types'
import type { Ray } from '../viewport/math'
import type { Scene as WasmScene } from '../wasm/loader'
import { parseKernelErrorCode, kernelErrorMessage } from '../kernelErrors'
import { editLengthBuffer, isLengthInputKey } from './moveInput'
import { RetypeWindow, idleRetypeCapturesKey, retypeStaleMessage } from './retypeWindow'
import { formatLength, parseLengthToMeters, getLengthUnit, typedReadout } from '../settings/units'

export type OnFilletCommit = () => void
export type OnToast = (message: string, code?: string) => void
export type OnMeasurement = (text: string) => void

/** The default size a corner gets before anything is typed (meters). */
export const DEFAULT_FILLET_SIZE = 0.1

type Spec = { sketch: bigint; vertex: bigint; size: number; chamfer: boolean }

export class FilletTool implements Tool {
  readonly name = 'Fillet'

  /** The size the next click uses, in meters. */
  size = DEFAULT_FILLET_SIZE
  /** Alt is down: the next click cuts the corner straight instead of
   *  rounding it. Set by the host from the pointer event (the Paint tool's
   *  `setEyedropper` idiom). */
  chamfer = false
  private typed = ''
  private readonly retype: RetypeWindow<Spec>
  lastSnap: Snap | null = null

  constructor(
    private readonly wasmScene: WasmScene,
    private readonly onCommit: OnFilletCommit,
    private readonly onToast: OnToast,
    private readonly onMeasurementCb: OnMeasurement = () => { /* no-op */ },
  ) {
    this.retype = new RetypeWindow(wasmScene)
    this.onMeasurementCb(formatLength(this.size))
  }

  statusHint(): string {
    return this.retype.isOpen
      ? 'Type a size to redo that corner — or click another corner. Alt-click cuts it straight.'
      : `Click a corner where two lines meet to round it at ${formatLength(this.size)} — type a size first to change it. Alt-click cuts it straight.`
  }

  hasArmedGesture(): boolean {
    return this.typed !== ''
  }

  capturesKey(key: string): boolean {
    return idleRetypeCapturesKey(key, this.typed, isLengthInputKey)
  }

  disarmRetype(): void {
    this.retype.close()
  }

  onPointerMove(snap: Snap | null, _ray: Ray): void {
    this.lastSnap = snap
  }

  onPointerDown(_snap: Snap | null, ray: Ray): void {
    this.retype.close()
    const pick = this.wasmScene.pick_sketch_vertex(
      ray.origin[0], ray.origin[1], ray.origin[2],
      ray.direction[0], ray.direction[1], ray.direction[2],
    )
    if (pick === undefined) return
    let sketch: bigint
    let vertex: bigint
    try {
      sketch = pick.sketch()
      vertex = pick.vertex()
    } finally {
      pick.free()
    }
    const spec: Spec = { sketch, vertex, size: this.size, chamfer: this.chamfer }
    const genBefore = this.wasmScene.history_generation()
    if (this._commit(spec)) this.retype.armFrom(spec, genBefore)
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      this.cancel()
      return
    }
    if (!this.capturesKey(ev.key)) return
    if (ev.key === 'Enter') {
      const meters = parseLengthToMeters(this.typed)
      this.typed = ''
      if (meters === null || !(meters > 0)) {
        this.onMeasurementCb(formatLength(this.size))
        return
      }
      this.size = meters
      this.onMeasurementCb(formatLength(this.size))
      if (this.retype.isOpen) this._retype(meters)
      return
    }
    this.typed = editLengthBuffer(this.typed, ev.key, getLengthUnit())
    this.onMeasurementCb(this.typed === '' ? formatLength(this.size) : typedReadout(this.typed))
  }

  cancel(): void {
    this.retype.close()
    this.typed = ''
    this.onMeasurementCb(formatLength(this.size))
  }

  /** Redo the corner just made at `size` (undo, re-commit, roll back on refusal). */
  private _retype(size: number): void {
    const outcome = this.retype.apply(
      (hot) => this._commit({ ...hot, size }),
      (hot) => this._commit(hot),
      (hot) => ({ ...hot, size }),
    )
    if (outcome === 'stale') this.onToast(retypeStaleMessage('corner'))
  }

  /** The kernel commit: true when accepted, false when refused (toasted). */
  private _commit(spec: Spec): boolean {
    try {
      if (spec.chamfer) {
        this.wasmScene.chamfer_sketch_corner(spec.sketch, spec.vertex, spec.size)
      } else {
        this.wasmScene.fillet_sketch_corner(spec.sketch, spec.vertex, spec.size)
      }
      this.onCommit()
      return true
    } catch (err) {
      const code = parseKernelErrorCode(err)
      const rawMsg = err instanceof Error ? err.message : String(err)
      this.onToast(kernelErrorMessage(code ?? 'Unknown', rawMsg), code ?? undefined)
      return false
    }
  }
}
