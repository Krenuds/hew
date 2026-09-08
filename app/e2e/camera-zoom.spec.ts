/**
 * Zoom floor + orbit pivot (docs/design/v1.1-cycle.md, Lane F;
 * app/src/viewport/cameraDepth.ts): a small detail of a large model must be
 * reachable by the wheel, must stay under the cursor while orbiting, and
 * must respond to Zoom Window — in both projections.
 *
 * Before the fix, `controls.minDistance` was ~2 % of the last Zoom Extents
 * fit distance (0.83 m for a 30 m model), so wheel-zooming into a 5 cm cube
 * stalled far away, Zoom Window did nothing more, and orbiting pivoted a
 * few centimetres in front of the eye — the whole model swung across the
 * screen. Every assertion below fails on that code.
 */
import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

type Vec3 = [number, number, number]

/** A 30 m × 30 m × 3 m slab plus a 5 cm cube on the ground beside it. */
const CUBE_MIN: Vec3 = [-1, -1, 0]
const CUBE_SIZE = 0.05
const CUBE_CENTER: Vec3 = [CUBE_MIN[0] + CUBE_SIZE / 2, CUBE_MIN[1] + CUBE_SIZE / 2, CUBE_SIZE / 2]

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
  await page.evaluate(
    ({ cubeMin, size }) => {
      const h = window.__hew_test!
      h.drawBox([0, 0, 0], [30, 30, 0], 3)
      h.drawBox(cubeMin, [cubeMin[0] + size, cubeMin[1] + size, 0], size)
      h.zoomExtents()
    },
    { cubeMin: CUBE_MIN, size: CUBE_SIZE },
  )
  await page.waitForTimeout(150)
}

async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  return box
}

/** The cube's center in PAGE coordinates (the harness answers canvas-relative px). */
async function cubeOnScreen(page: Page): Promise<{ x: number; y: number; behind: boolean }> {
  const box = await canvasBox(page)
  const p = await page.evaluate((c) => window.__hew_test!.worldToScreen(c), CUBE_CENTER)
  return { x: box.x + p.x, y: box.y + p.y, behind: p.behind }
}

async function eyeDistanceToCube(page: Page): Promise<number> {
  const cam = await page.evaluate(() => window.__hew_test!.getCamera())
  return Math.hypot(
    cam.position[0] - CUBE_CENTER[0],
    cam.position[1] - CUBE_CENTER[1],
    cam.position[2] - CUBE_CENTER[2],
  )
}

/** Wheel-zoom `notches` times with the cursor kept on the cube (re-aimed
 * every few notches, since zoom-to-cursor keeps it in place only up to
 * rounding). */
async function wheelIntoCube(page: Page, notches: number): Promise<void> {
  for (let i = 0; i < notches; i++) {
    if (i % 10 === 0) {
      const p = await cubeOnScreen(page)
      expect(p.behind).toBe(false)
      await page.mouse.move(p.x, p.y)
    }
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(5)
  }
  // Let the damping tail settle.
  await page.waitForTimeout(400)
}

test.describe('zoom floor and orbit pivot follow the geometry under the cursor', () => {
  // Wheel loops are many round trips; keep them robust on a loaded host.
  test.describe.configure({ timeout: 120_000 })

  test('the wheel reaches a 5 cm cube in a 30 m model, and orbiting keeps it on screen', async ({ page }) => {
    await setup(page)
    const startDistance = await eyeDistanceToCube(page)
    expect(startDistance).toBeGreaterThan(20)

    // 110 notches at OrbitControls' 0.95 step: nominally ≈ 280× closer
    // (a few notches are absorbed by the periodic re-aim, so assert with
    // margin). The old floor was `fit / 52.4` ≈ `start / 52` — any ratio
    // past ~60× is only reachable with the near-absolute floor.
    await wheelIntoCube(page, 110)

    const zoomed = await eyeDistanceToCube(page)
    expect(startDistance / zoomed).toBeGreaterThan(80)
    expect(zoomed).toBeGreaterThan(0.01)

    // Orbit with a real middle-drag of a modest size: the cube must stay on
    // screen (before the fix it left the viewport entirely).
    const box = await canvasBox(page)
    const before = await cubeOnScreen(page)
    await page.mouse.move(before.x, before.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(before.x + 80, before.y + 30, { steps: 10 })
    await page.mouse.up({ button: 'middle' })
    await page.waitForTimeout(500)
    const after = await cubeOnScreen(page)
    expect(after.behind).toBe(false)
    expect(after.x).toBeGreaterThan(box.x)
    expect(after.x).toBeLessThan(box.x + box.width)
    expect(after.y).toBeGreaterThan(box.y)
    expect(after.y).toBeLessThan(box.y + box.height)
    // And it did not drift far: the pivot sits at the cube's depth, so the
    // cube itself moves only by the drag's own parallax.
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(box.width * 0.25)
  })

  test('Zoom Window on the cube keeps zooming in past the old floor', async ({ page }) => {
    await setup(page)
    await wheelIntoCube(page, 60)
    const before = await eyeDistanceToCube(page)

    await page.getByRole('button', { name: 'Camera' }).click()
    await page.getByText('Zoom Window', { exact: true }).click()
    const p = await cubeOnScreen(page)
    const half = 40
    await page.mouse.move(p.x - half, p.y - half)
    await page.mouse.down()
    await page.mouse.move(p.x + half, p.y + half, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    const after = await eyeDistanceToCube(page)
    expect(after).toBeLessThan(before * 0.6)
  })

  test('parallel projection: the wheel zooms far past the old symmetric cap and Zoom Window still works', async ({ page }) => {
    await setup(page)
    await page.getByRole('button', { name: 'Camera' }).click()
    await page.getByText('Parallel Projection').click()
    await page.waitForTimeout(100)

    const pixelSize = async (): Promise<number> => {
      const [a, b] = await page.evaluate(
        ({ min, size }) => {
          const h = window.__hew_test!
          return [h.worldToScreen(min), h.worldToScreen([min[0] + size, min[1] + size, size])]
        },
        { min: CUBE_MIN, size: CUBE_SIZE },
      )
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const start = await pixelSize()
    await wheelIntoCube(page, 90)
    const zoomed = await pixelSize()
    // 90 notches at OrbitControls' 0.95 zoom step ≈ 100×; the old
    // symmetric cap stopped at ≈22× past the toggle-time framing.
    expect(zoomed / start).toBeGreaterThan(30)

    await page.getByRole('button', { name: 'Camera' }).click()
    await page.getByText('Zoom Window', { exact: true }).click()
    const p = await cubeOnScreen(page)
    await page.mouse.move(p.x - 40, p.y - 40)
    await page.mouse.down()
    await page.mouse.move(p.x + 40, p.y + 40, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(150)
    const windowed = await pixelSize()
    expect(windowed).toBeGreaterThan(zoomed * 1.5)
  })
})

test.describe('Zoom Window falls back sanely with no geometry under the rectangle', () => {
  /**
   * Adversarial-review coverage gap: `applyZoomWindow` (Viewport.tsx) calls
   * `pickDepthAlongRay` for the rectangle-center ray — a solid face, a
   * sketch region, or a NEARBY ground hit (`groundHitIsUsable`,
   * cameraDepth.ts: `GROUND_FALLBACK_MAX_RATIO` = 4 rejects a ground hit
   * farther than 4x the CURRENT orbit-target distance, exactly the
   * "grazing camera" trap this test constructs). When ALL THREE miss
   * (`pickDepthAlongRay` returns null), the new target is instead the ray's
   * intersection with the PLANE THROUGH THE CURRENT TARGET, perpendicular
   * to the view direction — a local re-center, not a teleport onto
   * whatever the raw ground hit happened to be, however far away.
   *
   * An EMPTY document (no face/region to pick at all) with a shallow,
   * near-horizontal camera reliably hits exactly that: geometry picking
   * finds nothing, and the ground plane IS technically intersected, but far
   * past the 4x gate — the one path prior to this fix (and every other
   * `pickDepthAlongRay` call site) never exercised.
   */
  test('a grazing camera over an empty document keeps the reframe local instead of teleporting to a distant ground hit', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
      timeout: 15_000,
    })

    // Eye at height 2, aimed almost dead-level with only a tiny downward
    // tilt: target 3 m ahead (current orbit distance = 3), but the ray only
    // reaches z=0 after ~100 m (2 / sin(tilt)) — comfortably past the
    // 4×3=12 m usable-ground-hit gate, so the ground hit is rejected; the
    // document is empty, so geometry picking finds nothing either.
    const eye: Vec3 = [0, 0, 2]
    const rawForward: Vec3 = [1, 0, -0.02]
    const mag = Math.hypot(...rawForward)
    const forward: Vec3 = [rawForward[0] / mag, rawForward[1] / mag, rawForward[2] / mag]
    const orbitDistance = 3
    const target: Vec3 = [
      eye[0] + forward[0] * orbitDistance,
      eye[1] + forward[1] * orbitDistance,
      eye[2] + forward[2] * orbitDistance,
    ]
    await page.evaluate(
      ({ eye, target }) => window.__hew_test!.setCamera({ position: eye, target, up: [0, 0, 1], fovDeg: 45 }),
      { eye, target },
    )
    await page.waitForTimeout(100)

    const before = await page.evaluate(() => window.__hew_test!.getCameraState())
    const oldTargetDistance = Math.hypot(...before.eye.map((v, i) => v - before.target[i]))
    expect(oldTargetDistance).toBeCloseTo(orbitDistance, 2)

    // A small Zoom Window rectangle CENTERED on the canvas — its center
    // ray is (very close to) the camera's own straight-ahead direction, the
    // same `forward` computed above — so the fallback's own math (doc
    // comment) should re-target at very nearly the SAME depth (~3 m), not
    // the ~100 m-away ground hit a broken (accepts-any-ground-hit, or
    // teleports-to-the-raw-hit) fallback would land on.
    const box = await page.locator('canvas').first().boundingBox()
    if (box === null) throw new Error('no canvas')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.getByRole('button', { name: 'Camera' }).click()
    await page.getByText('Zoom Window', { exact: true }).click()
    await page.mouse.move(cx - 30, cy - 30)
    await page.mouse.down()
    await page.mouse.move(cx + 30, cy + 30, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    const after = await page.evaluate(() => window.__hew_test!.getCameraState())
    // Deliberately measured from the OLD eye position, not the new
    // eye-to-target distance: Zoom Window ALSO scales the eye-to-target
    // distance by the drawn rectangle's size (the whole point of the
    // gesture — a small rect zooms in a lot), so the post-zoom distance is
    // expected to shrink regardless of whether the fallback is correct.
    // What this test cares about is the DEPTH `pickDepthAlongRay`'s
    // fallback found ALONG THE RAY — i.e. how far the new `controls.target`
    // sits from where the eye WAS — which the fallback's own math (doc
    // comment above) places at very nearly the old orbit distance (~3 m),
    // not the ~100 m-away ground hit a broken fallback would use instead.
    const newTargetDepth = Math.hypot(...after.target.map((v, i) => v - before.eye[i]))
    expect(newTargetDepth).toBeGreaterThan(oldTargetDistance / 1.5)
    expect(newTargetDepth).toBeLessThan(oldTargetDistance * 1.5)

    // The eye itself must not have teleported hundreds of metres away — it
    // stays near its ORIGINAL position (a Zoom Window over open space with
    // no valid depth reference reframes locally, it doesn't fling the
    // camera across the map).
    const eyeMoved = Math.hypot(...after.eye.map((v, i) => v - before.eye[i]))
    expect(eyeMoved).toBeLessThan(20)
  })
})
