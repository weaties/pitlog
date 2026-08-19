import { expect, test } from '@playwright/test'

test('the app shell loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'PitLog' })).toBeVisible()
})

test('the api reports healthy', async ({ request }) => {
  const res = await request.get(`${process.env.VITE_API_URL ?? 'http://localhost:8787'}/api/health`)
  expect(res.ok()).toBe(true)
  expect(await res.json()).toEqual({ ok: true })
})
