import { expect, test } from '@playwright/test'

/**
 * The claim worth testing about consumables is the one the crew relies on:
 * laps on a set are counted from the timing data, not typed by whoever
 * remembered. Hand-counted laps are wrong by Sunday afternoon, and wrong in the
 * direction that gets somebody sent out on cords.
 */

async function openKit(page: import('@playwright/test').Page, email = 'crew@example.com') {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()
  await page.getByRole('link', { name: 'Kit' }).click()
}

test('a set can be added, fitted, and taken off', async ({ page }) => {
  await openKit(page)

  const label = `R7 set ${Date.now()}`
  await page.getByTestId('add-set').click()
  await page.getByTestId('set-label').fill(label)
  await page.getByTestId('save-set').click()

  const card = page.getByTestId('sets').getByRole('listitem').filter({ hasText: label })
  await expect(card).toBeVisible()
  await expect(card.getByText('off')).toBeVisible()

  await card.getByRole('button', { name: 'Fit' }).click()
  await expect(card.getByText('on the car')).toBeVisible()

  await card.getByRole('button', { name: 'Take off' }).click()
  await expect(card.getByText('off')).toBeVisible()
})

test('laps are on the device, so tyre life can be derived offline', async ({ page }) => {
  await openKit(page)

  // `laps` is pull-only: the client reads it and can never push it, because
  // timing comes from the provider (SPEC §5.4).
  const lapCount = () =>
    page.evaluate(async () => {
      const open = indexedDB.open('pitlog')
      const db: IDBDatabase = await new Promise((r, j) => {
        open.onsuccess = () => r(open.result)
        open.onerror = () => j(open.error)
      })
      const req = db.transaction('laps', 'readonly').objectStore('laps').getAll()
      const rows: unknown[] = await new Promise((r, j) => {
        req.onsuccess = () => r(req.result)
        req.onerror = () => j(req.error)
      })
      return rows.length
    })

  // Polled, not sampled: the first pull brings the whole weekend down and a
  // race's worth of laps is the largest thing in it.
  // The seeded fixture race carries 172 official laps and 172 GPS ones.
  await expect.poll(lapCount, { timeout: 20_000 }).toBeGreaterThan(300)
})

test('a visitor sees the kit but cannot change it', async ({ page }) => {
  await openKit(page, 'visitor@example.com')
  await expect(page.getByTestId('add-set')).toHaveCount(0)
})
