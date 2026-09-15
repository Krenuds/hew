/**
 * Editable imprints (docs/design/editable-face-sketches.md; GitHub #9): a
 * shape drawn on a solid's face and not yet pushed is selectable by
 * clicking inside it, deletable, and movable on its face — driven here with
 * REAL pointer events over a pinned top-down camera, asserting the
 * harness's own view of the document (`getImprints`, `getSelection`).
 */
import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/** A 2 × 1 × 0.5 box; the camera looks straight down at its top (z = 0.5). */
async function setup(page: Page): Promise<string> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, { timeout: 15_000 })
  const object = await page.evaluate(() => {
    const h = window.__hew_test!
    const id = h.drawBox([0, 0, 0], [2, 1, 0], 0.5)
    h.setCamera({ position: [1, 0.5 - 0.01, 6], target: [1, 0.5, 0.5], up: [0, 0, 1], fovDeg: 45 })
    return id
  })
  await page.waitForTimeout(150)
  return object
}

async function pagePoint(page: Page, w: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('no canvas')
  const p = await page.evaluate((w) => window.__hew_test!.worldToScreen(w), w)
  return { x: box.x + p.x, y: box.y + p.y }
}

async function click(page: Page, w: [number, number, number]): Promise<void> {
  const p = await pagePoint(page, w)
  await page.mouse.move(p.x - 5, p.y - 3)
  await page.waitForTimeout(60)
  await page.mouse.move(p.x, p.y)
  await page.waitForTimeout(140)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(160)
}

/** Draw a rectangle on the top face with the Rectangle tool, corner to corner. */
async function drawRect(page: Page, a: [number, number, number], b: [number, number, number]): Promise<void> {
  await page.getByRole('radio', { name: 'Rectangle' }).click()
  await click(page, a)
  await click(page, b)
  await page.waitForTimeout(150)
}

async function imprints(page: Page, object: string) {
  return page.evaluate((o) => window.__hew_test!.getImprints(o), object)
}

async function selection(page: Page) {
  return page.evaluate(() => window.__hew_test!.getSelection())
}

function minX(loop: [number, number, number][]): number {
  return Math.min(...loop.map((p) => p[0]))
}

test('a rectangle drawn inside a face is one imprint; clicking inside it selects the imprint, elsewhere the solid', async ({ page }) => {
  const object = await setup(page)
  await drawRect(page, [0.5, 0.25, 0.5], [1, 0.75, 0.5])
  const list = await imprints(page, object)
  expect(list.length).toBe(1)
  expect(list[0].kind).toBe('sub_face')
  expect(list[0].name).toBe('Rectangle')

  await page.keyboard.press('Space') // Select
  await click(page, [0.75, 0.5, 0.5]) // inside the drawn shape
  let sel = await selection(page)
  expect(sel.length).toBe(1)
  expect(sel[0].kind).toBe('imprint')
  expect(sel[0].id).toBe(list[0].id)
  expect(sel[0].object).toBe(object)

  await click(page, [1.6, 0.5, 0.5]) // the same face, outside the shape
  sel = await selection(page)
  expect(sel.length).toBe(1)
  expect(sel[0].kind).toBe('object')
  expect(sel[0].id).toBe(object)
})

test('Delete dissolves a selected imprint back into its face, and undo brings it back', async ({ page }) => {
  const object = await setup(page)
  await drawRect(page, [0.5, 0.25, 0.5], [1, 0.75, 0.5])
  await page.keyboard.press('Space')
  await click(page, [0.75, 0.5, 0.5])
  expect((await selection(page))[0].kind).toBe('imprint')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(200)
  expect((await imprints(page, object)).length).toBe(0)
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(1)
  // The shape is gone from the selection too (nothing stale lingers).
  expect((await selection(page)).length).toBe(0)
  await page.evaluate(() => window.__hew_test!.undo())
  await page.waitForTimeout(150)
  expect((await imprints(page, object)).length).toBe(1)
})

test('Move slides a selected imprint across its face and keeps the selection; sliding it off the face is refused', async ({ page }) => {
  const object = await setup(page)
  await drawRect(page, [0.5, 0.25, 0.5], [1, 0.75, 0.5])
  await page.keyboard.press('Space')
  await click(page, [0.75, 0.5, 0.5])
  const before = (await imprints(page, object))[0]
  expect(minX(before.loop)).toBeCloseTo(0.5, 6)

  await page.keyboard.press('m') // Move
  await click(page, [0.75, 0.5, 0.5]) // base point inside the shape
  await click(page, [1.25, 0.5, 0.5]) // 0.5 m east, still on the top
  await page.waitForTimeout(200)
  const after = await imprints(page, object)
  expect(after.length).toBe(1)
  expect(after[0].id).toBe(before.id) // handle-stable: the same shape
  expect(minX(after[0].loop)).toBeCloseTo(1.0, 6)
  expect(after[0].loop.every((p) => Math.abs(p[2] - 0.5) < 1e-9)).toBe(true) // still on the face
  const sel = await selection(page)
  expect(sel[0].kind).toBe('imprint')
  expect(sel[0].id).toBe(before.id)

  // A drop past the east edge would leave the face: refused, nothing moves.
  await page.keyboard.press('Escape')
  await page.keyboard.press('m')
  await click(page, [1.25, 0.5, 0.5])
  await click(page, [1.9, 0.5, 0.5])
  await page.waitForTimeout(200)
  await expect(page.getByText(/fully inside the face/)).toBeVisible()
  const still = await imprints(page, object)
  expect(minX(still[0].loop)).toBeCloseTo(1.0, 6)
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(1)
})

test('a shape drawn up to a face edge selects by its line and deletes as a chord', async ({ page }) => {
  const object = await setup(page)
  // From the west edge's midpoint to a point on the north edge: two sides
  // lie ON the boundary, so the drawing is a chord run, not a sub-face.
  await drawRect(page, [0, 0.5, 0.5], [0.5, 1, 0.5])
  const list = await imprints(page, object)
  expect(list.length).toBe(1)
  expect(list[0].kind).toBe('chord')
  expect(list[0].name).toBe('Edge shape')

  await page.keyboard.press('Space')
  await click(page, [0.5, 0.75, 0.5]) // on the run's east side (x = 0.5)
  let sel = await selection(page)
  expect(sel.length).toBe(1)
  expect(sel[0].kind).toBe('imprint-chord')
  expect(sel[0].object).toBe(object)

  await page.keyboard.press('Delete')
  await page.waitForTimeout(200)
  expect((await imprints(page, object)).length).toBe(0)
  // The top is one face again: two rays into it land on the same face.
  const [a, b] = await page.evaluate(() => {
    const h = window.__hew_test!
    return [h.pickFace([0.25, 0.75, 5], [0, 0, -1]), h.pickFace([1.5, 0.25, 5], [0, 0, -1])]
  })
  expect(a!.face).toBe(b!.face)
  sel = await selection(page)
  expect(sel.length).toBe(0)
})

async function hover(page: Page, w: [number, number, number]): Promise<void> {
  const p = await pagePoint(page, w)
  await page.mouse.move(p.x - 5, p.y - 3)
  await page.waitForTimeout(60)
  await page.mouse.move(p.x, p.y)
  await page.waitForTimeout(180)
}

/** The inference chip's text (`InferenceTooltip`), or '' when none is shown. */
async function chip(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('div'))
      .filter((d) => d.style.zIndex === '20' && d.style.pointerEvents === 'none')
      .map((e) => e.textContent ?? '')
      .join(' | '),
  )
}

async function drawCircle(page: Page, center: [number, number, number], rim: [number, number, number]): Promise<void> {
  await page.getByRole('radio', { name: 'Circle' }).click()
  await click(page, center)
  await click(page, rim)
  await page.waitForTimeout(150)
}

test('a rectangle drawn all the way around a circle adopts it; deleting the rectangle keeps the circle', async ({ page }) => {
  const object = await setup(page)
  await drawCircle(page, [1, 0.5, 0.5], [1.15, 0.5, 0.5])
  await drawRect(page, [0.6, 0.2, 0.5], [1.4, 0.8, 0.5])
  await expect(page.getByText(/fully inside the face/)).toHaveCount(0)
  let list = await imprints(page, object)
  expect(list.map((f) => f.name).sort()).toEqual(['Circle', 'Rectangle'])

  await page.keyboard.press('Space')
  await click(page, [0.7, 0.3, 0.5]) // inside the rectangle, outside the circle
  const rect = list.find((f) => f.name === 'Rectangle')!
  const sel = await selection(page)
  expect(sel.length).toBe(1)
  expect(sel[0].kind).toBe('imprint')
  expect(sel[0].id).toBe(rect.id)

  await page.keyboard.press('Delete')
  await page.waitForTimeout(200)
  list = await imprints(page, object)
  expect(list.map((f) => f.name)).toEqual(['Circle'])
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(1)
})

test('a circle drawn on a face offers its center and quadrant snaps', async ({ page }) => {
  await setup(page)
  // Rim clicked half a facet step (3.75°) off the red axis, so no facet
  // vertex lands on a quadrant point for a 24- or 48-segment circle: an
  // exactly coincident vertex wins as Endpoint by design (the inference
  // crate's rank-group tie rule), on the ground as on a face.
  const a = (3.75 * Math.PI) / 180
  await drawCircle(page, [1, 0.5, 0.5], [1 + 0.2 * Math.cos(a), 0.5 + 0.2 * Math.sin(a), 0.5])
  await page.getByRole('radio', { name: 'Line' }).click()
  await hover(page, [1, 0.5, 0.5])
  expect(await chip(page)).toMatch(/center/i)
  await hover(page, [1, 0.7, 0.5])
  expect(await chip(page)).toMatch(/quadrant/i)
})

test('a circle whose center is clicked inside a small shape draws all the way around it (Playtest II)', async ({ page }) => {
  const object = await setup(page)
  await drawRect(page, [0.9, 0.4, 0.5], [1.1, 0.6, 0.5])
  // First click (the center) lands INSIDE the small rectangle.
  await drawCircle(page, [1, 0.5, 0.5], [1.3, 0.52, 0.5])
  await expect(page.getByText(/fully inside the face/)).toHaveCount(0)
  const list = await imprints(page, object)
  expect(list.map((f) => f.name).sort()).toEqual(['Circle', 'Rectangle'])
})

test('a circle pulled up keeps its identity on the raised rim: pushing that top through cuts a smooth tunnel', async ({ page }) => {
  const object = await setup(page)
  await drawCircle(page, [1, 0.5, 0.5], [1.2, 0.5, 0.5])
  const [circle] = await imprints(page, object)
  expect(circle.name).toBe('Circle')

  // Pull the circle up (a boss), then push its raised top straight down
  // through the whole solid. The tunnel's walls come from the raised rim's
  // edges: only if that rim still carries the circle do they stamp as a
  // cylinder, which the exporter re-facets to the requested density.
  const counts = await page.evaluate(
    ({ object, face }) => {
      const h = window.__hew_test!
      h.pushPull(object, face, 0.3)
      h.pushPull(object, face, -1.2)
      return [h.exportStl(0)?.triangleCount ?? 0, h.exportStl(96)?.triangleCount ?? 0]
    },
    { object, face: circle.id },
  )
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(1)
  const [stored, refaceted] = counts
  expect(stored).toBeGreaterThan(0)
  expect(refaceted).toBeGreaterThan(stored) // the tunnel is a true cylinder
})

test('a polygon whose center is clicked inside a small shape draws all the way around it (Playtest II)', async ({ page }) => {
  const object = await setup(page)
  await drawRect(page, [0.9, 0.4, 0.5], [1.1, 0.6, 0.5])
  await page.getByRole('radio', { name: 'Polygon' }).click()
  await click(page, [1, 0.5, 0.5])
  await click(page, [1.3, 0.52, 0.5])
  await page.waitForTimeout(150)
  await expect(page.getByText(/fully inside the face/)).toHaveCount(0)
  const list = await imprints(page, object)
  expect(list.length).toBe(2)
})

test('an arc drawn on a face keeps its circle on the D-shaped cut, so the raised wall is a true cylinder facet', async ({ page }) => {
  const object = await setup(page)
  // A 2-point arc from the south edge back into the face: endpoints on the
  // south edge (y = 0), bulge north into the face — the face-mode counterpart
  // of the "circle pulled up" test above, proving the OPEN chord commit
  // (`split_face_with_arc`) carries the drawn circle just like the closed
  // sub-face path does.
  await page.getByRole('radio', { name: 'Arc' }).click()
  await click(page, [0.6, 0, 0.5]) // endpoint A, on the south edge
  await click(page, [1.4, 0, 0.5]) // endpoint B, on the south edge
  await click(page, [1, 0.3, 0.5]) // bulge point, into the face
  await page.waitForTimeout(150)

  const list = await imprints(page, object)
  expect(list.length).toBe(1)
  expect(list[0].kind).toBe('chord')
  expect(list[0].name).toBe('Arc')
  expect(list[0].curves.length).toBeGreaterThan(0)
  expect(list[0].curves.every((c) => c !== null)).toBe(true)

  // Push the D-shaped face (south strip cut off by the arc) up, then compare
  // the stored facet count with a re-faceted export: only a true analytic
  // cylinder wall re-facets to MORE triangles at a higher segment density.
  const counts = await page.evaluate(
    ({ object }) => {
      const h = window.__hew_test!
      const picked = h.pickFace([1, 0.1, 5], [0, 0, -1])
      if (picked === null) return null
      h.pushPull(object, picked.face, 0.3)
      return [h.exportStl(0)?.triangleCount ?? 0, h.exportStl(96)?.triangleCount ?? 0]
    },
    { object },
  )
  await page.waitForTimeout(150)
  expect(counts).not.toBeNull()
  const [stored, refaceted] = counts!
  expect(stored).toBeGreaterThan(0)
  expect(refaceted).toBeGreaterThan(stored) // the wall is a true cylinder, not a facet approximation
})
