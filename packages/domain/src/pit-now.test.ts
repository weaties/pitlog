import { describe, expect, it } from 'vitest'
import type { BurnRateEstimate } from './burn-rate.js'
import { estimateBurnRate } from './burn-rate.js'
import { EIGHT_HOUR_RACE } from './fixtures/eight-hour-race.js'
import { evaluatePitNow } from './pit-now.js'
import type { RaceProgress } from './replan.js'
import { replanFromNow } from './replan.js'
import { parseSeriesRules } from './series-rules.js'
import type { PlannerDriver, StintPlanInput } from './stint-solver.js'

const MINUTE = 60

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

/** Bo went out after Ana's stint and has been on track for `minutes`. */
function midStint(minutes: number, fuelGallons?: number): RaceProgress {
  return {
    elapsedSeconds: 4860 + minutes * MINUTE,
    stints: [
      { driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 4500 },
      { driverId: 'bo', startOffsetSeconds: 4860, endOffsetSeconds: null },
    ],
    fuelGallons: fuelGallons ?? 20 - (minutes / 60) * race.burnRateGph,
  }
}

describe('evaluatePitNow — it is a what-if, not a decision', () => {
  it('does not touch the inputs it was handed', () => {
    const input = fixtureInput()
    const progress = midStint(30)
    const before = JSON.stringify({ input, progress })

    evaluatePitNow(input, progress)

    expect(JSON.stringify({ input, progress })).toBe(before)
  })

  it('reports the current plan unchanged as the stay-out case', () => {
    const input = fixtureInput()
    const progress = midStint(30)

    const comparison = evaluatePitNow(input, progress)
    expect(comparison.stayOut).toEqual(replanFromNow(input, progress))
  })
})

describe('evaluatePitNow — the delta, not just the new plan', () => {
  const comparison = evaluatePitNow(fixtureInput(), midStint(30))

  it('answers in one word', () => {
    expect(comparison.verdict).toBe('costs_a_stop')
  })

  it('counts the stop you are about to make', () => {
    // The pit-now plan describes the race *after* the stop, so its own stop
    // count is one short of what pitting actually costs. Getting this wrong
    // would report a free stop as free.
    if (!comparison.pitNow.ok || !comparison.stayOut.ok) throw new Error('expected both to solve')
    expect(comparison.delta?.stopCountDelta).toBe(
      1 + comparison.pitNow.plan.stopCount - comparison.stayOut.plan.stopCount,
    )
    expect(comparison.delta?.stopCountDelta).toBe(1)
  })

  it('says how much running is being thrown away', () => {
    if (!comparison.stayOut.ok) throw new Error('expected a stay-out plan')
    const wouldHaveRun =
      (comparison.stayOut.plan.stints[0]?.endOffsetSeconds ?? 0) -
      (comparison.stayOut.plan.stints[0]?.startOffsetSeconds ?? 0)

    expect(comparison.delta?.stintCutShortSeconds).toBe(wouldHaveRun)
    expect(comparison.delta?.stintCutShortSeconds).toBeGreaterThan(0)
  })

  it('says what is still in the tank', () => {
    expect(comparison.delta?.fuelAtStopGallons).toBeCloseTo(13, 9)
  })

  it('reports the fairness change, signed so that better is negative', () => {
    expect(typeof comparison.delta?.seatTimeSpreadDeltaSeconds).toBe('number')
  })
})

describe('evaluatePitNow — how the answer changes across a stint', () => {
  it('is free once the car is deep enough into the tank', () => {
    // From 63 minutes in, the stop has to happen before the next one either
    // way, so taking it under a yellow is the same stop for free.
    const comparison = evaluatePitNow(fixtureInput(), midStint(64))
    expect(comparison.verdict).toBe('free')
    expect(comparison.delta?.stopCountDelta).toBe(0)
  })

  it('saves a stop when staying out would force a pointless short stint', () => {
    // 74 minutes in there are three minutes of fuel left. Running them means
    // an extra stop for a three-minute stint that helps nobody.
    const comparison = evaluatePitNow(fixtureInput(), midStint(74))
    expect(comparison.verdict).toBe('saves_a_stop')
    expect(comparison.delta?.stopCountDelta).toBeLessThan(0)
  })

  it('only ever gets better as the tank empties', () => {
    // The property a crew relies on without being told: waiting longer never
    // turns a free stop back into an expensive one. A non-monotone answer
    // would mean the button is telling people to pit at random.
    const rank: Record<string, number> = { costs_a_stop: 0, free: 1, saves_a_stop: 2, forced: 3 }
    let previous = 0

    for (let minutes = 5; minutes <= 78; minutes++) {
      const verdict = evaluatePitNow(fixtureInput(), midStint(minutes)).verdict
      const current = rank[verdict]
      expect(current).toBeDefined()
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current ?? previous
    }

    expect(previous).toBe(rank.forced)
  })
})

describe('evaluatePitNow — when there is no choice', () => {
  it('says the stop is forced when staying out has no legal plan', () => {
    const rules = parseSeriesRules({
      schema_version: 1,
      series_key: 'testseries',
      display_name: 'Test Series',
      config_version: 1,
      pit: {
        min_stop_seconds: 60,
        engine_off_for_fueling: true,
        driver_in_car_during_fueling: false,
        driver_change_during_fueling: false,
        max_crew_over_wall: null,
      },
      fueling: {
        max_fuel_capacity_gallons: null,
        refuel_allowed_under_yellow: true,
        fuel_can_only: true,
        max_can_size_gallons: null,
      },
      driver: {
        min_stint_seconds: 30 * MINUTE,
        max_stint_seconds: 90 * MINUTE,
        max_consecutive_stint_seconds: 90 * MINUTE,
        min_rest_seconds: null,
        min_drivers_per_event: [{ min_race_hours: 0, drivers: 2 }],
        max_share_of_race: 1,
      },
    })

    // Bo has been in for the full 90 minutes the series allows. There is no
    // legal stint left for him, so the only question is who gets out of the car.
    const comparison = evaluatePitNow(fixtureInput({ rules }), midStint(90, 10))

    expect(comparison.stayOut.ok).toBe(false)
    expect(comparison.verdict).toBe('forced')
    expect(comparison.delta).toBeNull()
  })

  it('says plainly when pitting now leaves the rest of the race unsolvable', () => {
    // A splash of half a gallon instead of a brim: 4 minutes of fuel against a
    // 30-minute minimum stint.
    const comparison = evaluatePitNow(fixtureInput(), midStint(30), {
      fuelAfterStopGallons: 2.5,
    })

    expect(comparison.verdict).toBe('unsolvable')
    expect(comparison.pitNow.ok).toBe(false)
    if (comparison.pitNow.ok) throw new Error('unreachable')
    expect(comparison.pitNow.reason).toBe('fuel_window_below_minimum_stint')
    expect(comparison.delta).toBeNull()
  })

  it('reports no plan at all when neither option works', () => {
    const comparison = evaluatePitNow(fixtureInput(), {
      elapsedSeconds: race.durationSeconds,
      stints: [],
      fuelGallons: 20,
    })

    expect(comparison.verdict).toBe('no_plan')
    expect(comparison.delta).toBeNull()
  })
})

describe('evaluatePitNow — the stop itself', () => {
  it('brims the tank by default', () => {
    const comparison = evaluatePitNow(fixtureInput(), midStint(30))
    if (!comparison.pitNow.ok) throw new Error('expected a plan')
    expect(comparison.pitNow.plan.stints[0]?.fuelAtStartGallons).toBe(20)
  })

  it('honours a series minimum stop time', () => {
    const comparison = evaluatePitNow(fixtureInput({ pitStopSeconds: 60 }), midStint(30))
    if (!comparison.pitNow.ok) throw new Error('expected a plan')
    // The car goes back out one stop-length after now.
    expect(comparison.pitNow.plan.stints[0]?.startOffsetSeconds).toBe(4860 + 30 * MINUTE + 60)
    expect(comparison.stopSeconds).toBe(60)
  })

  it('takes the driver out of the car', () => {
    const comparison = evaluatePitNow(fixtureInput(), midStint(30))
    if (!comparison.pitNow.ok) throw new Error('expected a plan')
    // Whoever goes out next is chosen on seat time, not locked to whoever was
    // already strapped in.
    expect(comparison.pitNow.plan.stints[0]?.driverId).toBe('cy')
  })

  it('credits the driver with the part of the stint they actually ran', () => {
    const comparison = evaluatePitNow(fixtureInput(), midStint(30))
    if (!comparison.pitNow.ok) throw new Error('expected a plan')
    expect(comparison.pitNow.plan.seatTimeTakenSecondsByDriver.bo).toBe(30 * MINUTE)
  })
})

describe('evaluatePitNow — from the pit lane', () => {
  it('works when nobody is on track', () => {
    const comparison = evaluatePitNow(fixtureInput(), {
      elapsedSeconds: 4500,
      stints: [{ driverId: 'ana', startOffsetSeconds: 0, endOffsetSeconds: 4500 }],
      fuelGallons: 2.5,
    })

    expect(comparison.pitNow.ok).toBe(true)
  })
})
