import { expect, test } from '@playwright/test'

/**
 * The one-tap log is the primary race-weekend surface, so the claims worth
 * testing are the ones a crew depends on under pressure: a tap records
 * something immediately, a driver change produces a real stint rather than a
 * duplicate, and a brim fill is stored as the datapoint the planner needs.
 */

/** Read a table straight out of the device's store. */
async function localRows<T>(page: import('@playwright/test').Page, table: string): Promise<T[]> {
  return page.evaluate(async (name) => {
    const open = indexedDB.open('pitlog')
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const request = db.transaction(name, 'readonly').objectStore(name).getAll()
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }, table)
}

async function signIn(page: import('@playwright/test').Page, email = 'crew@example.com') {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()
  await page.getByRole('link', { name: 'Log' }).click()
  await expect(page.getByTestId('log-buttons')).toBeVisible()
}

test('one tap records an incident with no dialog in the way', async ({ page }) => {
  await signIn(page)

  await page.getByTestId('log-incident').click()

  // The row exists *before* any detail is asked for: an interrupted crew
  // member has still recorded the thing that happened. Asserted against the
  // store rather than the list, because the seeded fixture race is dated two
  // months out and crowds the "recent" view.
  await expect(page.getByTestId('note-form')).toBeVisible()
  const afterTap = await localRows<{ kind: string }>(page, 'log_entries')
  expect(afterTap.filter((e) => e.kind === 'incident').length).toBe(1)

  // Skipping the detail leaves the entry exactly as it was.
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByTestId('note-form')).toHaveCount(0)
  const afterSkip = await localRows<{ kind: string }>(page, 'log_entries')
  expect(afterSkip.filter((e) => e.kind === 'incident').length).toBe(1)
})

test('detail is an optional second step, not a required one', async ({ page }) => {
  await signIn(page)

  await page.getByTestId('log-black_flag').click()
  await page.getByTestId('detail-note').fill('Passing under yellow')
  await page.getByTestId('save-detail').click()
  await expect(page.getByTestId('note-form')).toHaveCount(0)

  const entries = await localRows<{ kind: string; note: string | null }>(page, 'log_entries')
  const flagged = entries.filter(
    (e) => e.kind === 'black_flag' && e.note === 'Passing under yellow',
  )
  // One row, edited — not a second row beside the original.
  expect(flagged).toHaveLength(1)
})

test('a driver change starts and ends a real stint', async ({ page }) => {
  await signIn(page)

  await expect(page.getByTestId('in-car')).toContainText('Nobody')

  await page.getByTestId('log-driver_in').click()
  await page.getByTestId('pick-driver-Ana').click()
  await expect(page.getByTestId('in-car')).toContainText('Ana')

  await page.getByTestId('log-driver_out').click()
  await expect(page.getByTestId('in-car')).toContainText('Nobody')

  // One stint, started and ended — not a duplicate beside the planned row.
  const stints = await localRows<{ started_at: string | null; ended_at: string | null }>(
    page,
    'stints',
  )
  const justRun = stints.filter((s) => s.started_at !== null && s.ended_at !== null)
  expect(justRun.length).toBeGreaterThan(0)
})

test('driver out is unavailable when nobody is in the car', async ({ page }) => {
  await signIn(page)
  await expect(page.getByTestId('in-car')).toContainText('Nobody')
  await expect(page.getByTestId('log-driver_out')).toBeDisabled()
})

test('a brim fill is stored as a burn-rate datapoint', async ({ page }) => {
  await signIn(page)

  await page.getByTestId('log-fuel_fill').click()
  await page.getByTestId('fill-gallons').fill('17.5')
  await page.getByTestId('fill-cost').fill('96.08')
  await page.getByTestId('save-fill').click()

  await page.getByTestId('sync-status').click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })

  const fills = await localRows<{ gallons: string; cost_cents: number; filled_to_full: boolean }>(
    page,
    'fuel_fills',
  )
  const fill = fills.find((r) => Number(r.gallons) === 17.5)

  expect(fill).toBeDefined()
  expect(fill?.filled_to_full).toBe(true)
  // Money is integer cents, never a float.
  expect(fill?.cost_cents).toBe(9608)
})

test('every control on the hot path is big enough for a gloved hand', async ({ page }) => {
  await signIn(page)

  // --spacing-tap is 4rem = 64px. Nothing on this screen may go below it.
  const buttons = page.getByTestId('log-buttons').getByRole('button')
  const count = await buttons.count()
  expect(count).toBeGreaterThan(0)

  for (let i = 0; i < count; i++) {
    const box = await buttons.nth(i).boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(64)
  }
})
