import { test, expect } from '@playwright/test'

/**
 * Push/Pull is about faces: even a face a few pixels across must be the
 * thing under the cursor, never one of the edges around it (playtest II,
 * solids). A 2 cm square drawn on a box top, viewed from 6 m so it spans
 * ~3 px, is pulled up — and only it: the big top face stays where it was.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

test.skip(({ browserName }) => browserName !== 'chromium', 'pixel sampling is only stable on pinned SwiftShader')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
})

test('push/pull picks a 3 px face under the cursor rather than its edges', async ({ page }) => {
  await page.evaluate(() => {
    const t = window.__hew_test!
    t.setGridVisible(false)
    t.setAxesVisible(false)
    t.drawBox([0, 0, 0], [1, 1, 0], 0.5)
    t.setCamera({ position: [0.5, 0.5, 6], target: [0.5, 0.5, 0], up: [0, 1, 0], fovDeg: 45 })
  })
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  const canvas = (await page.locator('canvas').first().boundingBox())!
  const toPage = async (w: [number, number, number]) => {
    const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w as [number, number, number]), w)
    return { x: canvas.x + p.x, y: canvas.y + p.y }
  }
  const click = async (p: { x: number; y: number }) => {
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.up()
  }

  await page.getByRole('radio', { name: 'Rectangle' }).click()
  await click(await toPage([0.45, 0.45, 0.5]))
  await click(await toPage([0.47, 0.47, 0.5]))
  const a = await toPage([0.45, 0.45, 0.5])
  const b = await toPage([0.47, 0.47, 0.5])
  expect(Math.abs(b.x - a.x)).toBeLessThan(6) // the face really is a few pixels wide

  const before = await page.evaluate(() => ({
    top: window.__hew_test!.pickFace([0.2, 0.2, 5], [0, 0, -1]),
    tiny: window.__hew_test!.pickFace([0.46, 0.46, 5], [0, 0, -1]),
  }))
  expect(before.top?.face).not.toEqual(before.tiny?.face)

  await page.getByRole('radio', { name: 'Push/Pull' }).click()
  await click(await toPage([0.46, 0.46, 0.5]))
  await page.keyboard.type('0.2')
  await page.keyboard.press('Enter')

  const after = await page.evaluate(() => {
    const t = window.__hew_test!
    return {
      err: t.getLastError(),
      bounds: t.getObjectBounds(t.getObjectIds()[0]),
      // A ray starting at z = 0.6 still hits the big top face (still at z = 0.5)…
      topFrom06: t.pickFace([0.2, 0.2, 0.6], [0, 0, -1]),
      // …but not the tiny one, whose top is now at z = 0.7.
      tinyFrom06: t.pickFace([0.46, 0.46, 0.6], [0, 0, -1]),
    }
  })
  expect(after.err).toBeNull()
  expect(after.bounds[5]).toBeCloseTo(0.7, 5)
  expect(after.topFrom06?.face).toEqual(before.top?.face)
  expect(after.tinyFrom06?.face).not.toEqual(before.tiny?.face)
})
