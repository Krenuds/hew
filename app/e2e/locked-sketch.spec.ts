import { test, expect, type Page } from '@playwright/test'
import {
  buildViewProjection,
  worldToPagePixel,
  type CameraParams,
  type Mat4,
} from './helpers/projectWorldToScreen'

/**
 * Locked sketches — end to end, as the deck that motivated them.
 *
 * A locked sketch is one you draw *against* instead of *into*: a chalk line.
 * Frame a deck and the footprint is a measurement, not stock — you set lumber
 * against it and never consume it, and it has to still be there for the next
 * board. Building from the footprint itself is by copy, for the same reason.
 *
 * Unlocked, it is not. The draw tools funnel everything drawn on one plane
 * into one sketch, so each joist welds into the footprint and splits it;
 * three of the joist region's four edges are footprint perimeter bounding no
 * surviving region, so extruding the joist takes them with it. Six boards in,
 * the reference dimension is gone.
 *
 * This spec drives the whole thing through REAL input on a pinned camera
 * (strategy 2, docs/dev/DEVELOPMENT.md): the Rectangle tool for every
 * outline, the Push/Pull tool for every board. Only the lock itself is set
 * through the harness — it is a panel checkbox, not this spec's subject.
 *
 * Assertions are logical (`getSketchIds`, `getSketchLines`,
 * `getSketchRegionCount`, `getObjectCount`, `getLastError`) per the pyramid;
 * the geometry of consumption is pinned in `locked_sketch_specs.rs`.
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
async function drawRect(
  page: Page,
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Promise<void> {
  await page.keyboard.press('r')
  await clickWorld(page, ctx, x0, y0, 0)
  await clickWorld(page, ctx, x1, y1, 0)
}

/** The bounding box of a sketch's lines, as [minX, minY, maxX, maxY]. */
function bounds(lines: number[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < lines.length; i += 3) {
    minX = Math.min(minX, lines[i])
    maxX = Math.max(maxX, lines[i])
    minY = Math.min(minY, lines[i + 1])
    maxY = Math.max(maxY, lines[i + 1])
  }
  return [minX, minY, maxX, maxY]
}

// A deck-sized model scaled to metres: a 6 x 6 footprint with 0.3-wide
// joists, which keeps every click far enough apart to resolve at this
// camera while staying the same shape as the 20 x 20 / 3-1/2" case.
const FOOT = 6
const JOIST_W = 0.3
const JOIST_PITCH = 1.2

const CAMERA: CameraParams = {
  position: { x: 9, y: -11, z: 10 },
  target: { x: 3, y: 3, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fovDeg: 55,
  near: 0.1,
  far: 1000,
}

test('a locked footprint survives the joists laid on it', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))

  // ---- 1. The footprint, with the REAL Rectangle tool -------------------
  await drawRect(page, ctx, 0, 0, FOOT, FOOT)

  const afterFootprint = await page.evaluate(() => ({
    sketchIds: window.__hew_test!.getSketchIds(),
    lastError: window.__hew_test!.getLastError(),
  }))
  expect(afterFootprint.lastError).toBeNull()
  expect(afterFootprint.sketchIds).toHaveLength(1)
  const footprint = afterFootprint.sketchIds[0]

  // ---- 2. Lock it. It is a measurement, not stock. ----------------------
  await page.evaluate((s) => window.__hew_test!.setSketchLocked(s, true), footprint)
  expect(await page.evaluate((s) => window.__hew_test!.isSketchLocked(s), footprint)).toBe(true)

  // ---- 3. Four joists along the footprint, each drawn and pushed --------
  // Every one starts ON the footprint's own y = 0 edge, which is exactly the
  // welding that used to eat it.
  for (let i = 0; i < 4; i++) {
    const y = i * JOIST_PITCH
    await drawRect(page, ctx, 0, y, FOOT, y + JOIST_W)

    // Push it into a board: click the strip's fill, type an exact height.
    await page.keyboard.press('p')
    await clickWorld(page, ctx, FOOT / 2, y + JOIST_W / 2, 0)
    await page.keyboard.type('0.3')
    await page.keyboard.press('Enter')
    await page.waitForFunction((n) => window.__hew_test!.getObjectCount() === n, i + 1)
  }

  // ---- 4. The reference dimension is still the reference dimension -----
  const final = await page.evaluate(
    (s) => ({
      objectCount: window.__hew_test!.getObjectCount(),
      lastError: window.__hew_test!.getLastError(),
      locked: window.__hew_test!.isSketchLocked(s),
      lines: window.__hew_test!.getSketchLines(s),
      regionCount: window.__hew_test!.getSketchRegionCount(s),
      sketchIds: window.__hew_test!.getSketchIds(),
    }),
    footprint,
  )

  expect(final.lastError).toBeNull()
  expect(final.objectCount).toBe(4)
  expect(final.locked).toBe(true)

  // Four edges, one region: nothing split it and nothing was taken from it.
  expect(final.lines).toHaveLength(4 * 6)
  expect(final.regionCount).toBe(1)

  const [minX, minY, maxX, maxY] = bounds(final.lines)
  expect(minX).toBeCloseTo(0, 6)
  expect(minY).toBeCloseTo(0, 6)
  expect(maxX).toBeCloseTo(FOOT, 6)
  // The whole point: NOT FOOT - JOIST_W.
  expect(maxY).toBeCloseTo(FOOT, 6)

  // The clearest statement of the whole feature: the footprint is the ONLY
  // sketch left. Every joist landed in a sketch of its own and was wholly
  // consumed into its board — the outline became the solid's base face and
  // the emptied sketch went with it (Model D). The stock sketches were eaten,
  // exactly as they should be; the chalk line was not.
  expect(final.sketchIds).toEqual([footprint])
})

test('a locked footprint is built from without being used up', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))

  await drawRect(page, ctx, 0, 0, FOOT, FOOT)
  const footprint = (await page.evaluate(() => window.__hew_test!.getSketchIds()))[0]
  await page.evaluate((s) => window.__hew_test!.setSketchLocked(s, true), footprint)

  // Push/Pull the locked footprint itself into a slab, with REAL input.
  await page.keyboard.press('p')
  await clickWorld(page, ctx, FOOT / 2, FOOT / 2, 0)
  await page.keyboard.type('0.2')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 1)

  const read = (s: string) =>
    page.evaluate(
      (id) => ({
        objectCount: window.__hew_test!.getObjectCount(),
        lastError: window.__hew_test!.getLastError(),
        locked: window.__hew_test!.isSketchLocked(id),
        lines: window.__hew_test!.getSketchLines(id),
        regionCount: window.__hew_test!.getSketchRegionCount(id),
        sketchIds: window.__hew_test!.getSketchIds(),
      }),
      s,
    )

  // The slab went up and the drawing is exactly what it was: an ordinary
  // sketch would have been emptied into the slab and left the document.
  const built = await read(footprint)
  expect(built.lastError).toBeNull()
  expect(built.locked).toBe(true)
  expect(built.sketchIds).toEqual([footprint])
  expect(built.lines).toHaveLength(4 * 6)
  expect(built.regionCount).toBe(1)

  // Undo has no outline to put back: it takes the slab and nothing else.
  await page.evaluate(() => window.__hew_test!.undo())
  const undone = await read(footprint)
  expect(undone.objectCount).toBe(0)
  expect(undone.locked).toBe(true)
  expect(undone.lines).toEqual(built.lines)
  expect(undone.regionCount).toBe(1)
})

test('unlocking returns the footprint to ordinary stock', async ({ page }) => {
  const ctx = await ready(page).then(() => aim(page, CAMERA))

  await drawRect(page, ctx, 0, 0, FOOT, FOOT)
  const footprint = (await page.evaluate(() => window.__hew_test!.getSketchIds()))[0]

  await page.evaluate((s) => window.__hew_test!.setSketchLocked(s, true), footprint)
  await page.evaluate((s) => window.__hew_test!.setSketchLocked(s, false), footprint)

  // Drawn over again, it welds exactly as it always did — one sketch, two
  // regions — so unlocking really does leave no residue.
  await drawRect(page, ctx, 0, 0, FOOT, JOIST_W)

  const after = await page.evaluate(
    (s) => ({
      locked: window.__hew_test!.isSketchLocked(s),
      sketchIds: window.__hew_test!.getSketchIds(),
      regionCount: window.__hew_test!.getSketchRegionCount(s),
      lastError: window.__hew_test!.getLastError(),
    }),
    footprint,
  )
  expect(after.lastError).toBeNull()
  expect(after.locked).toBe(false)
  expect(after.sketchIds).toHaveLength(1)
  expect(after.regionCount).toBe(2)
})
