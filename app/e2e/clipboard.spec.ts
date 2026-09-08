import { test, expect, type Page } from '@playwright/test'
import {
  buildViewProjection,
  worldToPagePixel,
  type CameraParams,
  type Mat4,
} from './helpers/projectWorldToScreen'

/**
 * Copy/Cut/Paste/Paste In Place (docs/design/v1.1-cycle.md Lane D): the
 * always-on JS keydown bindings (⌘C/⌘X/⌘V/⇧⌘V — no native accelerator, see
 * main.rs's comment by `edit_cut`), driven with real keyboard + mouse
 * events, exactly like `playtest-fixes.spec.ts`'s Move+Alt copy specs.
 *
 * Cross-window paste (the Tauri shared-clipboard mirror) is desktop-only
 * and can't be exercised by this web-build suite — `modelClipboard.test.ts`
 * covers that half in isolation (mocked `@tauri-apps/api/core`).
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

const CAMERA: CameraParams = {
  position: { x: 8, y: 6, z: 8 },
  target: { x: 1, y: 1, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fovDeg: 45,
  near: 0.1,
  far: 1000,
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

async function pinCamera(page: Page, cam: CameraParams): Promise<Ctx> {
  await page.evaluate(
    (c) =>
      window.__hew_test!.setCamera({
        position: [c.position.x, c.position.y, c.position.z],
        target: [c.target.x, c.target.y, c.target.z],
        up: [c.up.x, c.up.y, c.up.z],
        fovDeg: c.fovDeg,
      }),
    cam,
  )
  const box = await page.locator('canvas').first().boundingBox()
  if (box === null) throw new Error('viewport canvas has no bounding box')
  const rect = { left: box.x, top: box.y, width: box.width, height: box.height }
  return { vp: buildViewProjection(cam, rect.width / rect.height), rect }
}

async function setup(page: Page): Promise<Ctx> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
  return pinCamera(page, CAMERA)
}

async function clickWorld(page: Page, ctx: Ctx, x: number, y: number, z: number): Promise<void> {
  const p = px(ctx, x, y, z)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
}

/** A real double-click at a world point — opens a session (group or
 *  component) on whatever it resolves to, mirroring group-session.spec.ts's
 *  own helper of the same name. */
async function dblClickWorld(page: Page, ctx: Ctx, x: number, y: number, z: number): Promise<void> {
  const p = px(ctx, x, y, z)
  await page.mouse.move(p.x, p.y)
  await page.mouse.click(p.x, p.y, { clickCount: 2 })
}

/** Activate a tool with no rail slot via the web MenuBar's Tools dropdown —
 *  mirrors axes-tool.spec.ts's own helper (Drawing Axes lives here, not on
 *  the rail). Blurs afterward so a following `page.keyboard.press` reaches
 *  the canvas, not the menu item's button. */
async function activateFromToolsMenu(page: Page, label: string): Promise<void> {
  const menuBar = page.getByTestId('menu-bar')
  await menuBar.getByRole('button', { name: /^tools$/i }).click()
  await menuBar.getByText(label, { exact: true }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

// Paste target: world (2,-2,0) projects (under CAMERA) onto open canvas, well
// clear of the bottom Draw dock's buttons — a farther point like (4,4,0)
// projects UNDER that fixed overlay, so the "click" lands on a tool button
// instead of committing the placement.

test('Copy then Paste places a second box at the click point', async ({ page }) => {
  const ctx = await setup(page)
  const id = await page.evaluate(() => window.__hew_test!.drawBox([0, 0, 0], [1, 1, 0], 1))
  await page.evaluate((oid) => window.__hew_test!.selectObjects([oid]), id)
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 1)

  await page.keyboard.press('Control+c')
  await expect(page.getByText('Copied 1 object', { exact: false })).toBeVisible()

  await page.keyboard.press('Control+v')
  // The ghost is armed — a click on open ground commits the paste there.
  await clickWorld(page, ctx, 2, -2, 0)

  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 2)
  // The pasted copy is now the selection (LibraryPlaceTool's onPlaced
  // contract), distinct from the original.
  const selection = await page.evaluate(() => window.__hew_test!.getSelection())
  expect(selection).toHaveLength(1)
  expect(selection[0].id).not.toBe(id)

  // The original is untouched — a real second box exists, not a move.
  const originalBounds = await page.evaluate((oid) => window.__hew_test!.getObjectBounds(oid), id)
  expect(originalBounds[0]).toBeCloseTo(0, 5)
  expect(originalBounds[1]).toBeCloseTo(0, 5)
})

test('Paste In Place inserts at the original position with no click, no armed gesture', async ({ page }) => {
  await setup(page)
  const id = await page.evaluate(() => window.__hew_test!.drawBox([2, 2, 0], [3, 3, 0], 1))
  await page.evaluate((oid) => window.__hew_test!.selectObjects([oid]), id)
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 1)
  const originalBounds = await page.evaluate((oid) => window.__hew_test!.getObjectBounds(oid), id)

  await page.keyboard.press('Control+c')
  await expect(page.getByText('Copied 1 object', { exact: false })).toBeVisible()

  await page.keyboard.press('Control+Shift+v')
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 2)

  const selection = await page.evaluate(() => window.__hew_test!.getSelection())
  expect(selection).toHaveLength(1)
  const pastedId = selection[0].id
  expect(pastedId).not.toBe(id)
  const pastedBounds = await page.evaluate((oid) => window.__hew_test!.getObjectBounds(oid), pastedId)
  // Identity affine: the pasted copy overlaps the original exactly.
  for (let i = 0; i < 6; i++) {
    expect(pastedBounds[i]).toBeCloseTo(originalBounds[i], 5)
  }
})

test('Cut removes the original and leaves the clipboard pasteable', async ({ page }) => {
  const ctx = await setup(page)
  const id = await page.evaluate(() => window.__hew_test!.drawBox([0, 0, 0], [1, 1, 0], 1))
  await page.evaluate((oid) => window.__hew_test!.selectObjects([oid]), id)
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 1)

  await page.keyboard.press('Control+x')
  // Cut = Copy (async: hashes the bytes before the clipboard is actually
  // set) + delete — wait for the "Copied" toast (Copy's own completion
  // signal, same as every other test here) before Ctrl+V, or a fast
  // keypress can race the still-in-flight clipboard write and land on an
  // empty clipboard (a silent no-op paste).
  await expect(page.getByText('Copied 1 object', { exact: false })).toBeVisible()
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 0)

  await page.keyboard.press('Control+v')
  await clickWorld(page, ctx, 2, -2, 0)
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 1)
})

test('a sketch-only selection refuses Copy with a toast, not a crash', async ({ page }) => {
  const ctx = await setup(page)
  // A detached (never-extruded) rectangle sketch — `drawRectangle` leaves
  // exactly that behind, the sketch-scoped selection Copy must refuse.
  await page.evaluate(() => window.__hew_test!.drawRectangle([0, 0, 0], [1, 1, 0]))
  // Click its fill (a real gesture, not a constructed NodeRef — region/island
  // ids aren't the same numbering) to select the whole island.
  await clickWorld(page, ctx, 0.5, 0.5, 0)
  await page.waitForFunction(() => {
    const sel = window.__hew_test!.getSelection()
    return sel.length === 1 && sel[0].kind === 'sketch-island'
  })
  await page.keyboard.press('Control+c')
  await expect(page.getByText(/Sketch geometry can't be copied yet/)).toBeVisible()
})

test('Cut of a multi-node selection is ONE undo step — a single Ctrl+Z restores everything', async ({ page }) => {
  await setup(page)
  const ids = await page.evaluate(() => {
    const h = window.__hew_test!
    const a = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const b = h.drawBox([3, 0, 0], [4, 1, 0], 1)
    const c = h.drawBox([6, 0, 0], [7, 1, 0], 1)
    return { a, b, c }
  })
  await page.evaluate(
    (nodeIds) => window.__hew_test!.selectObjects(nodeIds),
    [ids.a, ids.b, ids.c],
  )
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 3)

  await page.keyboard.press('Control+x')
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 0)

  // ONE undo restores all three — `Scene.delete_selection` batches the
  // whole cut into a single compound undo entry (adversarial review
  // finding 3), not three separate `delete_node` entries a single Ctrl+Z
  // would only partially unwind.
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 3)
  const restoredIds = new Set(await page.evaluate(() => window.__hew_test!.getObjectIds()))
  expect(restoredIds).toEqual(new Set([ids.a, ids.b, ids.c]))
})

test('Paste In Place overlaps the original even when the drawing axes are moved', async ({ page }) => {
  const ctx = await setup(page)

  // Move the drawing axes off world identity with a REAL 3-click gesture —
  // axes-tool.spec.ts's own box/vertices, verbatim (a box near the camera's
  // target so the picks land precisely; see that spec's module doc for why
  // the TOP face, not bottom, from this camera pose, and why these three
  // particular vertices give a genuine non-identity rotation).
  await page.evaluate(() => window.__hew_test!.drawBox([0, 0, 0], [2, 2, 0], 1))
  await activateFromToolsMenu(page, 'Drawing Axes')
  await clickWorld(page, ctx, 0, 0, 1) // new origin
  await clickWorld(page, ctx, 0, 2, 1) // red (X) direction pick
  await clickWorld(page, ctx, 2, 0, 1) // green (Y) direction pick — commits
  const axes = await page.evaluate(() => window.__hew_test!.getDrawingAxes())
  expect(axes).not.toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])

  // The object under test, drawn AFTER the axes moved and well clear of the
  // axes-gesture box above — copied and pasted in place with the axes
  // still non-identity throughout.
  const id = await page.evaluate(() => window.__hew_test!.drawBox([5, 5, 0], [6, 6, 0], 1))
  await page.evaluate((oid) => window.__hew_test!.selectObjects([oid]), id)
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 1)
  const originalBounds = await page.evaluate((oid) => window.__hew_test!.getObjectBounds(oid), id)

  await page.keyboard.press('Control+c')
  await expect(page.getByText('Copied 1 object', { exact: false })).toBeVisible()

  const before = await page.evaluate(() => window.__hew_test!.getObjectCount())
  await page.keyboard.press('Control+Shift+v')
  await page.waitForFunction(
    (n) => window.__hew_test!.getObjectCount() === n,
    before + 1,
  )

  const selection = await page.evaluate(() => window.__hew_test!.getSelection())
  expect(selection).toHaveLength(1)
  const pastedId = selection[0].id
  expect(pastedId).not.toBe(id)
  const pastedBounds = await page.evaluate((oid) => window.__hew_test!.getObjectBounds(oid), pastedId)
  // The kernel-computed `extract_item_placement` affine (the axes frame's
  // own forward transform, since extract_item does NOT re-origin when the
  // axes are moved) reconstructs the original position exactly — a bare
  // identity affine would instead have left it near the moved axes' own
  // origin, nowhere close to (2,2,0)-(3,3,1).
  for (let i = 0; i < 6; i++) {
    expect(pastedBounds[i]).toBeCloseTo(originalBounds[i], 5)
  }
})

test('Cut, enter a group, Paste In Place inside the session: the part folds in as a member on close', async ({ page }) => {
  const ctx = await setup(page)

  // The group's one member (box) plus the part to cut — well clear of it,
  // so the cut/paste never touches the group's own geometry.
  const setupIds = await page.evaluate(() => {
    const h = window.__hew_test!
    const box = h.drawBox([0, 0, 0], [2, 1, 0], 1)
    const group = h.groupNodes([{ kind: 'object', id: box }])
    const part = h.drawBox([5, 5, 0], [6, 6, 0], 1)
    return { box, group, part }
  })
  const { group, part } = setupIds
  const originalPartBounds = await page.evaluate(
    (oid) => window.__hew_test!.getObjectBounds(oid),
    part,
  )

  // ---- 1. Select the part and Cut it (⌘X).
  await page.evaluate((oid) => window.__hew_test!.selectObjects([oid]), part)
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 1)
  await page.keyboard.press('Control+x')
  await expect(page.getByText('Copied 1 object', { exact: false })).toBeVisible()
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 1)
  const hashAfterCut = await page.evaluate(() => window.__hew_test!.getStateHash())

  // ---- 2. Double-click into the group to edit it — a real double-click,
  // not the harness.
  await dblClickWorld(page, ctx, 1, 0.5, 1)
  await page.waitForTimeout(200)
  const hashAfterOpen = await page.evaluate(() => window.__hew_test!.getStateHash())
  expect(hashAfterOpen).not.toBe(hashAfterCut)

  // ---- 3. Paste In Place (⇧⌘V) WHILE the session is open — `insert_item`
  // is not refused during a group session (only a component session
  // refuses ExplodeSessionScope): the pasted part lands surfaced, inside
  // the session's own scope.
  await page.keyboard.press('Control+Shift+v')
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 2)
  const selection = await page.evaluate(() => window.__hew_test!.getSelection())
  expect(selection).toHaveLength(1)
  const pastedId = selection[0].id
  expect(pastedId).not.toBe(part)
  const pastedBoundsInSession = await page.evaluate(
    (oid) => window.__hew_test!.getObjectBounds(oid),
    pastedId,
  )
  for (let i = 0; i < 6; i++) {
    expect(pastedBoundsInSession[i]).toBeCloseTo(originalPartBounds[i], 5)
  }
  const hashAfterPaste = await page.evaluate(() => window.__hew_test!.getStateHash())
  expect(hashAfterPaste).not.toBe(hashAfterOpen)

  // ---- 4. Exit the edit (Escape) — every node surfaced since the session
  // opened folds into the group at close (`exit_group_session` /
  // `nodes_surfaced_since`), so the pasted part becomes a member, at its
  // original (pasted) position — folding is pure tree bookkeeping, no
  // geometry change.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const membersAfter = await page.evaluate((g) => window.__hew_test!.getGroupMembers(g), group)
  expect(membersAfter.map((m) => m.id).sort()).toEqual(
    [setupIds.box, pastedId].sort(),
  )
  const pastedBoundsAfterClose = await page.evaluate(
    (oid) => window.__hew_test!.getObjectBounds(oid),
    pastedId,
  )
  for (let i = 0; i < 6; i++) {
    expect(pastedBoundsAfterClose[i]).toBeCloseTo(originalPartBounds[i], 5)
  }
  const hashAfterClose = await page.evaluate(() => window.__hew_test!.getStateHash())
  expect(hashAfterClose).not.toBe(hashAfterPaste)

  // ---- 5. One undo per step restores each in turn: close → paste → open
  // → cut, each a single labeled undo entry (DEVELOPMENT.md rule 9: undo
  // is subject to the same replay contract inside a session as outside
  // it).
  await page.keyboard.press('Control+z') // undoes the close/fold
  await page.waitForFunction(
    (h) => window.__hew_test!.getStateHash() === h,
    hashAfterPaste,
  )
  await page.keyboard.press('Control+z') // undoes the paste
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 1)
  await page.keyboard.press('Control+z') // undoes opening the session
  await page.waitForFunction(
    (h) => window.__hew_test!.getStateHash() === h,
    hashAfterCut,
  )
  await page.keyboard.press('Control+z') // undoes the cut
  await page.waitForFunction(() => window.__hew_test!.getObjectCount() === 2)
  const restoredPartId = (await page.evaluate(() => window.__hew_test!.getObjectIds())).find(
    (id) => id !== setupIds.box,
  )
  expect(restoredPartId).toBeDefined()
  const restoredBounds = await page.evaluate(
    (oid) => window.__hew_test!.getObjectBounds(oid),
    restoredPartId,
  )
  expect(restoredBounds).toEqual(originalPartBounds)
})

test('Paste In Place is refused with a clear toast while a component session is open', async ({ page }) => {
  const ctx = await setup(page)

  const setupIds = await page.evaluate(() => {
    const h = window.__hew_test!
    const member = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const { instance } = h.makeComponent([member])
    const part = h.drawBox([5, 5, 0], [6, 6, 0], 1)
    return { instance, part }
  })

  // Copy a part, then double-click the instance to open its component
  // session — a real double-click, not the harness.
  await page.evaluate((oid) => window.__hew_test!.selectObjects([oid]), setupIds.part)
  await page.waitForFunction(() => window.__hew_test!.getSelection().length === 1)
  await page.keyboard.press('Control+c')
  await expect(page.getByText('Copied 1 object', { exact: false })).toBeVisible()

  await dblClickWorld(page, ctx, 0.5, 0.5, 1)
  await page.waitForFunction(() => window.__hew_test!.getExplodeSessionInstance() !== null)

  // `insert_document` refuses `ExplodeSessionScope` while a COMPONENT
  // session is open (unlike a group session — see the test above) — a
  // clear toast, and the document untouched.
  const countBefore = await page.evaluate(() => window.__hew_test!.getObjectCount())
  await page.keyboard.press('Control+Shift+v')
  await expect(
    page.getByText(/isn't available while a group or component is open for editing/),
  ).toBeVisible()
  expect(await page.evaluate(() => window.__hew_test!.getObjectCount())).toBe(countBefore)
  expect(await page.evaluate(() => window.__hew_test!.getExplodeSessionInstance() !== null)).toBe(
    true,
  )

  await page.keyboard.press('Escape')
})
