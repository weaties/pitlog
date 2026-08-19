import { describe, expect, it, vi } from 'vitest'
import type { SyncRow } from './merge.js'
import type { SyncPushRequest, SyncPushResponse } from './protocol.js'
import type { QueuedWrite, QueueStorage, SyncTransport } from './queue.js'
import { backoffMs, drainOnce, enqueue, MAX_BATCH, queueDepth } from './queue.js'

const TEAM = '00000000-0000-4000-8000-000000000001'

function row(id: string): SyncRow {
  return {
    id,
    team_id: TEAM,
    client_updated_at: new Date('2026-10-10T14:00:00.000Z'),
    deleted_at: null,
    updated_by: null,
    gallons: 14.2,
  }
}

/** Stands in for IndexedDB. The retry policy has nothing to do with a browser. */
function memoryStorage(seed: QueuedWrite[] = []) {
  const rows = new Map(seed.map((w) => [w.seq, w]))
  const storage: QueueStorage = {
    async list() {
      return [...rows.values()]
    },
    async put(writes) {
      for (const w of writes) rows.set(w.seq, w)
    },
    async remove(seqs) {
      for (const seq of seqs) rows.delete(seq)
    },
  }
  return { storage, rows }
}

function transportReturning(results: SyncPushResponse['results']): SyncTransport {
  return {
    async push() {
      return { protocolVersion: 1, results, cursor: 'c' }
    },
  }
}

const accepted = (id: string) => ({
  table: 'fuel_fills',
  id,
  outcome: 'insert' as const,
  loser: null,
})

describe('enqueue', () => {
  it('makes a write durable before anything touches the network', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    expect(rows.size).toBe(1)
    expect(await queueDepth(storage)).toBe(1)
  })

  it('hands back the next sequence number so a reload can resume counting', async () => {
    const { storage } = memoryStorage()
    const next = await enqueue(storage, 7, [
      { table: 'fuel_fills', row: row('a') },
      { table: 'fuel_fills', row: row('b') },
    ])

    expect(next).toBe(9)
  })

  it('keeps the order things were actually typed in', async () => {
    const { storage } = memoryStorage()
    await enqueue(storage, 1, [
      { table: 'log_entries', row: row('first') },
      { table: 'log_entries', row: row('second') },
    ])

    const queued = (await storage.list()).sort((a, b) => a.seq - b.seq)
    expect(queued.map((w) => w.row.id)).toEqual(['first', 'second'])
  })
})

describe('drainOnce — the happy path', () => {
  it('does nothing when there is nothing waiting', async () => {
    const { storage } = memoryStorage()
    const push = vi.fn()
    const result = await drainOnce(storage, { push })

    expect(push).not.toHaveBeenCalled()
    expect(result.retryAfterMs).toBeNull()
  })

  it('clears writes the server accounted for', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    const result = await drainOnce(storage, transportReturning([accepted('a')]))

    expect(result.settled).toBe(1)
    expect(result.remaining).toBe(0)
    expect(rows.size).toBe(0)
  })

  it('treats a stale write the server already beat as settled', async () => {
    // Resending it would be pointless: the server holds something better.
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    await drainOnce(
      storage,
      transportReturning([{ table: 'fuel_fills', id: 'a', outcome: 'current_wins', loser: null }]),
    )

    expect(rows.size).toBe(0)
  })

  it('treats a replay as settled rather than retrying it forever', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    await drainOnce(
      storage,
      transportReturning([{ table: 'fuel_fills', id: 'a', outcome: 'unchanged', loser: null }]),
    )

    expect(rows.size).toBe(0)
  })

  it('sends at most one batch and asks to come straight back for the rest', async () => {
    const { storage } = memoryStorage()
    const many = Array.from({ length: MAX_BATCH + 5 }, (_, i) => ({
      table: 'log_entries' as const,
      row: row(`r${i}`),
    }))
    await enqueue(storage, 1, many)

    let sent = 0
    const transport: SyncTransport = {
      async push(request: SyncPushRequest) {
        sent = request.writes.length
        return {
          protocolVersion: 1,
          results: request.writes.map((w) => accepted((w.row as SyncRow).id)),
          cursor: 'c',
        }
      },
    }

    const result = await drainOnce(storage, transport)

    expect(sent).toBe(MAX_BATCH)
    expect(result.remaining).toBe(5)
    expect(result.retryAfterMs).toBe(0)
  })
})

describe('drainOnce — no network', () => {
  it('loses nothing when the push throws', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    const result = await drainOnce(storage, {
      async push() {
        throw new Error('Failed to fetch')
      },
    })

    expect(rows.size).toBe(1)
    expect(result.settled).toBe(0)
    expect(result.remaining).toBe(1)
  })

  it('remembers why, so the crew can be told what is wrong', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    await drainOnce(storage, {
      async push() {
        throw new Error('Failed to fetch')
      },
    })

    expect([...rows.values()][0]?.lastError).toBe('Failed to fetch')
    expect([...rows.values()][0]?.attempts).toBe(1)
  })

  it('backs off instead of spinning against a dead network', async () => {
    const { storage } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])
    const dead: SyncTransport = {
      async push() {
        throw new Error('offline')
      },
    }

    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      const result = await drainOnce(storage, dead)
      delays.push(result.retryAfterMs ?? -1)
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000])
  })

  it('stops the backoff growing without bound', async () => {
    // A crew back in signal after two hours should not wait another two.
    expect(backoffMs(1)).toBe(1_000)
    expect(backoffMs(50)).toBe(5 * 60_000)
    expect(backoffMs(0)).toBe(0)
  })

  it('survives a reload — the queue is the storage, not memory', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])
    await drainOnce(storage, {
      async push() {
        throw new Error('offline')
      },
    })

    // A fresh "page load" over the same durable rows.
    const reloaded = memoryStorage([...rows.values()])
    expect(await queueDepth(reloaded.storage)).toBe(1)

    const result = await drainOnce(reloaded.storage, transportReturning([accepted('a')]))
    expect(result.settled).toBe(1)
  })
})

describe('drainOnce — writes the server refuses', () => {
  it('takes them off the queue rather than retrying forever', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    const result = await drainOnce(
      storage,
      transportReturning([
        {
          table: 'fuel_fills',
          id: 'a',
          outcome: 'rejected',
          loser: null,
          error: 'gallons: required',
        },
      ]),
    )

    expect(rows.size).toBe(0)
    expect(result.rejected).toHaveLength(1)
  })

  it('hands them back with the reason, because a human has to hear about it', async () => {
    const { storage } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    const result = await drainOnce(
      storage,
      transportReturning([
        {
          table: 'fuel_fills',
          id: 'a',
          outcome: 'rejected',
          loser: null,
          error: 'gallons: required',
        },
      ]),
    )

    expect(result.rejected[0]?.lastError).toBe('gallons: required')
    expect(result.rejected[0]?.row.id).toBe('a')
  })

  it('does not let one refused row hold up the others', async () => {
    const { storage, rows } = memoryStorage()
    await enqueue(storage, 1, [
      { table: 'fuel_fills', row: row('bad') },
      { table: 'fuel_fills', row: row('good') },
    ])

    const result = await drainOnce(
      storage,
      transportReturning([
        { table: 'fuel_fills', id: 'bad', outcome: 'rejected', loser: null, error: 'nope' },
        accepted('good'),
      ]),
    )

    expect(rows.size).toBe(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.settled).toBe(2)
  })
})

describe('drainOnce — conflicts', () => {
  it('passes the losing value up for the conflict UI', async () => {
    const { storage } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    const result = await drainOnce(
      storage,
      transportReturning([
        { table: 'fuel_fills', id: 'a', outcome: 'incoming_wins', loser: row('a') },
      ]),
    )

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.loser?.id).toBe('a')
  })

  it('reports no conflict when nothing lost', async () => {
    const { storage } = memoryStorage()
    await enqueue(storage, 1, [{ table: 'fuel_fills', row: row('a') }])

    const result = await drainOnce(storage, transportReturning([accepted('a')]))
    expect(result.conflicts).toEqual([])
  })
})
