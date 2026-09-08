import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * Idle-CPU E2E for the on-demand render loop (docs/design/v1.1-cycle.md,
 * Lane F — "Render loop on demand"). Before this change, Viewport's
 * `render()` re-armed `requestAnimationFrame` unconditionally as its first
 * statement, so the pump ran at the display refresh rate for the entire life
 * of the viewport — whether or not anything on screen was actually changing.
 * These assert the pump actually goes idle: `frameCount()` (rAF callbacks
 * the pump has run — `viewport/renderScheduler.ts`, exposed on
 * `window.__hew_test` for exactly this) barely advances while nothing is
 * happening, and advances-then-settles across a real orbit drag.
 */

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
}

test.beforeEach(async ({ page }) => {
  await setup(page)
})

test('the render pump goes idle: frameCount barely advances after 2s of no input', async ({ page }) => {
  // Let whatever the initial mount kicked off (the first frame(s), any
  // startup layout/resize) settle before taking the baseline — the pump
  // going idle is the claim, not that it never renders at all.
  await page.waitForTimeout(300)
  const before = await page.evaluate(() => window.__hew_test!.frameCount())
  await page.waitForTimeout(2000)
  const after = await page.evaluate(() => window.__hew_test!.frameCount())
  expect(after - before).toBeLessThanOrEqual(2)
})

test('an orbit drag advances frames, then the pump settles again', async ({ page }) => {
  await page.waitForTimeout(300)
  const canvas = await page.locator('canvas').first().boundingBox()
  if (canvas === null) throw new Error('no canvas')
  const cx = canvas.x + canvas.width / 2
  const cy = canvas.y + canvas.height / 2

  const beforeDrag = await page.evaluate(() => window.__hew_test!.frameCount())
  // A real middle-drag orbit (OrbitControls' MIDDLE = ROTATE binding) —
  // real mouse events, not synthetic value-setting, so this exercises the
  // actual 'start'/'change'/'end' listener wiring that (re-)arms the pump.
  // Deliberately modest (a light flick, not a big swing): OrbitControls'
  // change-detection epsilon (`_EPS = 1e-6`, squared-distance) is tight
  // enough relative to typical model scale that a large drag's damping
  // tail can measurably run for a couple of seconds — real, pre-existing
  // damping physics unrelated to the on-demand pump, just invisible
  // before this change because the free-running pump always kept
  // rendering regardless. A small flick settles quickly and still proves
  // the point: the pump renders real frames during the gesture, then goes
  // idle again on its own.
  await page.mouse.move(cx, cy)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(cx + 40, cy + 15, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  const afterDrag = await page.evaluate(() => window.__hew_test!.frameCount())
  // The drag itself (each pointermove calls scheduleRender) rendered real
  // frames — the pump was not idle during the gesture.
  expect(afterDrag - beforeDrag).toBeGreaterThan(2)

  // Poll (rather than assert a single fixed window) until the pump has
  // gone idle again — the damping tail decays by a FIXED FRACTION per
  // rendered frame, not a fixed wall-clock amount, so its real-world
  // duration depends on the actual frame rate the test happened to get
  // (machine load, CI contention); a fixed-window assertion here would be
  // exactly the kind of timing flake that on-demand rendering itself
  // doesn't have. Two consecutive quiet windows (same ≤2-frames-per-400ms
  // threshold as the idle test above) count as settled.
  let quietWindows = 0
  let last = await page.evaluate(() => window.__hew_test!.frameCount())
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && quietWindows < 2) {
    await page.waitForTimeout(400)
    const now = await page.evaluate(() => window.__hew_test!.frameCount())
    quietWindows = now - last <= 2 ? quietWindows + 1 : 0
    last = now
  }
  expect(quietWindows).toBeGreaterThanOrEqual(2)
})

test('document.visibilitychange gates the pump at the Viewport integration level: no frames while hidden, resumes when visible', async ({ page }) => {
  // Adversarial-review coverage gap: the two tests above never actually
  // exercise Viewport's own `document.visibilitychange` listener
  // (`onVisibilityChange` -> `renderScheduler.setVisible()`) — a real
  // background tab/minimized window is exactly what that listener reacts
  // to, but a headless Playwright page never naturally goes `hidden`, so
  // without an explicit override this integration path had zero coverage.
  // `document.visibilityState`/`.hidden` are getter-only on the real
  // `Document` prototype; overriding them with own-properties + manually
  // dispatching the event is the standard technique for testing
  // Page-Visibility-API-driven code without an actual OS-level occlusion.
  await page.waitForTimeout(300)

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hiddenAt = await page.evaluate(() => window.__hew_test!.frameCount())

  // A REAL document mutation while hidden — drawBox reaches Viewport's
  // handleSceneRefresh -> scheduleRender() -> renderScheduler.request(),
  // the exact path a real edit takes. If visibility gating were broken
  // (RenderScheduler still requesting frames while `visible` is false),
  // this alone would advance frameCount; `setVisible(false)` is documented
  // to both cancel any pending frame AND block further `request()` calls.
  await page.evaluate(() => window.__hew_test!.drawBox([80, 80, 0], [81, 81, 0], 1))
  await page.waitForTimeout(500)
  const afterMutationHidden = await page.evaluate(() => window.__hew_test!.frameCount())
  expect(afterMutationHidden).toBe(hiddenAt)

  // Restore visibility — Viewport's own `onVisibilityChange` handler calls
  // `scheduleRender()` on becoming visible (RenderScheduler.setVisible(true)
  // alone does not request a frame by design; the caller must follow up
  // explicitly), so the pump should resume and present the mutation that
  // landed while hidden.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(300)
  const afterVisible = await page.evaluate(() => window.__hew_test!.frameCount())
  expect(afterVisible).toBeGreaterThan(afterMutationHidden)
})
