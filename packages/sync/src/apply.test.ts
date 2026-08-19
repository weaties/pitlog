import { describe, expect, it } from 'vitest'
import type { SyncStore } from './apply.js'
import { applySyncPush } from './apply.js'
import type { SyncRow } from './merge.js'
import type { SyncPushRequest } from './protocol.js'
import { PULL_OVERLAP_SECONDS, parseSyncRow, pullFloor } from './protocol.js'
import type { SyncTableName } from './tables.js'

const TEAM = '00000000-0000-4000-8000-000000000001'
const OTHER_TEAM = '00000000-0000-4000-8000-000000000002'
const SESSION = '00000000-0000-4000-8000-0000000000aa'
const KIM = '11111111-1111-4111-8111-111111111111'
const SAM = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-10T18:00:00.000Z')

/** An in-memory store. The rule under test has nothing to do with Postgres. */
function memoryStore(seed: Partial<Record<SyncTableName, SyncRow[]>> = {}) {
  const tables = new Map<SyncTableName, Map<string, SyncRow>>()
  for (const [table, rows] of Object.entries(seed)) {
    tables.set(table as SyncTableName, new Map((rows ?? []).map((r) => [r.id, r])))
  }

  const saves: { table: SyncTableName; ids: string[] }[] = []

  const store: SyncStore = {
    async load(table, ids) {
      const held = tables.get(table) ?? new Map()
      return new Map([...held].filter(([id]) => ids.includes(id)))
    },
    async save(table, rows) {
      const held = tables.get(table) ?? new Map<string, SyncRow>()
      for (const row of rows) held.set(row.id, row)
      tables.set(table, held)
      saves.push({ table, ids: rows.map((r) => r.id) })
    },
  }

  return { store, tables, saves }
}

function fill(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    team_id: TEAM,
    session_id: SESSION,
    filled_at: '2026-10-10T14:00:00.000Z',
    gallons: 14.2,
    cost_cents: 7800,
    filled_to_full: true,
    notes: null,
    client_updated_at: '2026-10-10T14:02:00.000Z',
    deleted_at: null,
    updated_by: KIM,
    ...overrides,
  }
}

function push(writes: { table: string; row: unknown }[]): SyncPushRequest {
  return { protocolVersion: 1, writes }
}

const FILL_A = '00000000-0000-4000-8000-0000000000f1'
const FILL_B = '00000000-0000-4000-8000-0000000000f2'

describe('applySyncPush — accepting writes', () => {
  it('inserts a row the server has never seen', async () => {
    const { store, tables } = memoryStore()
    const response = await applySyncPush(
      store,
      push([{ table: 'fuel_fills', row: fill(FILL_A) }]),
      {
        teamId: TEAM,
        now: NOW,
      },
    )

    expect(response.results[0]?.outcome).toBe('insert')
    expect(tables.get('fuel_fills')?.get(FILL_A)).toBeDefined()
  })

  it('coerces wire timestamps into real instants', async () => {
    const { store, tables } = memoryStore()
    await applySyncPush(store, push([{ table: 'fuel_fills', row: fill(FILL_A) }]), {
      teamId: TEAM,
      now: NOW,
    })

    expect(tables.get('fuel_fills')?.get(FILL_A)?.client_updated_at).toBeInstanceOf(Date)
  })

  it('returns a cursor the client can pull from', async () => {
    const { store } = memoryStore()
    const response = await applySyncPush(store, push([]), { teamId: TEAM, now: NOW })
    expect(response.cursor).toBe(NOW.toISOString())
  })

  it('does not write rows whose stored value already won', async () => {
    const held = parseSyncRow(
      'fuel_fills',
      fill(FILL_A, { gallons: 12.4, client_updated_at: '2026-10-10T16:00:00.000Z' }),
    )
    if (!held.ok) throw new Error('fixture')

    const { store, saves } = memoryStore({ fuel_fills: [held.row] })
    const response = await applySyncPush(
      store,
      push([{ table: 'fuel_fills', row: fill(FILL_A) }]),
      {
        teamId: TEAM,
        now: NOW,
      },
    )

    expect(response.results[0]?.outcome).toBe('current_wins')
    expect(saves).toHaveLength(0)
  })
})

describe('applySyncPush — a batch is atomic per row', () => {
  it('lets one bad row fail without costing the rest', async () => {
    const { store, tables } = memoryStore()
    const response = await applySyncPush(
      store,
      push([
        { table: 'fuel_fills', row: fill(FILL_A) },
        { table: 'fuel_fills', row: { id: FILL_B, team_id: TEAM } },
        { table: 'fuel_fills', row: fill(FILL_B, { gallons: 9 }) },
      ]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results.map((r) => r.outcome)).toEqual(['insert', 'rejected', 'insert'])
    expect(tables.get('fuel_fills')?.size).toBe(2)
  })

  it('names what was wrong with the row it refused', async () => {
    const { store } = memoryStore()
    const response = await applySyncPush(
      store,
      push([{ table: 'fuel_fills', row: fill(FILL_A, { gallons: undefined }) }]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results[0]?.outcome).toBe('rejected')
    expect(response.results[0]?.error).toMatch(/gallons/)
  })

  it('reports the id of a row it could not parse, so the client can retire it', async () => {
    const { store } = memoryStore()
    const response = await applySyncPush(
      store,
      push([{ table: 'fuel_fills', row: { id: FILL_A } }]),
      {
        teamId: TEAM,
        now: NOW,
      },
    )

    expect(response.results[0]?.id).toBe(FILL_A)
  })

  it('folds two writes to the same row inside one batch', async () => {
    const { store, tables } = memoryStore()
    const response = await applySyncPush(
      store,
      push([
        { table: 'fuel_fills', row: fill(FILL_A) },
        {
          table: 'fuel_fills',
          row: fill(FILL_A, { gallons: 12.4, client_updated_at: '2026-10-10T15:00:00.000Z' }),
        },
      ]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results[1]?.outcome).toBe('incoming_wins')
    expect(tables.get('fuel_fills')?.get(FILL_A)?.gallons).toBe('12.4')
  })

  it('is idempotent under replay', async () => {
    const { store, tables } = memoryStore()
    const batch = push([{ table: 'fuel_fills', row: fill(FILL_A) }])

    await applySyncPush(store, batch, { teamId: TEAM, now: NOW })
    const second = await applySyncPush(store, batch, { teamId: TEAM, now: NOW })

    expect(second.results[0]?.outcome).toBe('unchanged')
    expect(tables.get('fuel_fills')?.size).toBe(1)
  })
})

describe('applySyncPush — tenancy', () => {
  it('refuses a row that claims another team', async () => {
    const { store, tables } = memoryStore()
    const response = await applySyncPush(
      store,
      push([{ table: 'fuel_fills', row: fill(FILL_A, { team_id: OTHER_TEAM }) }]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results[0]?.outcome).toBe('rejected')
    expect(response.results[0]?.error).toMatch(/another team/)
    expect(tables.get('fuel_fills')).toBeUndefined()
  })

  it('refuses a table the pit client has no business writing', async () => {
    const { store } = memoryStore()
    // laps, media_assets and telemetry_files are M2 server-side ingest.
    const response = await applySyncPush(
      store,
      push([{ table: 'laps', row: { id: FILL_A, team_id: TEAM } }]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results[0]?.outcome).toBe('rejected')
    expect(response.results[0]?.error).toMatch(/may write/)
  })

  it('refuses a column this build does not know about', async () => {
    const { store } = memoryStore()
    const response = await applySyncPush(
      store,
      push([{ table: 'fuel_fills', row: fill(FILL_A, { is_admin: true }) }]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results[0]?.outcome).toBe('rejected')
  })
})

describe('applySyncPush — conflicts come back', () => {
  it('returns the losing value so the client can surface it', async () => {
    const held = parseSyncRow('fuel_fills', fill(FILL_A, { gallons: 12.4, updated_by: SAM }))
    if (!held.ok) throw new Error('fixture')

    const { store } = memoryStore({ fuel_fills: [held.row] })
    const response = await applySyncPush(
      store,
      push([
        {
          table: 'fuel_fills',
          row: fill(FILL_A, { client_updated_at: '2026-10-10T16:00:00.000Z', updated_by: KIM }),
        },
      ]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results[0]?.outcome).toBe('incoming_wins')
    expect(response.results[0]?.loser?.gallons).toBe('12.4')
  })

  it('stays quiet when one person corrects themselves', async () => {
    const held = parseSyncRow('fuel_fills', fill(FILL_A, { gallons: 12.4 }))
    if (!held.ok) throw new Error('fixture')

    const { store } = memoryStore({ fuel_fills: [held.row] })
    const response = await applySyncPush(
      store,
      push([
        {
          table: 'fuel_fills',
          row: fill(FILL_A, { client_updated_at: '2026-10-10T16:00:00.000Z' }),
        },
      ]),
      { teamId: TEAM, now: NOW },
    )

    expect(response.results[0]?.loser).toBeNull()
  })
})

describe('the pull cursor', () => {
  it('re-reads an overlap window before the cursor', () => {
    const since = new Date('2026-10-10T18:00:00.000Z')
    const floor = pullFloor(since)
    expect(floor?.toISOString()).toBe('2026-10-10T17:59:00.000Z')
    expect((since.getTime() - (floor?.getTime() ?? 0)) / 1000).toBe(PULL_OVERLAP_SECONDS)
  })

  it('reads everything when the client has never pulled', () => {
    expect(pullFloor(null)).toBeNull()
  })

  it('overlaps by long enough to outlast a write transaction', () => {
    // Postgres now() is transaction-start time, so a write that began before
    // the cursor can commit after it. The overlap is what makes that row still
    // arrive; replaying it is a no-op, which is why this is safe.
    expect(PULL_OVERLAP_SECONDS).toBeGreaterThanOrEqual(30)
  })
})

describe('applySyncPush — keeping what was overwritten', () => {
  function storeWithHistory(seed: SyncRow[]) {
    const base = memoryStore({ fuel_fills: seed })
    const recorded: { table: string; previous: SyncRow; wasConflict: boolean }[] = []
    return {
      store: {
        ...base.store,
        async recordSuperseded(
          rows: readonly {
            table: SyncTableName
            previous: SyncRow
            supersededBy: string | null
            wasConflict: boolean
          }[],
        ) {
          recorded.push(...rows)
        },
      },
      recorded,
    }
  }

  it('keeps the previous value when a write supersedes it', async () => {
    const held = parseSyncRow('fuel_fills', fill(FILL_A, { gallons: 12.4 }))
    if (!held.ok) throw new Error('fixture')
    const { store, recorded } = storeWithHistory([held.row])

    await applySyncPush(
      store,
      push([
        {
          table: 'fuel_fills',
          row: fill(FILL_A, { client_updated_at: '2026-10-10T16:00:00.000Z' }),
        },
      ]),
      { teamId: TEAM, now: NOW },
    )

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.previous.gallons).toBe('12.4')
  })

  it('keeps an edit somebody made to their own row, without calling it a conflict', async () => {
    // Not worth interrupting anyone about, but it is still the history someone
    // wants on Sunday night.
    const held = parseSyncRow('fuel_fills', fill(FILL_A, { gallons: 12.4 }))
    if (!held.ok) throw new Error('fixture')
    const { store, recorded } = storeWithHistory([held.row])

    await applySyncPush(
      store,
      push([
        {
          table: 'fuel_fills',
          row: fill(FILL_A, { client_updated_at: '2026-10-10T16:00:00.000Z' }),
        },
      ]),
      { teamId: TEAM, now: NOW },
    )

    expect(recorded[0]?.wasConflict).toBe(false)
  })

  it('marks an overwrite by a different person as a conflict', async () => {
    const held = parseSyncRow('fuel_fills', fill(FILL_A, { gallons: 12.4, updated_by: SAM }))
    if (!held.ok) throw new Error('fixture')
    const { store, recorded } = storeWithHistory([held.row])

    await applySyncPush(
      store,
      push([
        {
          table: 'fuel_fills',
          row: fill(FILL_A, { client_updated_at: '2026-10-10T16:00:00.000Z', updated_by: KIM }),
        },
      ]),
      { teamId: TEAM, now: NOW },
    )

    expect(recorded[0]?.wasConflict).toBe(true)
    expect(recorded[0]?.previous.updated_by).toBe(SAM)
  })

  it('keeps nothing when a write is a replay', async () => {
    const held = parseSyncRow('fuel_fills', fill(FILL_A))
    if (!held.ok) throw new Error('fixture')
    const { store, recorded } = storeWithHistory([held.row])

    await applySyncPush(store, push([{ table: 'fuel_fills', row: fill(FILL_A) }]), {
      teamId: TEAM,
      now: NOW,
    })

    expect(recorded).toHaveLength(0)
  })

  it('works against a store that keeps no history at all', async () => {
    // The method is optional so the client-side store, which has no history to
    // keep, does not have to pretend.
    const { store } = memoryStore()
    const response = await applySyncPush(
      store,
      push([{ table: 'fuel_fills', row: fill(FILL_A) }]),
      {
        teamId: TEAM,
        now: NOW,
      },
    )
    expect(response.results[0]?.outcome).toBe('insert')
  })
})
