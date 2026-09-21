import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  buildViewProjection,
  worldToPagePixel,
  type CameraParams,
  type Mat4,
} from './helpers/projectWorldToScreen'

/**
 * Sketch identity — end to end.
 *
 * A sketch is a named thing you organize a drawing by: one Outliner row per
 * sketch with its shapes nested inside, an editable name in Object Info, an
 * eye that really hides it (from view AND from the cursor), and all of it
 * saved with the document.
 *
 * Driven through REAL input on a pinned camera (strategy 2,
 * docs/dev/DEVELOPMENT.md): the Rectangle tool draws, the Outliner is clicked,
 * Object Info is typed into, Push/Pull is aimed at the ground. Two separate
 * sketches on the ground are made the only way the draw tools allow today —
 * lock the first, and the next stroke starts a fresh one; the lock is set
 * through the harness because it is not this spec's subject.
 *
 * Assertions are logical (`getSketchIds`, `getNodeName`, `isNodeHidden`,
 * `getObjectCount`, `getLastError`) plus the Outliner rows a user reads; the
 * kernel contract is pinned in `sketch_node_specs.rs`.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

interface Ctx {
  vp: Mat4
  rect: { left: number; top: number; width: number; height: number }
}

function px(ctx: Ctx, x: number, y: number, z: number): { x: number; y: number } {
  const p = worldToPagePixel({ x, y, z }, ctx.vp, ctx.rect)
  if (p === null) throw new Error(`world (${x},${y},${z}) does not project onto the canvas`)
  return p
}

async function ready(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
}

async function aim(page: Page, camera: CameraParams): Promise<Ctx> {
  await page.evaluate(
    (cam) =>
      window.__hew_test!.setCamera({
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [cam.target.x, cam.target.y, cam.target.z],
        up: [cam.up.x, cam.up.y, cam.up.z],
        fovDeg: cam.fovDeg,
      }),
    camera,
  )
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('viewport canvas has no bounding box')
  const rect = { left: box.x, top: box.y, width: box.width, height: box.height }
  return { vp: buildViewProjection(camera, rect.width / rect.height), rect }
}

async function clickWorld(page: Page, ctx: Ctx, x: number, y: number, z: number): Promise<void> {
  const p = px(ctx, x, y, z)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
}

/** Draw one axis-aligned ground rectangle with the REAL Rectangle tool. */
async function drawRect(page: Page, ctx: Ctx, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  await page.keyboard.press('r')
  await clickWorld(page, ctx, x0, y0, 0)
  await clickWorld(page, ctx, x1, y1, 0)
}

/** Aim Push/Pull at a ground point and type a height. */
async function pushPullAt(page: Page, ctx: Ctx, x: number, y: number): Promise<void> {
  await page.keyboard.press('p')
  await clickWorld(page, ctx, x, y, 0)
  await page.keyboard.type('0.5')
  await page.keyboard.press('Enter')
}

/** The Outliner row whose label is exactly `label` (the label span's parent). */
function rowFor(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).last().locator('xpath=..')
}

const CAMERA: CameraParams = {
  position: { x: 9, y: -11, z: 10 },
  target: { x: 3, y: 3, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fovDeg: 55,
  near: 0.1,
  far: 1000,
}

/** Two separate ground sketches: a 2 x 2 at the origin and a 2 x 2 beside it. */
async function twoSketches(page: Page, ctx: Ctx): Promise<{ first: string; second: string }> {
  await drawRect(page, ctx, 0, 0, 2, 2)
  const first = (await page.evaluate(() => window.__hew_test!.getSketchIds()))[0]
  // Locked, the first sketch is never a draw target: the next stroke on the
  // ground starts a fresh sketch instead of welding into this one.
  await page.evaluate((s) => window.__hew_test!.setSketchLocked(s, true), first)
  await drawRect(page, ctx, 4, 0, 6, 2)
  const ids = await page.evaluate(() => window.__hew_test!.getSketchIds())
  expect(ids).toHaveLength(2)
  const second = ids.find((id) => id !== first)!
  return { first, second }
}

test('a sketch is one named Outliner row with its shapes nested inside', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))
  const { first } = await twoSketches(page, ctx)
  await page.keyboard.press('Space')

  // One row per sketch, not per shape; shapes are out of sight until opened.
  await expect(rowFor(page, 'Sketch 1')).toBeVisible()
  await expect(rowFor(page, 'Sketch 2')).toBeVisible()
  await expect(page.getByText('Shape 1', { exact: true })).toHaveCount(0)

  // Select the sketch from its row and name it in Object Info.
  await rowFor(page, 'Sketch 1').click()
  const name = page.getByPlaceholder('Sketch 1')
  await name.fill('Ground floor')
  await name.press('Enter')

  await expect(rowFor(page, 'Ground floor')).toBeVisible()
  await expect(page.getByText('Sketch 1', { exact: true })).toHaveCount(0)
  // The other sketch keeps its own positional label.
  await expect(rowFor(page, 'Sketch 2')).toBeVisible()
  expect(await page.evaluate((s) => window.__hew_test!.getNodeName('sketch', s), first)).toBe(
    'Ground floor',
  )

  // Naming is one undo step.
  await page.evaluate(() => window.__hew_test!.undo())
  await expect(rowFor(page, 'Sketch 1')).toBeVisible()
  await page.evaluate(() => window.__hew_test!.redo())
  await expect(rowFor(page, 'Ground floor')).toBeVisible()

  // The chevron opens the sketch onto its shapes.
  await rowFor(page, 'Ground floor').getByText('▸').click()
  await expect(page.getByText('Shape 1', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('a hidden sketch is out of the cursor\'s way, and comes back', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))
  const { second } = await twoSketches(page, ctx)
  await page.keyboard.press('Space')

  // Hide the second sketch from its row's eye.
  await rowFor(page, 'Sketch 2').getByTitle('Hide').click()
  expect(
    await page.evaluate((s) => window.__hew_test!.isNodeHidden({ kind: 'sketch', id: s }), second),
  ).toBe(true)

  // Push/Pull aimed at where it is finds nothing to extrude: a hidden sketch
  // is not there to be clicked.
  await pushPullAt(page, ctx, 5, 1)
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Space')

  // Shown again, the same click builds from it.
  await rowFor(page, 'Sketch 2').getByTitle('Show').click()
  await pushPullAt(page, ctx, 5, 1)
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 1)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('a sketch\'s name and hidden state are saved with the document', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))
  const { first } = await twoSketches(page, ctx)
  await page.keyboard.press('Space')

  await page.evaluate((s) => window.__hew_test!.setNodeName('sketch', s, 'Ground floor'), first)
  await rowFor(page, 'Ground floor').getByTitle('Hide').click()

  // Save, then reopen through the app's real Open path.
  await page.evaluate(() => {
    const h = window.__hew_test!
    h.load(h.save())
  })

  const reopened = await page.evaluate(() => {
    const h = window.__hew_test!
    return h.getSketchIds().map((id) => ({
      name: h.getNodeName('sketch', id),
      hidden: h.isNodeHidden({ kind: 'sketch', id }),
    }))
  })
  expect(reopened).toEqual([
    { name: 'Ground floor', hidden: true },
    { name: null, hidden: false },
  ])
  await expect(rowFor(page, 'Ground floor').getByTitle('Show')).toBeVisible()
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('New Sketch ends the current sketch, and Draw Into goes back to an old one', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))

  // The draw tools keep everything on one plane in one sketch...
  await drawRect(page, ctx, 0, 0, 2, 2)
  await drawRect(page, ctx, 4, 0, 6, 2)
  const [plan] = await page.evaluate(() => window.__hew_test!.getSketchIds())
  expect(await page.evaluate(() => window.__hew_test!.getSketchIds())).toHaveLength(1)
  expect(await page.evaluate(() => window.__hew_test!.getActiveSketchIds())).toEqual([plan])

  // ...until Object ▸ New Sketch: the next stroke starts a fresh one. Nothing
  // is minted by the command itself, so it leaves no empty sketch behind.
  await page.keyboard.press('Space')
  await page.getByTestId('menu-bar').getByRole('button', { name: 'Object', exact: true }).click()
  await page.getByText('New Sketch', { exact: true }).click()
  expect(await page.evaluate(() => window.__hew_test!.getSketchIds())).toEqual([plan])
  expect(await page.evaluate(() => window.__hew_test!.getActiveSketchIds())).toEqual([])

  await drawRect(page, ctx, 0, 4, 2, 6)
  const afterNew = await page.evaluate(() => window.__hew_test!.getSketchIds())
  expect(afterNew).toHaveLength(2)
  const furniture = afterNew.find((id) => id !== plan)!
  expect(await page.evaluate(() => window.__hew_test!.getActiveSketchIds())).toEqual([furniture])

  // Two rows now, and the one strokes will join says so.
  await page.keyboard.press('Space')
  await expect(rowFor(page, 'Sketch 2').getByText('drawing', { exact: true })).toBeVisible()
  await expect(rowFor(page, 'Sketch 1').getByText('drawing', { exact: true })).toHaveCount(0)

  // Double-click the OLD sketch's row: draw into it again.
  await rowFor(page, 'Sketch 1').dblclick()
  expect(await page.evaluate(() => window.__hew_test!.getActiveSketchIds())).toEqual([plan])
  await expect(rowFor(page, 'Sketch 1').getByText('drawing', { exact: true })).toBeVisible()

  // A third rectangle joins the first sketch, not the most recent one.
  const before = await page.evaluate(
    (s) => window.__hew_test!.getSketchIslands(s).length,
    plan,
  )
  await drawRect(page, ctx, 4, 4, 6, 6)
  expect(await page.evaluate(() => window.__hew_test!.getSketchIds())).toHaveLength(2)
  expect(
    await page.evaluate((s) => window.__hew_test!.getSketchIslands(s).length, plan),
  ).toBe(before + 1)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('a locked sketch refuses Draw Into', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))
  await drawRect(page, ctx, 0, 0, 2, 2)
  const [plan] = await page.evaluate(() => window.__hew_test!.getSketchIds())
  await page.evaluate((s) => window.__hew_test!.setSketchLocked(s, true), plan)
  await page.keyboard.press('Space')

  await rowFor(page, 'Sketch 1').dblclick()
  expect(await page.evaluate(() => window.__hew_test!.getActiveSketchIds())).toEqual([])
  await expect(page.getByText(/That sketch is locked/)).toBeVisible()
})
