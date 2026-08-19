import { expect, test } from '@playwright/test'

/**
 * The setup screens exist so a real crew can use the app on data that is not
 * the seed. The claim worth testing is not that a form renders — it is that a
 * write made in the paddock lands on the device immediately and reaches the
 * server afterwards.
 */

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()
}

test('a driver added on the roster survives a reload and reaches the server', async ({ page }) => {
  await signIn(page, 'admin@example.com')

  await page.getByRole('link', { name: 'Team' }).click()
  await expect(page.getByTestId('roster')).toBeVisible()

  const name = `Robin ${Date.now()}`
  await page.getByTestId('add-driver').click()
  await page.getByTestId('driver-first-name').fill(name)
  await page.getByTestId('save-driver').click()

  // On screen straight away: the write went to IndexedDB, not over a wire.
  await expect(page.getByText(name)).toBeVisible()

  // Still there after a reload, which is the part a plain optimistic update
  // would fail.
  await page.reload()
  await page.getByRole('link', { name: 'Team' }).click()
  await expect(page.getByText(name)).toBeVisible()

  // And the queue drained, so the server has it too.
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })
})

test('a race and its session can be set up from the app', async ({ page }) => {
  await signIn(page, 'admin@example.com')

  await page.getByTestId('add-event').click()
  const name = `Fall Enduro ${Date.now()}`
  await page.getByTestId('event-name').fill(name)
  await page.getByTestId('event-capacity').fill('18')
  // The seed burn rate is the planner's only input until a brim fill is logged.
  await page.getByTestId('event-burn-rate').fill('13.5')
  await page.getByTestId('save-event').click()

  await expect(page.getByText(name)).toBeVisible()
  await expect(page.getByText('18 gal tank · 13.5 gal/h seed')).toBeVisible()

  // Tap the sync pill rather than waiting out the idle interval; a drain is
  // idempotent, which is exactly why the pill is tappable at all.
  await page.getByTestId('sync-status').click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })

  await page.reload()
  await expect(page.getByText(name)).toBeVisible()
})

test('a crew member can edit the roster but a visitor cannot', async ({ page }) => {
  await signIn(page, 'crew@example.com')
  await page.getByRole('link', { name: 'Team' }).click()
  await expect(page.getByTestId('add-driver')).toBeVisible()

  await page.context().clearCookies()
  await signIn(page, 'visitor@example.com')
  await page.getByRole('link', { name: 'Team' }).click()
  await expect(page.getByTestId('roster')).toBeVisible()
  await expect(page.getByTestId('add-driver')).toHaveCount(0)
})

test('the crew chooses the running order, and the plan follows it', async ({ page }) => {
  // Before #56 the planner's "roster order" tiebreak was whatever order rows
  // came out of IndexedDB in — primary-key order over client-generated UUIDs.
  // Who started the race was effectively arbitrary. This proves it is not.
  await signIn(page, 'admin@example.com')
  await page.getByRole('link', { name: 'Team' }).click()

  const rows = page.getByTestId('roster').getByRole('listitem')
  // Rows are numbered by position, so strip the number to compare names.
  const nameAt = async (i: number) =>
    ((await rows.nth(i).innerText()).split('\n')[0] ?? '').replace(/^\d+\.\s*/, '').trim()

  const before = await nameAt(0)
  const promoting = await nameAt(1)
  expect(promoting).not.toBe(before)

  await rows
    .nth(1)
    .getByRole('button', { name: /Move .* up/ })
    .click()
  await expect.poll(() => nameAt(0)).toBe(promoting)

  // The order survives a reload, so it is stored rather than a view quirk.
  await page.reload()
  await page.getByRole('link', { name: 'Team' }).click()
  await expect.poll(() => nameAt(0)).toBe(promoting)

  // And the plan agrees: the first stint goes to whoever is now at the top.
  await page.getByRole('link', { name: 'Plan' }).click()
  const firstStint = page.getByTestId('schedule').getByRole('listitem').first()
  await expect(firstStint).toContainText(promoting.split(' ')[0] ?? '')
})
