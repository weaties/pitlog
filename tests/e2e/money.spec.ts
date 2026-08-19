import { expect, test } from '@playwright/test'

/**
 * Money is where an app loses a crew's trust fastest, so the claims tested here
 * are about arithmetic and honesty rather than layout: the split adds up, the
 * ledger nets out, a receipt never holds up an expense, and nothing quietly
 * rebalances behind anyone's back.
 */

async function openMoney(page: import('@playwright/test').Page, email = 'admin@example.com') {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()
  await page.getByRole('link', { name: 'Money' }).click()
}

test('an expense splits evenly and shows up in the ledger', async ({ page }) => {
  await openMoney(page)

  await page.getByTestId('add-expense').click()
  await page.getByTestId('expense-description').fill('Entry fee')
  await page.getByTestId('expense-amount').fill('900.00')
  await page.getByTestId('save-expense').click()

  await expect(page.getByTestId('expenses')).toContainText('Entry fee')
  await expect(page.getByTestId('expenses')).toContainText('$900.00')
  // Roster size varies between a fresh seed and a database several test runs
  // old, so assert the shape rather than a headcount.
  await expect(page.getByTestId('expenses')).toContainText(/split \d+ ways/)

  // Somebody owes the payer, and the ledger says who and how much.
  await expect(page.getByTestId('ledger')).toBeVisible()
  await expect(page.getByTestId('ledger')).toContainText('→')
  await expect(page.getByTestId('ledger')).toContainText(/\$\d+\.\d{2}/)
})

test('an even split adds up to the expense to the cent', async ({ page }) => {
  await openMoney(page)

  // A unique description so this test can find its own rows: every browser
  // test shares one database, and a pull brings everyone else's in too.
  const description = `Coffee run ${Date.now()}`

  await page.getByTestId('add-expense').click()
  await page.getByTestId('expense-description').fill(description)
  await page.getByTestId('expense-amount').fill('10.00')
  await page.getByTestId('save-expense').click()

  await page.getByTestId('sync-status').click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })

  const mine = await page.evaluate(async (wanted) => {
    const open = indexedDB.open('pitlog')
    const db: IDBDatabase = await new Promise((r, j) => {
      open.onsuccess = () => r(open.result)
      open.onerror = () => j(open.error)
    })
    const read = <T>(store: string) =>
      new Promise<T[]>((r, j) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll()
        req.onsuccess = () => r(req.result)
        req.onerror = () => j(req.error)
      })

    const expenses = await read<{ id: string; description: string }>('expenses')
    const expense = expenses.find((e) => e.description === wanted)
    const shares = await read<{ expense_id: string; share_cents: number }>('expense_shares')
    return shares.filter((s) => s.expense_id === expense?.id).map((s) => s.share_cents)
  }, description)

  expect(mine.length).toBeGreaterThan(1)
  // The invariant that holds for any roster size: the shares add up exactly,
  // and nobody carries more than a cent more than anybody else. Whether a
  // remainder exists at all depends on the headcount, so the exact 333/333/334
  // case is pinned in the domain unit tests instead.
  expect(mine.reduce((a, b) => a + b, 0)).toBe(1000)
  expect(Math.max(...mine) - Math.min(...mine)).toBeLessThanOrEqual(1)
})

test('a receipt never holds up the expense', async ({ page }) => {
  await openMoney(page)

  await page.getByTestId('add-expense').click()
  await page.getByTestId('expense-description').fill('Tyres')
  await page.getByTestId('expense-amount').fill('640.00')

  await page.getByTestId('expense-receipt').setInputFiles({
    name: 'receipt.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not really a photo, but it hashes the same way'),
  })
  await expect(page.getByTestId('receipt-captured')).toBeVisible()

  await page.getByTestId('save-expense').click()

  // The expense is complete and split; the photo is merely pending. Object
  // storage is undecided (SPEC §6.4), so nothing is uploaded yet and the row
  // says exactly that.
  await expect(page.getByTestId('expenses')).toContainText('Tyres')
  await expect(page.getByTestId('receipt-state')).toContainText('waiting to upload')
})

test('settling marks shares square without deleting them', async ({ page }) => {
  await openMoney(page)

  const description = `Fuel jugs ${Date.now()}`
  await page.getByTestId('add-expense').click()
  await page.getByTestId('expense-description').fill(description)
  await page.getByTestId('expense-amount').fill('60.00')
  await page.getByTestId('save-expense').click()

  await expect(page.getByTestId('ledger')).toBeVisible()

  const countSettled = () =>
    page.evaluate(async () => {
      const open = indexedDB.open('pitlog')
      const db: IDBDatabase = await new Promise((r, j) => {
        open.onsuccess = () => r(open.result)
        open.onerror = () => j(open.error)
      })
      const req = db
        .transaction('expense_shares', 'readonly')
        .objectStore('expense_shares')
        .getAll()
      const rows: { id: string; settled_at: string | null }[] = await new Promise((r, j) => {
        req.onsuccess = () => r(req.result)
        req.onerror = () => j(req.error)
      })
      return {
        ids: rows.map((x) => x.id),
        settled: rows.filter((x) => x.settled_at !== null).length,
      }
    })

  const before = await countSettled()
  await page.getByTestId('ledger').getByRole('button', { name: 'Settle' }).first().click()
  await expect.poll(async () => (await countSettled()).settled).toBeGreaterThan(before.settled)

  // Settled is not deleted. Asserted as "nothing disappeared" rather than a
  // row count: a background pull can add rows at any moment, and a total is
  // not this test's to own.
  const after = await countSettled()
  for (const id of before.ids) expect(after.ids).toContain(id)
  await expect(page.getByTestId('expenses')).toContainText(description)
})

test('crew can add an expense but only an admin can settle', async ({ page }) => {
  await openMoney(page, 'crew@example.com')
  await expect(page.getByTestId('add-expense')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settle' })).toHaveCount(0)
})
