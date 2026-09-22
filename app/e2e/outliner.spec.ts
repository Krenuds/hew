import { test, expect, type Page, type Locator } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * Outliner search/visibility (docs/design/v1.1-cycle.md Lane D): the text
 * filter (matches + force-expanded ancestors), the root Model row's
 * whole-document hide-all-children eye, and a group row's own hide/show-all
 * control. Driven through the real DOM (the Outliner is plain DOM, not
 * canvas) plus `pickFace` to prove the kernel/renderer side of a hide, not
 * just the eye glyph.
 */

async function setup(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
}

/** The row `<div>` for a row whose label text is exactly `label` — the
 *  label `<span>`'s direct parent. Disambiguates a label that ALSO appears
 *  in the breadcrumb ("Model") by taking the LAST match: the breadcrumb
 *  renders above the tree, so the tree row is later in document order. */
function rowFor(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).last().locator('xpath=..')
}

test('filter shows a match and force-expands its ancestor group, hiding non-matching siblings', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const h = window.__hew_test!
    const alpha = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const beta = h.drawBox([3, 0, 0], [4, 1, 0], 1)
    const group = h.groupNodes([{ kind: 'object', id: alpha }])
    h.setNodeName('group', group, 'Container')
    h.setNodeName('object', alpha, 'Alpha')
    h.setNodeName('object', beta, 'Beta')
  })

  // Before filtering: the group starts collapsed, so "Alpha" isn't
  // rendered yet, and the sibling "Beta" is.
  await expect(page.getByText('Alpha', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Beta', { exact: true })).toBeVisible()

  await page.getByLabel('Filter outliner').fill('alpha')

  // The match's ancestor group force-expands, revealing "Alpha"...
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible()
  await expect(page.getByText('Container', { exact: true })).toBeVisible()
  // ...and the non-matching sibling is hidden from the list.
  await expect(page.getByText('Beta', { exact: true })).toHaveCount(0)

  // Clearing restores everything, including the group's expand state
  // (still expanded — filter/unfilter must not reset it).
  await page.getByLabel('Clear filter').click()
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible()
  await expect(page.getByText('Beta', { exact: true })).toBeVisible()
})

test('an empty filter result shows "No objects match"', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => window.__hew_test!.drawBox([0, 0, 0], [1, 1, 0], 1))
  await page.getByLabel('Filter outliner').fill('this matches nothing at all')
  await expect(page.getByText('No objects match')).toBeVisible()
})

test('a group\'s "hide/show all children" control hides every member, including a hidden grandchild, and pick-excludes them', async ({ page }) => {
  await setup(page)
  const ids = await page.evaluate(() => {
    const h = window.__hew_test!
    const a = h.drawBox([0, 0, 0], [1, 1, 0], 1) // direct child of the outer group
    const b = h.drawBox([3, 0, 0], [4, 1, 0], 1) // the GRANDCHILD — nested two levels deep
    const inner = h.groupNodes([{ kind: 'object', id: b }])
    const outer = h.groupNodes([
      { kind: 'object', id: a },
      { kind: 'group', id: inner },
    ])
    h.setNodeName('group', outer, 'Widgets')
    h.setNodeName('group', inner, 'Nested')
    return { a, b, inner, outer }
  })

  // Both the direct child (a) and the nested grandchild (b) pick before
  // anything is hidden.
  expect(await page.evaluate(() => window.__hew_test!.pickFace([0.5, 0.5, 5], [0, 0, -1]) !== null)).toBe(true)
  expect(await page.evaluate(() => window.__hew_test!.pickFace([3.5, 0.5, 5], [0, 0, -1]) !== null)).toBe(true)

  // Expand the OUTER group, then click its own "Hide all children" control
  // — the "Nested" group underneath it is never expanded in the DOM: the
  // batch hide (`collectDescendants`) reaches into it regardless, matching
  // the design's "digging into nested groups too."
  await rowFor(page, 'Widgets').getByRole('button').first().click() // the expand chevron
  await rowFor(page, 'Widgets').getByRole('button', { name: 'Hide all children' }).click()

  await page.waitForFunction(() => window.__hew_test!.pickFace([0.5, 0.5, 5], [0, 0, -1]) === null)
  // The grandchild is unpickable too, purely by inheriting its parent
  // ("Nested")'s hidden flag — `b` never gets its OWN hidden key (design:
  // "Hide all" sets each DIRECT child's key; descendants inherit").
  await page.waitForFunction(() => window.__hew_test!.pickFace([3.5, 0.5, 5], [0, 0, -1]) === null)
  expect(await page.evaluate((id) => window.__hew_test!.isNodeHidden({ kind: 'object', id }), ids.a)).toBe(true)
  expect(await page.evaluate((id) => window.__hew_test!.isNodeHidden({ kind: 'group', id }), ids.inner)).toBe(true)
  expect(await page.evaluate((id) => window.__hew_test!.isNodeHidden({ kind: 'object', id }), ids.b)).toBe(false)

  // The control now reads "Show all children"; clicking it restores both
  // the direct child and the nested grandchild.
  await rowFor(page, 'Widgets').getByRole('button', { name: 'Show all children' }).click()
  await page.waitForFunction(() => window.__hew_test!.pickFace([0.5, 0.5, 5], [0, 0, -1]) !== null)
  await page.waitForFunction(() => window.__hew_test!.pickFace([3.5, 0.5, 5], [0, 0, -1]) !== null)
})

test('dragging an object row onto a group row moves it into the group; undo restores', async ({ page }) => {
  await setup(page)
  const ids = await page.evaluate(() => {
    const h = window.__hew_test!
    const alpha = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const beta = h.drawBox([3, 0, 0], [4, 1, 0], 1)
    const target = h.groupNodes([{ kind: 'object', id: beta }])
    h.setNodeName('object', alpha, 'Alpha')
    h.setNodeName('group', target, 'Target')
    return { alpha, target }
  })

  // Before the drop: Alpha is top-level (no parent).
  expect(
    await page.evaluate((id) => window.__hew_test!.getNodeParent('object', id), ids.alpha),
  ).toBeNull()

  // Real mouse events, not the harness: press on the "Alpha" row, drag onto
  // the "Target" group row, release.
  const source = await rowFor(page, 'Alpha').boundingBox()
  const target = await rowFor(page, 'Target').boundingBox()
  if (source === null || target === null) throw new Error('rows not found')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
  await page.mouse.up()

  // The kernel tree changed: Alpha is now a member of Target.
  await page.waitForFunction(
    (id) => window.__hew_test!.getNodeParent('object', id) !== null,
    ids.alpha,
  )
  expect(
    await page.evaluate((id) => window.__hew_test!.getNodeParent('object', id), ids.alpha),
  ).toBe(ids.target)
  expect(
    await page.evaluate(
      (id) => window.__hew_test!.getGroupMembers(id).map((n) => n.id),
      ids.target,
    ),
  ).toContain(ids.alpha)

  // One undo restores it to the top level.
  await page.evaluate(() => window.__hew_test!.undo())
  expect(
    await page.evaluate((id) => window.__hew_test!.getNodeParent('object', id), ids.alpha),
  ).toBeNull()
})

test('a sketch row drags into a group, moves with it, and is still inside after a reload', async ({ page }) => {
  await setup(page)
  const ids = await page.evaluate(() => {
    const h = window.__hew_test!
    const wall = h.drawBox([0, 0, 0], [1, 1, 0], 1)
    const walls = h.groupNodes([{ kind: 'object', id: wall }])
    h.setNodeName('group', walls, 'Walls')
    const plan = h.drawRectangle([5, 5, 0], [8, 8, 0]).sketch
    h.setNodeName('sketch', plan, 'Ground floor')
    return { walls, plan }
  })
  const minX = (sketch: string) =>
    page.evaluate((s) => {
      const lines = window.__hew_test!.getSketchLines(s)
      let min = Infinity
      for (let i = 0; i < lines.length; i += 3) min = Math.min(min, lines[i])
      return min
    }, sketch)
  const planParent = () =>
    page.evaluate((id) => window.__hew_test!.getNodeParent('sketch', id), ids.plan)

  expect(await planParent()).toBeNull()

  // Real mouse events: carry the "Ground floor" row onto the "Walls" row.
  const source = await rowFor(page, 'Ground floor').boundingBox()
  const target = await rowFor(page, 'Walls').boundingBox()
  if (source === null || target === null) throw new Error('rows not found')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForFunction(
    (id) => window.__hew_test!.getNodeParent('sketch', id) !== null,
    ids.plan,
  )
  expect(await planParent()).toBe(ids.walls)

  // The row now sits under Walls, which opened for its newly selected
  // member; closing Walls tucks the plan away with the rest.
  await expect(rowFor(page, 'Ground floor')).toBeVisible()
  await rowFor(page, 'Walls').getByText('▾').click()
  await expect(page.getByText('Ground floor', { exact: true })).toHaveCount(0)
  await rowFor(page, 'Walls').getByText('▸').click()
  await expect(rowFor(page, 'Ground floor')).toBeVisible()

  // Moving the group moves the plan; one undo puts it back.
  expect(await minX(ids.plan)).toBeCloseTo(5)
  await page.evaluate((g) => window.__hew_test!.moveGroup(g, 10, 0, 0), ids.walls)
  expect(await minX(ids.plan)).toBeCloseTo(15)
  await page.evaluate(() => window.__hew_test!.undo())
  expect(await minX(ids.plan)).toBeCloseTo(5)

  // Save, reopen: still inside.
  const bytes = await page.evaluate(() => window.__hew_test!.save())
  await page.evaluate((b) => window.__hew_test!.load(b), bytes)
  const reloaded = await page.evaluate(() => {
    const h = window.__hew_test!
    const plan = h.getSketchIds()[0]
    return h.getNodeParent('sketch', plan)
  })
  expect(reloaded).not.toBeNull()
  expect(await page.evaluate(() => window.__hew_test!.getLastError())).toBeNull()
})

test('the root Model row\'s eye hides the whole document and restores it', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const h = window.__hew_test!
    h.drawBox([0, 0, 0], [1, 1, 0], 1)
    h.drawBox([3, 0, 0], [4, 1, 0], 1)
  })
  expect(await page.evaluate(() => window.__hew_test!.pickFace([0.5, 0.5, 5], [0, 0, -1]) !== null)).toBe(true)
  expect(await page.evaluate(() => window.__hew_test!.pickFace([3.5, 0.5, 5], [0, 0, -1]) !== null)).toBe(true)

  await rowFor(page, 'Model').getByRole('button', { name: 'Hide all children' }).click()
  await page.waitForFunction(() => window.__hew_test!.pickFace([0.5, 0.5, 5], [0, 0, -1]) === null)
  await page.waitForFunction(() => window.__hew_test!.pickFace([3.5, 0.5, 5], [0, 0, -1]) === null)

  await rowFor(page, 'Model').getByRole('button', { name: 'Show all children' }).click()
  await page.waitForFunction(() => window.__hew_test!.pickFace([0.5, 0.5, 5], [0, 0, -1]) !== null)
  await page.waitForFunction(() => window.__hew_test!.pickFace([3.5, 0.5, 5], [0, 0, -1]) !== null)
})
