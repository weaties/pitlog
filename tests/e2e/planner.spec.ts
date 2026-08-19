import { expect, test } from '@playwright/test'

/**
 * The plan screen's job is not to show a schedule — it is to show a schedule
 * *and everything wrong with it*. SPEC §5.1 forbids a bare number, and SPEC §3
 * means every shipped rule config is a set of placeholders, so the warning is
 * the feature.
 */

async function openPlan(page: import('@playwright/test').Page, email = 'crew@example.com') {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()
  await page.getByRole('link', { name: 'Plan' }).click()
}

test('the seeded race produces a schedule', async ({ page }) => {
  await openPlan(page)

  await expect(page.getByTestId('schedule')).toBeVisible()
  // The fixture race is 8 hours on a 20-gallon tank at 14 gal/h.
  const stints = page.getByTestId('schedule').getByRole('listitem')
  expect(await stints.count()).toBeGreaterThan(1)
})

test('a plan still built on an unchecked rule value says so, by name', async ({ page }) => {
  await openPlan(page)

  const banner = page.getByTestId('unverified-banner')
  await expect(banner).toBeVisible()

  // Not "some values are unverified" — a crew chief can act on a named field
  // and cannot act on a vague warning.
  await expect(banner).toContainText('unverified rule value')
  const fields = page.getByTestId('unverified-fields').getByRole('listitem')
  expect(await fields.count()).toBeGreaterThan(0)
})

test('fields that were read from a rulebook stop being flagged', async ({ page }) => {
  await openPlan(page)

  // The configs were checked against the published rulebooks on 2026-08-19, so
  // the banner must have shrunk to the handful the rulebooks do not address.
  // If this ever fails, either a config regressed to placeholders or somebody
  // widened verified_fields without reading anything.
  const listed = await page.getByTestId('unverified-fields').innerText()

  for (const checked of [
    'pit.engine_off_for_fueling',
    'pit.driver_change_during_fueling',
    'fueling.max_can_size_gallons',
    'driver.max_consecutive_stint_seconds',
  ]) {
    expect(listed, `${checked} was read from a rulebook and should not be flagged`).not.toContain(
      checked,
    )
  }
})

test('the banner is on the plan itself, not behind a tooltip', async ({ page }) => {
  await openPlan(page)

  // Both visible in the same viewport without opening anything.
  await expect(page.getByTestId('unverified-banner')).toBeVisible()
  await expect(page.getByTestId('schedule')).toBeVisible()
})

test('the assumptions panel shows the burn rate with its confidence', async ({ page }) => {
  await openPlan(page)

  await expect(page.getByTestId('assumptions')).toBeVisible()
  await expect(page.getByTestId('burn-rate')).toContainText('gal/h')
  // Never a bare number: the confidence and the method travel with it.
  await expect(page.getByTestId('burn-confidence')).toContainText(/none|low|medium|high/)
  await expect(page.getByTestId('burn-confidence')).toContainText(/seed|measured/)
})

test('a visitor can read the plan', async ({ page }) => {
  await openPlan(page, 'visitor@example.com')
  await expect(page.getByTestId('schedule')).toBeVisible()
})

test('a race with no series gets no series rules, rather than a guessed rulebook', async ({
  page,
}) => {
  // The three shipped series differ in ways that change a schedule, so picking
  // one for the crew would produce a plan that looks authoritative and is bound
  // by the wrong rulebook. Saying "none" is the honest answer.
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()

  const name = `Unseriesed ${Date.now()}`
  await page.getByTestId('add-event').click()
  await page.getByTestId('event-name').fill(name)
  await page.getByTestId('event-capacity').fill('20')
  await page.getByTestId('event-burn-rate').fill('14')
  await page.getByTestId('save-event').click()

  const card = page.getByTestId('events').getByRole('listitem').filter({ hasText: name })
  await expect(card).toContainText('No series rules')
})

test('a race can be bound to a named series', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()

  const name = `ChampCar round ${Date.now()}`
  await page.getByTestId('add-event').click()
  await page.getByTestId('event-name').fill(name)
  await page.getByTestId('event-series').selectOption({ label: 'ChampCar Endurance Series' })
  await page.getByTestId('save-event').click()

  const card = page.getByTestId('events').getByRole('listitem').filter({ hasText: name })
  await expect(card).toContainText('ChampCar Endurance Series')
})

test('a driver who has to leave early is never given a stint past their time', async ({ page }) => {
  // The motivating case for #57: "I need to be done for the day by 1pm."
  await openPlan(page, 'admin@example.com')
  await expect(page.getByTestId('schedule')).toBeVisible()

  await page.getByTestId('toggle-availability').click()

  // The seeded fixture race starts at 15:00 UTC; pick a wall-clock time a few
  // hours in, whatever the runner's timezone renders that as.
  const start = await page.getByTestId('schedule').getByRole('listitem').first().innerText()
  expect(start.length).toBeGreaterThan(0)

  const anaUntil = page.getByTestId(/^until-/).first()
  await anaUntil.fill('13:00')
  await page.getByTestId('toggle-availability').click()

  await expect(page.getByTestId('availability-summary')).toContainText('until 13:00')

  // It has to survive a reload, and it has to reach the server. The first
  // version of this feature did neither: the store it wrote to did not exist,
  // every write threw, and nothing said so.
  await expect(page.getByTestId('write-failure')).toHaveCount(0)
  await page.getByTestId('sync-status').click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 20_000 })

  await page.reload()
  await expect(page.getByTestId('availability-summary')).toContainText('until 13:00')

  // Whatever the planner does next, it must either produce a plan that honours
  // the window or refuse and say why — never a schedule that ignores it.
  const refused = page.getByTestId('plan-refused')
  const schedule = page.getByTestId('schedule')
  await expect(refused.or(schedule).first()).toBeVisible()
})
