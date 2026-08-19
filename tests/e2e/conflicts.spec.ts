import { expect, test } from '@playwright/test'

/**
 * Last-write-wins is only survivable if the loser can find out. These tests are
 * about the promise in SPEC §6.2: a value that loses is surfaced, never
 * discarded, and a human — not a heuristic — decides what happens next.
 */

const API = 'http://localhost:8787'
const SESSION = '00000000-0000-4000-8000-000000000102'
const KIM = '11111111-1111-4111-8111-111111111111'
const SAM = '22222222-2222-4222-8222-222222222222'

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await page.getByTestId('dev-link').click()
  await expect(page.getByTestId('sync-status')).toBeVisible()

  const teams = await page.request.get(`${API}/api/teams`)
  const body = (await teams.json()) as { teams: { id: string }[] }
  const id = body.teams[0]?.id
  if (!id) throw new Error('no team')
  return id
}

/** One device pushing one fuel fill. */
async function push(
  page: import('@playwright/test').Page,
  teamId: string,
  row: { id: string; gallons: number; at: string; by: string },
) {
  const response = await page.request.post(`${API}/api/teams/${teamId}/sync`, {
    data: {
      protocolVersion: 1,
      writes: [
        {
          table: 'fuel_fills',
          row: {
            id: row.id,
            team_id: teamId,
            session_id: SESSION,
            filled_at: '2026-10-10T20:00:00.000Z',
            gallons: row.gallons,
            filled_to_full: true,
            client_updated_at: row.at,
            updated_by: row.by,
            deleted_at: null,
          },
        },
      ],
    },
  })
  expect(response.ok()).toBe(true)
  return (await response.json()) as { results: { outcome: string; loser: unknown }[] }
}

test('a value that loses is shown to a human, not discarded', async ({ page }) => {
  const teamId = await signIn(page)
  const rowId = crypto.randomUUID()

  // Two devices, one row. Kim first, Sam later and louder.
  await push(page, teamId, { id: rowId, gallons: 14.2, at: '2026-10-10T20:01:00.000Z', by: KIM })
  const second = await push(page, teamId, {
    id: rowId,
    gallons: 12.4,
    at: '2026-10-10T20:05:00.000Z',
    by: SAM,
  })

  expect(second.results[0]?.outcome).toBe('incoming_wins')
  expect(second.results[0]?.loser).not.toBeNull()

  await page.getByRole('link', { name: 'Log' }).click()
  const conflicts = page.getByTestId('conflicts')
  await expect(conflicts).toBeVisible()
  // The losing value itself, not a vague "something changed".
  await expect(conflicts).toContainText('14.20')
})

test('a human can put the losing value back in one action', async ({ page }) => {
  const teamId = await signIn(page)
  const rowId = crypto.randomUUID()

  await push(page, teamId, { id: rowId, gallons: 9.1, at: '2026-10-10T20:01:00.000Z', by: KIM })
  await push(page, teamId, { id: rowId, gallons: 3.3, at: '2026-10-10T20:05:00.000Z', by: SAM })

  // Find *this* test's conflict rather than whichever is first on screen: the
  // suite shares one database, so the list holds other tests' conflicts too.
  const listed = await page.request.get(`${API}/api/teams/${teamId}/conflicts`)
  const { conflicts } = (await listed.json()) as { conflicts: { id: string; row_id: string }[] }
  const mine = conflicts.find((c) => c.row_id === rowId)
  expect(mine).toBeDefined()

  await page.getByRole('link', { name: 'Log' }).click()
  await expect(page.getByTestId('conflicts')).toContainText('9.1')

  await page.getByTestId(`restore-${mine?.id}`).click()

  // Restoring is an ordinary write: it queues and syncs like anything else.
  await page.getByTestId('sync-status').click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })
})

test('dismissing clears the alert but never the history', async ({ page }) => {
  const teamId = await signIn(page)
  const rowId = crypto.randomUUID()

  await push(page, teamId, { id: rowId, gallons: 7.7, at: '2026-10-10T20:01:00.000Z', by: KIM })
  await push(page, teamId, { id: rowId, gallons: 5.5, at: '2026-10-10T20:05:00.000Z', by: SAM })

  const before = await page.request.get(`${API}/api/teams/${teamId}/conflicts`)
  const list = (await before.json()) as { conflicts: { id: string; row_id: string }[] }
  const mine = list.conflicts.find((c) => c.row_id === rowId)
  expect(mine).toBeDefined()

  await page.request.post(`${API}/api/teams/${teamId}/conflicts/${mine?.id}/acknowledge`)

  const after = await page.request.get(`${API}/api/teams/${teamId}/conflicts`)
  const remaining = (await after.json()) as { conflicts: { row_id: string }[] }
  expect(remaining.conflicts.find((c) => c.row_id === rowId)).toBeUndefined()

  // A conflict that has been seen is history. The history itself is forever —
  // acknowledging is not deleting.
  const history = await page.request.get(
    `${API}/api/teams/${teamId}/history?table=fuel_fills&rowId=${rowId}`,
  )
  const versions = (await history.json()) as { versions: { snapshot: { gallons: string } }[] }
  expect(versions.versions).toHaveLength(1)
  expect(versions.versions[0]?.snapshot.gallons).toBe('7.70')
})

test('an edit somebody makes to their own entry is history, not an alarm', async ({ page }) => {
  const teamId = await signIn(page)
  const rowId = crypto.randomUUID()

  // Same author twice: an ordinary correction. Flagging these would train a
  // crew to swipe the conflict list away.
  await push(page, teamId, { id: rowId, gallons: 11.1, at: '2026-10-10T20:01:00.000Z', by: KIM })
  await push(page, teamId, { id: rowId, gallons: 11.9, at: '2026-10-10T20:05:00.000Z', by: KIM })

  const conflicts = await page.request.get(`${API}/api/teams/${teamId}/conflicts`)
  const list = (await conflicts.json()) as { conflicts: { row_id: string }[] }
  expect(list.conflicts.find((c) => c.row_id === rowId)).toBeUndefined()

  // But the previous value is still kept.
  const history = await page.request.get(
    `${API}/api/teams/${teamId}/history?table=fuel_fills&rowId=${rowId}`,
  )
  const versions = (await history.json()) as { versions: { snapshot: { gallons: string } }[] }
  expect(versions.versions[0]?.snapshot.gallons).toBe('11.10')
})
