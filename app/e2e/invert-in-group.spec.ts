import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * Edit ▸ Invert Selection inside an open group session inverts among the
 * group's own members only — a solid outside the group and a free sketch
 * drawn beside it (world-global while the session is open, for drawing)
 * must stay out of it.
 */
async function screenAt(page: Page, p: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas').first().boundingBox())!
  const s = await page.evaluate((pt) => window.__hew_test!.worldToScreen(pt as [number, number, number]), p)
  return { x: box.x + s.x, y: box.y + s.y }
}

test('Invert Selection inside an open group stays inside the group', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  const ids = await page.evaluate(() => {
    const h = window.__hew_test!
    const a = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const b = h.drawBox([2, 0, 0], [3, 1, 0], 1)
    const outside = h.drawBox([4, 0, 0], [5, 1, 0], 1)
    const sketch = h.drawRectangle([6, 0, 0], [7, 1, 0])
    const g = h.groupNodes([{ kind: 'object', id: a }, { kind: 'object', id: b }])
    h.selectObjects([])
    return { a, b, outside, sketch, g }
  })
  await page.evaluate(() => {
    window.__hew_test!.setCamera({ position: [3, -8, 6], target: [3, 0.5, 0.5], up: [0, 0, 1], fovDeg: 45 })
  })
  await page.waitForTimeout(150)

  // A real double-click on member A opens the group session.
  const top = await screenAt(page, [0.5, 0.5, 1])
  await page.mouse.move(top.x, top.y)
  await page.mouse.click(top.x, top.y, { clickCount: 2 })
  await page.waitForTimeout(300)
  // Then a plain click selects member A inside the session.
  await page.mouse.click(top.x, top.y)
  await page.waitForTimeout(150)
  const before = await page.evaluate(() => window.__hew_test!.getSelection())
  expect(before.map((n) => `${n.kind}:${n.id}`)).toEqual([`object:${ids.a}`])

  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await page.getByText('Invert Selection').click()
  await page.waitForTimeout(200)
  const after = await page.evaluate(() => window.__hew_test!.getSelection())
  expect(after.map((n) => `${n.kind}:${n.id}`)).toEqual([`object:${ids.b}`])
})
