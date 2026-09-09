/**
 * Drawing right up to a face's edges (docs/design/v1.1-cycle.md follow-up):
 * a rectangle on a box's top face from the west edge's midpoint to the
 * north edge's midpoint has two sides ON the face boundary. It used to be
 * refused ("must sit fully inside the face"); it now imprints as a chord
 * split, and the enclosed piece is a face that push/pull acts on.
 */
import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  await page.evaluate(() => {
    const h = window.__hew_test!
    h.drawBox([0, 0, 0], [2, 1, 0], 0.5)
    h.setCamera({ position: [1, 0.5 - 0.01, 6], target: [1, 0.5, 0.5], up: [0, 0, 1], fovDeg: 45 })
  })
  await page.waitForTimeout(150)
}

async function pagePoint(page: Page, w: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w), w)
  return { x: box.x + p.x, y: box.y + p.y }
}

test('a rectangle drawn to two edge midpoints of a face imprints and its piece pulls up', async ({ page }) => {
  await setup(page)
  // The whole top is one face to start with.
  const whole = await page.evaluate(() => {
    const h = window.__hew_test!
    return [h.pickFace([0.5, 0.75, 5], [0, 0, -1]), h.pickFace([1.5, 0.25, 5], [0, 0, -1])]
  })
  expect(whole[0]!.face).toBe(whole[1]!.face)

  await page.getByRole('radio', { name: 'Rectangle' }).click()
  const a = await pagePoint(page, [0, 0.5, 0.5]) // west edge midpoint of the top face
  const b = await pagePoint(page, [1, 1, 0.5]) // north edge midpoint
  await page.mouse.move(a.x, a.y)
  await page.waitForTimeout(120)
  await expect(page.getByText('Midpoint', { exact: true })).toBeVisible()
  await page.mouse.click(a.x, a.y)
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.waitForTimeout(120)
  await page.mouse.click(b.x, b.y)
  await page.waitForTimeout(200)

  // No refusal toast, and the enclosed quarter is now its own face: a ray
  // into it and a ray into the rest of the top land on different faces.
  await expect(page.getByText(/fully inside the face/)).toHaveCount(0)
  const [inside, outside] = await page.evaluate(() => {
    const h = window.__hew_test!
    return [h.pickFace([0.5, 0.75, 5], [0, 0, -1]), h.pickFace([1.5, 0.25, 5], [0, 0, -1])]
  })
  expect(inside).not.toBeNull()
  expect(outside).not.toBeNull()
  expect(inside!.face).not.toBe(outside!.face)

  // Pull the piece up through the harness: it is a real face.
  await page.evaluate((inside) => window.__hew_test!.pushPull(inside.object, inside.face, 0.25), inside!)
  const top = await page.evaluate(() => window.__hew_test!.pickFace([0.5, 0.75, 5], [0, 0, -1]))
  expect(top).not.toBeNull()
  // One undo removes the pull, a second removes the imprint entirely.
  await page.evaluate(() => { window.__hew_test!.undo(); window.__hew_test!.undo() })
  const again = await page.evaluate(() => {
    const h = window.__hew_test!
    return [h.pickFace([0.5, 0.75, 5], [0, 0, -1]), h.pickFace([1.5, 0.25, 5], [0, 0, -1])]
  })
  expect(again[0]!.face).toBe(again[1]!.face)
})
