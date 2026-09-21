/**
 * viewCubeRegions — the ViewCube's 26 clickable regions and the camera
 * direction each one means (docs/design/camera.md §8).
 *
 * A region is a sign triple in {-1,0,1}³ minus the origin: one non-zero
 * component is a FACE (6), two is an EDGE (12), three is a CORNER (8). The
 * same enumeration the Scale tool's grip box already uses for a bounding box
 * (`tools/ScaleTool.ts`, `gripsFromBox`) — a cube is a bounding box whose
 * grips you look along instead of drag.
 *
 * The six faces do NOT restate their eye vectors: they read
 * `STANDARD_VIEWS` (`standardViews.ts`), so the cube's Top is the viewport's
 * Top down to the `POLE_TILT` nudge, and the two cannot drift. Edges and
 * corners are the plain normalized triple — no tilt is needed because none of
 * them is anywhere near the ±Z pole.
 *
 * Pure: no three.js, no DOM. The cube's rendering layer turns a region into
 * pixels; this module only knows the geometry.
 */
import { STANDARD_VIEWS, type StandardView } from './standardViews'

/** -1, 0 or +1 along one world axis. */
export type Sign = -1 | 0 | 1
/** A region's position on the cube: [x, y, z] signs, never all zero. */
export type SignTriple = readonly [Sign, Sign, Sign]

export type ViewCubeRegionKind = 'face' | 'edge' | 'corner'

/** The six face regions, named for what you are looking AT. In the Z-up world
 * with `front`'s eye at [0,-1,0], the face you see from the front is the one
 * on -Y — so -Y reads FRONT, +Y BACK, +X RIGHT, -X LEFT, +Z TOP, -Z BOTTOM. */
export type CubeFace = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom'

export interface ViewCubeRegion {
  /** Stable id, also the accessible name: face names joined front/back,
   * left/right, top/bottom in that order — 'front', 'front-right',
   * 'front-right-top'. */
  id: string
  triple: SignTriple
  kind: ViewCubeRegionKind
  /** Unit eye direction (target → camera) this region frames. */
  eye: readonly [number, number, number]
  /** The equivalent `setStandardView` argument where one exists — the six
   * faces, plus the front-right-top corner, which IS Iso. `null` for the
   * other 19, which no menu entry reaches. */
  standardView: StandardView | null
}

const AXIS_NAMES: readonly [readonly [string, string], readonly [string, string], readonly [string, string]] = [
  ['left', 'right'],
  ['front', 'back'],
  ['bottom', 'top'],
]

/** Name parts in reading order — front/back, then left/right, then
 * top/bottom — so a corner reads 'front-right-top' the way a person says it,
 * not in raw axis order. */
const NAME_ORDER: readonly (0 | 1 | 2)[] = [1, 0, 2]

function idFor(triple: SignTriple): string {
  const parts: string[] = []
  for (const axis of NAME_ORDER) {
    const s = triple[axis]
    if (s !== 0) parts.push(AXIS_NAMES[axis][s < 0 ? 0 : 1])
  }
  return parts.join('-')
}

function normalize(v: readonly [number, number, number]): readonly [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2])
  return [v[0] / len, v[1] / len, v[2] / len]
}

/** The face a single-axis triple names, or `null` for an edge/corner. */
function faceOf(triple: SignTriple): CubeFace | null {
  const nonZero = triple.filter((s) => s !== 0)
  if (nonZero.length !== 1) return null
  return idFor(triple) as CubeFace
}

/**
 * Every region, in a stable order: the 6 faces, then the 12 edges, then the
 * 8 corners (the Scale gizmo's own grip order is faces → corners → edges;
 * this one groups by how a person thinks about the cube instead, and nothing
 * depends on the order but the tests).
 */
export const VIEW_CUBE_REGIONS: readonly ViewCubeRegion[] = buildRegions()

function buildRegions(): ViewCubeRegion[] {
  const SIGNS: readonly Sign[] = [-1, 0, 1]
  const byKind: Record<ViewCubeRegionKind, ViewCubeRegion[]> = { face: [], edge: [], corner: [] }

  for (const x of SIGNS) {
    for (const y of SIGNS) {
      for (const z of SIGNS) {
        const nonZero = (x !== 0 ? 1 : 0) + (y !== 0 ? 1 : 0) + (z !== 0 ? 1 : 0)
        if (nonZero === 0) continue
        const triple: SignTriple = [x, y, z]
        const kind: ViewCubeRegionKind = nonZero === 1 ? 'face' : nonZero === 2 ? 'edge' : 'corner'
        const face = faceOf(triple)
        // A face reads its eye straight off STANDARD_VIEWS so Top/Bottom keep
        // POLE_TILT; everything else is the triple itself, normalized.
        const eye = normalize(face !== null ? STANDARD_VIEWS[face].eye : [x, y, z])
        byKind[kind].push({
          id: idFor(triple),
          triple,
          kind,
          eye,
          // The front-right-top corner is the SketchUp Iso the menu already
          // has ([1,-1,1] — same direction, so the same view).
          standardView: face ?? (x === 1 && y === -1 && z === 1 ? 'iso' : null),
        })
      }
    }
  }
  return [...byKind.face, ...byKind.edge, ...byKind.corner]
}

const BY_ID = new Map(VIEW_CUBE_REGIONS.map((r) => [r.id, r]))

/** Look a region up by id. Throws on an unknown id — every caller builds its
 * ids from this module, so a miss is a bug, not user input. */
export function regionById(id: string): ViewCubeRegion {
  const region = BY_ID.get(id)
  if (region === undefined) throw new Error(`unknown ViewCube region: ${id}`)
  return region
}

/**
 * Which region the camera is currently sitting at, for the cube's "you are
 * here" highlight — the region whose eye direction is closest to `dir`, or
 * `null` when the camera is between regions. The nearest two regions are 45°
 * apart, so the default 3° window is unambiguous by a wide margin and means
 * "parked on this view", not "roughly facing it".
 *
 * `dir` need not be unit length; a zero-length `dir` answers `null`.
 */
export function regionAtDirection(
  dir: readonly [number, number, number],
  tolDeg = 3,
): ViewCubeRegion | null {
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len === 0) return null
  const u: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len]
  const minDot = Math.cos((tolDeg * Math.PI) / 180)

  let best: ViewCubeRegion | null = null
  let bestDot = -Infinity
  for (const region of VIEW_CUBE_REGIONS) {
    const dot = u[0] * region.eye[0] + u[1] * region.eye[1] + u[2] * region.eye[2]
    if (dot > bestDot) {
      bestDot = dot
      best = region
    }
  }
  return bestDot >= minDot ? best : null
}

/**
 * A face's in-plane axes in world space, chosen so `right × up` is the
 * outward normal and the face's label reads upright from that face's own
 * standard view. The cube's markup needs these to lay a face's 3×3 hit grid
 * out in the right orientation.
 */
export interface FaceFrame {
  normal: SignTriple
  right: SignTriple
  up: SignTriple
}

const FACE_FRAMES: Record<CubeFace, FaceFrame> = {
  front:  { normal: [0, -1, 0], right: [1, 0, 0],  up: [0, 0, 1] },
  back:   { normal: [0, 1, 0],  right: [-1, 0, 0], up: [0, 0, 1] },
  right:  { normal: [1, 0, 0],  right: [0, 1, 0],  up: [0, 0, 1] },
  left:   { normal: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  top:    { normal: [0, 0, 1],  right: [1, 0, 0],  up: [0, 1, 0] },
  bottom: { normal: [0, 0, -1], right: [1, 0, 0],  up: [0, -1, 0] },
}

export const CUBE_FACES: readonly CubeFace[] = ['front', 'back', 'right', 'left', 'top', 'bottom']

export function faceFrame(face: CubeFace): FaceFrame {
  return FACE_FRAMES[face]
}

/**
 * A face's 3×3 hit zones as region ids, indexed `[rowFromTop][col]` so the
 * grid can be emitted straight into markup in DOM order. The centre is the
 * face itself; the four side zones are edges and the four corner zones are
 * corners — each of which also appears on the one or two other faces that
 * share it, which is exactly right: they are the same region, reachable from
 * whichever face you happen to be looking at.
 */
export function faceZones(face: CubeFace): string[][] {
  const { normal, right, up } = FACE_FRAMES[face]
  const grid: string[][] = []
  for (let rowFromTop = 0; rowFromTop < 3; rowFromTop++) {
    const u = 1 - rowFromTop
    const row: string[] = []
    for (let col = -1; col <= 1; col++) {
      const triple: SignTriple = [
        (normal[0] + col * right[0] + u * up[0]) as Sign,
        (normal[1] + col * right[1] + u * up[1]) as Sign,
        (normal[2] + col * right[2] + u * up[2]) as Sign,
      ]
      row.push(idFor(triple))
    }
    grid.push(row)
  }
  return grid
}
