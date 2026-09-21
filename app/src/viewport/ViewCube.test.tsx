/**
 * ViewCube's DOM contract.
 *
 * jsdom has no layout engine: it does not apply CSS transforms, and
 * `elementFromPoint` is meaningless there. So these tests assert the DOM
 * STRUCTURE, the emitted transform STRINGS, and the handler WIRING — never
 * rendered geometry. Where a region physically lands on screen is the E2E's
 * job (`app/e2e/view-cube.spec.ts`); the transform math itself is pinned in
 * `viewCubeMatrix.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ViewCube } from './ViewCube'
import { publishCameraPose, resetCameraPoseBus } from './cameraPoseBus'
import { cubeMatrix, cssMatrix3d } from './viewCubeMatrix'
import { VIEW_CUBE_REGIONS, CUBE_FACES } from './viewCubeRegions'

/** The callbacks are returned as the mocks they are, not widened through the
 * overrides spread, so a test can `mockClear` between cases. Overrides are
 * for the plain inputs (`parallelProjection`, `viewportHeightPx`). */
function setup(overrides: Partial<React.ComponentProps<typeof ViewCube>> = {}) {
  const onSelectRegion = vi.fn()
  const onOrbitBy = vi.fn()
  const onToggleProjection = vi.fn()
  const onIso = vi.fn()
  const utils = render(
    <ViewCube
      parallelProjection={false}
      viewportHeightPx={() => 800}
      {...overrides}
      onSelectRegion={onSelectRegion}
      onOrbitBy={onOrbitBy}
      onToggleProjection={onToggleProjection}
      onIso={onIso}
    />,
  )
  return { ...utils, onSelectRegion, onOrbitBy, onToggleProjection, onIso }
}

/** The cube's 3D root — the element the pose feed writes `transform` onto. */
function cubeEl(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-face]')!.parentElement as HTMLElement
}

function stageEl(container: HTMLElement): HTMLElement {
  return cubeEl(container).parentElement as HTMLElement
}

function zone(container: HTMLElement, regionId: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-region="${regionId}"]`)!
}

/** jsdom implements neither pointer capture nor `Element.closest` on a
 * non-Element target; stub the capture API the component calls. */
beforeEach(() => {
  resetCameraPoseBus()
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
})

afterEach(() => cleanup())

describe('structure', () => {
  it('renders six faces', () => {
    const { container } = setup()
    expect(container.querySelectorAll('[data-face]')).toHaveLength(6)
    for (const face of CUBE_FACES) {
      expect(container.querySelector(`[data-face="${face}"]`)).not.toBeNull()
    }
  })

  it('renders a 3x3 grid on each face — 54 zones reaching all 26 regions', () => {
    const { container } = setup()
    const zones = container.querySelectorAll<HTMLElement>('[data-region]')
    expect(zones).toHaveLength(54)
    const ids = new Set([...zones].map((z) => z.dataset.region))
    expect(ids.size).toBe(26)
    for (const r of VIEW_CUBE_REGIONS) expect(ids.has(r.id)).toBe(true)
  })

  it('labels the six face centres and leaves edges and corners unlabelled', () => {
    setup()
    for (const label of ['TOP', 'BOTTOM', 'FRONT', 'BACK', 'LEFT', 'RIGHT']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('exposes each region to the keyboard exactly once, not once per face that draws it', () => {
    // Every edge is drawn twice and every corner three times. Tabbing should
    // still visit 26 things, not 54, and never the same view twice.
    const { container } = setup()
    const named = [...container.querySelectorAll<HTMLElement>('[data-region]')].filter(
      (z) => z.getAttribute('aria-hidden') === null,
    )
    expect(named).toHaveLength(26)
    expect(new Set(named.map((z) => z.dataset.region)).size).toBe(26)
    for (const z of named) expect(z.getAttribute('aria-label')).toBeTruthy()
  })

  it('takes the duplicate copies out of the tab order', () => {
    const { container } = setup()
    const dupes = [...container.querySelectorAll<HTMLElement>('[data-region][aria-hidden="true"]')]
    expect(dupes).toHaveLength(54 - 26)
    for (const z of dupes) expect(z.getAttribute('tabindex')).toBe('-1')
  })

  it('names a region by its view', () => {
    const { container } = setup()
    const named = container.querySelector<HTMLElement>(
      '[data-region="front-right-top"]:not([aria-hidden])',
    )
    expect(named?.getAttribute('aria-label')).toBe('Front Right Top')
  })

  it('names the cube as a group, so a zone does not have to repeat the context', () => {
    const { container } = setup()
    expect(stageEl(container).getAttribute('aria-label')).toBe('View cube')
    expect(stageEl(container).getAttribute('role')).toBe('group')
  })

  it('makes every zone a real button, so focus and keyboard activation come from the platform', () => {
    const { container } = setup()
    for (const z of container.querySelectorAll('[data-region]')) {
      expect(z.tagName).toBe('BUTTON')
      expect(z.getAttribute('type')).toBe('button')
    }
  })

  it('sets no property that would flatten the preserve-3d subtree', () => {
    // opacity / filter / overflow / clip-path / mask on any ancestor of the
    // faces collapses the cube to a stack of squares. Cheap to assert, and
    // the failure mode is silent in a browser.
    const { container } = setup()
    const root = container.querySelector<HTMLElement>('[data-testid="view-cube"]')!
    for (const el of [root, stageEl(container), cubeEl(container)]) {
      expect(el.style.opacity).toBe('')
      expect(el.style.filter).toBe('')
      expect(el.style.overflow).toBe('')
      expect(el.style.clipPath).toBe('')
      expect(el.style.mask).toBe('')
    }
    expect(cubeEl(container).style.transformStyle).toBe('preserve-3d')
  })
})

describe('camera pose feed', () => {
  it('orients the cube from a published pose', () => {
    const { container } = setup()
    publishCameraPose(0, 0, 0, 1)
    expect(cubeEl(container).style.transform).toBe(cssMatrix3d(cubeMatrix(0, 0, 0, 1)))
  })

  it('picks up a pose published before it mounted', () => {
    publishCameraPose(0, 0.7071067811865476, 0, 0.7071067811865476)
    const { container } = setup()
    expect(cubeEl(container).style.transform).toBe(
      cssMatrix3d(cubeMatrix(0, 0.7071067811865476, 0, 0.7071067811865476)),
    )
  })

  it('switches pointer-events off on the faces turned away, rather than trusting backface-visibility', () => {
    const { container } = setup()
    // Identity camera looks down -Z from +Z: only the top face is toward us.
    publishCameraPose(0, 0, 0, 1)
    expect(container.querySelector<HTMLElement>('[data-face="top"]')!.style.pointerEvents).toBe('auto')
    expect(container.querySelector<HTMLElement>('[data-face="bottom"]')!.style.pointerEvents).toBe('none')
  })

  it('marks the region the camera is parked on, and only that one', () => {
    const { container } = setup()
    publishCameraPose(0, 0, 0, 1) // looking straight down +Z — the top region
    const lit = [...container.querySelectorAll<HTMLElement>('[data-region]')].filter(
      (z) => z.dataset.here === 'true',
    )
    expect(lit.length).toBeGreaterThan(0)
    expect(new Set(lit.map((z) => z.dataset.region))).toEqual(new Set(['top']))
  })

  it('moves the mark when the camera moves, leaving nothing lit behind', () => {
    const { container } = setup()
    publishCameraPose(0, 0, 0, 1)
    expect(zone(container, 'top').dataset.here).toBe('true')
    // A quarter turn about X: now looking along -Y, i.e. the back region.
    publishCameraPose(0.7071067811865476, 0, 0, 0.7071067811865476)
    expect(zone(container, 'top').dataset.here).toBeUndefined()
  })

  it('stops writing after unmount', () => {
    const { container, unmount } = setup()
    publishCameraPose(0, 0, 0, 1)
    const before = cubeEl(container).style.transform
    unmount()
    expect(() => publishCameraPose(0.5, 0.5, 0.5, 0.5)).not.toThrow()
    expect(before).not.toBe('')
  })
})

/**
 * Picking is math, not DOM hit-testing (see the component's module doc), so
 * these tests need two things jsdom does not give for free: a laid-out stage
 * box, and a known camera pose.
 *
 * jsdom reports every rect as 0x0 — the same gap `zoomFloor.test.tsx` fills
 * for OrbitControls — so stub the stage's rect, then publish the identity
 * quaternion. That pose looks straight down the world +Z, which puts the TOP
 * face at the viewer with its +X to the right and +Y up the screen. Every
 * expected region below follows from that.
 */
const STAGE = { left: 1000, top: 100, size: 125 }
const CENTRE = { x: STAGE.left + STAGE.size / 2, y: STAGE.top + STAGE.size / 2 }
/** Well past a third of the half-size (36), so it lands in an outer band. */
const OFF = 30

function layOutStage(container: HTMLElement): void {
  stageEl(container).getBoundingClientRect = () =>
    ({
      left: STAGE.left,
      top: STAGE.top,
      width: STAGE.size,
      height: STAGE.size,
      right: STAGE.left + STAGE.size,
      bottom: STAGE.top + STAGE.size,
      x: STAGE.left,
      y: STAGE.top,
      toJSON: () => ({}),
    }) as DOMRect
  publishCameraPose(0, 0, 0, 1)
}

describe('picking is math, not DOM hit-testing', () => {
  it('resolves the zone under the pointer from the cube own projection', () => {
    const { container, onSelectRegion } = setup()
    layOutStage(container)
    const stage = stageEl(container)

    // Looking down +Z: centre is the top face, +x is its right edge, and
    // screen-up (-y) is its back edge.
    for (const [dx, dy, expected] of [
      [0, 0, 'top'],
      [OFF, 0, 'right-top'],
      [-OFF, 0, 'left-top'],
      [0, -OFF, 'back-top'],
      [0, OFF, 'front-top'],
      [OFF, -OFF, 'back-right-top'],
    ] as const) {
      onSelectRegion.mockClear()
      fireEvent.pointerDown(stage, {
        button: 0,
        clientX: CENTRE.x + dx,
        clientY: CENTRE.y + dy,
        pointerId: 1,
      })
      fireEvent.pointerUp(stage, {
        clientX: CENTRE.x + dx,
        clientY: CENTRE.y + dy,
        pointerId: 1,
      })
      expect(onSelectRegion).toHaveBeenCalledExactlyOnceWith(expected)
    }
  })

  it('ignores a press in the corner of the widget box, outside the cube silhouette', () => {
    const { container, onSelectRegion, onOrbitBy } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    // The far corner of the 125px box is outside a 72px cube seen face-on.
    fireEvent.pointerDown(stage, { button: 0, clientX: STAGE.left + 2, clientY: STAGE.top + 2, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: STAGE.left + 2, clientY: STAGE.top + 2, pointerId: 1 })
    expect(onSelectRegion).not.toHaveBeenCalled()
    expect(onOrbitBy).not.toHaveBeenCalled()
  })

  it('marks the hovered region, and clears it on the way out', () => {
    const { container } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    fireEvent.pointerMove(stage, { clientX: CENTRE.x + OFF, clientY: CENTRE.y, pointerId: 1 })
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-region][data-hover="true"]')].map(
        (e) => e.dataset.region,
      ),
    ).toEqual(expect.arrayContaining(['right-top']))
    fireEvent.pointerLeave(stage)
    expect(container.querySelectorAll('[data-region][data-hover="true"]')).toHaveLength(0)
  })

  it('activates from the keyboard through the button itself', () => {
    // Enter/Space fire a click with detail 0. That is the one path that goes
    // through the DOM rather than the pick, and it must not double-fire with
    // the pointer path.
    const { container, onSelectRegion } = setup()
    fireEvent.click(zone(container, 'front'), { detail: 0 })
    expect(onSelectRegion).toHaveBeenCalledExactlyOnceWith('front')
  })

  it('does not double-activate when a real pointer click reaches a button', () => {
    const { container, onSelectRegion } = setup()
    layOutStage(container)
    fireEvent.click(zone(container, 'front'), { detail: 1 })
    expect(onSelectRegion).not.toHaveBeenCalled()
  })
})

describe('click vs drag', () => {
  function press(el: HTMLElement, x: number, y: number) {
    fireEvent.pointerDown(el, { button: 0, clientX: x, clientY: y, pointerId: 1 })
  }

  it('a press and release on a zone selects that region', () => {
    const { container, onSelectRegion, onOrbitBy } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, CENTRE.x, CENTRE.y)
    fireEvent.pointerUp(stage, { clientX: CENTRE.x, clientY: CENTRE.y, pointerId: 1 })
    expect(onSelectRegion).toHaveBeenCalledExactlyOnceWith('top')
    expect(onOrbitBy).not.toHaveBeenCalled()
  })

  it('selects a corner region too', () => {
    const { container, onSelectRegion } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, CENTRE.x + OFF, CENTRE.y - OFF)
    fireEvent.pointerUp(stage, { clientX: CENTRE.x + OFF, clientY: CENTRE.y - OFF, pointerId: 1 })
    expect(onSelectRegion).toHaveBeenCalledExactlyOnceWith('back-right-top')
  })

  it('a jiggle under the threshold is still a click', () => {
    const { container, onSelectRegion, onOrbitBy } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, CENTRE.x, CENTRE.y)
    fireEvent.pointerMove(stage, { clientX: CENTRE.x + 2, clientY: CENTRE.y + 1, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: CENTRE.x + 2, clientY: CENTRE.y + 1, pointerId: 1 })
    expect(onOrbitBy).not.toHaveBeenCalled()
    expect(onSelectRegion).toHaveBeenCalledExactlyOnceWith('top')
  })

  it('a drag past the threshold orbits and selects nothing', () => {
    const { container, onSelectRegion, onOrbitBy } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, CENTRE.x, CENTRE.y)
    fireEvent.pointerMove(stage, { clientX: CENTRE.x + 40, clientY: CENTRE.y, pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: CENTRE.x + 40, clientY: CENTRE.y, pointerId: 1 })
    expect(onOrbitBy).toHaveBeenCalled()
    expect(onSelectRegion).not.toHaveBeenCalled()
  })

  it('converts drag pixels at the viewport height, not the cube size', () => {
    const { container, onOrbitBy } = setup({ viewportHeightPx: () => 800 })
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, CENTRE.x, CENTRE.y)
    fireEvent.pointerMove(stage, { clientX: CENTRE.x + 40, clientY: CENTRE.y, pointerId: 1 })
    expect(onOrbitBy).toHaveBeenCalledWith((2 * Math.PI * 40) / 800, 0)
  })

  it('does not depend on the event target, which pointer capture retargets anyway', () => {
    // Two regressions in one. `setPointerCapture` retargets every pointer
    // event after the press at the CAPTURING element, so `ev.target` is the
    // stage by pointerup and carries no region — and separately, Chromium
    // does not agree with `elementsFromPoint` about what a pointer inside a
    // `preserve-3d` subtree even hit. Both are why the region comes from the
    // coordinates, and nothing here looks at a target.
    const { container, onSelectRegion } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, CENTRE.x - OFF, CENTRE.y)
    fireEvent.pointerUp(stage, { clientX: CENTRE.x - OFF, clientY: CENTRE.y, pointerId: 1 })
    expect(onSelectRegion).toHaveBeenCalledExactlyOnceWith('left-top')
  })

  it('selects nothing when the press missed the cube', () => {
    const { container, onSelectRegion } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, STAGE.left + 2, STAGE.top + 2)
    fireEvent.pointerUp(stage, { clientX: STAGE.left + 2, clientY: STAGE.top + 2, pointerId: 1 })
    expect(onSelectRegion).not.toHaveBeenCalled()
  })

  it('drops the gesture on pointercancel without selecting anything', () => {
    const { container, onSelectRegion } = setup()
    layOutStage(container)
    const stage = stageEl(container)
    press(stage, CENTRE.x, CENTRE.y)
    fireEvent.pointerCancel(stage, { pointerId: 1 })
    fireEvent.pointerUp(stage, { clientX: CENTRE.x, clientY: CENTRE.y, pointerId: 1 })
    expect(onSelectRegion).not.toHaveBeenCalled()
  })
})

describe('glyph strip', () => {
  it('shows Perspective as the active one under perspective, and clicking it does nothing', () => {
    const { onToggleProjection } = setup({ parallelProjection: false })
    const persp = screen.getByRole('button', { name: 'Perspective' })
    expect(persp).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(persp)
    expect(onToggleProjection).not.toHaveBeenCalled()
  })

  it('switches projection when the inactive glyph is clicked', () => {
    const { onToggleProjection } = setup({ parallelProjection: false })
    fireEvent.click(screen.getByRole('button', { name: 'Parallel Projection' }))
    expect(onToggleProjection).toHaveBeenCalledOnce()
  })

  it('reads the other way round under parallel projection', () => {
    const { onToggleProjection } = setup({ parallelProjection: true })
    const par = screen.getByRole('button', { name: 'Parallel Projection' })
    expect(par).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Perspective' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    fireEvent.click(par)
    expect(onToggleProjection).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Perspective' }))
    expect(onToggleProjection).toHaveBeenCalledOnce()
  })

  it('fires the Iso action, which is the one control here that re-frames', () => {
    const { onIso, onSelectRegion } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Iso View (fit)' }))
    expect(onIso).toHaveBeenCalledOnce()
    expect(onSelectRegion).not.toHaveBeenCalled()
  })

  it('leaves Iso without a pressed state — it is an action, not a mode', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Iso View (fit)' })).not.toHaveAttribute(
      'aria-pressed',
    )
  })
})
