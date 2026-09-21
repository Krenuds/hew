import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * ViewCube (docs/design/camera.md §8) — the orientation gizmo in the
 * top-right of the viewport, driven through real pointer events on the real
 * widget and asserted through the harness's own `getCameraState()`.
 *
 * The contract worth testing here, and the reason this is its own file rather
 * than more of `camera.spec.ts` (which is scoped to Parallel Projection and
 * Zoom Window): **the cube reorients WITHOUT re-framing**. Clicking its Top
 * face and choosing Camera ▸ Standard Views ▸ Top point the camera the same
 * way, but only the menu re-fits the model. That difference is invisible to a
 * unit test and is exactly what a user would notice first if it regressed.
 *
 * The suite-wide storage state pins `hew.settings.viewCube` OFF (see
 * `playwright.config.ts`), so every spec here turns it on explicitly — the
 * same arrangement the welcome-screen specs use for their own pin.
 */

async function setup(page: Page): Promise<void> {
  // Seed the setting ON exactly once, then get out of the way. An init script
  // runs on EVERY navigation, so seeding unconditionally would re-enable the
  // cube across the `page.reload()` in the persistence test and quietly make
  // that assertion untestable. The sessionStorage latch survives a reload in
  // the same tab, so the app owns the value from the second load onwards.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('hew.e2e.viewCubeSeeded') === null) {
      sessionStorage.setItem('hew.e2e.viewCubeSeeded', '1')
      localStorage.setItem('hew.settings.viewCube', 'true')
    }
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
}

/** A box to frame, so `setStandardView` has something to fit to. */
async function drawBox(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__hew_test!.drawBox([0, 0, 0], [2, 3, 0], 1)
  })
}

async function cameraState(page: Page) {
  return page.evaluate(() => window.__hew_test!.getCameraState())
}

function direction(state: {
  eye: readonly number[]
  target: readonly number[]
}): [number, number, number] {
  const d: [number, number, number] = [
    state.eye[0] - state.target[0],
    state.eye[1] - state.target[1],
    state.eye[2] - state.target[2],
  ]
  const len = Math.hypot(...d)
  return [d[0] / len, d[1] / len, d[2] / len]
}

function distance(state: { eye: readonly number[]; target: readonly number[] }): number {
  return Math.hypot(
    state.eye[0] - state.target[0],
    state.eye[1] - state.target[1],
    state.eye[2] - state.target[2],
  )
}

/** Park the camera somewhere clearly off any standard view, so a reorient is
 * a real change and "distance preserved" is a meaningful claim. */
async function pinCamera(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__hew_test!.setCamera({
      position: [6, -7, 4],
      target: [1, 1, 0.5],
      up: [0, 0, 1],
      fovDeg: 45,
    })
  })
  await settle(page)
}

/** Let the 300ms region tween land. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(500)
}

/**
 * A menu item, by label.
 *
 * Anchored regex rather than `{ exact: true }`, because `CheckMenuItem`
 * renders the checkmark glyph as a SIBLING of the label inside one row: the
 * row's text is "✓View Cube", so no element's text is ever the label alone.
 * `camera.spec.ts` documents the same trap for Parallel Projection. Anchoring
 * also keeps "Zoom" from matching "Zoom Window" and "Zoom Extents", which a
 * bare substring would. Scoped to the menu bar because "Top" is a viewport
 * HUD chip too.
 */
function menuItem(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.getByTestId('menu-bar').getByText(new RegExp(`^\u2713?${escaped}$`))
}

/**
 * The clickable copy of a region.
 *
 * A region on a silhouette edge is emitted by two or three faces, and only
 * the well-facing ones take pointer events (`visibleFaces`). DOM order is not
 * that order, so `.first()` can land on a face the user cannot click. Pick by
 * the widest rendered box — the copy a hand would actually reach for.
 */
async function zone(page: Page, regionId: string) {
  const all = page.locator(`[data-region="${regionId}"]`)
  const count = await all.count()
  let best = 0
  let bestArea = -1
  for (let i = 0; i < count; i++) {
    const el = all.nth(i)
    const face = el.locator('xpath=ancestor::*[@data-face][1]')
    const interactive = await face.evaluate((f) => (f as HTMLElement).style.pointerEvents !== 'none')
    if (!interactive) continue
    const box = await el.boundingBox()
    const area = box === null ? -1 : box.width * box.height
    if (area > bestArea) {
      bestArea = area
      best = i
    }
  }
  expect(bestArea, `no clickable copy of region "${regionId}" is facing the camera`).toBeGreaterThan(0)
  return all.nth(best)
}

test.describe('ViewCube', () => {
  test('is shown by default and hides from View ▸ View Cube, and the choice survives a reload', async ({
    page,
  }) => {
    await setup(page)
    await expect(page.getByTestId('view-cube')).toBeVisible()

    await page.getByTestId('menu-bar').getByRole('button', { name: 'View' }).click()
    await menuItem(page, 'View Cube').click()
    await expect(page.getByTestId('view-cube')).toHaveCount(0)

    await page.reload()
    await page.waitForFunction(() => window.__hew_test?.isReady() === true)
    await expect(page.getByTestId('view-cube')).toHaveCount(0)

    await page.getByTestId('menu-bar').getByRole('button', { name: 'View' }).click()
    await menuItem(page, 'View Cube').click()
    await expect(page.getByTestId('view-cube')).toBeVisible()
  })

  test('clicking the Top face points the camera down WITHOUT re-framing — pivot and distance both survive', async ({
    page,
  }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    const before = await cameraState(page)
    await (await zone(page, 'top')).click()
    await settle(page)
    const after = await cameraState(page)

    // Pointed down: the baked Top eye is [0, -POLE_TILT, 1] normalized, so
    // Z dominates and the tiny -Y tilt is preserved (it is what keeps orbit
    // off the degenerate pole).
    const dir = direction(after)
    expect(dir[2]).toBeCloseTo(1, 3)
    expect(dir[0]).toBeCloseTo(0, 3)
    expect(dir[1]).toBeLessThan(0)

    // The whole point: nothing else moved.
    expect(after.target[0]).toBeCloseTo(before.target[0], 6)
    expect(after.target[1]).toBeCloseTo(before.target[1], 6)
    expect(after.target[2]).toBeCloseTo(before.target[2], 6)
    expect(distance(after)).toBeCloseTo(distance(before), 6)
  })

  test('Camera ▸ Standard Views ▸ Top DOES re-frame — the two paths are genuinely different', async ({
    page,
  }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    const before = await cameraState(page)
    await page.getByTestId('menu-bar').getByRole('button', { name: 'Camera' }).click()
    await page.getByTestId('menu-bar').getByText('Standard Views').hover()
    await menuItem(page, 'Top').click()
    await settle(page)
    const after = await cameraState(page)

    // Same direction as the cube's Top...
    expect(direction(after)[2]).toBeCloseTo(1, 3)
    // ...but it fits the model, so the distance moves off the pinned one.
    expect(Math.abs(distance(after) - distance(before))).toBeGreaterThan(0.1)
  })

  test('a corner region reaches the iso view', async ({ page }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    await (await zone(page, 'front-right-top')).click()
    await settle(page)

    const dir = direction(await cameraState(page))
    const iso = 1 / Math.sqrt(3)
    expect(dir[0]).toBeCloseTo(iso, 3)
    expect(dir[1]).toBeCloseTo(-iso, 3)
    expect(dir[2]).toBeCloseTo(iso, 3)
  })

  test('an edge region reaches the 45 degrees between two faces', async ({ page }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    await (await zone(page, 'front-right')).click()
    await settle(page)

    const dir = direction(await cameraState(page))
    const half = Math.SQRT1_2
    expect(dir[0]).toBeCloseTo(half, 3)
    expect(dir[1]).toBeCloseTo(-half, 3)
    expect(dir[2]).toBeCloseTo(0, 3)
  })

  test('dragging the cube orbits the camera, leaving the pivot and distance alone', async ({
    page,
  }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    const before = await cameraState(page)
    const box = (await page.getByTestId('view-cube').boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + 40

    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 30, cy, { steps: 6 })
    await page.mouse.move(cx + 60, cy, { steps: 6 })
    await page.mouse.up()
    await settle(page)

    const after = await cameraState(page)
    const d0 = direction(before)
    const d1 = direction(after)
    const dot = d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]
    expect(dot).toBeLessThan(0.999) // it actually turned

    expect(after.target[0]).toBeCloseTo(before.target[0], 4)
    expect(after.target[1]).toBeCloseTo(before.target[1], 4)
    expect(distance(after)).toBeCloseTo(distance(before), 4)
  })

  test('the projection glyphs switch projection and read back the live state', async ({ page }) => {
    await setup(page)
    await drawBox(page)

    const perspective = page.getByRole('button', { name: 'Perspective' })
    const parallel = page.getByRole('button', { name: 'Parallel Projection' })
    await expect(perspective).toHaveAttribute('aria-pressed', 'true')

    await parallel.click()
    await settle(page)
    expect((await cameraState(page)).projection).toBe('parallel')
    await expect(parallel).toHaveAttribute('aria-pressed', 'true')

    // Clicking the already-active one is a no-op, not a toggle.
    await parallel.click()
    await settle(page)
    expect((await cameraState(page)).projection).toBe('parallel')

    await perspective.click()
    await settle(page)
    expect((await cameraState(page)).projection).toBe('perspective')
  })

  test('the drag still orbits after a projection toggle rebuilds OrbitControls', async ({
    page,
  }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    // `rebindControlsForProjectionChange` disposes and replaces the controls
    // instance; `orbitBy` reads it through a closed-over `let`, and this is
    // the regression guard for that.
    await page.getByRole('button', { name: 'Parallel Projection' }).click()
    await settle(page)

    const before = await cameraState(page)
    const box = (await page.getByTestId('view-cube').boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + 40

    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 60, cy, { steps: 8 })
    await page.mouse.up()
    await settle(page)

    const d0 = direction(before)
    const d1 = direction(await cameraState(page))
    expect(d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]).toBeLessThan(0.999)
  })

  test('the Iso glyph re-frames, unlike every region on the cube itself', async ({ page }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    const before = await cameraState(page)
    await page.getByRole('button', { name: 'Iso View (fit)' }).click()
    await settle(page)

    const after = await cameraState(page)
    const iso = 1 / Math.sqrt(3)
    expect(direction(after)[0]).toBeCloseTo(iso, 3)
    expect(Math.abs(distance(after) - distance(before))).toBeGreaterThan(0.1)
  })

  test('the Zoom tool does not steal a cube click', async ({ page }) => {
    // The container-level fov-drag interceptor sees presses on every DOM
    // overlay inside the viewport, not just the canvas. Without its target
    // guard, clicking the cube under the Zoom tool armed an fov drag.
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    await page.getByTestId('menu-bar').getByRole('button', { name: 'Camera' }).click()
    await menuItem(page, 'Zoom').click()

    const before = await cameraState(page)
    await (await zone(page, 'top')).click()
    await settle(page)
    const after = await cameraState(page)

    expect(after.fovDeg).toBeCloseTo(before.fovDeg, 6)
    expect(direction(after)[2]).toBeCloseTo(1, 3)
  })

  test('every region is reachable and lands on a unit direction', async ({ page }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    // One of each kind, all reachable from the pinned front-right-top-ish
    // pose. Re-pin between hops: from a face-on view only THAT face is turned
    // toward you, so chaining face to face would test a journey the widget
    // does not offer. The full 26 are enumerated in viewCubeRegions.test.ts.
    for (const [id, expected] of [
      ['front', [0, -1, 0]],
      ['right', [1, 0, 0]],
      ['front-right', [Math.SQRT1_2, -Math.SQRT1_2, 0]],
      ['front-right-top', [1, -1, 1].map((n) => n / Math.sqrt(3))],
    ] as const) {
      await pinCamera(page)
      await (await zone(page, id)).click()
      await settle(page)
      const dir = direction(await cameraState(page))
      for (let i = 0; i < 3; i++) expect(dir[i]).toBeCloseTo(expected[i], 2)
    }
  })

  test('offers no way to click through to the far side of the cube', async ({ page }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    // Looking from the front-right-top, the opposite corner is behind the
    // cube. Its zones exist in the DOM — every region is emitted by the faces
    // that carry it — but none of them is on a face turned toward the viewer,
    // so nothing there can be clicked. Reaching it means orbiting first,
    // which is how every view cube behaves.
    const farSide = page.locator('[data-region="back-left-bottom"]')
    expect(await farSide.count()).toBeGreaterThan(0)
    for (let i = 0; i < (await farSide.count()); i++) {
      const face = farSide.nth(i).locator('xpath=ancestor::*[@data-face][1]')
      expect(await face.evaluate((f) => (f as HTMLElement).style.pointerEvents)).toBe('none')
    }
  })

  test('marks the region the camera is parked on', async ({ page }) => {
    await setup(page)
    await drawBox(page)
    await pinCamera(page)

    await expect(page.locator('[data-region][data-here="true"]')).toHaveCount(0)
    await (await zone(page, 'front')).click()
    await settle(page)
    await expect(page.locator('[data-region="front"][data-here="true"]').first()).toBeAttached()
  })
})
