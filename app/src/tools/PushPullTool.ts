/**
 * PushPullTool — hover-highlight + drag to extrude/push-pull.
 *
 * Gesture (two-click mode):
 *   1. Hover: snap() → highlight face when on-face snap with element
 *   2. First click: enter drag mode, record anchor point + normal axis
 *   3. Move: project ray onto normal axis from anchor → ghost preview height
 *   4. Second click: commit extrude_region or push_pull
 *   5. Esc: cancel
 *
 * Calls onCommit after each successful commit.
 * Throws kernel "CODE: message" errors as toasts via onToast.
 */

import * as THREE from 'three'
import type { Tool, Snap, EditContext, SnapConstraint } from './types'
import { editContextEq } from './types'
import type { Ray } from '../viewport/math'
import type { Scene as WasmScene } from '../wasm/loader'
import { projectRayOntoAxis, applyAffine3x4, transformNormalThroughPose } from '../viewport/geoHelpers'
import { parseKernelErrorCode, kernelErrorMessage } from '../kernelErrors'
import { editLengthBuffer, isLengthInputKey } from './moveInput'
import { formatLength, parseLengthToMeters, getLengthUnit, typedReadout } from '../settings/units'
import { buildSweptPrismPreview, clearPreview } from './transformPreview'
import { defaultFaceEligible, worldFaceNormal, FacePickCache, type FaceEligible } from './faceDraw'

/** Snap kinds whose point is a deliberate depth reference for push/pull — the
 * cursor was parked on a real feature. `on-face` is excluded on purpose: it
 * fires continuously during a drag and would hijack the free-drag depth. */
const HARD_SNAP_KINDS = new Set([
  'endpoint',
  'center',
  'quadrant',
  'tangent',
  'midpoint',
  'intersection',
  'on-edge',
  'on-guide',
  'on-axis',
])

/**
 * Minimum inward (negative) live-drag distance, in meters, that counts as a
 * deliberate "push inward" when committing a typed push/pull. A real inward
 * drag moves the cursor by many pixels — millimeters or more of world
 * distance — so this sits far below any intentional pull yet far above the
 * ~1e-15 m floating-point wobble a still cursor picks up from the camera
 * projection. Its sole job is to stop that wobble from flipping the extrude
 * direction when the user typed a distance without dragging (see
 * `_commitFromTyped`).
 */
const MIN_INWARD_DRAG_M = 1e-9

export type PushPullTarget =
  | {
      kind: 'region'
      sketchHandle: bigint
      regionHandle: bigint
      normal: [number, number, number]
      /** The instance to extrude THROUGH (component-edit-parity.md phase
       *  A2) — set when the region's sketch is a member of the entered
       *  instance's definition, else null (a world sketch, extruded via the
       *  plain `extrude_region`). Doubles as the ghost preview's pose source
       *  (`_drawGhostPreview`): `region_boundary` answers in DEFINITION-local
       *  coordinates for a def-owned sketch, so the swept-prism ghost maps
       *  it through this instance's pose before drawing. */
      instance: bigint | null
    }
  | {
      kind: 'face'
      objectHandle: bigint
      faceHandle: bigint
      normal: [number, number, number]
      /** The instance the face was picked THROUGH (component-edit-parity.md
       *  phase A2) — null for a plain world object. `face_boundary` answers
       *  in the object's own LOCAL (definition) frame for a component
       *  member, exactly like `region_boundary` above, so the ghost preview
       *  maps it through this same pose. */
      instance: bigint | null
    }

export type OnPushPullCommit = (objectId: bigint) => void
export type OnToast = (message: string, code?: string) => void
export type OnMeasurement = (text: string) => void
export type OnExtrudeAsNewModeChange = (on: boolean) => void

type Stage =
  | { kind: 'idle' }
  | {
      kind: 'dragging'
      target: PushPullTarget
      anchor: [number, number, number]
      /** Last computed signed distance */
      distance: number
    }

export class PushPullTool implements Tool {
  readonly name = 'Push/Pull'

  /** Live status-bar guidance for the current stage (see Tool.statusHint). */
  statusHint(): string {
    if (this.stage.kind === 'idle') {
      const base = 'Click a face to push or pull it — double-click repeats the last distance.'
      return this.extrudeAsNewMode ? `${base} Ctrl is on — extrudes a new object.` : base
    }
    return this.extrudeAsNewMode
      ? 'Move to extrude a NEW object, click to commit — or type an exact distance. Tap Ctrl to push/pull instead.'
      : 'Move to extrude, click to commit — or type an exact distance. Tap Ctrl to extrude a new object instead.'
  }

  private stage: Stage = { kind: 'idle' }
  private preview: THREE.Group
  private wasmScene: WasmScene
  private onCommit: OnPushPullCommit
  private onToast: OnToast
  private onMeasurementCb: OnMeasurement

  /** VCB buffer — raw string being typed by the user */
  private typed: string = ''

  /** The snap last seen on hover (for highlight logic) */
  lastSnap: Snap | null = null

  /** Per-pointer-event `pick_face` memo for `snapConstraint`'s idle hover —
   *  see `FacePickCache` in faceDraw.ts (same pattern as the draw tools). */
  private readonly _pickCache = new FacePickCache()

  /**
   * Last successfully committed signed distance (meters, along the face
   * normal — negative recesses), session-lived on this tool instance:
   * double-click repeats it on whatever face/region is clicked next. `null`
   * until the first commit this activation; a fresh `PushPullTool` (every
   * tool switch mints one — see Viewport's `makePushPullTool`) starts with
   * no repeat armed, matching SketchUp's per-activation memory.
   */
  private lastCommittedDistance: number | null = null

  /**
   * Durable per-gesture toggle (tap Ctrl/Cmd to flip — the Move-copy idiom:
   * `MoveTool.ts` reads Alt the same way in `onKey`, not a live per-click
   * modifier read like Paint's whole-object fill in `Viewport.tsx`). A live
   * read doesn't fit here: Push/Pull is a click-drag-click gesture, and the
   * modifier must survive released keys through the whole drag exactly like
   * Move's copy toggle, not just whatever was held at one instant. While
   * on, a solid-face commit routes through `extrude_face_as_new_object`
   * (a NEW coincident object, source untouched) instead of `push_pull`.
   */
  private extrudeAsNewMode: boolean = false
  private onExtrudeAsNewModeChange: OnExtrudeAsNewModeChange

  constructor(
    wasmScene: WasmScene,
    previewGroup: THREE.Group,
    onCommit: OnPushPullCommit,
    onToast: OnToast,
    onMeasurement: OnMeasurement = () => { /* no-op */ },
    onExtrudeAsNewModeChange: OnExtrudeAsNewModeChange = () => { /* no-op */ },
  ) {
    this.wasmScene = wasmScene
    this.preview = previewGroup
    this.onCommit = onCommit
    this.onToast = onToast
    this.onMeasurementCb = onMeasurement
    this.onExtrudeAsNewModeChange = onExtrudeAsNewModeChange
  }

  // ── Optional Tool interface extensions ─────────────────────────────────────

  capturingInput(): boolean {
    return this.stage.kind === 'dragging'
  }

  /**
   * Double-click repeats `lastCommittedDistance` on the clicked face/region
   * (SketchUp parity), honoring the same validity refusals as any other
   * commit (`_commit` already toasts a kernel refusal). The gesture's FIRST
   * click ran through the normal `onPointerDown` and picked/validated a
   * target into `this.stage` — the Viewport skips routing the second,
   * phantom pointerdown once a tool implements `onDoubleClick` (see the
   * Tool interface doc) — so this reuses that already-validated target
   * rather than re-picking. Always resets the phantom drag click one
   * started, so it never lingers as a stray in-progress gesture regardless
   * of the outcome.
   *
   * Returns `false` — falling through to the Viewport's default "enter
   * context" gesture, exactly PushPullTool's behavior before this method
   * existed — when there is nothing to repeat: no target was picked (an
   * ineligible-face click already toasted and stayed idle), or nothing has
   * been committed yet this tool activation. Once a repeat IS attempted,
   * returns `true` unconditionally (even on a refused commit) — a
   * double-click is a deliberate repeat attempt, not a fallback-worthy miss.
   */
  onDoubleClick(_snap: Snap | null, _ray: Ray): boolean {
    const stage = this.stage
    this.stage = { kind: 'idle' }
    this.typed = ''
    clearPreview(this.preview)
    this.onMeasurementCb('')

    if (stage.kind !== 'dragging' || this.lastCommittedDistance === null) {
      return false
    }
    this._commit(stage.target, this.lastCommittedDistance)
    return true
  }

  /**
   * Idle hover only (design v1.1 Lane E "Push/Pull face-first"): constrain
   * the next snap query to the plane of the face/region under the cursor,
   * restricted to its `on-face` point (`facesOnly`). Without this,
   * inference's hard total rank order (`crates/inference` `rank_group`,
   * pinned by `inference_specs.rs:2569`) means a hover a few pixels from a
   * box corner resolves — and a drag from there would push/pull from —
   * that corner's `endpoint` chip instead of the face itself, since
   * `on-face` can never outrank a precise point kind. `SnapService.resolve`
   * honors `facesOnly` by replacing any non-`on-face` winner with the
   * `constraintPlane` ray intersection (kind `'plane'`), so the hover cue
   * is always the on-face dot under the cursor on the face that will
   * actually be pushed — no endpoint/midpoint/edge chip ever wins the pick.
   *
   * Mirrors `onPointerDown`'s two paths exactly, read-only — including its
   * FAIL-CLOSED rule: an INELIGIBLE face (grouped/instanced, hit but
   * rejected by `_isEligible`) offers no constraint at all, the same way
   * `onPointerDown` consumes that click with a toast rather than falling
   * through to Path B. Without this, a hover over a group's face would let
   * a sketch region BEHIND the group become the constraint plane, so the
   * hover cue would land on the ground plane through the solid instead of
   * showing nothing — a hover-time lie about what a click would do. Path A
   * (`pick_face` + the shared eligibility policy, memoized per ray via
   * `FacePickCache` like the draw tools) runs first; Path B
   * (`pick_sketch_region`, instance-scoped the same way, also memoized per
   * ray) only runs when Path A found NO face at all (`rawPickFor` null) —
   * never when it found one and rejected it. `null` — no constraint — once
   * a drag has anchored (`this.stage.kind !== 'idle'`): the drag itself
   * must keep `HARD_SNAP_KINDS` working unconstrained ("pull to that
   * edge"), and the anchor is already fixed by then regardless.
   */
  snapConstraint(ray?: Ray): SnapConstraint | null {
    if (this.stage.kind !== 'idle' || ray === undefined) return null

    // Path A: the same eligible-face pick `onPointerDown` would commit to.
    const eligible = this._pickCache.pickFor(this.wasmScene, ray, (object, instance) =>
      this._isEligible(object, instance))
    if (eligible !== null) {
      const a = this.wasmScene.face_plane(eligible.object, eligible.face)
      return {
        constraintPlane: { point: [a[0], a[1], a[2]], normal: [a[3], a[4], a[5]] },
        facesOnly: true,
      }
    }
    // A face WAS hit but rejected by eligibility — fail closed exactly like
    // onPointerDown's ineligible branch (toast, click consumed): no
    // constraint, never Path B's sketch-region fallback behind it.
    if (this._pickCache.rawPickFor(ray) !== null) return null

    // Path B: a hovered sketch region's own plane, exactly as `onPointerDown`
    // scopes it — top-level (or the entered instance's own def-owned
    // sketches) only, never inside an OBJECT editing context. Only reached
    // when Path A found no face under the cursor at all.
    if (this._activeContext !== null) return null
    const activeInstance = this._activeInstance
    const region = this._pickRegionFor(ray, activeInstance)
    if (region === null) return null
    const plane = this.wasmScene.sketch_plane(region.sketch)
    if (plane === undefined) return null // stale handle — no constraint
    let point: [number, number, number] = [plane[0], plane[1], plane[2]]
    let normal: [number, number, number] = [plane[3], plane[4], plane[5]]
    if (activeInstance !== null) {
      // A def-owned sketch's plane is DEFINITION-LOCAL (`sketch_plane` has
      // no `_in_instance` sibling) — map both the point (full affine) and
      // the normal (inverse-transpose of the linear part, via the same
      // `transformNormalThroughPose` helper `worldFaceNormal` above uses)
      // through the instance's real pose into world space.
      const pose = this.wasmScene.instance_pose(activeInstance)
      if (pose === undefined) return null
      point = applyAffine3x4(pose, point)
      const mappedNormal = transformNormalThroughPose(pose, normal)
      if (mappedNormal === null) return null
      normal = mappedNormal
    }
    return { constraintPlane: { point, normal }, facesOnly: true }
  }

  /**
   * Per-pointer-event `pick_sketch_region`/`pick_sketch_region_in_instance`
   * memo, mirroring `FacePickCache`'s ray-reference keying (faceDraw.ts) —
   * `snapConstraint`'s hover probe and `onPointerDown`'s commit are called
   * back-to-back by the Viewport with the SAME `Ray` object, so this keeps
   * Path B to one pick per ray too, not one from each caller. Keyed on the
   * active instance as well as the ray: a context change between two calls
   * that happen to share a (stale) ray reference must still re-pick.
   */
  private _regionPickCache: {
    ray: Ray
    instance: bigint | null
    region: { sketch: bigint; region: bigint } | null
  } | null = null

  private _pickRegionFor(ray: Ray, activeInstance: bigint | null): { sketch: bigint; region: bigint } | null {
    if (
      this._regionPickCache !== null &&
      this._regionPickCache.ray === ray &&
      this._regionPickCache.instance === activeInstance
    ) {
      return this._regionPickCache.region
    }
    const regionPick =
      activeInstance !== null
        ? this.wasmScene.pick_sketch_region_in_instance(
            activeInstance,
            ray.origin[0], ray.origin[1], ray.origin[2],
            ray.direction[0], ray.direction[1], ray.direction[2],
          )
        : this.wasmScene.pick_sketch_region(
            ray.origin[0], ray.origin[1], ray.origin[2],
            ray.direction[0], ray.direction[1], ray.direction[2],
          )
    let region: { sketch: bigint; region: bigint } | null = null
    if (regionPick !== undefined) {
      try {
        region = { sketch: regionPick.sketch(), region: regionPick.region() }
      } finally {
        regionPick.free()
      }
    }
    this._regionPickCache = { ray, instance: activeInstance, region }
    return region
  }

  onPointerMove(snap: Snap | null, ray: Ray): void {
    this.lastSnap = snap

    if (this.stage.kind === 'dragging') {
      const { target, anchor } = this.stage
      const distance = this._axisDistance(snap, ray, anchor, target.normal)
      this.stage = { ...this.stage, distance }
      this._drawGhostPreview(anchor, target.normal, distance)
      this._reportMeasurement(distance)
    }
    // Hover highlight is handled via CueLayer for on-face snaps (M1 shortcut
    // per docs/dev/DEVELOPMENT.md: show snap marker at face location; per-face highlight
    // requires face→triangle table in MeshJs which is a WASM_API addendum).
  }

  onPointerDown(snap: Snap | null, ray: Ray): void {
    if (this.stage.kind === 'idle') {
      let target: PushPullTarget | null = null
      let anchor: [number, number, number] = [0, 0, 0]

      // --- Path A: ray-cast for the nearest object face (ignores snap priority) ---
      // pick_face bypasses the drawing snap bias toward vertices/edges, so it
      // reliably returns the surface under the cursor even when snap prefers a
      // nearby endpoint.  We call this FIRST; Path B only fires when no object
      // face is hit (bare ground or no objects yet).
      //
      // Reuses `_pickCache` — the SAME memoized pick `snapConstraint(ray)`
      // just computed for this exact `ray` object (the Viewport calls the
      // two back-to-back with the identical `Ray`), so a click costs one
      // `pick_face`, not two. A direct `onPointerDown` call with no prior
      // `snapConstraint` for this ray (every existing unit test) is still
      // correct: `pickFor`'s cache simply misses and it raycasts fresh.
      const eligible = this._pickCache.pickFor(this.wasmScene, ray, (object, instance) =>
        this._isEligible(object, instance))
      const raw = this._pickCache.rawPickFor(ray)
      if (raw !== null) {
        // Same face-eligibility policy as the draw tools (faceDraw.ts): at
        // the top level only PLAIN objects are directly push/pullable —
        // faces inside a group or component instance keep their explicit
        // editing step. Inside an editing context only that context's
        // scope is editable, so isolated editing can't disturb neighbors.
        if (eligible !== null) {
          const objectHandle = eligible.object
          const faceHandle = eligible.face
          const instanceHandle = raw.instance
          // `face_normal` answers in `objectHandle`'s own LOCAL frame — the
          // instance the face was actually picked THROUGH (`instanceHandle`,
          // not necessarily `this._activeInstance`: an injected eligibility
          // predicate could in principle allow a different one) carries the
          // real, un-baked pose that maps it into world space. `null` means
          // a stale instance or a degenerate mapped normal — treated exactly
          // like a miss (component-edit-parity.md phase A2).
          const normal = worldFaceNormal(this.wasmScene, objectHandle, faceHandle, instanceHandle ?? null)
          if (normal === null) return
          // The anchor is the (facesOnly) snap point — `snapConstraint`
          // above constrains every idle hover to this same face's plane,
          // so `snap` is always on it by construction, never a ground hit
          // through the face. A null snap can no longer happen here in
          // practice (the constraint plane's ray intersection always
          // produces one); ray-origin is a defensive last resort only —
          // see PushPullTool.test's "anchor lies on the face plane" spec.
          anchor = snap !== null ? [snap.x, snap.y, snap.z] : [...ray.origin]
          target = { kind: 'face', objectHandle, faceHandle, normal, instance: instanceHandle ?? null }
        } else {
          // FAIL CLOSED: an ineligible face CONSUMES the click. Falling
          // through to Path B would let a sketch region along the same ray
          // (a ground sketch behind the group — ordinary mid-modeling
          // state) silently start a drag and extrude geometry the user
          // did not aim at. Refuse explicably instead. `snapConstraint`
          // fails closed the same way at hover time (see its own doc) —
          // the two must never disagree.
          this.onToast(this._ineligibleFaceHint(raw.instance))
          return
        }
      }

      // --- Path B: no object face hit — try picking a sketch region ---
      // Only reached when pick_face returns undefined (bare ground click, or
      // no objects in scene yet). `pick_sketch_region` resolves the smallest
      // containing region across ALL live sketches kernel-side (nested rings
      // resolve to the innermost — the app no longer has to walk sketch_regions
      // + region_boundary + point-in-polygon itself). `pick_sketch_region`
      // only ever walks WORLD-tree sketches (`Document::sketch_ids()`
      // deliberately excludes definition-owned ones) — it can NEVER find a
      // region drawn inside a component's own definition, so an instance
      // context calls the `_in_instance` sibling instead, which is scoped to
      // (and pose-maps the ray for) exactly that definition's own sketches;
      // there is nothing left to filter by membership afterward, unlike the
      // stale approach this replaced.
      // Region extrusion is a top-level (or instance-context) act; suppress
      // it inside an OBJECT editing context (component-edit-parity.md phase
      // A2 — an instance context now has its own def-owned regions too).
      //
      // Reuses `_pickRegionFor` — the SAME memoized pick `snapConstraint(ray)`
      // just computed for this exact `ray` (mirrors Path A's `_pickCache`
      // reuse above), so this costs one `pick_sketch_region` per ray too.
      if (target === null && this._activeContext === null) {
        const activeInstance = this._activeInstance
        const region = this._pickRegionFor(ray, activeInstance)
        if (region !== null) {
          const sketchHandle = region.sketch
          const regionHandle = region.region
          // The kernel extrudes along the profile plane's own normal, so
          // the drag axis/ghost must match it (sketches on any plane —
          // Phase 1). A stale handle between the region pick and this
          // query is a miss, not a fallback to ground.
          const plane = this.wasmScene.sketch_plane(sketchHandle)
          if (plane === undefined) return // stale handle — treat as a miss
          let normal: [number, number, number] = [plane[3], plane[4], plane[5]]
          if (activeInstance !== null) {
            // A def-owned sketch's plane is DEFINITION-LOCAL — `sketch_plane`
            // has no `_in_instance` sibling, so the normal is pose-mapped
            // here the same approximate way `sketchGesture.ts`'s
            // `isStillOnPlane` does (linear part, re-normalized): exact for
            // rotation/uniform-scale/mirror/translation, and even a non-
            // uniform-scale pose can only skew the drag axis/preview, never
            // the actual commit, which goes through the kernel's own exact
            // pose⁻¹ regardless.
            const pose = this.wasmScene.instance_pose(activeInstance)
            if (pose === undefined) return
            const [nx, ny, nz] = normal
            const rnx = pose[0] * nx + pose[1] * ny + pose[2] * nz
            const rny = pose[4] * nx + pose[5] * ny + pose[6] * nz
            const rnz = pose[8] * nx + pose[9] * ny + pose[10] * nz
            const len = Math.hypot(rnx, rny, rnz)
            if (len <= 1e-12) return
            normal = [rnx / len, rny / len, rnz / len]
          }
          // The anchor is the (facesOnly) snap point — see the matching
          // Path A comment above; `snapConstraint`'s region branch
          // constrains every idle hover to this same region's plane.
          anchor = snap !== null ? [snap.x, snap.y, snap.z] : [...ray.origin]
          target = {
            kind: 'region',
            sketchHandle,
            regionHandle,
            normal,
            instance: activeInstance,
          }
        }
      }

      if (target === null) return

      this.typed = ''
      this.stage = { kind: 'dragging', target, anchor, distance: 0 }
    } else if (this.stage.kind === 'dragging') {
      // Second click: commit with current distance
      const { target, anchor, distance } = this.stage
      this.stage = { kind: 'idle' }
      this.typed = ''
      clearPreview(this.preview)
      this.onMeasurementCb('')

      // Final depth at the click — perpendicular to the face, projecting the
      // snapped reference point onto the axis when one is present (see
      // _axisDistance) so e.g. clicking an edge midpoint cuts to exactly that
      // depth rather than the cursor ray's diagonal closest-approach.
      const finalDistance = this._axisDistance(snap, ray, anchor, target.normal)
      this._commit(target, finalDistance === 0 ? distance : finalDistance)
    }
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      this.cancel()
      return
    }

    // NB: the Ctrl/Cmd extrude-as-new toggle is NOT handled here — a bare
    // Control/Meta keydown reports ctrlKey/metaKey: true on itself, so the
    // Viewport's generic key path (gated on `!isMod`) never routes it to a
    // tool's onKey (same reason Scale's Ctrl center-anchor toggle and
    // Shift's axis lock each have their own listener). It arrives via
    // `toggleExtrudeAsNew()`, driven by a dedicated Ctrl/Cmd listener in the
    // Viewport.
    if (this.stage.kind !== 'dragging') return

    // ── Numeric VCB ──
    if (ev.key === 'Enter') {
      const meters = parseLengthToMeters(this.typed)
      if (meters !== null) {
        this._commitFromTyped(meters)
      }
      return
    }

    // Feed length-input keys (digits, dot, minus, feet/inch/fraction marks,
    // explicit unit-suffix letters, Backspace) into the buffer.
    if (isLengthInputKey(ev.key)) {
      this.typed = editLengthBuffer(this.typed, ev.key, getLengthUnit())
      // Report the typed buffer as the measurement readout, tagged with the
      // current display unit so the user knows what they're typing in.
      this.onMeasurementCb(this._typedReadout())
    }
  }

  /** The typed-buffer readout, suffixed for metric formats (imperial tokens
   * like `'`/`"` are already visible in the buffer itself). */
  private _typedReadout(): string {
    return typedReadout(this.typed)
  }

  /**
   * Flip the durable extrude-as-new-object mode (SketchUp's Ctrl/Cmd "leave
   * original face", reinterpreted per the tool-parity design). A TAP toggle,
   * not hold: set it before starting a drag, or flip it mid-drag to change
   * what the NEXT click commits. Called by the Viewport's dedicated
   * Ctrl/Cmd listener on a clean tap of either key — see the onKey note
   * above for why this can't ride the generic key path. Autorepeat / the
   * combo-vs-tap distinction are the Viewport listener's concern.
   */
  toggleExtrudeAsNew(): void {
    this.extrudeAsNewMode = !this.extrudeAsNewMode
    this.onExtrudeAsNewModeChange(this.extrudeAsNewMode)
  }

  cancel(): void {
    this.stage = { kind: 'idle' }
    this.typed = ''
    clearPreview(this.preview)
    this.onMeasurementCb('')
    this.lastSnap = null
  }

  /**
   * Commit from the typed VCB buffer. `dist` is a signed distance in meters,
   * already converted from the display unit — and `editLengthBuffer` keeps a
   * leading `-` as a sign, so `dist` is negative exactly when the user typed
   * one (e.g. `-0.5` → recess by 0.5).
   *
   * The typed value always supplies the MAGNITUDE. The DIRECTION follows a
   * fixed precedence, most deliberate signal first:
   *
   *   1. An explicit typed sign wins outright. A negative `dist` is the user
   *      spelling out "recess / push inward" — the single most deliberate
   *      signal there is — so it beats both the live drag and the outward
   *      default. Typing `-0.5` goes inward even mid-outward-drag.
   *   2. Otherwise (an unsigned, positive magnitude) the direction comes from
   *      the live drag, but only once the drag clears [`MIN_INWARD_DRAG_M`].
   *      Below that threshold the drag supplies no direction: with no
   *      meaningful drag — the user clicked a face or ground region and typed
   *      an exact distance — the ray-projected `distance` is essentially zero,
   *      and its raw sign can flip negative on nothing more than the ~1e-15 m
   *      low-bit wobble of the camera projection matrix (which varies per page
   *      load). So below the threshold we extrude OUTWARD along the face
   *      normal — the unambiguous intent of "type a distance and commit".
   *
   * The four cases: `0.5`+no-drag → out; `-0.5`+no-drag → in (recess);
   * `0.5`+inward-drag → in; `-0.5`+anything → in (explicit sign wins).
   */
  private _commitFromTyped(dist: number): void {
    if (this.stage.kind !== 'dragging') return
    const { target, distance } = this.stage

    // Inward when the user typed an explicit `-` (dist < 0), OR when a genuine
    // inward drag cleared the noise threshold; outward otherwise. The explicit
    // typed sign wins over the drag — a negative `dist` forces inward no matter
    // which way the live drag was pointing.
    const sign = dist < 0 || distance < -MIN_INWARD_DRAG_M ? -1 : 1
    const signed = Math.abs(dist) * sign

    this.stage = { kind: 'idle' }
    this.typed = ''
    clearPreview(this.preview)
    this.onMeasurementCb('')

    this._commit(target, signed)
  }

  /** The current editing context (component-edit-parity.md phase A1) — a
   *  single value replacing the old `_activeContext`/`_activeComponent`/
   *  `_contextScoped` duck-typed fields. The getters below preserve their
   *  exact old read semantics so the rest of this file is unchanged. */
  private _editContext: EditContext = { kind: 'top' }
  setEditContext(ctx: EditContext): void {
    if (editContextEq(ctx, this._editContext)) return
    this._editContext = ctx
    this.cancel()
  }

  /** The entered OBJECT id, or null — unchanged meaning from the old
   *  `_activeContext` field. When set, push/pull only acts on that object's
   *  faces (scoped editing). */
  private get _activeContext(): bigint | null {
    return this._editContext.kind === 'object' ? this._editContext.id : null
  }

  /** The entered component INSTANCE id, or null (component-edit-parity.md
   *  phase A2) — new: `extrude_region_in_instance` needs the instance (not
   *  just the definition) to map a region's birth through its pose. */
  private get _activeInstance(): bigint | null {
    return this._editContext.kind === 'instance' ? this._editContext.id : null
  }

  /** Optional richer eligibility, injected by the Viewport (which knows the
   *  full group/instance context path the tool can't see). Null = the shared
   *  default policy in faceDraw.ts. */
  private _faceEligible: FaceEligible | null = null
  setFaceEligibility(pred: FaceEligible | null): void {
    this._faceEligible = pred
  }

  /** The draw tools' plain-object policy, applied to push/pull. The one
   *  tool-local addition: inside a component editing context (the Viewport
   *  pairs `setComponentContext` with its injected predicate in production)
   *  instanced picks are the editable set — the commit routes through
   *  `push_pull_in_component`. */
  private _isEligible(object: bigint, instance: bigint | undefined): boolean {
    if (this._faceEligible !== null) return this._faceEligible(object, instance)
    if (this._activeComponent !== null) return instance !== undefined
    return defaultFaceEligible(this.wasmScene, this._activeContext, object, instance)
  }

  /**
   * The component DEFINITION being edited (double-click into an instance),
   * or null; when set, push/pull routes face operations through
   * `push_pull_in_component` instead of `push_pull`. Unchanged meaning from
   * the old `_activeComponent` field (the definition handle from
   * `instance_def`, NOT the instance itself — `_activeInstance` above is the
   * new addition).
   */
  private get _activeComponent(): bigint | null {
    return this._editContext.kind === 'instance' ? this._editContext.component : null
  }

  /**
   * True while ANY editing context is entered — object, GROUP, or component.
   * Unchanged meaning from the old `_contextScoped` field. Affects only the
   * refusal hint's wording; eligibility itself comes from the injected
   * predicate, which already understands the full context path.
   */
  private get _contextScoped(): boolean {
    return this._editContext.kind !== 'top'
  }

  /** Why an ineligible face refused, phrased as the way in. Inside ANY
   *  editing context the refusal is the scope — the clicked face may not be
   *  in any group, and double-click can't enter an out-of-scope container
   *  from here, so 'step out' is the only honest guidance. At the top level
   *  (where plain objects always pass) an instanced pick belongs to a
   *  component and anything else was a grouped face. */
  private _ineligibleFaceHint(instance: bigint | undefined): string {
    if (this._contextScoped || this._activeContext !== null || this._activeComponent !== null) {
      return 'Push/pull is scoped to what you are editing — press Esc to step out first'
    }
    if (instance !== undefined) {
      return 'That face is part of a component — double-click it to edit the component'
    }
    return 'That face is inside a group — double-click to enter the group and edit it'
  }

  /**
   * Signed perpendicular depth along the push axis. When the cursor is snapped
   * to a real reference (vertex / midpoint / edge / on-face point), project THAT
   * POINT onto the axis through `anchor` so the depth is the perpendicular
   * distance to it — e.g. snapping the midpoint of an object's vertical edge
   * pushes exactly half-way. Push/pull is always a straight move along the face
   * normal, so the diagonal distance to the reference is never what we want.
   * Falls back to the cursor ray's axis projection over empty space (no snap).
   * `normal` is unit (kernel face/profile normals are).
   */
  private _axisDistance(
    snap: Snap | null,
    ray: Ray,
    anchor: [number, number, number],
    normal: [number, number, number],
  ): number {
    // Only a DELIBERATE point inference (an endpoint / midpoint / edge / axis /
    // guide / intersection the user parked the cursor on) borrows its depth.
    // A bare `on-face` snap fires almost continuously during a drag — the cursor
    // is always over *some* face — so using it would kill the free drag and make
    // the depth jump to whatever face got snapped (e.g. the far/bottom wall).
    // Free drag (and on-face) follows the cursor ray projected onto the axis.
    if (snap !== null && HARD_SNAP_KINDS.has(snap.kind)) {
      return (
        (snap.x - anchor[0]) * normal[0] +
        (snap.y - anchor[1]) * normal[1] +
        (snap.z - anchor[2]) * normal[2]
      )
    }
    return projectRayOntoAxis(ray.origin, ray.direction, anchor, normal)
  }

  private _commit(target: PushPullTarget, distance: number): void {
    if (Math.abs(distance) < 1e-6) {
      this.onToast('Move more before committing push/pull')
      return
    }

    try {
      if (target.kind === 'region') {
        // A def-owned region (component-edit-parity.md phase A2) births the
        // solid as a new DEFINITION member via `extrude_region_in_instance`
        // (seen by every instance at once), instead of a world Object.
        const objectId = target.instance !== null
          ? this.wasmScene.extrude_region_in_instance(
              target.instance,
              target.sketchHandle,
              target.regionHandle,
              distance,
            )
          : this.wasmScene.extrude_region(
              target.sketchHandle,
              target.regionHandle,
              distance,
            )
        this.onCommit(objectId)
      } else if (this.extrudeAsNewMode && this._activeComponent === null) {
        // Ctrl/Cmd modifier (design tool-parity §2): extrude a NEW
        // coincident object from the clicked face instead of pushing/
        // pulling the source — SketchUp's "leave original face". Not
        // offered inside a component editing context: the kernel op only
        // reaches WORLD faces (a definition member has no face to extrude
        // at world scale), so that combination silently falls back to the
        // ordinary `push_pull_in_component` commit below.
        const objectId = this.wasmScene.extrude_face_as_new_object(
          target.objectHandle,
          target.faceHandle,
          distance,
        )
        this.onCommit(objectId)
      } else {
        // Route through push_pull_in_component when the face was picked
        // through a component instance — `target.instance` (the instance the
        // ghost preview's pose came from), not necessarily `this._activeInstance`
        // (an injected eligibility predicate could in principle allow a
        // different one; same rationale as the `normal` lookup above).
        // `distance` is the WORLD drag distance the ghost swept; the kernel
        // maps it through `target.instance`'s pose (delta-review fix —
        // previously committed raw, diverging from the ghost on a scaled
        // instance).
        const report = target.instance !== null
          ? this.wasmScene.push_pull_in_component(
              target.instance,
              target.objectHandle,
              target.faceHandle,
              distance,
            )
          : this.wasmScene.push_pull(
              target.objectHandle,
              target.faceHandle,
              distance,
            )
        try {
          // A through-cut consumes the source object and replaces it with
          // one or more new objects; commit the first of those so selection/
          // highlight lands on real geometry instead of the now-gone source.
          if (report.is_through()) {
            const results = report.result_objects()
            this.onCommit(results.length > 0 ? results[0] : target.objectHandle)
          } else {
            this.onCommit(target.objectHandle)
          }
        } finally {
          report.free()
        }
      }
      // Record on every successful commit, however it was invoked (drag,
      // typed Enter, or a double-click repeat) — a double-click always
      // repeats the MOST RECENT distance, chainable like SketchUp's.
      this.lastCommittedDistance = distance
    } catch (err) {
      const code = parseKernelErrorCode(err)
      const rawMsg = err instanceof Error ? err.message : String(err)
      const message = kernelErrorMessage(code ?? 'Unknown', rawMsg)
      this.onToast(message, code ?? undefined)
    }
  }

  /**
   * Report the live distance measurement while dragging.
   * When the user has typed something, that buffer (tagged with the display
   * unit) is the readout; otherwise show the signed live distance so a
   * recess (pushed inward) reads negative.
   */
  private _reportMeasurement(distance: number): void {
    if (this.typed !== '') {
      this.onMeasurementCb(this._typedReadout())
      return
    }
    this.onMeasurementCb(formatLength(distance))
  }

  private _drawGhostPreview(
    anchor: [number, number, number],
    normal: [number, number, number],
    distance: number,
  ): void {
    clearPreview(this.preview)

    if (Math.abs(distance) < 1e-6) return

    // Prefer the live swept-solid ghost (the actual prism push/pull will
    // produce) — plain object/region AND in-instance targets alike
    // (component-edit-parity.md Finding 3: the in-instance path used to
    // fall straight to the bare arrow, the only visible difference from a
    // plain-object push/pull). `face_boundary`/`region_boundary` answer in
    // DEFINITION-local coordinates for a component member/def-owned sketch,
    // so `target.instance` (non-null there) maps the boundary through that
    // instance's pose into world space before building the ghost — the same
    // frame `_commit` already puts the actual solid in.
    if (this.stage.kind === 'dragging') {
      const { target } = this.stage
      try {
        const boundary = target.kind === 'region'
          ? this.wasmScene.region_boundary(target.sketchHandle, target.regionHandle)
          : this.wasmScene.face_boundary(target.objectHandle, target.faceHandle)
        const worldBoundary =
          target.instance !== null ? this._poseMapBoundary(boundary, target.instance) : boundary
        // A stale/unresolvable instance pose (rare: the instance vanished
        // mid-drag) degrades to the arrow rather than drawing a misplaced
        // ghost — `worldBoundary` is null exactly then.
        if (worldBoundary !== null) {
          const prism = buildSweptPrismPreview(worldBoundary, normal, distance)
          if (prism !== null) {
            this.preview.add(prism)
            return
          }
        }
      } catch {
        // Stale handle mid-drag (e.g. the target object/sketch changed
        // underneath us) — fall through to the arrow, no toast.
      }
    }

    this._drawArrowFallback(anchor, normal, distance)
  }

  /**
   * Map a flat `[x0,y0,z0, x1,y1,z1, …]` boundary from DEFINITION-local
   * coordinates into WORLD space through `instance`'s current pose
   * (row-major 3×4 affine, the same convention `SceneRenderer`/the kernel
   * use everywhere else). Returns `null` for a stale/unknown instance so the
   * caller can fall back to the arrow instead of drawing a misplaced ghost.
   */
  private _poseMapBoundary(boundary: Float32Array | number[], instance: bigint): Float32Array | null {
    const pose = this.wasmScene.instance_pose(instance)
    if (pose === undefined) return null
    const n = Math.floor(boundary.length / 3)
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const x = boundary[i * 3]
      const y = boundary[i * 3 + 1]
      const z = boundary[i * 3 + 2]
      out[i * 3] = pose[0] * x + pose[1] * y + pose[2] * z + pose[3]
      out[i * 3 + 1] = pose[4] * x + pose[5] * y + pose[6] * z + pose[7]
      out[i * 3 + 2] = pose[8] * x + pose[9] * y + pose[10] * z + pose[11]
    }
    return out
  }

  /**
   * Bare arrow + tip-cross preview — the original push/pull ghost. Used as a
   * fallback when the swept-prism ghost can't be built: inside a component
   * editing context (face_boundary is definition-local there, not world), or
   * when the boundary fetch fails (stale handle) or the prism is degenerate.
   */
  private _drawArrowFallback(
    anchor: [number, number, number],
    normal: [number, number, number],
    distance: number,
  ): void {
    const [ax, ay, az] = anchor
    const [nx, ny, nz] = normal

    const tip: [number, number, number] = [
      ax + nx * distance,
      ay + ny * distance,
      az + nz * distance,
    ]

    const pts = new Float32Array([ax, ay, az, ...tip])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0xee8800,
      depthTest: false,
    })
    const line = new THREE.LineSegments(geo, mat)
    line.renderOrder = 996
    this.preview.add(line)

    // Also render a small cross at the tip
    const s = 0.05
    const crossPts = new Float32Array([
      tip[0] - s, tip[1], tip[2],  tip[0] + s, tip[1], tip[2],
      tip[0], tip[1] - s, tip[2],  tip[0], tip[1] + s, tip[2],
    ])
    const crossGeo = new THREE.BufferGeometry()
    crossGeo.setAttribute('position', new THREE.BufferAttribute(crossPts, 3))
    const crossMat = new THREE.LineBasicMaterial({ color: 0xee8800, depthTest: false })
    const cross = new THREE.LineSegments(crossGeo, crossMat)
    cross.renderOrder = 996
    this.preview.add(cross)
  }
}
