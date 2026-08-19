import { describe, expect, it } from 'vitest'
import { conflictingPins, coverageGaps, expectedSeatTime, isAvailableFor } from './availability.js'
import type { PlannerDriver } from './stint-solver.js'

const HOUR = 3600

function driver(id: string, overrides: Partial<PlannerDriver> = {}): PlannerDriver {
  return {
    id,
    canDrive: true,
    minStintSeconds: null,
    maxStintSeconds: null,
    burnRateFactor: 1,
    ...overrides,
  }
}

describe('coverageGaps', () => {
  it('finds nothing when everybody is around all day', () => {
    expect(coverageGaps([driver('a'), driver('b')], 8 * HOUR)).toEqual([])
  })

  it('finds the stretch nobody can cover', () => {
    // Dan has to be done by 1pm and nobody else is there.
    const gaps = coverageGaps([driver('dan', { availableUntilSeconds: 3 * HOUR })], 8 * HOUR)
    expect(gaps).toEqual([{ fromSeconds: 3 * HOUR, untilSeconds: 8 * HOUR }])
  })

  it('finds a hole in the middle of the day', () => {
    const gaps = coverageGaps(
      [
        driver('a', { availableUntilSeconds: 2 * HOUR }),
        driver('b', { availableFromSeconds: 5 * HOUR }),
      ],
      8 * HOUR,
    )
    expect(gaps).toEqual([{ fromSeconds: 2 * HOUR, untilSeconds: 5 * HOUR }])
  })

  it('is satisfied by a hand-over with no overlap', () => {
    const gaps = coverageGaps(
      [
        driver('a', { availableUntilSeconds: 4 * HOUR }),
        driver('b', { availableFromSeconds: 4 * HOUR }),
      ],
      8 * HOUR,
    )
    expect(gaps).toEqual([])
  })

  it('is satisfied when one driver covers everything the others miss', () => {
    const gaps = coverageGaps(
      [
        driver('a', { availableUntilSeconds: 2 * HOUR }),
        driver('b', { availableFromSeconds: 5 * HOUR }),
        driver('all-day'),
      ],
      8 * HOUR,
    )
    expect(gaps).toEqual([])
  })

  it('reports a late start as a gap at the front', () => {
    const gaps = coverageGaps([driver('a', { availableFromSeconds: HOUR })], 8 * HOUR)
    expect(gaps[0]).toEqual({ fromSeconds: 0, untilSeconds: HOUR })
  })

  it('ignores drivers who cannot drive at all', () => {
    const gaps = coverageGaps([driver('crew', { canDrive: false })], 4 * HOUR)
    expect(gaps).toEqual([{ fromSeconds: 0, untilSeconds: 4 * HOUR }])
  })
})

describe('conflictingPins', () => {
  it('is quiet when nobody is pinned', () => {
    expect(conflictingPins([driver('a'), driver('b')])).toEqual([])
  })

  it('is quiet when pins are distinct', () => {
    expect(
      conflictingPins([driver('a', { pinnedSequence: 1 }), driver('b', { pinnedSequence: 2 })]),
    ).toEqual([])
  })

  it('names the stint two drivers both claim', () => {
    const conflicts = conflictingPins([
      driver('a', { pinnedSequence: 1 }),
      driver('b', { pinnedSequence: 1 }),
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toContain('stint 1')
    expect(conflicts[0]).toContain('a')
    expect(conflicts[0]).toContain('b')
  })
})

describe('isAvailableFor', () => {
  it('accepts a stint wholly inside the window', () => {
    expect(isAvailableFor(driver('a', { availableUntilSeconds: 4 * HOUR }), 0, 2 * HOUR)).toBe(true)
  })

  it('rejects a stint that runs past the window', () => {
    // A stint that merely *starts* before one o'clock is not good enough.
    expect(
      isAvailableFor(driver('a', { availableUntilSeconds: 4 * HOUR }), 3 * HOUR, 5 * HOUR),
    ).toBe(false)
  })

  it('rejects a stint that starts before the driver arrives', () => {
    expect(isAvailableFor(driver('a', { availableFromSeconds: HOUR }), 0, 2 * HOUR)).toBe(false)
  })

  it('accepts anything when the window is unbounded', () => {
    expect(isAvailableFor(driver('a'), 0, 24 * HOUR)).toBe(true)
  })
})

describe('expectedSeatTime', () => {
  it('is an equal share when everybody is around all day', () => {
    const expected = expectedSeatTime([driver('a'), driver('b')], 8 * HOUR, 7 * HOUR)
    expect(expected.get('a')).toBeCloseTo(3.5 * HOUR, 6)
    expect(expected.get('b')).toBeCloseTo(3.5 * HOUR, 6)
  })

  it('expects less of somebody who is only around for half of it', () => {
    // Fairness must stop fighting a constraint it cannot change: a driver
    // leaving at lunchtime will take less of the race, and calling that
    // unfairness would send the solver after a plan that does not exist.
    const expected = expectedSeatTime(
      [driver('a', { availableUntilSeconds: 4 * HOUR }), driver('b')],
      8 * HOUR,
      6 * HOUR,
    )

    expect(expected.get('a')).toBeCloseTo(2 * HOUR, 6)
    expect(expected.get('b')).toBeCloseTo(4 * HOUR, 6)
  })

  it('always adds up to the driving time', () => {
    const expected = expectedSeatTime(
      [
        driver('a', { availableUntilSeconds: 3 * HOUR }),
        driver('b', { availableFromSeconds: 2 * HOUR }),
        driver('c'),
      ],
      8 * HOUR,
      7 * HOUR,
    )
    const total = [...expected.values()].reduce((sum, v) => sum + v, 0)
    expect(total).toBeCloseTo(7 * HOUR, 6)
  })

  it('leaves out crew who never drive', () => {
    const expected = expectedSeatTime(
      [driver('a'), driver('crew', { canDrive: false })],
      HOUR,
      HOUR,
    )
    expect(expected.has('crew')).toBe(false)
  })
})
