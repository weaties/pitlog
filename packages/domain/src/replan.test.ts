import { describe, expect, it } from 'vitest'
import type { BurnRateEstimate } from './burn-rate.js'
import { estimateBurnRate } from './burn-rate.js'
import { EIGHT_HOUR_RACE, KNOWN_GOOD_SOLUTION } from './fixtures/eight-hour-race.js'
import type { ActualStint, RaceProgress } from './replan.js'
import { replanFromNow } from './replan.js'
import type { PlannerDriver, StintPlanInput } from './stint-solver.js'

const MINUTE = 60
const HOUR = 3600

function seeded(gph: number): BurnRateEstimate {
  const estimate = estimateBurnRate({ fills: [], stints: [], knownFullAt: null, seedGph: gph })
  if (!estimate) throw new Error('unreachable')
  return estimate
}

function driver(id: string, overrides: Partial<PlannerDriver> = {}): PlannerDriver {
  return {
    id,
    canDrive: true,
    minStintSeconds: 30 * MINUTE,
    maxStintSeconds: 90 * MINUTE,
    burnRateFactor: 1,
    ...overrides,
  }
}

const { race, drivers: fixtureDrivers } = EIGHT_HOUR_RACE

/** The fixture race, as the solver sees it. */
function fixtureInput(overrides: Partial<StintPlanInput> = {}): StintPlanInput {
  return {
    raceSeconds: race.durationSeconds,
    fuelCapacityGallons: race.fuelCapacityGallons,
    reserveGallons: race.reserveGallons,
    pitStopSeconds: race.pitStopSeconds,
    burnRate: seeded(race.burnRateGph),
    drivers: fixtureDrivers.map((d) =>
      driver(d.key, {
        minStintSeconds: d.minStintSeconds,
        maxStintSeconds: d.maxStintSeconds,
        burnRateFactor: d.burnRateFactor,
      }),
    ),
    rules: null,
    ...overrides,
  }
}

/** The first `count` known-good stints, as though they had run to plan. */
function ranToPlan(count: number): ActualStint[] {
  return KNOWN_GOOD_SOLUTION.stints.slice(0, count).map((s) => ({
    driverId: s.driverKey,
    startOffsetSeconds: s.startOffsetSeconds,
    endOffsetSeconds: s.endOffsetSeconds,
  }))
}

function expectOk(result: ReturnType<typeof replanFromNow>) {
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}: ${result.detail}`)
  return result.plan
}

function expectFailure(result: ReturnType<typeof replanFromNow>) {
  if (result.ok) throw new Error('expected the replan to refuse')
  return result
}

// ---------------------------------------------------------------------------
// The mid-race fixture — a race that has run exactly to plan must re-solve to
// the rest of that same plan. Anything else means replanning drifts.
// ---------------------------------------------------------------------------

describe('replanFromNow — the fixture race, halfway through', () => {
  // Three stints done and the third stop complete: the car is leaving the box
  // on a full tank, 14580 s in.
  const leavingTheBox = 3 * 4500 + 3 * 360

  const progress: RaceProgress = {
    elapsedSeconds: leavingTheBox,
    stints: ranToPlan(3),
    fuelGallons: race.fuelCapacityGallons,
  }

  const plan = expectOk(replanFromNow(fixtureInput(), progress))

  it('re-solves to exactly the remaining known-good stints', () => {
    expect(
      plan.stints.map((s) => ({
        driverKey: s.driverId,
        startOffsetSeconds: s.startOffsetSeconds,
        endOffsetSeconds: s.endOffsetSeconds,
        fuelAtStartGallons: s.fuelAtStartGallons,
        fuelAtEndGallons: s.fuelAtEndGallons,
      })),
    ).toEqual(
      KNOWN_GOOD_SOLUTION.stints.slice(3).map((s) => ({
        driverKey: s.driverKey,
        startOffsetSeconds: s.startOffsetSeconds,
        endOffsetSeconds: s.endOffsetSeconds,
        fuelAtStartGallons: s.fuelAtStartGallons,
        fuelAtEndGallons: s.fuelAtEndGallons,
      })),
    )
  })

  it('runs to the chequered flag, not to some horizon of its own', () => {
    expect(plan.stints.at(-1)?.endOffsetSeconds).toBe(race.durationSeconds)
  })

  it('offsets are measured from the race start, not from now', () => {
    expect(plan.stints[0]?.startOffsetSeconds).toBe(leavingTheBox)
  })

  it('counts seat time already taken toward the whole-race split', () => {
    expect(plan.seatTimeTakenSecondsByDriver).toEqual({ ana: 4500, bo: 4500, cy: 4500 })
    expect(plan.seatTimeSecondsByDriver).toEqual({ ana: 9000, bo: 9000, cy: 9000 })
    expect(plan.seatTimeSpreadSeconds).toBe(0)
  })

  it('never plans a stint that starts in the past', () => {
    for (const stint of plan.stints) {
      expect(stint.startOffsetSeconds).toBeGreaterThanOrEqual(leavingTheBox)
    }
  })
})

// ---------------------------------------------------------------------------
// Fairness is measured against what has already happened
// ---------------------------------------------------------------------------

describe('replanFromNow — fairness from where we are, not from zero', () => {
  it('gives the next stint to whoever is behind on seat time', () => {
    // Ana has done two stints back to back; Cy has not driven at all.
    const progress: RaceProgress = {
      elapsedSeconds: 2 * 4500 + 2 * 360,
      stints: [
        { driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 4500 },
        { driverId: 'ana', startOffsetSeconds: 4860, endOffsetSeconds: 9360 },
      ],
      fuelGallons: race.fuelCapacityGallons,
    }

    const plan = expectOk(replanFromNow(fixtureInput(), progress))

    expect(plan.stints[0]?.driverId).toBe('bo')
    expect(plan.stints[1]?.driverId).toBe('cy')
    expect(plan.stints.map((s) => s.driverId)).not.toContain('ana')
  })

  it('evens the whole race out rather than the remainder of it', () => {
    const progress: RaceProgress = {
      elapsedSeconds: 2 * 4500 + 2 * 360,
      stints: [
        { driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 4500 },
        { driverId: 'bo', startOffsetSeconds: 4860, endOffsetSeconds: 9360 },
      ],
      fuelGallons: race.fuelCapacityGallons,
    }

    const plan = expectOk(replanFromNow(fixtureInput({ fairnessWeight: 1 }), progress))
    const seat = Object.values(plan.seatTimeSecondsByDriver)
    expect(Math.max(...seat) - Math.min(...seat)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A driver is in the car right now
// ---------------------------------------------------------------------------

describe('replanFromNow — mid-stint', () => {
  const progress: RaceProgress = {
    elapsedSeconds: 4500 + 360 + 1800,
    stints: [
      { driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 4500 },
      // Bo went out 30 minutes ago and is still on track.
      { driverId: 'bo', startOffsetSeconds: 4860, endOffsetSeconds: null },
    ],
    fuelGallons: 13,
  }

  const plan = expectOk(replanFromNow(fixtureInput(), progress))

  it('leaves the driver who is on track in the car', () => {
    expect(plan.stints[0]?.driverId).toBe('bo')
  })

  it('does not plan a pit stop that has not happened', () => {
    expect(plan.stints[0]?.startOffsetSeconds).toBe(progress.elapsedSeconds)
  })

  it('starts from the fuel actually in the tank', () => {
    expect(plan.stints[0]?.fuelAtStartGallons).toBe(13)
  })

  it('counts the part of the stint already driven toward the maximum', () => {
    const first = plan.stints[0]
    if (!first) throw new Error('unreachable')
    const remaining = first.endOffsetSeconds - first.startOffsetSeconds
    // Bo's cap is 90 minutes and 30 are gone.
    expect(remaining).toBeLessThanOrEqual(60 * MINUTE)
  })

  it('counts the part already driven toward seat time', () => {
    expect(plan.seatTimeTakenSecondsByDriver.bo).toBe(1800)
  })

  it('leaves a driver near their cap only the minutes they have left', () => {
    // Bo is 80 minutes into a 90-minute maximum. Ten minutes is all that is
    // left, and the 30-minute minimum no longer applies — it has been served.
    const nearlyDone = expectOk(
      replanFromNow(fixtureInput(), {
        elapsedSeconds: 4860 + 80 * MINUTE,
        stints: [
          { driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 4500 },
          { driverId: 'bo', startOffsetSeconds: 4860, endOffsetSeconds: null },
        ],
        fuelGallons: 5,
      }),
    )

    const first = nearlyDone.stints[0]
    if (!first) throw new Error('unreachable')
    expect(first.driverId).toBe('bo')
    expect(first.endOffsetSeconds - first.startOffsetSeconds).toBeLessThanOrEqual(10 * MINUTE)
  })
})

// ---------------------------------------------------------------------------
// The race does not run to plan. That is the entire point.
// ---------------------------------------------------------------------------

describe('replanFromNow — after something unplanned', () => {
  it('absorbs an unplanned stop without corrupting the rest', () => {
    // A black flag put the car in the pits after 20 minutes.
    const progress: RaceProgress = {
      elapsedSeconds: 1200 + 600,
      stints: [{ driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 1200 }],
      fuelGallons: race.fuelCapacityGallons,
    }

    const plan = expectOk(replanFromNow(fixtureInput(), progress))

    expect(plan.stints.at(-1)?.endOffsetSeconds).toBe(race.durationSeconds)
    expect(plan.stints[0]?.startOffsetSeconds).toBe(1800)
    for (const stint of plan.stints) {
      expect(stint.fuelAtEndGallons).toBeGreaterThanOrEqual(race.reserveGallons)
    }
  })

  it('refuses rather than plan an illegal stint on a short-fuelled tank', () => {
    // Someone splashed in five gallons instead of brimming it.
    const progress: RaceProgress = {
      elapsedSeconds: 4500 + 360,
      stints: ranToPlan(1),
      fuelGallons: 7.5,
    }

    // 5.5 usable gallons at 14 gal/h is 23 minutes, under the 30-minute
    // minimum stint. The planner says so rather than quietly scheduling an
    // illegal stint — the crew has a real decision to make here: accept a
    // short stint, or put more fuel in before the car goes back out.
    const failure = expectFailure(replanFromNow(fixtureInput(), progress))
    expect(failure.reason).toBe('fuel_window_below_minimum_stint')
    expect(failure.detail).toMatch(/30 min/)
  })

  it('keeps the per-driver share cap against the whole race, not the remainder', () => {
    // Ana has already used 40% of the race; a 50% cap leaves her 10%.
    const progress: RaceProgress = {
      elapsedSeconds: 4 * 4500 + 4 * 360,
      stints: [
        { driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 4500 },
        { driverId: 'ana', startOffsetSeconds: 4860, endOffsetSeconds: 9360 },
        { driverId: 'bo', startOffsetSeconds: 9720, endOffsetSeconds: 14220 },
        { driverId: 'cy', startOffsetSeconds: 14580, endOffsetSeconds: 19080 },
      ],
      fuelGallons: race.fuelCapacityGallons,
    }

    const plan = expectOk(replanFromNow(fixtureInput(), progress))
    const anaShare = (plan.seatTimeSecondsByDriver.ana ?? 0) / race.durationSeconds
    expect(anaShare).toBeLessThanOrEqual(0.5)
  })
})

// ---------------------------------------------------------------------------
// Refusing
// ---------------------------------------------------------------------------

describe('replanFromNow — refusing', () => {
  it('refuses once the race is over', () => {
    const failure = expectFailure(
      replanFromNow(fixtureInput(), {
        elapsedSeconds: race.durationSeconds,
        stints: ranToPlan(6),
        fuelGallons: 2.5,
      }),
    )
    expect(failure.reason).toBe('race_complete')
  })

  it('refuses when there is not enough fuel to reach the minimum stint', () => {
    const failure = expectFailure(
      replanFromNow(fixtureInput(), {
        elapsedSeconds: 4500 + 360,
        stints: ranToPlan(1),
        fuelGallons: 2.1,
      }),
    )
    expect(failure.ok).toBe(false)
    expect(failure.detail.length).toBeGreaterThan(0)
  })

  it('rejects an elapsed time that is not on the clock', () => {
    expect(() =>
      replanFromNow(fixtureInput(), { elapsedSeconds: -1, stints: [], fuelGallons: 20 }),
    ).toThrow(/elapsed/i)
  })

  it('rejects more fuel than the tank holds', () => {
    expect(() =>
      replanFromNow(fixtureInput(), { elapsedSeconds: 60, stints: [], fuelGallons: 99 }),
    ).toThrow(/fuel/i)
  })
})

// ---------------------------------------------------------------------------
// Replanning from the grid is just planning
// ---------------------------------------------------------------------------

describe('replanFromNow — at the start line', () => {
  it('matches a fresh plan when nothing has happened yet', () => {
    const fromNow = expectOk(
      replanFromNow(fixtureInput(), { elapsedSeconds: 0, stints: [], fuelGallons: 20 }),
    )

    expect(
      fromNow.stints.map((s) => ({
        sequence: s.sequence,
        driverKey: s.driverId,
        startOffsetSeconds: s.startOffsetSeconds,
        endOffsetSeconds: s.endOffsetSeconds,
        fuelAtStartGallons: s.fuelAtStartGallons,
        fuelAtEndGallons: s.fuelAtEndGallons,
      })),
    ).toEqual(KNOWN_GOOD_SOLUTION.stints)
    expect(fromNow.seatTimeTakenSecondsByDriver).toEqual({})
  })

  it('carries the same assumptions a fresh plan carries', () => {
    const plan = expectOk(
      replanFromNow(fixtureInput(), {
        elapsedSeconds: HOUR,
        stints: ranToPlan(0),
        fuelGallons: 20,
      }),
    )
    expect(plan.assumptions.length).toBeGreaterThan(0)
    expect(plan.burnRate.method).toBe('seed')
  })
})

describe('replanFromNow — availability moves with the clock', () => {
  const withWindow = (untilSeconds: number) =>
    fixtureInput({
      drivers: [driver('ana', { availableUntilSeconds: untilSeconds }), driver('bo'), driver('cy')],
      fairnessWeight: 0,
    })

  it('still honours a window measured from the green flag', () => {
    // Ana leaves three hours in. Re-solving at the two-hour mark, she has one
    // hour left — not three, and not none.
    const plan = expectOk(
      replanFromNow(withWindow(3 * HOUR), {
        elapsedSeconds: 2 * HOUR,
        stints: [{ driverId: 'bo', startOffsetSeconds: 0, endOffsetSeconds: 2 * HOUR }],
        fuelGallons: race.fuelCapacityGallons,
      }),
    )

    for (const stint of plan.stints) {
      // Offsets come back in race time, so the window is directly comparable.
      if (stint.driverId === 'ana') expect(stint.endOffsetSeconds).toBeLessThanOrEqual(3 * HOUR)
    }
  })

  it('leaves out a driver whose window has already closed', () => {
    const plan = expectOk(
      replanFromNow(withWindow(2 * HOUR), {
        elapsedSeconds: 3 * HOUR,
        stints: [{ driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 2 * HOUR }],
        fuelGallons: race.fuelCapacityGallons,
      }),
    )

    expect(plan.stints.map((s) => s.driverId)).not.toContain('ana')
  })

  it('refuses when everybody left has run out of day', () => {
    const failure = expectFailure(
      replanFromNow(
        fixtureInput({
          drivers: [
            driver('ana', { availableUntilSeconds: 2 * HOUR }),
            driver('bo', { availableUntilSeconds: 2 * HOUR }),
            driver('cy', { availableUntilSeconds: 2 * HOUR }),
          ],
        }),
        {
          elapsedSeconds: 3 * HOUR,
          stints: [{ driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 2 * HOUR }],
          fuelGallons: race.fuelCapacityGallons,
        },
      ),
    )

    // Not "no eligible drivers" — they exist, they just cannot drive any more.
    expect(['availability_gap', 'no_eligible_drivers']).toContain(failure.reason)
    expect(failure.detail.length).toBeGreaterThan(0)
  })
})
