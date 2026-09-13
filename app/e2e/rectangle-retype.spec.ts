import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * RectangleTool's "retype window" (tools/RectangleTool.ts `RetypeHot`): after
 * the SECOND click commits a rectangle, typing `W,D` + Enter RESIZES that
 * same rectangle in place -- SketchUp's "draw roughly, then type the size" --
 * as often as wanted, until the next pointer action, Escape, or tool switch.
 * Driven end to end with REAL pointer/keyboard events.
 */

const CAMERA = {
  position: [4, -8, 6] as [number, number, number],
  target: [1, 1, 0] as [number, number, number],
  up: [0, 0, 1] as [number, number, number],
  fovDeg: 45,
}

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
  await page.evaluate((cam) => window.__hew_test!.setCamera(cam), CAMERA)
  await page.waitForTimeout(100)
}

async function pagePoint(page: Page, w: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w), w)
  if (p.behind) throw new Error(`world point ${w.join(',')} is behind the camera`)
  return { x: box.x + p.x, y: box.y + p.y }
}

async function clickWorld(page: Page, w: [number, number, number]): Promise<void> {
  const p = await pagePoint(page, w)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
}

/** The one sketch's bounding rect in the ground plane, from its raw edge
 * endpoints -- `getSketchLines` returns every edge of the WHOLE sketch as
 * flat xyz triples, so after a retype (the old edges are undone, not just
 * hidden) this is exactly the current rectangle's 4 edges. */
async function soleSketchXYBounds(page: Page): Promise<{ minX: number; minY: number; maxX: number; maxY: number; sketch: string }> {
  return page.evaluate(() => {
    const h = window.__hew_test!
    const ids = h.getSketchIds()
    if (ids.length !== 1) throw new Error(`expected exactly one sketch, found ${ids.length}`)
    const sketch = ids[0]
    const lines = h.getSketchLines(sketch)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < lines.length; i += 3) {
      minX = Math.min(minX, lines[i])
      maxX = Math.max(maxX, lines[i])
      minY = Math.min(minY, lines[i + 1])
      maxY = Math.max(maxY, lines[i + 1])
    }
    return { minX, minY, maxX, maxY, sketch }
  })
}

async function edgeCount(page: Page, sketch: string): Promise<number> {
  return page.evaluate((sketch) => {
    const h = window.__hew_test!
    let n = 0
    for (const island of h.getSketchIslands(sketch)) n += island.edges.length
    return n
  }, sketch)
}

test('typing dimensions after the second click resizes the rectangle in place, growing the same direction it was drawn', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('r')
  await clickWorld(page, [0, 0, 0])
  await clickWorld(page, [1, 1, 0])
  await page.waitForTimeout(100)

  const initial = await soleSketchXYBounds(page)
  expect(initial.minX).toBeCloseTo(0, 6)
  expect(initial.minY).toBeCloseTo(0, 6)
  expect(initial.maxX).toBeCloseTo(1, 6)
  expect(initial.maxY).toBeCloseTo(1, 6)
  expect(await edgeCount(page, initial.sketch)).toBe(4)

  // Retype to 2x3 -- still exactly one sketch in the document (the retype
  // undoes the prior commit and recommits, so the wasm sketch HANDLE is not
  // guaranteed to stay numerically identical -- but there is still only
  // ONE sketch, holding the new rectangle, growing toward +x,+y (the
  // direction the original drag went), still exactly 4 edges.
  await page.keyboard.type('2,3')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  const resized = await soleSketchXYBounds(page)
  expect(resized.minX).toBeCloseTo(0, 6)
  expect(resized.minY).toBeCloseTo(0, 6)
  expect(resized.maxX).toBeCloseTo(2, 6)
  expect(resized.maxY).toBeCloseTo(3, 6)
  expect(await edgeCount(page, resized.sketch)).toBe(4)

  // Retype again to a 1.5 square.
  await page.keyboard.type('1.5')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  const square = await soleSketchXYBounds(page)
  expect(square.minX).toBeCloseTo(0, 6)
  expect(square.minY).toBeCloseTo(0, 6)
  expect(square.maxX).toBeCloseTo(1.5, 6)
  expect(square.maxY).toBeCloseTo(1.5, 6)
  expect(await edgeCount(page, square.sketch)).toBe(4)

  // ONE undo retracts the whole thing -- every retype undid its predecessor
  // before committing, so only one committed step remains.
  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(100)
  const sketchesAfterUndo = await page.evaluate(() => window.__hew_test!.getSketchIds())
  expect(sketchesAfterUndo).toHaveLength(0)
})

test('retyping honors the direction the rectangle was drawn in (negative growth)', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('r')
  await clickWorld(page, [0, 0, 0])
  await clickWorld(page, [-1, -1, 0])
  await page.waitForTimeout(100)

  await page.keyboard.type('2,1')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)

  const b = await soleSketchXYBounds(page)
  expect(b.minX).toBeCloseTo(-2, 6)
  expect(b.maxX).toBeCloseTo(0, 6)
  expect(b.minY).toBeCloseTo(-1, 6)
  expect(b.maxY).toBeCloseTo(0, 6)
})

test('the retype window does not swallow bare-letter tool shortcuts', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('r')
  await clickWorld(page, [0, 0, 0])
  await clickWorld(page, [1, 1, 0])
  await page.waitForTimeout(100)

  // Letters keep their global meaning while the retype buffer is empty:
  // 'p' switches to Push/Pull rather than being swallowed by the window.
  await page.keyboard.press('p')
  await page.waitForTimeout(100)
  await expect(
    page.getByRole('radiogroup', { name: 'Tools' }).getByRole('radio', { name: 'Push/Pull' }),
  ).toHaveAttribute('aria-checked', 'true')
})

test('Escape closes the retype window; typed dimensions afterward change nothing', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('r')
  await clickWorld(page, [3, 0, 0])
  await clickWorld(page, [4, 1, 0])
  await page.waitForTimeout(100)
  const before = await soleSketchXYBounds(page)

  await page.keyboard.press('Escape')
  await page.keyboard.type('2,3')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  const after = await soleSketchXYBounds(page)
  expect(after).toEqual(before)
})
