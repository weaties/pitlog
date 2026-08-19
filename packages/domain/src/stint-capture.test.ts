import { describe, expect, it } from 'vitest'
import type { CapturedStint } from './stint-capture.js'
import { applyDriverIn, applyDriverOut, openStint } from './stint-capture.js'

const SESSION = 'session-1'
const T = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 15, minutes))

function planned(overrides: Partial<CapturedStint> & { sequence: number }): CapturedStint {
  return {
    id: `stint-${overrides.sequence}`,
    session_id: SESSION,
    driver_id: null,
    planned_start_at: null,
    planned_end_at: null,
    started_at: null,
    ended_at: null,
    ...overrides,
  }
}

describe('applyDriverIn — starting a planned stint', () => {
  it('starts the stint that was planned rather than creating a second one', () => {
    // The failure this prevents: a plan of six stints becoming a plan of six
    // plus six actuals, with the planner double-counting seat time.
    const stints = [
      planned({ sequence: 1, driver_id: 'ana', planned_start_at: T(0), planned_end_at: T(75) }),
    ]

    const result = applyDriverIn(stints, { sessionId: SESSION, driverId: 'ana', at: T(2) })

    expect(result.created).toBe(false)
    expect(result.stint.id).toBe('stint-1')
    expect(result.stint.started_at).toEqual(T(2))
  })

  it('claims an unassigned planned stint for whoever actually got in', () => {
    const stints = [planned({ sequence: 1, planned_start_at: T(0) })]

    const result = applyDriverIn(stints, { sessionId: SESSION, driverId: 'bo', at: T(1) })

    expect(result.created).toBe(false)
    expect(result.stint.driver_id).toBe('bo')
  })

  it('prefers the plan nearest to now when several are unstarted', () => {
    const stints = [
      planned({ sequence: 1, driver_id: 'ana', planned_start_at: T(0) }),
      planned({ sequence: 2, driver_id: 'ana', planned_start_at: T(81) }),
      planned({ sequence: 3, driver_id: 'ana', planned_start_at: T(162) }),
    ]

    const result = applyDriverIn(stints, { sessionId: SESSION, driverId: 'ana', at: T(80) })
    expect(result.stint.sequence).toBe(2)
  })

  it('does not steal a stint planned for somebody else', () => {
    const stints = [planned({ sequence: 1, driver_id: 'ana', planned_start_at: T(0) })]

    const result = applyDriverIn(stints, { sessionId: SESSION, driverId: 'cy', at: T(1) })

    expect(result.created).toBe(true)
    expect(result.stint.driver_id).toBe('cy')
  })

  it('ignores plans from another session', () => {
    const stints = [planned({ sequence: 1, session_id: 'other', driver_id: 'ana' })]
    const result = applyDriverIn(stints, { sessionId: SESSION, driverId: 'ana', at: T(1) })
    expect(result.created).toBe(true)
  })
})

describe('applyDriverIn — the car pitted for something nobody planned', () => {
  it('creates a stint and numbers it after the last one', () => {
    const stints = [planned({ sequence: 1, driver_id: 'ana', started_at: T(0), ended_at: T(20) })]

    const result = applyDriverIn(stints, { sessionId: SESSION, driverId: 'bo', at: T(26) })

    expect(result.created).toBe(true)
    expect(result.stint.sequence).toBe(2)
    expect(result.stint.planned_start_at).toBeNull()
    expect(result.stint.started_at).toEqual(T(26))
  })

  it('numbers the first stint of a session 1', () => {
    const result = applyDriverIn([], { sessionId: SESSION, driverId: 'ana', at: T(0) })
    expect(result.stint.sequence).toBe(1)
  })

  it('closes a stint somebody forgot to end', () => {
    // Driver changes happen faster than the person with the phone. An open
    // stint when the next driver gets in means the last one ended here.
    const stints = [planned({ sequence: 1, driver_id: 'ana', started_at: T(0) })]

    const result = applyDriverIn(stints, { sessionId: SESSION, driverId: 'bo', at: T(80) })

    expect(result.closed?.id).toBe('stint-1')
    expect(result.closed?.ended_at).toEqual(T(80))
    expect(result.stint.driver_id).toBe('bo')
  })
})

describe('applyDriverOut', () => {
  it('ends the stint that is open', () => {
    const stints = [planned({ sequence: 1, driver_id: 'ana', started_at: T(0) })]

    const result = applyDriverOut(stints, { sessionId: SESSION, at: T(75) })

    expect(result.created).toBe(false)
    expect(result.stint.id).toBe('stint-1')
    expect(result.stint.ended_at).toEqual(T(75))
  })

  it('ends the most recently started stint when more than one is open', () => {
    const stints = [
      planned({ sequence: 1, driver_id: 'ana', started_at: T(0) }),
      planned({ sequence: 2, driver_id: 'bo', started_at: T(80) }),
    ]

    const result = applyDriverOut(stints, { sessionId: SESSION, at: T(150) })
    expect(result.stint.sequence).toBe(2)
  })

  it('records a driver-out that arrived before its driver-in', () => {
    // Two phones, one of them offline. The out synced first; the in is still
    // sitting in someone's outbox. Losing it is not an option.
    const result = applyDriverOut([], { sessionId: SESSION, at: T(75), driverId: 'ana' })

    expect(result.created).toBe(true)
    expect(result.stint.ended_at).toEqual(T(75))
    expect(result.stint.started_at).toBeNull()
  })

  it('lets the late driver-in fill in the stint the out already created', () => {
    const orphaned = planned({ sequence: 1, driver_id: 'ana', ended_at: T(75) })

    const result = applyDriverIn([orphaned], { sessionId: SESSION, driverId: 'ana', at: T(0) })

    expect(result.created).toBe(false)
    expect(result.stint.id).toBe('stint-1')
    expect(result.stint.started_at).toEqual(T(0))
    expect(result.stint.ended_at).toEqual(T(75))
  })

  it('does not adopt an orphan that ended before the driver got in', () => {
    // An earlier stint by the same driver, already complete. Filling this in
    // would rewrite history rather than reconcile it.
    const earlier = planned({ sequence: 1, driver_id: 'ana', started_at: T(0), ended_at: T(75) })

    const result = applyDriverIn([earlier], { sessionId: SESSION, driverId: 'ana', at: T(160) })
    expect(result.created).toBe(true)
  })
})

describe('openStint', () => {
  it('finds the driver currently in the car', () => {
    const stints = [
      planned({ sequence: 1, driver_id: 'ana', started_at: T(0), ended_at: T(75) }),
      planned({ sequence: 2, driver_id: 'bo', started_at: T(81) }),
    ]

    expect(openStint(stints, SESSION)?.driver_id).toBe('bo')
  })

  it('is null when the car is in the pits', () => {
    const stints = [planned({ sequence: 1, driver_id: 'ana', started_at: T(0), ended_at: T(75) })]
    expect(openStint(stints, SESSION)).toBeNull()
  })

  it('ignores a stint that only has an end, which is an unreconciled orphan', () => {
    expect(openStint([planned({ sequence: 1, ended_at: T(75) })], SESSION)).toBeNull()
  })
})
