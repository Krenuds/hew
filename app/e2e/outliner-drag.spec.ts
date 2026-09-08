import { test, expect } from '@playwright/test'

/**
 * Outliner drag-and-drop with REAL pointer events (press, a slow drag past
 * the 4 px threshold, release): an object row dropped onto a group row
 * joins the group, and a drag that cannot drop says why in a toast instead
 * of doing nothing (playtest II: "Outliner dragging doesn't work at all").
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

async function scene(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const t = window.__hew_test!
    const a = t.drawBox([0, 0, 0], [1, 1, 0], 1)
    const b = t.drawBox([3, 0, 0], [4, 1, 0], 1)
    const c = t.drawBox([6, 0, 0], [7, 1, 0], 1)
    const g = t.groupNodes([{ kind: 'object', id: b }, { kind: 'object', id: c }])
    return { a, b, c, g }
  })
}

async function dragRow(page: import('@playwright/test').Page, from: string, to: string) {
  const src = page.locator(`[data-drop-target="${from}"]`)
  const dst = page.locator(`[data-drop-target="${to}"]`)
  const sb = (await src.boundingBox())!
  const db = (await dst.boundingBox())!
  await page.mouse.move(sb.x + 40, sb.y + sb.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(sb.x + 40 + i, sb.y + sb.height / 2 + ((db.y - sb.y) * i) / 10)
  }
  await page.waitForTimeout(50)
  const highlighted = await dst.evaluate((el) => getComputedStyle(el).backgroundColor)
  // Mid-drag the ghost with the dragged name follows the pointer, and the
  // source row is dimmed in place — it must be visible that something is
  // being carried.
  await expect(page.getByTestId('outliner-drag-ghost')).toBeVisible()
  const dimmed = await src.evaluate((el) => Number(getComputedStyle(el).opacity))
  expect(dimmed).toBeLessThan(1)
  await page.mouse.up()
  await expect(page.getByTestId('outliner-drag-ghost')).toHaveCount(0)
  return highlighted
}

test('an object row dragged onto a group row joins the group', async ({ page }) => {
  const ids = await scene(page)
  const highlighted = await dragRow(page, `object:${ids.a}`, `group:${ids.g}`)
  expect(highlighted).not.toBe('rgba(0, 0, 0, 0)') // the drop target lit up under the drag
  const members = await page.evaluate((g) => window.__hew_test!.getGroupMembers(g), ids.g)
  expect(members.map((m) => m.id)).toContain(ids.a)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('a drop that cannot land says why in a toast instead of doing nothing', async ({ page }) => {
  const ids = await scene(page)
  // An object row is not a drop target: only group rows and Model are.
  await dragRow(page, `object:${ids.a}`, `object:${ids.a}`)
  await expect(page.getByText('Drop onto a group row', { exact: false })).toBeVisible()
  const members = await page.evaluate((g) => window.__hew_test!.getGroupMembers(g), ids.g)
  expect(members.map((m) => m.id)).not.toContain(ids.a)
})
