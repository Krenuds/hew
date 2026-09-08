import { test, expect } from '@playwright/test'

/**
 * LineTool's from-point closing inference (module doc — SketchUp's classic
 * "draw three sides of a square, the fourth snaps shut") — end to end,
 * driven with real mouse events and real arrow-key axis locks through the
 * actual four-click gesture:
 *
 *   A(0,0,0) --green--> B(0,2,0) --red--> C(2,2,0) --green(inferred)--> D
 *
 * The third segment (from C) is locked green (heading back toward -Y) with
 * no precise kernel snap anywhere nearby; hovering a couple of centimeters
 * off the true closing point D=(2,0,0) — well inside LineTool's 8px acquire
 * radius — must resolve to the "From Point" inference (a dashed guide line
 * from A along red, per the module doc) rather than the raw, unsnapped
 * point under the cursor. The click there commits exactly at D, and the
 * fourth segment (an ordinary precise endpoint snap onto A, needing no
 * inference at all) closes the loop into one region — a true square, all
 * four corners exact.
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

test('drawing a square with the Line tool: the third (locked) segment closing-infers the fourth corner from an earlier vertex', async ({
  page,
}) => {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    // Top-down, parallel-projection view (same camera shape as
    // dimensions-align.spec.ts's proven pixel-acquire setup) centered on the
    // square being drawn.
    t.setCamera({ position: [1, 1, 50], target: [1, 1, 0], up: [0, 1, 0], fovDeg: 45 })
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

  await page.getByRole('radio', { name: 'Line' }).click()

  // A
  await click(await toPage([0, 0, 0]))
  // Lock green (Y) for A -> B.
  await page.keyboard.press('ArrowLeft')
  await click(await toPage([0, 2, 0])) // B
  // Lock red (X) for B -> C.
  await page.keyboard.press('ArrowRight')
  await click(await toPage([2, 2, 0])) // C
  // Lock green again — the third segment heads back down (-Y) from C.
  await page.keyboard.press('ArrowLeft')

  // Hover 2 cm off the true closing point D=(2,0,0) — well inside the 8px
  // acquire radius at this zoom (mirrors dimensions-align.spec.ts's own
  // proven 2cm offset for its 12px radius).
  const nearD = await toPage([2, 0.02, 0])
  await page.mouse.move(nearD.x, nearD.y)
  await expect(page.getByText('From Point', { exact: false })).toBeVisible()
  await click(nearD) // commits C -> D, snapped to (2, 0, 0) — not the raw hover point

  // Fourth segment: lock red toward A and close the loop — an ORDINARY
  // precise endpoint snap onto the real A vertex, no inference needed.
  await page.keyboard.press('ArrowRight')
  await click(await toPage([0, 0, 0]))

  const result = await page.evaluate(() => {
    const t = window.__hew_test!
    const sketchIds = t.getSketchIds()
    const sketch = sketchIds[0]
    return {
      lastError: t.getLastError(),
      sketchIds,
      regionCount: t.getSketchRegionCount(sketch),
      lines: t.getSketchLines(sketch),
    }
  })

  expect(result.lastError).toBeNull()
  expect(result.sketchIds).toHaveLength(1) // one ground sketch throughout
  expect(result.regionCount).toBe(1) // one closed, extrudable region

  // Every one of the 4 edges' endpoints (24 floats: 4 edges x 2 points x 3
  // floats) is one of the square's 4 exact corners, and all 4 corners are
  // present — a true square, not an open or malformed chain.
  const expectedCorners: [number, number, number][] = [
    [0, 0, 0], [0, 2, 0], [2, 2, 0], [2, 0, 0],
  ]
  const seen = new Set<number>()
  for (let i = 0; i < result.lines.length; i += 3) {
    const p: [number, number, number] = [result.lines[i], result.lines[i + 1], result.lines[i + 2]]
    const idx = expectedCorners.findIndex(
      (c) => Math.abs(c[0] - p[0]) < 0.02 && Math.abs(c[1] - p[1]) < 0.02 && Math.abs(c[2] - p[2]) < 0.02,
    )
    expect(idx, `point (${p.join(',')}) is not one of the square's exact corners`).toBeGreaterThanOrEqual(0)
    seen.add(idx)
  }
  expect(seen.size).toBe(4) // all four corners present, incl. the inferred D
})
