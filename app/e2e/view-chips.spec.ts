import { test, expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __hew_test?: import('../src/test/harness').HewTestHarness
  }
}

/**
 * View ▸ View Chips — the top-left Orbit/Top/Iso/Front cluster
 * (`viewport/ViewportHUD.tsx`). The View Cube superseded it, so it now ships
 * HIDDEN and this menu item is how someone gets it back.
 *
 * The suite-wide storage state pins the chips ON through the `viewport`
 * settings object (see `playwright.config.ts`) because the goldens were
 * captured with them present and two line specs click the Iso chip. This
 * spec seeds them back OFF so the shipped default is what gets tested — the
 * mirror image of the arrangement `view-cube.spec.ts` uses.
 */
async function setup(page: Page): Promise<void> {
  // Seed exactly once: an init script runs on EVERY navigation, so seeding
  // unconditionally would re-hide the chips across the `page.reload()` below
  // and quietly make the persistence assertion untestable. The sessionStorage
  // latch survives a reload in the same tab, so the app owns the value from
  // the second load onwards.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('hew.e2e.viewChipsSeeded') === null) {
      sessionStorage.setItem('hew.e2e.viewChipsSeeded', '1')
      // Read-modify-write, not a bare overwrite: the chips are one field of
      // the viewport settings object and the suite pin lives in the same key.
      let current: Record<string, unknown> = {}
      try {
        current = JSON.parse(localStorage.getItem('hew.settings.viewport') ?? '{}')
      } catch {
        current = {}
      }
      localStorage.setItem(
        'hew.settings.viewport',
        JSON.stringify({ ...current, showViewChips: false }),
      )
    }
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__hew_test?.isReady() === true, null, {
    timeout: 15_000,
  })
}

/**
 * A menu item, by label. `CheckMenuItem` renders the checkmark glyph as a
 * SIBLING of the label inside one row, so the row's text is "✓View Chips"
 * and no element's text is ever the label alone — hence the anchored regex
 * rather than `{ exact: true }`. Same trap `view-cube.spec.ts` documents.
 */
function menuItem(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.getByTestId('menu-bar').getByText(new RegExp(`^✓?${escaped}$`))
}

test.describe('View Chips', () => {
  test('are hidden by default and show from View ▸ View Chips, and the choice survives a reload', async ({
    page,
  }) => {
    await setup(page)
    await expect(page.getByTestId('view-chips')).toHaveCount(0)

    await page.getByTestId('menu-bar').getByRole('button', { name: 'View' }).click()
    await menuItem(page, 'View Chips').click()
    await expect(page.getByTestId('view-chips')).toBeVisible()

    await page.reload()
    await page.waitForFunction(() => window.__hew_test?.isReady() === true)
    await expect(page.getByTestId('view-chips')).toBeVisible()

    await page.getByTestId('menu-bar').getByRole('button', { name: 'View' }).click()
    await menuItem(page, 'View Chips').click()
    await expect(page.getByTestId('view-chips')).toHaveCount(0)
  })
})
