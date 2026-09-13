import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * FollowMeTool's path preselection (tools/FollowMeTool.ts `_pathFromSelection`)
 * now honors the selection EXACTLY as picked, instead of expanding a sole
 * selected edge to its whole connected island: a single Select-tool click on
 * one segment of a polyline path sweeps that segment ALONE, however long the
 * polyline it belongs to; triple-clicking the same segment (SketchUp's
 * "select all connected") picks up the whole run, and Follow Me sweeps the
 * whole thing, same as before.
 *
 * Profile + path setup mirrors follow-me.spec.ts's "one click on one
 * Line-tool segment" scenario (a 0.6 m profile square stood upright at the
 * path's start, an L of two ground segments) -- driven with the same REAL
 * pointer/keyboard sequence; only the final select+sweep step differs.
 */

const CAMERA = {
  position: { x: 8, y: 6, z: 8 },
  target: { x: 1, y: 1, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fovDeg: 45,
}

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
  await page.evaluate(
    (cam) =>
      window.__hew_test!.setCamera({
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [cam.target.x, cam.target.y, cam.target.z],
        up: [cam.up.x, cam.up.y, cam.up.z],
        fovDeg: cam.fovDeg,
      }),
    CAMERA,
  )
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

/**
 * Build the standing 0.6 m profile square + the ground L-path (0,0,0) ->
 * (0,2,0) -> (2,2,0), through the REAL Rectangle/Rotate/Line tools -- the
 * exact sequence follow-me.spec.ts's "preselect flow" test uses.
 */
async function buildProfileAndPath(page: Page): Promise<void> {
  // Profile: a 0.6 m square drawn flat, stood upright onto the y = 0 plane
  // -- square across a path that leaves the origin along +y.
  await page.keyboard.press('r')
  await clickWorld(page, [-0.3, 0.4, 0])
  const mid = await pagePoint(page, [0.2, 0.9, 0])
  await page.mouse.move(mid.x, mid.y)
  await page.keyboard.type('0.6,0.6')
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await clickWorld(page, [0, 0.4, 0]) // bottom edge of the square
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 1)
  await page.keyboard.press('q')
  await page.keyboard.press('ArrowRight') // lock X
  await clickWorld(page, [0, 0, 0])
  await clickWorld(page, [0, 1, 0])
  await page.keyboard.type('90')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const h = window.__hew_test!
    return h
      .getSketchIds()
      .some((s) => h.getSketchLines(s).some((v, i) => i % 3 === 2 && Math.abs(v) > 0.3))
  })

  // Path: an L of two Line-tool segments on the ground.
  await page.keyboard.press('l')
  await clickWorld(page, [0, 0, 0])
  await clickWorld(page, [0, 2, 0])
  await clickWorld(page, [2, 2, 0])
  await page.keyboard.press('Escape')
}

/** The path sketch's handle -- the free sketch that isn't the (already-
 * upright) profile sketch, identified by lying flat on the ground (all Z
 * near 0). */
async function findPathSketch(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = window.__hew_test!
    for (const s of h.getSketchIds()) {
      const lines = h.getSketchLines(s)
      if (lines.length > 0 && lines.every((v, i) => i % 3 !== 2 || Math.abs(v) < 1e-6)) return s
    }
    throw new Error('no ground-plane path sketch found')
  })
}

test('a single selected segment is swept alone', async ({ page }) => {
  await setup(page)
  await buildProfileAndPath(page)

  const pathSketch = await findPathSketch(page)
  // The L welded into one 2-edge island -- sanity check on the setup.
  const island = await page.evaluate(
    (sketch) => window.__hew_test!.getSketchIslands(sketch).find((i) => i.edges.length === 2),
    pathSketch,
  )
  expect(island).toBeTruthy()

  // ONE Select click on ONE segment -> a single sketch-edge, not the island.
  await page.keyboard.press(' ')
  await clickWorld(page, [0, 1, 0]) // midpoint of the first leg
  await page.waitForFunction(() => {
    const sel = window.__hew_test!.getSelection()
    return sel.length === 1 && sel[0].kind === 'sketch-edge'
  })

  // Follow Me, then the profile.
  await page.getByRole('radio', { name: 'Follow Me' }).click()
  await expect(page.getByText('Click the profile to sweep along')).toBeVisible()
  await clickWorld(page, [0, 0, 0.7]) // center of the standing square
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 1)

  const id = await page.evaluate(() => window.__hew_test!.getObjectIds()[0])
  const bounds = await page.evaluate((id) => window.__hew_test!.getObjectBounds(id), id)
  // Swept along the FIRST leg only (y: 0..2): bounds stay narrow in X (the
  // profile's own ~0.6 m width), never reaching around the corner toward
  // the second leg's x = 2 end.
  expect(bounds[4]).toBeGreaterThan(1.8) // maxY reaches leg 1's far end
  expect(bounds[3]).toBeLessThan(1.0) // maxX stays near the profile width
})

test('control: the whole island (triple-clicked) sweeps the full L path', async ({ page }) => {
  await setup(page)
  await buildProfileAndPath(page)

  await page.keyboard.press(' ')
  const p = await pagePoint(page, [0, 1, 0])
  await page.mouse.click(p.x, p.y, { clickCount: 3 })
  await page.waitForFunction(() => {
    const sel = window.__hew_test!.getSelection()
    return sel.length === 1 && sel[0].kind === 'sketch-island'
  })

  await page.getByRole('radio', { name: 'Follow Me' }).click()
  await expect(page.getByText('Click the profile to sweep along')).toBeVisible()
  await clickWorld(page, [0, 0, 0.7])
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 1)

  const id = await page.evaluate(() => window.__hew_test!.getObjectIds()[0])
  const bounds = await page.evaluate((id) => window.__hew_test!.getObjectBounds(id), id)
  // Swept around BOTH legs: bounds now extend well along X too (toward the
  // second leg's x = 2 end).
  expect(bounds[4]).toBeGreaterThan(1.8) // maxY
  expect(bounds[3]).toBeGreaterThan(1.5) // maxX -- reaches around the corner
})
