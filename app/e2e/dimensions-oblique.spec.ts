import { test, expect } from '@playwright/test'

/**
 * Linear-dimension WORKING PLANE from oblique cameras — end-to-end, driven
 * with the real three-click gesture (real mouse events, real inference
 * snapping) from a genuinely oblique ISO camera, asserting on what the user
 * actually SEES (rendered pixels of the dimension line and its extension
 * lines, plus the label's world position) — not merely on the committed
 * record's fields.
 *
 * Why this spec exists (the angle-dimensions defect): the tool used to build
 * the drag-out offset in the SCREEN-PARALLEL plane through the baseline
 * ("view-facing", the component of the view direction perpendicular to the
 * baseline). From an ISO camera that plane's in-plane offset direction is a
 * 45-degree WORLD diagonal — e.g. baseline along X viewed from the standard
 * ISO puts the offset along (0, 1, 1)/sqrt(2) — so committed dimensions
 * floated off at 45 degrees to everything in the model, matching nothing.
 * From a top/front/side view the screen-parallel plane happens to COINCIDE
 * with an axis plane, which is exactly why every axis-aligned-camera test
 * passed while the defect shipped. The corrected rule places the dimension
 * in an AXIS-ALIGNED plane through the baseline (or the arrow-key-locked
 * one), chosen by where the cursor ray lands — see
 * `annotationLayout.axisDimensionPlane`.
 *
 * Methodology notes (both are documented traps in this suite):
 *  - `pixelColorAt`/`captureFrame` render OUT OF BAND and do NOT run the
 *    per-frame annotation update — a real frame yield (`nextFrame`, two rAFs)
 *    is required after any camera/scene change before sampling pixels, or
 *    the samples reflect a stale annotation pose (dimensions-depth.spec.ts).
 *  - A single reference pixel can land inside the dimension line's own
 *    label gap — always scan several points and keep the best
 *    (dimensions-depth.spec.ts's multi-point methodology).
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test.skip(({ browserName }) => browserName !== 'chromium', 'pixel sampling is only stable on pinned SwiftShader')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
})

/** Wait for a REAL animation frame (two rAFs — see dimensions-depth.spec.ts's
 * `nextFrame` doc comment for why two, and why sampling without this reads a
 * stale annotation pose). */
function nextFrame(page: import('@playwright/test').Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

/** Best (largest) per-channel color delta from `background` over a scan of
 * world-space sample points along the segment `from`..`to` (endpoints
 * excluded; the label gap around the midpoint is skated over by keeping the
 * best of many samples — the multi-point methodology from
 * dimensions-depth.spec.ts). */
async function scanDelta(
  page: import('@playwright/test').Page,
  from: [number, number, number],
  to: [number, number, number],
  background: { r: number; g: number; b: number },
  samples = 16,
): Promise<number> {
  return page.evaluate(
    ([from, to, background, samples]) => {
      const t = window.__hew_test!
      let best = -Infinity
      for (let i = 1; i < samples; i++) {
        const f = i / samples
        const p: [number, number, number] = [
          from[0] + (to[0] - from[0]) * f,
          from[1] + (to[1] - from[1]) * f,
          from[2] + (to[2] - from[2]) * f,
        ]
        const c = t.pixelColorAt(p)
        if (c === null) continue
        const d = Math.abs(c.r - background.r) + Math.abs(c.g - background.g) + Math.abs(c.b - background.b)
        if (d > best) best = d
      }
      return best
    },
    [from, to, background, samples] as [
      [number, number, number],
      [number, number, number],
      { r: number; g: number; b: number },
      number,
    ],
  )
}

/** Shared scene + gesture helpers: a 2x1x2 box, the standard ISO camera, and
 * the projected-world-point click helper from dimensions-text.spec.ts. */
async function setupScene(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    t.drawBox([0, 0, 0], [2, 1, 0], 2)
    // A genuinely oblique ISO pose — no view axis aligned with any world
    // axis. This is precisely the camera family every pre-existing dimension
    // test avoided, and where the defect lived.
    t.setCamera({ position: [8, -8, 8], target: [1, 1, 1], fovDeg: 45 })
  })
  await nextFrame(page)
  const canvas = await page.locator('canvas').first().boundingBox()
  if (canvas === null) throw new Error('no canvas')
  const toPage = async (world: [number, number, number]) => {
    const p = await page.evaluate(
      (w) => window.__hew_test!.worldToScreen(w as [number, number, number]),
      world,
    )
    return { x: canvas.x + p.x, y: canvas.y + p.y }
  }
  const click = async (pt: { x: number; y: number }) => {
    await page.mouse.move(pt.x, pt.y)
    await page.mouse.down()
    await page.mouse.up()
  }
  return { toPage, click }
}

test('ISO camera: dragging a dimension above a top edge lands it in the VERTICAL axis plane through the edge — extension lines rise vertically, no 45-degree diagonal', async ({ page }) => {
  const { toPage, click } = await setupScene(page)

  await page.getByRole('radio', { name: 'Dimension' }).click()
  // Baseline: the box's top front edge, (0,0,2) -> (2,0,2), clicked for real
  // so inference snapping resolves the actual corners.
  await click(await toPage([0, 0, 2]))
  await expect(page.getByText('Click the second point.')).toBeVisible()
  await click(await toPage([2, 0, 2]))
  await expect(page.getByText('Drag out the dimension line', { exact: false })).toBeVisible()
  // Drag straight above the edge's midpoint — the cursor ray passes through
  // world (1, 0, 3.2). The correct working plane is the vertical axis plane
  // y=0 through the baseline: offset (0, 0, 1.2), dimension line
  // (0,0,3.2)->(2,0,3.2). The defective view-facing rule instead offsets
  // along the screen-parallel diagonal (0, ~0.64, ~0.82)·k.
  await click(await toPage([1, 0, 3.2]))

  const id = await page.evaluate(() => window.__hew_test!.getAnnotationIds()[0])
  expect(id).toBeTruthy()

  // The label rides the dimension line — with the axis-plane rule it stays in
  // the baseline's own vertical plane (y = 0), never on the 45-degree
  // diagonal (which puts it at y ≈ +0.6 for this drag).
  const labelPos = await page.evaluate((i) => window.__hew_test!.getAnnotationTextWorldPosition(i), id)
  expect(labelPos).not.toBeNull()
  expect(Math.abs(labelPos![1])).toBeLessThan(0.05)
  expect(labelPos![2]).toBeGreaterThan(2.5)

  // Pixel truth, after a REAL frame: the dimension line and both extension
  // lines are actually inked where the vertical-plane dimension draws them.
  await nextFrame(page)
  const background = await page.evaluate(() => window.__hew_test!.pixelColorAt([-1.2, 0, 3.6])!)
  const lineDelta = await scanDelta(page, [0, 0, 3.2], [2, 0, 3.2], background)
  // Extension lines rise VERTICALLY (+Z) from the anchors — sample their
  // upper halves, clear of the box's own top-edge ink at z=2.
  const extA = await scanDelta(page, [0, 0, 2.4], [0, 0, 3.1], background, 8)
  const extB = await scanDelta(page, [2, 0, 2.4], [2, 0, 3.1], background, 8)
  expect(lineDelta, 'dimension line inked along (0,0,3.2)->(2,0,3.2)').toBeGreaterThan(30)
  expect(extA, 'extension line inked vertically above anchor A').toBeGreaterThan(30)
  expect(extB, 'extension line inked vertically above anchor B').toBeGreaterThan(30)
})

test('ISO camera: ArrowUp mid-gesture locks the blue (flat) plane — the same drag now lays the dimension down flat, honoring the draw tools\' arrow convention', async ({ page }) => {
  const { toPage, click } = await setupScene(page)

  await page.getByRole('radio', { name: 'Dimension' }).click()
  await click(await toPage([0, 0, 2]))
  await click(await toPage([2, 0, 2]))
  await expect(page.getByText('Drag out the dimension line', { exact: false })).toBeVisible()

  // Arrow convention shared with the draw tools: an arrow picks the PLANE'S
  // OWN AXIS (its normal) — ArrowUp = blue/Z = the flat plane.
  await page.keyboard.press('ArrowUp')
  await expect(page.getByText(/locked to the blue plane/i)).toBeVisible()

  // The SAME screen drag as the unlocked test — but the lock forces the flat
  // plane z=2 through the baseline: the cursor ray through world (1,0,3.2)
  // pierces it at (-0.75, 2, 2), so offset = (0, 2, 0) and the dimension
  // line is (0,2,2)->(2,2,2), lying flat past the box.
  await click(await toPage([1, 0, 3.2]))

  const id = await page.evaluate(() => window.__hew_test!.getAnnotationIds()[0])
  expect(id).toBeTruthy()
  const labelPos = await page.evaluate((i) => window.__hew_test!.getAnnotationTextWorldPosition(i), id)
  expect(labelPos).not.toBeNull()
  // Flat: the label stays AT the baseline's own height, offset horizontally.
  expect(Math.abs(labelPos![2] - 2)).toBeLessThan(0.05)
  expect(labelPos![1]).toBeGreaterThan(1.4)

  await nextFrame(page)
  const background = await page.evaluate(() => window.__hew_test!.pixelColorAt([-1.2, 2, 2])!)
  const lineDelta = await scanDelta(page, [0, 2, 2], [2, 2, 2], background)
  // Extension lines run HORIZONTALLY (+Y) from the anchors — sample beyond
  // the box's own top face (y > 1) so only annotation ink can be there.
  const extA = await scanDelta(page, [0, 1.3, 2], [0, 1.9, 2], background, 8)
  const extB = await scanDelta(page, [2, 1.3, 2], [2, 1.9, 2], background, 8)
  expect(lineDelta, 'dimension line inked along (0,2,2)->(2,2,2)').toBeGreaterThan(30)
  expect(extA, 'extension line inked flat past anchor A').toBeGreaterThan(30)
  expect(extB, 'extension line inked flat past anchor B').toBeGreaterThan(30)
})

// Design v1.1 Lane E "Dimensions on-plane": a Top-view/Parallel-Projection
// dimension's SECOND point used to be free to fall through to the literal
// ground plane (z=0) whenever nothing was under the cursor there — sliding
// a wall-top measurement down to the ground underneath it. `have-a` now
// freezes a gesture plane from the FIRST click (here, straight down, the
// flat z-height plane through the wall's own top) and projects the second
// point onto it.
test('Top view (Parallel Projection): a dimension across a wall top has BOTH endpoints at the wall height, never the ground', async ({
  page,
}) => {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    // A "wall": a 3m x 0.3m slab, top at z = 2.
    t.drawBox([0, 0, 0], [3, 0.3, 0], 2)
    // Straight down, no view axis picking a lucky plane by coincidence —
    // the exact pose this fix targets.
    t.setCamera({ position: [1.5, 0.15, 50], target: [1.5, 0.15, 0], up: [0, 1, 0], fovDeg: 45 })
  })
  await page.getByRole('button', { name: 'Camera' }).click()
  await page.getByText('Parallel Projection').click()
  await nextFrame(page)

  const canvas = await page.locator('canvas').first().boundingBox()
  if (canvas === null) throw new Error('no canvas')
  const toPage = async (world: [number, number, number]) => {
    const p = await page.evaluate(
      (w) => window.__hew_test!.worldToScreen(w as [number, number, number]),
      world,
    )
    return { x: canvas.x + p.x, y: canvas.y + p.y }
  }
  const click = async (pt: { x: number; y: number }) => {
    await page.mouse.move(pt.x, pt.y)
    await page.mouse.down()
    await page.mouse.up()
  }

  await page.getByRole('radio', { name: 'Dimension' }).click()
  // First click: the wall's own top-left corner, a real Endpoint.
  await click(await toPage([0, 0, 2]))
  await expect(page.getByText('Click the second point.')).toBeVisible()
  // Second click: well PAST the wall's far end (x=3) — from directly
  // overhead, nothing is under the cursor there at all, so the kernel snap
  // misses entirely and SnapService falls back to the literal ground plane
  // (z=0, pre-fix). The have-a freeze projects that fallback onto the
  // wall's own z=2 plane instead.
  await click(await toPage([4.5, 0.15, 2]))
  await expect(page.getByText('Drag out the dimension line', { exact: false })).toBeVisible()
  // Drag sideways, still in the SAME flat plane — the offset stays
  // horizontal, so the drawn line's own endpoints (a1/b1) sit at exactly
  // the anchors' own height too.
  await click(await toPage([2, 1, 2]))

  const id = await page.evaluate(() => window.__hew_test!.getAnnotationIds()[0])
  expect(id).toBeTruthy()
  const endpoints = await page.evaluate((i) => window.__hew_test!.getLinearDimensionEndpoints(i), id)
  expect(endpoints).not.toBeNull()
  expect(endpoints!.a1[2]).toBeCloseTo(2, 5)
  expect(endpoints!.b1[2]).toBeCloseTo(2, 5)
})

// Maintainer playtest: a Top-view, Parallel-Projection dimension across a
// framed wall's corner had every endpoint — slab, sole plate, stud top, top
// plates — stacked straight down the view ray. The frozen have-a plane is
// horizontal at the first click's height, but the old code honored ANY
// precise (endpoint/midpoint/center/quadrant/intersection) snap off that
// plane unconditionally — so the second click could resolve to a DIFFERENT
// stacked point (invisible from directly overhead) and commit a
// non-coplanar dimension with no visible cue. The fix: an off-plane precise
// point is honored only when its own displacement off the plane is actually
// VISIBLE from the camera (`DimensionTool._offPlaneDisplacementVisible`) —
// a Top-view vertical displacement never is.
test('Top view (Parallel Projection), stacked corner: a dimension aimed at a corner with several endpoints along the view ray stays coplanar at the first click\'s height', async ({
  page,
}) => {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    // Box A: a 3x3x1 slab, top at z=1.
    t.drawBox([0, 0, 0], [3, 3, 0], 1)
    // Box B: a 1x1x1 block floating ABOVE box A, sharing box A's (0,0) top
    // corner's x/y — its own top corner (0,0,2.5) sits directly over box
    // A's top corner (0,0,1), several endpoints stacked along one vertical
    // column: box A's top (z=1), box B's base (z=1.5), box B's top (z=2.5).
    const b = t.drawBox([0, 0, 0], [1, 1, 0], 1)
    t.moveObject(b, 0, 0, 1.5)
    // Straight down, world-Z up, eye a hair off the pole (harness convention
    // for a stable Top-view pose under an orbit-style camera rig).
    t.setCamera({ position: [1.5, 1.47, 30], target: [1.5, 1.5, 0], up: [0, 0, 1] })
  })
  await page.getByRole('button', { name: 'Camera' }).click()
  await page.getByText('Parallel Projection').click()
  await nextFrame(page)

  const canvas = await page.locator('canvas').first().boundingBox()
  if (canvas === null) throw new Error('no canvas')
  const toPage = async (world: [number, number, number]) => {
    const p = await page.evaluate(
      (w) => window.__hew_test!.worldToScreen(w as [number, number, number]),
      world,
    )
    return { x: canvas.x + p.x, y: canvas.y + p.y }
  }
  const click = async (pt: { x: number; y: number }) => {
    await page.mouse.move(pt.x, pt.y)
    await page.mouse.down()
    await page.mouse.up()
  }

  await page.getByRole('radio', { name: 'Dimension' }).click()
  // First click: box A's FAR top corner — freezes the horizontal plane z=1.
  await click(await toPage([3, 3, 1]))
  await expect(page.getByText('Click the second point.')).toBeVisible()
  // Second click: aimed straight down the stacked column at (0,0) — from
  // directly overhead this resolves to box B's own top corner (0,0,2.5),
  // a real, precise Endpoint whose entire displacement off the z=1 plane
  // runs along the view ray (invisible) — it must be projected, not honored.
  await click(await toPage([0, 0, 2.5]))
  await expect(page.getByText('Drag out the dimension line', { exact: false })).toBeVisible()
  await click(await toPage([1.5, 3.5, 1]))

  const id = await page.evaluate(() => window.__hew_test!.getAnnotationIds()[0])
  expect(id).toBeTruthy()
  const endpoints = await page.evaluate((i) => window.__hew_test!.getLinearDimensionEndpoints(i), id)
  expect(endpoints).not.toBeNull()
  // Both anchors (offset already applied) sit at the FIRST click's own
  // height — never box B's own z=2.5.
  expect(endpoints!.a1[2]).toBeCloseTo(1, 5)
  expect(endpoints!.b1[2]).toBeCloseTo(1, 5)
})

// Maintainer playtest (UX finding): while a plane lock is active, the
// in-progress rubber-band lines should be colored by the lock's own axis
// color (the same red/green/blue the draw tools' locked previews use), not
// the tool's ordinary neutral blue — so the lock's effect is visible while
// still dragging, not just after the fact.
test('ArrowRight lock colors the in-progress dimension line red — the plane-lock color, not the neutral blue preview', async ({ page }) => {
  const { toPage, click } = await setupScene(page)

  await page.getByRole('radio', { name: 'Dimension' }).click()
  // Baseline: the box's own vertical front-left edge (0,0,0)->(0,0,2) — a
  // Z-direction baseline, so the RED (X-normal) plane lock is usable (⟂ to
  // the baseline; an X lock on an X baseline would be degenerate instead).
  await click(await toPage([0, 0, 0]))
  await click(await toPage([0, 0, 2]))
  await expect(page.getByText('Drag out the dimension line', { exact: false })).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(page.getByText(/locked to the red plane/i)).toBeVisible()

  // Aim exactly ON the locked plane (x=0, free space clear of the box,
  // whose own footprint stops at y=1) so the drag's offset is predictable:
  // (0,2,0) — the previewed dimension line runs (0,2,0)->(0,2,2).
  const hover = await toPage([0, 2, 1])
  await page.mouse.move(hover.x, hover.y)

  await nextFrame(page)
  const background = await page.evaluate(() => window.__hew_test!.pixelColorAt([0, 3, 1])!)
  const lineColor = await page.evaluate(() => window.__hew_test!.pixelColorAt([0, 2, 1]))
  expect(lineColor).not.toBeNull()
  const delta =
    Math.abs(lineColor!.r - background.r) + Math.abs(lineColor!.g - background.g) + Math.abs(lineColor!.b - background.b)
  expect(delta, 'the locked preview line is actually inked at (0,2,1)').toBeGreaterThan(20)
  // Red-dominant ink — clearly NOT the neutral preview blue (0x4d90ff /
  // 0xe85a60-ish red is the opposite channel relationship).
  expect(lineColor!.r).toBeGreaterThan(lineColor!.b)
})
