import { expect, test } from '@playwright/test'

const API = process.env.VITE_API_URL ?? 'http://localhost:8787'

test('the api reports healthy', async ({ request }) => {
  const res = await request.get(`${API}/api/health`)
  expect(res.ok()).toBe(true)
  expect(await res.json()).toEqual({ ok: true })
})

test('an anonymous visitor is sent to the login page', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'PitLog' })).toBeVisible()
})

test('a seeded admin can sign in with a magic link and see their team dashboard', async ({
  page,
}) => {
  await page.goto('/login')

  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()

  // The console mail transport returns the link in the response so there is no
  // inbox to poll. See `exposeDevLink` in apps/api/src/routes/auth.ts.
  const devLink = page.getByTestId('dev-link')
  await expect(devLink).toBeVisible()
  await devLink.click()

  await expect(page).toHaveURL(/localhost:5173\/?$/)
  await expect(page.getByTestId('team-name')).toHaveText('Rusty Nail Racing')
  await expect(page.getByTestId('dashboard')).toBeVisible()
})

test('the seeded fixture race shows up on the dashboard', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('crew@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()

  await expect(page.getByText('Autumn Enduro 8')).toBeVisible()
})

test('a visitor is refused a write-gated endpoint', async ({ request }) => {
  // The role gates are unit-tested exhaustively; this proves the wiring is real
  // — a signed-out caller gets 401, not a 200 with an empty body.
  const res = await request.get(`${API}/api/teams`)
  expect(res.status()).toBe(401)
})

test('the pit client syncs from IndexedDB and says so', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('crew@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()

  const status = page.getByTestId('sync-status')
  await expect(status).toBeVisible()
  // Nothing queued and a reachable API: the honest answer is "Synced".
  await expect(status).toHaveAttribute('data-online', 'true')
  await expect(status).toHaveText('Synced')

  // The pull populated the local store, so the weekend is readable offline.
  const localRows = await page.evaluate(async () => {
    const open = indexedDB.open('pitlog')
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const request = db.transaction('stints', 'readonly').objectStore('stints').getAll()
    return new Promise<unknown[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  })

  expect(localRows.length).toBeGreaterThan(0)
})
