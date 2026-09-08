import { test, expect } from '@playwright/test'

/**
 * DimensionTool's dimension-row alignment snap (SketchUp parity, maintainer
 * playtest finding 3) — end-to-end, driven with real mouse events through
 * the actual three-click gesture: placing a SECOND linear dimension along
 * the same wall line as an already-committed one, with the second dimension
 * line's drag passing within a few screen pixels of the first's own line,
 * snaps the new dimension collinear with it, so a row of dimensions lines
 * up exactly the way it does in SketchUp.
 *
 * `annotation_anchor_point`/`annotation_offset`/`annotation_plane` already
 * exist on the wasm-api Scene (no new wasm-api surface was needed for this
 * feature — `DimensionTool._alignmentCandidates` reads the existing
 * accessors directly), so this exercises the real kernel end to end, not a
 * mock.
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

function nextFrame(page: import('@playwright/test').Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

test('placing a second dimension along the same wall line, with the drag passing near the first dimension\'s own line, snaps it collinear', async ({
  page,
}) => {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    // A "wall": a 6m x 0.3m slab, top edge at z = 2, running along +X.
    t.drawBox([0, 0, 0], [6, 0.3, 0], 2)
    // Top view, straight down — the same pose the existing Top-view
    // dimension specs use (world-Y up, eye directly overhead).
    t.setCamera({ position: [3, 0.15, 50], target: [3, 0.15, 0], up: [0, 1, 0], fovDeg: 45 })
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

  // First dimension: the wall top's left half, (0,0,2) -> (3,0,2), dragged
  // out to y = 1.
  await click(await toPage([0, 0, 2]))
  await expect(page.getByText('Click the second point.')).toBeVisible()
  await click(await toPage([3, 0, 2]))
  await expect(page.getByText('Drag out the dimension line', { exact: false })).toBeVisible()
  await click(await toPage([1.5, 1, 2]))

  const firstId = await page.evaluate(() => window.__hew_test!.getAnnotationIds()[0])
  expect(firstId).toBeTruthy()
  const firstEndpoints = await page.evaluate((i) => window.__hew_test!.getLinearDimensionEndpoints(i), firstId)
  expect(firstEndpoints).not.toBeNull()
  expect(firstEndpoints!.a1[1]).toBeCloseTo(1, 3)

  // Second dimension: the wall top's right half, (3,0,2) -> (6,0,2) —
  // dragged to y = 1.02, a couple of pixels off the FIRST dimension's own
  // line at this zoom, well within the 12px acquire radius.
  await click(await toPage([3, 0, 2]))
  await expect(page.getByText('Click the second point.')).toBeVisible()
  await click(await toPage([6, 0, 2]))
  await expect(page.getByText('Drag out the dimension line', { exact: false })).toBeVisible()
  const nearFirstLine = await toPage([4.5, 1.02, 2])
  await page.mouse.move(nearFirstLine.x, nearFirstLine.y)
  await expect(page.getByText('Aligned', { exact: false })).toBeVisible()
  await click(nearFirstLine)

  const ids = await page.evaluate(() => window.__hew_test!.getAnnotationIds())
  expect(ids.length).toBe(2)
  const secondId = ids.find((i) => i !== firstId)
  expect(secondId).toBeTruthy()
  const secondEndpoints = await page.evaluate((i) => window.__hew_test!.getLinearDimensionEndpoints(i), secondId!)
  expect(secondEndpoints).not.toBeNull()

  // Collinear with the first dimension's own line: same y, and both flat at
  // the wall's own height.
  expect(secondEndpoints!.a1[1]).toBeCloseTo(1, 3)
  expect(secondEndpoints!.b1[1]).toBeCloseTo(1, 3)
  expect(secondEndpoints!.a1[1]).toBeCloseTo(firstEndpoints!.b1[1], 3)
})
