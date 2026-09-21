/**
 * ViewCube — the viewport's orientation gizmo (docs/design/camera.md §8).
 *
 * A cube in the top-right corner that always shows which way the camera is
 * pointing. Click any of its 26 regions — 6 faces, 12 edges, 8 corners — to
 * swing to that view; drag it to orbit. Beneath it, a glyph strip: Iso, and a
 * two-state Perspective/Parallel readout.
 *
 * **Clicking a region reorients only.** It keeps the pivot and the distance
 * you were already working at, unlike `setStandardView` (the Camera menu, the
 * `ViewportHUD` chips), which also re-fits the model. That split is
 * deliberate: this is an instrument you touch constantly while modelling and
 * it must not throw away your zoom. The Iso glyph is the one control here
 * that DOES re-frame — the deliberate "get me un-lost" button.
 *
 * **It is DOM, not GL.** Six `<div>` faces under `transform-style:
 * preserve-3d`, each holding a 3×3 grid of `<button>` zones; the centre zone
 * is that face, the eight around it are the edges and corners it shares with
 * its neighbours. The browser draws and z-sorts them. That buys crisp DOM
 * labels, themes straight off the tokens, real focus and keyboard
 * activation, jsdom tests, and — the reason it is not a scissored second
 * pass — no new GL state anywhere near the drawing buffer the tape loupe
 * reads back. Every other viewport overlay here is DOM too.
 *
 * **The browser draws the cube; it does not pick it.** Chromium routes a
 * pointer event inside a `preserve-3d` subtree to a different element than
 * `elementsFromPoint` reports for the same pixel — press a zone dead centre
 * and `ev.target` is the face, not the zone. So hover and press both go
 * through `regionAtCubePoint`, which inverts the cube's own projection. The
 * zones stay real `<button>`s for focus, tooltips and keyboard activation,
 * and a keyboard `click` (`detail === 0`) is the one path that activates
 * through the DOM.
 *
 * Nothing in the cube's subtree may set `opacity`, `filter`, `overflow`,
 * `clip-path`, `mask`, `backdrop-filter`, `contain: paint` or
 * `will-change: opacity`. Any one of them collapses a `preserve-3d` subtree
 * back to flat and the cube silently becomes a stack of squares — which is
 * why the states in `index.css` are background-only.
 *
 * A region on a silhouette edge belongs to two or three faces at once. That
 * is harmless by construction: every copy is derived from the same sign
 * triple and carries the same region id, and `regionAtCubePoint` resolves
 * overlaps by depth, so the one you can see is the one you get.
 *
 * Orientation arrives on `cameraPoseBus` and is applied as direct style
 * writes on refs — no `setState` in the frame path. The component re-renders
 * only when the projection flips.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { CUBE_FACES, faceFrame, faceZones, regionAtDirection, regionById, type CubeFace } from './viewCubeRegions'
import {
  cubeMatrix,
  cssMatrix3d,
  faceMatrix,
  eyeDirFromQuaternion,
  visibleFaces,
  regionAtCubePoint,
  type Matrix3dElements,
} from './viewCubeMatrix'
import { subscribeCameraPose } from './cameraPoseBus'
import {
  beginViewCubeDrag,
  updateViewCubeDrag,
  endViewCubeDrag,
  type ViewCubeDragState,
} from './viewCubeDrag'

/** A face's edge length in CSS pixels. Each of its nine zones is a third of
 * that — a 21px target. Under the 24px a standalone control would want, but
 * this is a pointing widget whose regions are read by inverting the cube's
 * projection rather than by hit-testing the DOM, so a zone is exactly as big
 * as the part of the cube it draws and shrinking the cube shrinks it 1:1.
 * Every region is also reachable from the keyboard and from Camera ▸ Standard
 * Views. */
const CUBE_PX = 64
const HALF_PX = CUBE_PX / 2

/**
 * The box the widget actually reserves.
 *
 * A rotated cube's silhouette is bigger than any one face: seen corner-on it
 * measures a full body diagonal, `CUBE_PX · √3`. Sizing the stage to the FACE
 * would let the cube spill out of its own footprint — at the iso view by some
 * 30px, straight up over the toolbar above the viewport. Reserve the
 * silhouette instead, and the faces still centre themselves inside it.
 */
const STAGE_PX = Math.ceil(CUBE_PX * Math.sqrt(3))

/**
 * How long a region click takes to swing the camera. Shorter than the 600ms
 * Scene transition on purpose: a Scene change is a presentation beat you
 * watch, while this is navigation you are trying to get through. Passed to
 * `tweenCameraState`, which honours `prefers-reduced-motion` on its own.
 */
export const VIEW_CUBE_TWEEN_MS = 300

/**
 * One focusable copy per region.
 *
 * The 26 regions are drawn 54 times — every edge appears on two faces and
 * every corner on three — which is right for the picture and wrong for the
 * keyboard: tabbing would land on "Front Right Top" three separate times.
 * The first face to emit a region owns the real button; the other copies are
 * decoration, taken out of the tab order and hidden from assistive tech.
 * Pointer input is unaffected, since it never goes through these at all.
 */
const PRIMARY_ZONES: ReadonlySet<string> = (() => {
  const seen = new Set<string>()
  const primary = new Set<string>()
  for (const face of CUBE_FACES) {
    faceZones(face).forEach((row, r) =>
      row.forEach((regionId, c) => {
        if (seen.has(regionId)) return
        seen.add(regionId)
        primary.add(`${face}:${r}:${c}`)
      }),
    )
  }
  return primary
})()

/** Face transforms never change — one per face, computed once. */
const FACE_TRANSFORMS: Record<CubeFace, string> = Object.fromEntries(
  CUBE_FACES.map((face) => [face, cssMatrix3d(faceMatrix(face, HALF_PX))]),
) as Record<CubeFace, string>

/** The world-axis colour token per axis index, in the same X, Y, Z order
 * `axisColors.ts` uses — the one place the app decides that X is red. */
const AXIS_TOKEN = ['--axis-red', '--axis-green', '--axis-blue'] as const

/**
 * Each face painted in its own axis colour.
 *
 * A face's normal IS a world axis, so the cube can say which axis you are
 * looking down without drawing a triad: Right/Left carry X, Front/Back carry
 * Y, Top/Bottom carry Z. The tint is a whisper — a tenth of the axis colour
 * mixed into the same overlay surface every other chip uses — but it is
 * enough that three adjacent faces never read as one flat shape, which is the
 * other thing a cube of six identical fills was missing.
 *
 * The POSITIVE end of an axis is tinted twice as hard as the negative one, so
 * the pair also tells you which way along the axis you are: +X reads red, −X
 * reads barely red. That is the same convention the axis lines already use,
 * where the negative half is the faint one.
 */
const FACE_PAINT: Record<CubeFace, { background: string; color: string }> = Object.fromEntries(
  CUBE_FACES.map((face) => {
    const normal = faceFrame(face).normal
    const axis = normal.findIndex((c) => c !== 0)
    const hue = `var(${AXIS_TOKEN[axis]})`
    const positive = normal[axis] > 0
    return [
      face,
      {
        background: `color-mix(in srgb, ${hue} ${positive ? 10 : 5}%, var(--surface-overlay))`,
        // Mixed toward the PRIMARY text colour, not the secondary one the
        // labels used to take: an axis-tinted grey is just mud, and the label
        // was the weakest thing on the widget to begin with.
        color: `color-mix(in srgb, ${hue} 70%, var(--text-primary))`,
      },
    ]
  }),
) as Record<CubeFace, { background: string; color: string }>

/** The same six words the Camera ▸ Standard Views submenu uses, so the cube
 * and the menu cannot disagree about what a face is called. */
const FACE_LABEL: Record<CubeFace, string> = {
  front: 'FRONT',
  back: 'BACK',
  right: 'RIGHT',
  left: 'LEFT',
  top: 'TOP',
  bottom: 'BOTTOM',
}

/** 'front-right-top' → 'Front Right Top', for the tooltip and the accessible
 * name. Edges and corners carry no visible label (Fusion's don't either), so
 * this is the only thing that names them. The name is the view alone, not
 * "View: …" — the cube is a labelled group, so prefixing all 54 zones would
 * only make every one of them read the same for the first word. */
function regionTitle(id: string): string {
  return id
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

export interface ViewCubeProps {
  /** Which projection is live, for the glyph strip's two-state readout.
   * App.tsx already caches this from Viewport's `onProjectionChange`. */
  parallelProjection: boolean
  /** A region was clicked: reorient to it, keeping pivot and distance. */
  onSelectRegion: (regionId: string) => void
  /** The cube was dragged: orbit by these radians (`ViewportApi.orbitBy`). */
  onOrbitBy: (deltaTheta: number, deltaPhi: number) => void
  /** The inactive projection glyph was clicked. */
  onToggleProjection: () => void
  /** The Iso glyph was clicked — reorient AND re-fit. */
  onIso: () => void
  /** The viewport's current height in CSS pixels. Read lazily, at
   * pointer-down, so a resize between renders can't feed stale numbers into
   * the drag rate — and it must be the VIEWPORT's height, not the cube's, or
   * the same hand movement would spin the camera nine times as far. */
  viewportHeightPx: () => number
}

export function ViewCube({
  parallelProjection,
  onSelectRegion,
  onOrbitBy,
  onToggleProjection,
  onIso,
  viewportHeightPx,
}: ViewCubeProps) {
  const cubeRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const faceRefs = useRef<Partial<Record<CubeFace, HTMLDivElement | null>>>({})
  /** Every zone element keyed by region id — a region appears on up to three
   * faces, so the highlight has to reach all of them. Built once from the
   * rendered DOM; the markup is static, so it never needs rebuilding. */
  const zonesByRegion = useRef<Map<string, HTMLElement[]>>(new Map())
  const litRegion = useRef<string | null>(null)
  const hoverRegion = useRef<string | null>(null)
  /** The live world→CSS matrix, kept so picking can invert the very
   * projection the cube is currently drawn with. */
  const matrix = useRef<Matrix3dElements>(cubeMatrix(0, 0, 0, 1))

  useLayoutEffect(() => {
    const map = new Map<string, HTMLElement[]>()
    for (const el of cubeRef.current?.querySelectorAll<HTMLElement>('[data-region]') ?? []) {
      const id = el.dataset.region as string
      const list = map.get(id)
      if (list === undefined) map.set(id, [el])
      else list.push(el)
    }
    zonesByRegion.current = map
  }, [])

  // Orientation. Direct style writes, never setState — this runs on every
  // frame the camera moves. The callback only WRITES: no getBoundingClientRect
  // or offsetWidth, so it cannot force a synchronous layout inside the frame.
  useEffect(
    () =>
      subscribeCameraPose((qx, qy, qz, qw) => {
        const cube = cubeRef.current
        if (cube === null) return
        const m = cubeMatrix(qx, qy, qz, qw)
        matrix.current = m
        cube.style.transform = cssMatrix3d(m)

        const vis = visibleFaces(qx, qy, qz, qw)
        for (const face of CUBE_FACES) {
          const el = faceRefs.current[face]
          if (el != null) el.style.pointerEvents = vis[face] ? 'auto' : 'none'
        }

        const here = regionAtDirection(eyeDirFromQuaternion(qx, qy, qz, qw))?.id ?? null
        if (here !== litRegion.current) {
          setFlag(zonesByRegion.current, litRegion.current, 'here', false)
          setFlag(zonesByRegion.current, here, 'here', true)
          litRegion.current = here
        }
      }),
    [],
  )

  // ---------------------------------------------------------------- gesture
  const drag = useRef<ViewCubeDragState | null>(null)
  const heightAtPress = useRef(1)
  /** The region the press landed on. Captured at pointerDOWN because
   * `setPointerCapture` retargets every later pointer event at the capturing
   * element — by pointerup, `ev.target` is the stage, not the zone. */
  const pressedRegion = useRef<string | null>(null)

  /** The region under a client point, by inverting the cube's own projection
   * — see the module doc for why the DOM is not asked. */
  function pickRegion(clientX: number, clientY: number): string | null {
    const stage = stageRef.current
    if (stage === null) return null
    const rect = stage.getBoundingClientRect()
    if (rect.width === 0) return null
    return regionAtCubePoint(
      matrix.current,
      clientX - (rect.left + rect.width / 2),
      clientY - (rect.top + rect.height / 2),
      HALF_PX,
    )
  }

  function setHover(id: string | null): void {
    if (id === hoverRegion.current) return
    setFlag(zonesByRegion.current, hoverRegion.current, 'hover', false)
    setFlag(zonesByRegion.current, id, 'hover', true)
    hoverRegion.current = id
  }

  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>): void {
    if (ev.button !== 0) return
    const region = pickRegion(ev.clientX, ev.clientY)
    // A press in the corner of the widget's box, outside the cube's
    // silhouette, is not the cube's to take — let it fall through.
    if (region === null) return
    ev.preventDefault()
    drag.current = beginViewCubeDrag(ev.clientX, ev.clientY)
    heightAtPress.current = viewportHeightPx()
    pressedRegion.current = region
    ev.currentTarget.setPointerCapture(ev.pointerId)
  }

  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>): void {
    const state = drag.current
    if (state === null) {
      setHover(pickRegion(ev.clientX, ev.clientY))
      return
    }
    const next = updateViewCubeDrag(state, ev.clientX, ev.clientY, heightAtPress.current)
    drag.current = next.state
    if (next.orbit !== null) {
      setHover(null)
      onOrbitBy(next.orbit.deltaTheta, next.orbit.deltaPhi)
    }
  }

  function onPointerLeave(): void {
    if (drag.current === null) setHover(null)
  }

  function onPointerUp(ev: React.PointerEvent<HTMLDivElement>): void {
    const state = drag.current
    const pressed = pressedRegion.current
    drag.current = null
    pressedRegion.current = null
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId)
    }
    if (state === null || pressed === null || !endViewCubeDrag(state).click) return
    // Native button semantics: press a zone, release somewhere else, nothing
    // happens. The cube has turned under the pointer if this was a drag, so
    // only a click re-picks.
    const released = pickRegion(ev.clientX, ev.clientY)
    if (released === null || released === pressed) onSelectRegion(pressed)
  }

  function onPointerCancel(): void {
    drag.current = null
    pressedRegion.current = null
    setHover(null)
  }

  /**
   * Keyboard activation. A zone is a real button, so Enter and Space fire a
   * `click` with `detail === 0`; a pointer-driven click has a positive
   * detail and is already handled by the pointer path above, so this is the
   * one place the DOM's own hit answer is used — and for keyboard it is not
   * a hit answer at all, it is focus.
   */
  function onZoneClick(ev: React.MouseEvent<HTMLButtonElement>, regionId: string): void {
    if (ev.detail === 0) onSelectRegion(regionId)
  }

  return (
    <div style={WRAPPER_STYLE} data-testid="view-cube">
      <div
        ref={stageRef}
        role="group"
        aria-label="View cube"
        style={STAGE_STYLE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
      >
        <div ref={cubeRef} style={CUBE_STYLE}>
          {CUBE_FACES.map((face) => (
            <div
              key={face}
              ref={(el) => {
                faceRefs.current[face] = el
              }}
              data-face={face}
              style={{ ...FACE_STYLE, ...FACE_PAINT[face], transform: FACE_TRANSFORMS[face] }}
            >
              {faceZones(face).map((row, rowFromTop) =>
                row.map((regionId, col) => {
                  const primary = PRIMARY_ZONES.has(`${face}:${rowFromTop}:${col}`)
                  return (
                    <button
                      key={`${rowFromTop}-${col}`}
                      type="button"
                      className="hew-view-cube-zone"
                      data-region={regionId}
                      title={regionTitle(regionId)}
                      aria-label={primary ? regionTitle(regionId) : undefined}
                      aria-hidden={primary ? undefined : true}
                      tabIndex={primary ? undefined : -1}
                      onClick={(ev) => onZoneClick(ev, regionId)}
                      style={
                        regionById(regionId).kind === 'face' ? FACE_ZONE_STYLE : EDGE_ZONE_STYLE
                      }
                    >
                      {rowFromTop === 1 && col === 1 ? FACE_LABEL[face] : null}
                    </button>
                  )
                }),
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={GLYPH_STRIP_STYLE}>
        <GlyphButton title="Iso View (fit)" onClick={onIso} active={false}>
          <IsoGlyph />
        </GlyphButton>
        <GlyphButton
          title="Perspective"
          pressed={!parallelProjection}
          active={!parallelProjection}
          onClick={() => {
            if (parallelProjection) onToggleProjection()
          }}
        >
          <PerspectiveGlyph />
        </GlyphButton>
        <GlyphButton
          title="Parallel Projection"
          pressed={parallelProjection}
          active={parallelProjection}
          onClick={() => {
            if (!parallelProjection) onToggleProjection()
          }}
        >
          <ParallelGlyph />
        </GlyphButton>
      </div>
    </div>
  )
}

/**
 * Flip a `data-` flag on every copy of a region — a region on a silhouette
 * edge is drawn by two or three faces, and all of them have to light up
 * together or the highlight looks like it belongs to one arbitrary face.
 */
function setFlag(
  map: Map<string, HTMLElement[]>,
  id: string | null,
  flag: 'here' | 'hover',
  on: boolean,
): void {
  if (id === null) return
  for (const el of map.get(id) ?? []) {
    if (on) el.dataset[flag] = 'true'
    else delete el.dataset[flag]
  }
}

// ------------------------------------------------------------------ glyphs

function GlyphButton({
  title,
  onClick,
  active,
  pressed,
  children,
}: {
  title: string
  onClick: () => void
  active: boolean
  pressed?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={onClick}
      style={{
        ...GLYPH_BUTTON_STYLE,
        color: active ? 'var(--accent-base)' : 'var(--text-secondary)',
        borderColor: active ? 'var(--accent-border)' : 'var(--border-hairline)',
        background: active ? 'var(--accent-tint-15)' : 'var(--surface-overlay)',
      }}
    >
      {children}
    </button>
  )
}

const GLYPH_SVG_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.1,
  strokeLinejoin: 'round' as const,
  strokeLinecap: 'round' as const,
  'aria-hidden': true,
}

/** A cube seen corner-on: a hexagon silhouette with three spokes to the
 * centre — the universal isometric mark. */
function IsoGlyph() {
  return (
    <svg {...GLYPH_SVG_PROPS}>
      <path d="M8 1.6 13.5 4.8 13.5 11.2 8 14.4 2.5 11.2 2.5 4.8Z" />
      <path d="M8 8 8 14.4M8 8 2.5 4.8M8 8 13.5 4.8" />
    </svg>
  )
}

/** A box drawn in one-point perspective: the far square is SMALLER, so its
 * connecting edges visibly converge. */
function PerspectiveGlyph() {
  return (
    <svg {...GLYPH_SVG_PROPS}>
      <rect x="2.2" y="6.6" width="8" height="7.2" />
      <rect x="7" y="3.4" width="6.2" height="5.6" />
      <path d="M2.2 6.6 7 3.4M10.2 6.6 13.2 3.4M10.2 13.8 13.2 9" />
    </svg>
  )
}

/** The same box with the far square the SAME size — every edge parallel.
 * Deliberately one variable away from the perspective glyph, so the pair
 * reads as a contrast rather than as two unrelated marks. */
function ParallelGlyph() {
  return (
    <svg {...GLYPH_SVG_PROPS}>
      <rect x="2.2" y="6.6" width="7.6" height="7.2" />
      <rect x="6.2" y="2.6" width="7.6" height="7.2" />
      <path d="M2.2 6.6 6.2 2.6M9.8 6.6 13.8 2.6M9.8 13.8 13.8 9.8" />
    </svg>
  )
}

// ------------------------------------------------------------------ styles

const WRAPPER_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: '16px',
  right: '16px',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '6px',
  // No opacity/filter/overflow anywhere down this subtree — see the module
  // doc. They would flatten the cube.
}

const STAGE_STYLE: React.CSSProperties = {
  position: 'relative',
  width: `${STAGE_PX}px`,
  height: `${STAGE_PX}px`,
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  cursor: 'grab',
}

const CUBE_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  transformStyle: 'preserve-3d',
  // No `perspective` on the stage: the cube is drawn orthographically, so its
  // silhouette never changes with the main camera's own projection. Fusion's
  // reads near-orthographic too.
}

const FACE_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: `${CUBE_PX}px`,
  height: `${CUBE_PX}px`,
  marginLeft: `${-HALF_PX}px`,
  marginTop: `${-HALF_PX}px`,
  transformStyle: 'flat',
  backfaceVisibility: 'hidden',
  // The fill comes from `FACE_PAINT` — opaque, or the far faces read through
  // the near ones. The border doubles as the cube's own edge line and hides
  // the sub-pixel seam where two faces meet.
  // `--border-strong`, not the hairline every other overlay uses: on a cube
  // the borders ARE the edges, and the whole read of the shape depends on
  // them. A hairline leaves it a pale blob.
  border: '1px solid var(--border-strong)',
  boxSizing: 'border-box',
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gridTemplateRows: 'repeat(3, 1fr)',
}

const EDGE_ZONE_STYLE: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
}

const FACE_ZONE_STYLE: React.CSSProperties = {
  ...EDGE_ZONE_STYLE,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-family-ui)',
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.04em',
  // The label is wider than the centre zone that holds it — "BOTTOM" is some
  // 45px across a 21px cell — and it is meant to be: it is the FACE's label,
  // centred on the face, and the zone is only where it happens to live in the
  // grid. Without this it wraps to three stacked letters.
  whiteSpace: 'nowrap',
  // Colour comes from the face, which sets its own axis tint.
  color: 'inherit',
}

const GLYPH_STRIP_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: '4px',
}

const GLYPH_BUTTON_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  padding: 0,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: 'var(--radius-control, 7px)',
  cursor: 'pointer',
}
