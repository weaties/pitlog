import { describe, expect, it } from 'vitest'
import type { SyncRow } from './merge.js'
import { mergeAll, mergeRow } from './merge.js'

interface Fill {
  gallons: number
}

const KIM = '11111111-1111-4111-8111-111111111111'
const SAM = '22222222-2222-4222-8222-222222222222'
const FILL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** `at` is minutes past the hour on the writing device's clock. */
function fill(overrides: Partial<SyncRow<Fill>> & { at: number; by: string }): SyncRow<Fill> {
  const { at, by, ...rest } = overrides
  return {
    id: FILL,
    gallons: 14.2,
    client_updated_at: new Date(`2026-10-10T14:${String(at).padStart(2, '0')}:00.000Z`),
    deleted_at: null,
    updated_by: by,
    ...rest,
  }
}

describe('mergeRow — a row the server has never seen', () => {
  it('inserts it rather than erroring', () => {
    const decision = mergeRow(null, fill({ at: 2, by: KIM }))

    expect(decision.outcome).toBe('insert')
    expect(decision.winner.gallons).toBe(14.2)
    expect(decision.loser).toBeNull()
    expect(decision.conflict).toBe(false)
  })

  it('inserts a row that arrives already deleted', () => {
    // A row created and deleted offline, both before the first sync.
    const deleted = fill({ at: 2, by: KIM, deleted_at: new Date('2026-10-10T14:05:00.000Z') })
    const decision = mergeRow(null, deleted)

    expect(decision.outcome).toBe('insert')
    expect(decision.winner.deleted_at).not.toBeNull()
  })
})

describe('mergeRow — last write wins on the client clock', () => {
  it('takes the incoming row when it is newer', () => {
    const decision = mergeRow(fill({ at: 2, by: KIM }), fill({ at: 30, by: SAM, gallons: 12.4 }))

    expect(decision.outcome).toBe('incoming_wins')
    expect(decision.winner.gallons).toBe(12.4)
    expect(decision.loser?.gallons).toBe(14.2)
  })

  it('keeps what it has when the incoming row is older', () => {
    const decision = mergeRow(fill({ at: 30, by: KIM, gallons: 12.4 }), fill({ at: 2, by: SAM }))

    expect(decision.outcome).toBe('current_wins')
    expect(decision.winner.gallons).toBe(12.4)
    expect(decision.loser?.gallons).toBe(14.2)
  })

  it('never consults the server clock', () => {
    // This is the whole point of the design. A correction typed at 14:02
    // offline and synced at 18:30 must not beat one typed at 14:30 online.
    const typedEarlySyncedLate = {
      ...fill({ at: 2, by: KIM }),
      server_updated_at: new Date('2026-10-10T18:30:00.000Z'),
    }
    const typedLateSyncedImmediately = {
      ...fill({ at: 30, by: SAM, gallons: 12.4 }),
      server_updated_at: new Date('2026-10-10T14:30:00.000Z'),
    }

    const decision = mergeRow(typedLateSyncedImmediately, typedEarlySyncedLate)

    expect(decision.outcome).toBe('current_wins')
    expect(decision.winner.gallons).toBe(12.4)
  })
})

describe('mergeRow — ties', () => {
  const kimsWrite = fill({ at: 2, by: KIM, gallons: 14.2 })
  const samsWrite = fill({ at: 2, by: SAM, gallons: 12.4 })

  it('breaks a tie on updated_by rather than on arrival order', () => {
    const decision = mergeRow(kimsWrite, samsWrite)
    expect(decision.outcome).toBe('incoming_wins')
    expect(decision.winner.updated_by).toBe(SAM)
  })

  it('reaches the same winner from either side — this is what makes devices converge', () => {
    const onKimsPhone = mergeRow(kimsWrite, samsWrite)
    const onSamsPhone = mergeRow(samsWrite, kimsWrite)

    expect(onKimsPhone.winner).toEqual(onSamsPhone.winner)
    expect(onKimsPhone.loser).toEqual(onSamsPhone.loser)
    expect(onKimsPhone.winner.updated_by).toBe(SAM)
  })

  it('surfaces the losing value on both devices, not just the one that lost', () => {
    expect(mergeRow(kimsWrite, samsWrite).loser?.gallons).toBe(14.2)
    expect(mergeRow(samsWrite, kimsWrite).loser?.gallons).toBe(14.2)
  })

  it('treats an unattributed write as ranking below any attributed one', () => {
    const anonymous = fill({ at: 2, by: KIM, updated_by: null })
    const attributed = fill({ at: 2, by: KIM, gallons: 9 })

    expect(mergeRow(anonymous, attributed).winner.gallons).toBe(9)
    expect(mergeRow(attributed, anonymous).winner.gallons).toBe(9)
  })
})

describe('mergeRow — replay', () => {
  it('is a no-op when the same write arrives twice', () => {
    const write = fill({ at: 2, by: KIM })
    const decision = mergeRow(write, { ...write })

    expect(decision.outcome).toBe('unchanged')
    expect(decision.conflict).toBe(false)
    expect(decision.loser).toBeNull()
  })

  it('is idempotent — applying an incoming row twice lands in the same place', () => {
    const current = fill({ at: 2, by: KIM })
    const incoming = fill({ at: 30, by: SAM, gallons: 12.4 })

    const once = mergeRow(current, incoming)
    const twice = mergeRow(once.winner, incoming)

    expect(twice.winner).toEqual(once.winner)
    expect(twice.outcome).toBe('unchanged')
  })
})

describe('mergeRow — delete against edit', () => {
  const deletedAt = new Date('2026-10-10T14:40:00.000Z')

  it('lets the later delete win', () => {
    const edit = fill({ at: 30, by: KIM, gallons: 12.4 })
    const remove = fill({ at: 40, by: SAM, deleted_at: deletedAt })

    const decision = mergeRow(edit, remove)
    expect(decision.outcome).toBe('incoming_wins')
    expect(decision.winner.deleted_at).toEqual(deletedAt)
  })

  it('lets the later edit win over an earlier delete', () => {
    const remove = fill({ at: 30, by: SAM, deleted_at: deletedAt })
    const edit = fill({ at: 40, by: KIM, gallons: 12.4 })

    const decision = mergeRow(remove, edit)
    expect(decision.outcome).toBe('incoming_wins')
    expect(decision.winner.deleted_at).toBeNull()
    expect(decision.winner.gallons).toBe(12.4)
  })

  it('surfaces a losing delete rather than dropping it', () => {
    // Someone deleted this row and does not know their delete lost. If the
    // app stays silent they will assume it is gone.
    const remove = fill({ at: 30, by: SAM, deleted_at: deletedAt })
    const edit = fill({ at: 40, by: KIM, gallons: 12.4 })

    const decision = mergeRow(remove, edit)
    expect(decision.conflict).toBe(true)
    expect(decision.loser?.deleted_at).toEqual(deletedAt)
  })

  it('surfaces a losing delete even when the same person made both writes', () => {
    // Same author is normally an ordinary correction, but losing a delete is
    // never ordinary — the row is back and they need to know.
    const remove = fill({ at: 30, by: KIM, deleted_at: deletedAt })
    const edit = fill({ at: 40, by: KIM, gallons: 12.4 })

    expect(mergeRow(remove, edit).conflict).toBe(true)
  })

  it('never hard-deletes — the losing row is still a row', () => {
    const remove = fill({ at: 40, by: SAM, deleted_at: deletedAt })
    const decision = mergeRow(fill({ at: 30, by: KIM }), remove)

    expect(decision.winner.id).toBe(FILL)
    expect(decision.winner.gallons).toBe(14.2)
  })
})

describe('mergeRow — what counts as a conflict worth showing someone', () => {
  it('flags two people disagreeing', () => {
    const decision = mergeRow(fill({ at: 2, by: KIM }), fill({ at: 30, by: SAM, gallons: 12.4 }))
    expect(decision.conflict).toBe(true)
  })

  it('does not flag one person correcting themselves', () => {
    // An ordinary edit. Showing this as a conflict would train people to
    // ignore the conflict UI, which is worse than not having one.
    const decision = mergeRow(fill({ at: 2, by: KIM }), fill({ at: 30, by: KIM, gallons: 12.4 }))

    expect(decision.outcome).toBe('incoming_wins')
    expect(decision.conflict).toBe(false)
  })

  it('does not flag two people who happen to have written the same value', () => {
    const decision = mergeRow(fill({ at: 2, by: KIM }), fill({ at: 30, by: SAM }))
    expect(decision.conflict).toBe(false)
    expect(decision.loser).toBeNull()
  })
})

describe('mergeRow — purity', () => {
  it('does not mutate what it was given', () => {
    const current = fill({ at: 2, by: KIM })
    const incoming = fill({ at: 30, by: SAM, gallons: 12.4 })
    const snapshot = JSON.stringify({ current, incoming })

    mergeRow(current, incoming)

    expect(JSON.stringify({ current, incoming })).toBe(snapshot)
  })

  it('converges regardless of the order writes arrive in', () => {
    // The property the whole design rests on: three devices, three writes,
    // any arrival order, one agreed answer.
    const writes = [
      fill({ at: 2, by: KIM, gallons: 14.2 }),
      fill({ at: 30, by: SAM, gallons: 12.4 }),
      fill({ at: 30, by: KIM, gallons: 13.1 }),
    ]

    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]

    const settled = orders.map((order) => {
      let state: SyncRow<Fill> | null = null
      for (const index of order) {
        const write = writes[index]
        if (!write) throw new Error('unreachable')
        state = mergeRow(state, write).winner
      }
      return state
    })

    for (const state of settled) expect(state).toEqual(settled[0])
    expect(settled[0]?.gallons).toBe(12.4)
  })
})

describe('mergeAll', () => {
  const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  it('merges a batch row by row, keyed on id', () => {
    const current = new Map([[FILL, fill({ at: 2, by: KIM })]])
    const incoming = [
      fill({ at: 30, by: SAM, gallons: 12.4 }),
      fill({ at: 5, by: SAM, id: OTHER, gallons: 8 }),
    ]

    const decisions = mergeAll(current, incoming)

    expect(decisions).toHaveLength(2)
    expect(decisions[0]?.outcome).toBe('incoming_wins')
    expect(decisions[1]?.outcome).toBe('insert')
  })

  it('lets one bad row lose without touching the rest', () => {
    // A stale write for one row must not stop a fresh write for another.
    const current = new Map([
      [FILL, fill({ at: 30, by: KIM, gallons: 12.4 })],
      [OTHER, fill({ at: 2, by: KIM, id: OTHER, gallons: 8 })],
    ])
    const incoming = [fill({ at: 2, by: SAM }), fill({ at: 40, by: SAM, id: OTHER, gallons: 9 })]

    const decisions = mergeAll(current, incoming)

    expect(decisions[0]?.outcome).toBe('current_wins')
    expect(decisions[1]?.outcome).toBe('incoming_wins')
    expect(decisions[1]?.winner.gallons).toBe(9)
  })

  it('collects the conflicts for the surfacing UI', () => {
    const current = new Map([[FILL, fill({ at: 2, by: KIM })]])
    const decisions = mergeAll(current, [fill({ at: 30, by: SAM, gallons: 12.4 })])

    expect(decisions.filter((d) => d.conflict)).toHaveLength(1)
  })

  it('handles two writes for the same row inside one batch', () => {
    const decisions = mergeAll(new Map(), [
      fill({ at: 2, by: KIM }),
      fill({ at: 30, by: SAM, gallons: 12.4 }),
    ])

    expect(decisions).toHaveLength(2)
    expect(decisions[1]?.outcome).toBe('incoming_wins')
    expect(decisions[1]?.winner.gallons).toBe(12.4)
  })
})
