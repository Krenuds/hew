/**
 * RectangleTool — two-click rectangle sketching.
 *
 * Typed dimensions work at two moments: after the FIRST click (the classic
 * VCB — `W,D` + Enter commits the rectangle at that size) and after the
 * SECOND click (the retype window — `W,D` + Enter RESIZES the rectangle just
 * committed, in place, as often as wanted, until the next click, Escape,
 * tool switch, or any other change to the document; see `RetypeHot`). The
 * second is SketchUp's idiom of "draw roughly, then type the size".
 *
 * Two modes:
 *
 * Plane mode (activeContext === null, no eligible face): the drawing plane
 * is resolved once, at the first click, and frozen for the rest of the
 * gesture (sketches on any plane — design doc §1/§4):
 *   - A top-level hover over a committed sketch whose plane is non-ground
 *     (`pick_sketch` + `planeFromSketch`) adopts THAT sketch's plane —
 *     SKETCH MODE — and the rectangle's four segments land in that one
 *     sketch (`SketchTarget.existing`).
 *   - Otherwise the plane is the ground plane — PLANE MODE, today's
 *     behavior — segments land in the shared per-plane cached sketch
 *     (`SketchTarget.plane`; `begin_ground_sketch()` on a cache miss).
 *   On the ground plane every corner is computed by the EXACT legacy
 *   `rectangleCorners` (z = 0, no basis math) — bit-identical committed
 *   coordinates. On any other plane, corners come from `faceRectangleCorners`
 *   (the same helper face mode uses), and the cursor is the snap (already
 *   plane-constrained via `snapConstraint`) or, absent one, ray∩plane.
 *
 *   1. First click: anchor corner
 *   2. Move: rubber-band rectangle preview on the plane
 *   3. Second click: commit — four `sketch_add_segment` calls forming the
 *      rectangle, via `runSketchGesture`
 *   4. Esc between clicks: cancel stage 1
 *   Calls onCommit() after each successful commit so the viewport can
 *   refresh scene geometry and trigger re-render.
 *
 * Face mode (an eligible Object face is under the cursor — decided per
 * pointer event like LineTool, not by whether an editing context is active;
 * see `faceDraw.ts` for the shared plain-object eligibility policy):
 *   1. First click on an eligible face: anchor corner (on face plane)
 *   2. Move: rubber-band rectangle preview projected onto that face plane
 *   3. Second click: commit — split_face_inner() on that face
 *   4. Esc: cancel
 *   Calls onFaceImprint(objectId) after each successful imprint so the viewport
 *   can refresh the scene.
 */

import * as THREE from 'three'
import type { Tool, Snap, EditContext } from './types'
import { editContextEq } from './types'
import type { Ray } from '../viewport/math'
import type { Scene as WasmScene } from '../wasm/loader'
import type { V3 } from '../viewport/geoHelpers'
import { rectangleCorners, faceRectangleCorners, facePlaneBasis, rayPlaneIntersect } from '../viewport/geoHelpers'
import { parseKernelErrorCode, kernelErrorMessage } from '../kernelErrors'
import { makeFatSegments, disposeFatSegments, PREVIEW_LINE_STYLE } from '../viewport/fatLine'
import { formatLength, parseDimensionsToMeters, typedReadout } from '../settings/units'
import { editDimsBuffer, nextIdlePlaneLock, AXIS_LOCK_COLOR_NAMES } from './moveInput'
import { runSketchGesture, makeSketchPlaneCache, type SketchPlaneCache, type SketchTarget } from './sketchGesture'
import { pointOnPlane, drawPlaneCue, drawPlaneThrough, isGroundPlane, SketchPickCache, resolveIdleDrawTarget, resolveClickDrawTarget, nextGestureLockPlane, groundNaturalTarget, type DrawPlane } from './drawPlane'
import { getDrawingAxes } from './drawingAxes'
import { measurementAxisFor, type MeasurementAxes } from '../viewport/measurementAxes'
import { FacePickCache, defaultFaceEligible, worldFaceNormal, worldFacePlane, distanceOffPlane, FACE_PLANE_EPS_M, snapOnObjectBoundary, type FaceEligible, type FaceThroughPick } from './faceDraw'
import { RetypeWindow, idleRetypeCapturesKey, retypeStaleMessage } from './retypeWindow'
import { PlanePin } from './planePin'

/** Smallest side, in metres, a ground rectangle may commit with. See the
 *  degeneracy check in `onPointerDown` for why this is per-axis and why it
 *  sits deliberately above the kernel's `tol::POINT_MERGE`. */
export const RECTANGLE_MIN_SIDE = 1e-8

export type RectangleCommitResult = {
  sketchHandle: bigint
  /** Handles of regions created by the last segment (may be empty if not yet closed) */
  regionsCreated: bigint[]
}

export type OnRectangleCommit = (result: RectangleCommitResult) => void
export type OnFaceImprint = (objectId: bigint) => void
export type OnToast = (message: string, code?: string) => void
export type OnMeasurement = (text: string, axes?: MeasurementAxes) => void

/** Plane stage: waiting for first click, or waiting for second click, on a
 *  frozen `DrawPlane`/`SketchTarget`. `natural` (design §2a) is the plane/
 *  target this gesture would have anchored onto at its own first click had
 *  no idle lock been active — what a mid-gesture arrow-key lock reverts to
 *  when toggled back off (see `nextGestureLockPlane` in drawPlane.ts). */
type PlaneStage =
  | { kind: 'idle' }
  | {
      kind: 'anchored'
      plane: DrawPlane
      target: SketchTarget
      anchor: V3
      natural: { plane: DrawPlane; target: SketchTarget }
    }

/** Face stage: idle, or anchored on a specific face plane */
type FaceStage =
  | { kind: 'idle' }
  | {
      kind: 'anchored'
      object: bigint
      face: bigint
      normal: V3
      /** A world-space point that lies on the face plane (the first click position) */
      planePoint: V3
      anchor: V3
    }

/**
 * The just-committed rectangle, kept in a `RetypeWindow` so typed
 * dimensions can resize it after the fact — SketchUp's idiom: click both
 * corners, then type `W,D` + Enter and the rectangle redraws to those
 * dimensions, as often as you like, until the next action. `anchor` and
 * `far` are the two corners the commit used (`far` fixes which way each
 * dimension grows). The undo/re-commit cycle and its history-generation
 * guard live in retypeWindow.ts.
 */
type RetypeSpec = {
  anchor: V3
  far: V3
} & (
  | { mode: 'plane'; plane: DrawPlane; target: SketchTarget }
  | { mode: 'face'; object: bigint; face: bigint; normal: V3 }
)

/** The keys the idle retype buffer can accept, once it holds something —
 *  the same character set the anchored-stage VCB feeds `editDimsBuffer`. */
function isDimsBufferKey(key: string): boolean {
  return (
    (key >= '0' && key <= '9') ||
    key === '.' ||
    key === ',' ||
    key === 'x' ||
    key === 'X' ||
    key === ' ' ||
    key === 'Backspace' ||
    key === "'" ||
    key === '"' ||
    key === '/' ||
    key === '-' ||
    /^[mckftinMCKFTIN]$/.test(key)
  )
}

export class RectangleTool implements Tool {
  readonly name = 'Rectangle'

  /** Live status-bar guidance for the current stage (see Tool.statusHint). */
  statusHint(): string {
    if (this.planeStage.kind !== 'idle' || this.faceStage.kind !== 'idle') {
      return 'Click the opposite corner — or type exact dimensions.'
    }
    if (this.idlePlaneLock !== null) {
      return `Locked to the ${AXIS_LOCK_COLOR_NAMES[this.idlePlaneLock]} plane — click to start; same arrow or Esc unlocks.`
    }
    if (this.pin.current !== null) {
      return 'Pinned to the hovered plane — click to start; Shift again or Esc unpins.'
    }
    if (this.retype.isOpen) {
      return 'Type exact dimensions to resize the rectangle you just drew — or click the first corner of the next one.'
    }
    return 'Click the first corner — on the ground plane or any face or sketch.'
  }

  private planeStage: PlaneStage = { kind: 'idle' }
  private faceStage: FaceStage = { kind: 'idle' }
  private preview: THREE.Group
  private wasmScene: WasmScene
  private onCommit: OnRectangleCommit
  private onFaceImprint: OnFaceImprint
  private onToast: OnToast
  private onMeasurementCb: OnMeasurement

  /** Cached plane-mode sketch handles — the Viewport passes one cache
   *  shared by every draw tool, so mixed-tool profiles land in a single
   *  sketch per plane. */
  private readonly sketchCache: SketchPlaneCache

  /** The current editing context (component-edit-parity.md phase A1) — see
   *  LineTool's identical fields for the full rationale. */
  private _editContext: EditContext = { kind: 'top' }

  /** The entered OBJECT id, or null — unchanged meaning from the old
   *  `_activeContext` field. */
  private get _activeContext(): bigint | null {
    return this._editContext.kind === 'object' ? this._editContext.id : null
  }

  /** The entered component INSTANCE id, or null (component-edit-parity.md
   *  phase A2). */
  private get _activeInstance(): bigint | null {
    return this._editContext.kind === 'instance' ? this._editContext.id : null
  }

  /** VCB buffer — raw string being typed by the user (W,D in display units) */
  private typed: string = ''

  /** The just-committed rectangle, resizable by typed dimensions until the
   *  next pointer action, Escape, tool switch, or any other document
   *  mutation (see `RetypeSpec` and retypeWindow.ts). */
  private readonly retype: RetypeWindow<RetypeSpec>
  /** The retype buffer — `W,D` being typed while IDLE with the window open.
   *  Separate from `typed` (the anchored-stage buffer) so the two windows
   *  can never bleed into each other. */
  private retypeTyped: string = ''

  /** Last rubber-band cursor positions, tracked for typed-entry sign/direction */
  private _lastPlaneCursor: V3 | null = null
  private _lastFaceCursor: V3 | null = null

  /** Idle plane lock (design §5.2): while FULLY idle (no anchored stage),
   *  an arrow key locks the future plane's NORMAL to a world axis (0=X/red,
   *  1=Y/green, 2=Z/blue — `arrowToAxis`); the same arrow again, or
   *  Escape/ArrowDown, clears it. An ACTIVE lock overrides face pick and
   *  sketch-hover adoption on the next click (SketchUp: an explicit lock
   *  beats inference) — see `_currentMode`/`_resolveClickTarget`. Survives a
   *  completed gesture (cleared only by `cancel()`, which
   *  `onDocumentReset()`/`setEditContext()` already route through). */
  private idlePlaneLock: 0 | 1 | 2 | null = null

  /** Shift-pinned drawing plane (GitHub issue 14) — see planePin.ts. Idle
   *  hovers feed it the plane the next click would land on; a Shift press
   *  pins that plane for the whole gesture (and the next, until released).
   *  Mutually exclusive with `idlePlaneLock`: whichever is set last wins. */
  private readonly pin = new PlanePin()

  /** The last hover point seen while idle-locked (design §6 bullet 1) — feeds
   *  `activeDrawPlaneCue()`'s idle-locked case. Reset to null whenever the
   *  lock itself changes (a fresh lock has no hover yet) and by `cancel()`. */
  private _lastIdleHoverPoint: V3 | null = null

  constructor(
    wasmScene: WasmScene,
    previewGroup: THREE.Group,
    onCommit: OnRectangleCommit,
    onToast: OnToast,
    onFaceImprint: OnFaceImprint,
    onMeasurement: OnMeasurement = () => { /* no-op */ },
    sketchCache: SketchPlaneCache = makeSketchPlaneCache(),
  ) {
    this.wasmScene = wasmScene
    this.preview = previewGroup
    this.onCommit = onCommit
    this.onFaceImprint = onFaceImprint
    this.onToast = onToast
    this.onMeasurementCb = onMeasurement
    this.sketchCache = sketchCache
    this.retype = new RetypeWindow(wasmScene)
  }

  /** The single editing-context channel (component-edit-parity.md phase A1;
   *  replaces `setActiveContext`). */
  setEditContext(ctx: EditContext): void {
    if (editContextEq(ctx, this._editContext)) return
    this._editContext = ctx
    this.cancel()
  }

  /** Per-pointer-event `pick_face` memo — see `FacePickCache` in faceDraw.ts. */
  private readonly _pickCache = new FacePickCache()
  /** Per-pointer-event `pick_sketch` memo — see `SketchPickCache` in drawPlane.ts. */
  private readonly _sketchPickCache = new SketchPickCache()

  /** Optional richer eligibility, injected by the Viewport (which knows the
   *  full group/instance context path the tool can't see). Null = the shared
   *  default policy in faceDraw.ts. */
  private _faceEligible: FaceEligible | null = null
  setFaceEligibility(pred: FaceEligible | null): void {
    this._faceEligible = pred
  }

  /** Plain objects are directly drawable at the top level; inside an entered
   *  object context only that object's faces are — see faceDraw.ts. */
  private _isEligible(objectHandle: bigint, instanceHandle: bigint | undefined): boolean {
    if (this._faceEligible !== null) return this._faceEligible(objectHandle, instanceHandle)
    return defaultFaceEligible(this.wasmScene, this._activeContext, objectHandle, instanceHandle)
  }

  /** The eligible face under `ray`, or null (memoized per pointer event). */
  private _eligiblePickFor(ray: Ray): { object: bigint; face: bigint } | null {
    return this._pickCache.pickFor(this.wasmScene, ray, (object, instance) =>
      this._isEligible(object, instance))
  }

  /**
   * The eligible face a click at `snap` means, with its world plane. For a
   * snap ON an object's edge or corner (`snapOnObjectBoundary`) the plain
   * pick under the ray is a coin toss between the faces meeting there — or a
   * miss, which used to send the whole gesture to the GROUND plane (a
   * Rectangle started on a vertical edge's midpoint landed at z = 0) — so
   * the ranked boundary pick (`FacePickCache.faceThrough`) answers instead:
   * the most camera-facing eligible face whose plane holds the snapped
   * point. Any other snap keeps the plain pick, with the plane read from it.
   */
  private _facePickAt(snap: Snap | null, ray: Ray): FaceThroughPick | null {
    if (snapOnObjectBoundary(snap)) {
      return this._pickCache.faceThrough(
        this.wasmScene, ray, (object, instance) => this._isEligible(object, instance),
        this._activeInstance, [[snap.x, snap.y, snap.z]],
      )
    }
    const eligible = this._eligiblePickFor(ray)
    if (eligible === null) return null
    const normal = worldFaceNormal(this.wasmScene, eligible.object, eligible.face, this._activeInstance)
    if (normal === null) return null
    return { ...eligible, normal, point: snap !== null ? [snap.x, snap.y, snap.z] : [0, 0, 0] }
  }

  /**
   * Resolve the plane/target an IDLE gesture would anchor onto at `ray`
   * (design §1/§4): a top-level `pick_sketch` hit whose plane is non-ground
   * adopts that sketch (SKETCH MODE); otherwise the ground plane (PLANE
   * MODE, today's behavior). Only reachable when `_currentMode` has already
   * ruled out face mode (which takes priority), so no `_activeContext`
   * re-check is needed here.
   */
  private _resolveIdleTarget(ray: Ray): { plane: DrawPlane; target: SketchTarget } {
    return resolveIdleDrawTarget(this.wasmScene, this._sketchPickCache, ray, this._editContext)
  }

  /**
   * Resolve the plane/target the FIRST click of a gesture anchors onto
   * (design §5.2): an ACTIVE idle plane lock beats face pick and
   * sketch-hover adoption — the locked plane passes through `snap`'s point
   * (free/unconstrained, per `snapConstraint`'s idle-lock branch above), so
   * clicking a solid's corner starts a vertical sketch at that corner.
   * Falls back to `_resolveIdleTarget` (face/sketch/ground) when no lock is
   * active. Returns `null` only when a lock is active but there's no snap
   * point yet (nothing to click through).
   */
  private _resolveClickTarget(snap: Snap | null, ray: Ray): { plane: DrawPlane; target: SketchTarget } | null {
    const pinned = this.pin.clickTarget(this._editContext)
    if (pinned !== null) return pinned
    return resolveClickDrawTarget(
      this.wasmScene, this._sketchPickCache, this.idlePlaneLock, snap, ray, this._editContext,
    )
  }

  /** The cursor's position on `plane`. On the ground plane this is EXACTLY
   *  `[snap.x, snap.y, 0]` (no basis math, snap required) — the legacy fast
   *  path, bit-identical to before this module existed. On any other plane:
   *  the snap (already plane-constrained via `snapConstraint`) if present,
   *  else ray∩plane. */
  private _planeCursor(snap: Snap | null, ray: Ray, plane: DrawPlane): V3 | null {
    if (plane.ground) {
      if (snap === null) return null
      // Records whether the z about to be discarded was actually carrying
      // information — see `snapProjected`.
      this._snapProjected = snap.z !== 0
      return [snap.x, snap.y, 0]
    }
    this._snapProjected = false
    if (snap !== null) return [snap.x, snap.y, snap.z]
    return pointOnPlane(ray, plane)
  }

  /** See `Tool.snapProjected`. Set by `_planeCursor`, which is where the
   *  drawing plane's z actually replaces the snap's. */
  snapProjected(): boolean {
    return this._snapProjected
  }

  /** Whether the last `_planeCursor` discarded a non-zero snap z. */
  private _snapProjected = false

  /**
   * Decide which mode governs the NEXT pointer event (same contract as the
   * other draw tools):
   *   - Already anchored in one mode: stick with it (mid-gesture).
   *   - Inside an entered object context: always face mode (drawing stays
   *     scoped to that object — no top-level plane sketch from inside).
   *   - Otherwise idle at top level: face mode if an eligible Object face is
   *     under the cursor (via `pick_face`), else plane mode (which itself
   *     resolves sketch-vs-ground via `_resolveIdleTarget`).
   */
  private _currentMode(ray?: Ray, snap: Snap | null = null): 'face' | 'plane' {
    if (this.faceStage.kind === 'anchored') return 'face'
    if (this.planeStage.kind === 'anchored') return 'plane'
    // Inside an entered object context, drawing stays scoped to that
    // object's faces — a click elsewhere is ignored by the face handler
    // rather than falling through to a top-level plane sketch.
    if (this._activeContext !== null) return 'face'
    // An active idle plane lock or Shift pin beats face pick and
    // sketch-hover adoption (design §5.2) — the user already chose a plane.
    if (this.idlePlaneLock !== null || this.pin.current !== null) return 'plane'
    if (ray === undefined) return 'plane'
    return this._facePickAt(snap, ray) !== null ? 'face' : 'plane'
  }

  /**
   * Provide a constraint plane for snap so off-plane/occluded geometry is
   * excluded while snapping during face-mode or non-ground plane/sketch-mode
   * drawing.
   *
   * - Face mode, anchored: return the already-known face plane so subsequent
   *   snaps stay on that plane.
   * - Plane mode, anchored on a NON-ground plane (sketch mode): same —
   *   return the frozen plane. Ground-anchored: no constraint (today's
   *   behavior, unchanged).
   * - Idle: pick the hovered face (if an eligible one is under the cursor)
   *   and return its plane so the FIRST-click anchor lands precisely on the
   *   face, preventing the kernel from rejecting a non-planar rectangle;
   *   absent that, a top-level hover over a non-ground sketch returns ITS
   *   plane.
   * - Otherwise (ground mode): return null (unconstrained).
   */
  snapConstraint(ray: Ray): { constraintPlane?: { point: [number, number, number]; normal: [number, number, number] } } | null {
    if (this.faceStage.kind === 'anchored') {
      // Already anchored: lock to the established face plane
      return {
        constraintPlane: {
          point: this.faceStage.planePoint,
          normal: this.faceStage.normal,
        },
      }
    }

    if (this.planeStage.kind === 'anchored') {
      if (this.planeStage.plane.ground) return null
      return {
        constraintPlane: {
          point: this.planeStage.plane.origin,
          normal: this.planeStage.plane.normal,
        },
      }
    }

    // Idle plane lock (design §5.2): the first click is FREE — no
    // constraint plane. The locked plane is derived FROM that click
    // (`_resolveClickTarget`), so constraining the snap here would be
    // circular. A lock also beats face pick / sketch-hover adoption, so
    // neither of those runs below while one is active.
    if (this.idlePlaneLock !== null) return null

    // A Shift-pinned plane (planePin.ts) is a FIXED plane: the cursor is
    // held to it wherever it goes, so it constrains the snap outright.
    const pinned = this.pin.constraint()
    if (pinned !== null) return pinned

    const plane = this._idleHoverPlane(ray)
    if (!plane.ground) {
      return { constraintPlane: { point: plane.origin, normal: plane.normal } }
    }
    return null
  }

  /**
   * The plane an idle click at `ray` would land on — the hovered eligible
   * face's, a hovered non-ground sketch's, else the ground — as a
   * `DrawPlane`, and the plane a Shift press pins (`onPointerMove` records
   * it into `pin` with the hover point). Falls back to the ground plane
   * for a stale face (no world normal), matching `_currentMode`'s miss.
   */
  private _idleHoverPlane(ray: Ray, snap: Snap | null = null): DrawPlane {
    // Hovering an object's edge or corner: the plain ray pick misses there
    // (strict at the boundary), so the ranked boundary pick answers which
    // face the point belongs to — a Shift press over a wall's edge
    // midpoint pins that WALL, not the ground the miss fell through to.
    if (snapOnObjectBoundary(snap)) {
      const through = this._facePickAt(snap, ray)
      if (through !== null) {
        const drawPlane = drawPlaneThrough(through.point, through.normal)
        if (drawPlane !== null) return drawPlane
      }
    }
    const eligible = this._eligiblePickFor(ray)
    if (eligible !== null) {
      const plane = worldFacePlane(this.wasmScene, eligible.object, eligible.face, this._activeInstance)
      if (plane !== null) {
        const drawPlane = drawPlaneThrough(plane.point, plane.normal)
        if (drawPlane !== null) return drawPlane
      }
    }
    return this._resolveIdleTarget(ray).plane
  }

  /**
   * The drawing-plane cue the Viewport should render right now (design §6
   * bullet 1) — a grid patch on the active NON-ground plane, or null (ground
   * is covered by the world grid already). See `drawPlaneCue` in
   * `drawPlane.ts` for the two cases (anchored non-ground / idle-locked with
   * a tracked hover).
   */
  activeDrawPlaneCue(): { plane: DrawPlane; through: V3 } | null {
    if (this.faceStage.kind === 'anchored') {
      const basis = facePlaneBasis(this.faceStage.normal)
      if (basis === null) return null
      const anchoredPlane: DrawPlane = {
        origin: this.faceStage.planePoint,
        normal: this.faceStage.normal,
        u: basis.u,
        v: basis.v,
        ground: isGroundPlane(this.faceStage.planePoint, this.faceStage.normal),
      }
      return drawPlaneCue({
        anchoredPlane,
        anchoredThrough: this.faceStage.planePoint,
        idleLock: null,
        idleHover: null,
      })
    }
    if (this.planeStage.kind === 'anchored') {
      return drawPlaneCue({
        anchoredPlane: this.planeStage.plane,
        anchoredThrough: this.planeStage.anchor,
        idleLock: null,
        idleHover: null,
      })
    }
    const pinned = this.pin.current
    if (pinned !== null) {
      // The pinned plane through wherever the cursor is now (its foot on
      // the plane — the snap is constrained to it), so the patch follows
      // the hover exactly as the arrow-lock preview does.
      return drawPlaneCue({
        anchoredPlane: pinned.plane,
        anchoredThrough: this._lastIdleHoverPoint ?? pinned.through,
        idleLock: null,
        idleHover: null,
      })
    }
    return drawPlaneCue({
      anchoredPlane: null,
      anchoredThrough: null,
      idleLock: this.idlePlaneLock,
      idleHover: this._lastIdleHoverPoint,
      frame: getDrawingAxes(this.wasmScene),
    })
  }

  /**
   * Shift pressed/released while IDLE toggles the plane pin (planePin.ts;
   * GitHub issue 14 — "press Shift to lock the plane does nothing"): the
   * plane the last hover recorded becomes the drawing plane until Shift is
   * pressed again or Escape releases it. A pin displaces an arrow-key lock
   * (the two are different shapes of the same choice). Mid-gesture Shift
   * does nothing here — the rectangle's plane is frozen at its first click.
   */
  setShiftHeld(held: boolean): void {
    if (this.capturingInput()) {
      this.pin.markShift(held) // keep the autorepeat guard honest, never toggle
      return
    }
    if (this.pin.setShiftHeld(held)) {
      this.idlePlaneLock = null
      this._lastIdleHoverPoint = null
    }
  }

  /** Idle hover bookkeeping: the hover point for the plane cue (arrow lock
   *  and Shift pin previews both draw through it) and, for the pin, the
   *  plane the next click would land on (`_idleHoverPlane`). */
  private _trackIdleHover(snap: Snap | null, ray: Ray): void {
    if (snap === null) return
    const through: V3 = [snap.x, snap.y, snap.z]
    this._lastIdleHoverPoint = through
    if (this.idlePlaneLock === null) this.pin.trackHover(this._idleHoverPlane(ray, snap), through)
  }

  onPointerMove(snap: Snap | null, ray: Ray): void {
    if (this._currentMode(ray, snap) === 'face') {
      // Face mode
      if (this.faceStage.kind !== 'anchored') {
        this._trackIdleHover(snap, ray)
        this._clearPreview()
        // An open retype buffer owns the readout: the key router re-runs
        // this hover after every captured key, which must not wipe the
        // dimensions being typed.
        if (this.retypeTyped === '') this.onMeasurementCb('')
        return
      }
      const { anchor, normal } = this.faceStage
      const cursorOnPlane = this._faceCursor(snap, ray)
      if (cursorOnPlane === null) {
        this._clearPreview()
        this.onMeasurementCb('')
        return
      }
      this._lastFaceCursor = cursorOnPlane
      const corners = faceRectangleCorners(anchor, cursorOnPlane, normal)
      const extents = this._planeExtents(anchor, cursorOnPlane, normal)
      if (corners !== null && extents !== null) {
        this._drawRubberBandCorners(corners)
        this._reportMeasurement(extents[0], extents[1])
      } else {
        this._clearPreview()
        if (this.typed === '') this.onMeasurementCb('')
      }
    } else {
      // Plane mode
      if (this.planeStage.kind !== 'anchored') {
        this._trackIdleHover(snap, ray)
        this._clearPreview()
        if (this.retypeTyped === '') this.onMeasurementCb('') // see the face-mode note
        return
      }
      const { plane, anchor } = this.planeStage
      const cursor = this._planeCursor(snap, ray, plane)
      if (cursor === null) {
        this._clearPreview()
        this.onMeasurementCb('')
        return
      }
      this._lastPlaneCursor = cursor
      if (plane.ground) {
        // EXACT legacy ground fast path — no basis math.
        const corners = rectangleCorners([anchor[0], anchor[1]], [cursor[0], cursor[1]])
        this._drawRubberBandCorners(corners)
        this._reportMeasurement(Math.abs(cursor[0] - anchor[0]), Math.abs(cursor[1] - anchor[1]))
      } else {
        const corners = faceRectangleCorners(anchor, cursor, plane.normal)
        const extents = this._planeExtents(anchor, cursor, plane.normal)
        if (corners !== null && extents !== null) {
          this._drawRubberBandCorners(corners)
          this._reportMeasurement(extents[0], extents[1])
        } else {
          this._clearPreview()
          if (this.typed === '') this.onMeasurementCb('')
        }
      }
    }
  }

  onPointerDown(snap: Snap | null, ray: Ray): void {
    // Any pointer action ends the retype window — the next rectangle has
    // begun, and typed dimensions now belong to it.
    this.disarmRetype()
    if (this._currentMode(ray, snap) === 'face') {
      this._onPointerDownFace(snap, ray)
    } else {
      this._onPointerDownPlane(snap, ray)
    }
  }

  /**
   * Typed VCB entry is available once the first corner has been placed
   * (either plane or face mode) — see the Viewport key router, which
   * routes digit/letter/arrow keys here instead of tool-switch shortcuts
   * while this returns true.
   */
  capturingInput(): boolean {
    return this.planeStage.kind === 'anchored' || this.faceStage.kind === 'anchored'
  }

  /**
   * Per-key refinement of the capture (see Tool.capturesKey). An anchored
   * gesture keeps the whole keyboard, exactly as before. The IDLE retype
   * window (a rectangle just committed, `retypeHot` set) takes only what
   * its buffer needs: a digit always opens it — the SketchUp reflex is to
   * type the dimensions straight after the second click — and once
   * something is in the buffer, the rest of the dimension grammar (unit
   * letters, separators, Backspace, Enter) follows. With the buffer EMPTY
   * every letter keeps its global meaning, so `m`/`c`/`f`/`p` still switch
   * tools right after a rectangle, and Space still resets to Select.
   */
  capturesKey(key: string): boolean {
    if (this.capturingInput()) return true
    if (!this.retype.isOpen) return false
    return idleRetypeCapturesKey(key, this.retypeTyped, isDimsBufferKey)
  }

  /**
   * True while a gesture is anchored OR an idle plane lock is armed OR a
   * retype buffer is open — Escape has tool-local work to do (clear the
   * lock, drop the buffer, or step the gesture back) before a context-pop
   * is appropriate (component-edit-parity.md phase A2; see
   * `toolHasArmedGesture` in tools/types.ts). `capturingInput()` alone
   * misses the idle cases: locked-but-idle or typing-a-resize is not
   * "capturing input" but IS armed for Escape's purposes.
   */
  hasArmedGesture(): boolean {
    return this.capturingInput() || this.idlePlaneLock !== null || this.pin.current !== null || this.retypeTyped !== ''
  }

  /**
   * Quietly close the retype window — the Viewport calls this before an
   * explicit undo/redo/delete executes (`disarmActivePostCommitWindow`), so
   * a later Enter can never fire a wrong-action undo against a document the
   * user has since changed on purpose. Any pointer action, Escape, and
   * `cancel()` close it the same way.
   */
  disarmRetype(): void {
    this.retype.close()
    if (this.retypeTyped !== '') {
      this.retypeTyped = ''
      this.onMeasurementCb('')
    }
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      // Idle with a retype BUFFER open: Escape drops it and stops there
      // ("never mind, the rectangle stays as drawn") — the same "armed"
      // verdict `hasArmedGesture()` gives the Viewport, so the two agree on
      // which Escape the tool consumes. An open-but-untyped window is NOT
      // armed: it closes quietly and Escape goes on to its usual meaning
      // (plane lock, then the host's context pop), so a rectangle just
      // drawn never costs an extra Escape.
      if (!this.capturingInput() && this.retypeTyped !== '') {
        this.disarmRetype()
        return
      }
      if (!this.capturingInput()) this.disarmRetype()
      // Idle with an active plane lock: Escape clears the lock FIRST — only
      // a second Escape (already idle, unlocked) falls through to today's
      // idle-Escape behavior (design §5.2).
      if (!this.capturingInput() && (this.idlePlaneLock !== null || this.pin.current !== null)) {
        this.idlePlaneLock = null
        this.pin.clear()
        this._lastIdleHoverPoint = null
        return
      }
      // Aborting an in-progress gesture keeps the plane lock: the lock is
      // an idle aiming choice, cleared only by an idle Escape or toggle
      // (parity across all four draw tools — LineTool's _endChain path).
      const lock = this.idlePlaneLock
      const pinned = this.pin.current
      this.cancel()
      this.idlePlaneLock = lock
      this.pin.restore(pinned)
      return
    }

    if (!this.capturingInput()) {
      // Idle retype window (see `RetypeHot`): the keys `capturesKey` admits
      // edit the buffer; Enter resizes the just-committed rectangle.
      if (this.retype.isOpen && this.capturesKey(ev.key)) {
        if (ev.key === 'Enter') {
          const dims = parseDimensionsToMeters(this.retypeTyped)
          if (dims !== null) this._retypeCommit(dims[0], dims[1])
          return
        }
        this.retypeTyped = editDimsBuffer(this.retypeTyped, ev.key)
        this.onMeasurementCb(
          this.retypeTyped === '' ? '' : typedReadout(this.retypeTyped),
          this._dimensionAxes(),
        )
        return
      }
      // Idle plane lock via arrow keys (design §5.2) — consumed by neither
      // hover nor preview, only by the next first click.
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        this.idlePlaneLock = nextIdlePlaneLock(this.idlePlaneLock, ev.key)
        this.pin.clear() // an arrow lock displaces a Shift pin, and vice versa
        // A fresh/changed lock has no tracked hover yet (design §6 bullet 1).
        this._lastIdleHoverPoint = null
      }
      return
    }

    // Mid-gesture plane re-lock (design §2a): once the first corner is
    // placed, an arrow key still re-locks the plane — through that
    // ALREADY-PLACED anchor, not the cursor — since nothing has reached the
    // kernel yet (the rectangle commits only on the second click). Scoped to
    // plane mode: a face-anchored gesture is locked to a REAL face's plane,
    // which an arbitrary axis lock cannot honestly override without leaving
    // that face (out of scope here — see the module's face-mode doc).
    if (
      this.planeStage.kind === 'anchored' &&
      (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown')
    ) {
      const { anchor, natural } = this.planeStage
      const next = nextGestureLockPlane(
        this.idlePlaneLock, ev.key, anchor, natural, getDrawingAxes(this.wasmScene), this._editContext,
      )
      this.idlePlaneLock = next.lock
      this.planeStage = { kind: 'anchored', plane: next.plane, target: next.target, anchor, natural }
      this._lastPlaneCursor = null
      this._clearPreview()
      this.onMeasurementCb('')
      return
    }

    if (ev.key === 'Enter') {
      // Each component goes through the length grammar, so explicit units
      // work (and can be mixed) regardless of the display format —
      // "1cm,100mm", "5',23\"" — while bare numbers stay in display units.
      const dims = parseDimensionsToMeters(this.typed)
      if (dims !== null) {
        this._commitTyped(dims[0], dims[1])
      }
      return
    }

    // Feed digits, dot, separators, explicit-unit tokens, Backspace into
    // the buffer (editDimsBuffer applies the grammar rules).
    if (
      (ev.key >= '0' && ev.key <= '9') ||
      ev.key === '.' ||
      ev.key === ',' ||
      ev.key === 'x' ||
      ev.key === 'X' ||
      ev.key === ' ' ||
      ev.key === 'Backspace' ||
      ev.key === "'" ||
      ev.key === '"' ||
      ev.key === '/' ||
      ev.key === '-' ||
      /^[mckftinMCKFTIN]$/.test(ev.key)
    ) {
      this.typed = editDimsBuffer(this.typed, ev.key)
      this.onMeasurementCb(typedReadout(this.typed), this._dimensionAxes())
    }
  }

  cancel(): void {
    this.planeStage = { kind: 'idle' }
    this.faceStage = { kind: 'idle' }
    this.typed = ''
    this.retype.close()
    this.retypeTyped = ''
    this._lastPlaneCursor = null
    this._lastFaceCursor = null
    this.idlePlaneLock = null
    this.pin.clear()
    this._lastIdleHoverPoint = null
    this._clearPreview()
    this.onMeasurementCb('')
  }

  /**
   * A new/loaded document replaced the Scene, so every cached plane-mode
   * sketch handle is now stale (reusing one throws UnknownSketch). Drop them
   * all and reset. Called by the Viewport from `notifyLoaded`.
   */
  onDocumentReset(): void {
    this.sketchCache.clear()
    this.cancel()
  }

  /**
   * The two dimensions of a rubber band, in the order `_commitTyped` applies
   * a typed `W,D` pair: the extent along the plane basis's `u` first, then
   * along its `v`.
   *
   * Deliberately NOT derived from the spacing of the four preview corners.
   * `faceRectangleCorners` swaps corners B and D when the drag's two signed
   * extents have opposite signs (to keep the winding CCW from +normal), so
   * corner spacing reports the pair the other way round for half of all
   * drags — while `_commitTyped` always applies the first typed number along
   * `u`. Reading the extents off the basis is what keeps the readout and the
   * commit talking about the same two numbers.
   */
  private _planeExtents(anchor: V3, cursor: V3, normal: V3): [number, number] | null {
    const basis = facePlaneBasis(normal)
    if (basis === null) return null
    const { u, v } = basis
    const dx = cursor[0] - anchor[0]
    const dy = cursor[1] - anchor[1]
    const dz = cursor[2] - anchor[2]
    return [
      Math.abs(dx * u[0] + dy * u[1] + dz * u[2]),
      Math.abs(dx * v[0] + dy * v[1] + dz * v[2]),
    ]
  }

  /**
   * The world directions the two typed dimensions run along, in the order
   * `_commitTyped` applies them. Dispatches exactly as the commit does, so
   * the dots in the Measurements box can never name a direction the commit
   * would not use:
   *
   *  - an anchored plane stage — world X/Y on the ground fast path, which is
   *    hardcoded there and deliberately frame-blind, else the plane normal's
   *    basis;
   *  - an anchored face stage — the face normal's basis;
   *  - the post-commit retype window — the same `RetypeSpec` fork
   *    `_retypeCorners` reads.
   *
   * Re-derived from the normal rather than read off `DrawPlane`'s own u/v, so
   * a future `DrawPlane` constructor cannot silently make the two disagree.
   */
  private _dimensionDirections(): [V3, V3] | null {
    if (this.planeStage.kind === 'anchored') {
      const { plane } = this.planeStage
      if (plane.ground) return [[1, 0, 0], [0, 1, 0]]
      const basis = facePlaneBasis(plane.normal)
      return basis === null ? null : [basis.u, basis.v]
    }
    if (this.faceStage.kind === 'anchored') {
      const basis = facePlaneBasis(this.faceStage.normal)
      return basis === null ? null : [basis.u, basis.v]
    }
    const spec = this.retype.spec
    if (spec !== null) {
      if (spec.mode === 'plane' && spec.plane.ground) return [[1, 0, 0], [0, 1, 0]]
      const basis = facePlaneBasis(spec.mode === 'plane' ? spec.plane.normal : spec.normal)
      return basis === null ? null : [basis.u, basis.v]
    }
    return null
  }

  /**
   * The axis each typed dimension reads as, for the Measurements box's dots.
   *
   * Always two entries once anything is anchored — `[null, null]` on an
   * oblique plane rather than an empty list, so the box never changes width.
   * Since `measurementAxisFor` is polarity-blind, this depends only on the
   * plane, which means it is right from the anchoring click, unchanged by
   * cursor movement, and still right while a typed buffer has left the
   * rubber-band corners behind.
   *
   * On a MOVED drawing-axes frame a ground rectangle reports `[null, null]`:
   * its two dimensions really are world X and Y (the ground fast path is
   * frame-blind by design, to keep ground coordinates bit-identical), so
   * neither runs along the frame's red or green, and saying otherwise would
   * be the exact lie these dots exist to prevent.
   */
  private _dimensionAxes(): MeasurementAxes | undefined {
    const dirs = this._dimensionDirections()
    if (dirs === null) return undefined
    const frame = getDrawingAxes(this.wasmScene)
    return [measurementAxisFor(dirs[0], frame), measurementAxisFor(dirs[1], frame)]
  }

  /** Report the live W × D measurement. */
  private _reportMeasurement(width: number, depth: number): void {
    const axes = this._dimensionAxes()
    if (this.typed !== '') {
      this.onMeasurementCb(typedReadout(this.typed), axes)
      return
    }
    this.onMeasurementCb(`${formatLength(width)} × ${formatLength(depth)}`, axes)
  }

  /**
   * Commit an exact width × depth rectangle from the typed VCB buffer, using
   * the current rubber-band cursor side (or +,+ default) to pick the growth
   * direction along each axis. Dispatches to plane or face mode depending
   * on which stage is anchored.
   */
  private _commitTyped(w: number, d: number): void {
    if (this.planeStage.kind === 'anchored') {
      const { plane, target, anchor } = this.planeStage
      // Sign of growth along each axis follows the last rubber-band cursor
      // position (so typing matches the direction the user was dragging);
      // default +,+ if the cursor hasn't moved yet.
      const cursor = this._lastPlaneCursor ?? anchor

      let corners: [V3, V3, V3, V3]
      if (plane.ground) {
        // EXACT legacy ground fast path — no basis math.
        const signX = cursor[0] - anchor[0] < 0 ? -1 : 1
        const signY = cursor[1] - anchor[1] < 0 ? -1 : 1
        const farCorner: [number, number] = [anchor[0] + signX * w, anchor[1] + signY * d]
        corners = rectangleCorners([anchor[0], anchor[1]], farCorner)
      } else {
        const basis = facePlaneBasis(plane.normal)
        if (basis === null) {
          this.cancel()
          return
        }
        const { u, v } = basis
        const dx = cursor[0] - anchor[0]
        const dy = cursor[1] - anchor[1]
        const dz = cursor[2] - anchor[2]
        const du = dx * u[0] + dy * u[1] + dz * u[2]
        const dv = dx * v[0] + dy * v[1] + dz * v[2]
        const signU = du < 0 ? -1 : 1
        const signV = dv < 0 ? -1 : 1

        const b: V3 = [anchor[0] + u[0] * signU * w, anchor[1] + u[1] * signU * w, anchor[2] + u[2] * signU * w]
        const c: V3 = [b[0] + v[0] * signV * d, b[1] + v[1] * signV * d, b[2] + v[2] * signV * d]
        const dd: V3 = [anchor[0] + v[0] * signV * d, anchor[1] + v[1] * signV * d, anchor[2] + v[2] * signV * d]
        corners = [anchor, b, c, dd]
      }

      this.planeStage = { kind: 'idle' }
      this.typed = ''
      this._lastPlaneCursor = null
      this._clearPreview()
      this.onMeasurementCb('')
      if (this._commitPlaneRectangle(target, corners)) {
        this._armRetype({ mode: 'plane', plane, target, anchor, far: corners[2] })
      }
    } else if (this.faceStage.kind === 'anchored') {
      const { object, face, normal, anchor } = this.faceStage
      const basis = facePlaneBasis(normal)
      if (basis === null) {
        this.cancel()
        return
      }
      const { u, v } = basis
      const cursor = this._lastFaceCursor ?? anchor
      const dx = cursor[0] - anchor[0]
      const dy = cursor[1] - anchor[1]
      const dz = cursor[2] - anchor[2]
      const du = dx * u[0] + dy * u[1] + dz * u[2]
      const dv = dx * v[0] + dy * v[1] + dz * v[2]
      const signU = du < 0 ? -1 : 1
      const signV = dv < 0 ? -1 : 1

      const b: V3 = [anchor[0] + u[0] * signU * w, anchor[1] + u[1] * signU * w, anchor[2] + u[2] * signU * w]
      const c: V3 = [b[0] + v[0] * signV * d, b[1] + v[1] * signV * d, b[2] + v[2] * signV * d]
      const dd: V3 = [anchor[0] + v[0] * signV * d, anchor[1] + v[1] * signV * d, anchor[2] + v[2] * signV * d]
      const corners: [V3, V3, V3, V3] = [anchor, b, c, dd]

      this.faceStage = { kind: 'idle' }
      this.typed = ''
      this._lastFaceCursor = null
      this._clearPreview()
      this.onMeasurementCb('')
      if (this._commitFaceCorners(object, face, corners)) {
        this._armRetype({ mode: 'face', object, face, normal, anchor, far: corners[2] })
      }
    }
  }

  /** Open the retype window on a rectangle that just committed successfully. */
  private _armRetype(spec: RetypeSpec): void {
    this.retypeTyped = ''
    this.retype.arm(spec)
  }

  /**
   * The corners a retype of the hot rectangle to `w × d` produces: the same
   * anchor, each dimension growing the way the committed rectangle did
   * (the sign of `far − anchor` along each plane axis), built by the very
   * helper a second click uses, so a retyped rectangle is indistinguishable
   * from one clicked at that far corner. Null for a degenerate size.
   */
  private _retypeCorners(hot: RetypeSpec, w: number, d: number): [V3, V3, V3, V3] | null {
    const { anchor, far } = hot
    if (hot.mode === 'plane' && hot.plane.ground) {
      const signX = far[0] - anchor[0] < 0 ? -1 : 1
      const signY = far[1] - anchor[1] < 0 ? -1 : 1
      if (w < RECTANGLE_MIN_SIDE || d < RECTANGLE_MIN_SIDE) return null
      return rectangleCorners([anchor[0], anchor[1]], [anchor[0] + signX * w, anchor[1] + signY * d])
    }
    const normal = hot.mode === 'plane' ? hot.plane.normal : hot.normal
    const basis = facePlaneBasis(normal)
    if (basis === null) return null
    const { u, v } = basis
    const dx = far[0] - anchor[0]
    const dy = far[1] - anchor[1]
    const dz = far[2] - anchor[2]
    const signU = dx * u[0] + dy * u[1] + dz * u[2] < 0 ? -1 : 1
    const signV = dx * v[0] + dy * v[1] + dz * v[2] < 0 ? -1 : 1
    const newFar: V3 = [
      anchor[0] + u[0] * signU * w + v[0] * signV * d,
      anchor[1] + u[1] * signU * w + v[1] * signV * d,
      anchor[2] + u[2] * signU * w + v[2] * signV * d,
    ]
    return faceRectangleCorners(anchor, newFar, normal)
  }

  /**
   * Resize the just-committed rectangle to the typed `w × d` through the
   * shared window (retypeWindow.ts): one guarded scene undo, then the same
   * commit path with corners rebuilt at the new far corner — ONE undo step
   * for the final rectangle, as if it had been drawn that size. The window
   * stays open afterwards so another size can be typed.
   */
  private _retypeCommit(w: number, d: number): void {
    const spec = this.retype.spec
    this.retypeTyped = ''
    this.onMeasurementCb('')
    if (spec === null) return
    const corners = this._retypeCorners(spec, w, d)
    if (corners === null) return
    const outcome = this.retype.apply(
      (hot) => this._commitHot(hot, corners),
      (hot) => {
        const original = this._retypeCorners(hot, ...this._retypeDims(hot))
        return original !== null && this._commitHot(hot, original)
      },
      (hot) => ({ ...hot, far: corners[2] }),
    )
    if (outcome === 'stale') this.onToast(retypeStaleMessage('rectangle'))
  }

  /** Lay `corners` down through the hot record's own commit path. */
  private _commitHot(hot: RetypeSpec, corners: [V3, V3, V3, V3]): boolean {
    return hot.mode === 'plane'
      ? this._commitPlaneRectangle(hot.target, corners)
      : this._commitFaceCorners(hot.object, hot.face, corners)
  }

  /** The committed rectangle's own `w × d` (from anchor → far), for
   *  redrawing it as-was after a refused retype. */
  private _retypeDims(hot: RetypeSpec): [number, number] {
    const { anchor, far } = hot
    if (hot.mode === 'plane' && hot.plane.ground) {
      return [Math.abs(far[0] - anchor[0]), Math.abs(far[1] - anchor[1])]
    }
    const normal = hot.mode === 'plane' ? hot.plane.normal : hot.normal
    const basis = facePlaneBasis(normal)
    if (basis === null) return [0, 0]
    const dx = far[0] - anchor[0]
    const dy = far[1] - anchor[1]
    const dz = far[2] - anchor[2]
    return [
      Math.abs(dx * basis.u[0] + dy * basis.u[1] + dz * basis.u[2]),
      Math.abs(dx * basis.v[0] + dy * basis.v[1] + dz * basis.v[2]),
    ]
  }

  // ------------------------------------------------------------------ plane mode

  private _onPointerDownPlane(snap: Snap | null, ray: Ray): void {
    if (this.planeStage.kind === 'idle') {
      // First click: resolve (and freeze) the plane/target, then anchor.
      const resolved = this._resolveClickTarget(snap, ray)
      if (resolved === null) return
      const { plane, target } = resolved
      const anchor = this._planeCursor(snap, ray, plane)
      if (anchor === null) return
      // What a mid-gesture arrow-key lock reverts to when toggled back off
      // (design §2a). No lock active for THIS click: `resolved` already IS
      // the unlocked (sketch-hover-or-ground) resolution — reuse it at zero
      // extra cost. A lock WAS active: its branch never probes sketch-hover
      // ("an active lock beats face pick and sketch-hover adoption" means
      // the probe itself never runs — design §5.2), so there is no hover
      // result to remember; fall back to ground rather than reopen that
      // probe here.
      // A Shift pin's first click resolves to the pinned plane itself,
      // which is exactly what a later arrow-lock release should revert to.
      const natural = this.idlePlaneLock !== null
        ? groundNaturalTarget(this._editContext, anchor)
        : resolved
      this.planeStage = { kind: 'anchored', plane, target, anchor, natural }
      this._lastPlaneCursor = null
    } else {
      // Second click: commit the rectangle.
      const { plane, target, anchor } = this.planeStage
      const cursor = this._planeCursor(snap, ray, plane)
      if (cursor === null) return

      if (plane.ground) {
        // Skip degenerate rectangles (same point, or zero area).
        //
        // PER-AXIS on purpose, and deliberately NOT harmonised with the
        // kernel's `tol::POINT_MERGE` (1e-9). This is not asking "are these
        // two points the same?" the way a segment gate does — a rectangle
        // whose corners are far apart in x but coincident in y has two
        // distinct corners and no area at all, so an axis that collapses is
        // what makes it degenerate. The bound is also an order of magnitude
        // STRICTER than POINT_MERGE, which is the safe direction: the tool
        // refuses a sliver the kernel would have accepted, and there is no
        // width where the tool commits a rectangle whose corners the kernel
        // then merges. Loosening this toward POINT_MERGE would open exactly
        // that window.
        if (
          Math.abs(anchor[0] - cursor[0]) < RECTANGLE_MIN_SIDE ||
          Math.abs(anchor[1] - cursor[1]) < RECTANGLE_MIN_SIDE
        ) {
          return
        }
        this.planeStage = { kind: 'idle' }
        this.typed = ''
        this._lastPlaneCursor = null
        this._clearPreview()
        this.onMeasurementCb('')
        const corners = rectangleCorners([anchor[0], anchor[1]], [cursor[0], cursor[1]])
        if (this._commitPlaneRectangle(target, corners)) {
          this._armRetype({ mode: 'plane', plane, target, anchor, far: corners[2] })
        }
      } else {
        const corners = faceRectangleCorners(anchor, cursor, plane.normal)
        if (corners === null) return // degenerate — ignore
        this.planeStage = { kind: 'idle' }
        this.typed = ''
        this._lastPlaneCursor = null
        this._clearPreview()
        this.onMeasurementCb('')
        if (this._commitPlaneRectangle(target, corners)) {
          this._armRetype({ mode: 'plane', plane, target, anchor, far: corners[2] })
        }
      }
    }
  }

  /** Commit a rectangle loop (four `sketch_add_segment` calls) into
   *  `target`'s sketch — used by both ground and non-ground plane/sketch
   *  mode (real face mode instead imprints via `split_face_inner`, see
   *  `_commitFaceCorners`). */
  private _commitPlaneRectangle(target: SketchTarget, corners: [V3, V3, V3, V3]): boolean {
    try {
      runSketchGesture(this.wasmScene, this.sketchCache, target, (sketch, toLocal) => {
        // Four edges: 0→1, 1→2, 2→3, 3→0
        const edges = [
          [corners[0], corners[1]],
          [corners[1], corners[2]],
          [corners[2], corners[3]],
          [corners[3], corners[0]],
        ] as const

        let lastRegionsCreated: bigint[] = []
        for (const [p0, q0] of edges) {
          // `toLocal`: identity for a world target, pose⁻¹ for a definition-
          // owned one (component-edit-parity.md phase A2) — see
          // `runSketchGesture`'s doc.
          const p = toLocal(p0)
          const q = toLocal(q0)
          const report = this.wasmScene.sketch_add_segment(
            sketch,
            p[0], p[1], p[2],
            q[0], q[1], q[2],
          )
          try {
            const rc = report.regions_created()
            lastRegionsCreated = Array.from(rc)
          } finally {
            report.free()
          }
        }

        this.onCommit({ sketchHandle: sketch, regionsCreated: lastRegionsCreated })
      })
      return true
    } catch (err) {
      const code = parseKernelErrorCode(err)
      const rawMsg = err instanceof Error ? err.message : String(err)
      const message = kernelErrorMessage(code ?? 'Unknown', rawMsg)
      this.onToast(message, code ?? undefined)
      return false
    }
  }

  // ------------------------------------------------------------------ face mode

  private _onPointerDownFace(snap: Snap | null, ray: Ray): void {
    if (this.faceStage.kind === 'idle') {
      // First click: anchor on the eligible face under the cursor
      if (snap === null) return

      const eligible = this._facePickAt(snap, ray)
      if (eligible === null) return

      const { normal } = eligible
      const anchor: V3 = [snap.x, snap.y, snap.z]

      this.faceStage = {
        kind: 'anchored',
        object: eligible.object,
        face: eligible.face,
        normal,
        planePoint: anchor,
        anchor,
      }
      this._lastFaceCursor = null
    } else {
      // Second click: commit the face imprint
      const { object, face, normal, anchor } = this.faceStage

      const cursorOnPlane = this._faceCursor(snap, ray)
      if (cursorOnPlane === null) return

      const corners = faceRectangleCorners(anchor, cursorOnPlane, normal)
      if (corners === null) return // degenerate — ignore

      this.faceStage = { kind: 'idle' }
      this.typed = ''
      this._lastFaceCursor = null
      this._clearPreview()
      this.onMeasurementCb('')

      if (this._commitFaceCorners(object, face, corners)) {
        this._armRetype({ mode: 'face', object, face, normal, anchor, far: corners[2] })
      }
    }
  }

  /**
   * The cursor's position on the anchored face plane: the SNAPPED point when
   * one is available — `snapConstraint` already holds every face-mode snap
   * to this plane, so an `Endpoint`/`Midpoint`/`On Edge` chip is honoured
   * exactly, the opposite corner landing ON the snapped corner rather than
   * a sub-pixel off it — else the raw ray∩plane intersection (nothing
   * snapped: past the face's extent, or no kernel candidate). A snap that
   * somehow sits off the plane (never, by the constraint's construction —
   * a defensive check only) falls back to the ray too, so the imprint can
   * never be handed an off-plane corner. Before this, the rubber band and
   * the commit both used ray∩plane unconditionally while the chip claimed
   * a snap the rectangle did not take.
   */
  private _faceCursor(snap: Snap | null, ray: Ray): V3 | null {
    if (this.faceStage.kind !== 'anchored') return null
    const { planePoint, normal } = this.faceStage
    if (snap !== null) {
      const p: V3 = [snap.x, snap.y, snap.z]
      if (Math.abs(distanceOffPlane(p, planePoint, normal)) <= FACE_PLANE_EPS_M) return p
    }
    return rayPlaneIntersect(ray.origin, ray.direction, planePoint, normal)
  }

  /** Split the given face with a rectangle loop defined by 4 explicit world-space
   *  corners. True when the kernel accepted it (false = refused, toasted). */
  private _commitFaceCorners(object: bigint, face: bigint, corners: [V3, V3, V3, V3]): boolean {
    // Flatten the 4 corners into a Float64Array of xyz triples
    const loopPts = new Float64Array(4 * 3)
    for (let i = 0; i < 4; i++) {
      loopPts[i * 3 + 0] = corners[i][0]
      loopPts[i * 3 + 1] = corners[i][1]
      loopPts[i * 3 + 2] = corners[i][2]
    }

    try {
      // Inside a component instance's editing context (component-edit-
      // parity.md phase A2), `object` is a definition member — the world
      // `split_face_inner` refuses it (`is_world` guard);
      // `split_face_inner_in_instance` maps the loop through the instance's
      // pose⁻¹ and routes through `apply_def_op` instead.
      if (this._activeInstance !== null) {
        this.wasmScene.split_face_inner_in_instance(this._activeInstance, object, face, loopPts)
      } else {
        this.wasmScene.split_face_inner(object, face, loopPts)
      }
      this.onFaceImprint(object)
      return true
    } catch (err) {
      const code = parseKernelErrorCode(err)
      const rawMsg = err instanceof Error ? err.message : String(err)
      const message = kernelErrorMessage(code ?? 'Unknown', rawMsg)
      this.onToast(message, code ?? undefined)
      return false
    }
  }

  // ------------------------------------------------------------------ preview

  /**
   * Emit a LineSegments preview for a closed 4-corner loop. Corners are used
   * exactly as given — the preview's depth bias (PREVIEW_LINE_STYLE,
   * depthPolicy.ts) settles coincidence with the ground/committed lines, so
   * no z-lift.
   *
   * @param corners  Four world-space xyz corners in order.
   */
  private _drawRubberBandCorners(corners: readonly [V3, V3, V3, V3]): void {
    this._clearPreview()
    const [c0, c1, c2, c3] = corners
    const pts = new Float32Array([
      ...c0, ...c1,
      ...c1, ...c2,
      ...c2, ...c3,
      ...c3, ...c0,
    ])
    this.preview.add(makeFatSegments(pts, PREVIEW_LINE_STYLE))
  }

  private _clearPreview(): void {
    this.preview.traverse((child) => {
      disposeFatSegments(child)
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose()
        if (child.material instanceof THREE.Material) {
          child.material.dispose()
        }
      }
    })
    this.preview.clear()
  }
}
