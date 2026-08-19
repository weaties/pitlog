import { expect, test } from '@playwright/test'

/**
 * `page.request` throughout, not the standalone `request` fixture: the latter
 * has its own cookie jar, so it is never signed in as the admin who is
 * supposed to be creating these links.
 *
 * A visitor link is the one credential in this app that gets forwarded around a
 * paddock, so the claims worth proving are about what it *cannot* do: reach
 * another team, write anything, survive revocation, or carry anybody's surname.
 */

async function signInAsAdmin(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()
}

async function createLink(request: import('@playwright/test').APIRequestContext, teamId: string) {
  const response = await request.post(`http://localhost:8787/api/teams/${teamId}/visitor-links`, {
    data: { label: `Family ${Date.now()}` },
  })
  expect(response.status()).toBe(201)
  return (await response.json()) as { id: string; url: string }
}

async function teamId(request: import('@playwright/test').APIRequestContext) {
  const response = await request.get('http://localhost:8787/api/teams')
  const body = (await response.json()) as { teams: { id: string }[] }
  const id = body.teams[0]?.id
  if (!id) throw new Error('no team')
  return id
}

test('a visitor link opens the weekend without an account', async ({ page }) => {
  await signInAsAdmin(page)
  const id = await teamId(page.request)
  const link = await createLink(page.request, id)

  // A brand-new browser: no session, no login, just the link.
  const visitor = await page.context().browser()?.newContext()
  if (!visitor) throw new Error('no browser')
  const visitorPage = await visitor.newPage()

  await visitorPage.goto(link.url)
  await expect(visitorPage.getByTestId('visit-team')).toHaveText('Rusty Nail Racing')
  await expect(visitorPage.getByTestId('visit-stints')).toBeVisible()

  await visitor.close()
})

test('the visitor payload carries no surnames, emails or money', async ({ page }) => {
  await signInAsAdmin(page)
  const id = await teamId(page.request)
  const link = await createLink(page.request, id)

  const visitor = await page.context().browser()?.newContext()
  if (!visitor) throw new Error('no browser')
  const visitorPage = await visitor.newPage()

  const token = new URL(link.url).searchParams.get('token') ?? ''
  await visitorPage.request.post(
    `http://localhost:8787/api/auth/visitor?token=${encodeURIComponent(token)}`,
  )
  const weekend = await visitorPage.request.get(`http://localhost:8787/api/teams/${id}/weekend`)
  const raw = await weekend.text()

  // Asserted on the payload, not the rendered page. Hiding a surname in a
  // component while shipping it in the JSON is not hiding it.
  for (const forbidden of [
    'Ruiz',
    'Nakamura',
    'Okonkwo',
    'last_name',
    '@example.com',
    'amount_cents',
  ]) {
    expect(raw).not.toContain(forbidden)
  }
  expect(raw).toContain('Ana')

  await visitor.close()
})

test('a visitor cannot write anything', async ({ page }) => {
  await signInAsAdmin(page)
  const id = await teamId(page.request)
  const link = await createLink(page.request, id)

  const visitor = await page.context().browser()?.newContext()
  if (!visitor) throw new Error('no browser')
  const visitorPage = await visitor.newPage()
  const token = new URL(link.url).searchParams.get('token') ?? ''
  await visitorPage.request.post(
    `http://localhost:8787/api/auth/visitor?token=${encodeURIComponent(token)}`,
  )

  const push = await visitorPage.request.post(`http://localhost:8787/api/teams/${id}/sync`, {
    data: { protocolVersion: 1, writes: [] },
  })
  expect(push.status()).toBe(403)

  const escalate = await visitorPage.request.post(
    `http://localhost:8787/api/teams/${id}/visitor-links`,
    { data: { label: 'nope' } },
  )
  expect(escalate.status()).toBe(403)

  await visitor.close()
})

test('revoking a link kills the session that is already open', async ({ page }) => {
  await signInAsAdmin(page)
  const id = await teamId(page.request)
  const link = await createLink(page.request, id)

  const visitor = await page.context().browser()?.newContext()
  if (!visitor) throw new Error('no browser')
  const visitorPage = await visitor.newPage()
  const token = new URL(link.url).searchParams.get('token') ?? ''
  await visitorPage.request.post(
    `http://localhost:8787/api/auth/visitor?token=${encodeURIComponent(token)}`,
  )
  expect(
    (await visitorPage.request.get(`http://localhost:8787/api/teams/${id}/weekend`)).status(),
  ).toBe(200)

  await page.request.delete(`http://localhost:8787/api/teams/${id}/visitor-links/${link.id}`)

  // Immediately, not at the next expiry. A link that cannot be killed
  // mid-weekend is not revocable at all.
  expect(
    (await visitorPage.request.get(`http://localhost:8787/api/teams/${id}/weekend`)).status(),
  ).toBe(401)

  await visitor.close()
})

test('the link listing never returns a token, even to an admin', async ({ page }) => {
  await signInAsAdmin(page)
  const id = await teamId(page.request)
  await createLink(page.request, id)

  const listing = await page.request.get(`http://localhost:8787/api/teams/${id}/visitor-links`)
  const raw = await listing.text()

  // Only the hash is stored, so the plaintext exists in exactly one response
  // and never again.
  expect(raw).not.toContain('token')
})

test('an admin can invite someone, and the invite creates the membership', async ({ page }) => {
  await signInAsAdmin(page)
  const id = await teamId(page.request)

  const email = `invited-${Date.now()}@example.com`
  const response = await page.request.post(`http://localhost:8787/api/teams/${id}/invites`, {
    data: { email, role: 'crew' },
  })
  expect(response.status()).toBe(201)
  const invite = (await response.json()) as { url: string }

  const invitee = await page.context().browser()?.newContext()
  if (!invitee) throw new Error('no browser')
  const inviteePage = await invitee.newPage()

  // Accepting the invite and signing in are the same click.
  await inviteePage.goto(invite.url)
  const teams = await inviteePage.request.get('http://localhost:8787/api/teams')
  const body = (await teams.json()) as { teams: { role: string }[] }
  expect(body.teams[0]?.role).toBe('crew')

  await invitee.close()
})
