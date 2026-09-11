import { test, expect } from '@playwright/test'

/**
 * Push/Pull past a co-facing wall, both ways. On a P-shaped slab (a stem
 * with a wider bowl), pushing the bowl's end in past the stem's end notches
 * the stem (the subtract route), and pulling a face out past a co-facing
 * wall ahead of it grows the material straight through (the union route):
 * the stem pulled past the bowl's end, or the notched bowl pulled back out
 * to where it started. The flat translate path could only refuse the pulls
 * as non-manifold.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
})

// Stem x 0..0.5 × y 0..2, bowl x 0.5..1 × y 1..2, 0.2 tall.
const STEM_X = 0.5
const BOWL_X = 1.0
const BOWL_Y = 1.0
const TOP_Y = 2.0
const H = 0.2

async function settle(page: import('@playwright/test').Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

async function pSlab(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    t.setCamera({ position: [0.5, 1, 8], target: [0.5, 1, 0], up: [0, 1, 0], fovDeg: 45 })
  })
  await settle(page)
  const canvas = (await page.locator('canvas').first().boundingBox())!
  const toPage = async (w: [number, number, number]) => {
    const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w as [number, number, number]), w)
    return { x: canvas.x + p.x, y: canvas.y + p.y }
  }
  const click = async (w: [number, number, number]) => {
    const p = await toPage(w)
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.up()
  }
  // The profile goes in through the harness so its corners are exact (a
  // clicked outline lands a few 1e-7 m off axis, which turns the pushes
  // below into sliver-producing booleans); the pushes are real tool clicks.
  const state = await page.evaluate(
    ({ STEM_X, BOWL_X, BOWL_Y, TOP_Y, H }) => {
      const t = window.__hew_test!
      const { sketch, regions } = t.drawLineChain([
        [0, 0, 0],
        [STEM_X, 0, 0],
        [STEM_X, BOWL_Y, 0],
        [BOWL_X, BOWL_Y, 0],
        [BOWL_X, TOP_Y, 0],
        [0, TOP_Y, 0],
        [0, 0, 0],
      ])
      t.extrudeRegion(sketch, regions[0], H)
      const ids = t.getObjectIds()
      return { err: t.getLastError(), ids, bounds: ids.length === 1 ? t.getObjectBounds(ids[0]) : null }
    },
    { STEM_X, BOWL_X, BOWL_Y, TOP_Y, H },
  )
  expect(state.err).toBeNull()
  expect(state.ids).toHaveLength(1)
  expect(state.bounds![3]).toBeCloseTo(BOWL_X, 5)
  expect(state.bounds![5]).toBeCloseTo(H, 5)
  return { toPage, click }
}

/** Look at the slab from the east so the east-facing ends are under the cursor. */
async function lookFromEast(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    window.__hew_test!.setCamera({ position: [8, 1, 0.1], target: [0, 1, 0.1], up: [0, 0, 1], fovDeg: 45 })
  })
  await settle(page)
}

async function pushPull(
  page: import('@playwright/test').Page,
  click: (w: [number, number, number]) => Promise<void>,
  at: [number, number, number],
  distance: number,
) {
  await page.getByRole('radio', { name: 'Push/Pull' }).click()
  await click(at)
  await page.keyboard.type(String(distance))
  await page.keyboard.press('Enter')
  return page.evaluate(() => {
    const t = window.__hew_test!
    const ids = t.getObjectIds()
    return { err: t.getLastError(), ids, bounds: ids.length === 1 ? t.getObjectBounds(ids[0]) : null }
  })
}

test('pulling the stem past the bowl end grows it straight through', async ({ page }) => {
  const { click } = await pSlab(page)
  await lookFromEast(page)
  const after = await pushPull(page, click, [STEM_X, 0.5, H / 2], 0.8)
  expect(after.err).toBeNull()
  expect(after.ids).toHaveLength(1)
  expect(after.bounds![3]).toBeCloseTo(STEM_X + 0.8, 5)
  expect(after.bounds![4]).toBeCloseTo(TOP_Y, 5)
  // The bowl kept its own end (nothing of it lies east of x = 1.1) while
  // the stem row now has material out past x = 1.1.
  const hits = await page.evaluate(() => {
    const t = window.__hew_test!
    return {
      bowlBeyond: t.pickFace([1.1, 1.5, 0.1], [1, 0, 0]),
      bowlEnd: t.pickFace([1.1, 1.5, 0.1], [-1, 0, 0]),
      stemBeyond: t.pickFace([1.5, 0.5, 0.1], [-1, 0, 0]),
    }
  })
  expect(hits.bowlBeyond).toBeNull()
  expect(hits.bowlEnd).not.toBeNull()
  expect(hits.stemBeyond).not.toBeNull()
})

test('pushing the bowl in past the stem and pulling it back restores the slab', async ({ page }) => {
  const { click } = await pSlab(page)
  await lookFromEast(page)
  const notched = await pushPull(page, click, [BOWL_X, 1.5, H / 2], -0.8)
  expect(notched.err).toBeNull()
  expect(notched.ids).toHaveLength(1)
  expect(notched.bounds![3]).toBeCloseTo(STEM_X, 5)
  // The bowl's end now sits inside the stem's footprint: nothing of the
  // bowl row lies east of x = 0.3.
  const bowlNow = await page.evaluate(() => window.__hew_test!.pickFace([0.3, 1.5, 0.1], [1, 0, 0]))
  expect(bowlNow).toBeNull()

  const restored = await pushPull(page, click, [BOWL_X - 0.8, 1.5, H / 2], 0.8)
  expect(restored.err).toBeNull()
  expect(restored.ids).toHaveLength(1)
  expect(restored.bounds![3]).toBeCloseTo(BOWL_X, 5)
  expect(restored.bounds![4]).toBeCloseTo(TOP_Y, 5)
  // Back to a P: the bowl row reaches x = 1 again and the stem row still
  // ends at x = 0.5.
  const hits = await page.evaluate(() => {
    const t = window.__hew_test!
    return {
      bowlEnd: t.pickFace([1.1, 1.5, 0.1], [-1, 0, 0]),
      stemBeyond: t.pickFace([0.6, 0.5, 0.1], [1, 0, 0]),
      stemEnd: t.pickFace([0.6, 0.5, 0.1], [-1, 0, 0]),
    }
  })
  expect(hits.bowlEnd).not.toBeNull()
  expect(hits.stemBeyond).toBeNull()
  expect(hits.stemEnd).not.toBeNull()
})
