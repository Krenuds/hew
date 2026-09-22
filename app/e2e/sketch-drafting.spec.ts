import { test, expect, type Page } from '@playwright/test'
import {
  buildViewProjection,
  worldToPagePixel,
  type CameraParams,
  type Mat4,
} from './helpers/projectWorldToScreen'

/**
 * Sketches as a drafting surface — end to end.
 *
 * The number a drawn line IS can be retyped in Object Info; a corner rounds
 * with the Fillet tool; a shape mirrors across a clicked line; Camera ▸ Look
 * at Sketch squares the camera to the plan. Driven through REAL input on a
 * pinned camera (strategy 2, docs/dev/DEVELOPMENT.md); the kernel contract is
 * pinned in `sketch_retype_specs.rs` and `sketch_verb_specs.rs`.
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

const CAMERA: CameraParams = {
  position: { x: 9, y: -11, z: 10 },
  target: { x: 3, y: 3, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fovDeg: 55,
  near: 0.1,
  far: 1000,
}

/** A 3 x 2 plan at the origin drawn through the harness, and its south wall. */
async function planWithSouthWall(page: Page): Promise<{ plan: string; wall: string }> {
  return page.evaluate(() => {
    const h = window.__hew_test!
    const plan = h.drawRectangle([0, 0, 0], [3, 2, 0]).sketch
    const wall = h.getSketchEdgeIds(plan).find((e) => {
      const ends = h.getSketchEdgeEndpoints(plan, e)
      return ends !== null && Math.abs(ends[1]) < 1e-9 && Math.abs(ends[4]) < 1e-9
    })!
    return { plan, wall }
  })
}

test('a wall line becomes the typed length in Object Info', async ({ page }) => {
  await ready(page)
  await aim(page, CAMERA)
  const { plan, wall } = await planWithSouthWall(page)
  await page.evaluate(
    ({ plan, wall }) => window.__hew_test!.selectNodes([{ kind: 'sketch-edge', id: wall, sketch: plan }]),
    { plan, wall },
  )

  const field = page.getByLabel('Length')
  await expect(field).toBeVisible()
  await field.fill('4m')
  await field.press('Enter')

  await page.waitForFunction(
    ({ plan, wall }) => {
      const ends = window.__hew_test!.getSketchEdgeEndpoints(plan, wall)
      return ends !== null && Math.abs(Math.hypot(ends[3] - ends[0], ends[4] - ends[1]) - 4) < 1e-6
    },
    { plan, wall },
  )
  // One undo puts the wall back.
  await page.evaluate(() => window.__hew_test!.undo())
  const ends = await page.evaluate(
    ({ plan, wall }) => window.__hew_test!.getSketchEdgeEndpoints(plan, wall),
    { plan, wall },
  )
  expect(Math.hypot(ends![3] - ends![0], ends![4] - ends![1])).toBeCloseTo(3, 6)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('the Fillet tool rounds a clicked corner into an arc, one undo step', async ({ page }) => {
  await ready(page)
  const ctx = await aim(page, CAMERA)
  const { plan } = await planWithSouthWall(page)
  const edgesBefore = await page.evaluate((s) => window.__hew_test!.getSketchEdgeIds(s).length, plan)

  await page.getByTestId('menu-bar').getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByText('Fillet', { exact: true }).click()
  await page.keyboard.type('0.5')
  await page.keyboard.press('Enter')
  await clickWorld(page, ctx, 3, 0, 0)

  await page.waitForFunction(
    ({ plan, before }) => window.__hew_test!.getSketchEdgeIds(plan).length > before + 2,
    { plan, before: edgesBefore },
  )
  await page.evaluate(() => window.__hew_test!.undo())
  expect(await page.evaluate((s) => window.__hew_test!.getSketchEdgeIds(s).length, plan)).toBe(edgesBefore)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('Look at Sketch squares the camera to the plan in parallel projection', async ({ page }) => {
  await ready(page)
  await aim(page, CAMERA)
  const { plan } = await planWithSouthWall(page)
  await page.evaluate((s) => window.__hew_test!.selectNodes([{ kind: 'sketch', id: s }]), plan)

  await page.getByTestId('menu-bar').getByRole('button', { name: 'Camera', exact: true }).click()
  await page.getByText('Look at Sketch', { exact: true }).click()

  await page.waitForFunction(() => window.__hew_test!.getCameraState().projection === 'parallel')
  const cam = await page.evaluate(() => window.__hew_test!.getCameraState())
  const dir = [cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2]]
  const len = Math.hypot(dir[0], dir[1], dir[2])
  expect(Math.abs(dir[2] / len)).toBeCloseTo(1, 3) // looking straight down the plan's normal
  expect(cam.target[0]).toBeCloseTo(1.5, 3)
  expect(cam.target[1]).toBeCloseTo(1, 3)
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})
