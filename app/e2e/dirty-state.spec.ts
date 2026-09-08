import { test, expect, type Page } from '@playwright/test'

/**
 * Lane C — dirty-state E2E (docs/design/v1.1-cycle.md): the derived
 * `dirty` flag (`!scene.at_saved_mark() || nonUndoableDirty`, App.tsx's
 * `handleDocumentChanged`) end to end, through the real reconcile path
 * (window.__hew_test's `act`-backed methods) rather than a unit test's
 * hand-called `afterMutation`.
 *
 * The window/document TITLE is the signal under test: `deriveTitle`
 * (documentSession.ts) prepends "• " while dirty, and App.tsx's effect
 * pushes it straight to `document.title` — the web build's own tab title,
 * with no native title bar to intercept it. `toHaveTitle` polls, so no
 * manual waits are needed for the title effect to commit after a harness
 * mutation.
 */

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 20_000,
  })
}

test('a draw dirties the title; undo back to the start cleans it', async ({ page }) => {
  await page.goto('/')
  await waitForHarness(page)

  await expect(page).toHaveTitle(/^Untitled — Hew$/)

  await page.evaluate(() => {
    window.__hew_test!.drawBox([0, 0, 0], [1, 1, 0], 1)
  })
  await expect(page).toHaveTitle(/^• Untitled — Hew$/)

  // Undo the extrude, then the draw gesture — two undo entries for one box
  // (kernel: `saved_mark_specs.rs`'s `build_box`), back to the document's
  // ORIGINAL depth-0 state, which is clean by kernel default — no save
  // needed for this half of the round trip.
  await page.evaluate(() => window.__hew_test!.undo())
  await page.evaluate(() => window.__hew_test!.undo())
  await expect(page).toHaveTitle(/^Untitled — Hew$/)
})

test('save cleans the title; undo dirties it again; redo cleans it back up', async ({ page }) => {
  await page.goto('/')
  await waitForHarness(page)

  await page.evaluate(() => {
    window.__hew_test!.drawBox([0, 0, 0], [1, 1, 0], 1)
  })
  await expect(page).toHaveTitle(/^• Untitled — Hew$/)

  // saveWithCameraState mirrors App's real save flow: it marks the
  // document's CURRENT undo depth as the saved mark and reconciles, so the
  // title should clean up exactly as it would after a real File ▸ Save.
  await page.evaluate(() => window.__hew_test!.saveWithCameraState())
  await expect(page).toHaveTitle(/^Untitled — Hew$/)

  // Undo below the saved depth: dirty again (the "saved" file has the box,
  // the live document doesn't).
  await page.evaluate(() => window.__hew_test!.undo())
  await expect(page).toHaveTitle(/^• Untitled — Hew$/)

  // Redo back to the saved depth: clean again — this is the headline Lane C
  // behavior (undo-to-clean), not just "save clears dirty".
  await page.evaluate(() => window.__hew_test!.redo())
  await expect(page).toHaveTitle(/^Untitled — Hew$/)
})

// Session bookkeeping (Lane C follow-up, maintainer playtest): entering or
// leaving a group/component edit session pushes a real, undoable history
// entry, but the kernel's `content_depth` ignores it — it must never dirty
// the document or count as a "change" in the Changes panel. Enters via a
// real Outliner double-click on the group's own row (`DocumentTree.tsx`'s
// `onEnterContext`, the same entry point group-session.spec.ts's viewport
// double-click resolves to) — no camera/pixel math needed since the row is
// a plain DOM element, not a viewport pick.
test('entering and leaving a group edit session never dirties the title or the Changes panel', async ({ page }) => {
  await page.goto('/')
  await waitForHarness(page)

  const setup = await page.evaluate(() => {
    const h = window.__hew_test!
    const box = h.drawBox([0, 0, 0], [2, 1, 0], 1)
    const group = h.groupNodes([{ kind: 'object', id: box }])
    h.saveWithCameraState()
    return { box, group }
  })
  await expect(page).toHaveTitle(/^Untitled — Hew$/)

  // Expand the Changes tray section so its footer text is on screen.
  await page.getByRole('button', { name: 'Changes' }).click()
  await expect(page.getByText('No changes since last save.')).toBeVisible()

  // Double-click the group's own Outliner row — opens its edit session.
  const groupRow = page.getByText('Group 1').first()
  await expect(groupRow).toBeVisible()
  await groupRow.dblclick()
  await page.waitForTimeout(200)
  await expect(page.getByText('editing', { exact: true })).toHaveCount(1)

  // Undoable bookkeeping, but not a change: no dirty dot, no reported changes.
  await expect(page).toHaveTitle(/^Untitled — Hew$/)
  await expect(page.getByText('No changes since last save.')).toBeVisible()

  // A real edit inside the session dirties normally...
  await page.evaluate((id) => window.__hew_test!.addNodeTag('object', id, ['tag']), setup.box)
  await expect(page).toHaveTitle(/^• Untitled — Hew$/)
  await expect(page.getByText('1 change since last save.')).toBeVisible()

  // ...undoing it returns to clean, still inside the session.
  await page.evaluate(() => window.__hew_test!.undo())
  await expect(page).toHaveTitle(/^Untitled — Hew$/)
  await expect(page.getByText('No changes since last save.')).toBeVisible()

  // Exiting the session (Escape) is itself more bookkeeping — still clean.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await expect(page.getByText('editing', { exact: true })).toHaveCount(0)
  await expect(page).toHaveTitle(/^Untitled — Hew$/)
  await expect(page.getByText('No changes since last save.')).toBeVisible()
})

test('a further edit past the saved mark dirties again, and stays dirty across an unrelated undo/redo pair', async ({ page }) => {
  await page.goto('/')
  await waitForHarness(page)

  await page.evaluate(() => {
    window.__hew_test!.drawBox([0, 0, 0], [1, 1, 0], 1)
  })
  await page.evaluate(() => window.__hew_test!.saveWithCameraState())
  await expect(page).toHaveTitle(/^Untitled — Hew$/)

  // A second box, drawn AFTER the save: dirty, and — because this is a
  // brand-new action — it discards any redo branch (none here) and moves
  // the undo depth past the saved mark.
  await page.evaluate(() => {
    window.__hew_test!.drawBox([2, 0, 0], [3, 1, 0], 1)
  })
  await expect(page).toHaveTitle(/^• Untitled — Hew$/)

  await page.evaluate(() => window.__hew_test!.undo())
  await page.evaluate(() => window.__hew_test!.undo())
  await expect(page).toHaveTitle(/^Untitled — Hew$/)

  await page.evaluate(() => window.__hew_test!.redo())
  await page.evaluate(() => window.__hew_test!.redo())
  await expect(page).toHaveTitle(/^• Untitled — Hew$/)
})
