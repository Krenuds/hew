import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * The "retype window" (tools/retypeWindow.ts), exercised on every draw tool
 * that carries one: after the committing click, typing an exact measurement
 * and pressing `Enter` redraws the shape just drawn, in place, rather than
 * starting a new one -- SketchUp's "draw roughly, then type the size",
 * repeatable until the next pointer action, Escape, tool switch, or other
 * model change. `rectangle-retype.spec.ts` covers Rectangle (the original,
 * `RectangleTool.ts`'s `RetypeHot`); this file covers the four tools it was
 * generalized to, each documented at the top of its own file:
 *
 *   - Circle (`CircleTool.ts` `RetypeSpec`): a typed radius after the rim
 *     click redraws the circle around the SAME centre.
 *   - Polygon (`PolygonTool.ts` `RetypeSpec`): a typed radius does the same,
 *     and a typed `Ns` also redraws the polygon at N sides, same radius --
 *     N then becomes the default for the next polygon.
 *   - Arc (`ArcTool.ts` `RetypeSpec`): a typed length after the bulge click
 *     redraws the arc with that |sagitta|, same side of the same chord,
 *     same open/pie/segment closure; a flat (zero) bulge is refused.
 *   - Line (`LineTool.ts` `RetypeSpec`): a typed length right after a click,
 *     with the pointer still, resizes THAT segment along its own direction;
 *     the pointer moving more than a few pixels closes the window, and a
 *     typed length then starts the NEXT segment along the cursor instead --
 *     the chain keeps going either way.
 *
 * Driven end to end with REAL pointer/keyboard events, mirroring
 * rectangle-retype.spec.ts's conventions.
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

async function moveToWorld(page: Page, w: [number, number, number]): Promise<void> {
  const p = await pagePoint(page, w)
  await page.mouse.move(p.x, p.y)
}

/** The document's one sketch, as its raw edge endpoints -- `getSketchLines`
 * returns every edge of the WHOLE sketch as flat xyz triples, so after a
 * retype (the old edges are undone, not just hidden) this is exactly the
 * current shape's geometry. Throws unless exactly one sketch exists. */
async function soleSketchLines(page: Page): Promise<{ sketch: string; lines: number[] }> {
  return page.evaluate(() => {
    const h = window.__hew_test!
    const ids = h.getSketchIds()
    if (ids.length !== 1) throw new Error(`expected exactly one sketch, found ${ids.length}`)
    const sketch = ids[0]
    return { sketch, lines: h.getSketchLines(sketch) }
  })
}

async function sketchCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__hew_test!.getSketchIds().length)
}

async function edgeCount(page: Page, sketch: string): Promise<number> {
  return page.evaluate((sketch) => window.__hew_test!.getSketchEdgeIds(sketch).length, sketch)
}

/** Farthest a flat xyz-triple list strays from the origin -- the radius of
 * a circle/polygon drawn centred there (every vertex sits exactly on the
 * commanded radius by construction, see CircleTool/PolygonTool's module
 * docs, so this is exact up to float error, not a facet approximation). */
function maxDistFromOrigin(lines: number[]): number {
  let m = 0
  for (let i = 0; i < lines.length; i += 3) {
    m = Math.max(m, Math.hypot(lines[i], lines[i + 1], lines[i + 2]))
  }
  return m
}

/** Centroid of a flat xyz-triple list. Every vertex of a regular N-gon
 * appears exactly twice in `getSketchLines`' edge-pair encoding (once as an
 * edge's `a`, once as the next edge's `b`), but that uniform doubling
 * doesn't move the average -- so this is exactly the shape's centre. */
function centroid(lines: number[]): [number, number, number] {
  let x = 0, y = 0, z = 0, n = 0
  for (let i = 0; i < lines.length; i += 3) {
    x += lines[i]; y += lines[i + 1]; z += lines[i + 2]; n++
  }
  return [x / n, y / n, z / n]
}

type Edge = { a: [number, number, number]; b: [number, number, number] }

/** `getSketchLines`' flat `[ax,ay,az, bx,by,bz, ...]` encoding, grouped into
 * per-edge endpoint pairs -- order is NOT assumed to match commit order, so
 * every Line-tool assertion below matches edges by endpoint, not index. */
function edgesOf(lines: number[]): Edge[] {
  const edges: Edge[] = []
  for (let i = 0; i < lines.length; i += 6) {
    edges.push({
      a: [lines[i], lines[i + 1], lines[i + 2]],
      b: [lines[i + 3], lines[i + 4], lines[i + 5]],
    })
  }
  return edges
}

function dist(p: [number, number, number], q: [number, number, number]): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

const EDGE_TOL_M = 1e-3

function edgeMatches(e: Edge, p: [number, number, number], q: [number, number, number]): boolean {
  return (
    (dist(e.a, p) < EDGE_TOL_M && dist(e.b, q) < EDGE_TOL_M) ||
    (dist(e.a, q) < EDGE_TOL_M && dist(e.b, p) < EDGE_TOL_M)
  )
}

// ---------------------------------------------------------------------------
// Circle
// ---------------------------------------------------------------------------

test.describe('Circle retype', () => {
  test('typing a radius after the rim click redraws the circle around the same centre; a bare letter still switches tools; one undo removes it', async ({
    page,
  }) => {
    await setup(page)
    await page.keyboard.press('c')
    await clickWorld(page, [0, 0, 0])
    await clickWorld(page, [1, 0, 0])
    await page.waitForTimeout(100)

    let { lines } = await soleSketchLines(page)
    expect(maxDistFromOrigin(lines)).toBeCloseTo(1, 3)
    let c = centroid(lines)
    expect(c[0]).toBeCloseTo(0, 3)
    expect(c[1]).toBeCloseTo(0, 3)

    // Retype to radius 2 -- same centre, still exactly one sketch.
    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    expect(await sketchCount(page)).toBe(1)
    ;({ lines } = await soleSketchLines(page))
    expect(maxDistFromOrigin(lines)).toBeCloseTo(2, 3)
    c = centroid(lines)
    expect(c[0]).toBeCloseTo(0, 3)
    expect(c[1]).toBeCloseTo(0, 3)

    // With the retype buffer empty, a bare letter keeps its global meaning:
    // 'p' switches to Push/Pull rather than being swallowed by the window.
    await page.keyboard.press('p')
    await page.waitForTimeout(100)
    await expect(
      page.getByRole('radiogroup', { name: 'Tools' }).getByRole('radio', { name: 'Push/Pull' }),
    ).toHaveAttribute('aria-checked', 'true')

    // One undo retracts the whole circle -- the retype undid its
    // predecessor before recommitting, so only one committed step remains.
    await page.evaluate(() => window.__hew_test!.undo())
    await page.waitForTimeout(100)
    expect(await sketchCount(page)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Polygon
// ---------------------------------------------------------------------------

test.describe('Polygon retype', () => {
  test('typing Ns then a radius after the rim click redraws the polygon just drawn, at N sides and the new radius', async ({
    page,
  }) => {
    await setup(page)
    const rail = page.getByRole('radiogroup', { name: 'Tools' })
    // Polygon has no letter shortcut -- activate the way a user does, from
    // the rail.
    await rail.getByRole('radio', { name: 'Polygon' }).click()
    await expect(rail.getByRole('radio', { name: 'Polygon' })).toHaveAttribute('aria-checked', 'true')

    await clickWorld(page, [0, 0, 0])
    await clickWorld(page, [1, 0, 0])
    await page.waitForTimeout(100)

    let { sketch, lines } = await soleSketchLines(page)
    expect(await edgeCount(page, sketch)).toBe(6) // DEFAULT_POLYGON_SIDES
    expect(maxDistFromOrigin(lines)).toBeCloseTo(1, 3)

    // `Ns` retypes the side count -- same radius, same centre.
    await page.keyboard.type('8s')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    expect(await sketchCount(page)).toBe(1)
    ;({ sketch, lines } = await soleSketchLines(page))
    expect(await edgeCount(page, sketch)).toBe(8)
    expect(maxDistFromOrigin(lines)).toBeCloseTo(1, 3)

    // A typed radius then retypes at that radius -- the 8 sides persist.
    await page.keyboard.type('1.5')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    expect(await sketchCount(page)).toBe(1)
    ;({ sketch, lines } = await soleSketchLines(page))
    expect(await edgeCount(page, sketch)).toBe(8)
    expect(maxDistFromOrigin(lines)).toBeCloseTo(1.5, 3)
  })
})

// ---------------------------------------------------------------------------
// Arc
// ---------------------------------------------------------------------------

/** Farthest a flat xyz-triple list rises in +Y -- the chord A(0,0,0)-B(2,0,0)
 * used below lies exactly on the X axis at z=0, so distance from the chord
 * (an infinite line here, matching the drawn segment) is just a vertex's Y
 * coordinate; its sign says which side of the chord the bulge is on. */
function maxYFromChord(lines: number[]): number {
  let m = -Infinity
  for (let i = 0; i < lines.length; i += 3) m = Math.max(m, lines[i + 1])
  return m
}

test.describe('Arc retype', () => {
  test('typing a bulge length after the third click redraws the arc on the same side of the same chord', async ({
    page,
  }) => {
    await setup(page)
    await page.keyboard.press('a')
    await clickWorld(page, [0, 0, 0])
    await clickWorld(page, [2, 0, 0])
    await clickWorld(page, [1, 0.5, 0]) // move to pull the bulge, then click to commit
    await page.waitForTimeout(100)

    expect(await sketchCount(page)).toBe(1)
    let maxY = maxYFromChord((await soleSketchLines(page)).lines)
    expect(maxY).toBeGreaterThan(0) // bulges toward +y, as clicked

    // Retype the bulge to an exact length -- same chord, same (+y) side.
    await page.keyboard.type('1')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    expect(await sketchCount(page)).toBe(1)
    maxY = maxYFromChord((await soleSketchLines(page)).lines)
    // Every interior vertex sits exactly on the arc's true circle
    // (`arcPolyline`/`arcPolylineOnPlane`: center + radius + angle, never
    // integrated step-by-step), so this is exact up to float error, not a
    // facet approximation -- but the tolerance is kept a touch looser than
    // the other shapes' since the nearest facet vertex to the true apex can
    // sit a fraction of a millimeter short of it.
    expect(maxY).toBeCloseTo(1, 2)
  })

  test('typing 0 for the bulge does not change the arc (refused, not committed)', async ({ page }) => {
    await setup(page)
    await page.keyboard.press('a')
    await clickWorld(page, [0, 0, 0])
    await clickWorld(page, [2, 0, 0])
    await clickWorld(page, [1, 0.5, 0])
    await page.waitForTimeout(100)

    const before = (await soleSketchLines(page)).lines

    await page.keyboard.type('0')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    expect(await sketchCount(page)).toBe(1)
    const after = (await soleSketchLines(page)).lines
    expect(after).toEqual(before)
  })

  // A refused (flat) retype keeps the arc and shows the hint in the readout;
  // the key router's re-hover after Enter must not wipe it (ArcTool's idle
  // hover leaves the readout alone while the retype window is open).
  test(
    'typing 0 for the bulge shows the "Pull out the bulge" hint',
    async ({ page }) => {
      await setup(page)
      await page.keyboard.press('a')
      await clickWorld(page, [0, 0, 0])
      await clickWorld(page, [2, 0, 0])
      await clickWorld(page, [1, 0.5, 0])
      await page.waitForTimeout(100)

      await page.keyboard.type('0')
      await page.keyboard.press('Enter')
      await expect(page.getByText('Pull out the bulge')).toBeVisible()
    },
  )
})

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

test.describe('Line retype', () => {
  test('typing a length right after a click, without moving, resizes the segment just placed and the chain continues from the new end', async ({
    page,
  }) => {
    await setup(page)
    await page.keyboard.press('l')
    await clickWorld(page, [0, 0, 0])
    await clickWorld(page, [1, 0, 0])
    await page.waitForTimeout(100)

    // No pointer movement since the second click -- typing a length resizes
    // THAT segment along its own direction instead of starting the next one.
    await page.keyboard.type('3')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    let edges = edgesOf((await soleSketchLines(page)).lines)
    expect(edges).toHaveLength(1)
    expect(edgeMatches(edges[0], [0, 0, 0], [3, 0, 0])).toBe(true)

    // Moving the pointer closes the retype window -- a typed length now
    // draws the NEXT segment along the cursor, continuing the chain from
    // the retyped end.
    await moveToWorld(page, [3, 2, 0])
    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    edges = edgesOf((await soleSketchLines(page)).lines)
    expect(edges).toHaveLength(2)
    expect(edges.some((e) => edgeMatches(e, [0, 0, 0], [3, 0, 0]))).toBe(true)
    expect(edges.some((e) => edgeMatches(e, [3, 0, 0], [3, 2, 0]))).toBe(true)
  })

  test('moving the pointer past the 4 px still threshold after a click closes the retype window -- a typed length after that starts the next segment, and the first is untouched', async ({
    page,
  }) => {
    await setup(page)
    await page.keyboard.press('l')
    await clickWorld(page, [0, 0, 0])
    await clickWorld(page, [1, 0, 0])
    await page.waitForTimeout(100)

    const p1 = await pagePoint(page, [1, 0, 0])
    await page.mouse.move(p1.x + 60, p1.y + 60) // well past the 4px "still" threshold
    await page.waitForTimeout(100)

    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(100)

    const edges = edgesOf((await soleSketchLines(page)).lines)
    expect(edges).toHaveLength(2)

    // First segment untouched.
    expect(edges.some((e) => edgeMatches(e, [0, 0, 0], [1, 0, 0]))).toBe(true)

    // Second segment starts at (1,0,0) and has the typed length -- direction
    // follows the cursor, so only its length and starting point are checked.
    const second = edges.find((e) => !edgeMatches(e, [0, 0, 0], [1, 0, 0]))
    expect(second).toBeDefined()
    const start = dist(second!.a, [1, 0, 0]) < EDGE_TOL_M ? second!.a : second!.b
    const end = start === second!.a ? second!.b : second!.a
    expect(dist(start, [1, 0, 0])).toBeLessThan(EDGE_TOL_M)
    expect(dist(start, end)).toBeCloseTo(2, 3)
  })
})
