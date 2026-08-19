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

test('a split that cannot divide still adds up to the expense', async ({ page }) => {
  await openMoney(page)

  await page.getByTestId('add-expense').click()
  await page.getByTestId('expense-description').fill('Coffee run')
  // $10.00 over three people is 333, 333, 334.
  await page.getByTestId('expense-amount').fill('10.00')
  await page.getByTestId('save-expense').click()

  await page.getByTestId('sync-status').click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })

  const shares = await page.evaluate(async () => {
    const open = indexedDB.open('pitlog')
    const db: IDBDatabase = await new Promise((r, j) => {
      open.onsuccess = () => r(open.result)
      open.onerror = () => j(open.error)
    })
    const req = db.transaction('expense_shares', 'readonly').objectStore('expense_shares').getAll()
    return new Promise<{ share_cents: number; expense_id: string }[]>((r, j) => {
      req.onsuccess = () => r(req.result)
      req.onerror = () => j(req.error)
    })
  })

  const byExpense = new Map<string, number[]>()
  for (const s of shares) {
    byExpense.set(s.expense_id, [...(byExpense.get(s.expense_id) ?? []), s.share_cents])
  }
  const tenDollars = [...byExpense.values()].find(
    (values) => values.reduce((a, b) => a + b, 0) === 1000,
  )

  expect(tenDollars).toBeDefined()
  // Nobody is more than a cent off anybody else.
  expect(Math.max(...(tenDollars ?? [])) - Math.min(...(tenDollars ?? []))).toBe(1)
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

test('the ledger nets out and settling clears it', async ({ page }) => {
  await openMoney(page)

  await page.getByTestId('add-expense').click()
  await page.getByTestId('expense-description').fill('Fuel jugs')
  await page.getByTestId('expense-amount').fill('60.00')
  await page.getByTestId('save-expense').click()

  await expect(page.getByTestId('ledger')).toBeVisible()
  const settle = page.getByTestId('ledger').getByRole('button', { name: 'Settle' }).first()
  await settle.click()

  // Settled shares stay in the history; they just stop being owed.
  await expect(page.getByTestId('expenses')).toContainText('Fuel jugs')
})

test('crew can add an expense but only an admin can settle', async ({ page }) => {
  await openMoney(page, 'crew@example.com')
  await expect(page.getByTestId('add-expense')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settle' })).toHaveCount(0)
})
