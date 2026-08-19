import { describe, expect, it } from 'vitest'
import type { BurnRateEstimate } from './burn-rate.js'
import { estimateBurnRate } from './burn-rate.js'
import {
  EIGHT_HOUR_RACE,
  KNOWN_GOOD_SOLUTION,
  seatTimeSecondsByDriver,
} from './fixtures/eight-hour-race.js'
import type { SeriesRulesConfig } from './series-rules.js'
import { parseSeriesRules, RULE_FIELD_PATHS } from './series-rules.js'
import type { PlannerDriver, StintPlanInput } from './stint-solver.js'
import { CONSUMED_RULE_FIELDS, solveStintPlan, UNMODELLED_RULE_FIELDS } from './stint-solver.js'

const MINUTE = 60
const HOUR = 3600

/** A seeded estimate — the honest shape for a race that has not started. */
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

function rules(overrides: {
  pit?: Partial<SeriesRulesConfig['pit']>
  fueling?: Partial<SeriesRulesConfig['fueling']>
  driver?: Partial<SeriesRulesConfig['driver']>
}): SeriesRulesConfig {
  return parseSeriesRules({
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
      ...overrides.pit,
    },
    fueling: {
      max_fuel_capacity_gallons: null,
      refuel_allowed_under_yellow: true,
      fuel_can_only: true,
      max_can_size_gallons: null,
      ...overrides.fueling,
    },
    driver: {
      min_stint_seconds: 30 * MINUTE,
      max_stint_seconds: 2 * HOUR,
      max_consecutive_stint_seconds: 2 * HOUR,
      min_rest_seconds: null,
      min_drivers_per_event: [{ min_race_hours: 0, drivers: 2 }],
      max_share_of_race: 1,
      ...overrides.driver,
    },
  })
}

/** A plain 4-hour race with three interchangeable drivers. */
function baseInput(overrides: Partial<StintPlanInput> = {}): StintPlanInput {
  return {
    raceSeconds: 4 * HOUR,
    fuelCapacityGallons: 20,
    reserveGallons: 2,
    pitStopSeconds: 5 * MINUTE,
    burnRate: seeded(14),
    drivers: [driver('a'), driver('b'), driver('c')],
    rules: null,
    ...overrides,
  }
}

function expectOk(result: ReturnType<typeof solveStintPlan>) {
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}: ${result.detail}`)
  return result.plan
}

function expectFailure(result: ReturnType<typeof solveStintPlan>) {
  if (result.ok) throw new Error('expected the solver to refuse')
  return result
}

// ---------------------------------------------------------------------------
// The fixture race — SPEC §7. This is the acceptance test for #5.
// ---------------------------------------------------------------------------

describe('solveStintPlan — the fixture race', () => {
  const { race, drivers } = EIGHT_HOUR_RACE

  const plan = expectOk(
    solveStintPlan({
      raceSeconds: race.durationSeconds,
      fuelCapacityGallons: race.fuelCapacityGallons,
      reserveGallons: race.reserveGallons,
      pitStopSeconds: race.pitStopSeconds,
      burnRate: seeded(race.burnRateGph),
      drivers: drivers.map((d) =>
        driver(d.key, {
          minStintSeconds: d.minStintSeconds,
          maxStintSeconds: d.maxStintSeconds,
          burnRateFactor: d.burnRateFactor,
        }),
      ),
      rules: null,
    }),
  )

  it('reproduces the known-good stint boundaries exactly', () => {
    expect(
      plan.stints.map((s) => ({
        sequence: s.sequence,
        driverKey: s.driverId,
        startOffsetSeconds: s.startOffsetSeconds,
        endOffsetSeconds: s.endOffsetSeconds,
        fuelAtStartGallons: s.fuelAtStartGallons,
        fuelAtEndGallons: s.fuelAtEndGallons,
      })),
    ).toEqual(KNOWN_GOOD_SOLUTION.stints)
  })

  it('reproduces the known-good fill volumes exactly', () => {
    expect(
      plan.fills.map((f) => ({ afterStintSequence: f.afterStintSequence, gallons: f.gallons })),
    ).toEqual(
      KNOWN_GOOD_SOLUTION.fills.map((f) => ({
        afterStintSequence: f.afterStintSequence,
        gallons: f.gallons,
      })),
    )
  })

  it('splits seat time exactly evenly', () => {
    const expected = seatTimeSecondsByDriver(KNOWN_GOOD_SOLUTION)
    expect(plan.seatTimeSecondsByDriver).toEqual(Object.fromEntries(expected))
    expect(new Set(Object.values(plan.seatTimeSecondsByDriver)).size).toBe(1)
  })

  it('uses the fewest stops the fuel window and driver maximum allow', () => {
    // Five stints would be 91.2 min, over both the 90-min driver maximum and
    // the 77.1-min fuel window. Six is forced.
    expect(plan.stints).toHaveLength(6)
    expect(plan.stopCount).toBe(5)
  })

  it('fills the race to the second', () => {
    expect(plan.stints[0]?.startOffsetSeconds).toBe(0)
    expect(plan.stints.at(-1)?.endOffsetSeconds).toBe(race.durationSeconds)
  })
})

// ---------------------------------------------------------------------------
// Hard constraints
// ---------------------------------------------------------------------------

describe('solveStintPlan — fuel', () => {
  it('never plans the tank below the reserve', () => {
    const plan = expectOk(solveStintPlan(baseInput({ raceSeconds: 10 * HOUR })))
    for (const stint of plan.stints) {
      expect(stint.fuelAtEndGallons).toBeGreaterThanOrEqual(2)
    }
  })

  it('brims the tank at every stop', () => {
    const plan = expectOk(solveStintPlan(baseInput()))
    for (const stint of plan.stints.slice(1)) {
      expect(stint.fuelAtStartGallons).toBe(20)
    }
    for (const [index, fill] of plan.fills.entries()) {
      const before = plan.stints[index]
      if (!before) throw new Error('unreachable')
      expect(fill.gallons).toBeCloseTo(20 - before.fuelAtEndGallons, 9)
    }
  })

  it('adds stops when the fuel window is tighter', () => {
    const roomy = expectOk(solveStintPlan(baseInput({ fuelCapacityGallons: 20 })))
    const tight = expectOk(solveStintPlan(baseInput({ fuelCapacityGallons: 10 })))
    expect(tight.stopCount).toBeGreaterThan(roomy.stopCount)
  })

  it('respects a per-driver burn factor when sizing the fuel window', () => {
    // A thirsty driver empties the tank sooner, so nobody can run a stint
    // longer than *their* window allows.
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 8 * HOUR,
          drivers: [driver('a', { burnRateFactor: 1.5 }), driver('b'), driver('c')],
        }),
      ),
    )

    for (const stint of plan.stints) {
      const length = stint.endOffsetSeconds - stint.startOffsetSeconds
      const burned = (length / HOUR) * stint.burnGph
      expect(stint.fuelAtStartGallons - burned).toBeGreaterThanOrEqual(2 - 1e-9)
    }
  })

  it('starts from the fuel actually in the tank', () => {
    const plan = expectOk(solveStintPlan(baseInput({ startFuelGallons: 10 })))
    expect(plan.stints[0]?.fuelAtStartGallons).toBe(10)
  })
})

describe('solveStintPlan — driver seat-time bounds', () => {
  it('never plans a stint below the driver minimum or above the maximum', () => {
    const plan = expectOk(solveStintPlan(baseInput({ raceSeconds: 6 * HOUR })))
    for (const stint of plan.stints) {
      const length = stint.endOffsetSeconds - stint.startOffsetSeconds
      expect(length).toBeGreaterThanOrEqual(30 * MINUTE)
      expect(length).toBeLessThanOrEqual(90 * MINUTE)
    }
  })

  it('shortens only the stints of the driver who is capped', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          fairnessWeight: 0,
          drivers: [driver('a', { maxStintSeconds: 50 * MINUTE }), driver('b'), driver('c')],
        }),
      ),
    )

    for (const stint of plan.stints) {
      const length = stint.endOffsetSeconds - stint.startOffsetSeconds
      if (stint.driverId === 'a') expect(length).toBeLessThanOrEqual(50 * MINUTE)
    }
    // The surplus went to the drivers with headroom rather than buying a stop.
    expect(plan.stopCount).toBe(3)
  })

  it('skips a driver who cannot drive', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({ drivers: [driver('a'), driver('b'), driver('crewonly', { canDrive: false })] }),
      ),
    )
    expect(plan.stints.map((s) => s.driverId)).not.toContain('crewonly')
    expect(plan.seatTimeSecondsByDriver.crewonly).toBeUndefined()
  })

  it('takes the tighter of the driver row and the rule config', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 6 * HOUR,
          rules: rules({ driver: { max_stint_seconds: 45 * MINUTE } }),
        }),
      ),
    )
    for (const stint of plan.stints) {
      expect(stint.endOffsetSeconds - stint.startOffsetSeconds).toBeLessThanOrEqual(45 * MINUTE)
    }
  })
})

// ---------------------------------------------------------------------------
// The objective chain — AGENTS.md → Decisions
// ---------------------------------------------------------------------------

describe('solveStintPlan — the objective chain', () => {
  it('gives the next stint to whoever has driven least, roster order breaking ties', () => {
    const plan = expectOk(solveStintPlan(baseInput({ raceSeconds: 6 * HOUR })))
    expect(plan.stints.slice(0, 3).map((s) => s.driverId)).toEqual(['a', 'b', 'c'])
  })

  it('never runs the same driver twice in a row when someone else is available', () => {
    const plan = expectOk(solveStintPlan(baseInput({ raceSeconds: 8 * HOUR })))
    for (let i = 1; i < plan.stints.length; i++) {
      expect(plan.stints[i]?.driverId).not.toBe(plan.stints[i - 1]?.driverId)
    }
  })

  it('prefers equal stints when nothing forces otherwise', () => {
    const plan = expectOk(solveStintPlan(baseInput({ raceSeconds: 6 * HOUR })))
    const lengths = new Set(plan.stints.map((s) => s.endOffsetSeconds - s.startOffsetSeconds))
    expect(lengths.size).toBe(1)
  })

  it('is deterministic — the same input yields byte-identical plans', () => {
    const a = expectOk(solveStintPlan(baseInput({ raceSeconds: 7 * HOUR })))
    const b = expectOk(solveStintPlan(baseInput({ raceSeconds: 7 * HOUR })))
    expect(a).toEqual(b)
  })

  it('does not depend on the order drivers arrive in beyond the documented tiebreak', () => {
    const forward = expectOk(solveStintPlan(baseInput({ raceSeconds: 6 * HOUR })))
    const reversed = expectOk(
      solveStintPlan(
        baseInput({ raceSeconds: 6 * HOUR, drivers: [driver('c'), driver('b'), driver('a')] }),
      ),
    )
    // Same shape, same fairness; only the roster-order tiebreak differs.
    expect(reversed.stints.map((s) => s.driverId)).toEqual(['c', 'b', 'a', 'c', 'b', 'a'])
    expect(Object.values(reversed.seatTimeSecondsByDriver).sort()).toEqual(
      Object.values(forward.seatTimeSecondsByDriver).sort(),
    )
  })
})

describe('solveStintPlan — fairness weight', () => {
  it('accepts an uneven split when fairness is weighted at zero', () => {
    // 5 stints over 2 drivers cannot be even.
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 8.5 * HOUR,
          drivers: [driver('a'), driver('b')],
          fairnessWeight: 0,
        }),
      ),
    )
    expect(plan.stints.length % 2).toBe(1)
  })

  it('buys another stint rather than an uneven split when fairness is absolute', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 8.5 * HOUR,
          drivers: [driver('a'), driver('b')],
          fairnessWeight: 1,
        }),
      ),
    )
    const seat = Object.values(plan.seatTimeSecondsByDriver)
    expect(Math.max(...seat) - Math.min(...seat)).toBe(0)
  })

  it('reports the spread it settled for', () => {
    const plan = expectOk(solveStintPlan(baseInput({ raceSeconds: 6 * HOUR })))
    expect(plan.seatTimeSpreadSeconds).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// #6 — rule configs consumed as data
// ---------------------------------------------------------------------------

describe('solveStintPlan — rule configs are data', () => {
  it('lengthens the stop to the series minimum', () => {
    const quick = expectOk(solveStintPlan(baseInput({ pitStopSeconds: 60, rules: rules({}) })))
    const slow = expectOk(
      solveStintPlan(
        baseInput({ pitStopSeconds: 60, rules: rules({ pit: { min_stop_seconds: 600 } }) }),
      ),
    )
    expect(slow.pitStopSeconds).toBe(600)
    expect(quick.pitStopSeconds).toBe(60)
  })

  it('honours a series cap on fuel capacity', () => {
    const uncapped = expectOk(
      solveStintPlan(baseInput({ fuelCapacityGallons: 20, rules: rules({}) })),
    )
    const capped = expectOk(
      solveStintPlan(
        baseInput({
          fuelCapacityGallons: 20,
          rules: rules({ fueling: { max_fuel_capacity_gallons: 12 } }),
        }),
      ),
    )

    expect(capped.fuelCapacityGallons).toBe(12)
    for (const stint of capped.stints) expect(stint.fuelAtStartGallons).toBeLessThanOrEqual(12)
    // A smaller tank is a shorter fuel window, which costs stops.
    expect(capped.stopCount).toBeGreaterThan(uncapped.stopCount)
  })

  it('refuses when a series fuel cap makes the minimum stint unreachable', () => {
    // 8 gal less a 2 gal reserve is 26 minutes at 14 gal/h — the car cannot
    // reach the 30-minute minimum stint before it runs dry.
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          fuelCapacityGallons: 20,
          rules: rules({ fueling: { max_fuel_capacity_gallons: 8 } }),
        }),
      ),
    )
    expect(failure.reason).toBe('fuel_window_below_minimum_stint')
    expect(failure.detail).toMatch(/reserve/)
  })

  it('refuses when the roster is smaller than the series minimum', () => {
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          drivers: [driver('a')],
          rules: rules({ driver: { min_drivers_per_event: [{ min_race_hours: 0, drivers: 2 }] } }),
        }),
      ),
    )
    expect(failure.reason).toBe('insufficient_drivers_for_rules')
    expect(failure.detail).toMatch(/2/)
  })

  it('refuses when the per-driver share cap cannot cover the race', () => {
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          drivers: [driver('a'), driver('b'), driver('c')],
          rules: rules({ driver: { max_share_of_race: 0.3 } }),
        }),
      ),
    )
    expect(failure.reason).toBe('share_cap_unsatisfiable')
  })

  it('enforces the consecutive-driving cap', () => {
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          raceSeconds: 3 * HOUR,
          drivers: [driver('a')],
          rules: rules({
            driver: {
              min_drivers_per_event: [{ min_race_hours: 0, drivers: 1 }],
              max_consecutive_stint_seconds: HOUR,
            },
          }),
        }),
      ),
    )
    expect(failure.reason).toBe('stint_bounds_unsatisfiable')
  })

  it('produces an identical plan for two configs differing only in their series key', () => {
    // The behavioural form of "no switch on series_key": the key is an
    // identifier, and nothing about the plan may depend on which one it is.
    const lemonsish = expectOk(solveStintPlan(baseInput({ rules: rules({}) })))
    const champcarish = expectOk(
      solveStintPlan(
        baseInput({
          rules: { ...rules({}), series_key: 'otherseries', display_name: 'Other Series' },
        }),
      ),
    )

    expect(champcarish.stints).toEqual(lemonsish.stints)
    expect(champcarish.fills).toEqual(lemonsish.fills)
    expect(champcarish.pitStopSeconds).toBe(lemonsish.pitStopSeconds)
  })

  it('classifies every field in the rule schema as consumed or explicitly unmodelled', () => {
    // The guard behind #6's "adding a rule field requires no solver change
    // beyond reading it": a new field cannot be silently ignored, because this
    // test fails until someone decides which list it belongs in.
    const classified = [...CONSUMED_RULE_FIELDS, ...UNMODELLED_RULE_FIELDS].sort()
    expect(classified).toEqual([...RULE_FIELD_PATHS].sort())
    expect(new Set(classified).size).toBe(classified.length)
  })

  it('reports the rule fields it did not model, so the UI can say so', () => {
    const plan = expectOk(solveStintPlan(baseInput({ rules: rules({}) })))
    expect(plan.ruleConfig?.unmodelledFields).toEqual([...UNMODELLED_RULE_FIELDS])
  })

  it('reports the verification status and unverified fields of the config it used', () => {
    const plan = expectOk(solveStintPlan(baseInput({ rules: rules({}) })))
    expect(plan.ruleConfig?.seriesKey).toBe('testseries')
    expect(plan.ruleConfig?.verificationStatus).toBe('UNVERIFIED')
    expect(plan.ruleConfig?.unverifiedFields.length).toBeGreaterThan(0)
  })

  it('says plainly when it planned with no rule config at all', () => {
    const plan = expectOk(solveStintPlan(baseInput({ rules: null })))
    expect(plan.ruleConfig).toBeNull()
    expect(plan.assumptions.map((a) => a.code)).toContain('no_rule_config')
  })
})

// ---------------------------------------------------------------------------
// Assumptions travel with the plan — SPEC §5.1
// ---------------------------------------------------------------------------

describe('solveStintPlan — assumptions', () => {
  it('carries the burn-rate assumptions through to the plan', () => {
    const plan = expectOk(solveStintPlan(baseInput()))
    expect(plan.burnRate.method).toBe('seed')
    expect(plan.assumptions.map((a) => a.code)).toContain('seeded_no_data')
  })

  it('is never a bare schedule — there is always something to show alongside it', () => {
    const plan = expectOk(solveStintPlan(baseInput({ rules: rules({}) })))
    expect(plan.assumptions.length).toBeGreaterThan(0)
    for (const assumption of plan.assumptions) expect(assumption.detail.length).toBeGreaterThan(0)
  })

  it('flags a plan built on an unverified config', () => {
    const plan = expectOk(solveStintPlan(baseInput({ rules: rules({}) })))
    expect(plan.assumptions.map((a) => a.code)).toContain('unverified_rule_config')
  })
})

// ---------------------------------------------------------------------------
// Diagnosable failure, never a silently degraded plan
// ---------------------------------------------------------------------------

describe('solveStintPlan — refusing', () => {
  it('refuses without an eligible driver', () => {
    const failure = expectFailure(
      solveStintPlan(baseInput({ drivers: [driver('a', { canDrive: false })] })),
    )
    expect(failure.reason).toBe('no_eligible_drivers')
  })

  it('refuses when the reserve leaves no usable fuel', () => {
    const failure = expectFailure(
      solveStintPlan(baseInput({ fuelCapacityGallons: 2, reserveGallons: 2 })),
    )
    expect(failure.reason).toBe('no_usable_fuel')
  })

  it('refuses when the race is shorter than one minimum stint', () => {
    const failure = expectFailure(
      solveStintPlan(baseInput({ raceSeconds: 10 * MINUTE, drivers: [driver('a'), driver('b')] })),
    )
    expect(failure.reason).toBe('stint_bounds_unsatisfiable')
  })

  it('explains itself in prose as well as a code', () => {
    const failure = expectFailure(solveStintPlan(baseInput({ drivers: [] })))
    expect(failure.detail.length).toBeGreaterThan(0)
    expect(failure.reason).toBe('no_eligible_drivers')
  })

  it('never returns a partial plan alongside a failure', () => {
    const failure = expectFailure(solveStintPlan(baseInput({ drivers: [] })))
    expect('plan' in failure).toBe(false)
  })
})

describe('solveStintPlan — input validation', () => {
  it('rejects a non-positive race length', () => {
    expect(() => solveStintPlan(baseInput({ raceSeconds: 0 }))).toThrow(/race/i)
  })

  it('rejects a reserve larger than the tank', () => {
    expect(() => solveStintPlan(baseInput({ reserveGallons: 30 }))).toThrow(/reserve/i)
  })

  it('rejects a fairness weight outside 0..1', () => {
    expect(() => solveStintPlan(baseInput({ fairnessWeight: 1.5 }))).toThrow(/fairness/i)
  })

  it('rejects a negative pit stop', () => {
    expect(() => solveStintPlan(baseInput({ pitStopSeconds: -1 }))).toThrow(/pit/i)
  })
})

// ---------------------------------------------------------------------------
// Rules the real rulebooks turned out to contain — see config/series/*.yaml
// ---------------------------------------------------------------------------

describe('solveStintPlan — the rest requirement', () => {
  /** Lucky Dog and ChampCar both require 60 minutes out of the car. */
  const withRest = rules({ driver: { min_rest_seconds: 3600, max_stint_seconds: 2 * HOUR } })

  it('never sends a driver back out before they have rested', () => {
    const plan = expectOk(
      solveStintPlan(baseInput({ raceSeconds: 8 * HOUR, rules: withRest, fairnessWeight: 0 })),
    )

    const lastEnd = new Map<string, number>()
    for (const stint of plan.stints) {
      const previous = lastEnd.get(stint.driverId)
      if (previous !== undefined) {
        expect(stint.startOffsetSeconds - previous).toBeGreaterThanOrEqual(3600)
      }
      lastEnd.set(stint.driverId, stint.endOffsetSeconds)
    }
  })

  it('refuses when a roster is too small to rest and still cover the race', () => {
    // Two drivers on a tank that only lasts 40 minutes cannot alternate: each
    // would be back in the car twenty minutes early.
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          raceSeconds: 6 * HOUR,
          fuelCapacityGallons: 11,
          drivers: [driver('a'), driver('b')],
          rules: withRest,
        }),
      ),
    )

    expect(failure.reason).toBe('stint_bounds_unsatisfiable')
  })

  it('is untroubled by a series that asks for no rest', () => {
    // 24 Hours of Lemons imposes none, so the same roster is fine.
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 6 * HOUR,
          fuelCapacityGallons: 11,
          drivers: [driver('a'), driver('b')],
          rules: rules({ driver: { min_rest_seconds: null } }),
        }),
      ),
    )

    expect(plan.stints.length).toBeGreaterThan(2)
  })
})

describe('solveStintPlan — driver counts are a function of race length', () => {
  /** ChampCar's actual tiers: 2 up to 8 h, 3 from 9, 4 from 17. */
  const champcarish = rules({
    driver: {
      min_drivers_per_event: [
        { min_race_hours: 0, drivers: 2 },
        { min_race_hours: 9, drivers: 3 },
        { min_race_hours: 17, drivers: 4 },
      ],
    },
  })

  it('lets two drivers take an eight-hour race', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 8 * HOUR,
          drivers: [driver('a'), driver('b')],
          rules: champcarish,
        }),
      ),
    )
    expect(plan.stints.length).toBeGreaterThan(0)
  })

  it('refuses the same two drivers a twelve-hour race', () => {
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          raceSeconds: 12 * HOUR,
          drivers: [driver('a'), driver('b')],
          rules: champcarish,
        }),
      ),
    )

    expect(failure.reason).toBe('insufficient_drivers_for_rules')
    // The message names the race length, because "you need 3" is not actionable
    // without saying why it changed.
    expect(failure.detail).toMatch(/12\.0 h/)
    expect(failure.detail).toMatch(/3 drivers/)
  })
})

// ---------------------------------------------------------------------------
// #57 — when a driver can actually be in the car
// ---------------------------------------------------------------------------

describe('solveStintPlan — availability windows', () => {
  it('never plans a driver past the time they have to leave', () => {
    // "I need to be done for the day by 1pm", three hours into an eight-hour
    // race.
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 8 * HOUR,
          fairnessWeight: 0,
          drivers: [driver('dan', { availableUntilSeconds: 3 * HOUR }), driver('bo'), driver('cy')],
        }),
      ),
    )

    for (const stint of plan.stints) {
      if (stint.driverId === 'dan') expect(stint.endOffsetSeconds).toBeLessThanOrEqual(3 * HOUR)
    }
    expect(plan.stints.some((s) => s.driverId === 'dan')).toBe(true)
  })

  it('refuses when nobody can cover part of the race, and says which part', () => {
    // A refusal the crew cannot act on is barely better than a wrong plan.
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          raceSeconds: 8 * HOUR,
          drivers: [
            driver('dan', { availableUntilSeconds: 3 * HOUR }),
            driver('bo', { availableUntilSeconds: 3 * HOUR }),
          ],
        }),
      ),
    )

    expect(failure.reason).toBe('availability_gap')
    expect(failure.detail).toMatch(/3h 00m/)
    expect(failure.detail).toMatch(/8h 00m/)
  })

  it('is happy with a clean hand-over and no overlap', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 8 * HOUR,
          fairnessWeight: 0,
          drivers: [
            driver('morning', { availableUntilSeconds: 4 * HOUR }),
            driver('afternoon', { availableFromSeconds: 4 * HOUR }),
          ],
        }),
      ),
    )

    for (const stint of plan.stints) {
      if (stint.driverId === 'morning') expect(stint.endOffsetSeconds).toBeLessThanOrEqual(4 * HOUR)
      if (stint.driverId === 'afternoon') {
        expect(stint.startOffsetSeconds).toBeGreaterThanOrEqual(4 * HOUR)
      }
    }
  })

  it('backtracks where a greedy pass would strand a later stint', () => {
    // Greedy hands stint 1 to whoever has driven least, which early on is
    // everyone. Give it the driver who is about to leave and the last stint has
    // nobody legal — even though a legal whole-plan assignment exists. This is
    // the case the old assignment could not solve.
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 4 * HOUR,
          fairnessWeight: 0,
          drivers: [driver('leaves-early', { availableUntilSeconds: 2 * HOUR }), driver('all-day')],
        }),
      ),
    )

    const last = plan.stints.at(-1)
    expect(last?.driverId).toBe('all-day')
    expect(plan.stints.at(-1)?.endOffsetSeconds).toBe(4 * HOUR)
  })

  it('does not report a short window as unfairness', () => {
    // Fairness has to stop fighting a constraint it cannot change. At full
    // fairness weight, a plan must still exist when somebody can only do part
    // of the day.
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 8 * HOUR,
          fairnessWeight: 1,
          drivers: [
            driver('half-day', { availableUntilSeconds: 4 * HOUR }),
            driver('bo'),
            driver('cy'),
          ],
        }),
      ),
    )

    const halfDay = plan.seatTimeSecondsByDriver['half-day'] ?? 0
    const bo = plan.seatTimeSecondsByDriver.bo ?? 0
    // They take less, and that is correct rather than unfair.
    expect(halfDay).toBeLessThan(bo)
  })
})

describe('solveStintPlan — pinned stints', () => {
  it('gives a pinned driver the stint they claimed', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 6 * HOUR,
          fairnessWeight: 0,
          drivers: [driver('a'), driver('b'), driver('starter', { pinnedSequence: 1 })],
        }),
      ),
    )

    expect(plan.stints[0]?.driverId).toBe('starter')
  })

  it('does not give a pinned driver any other stint', () => {
    const plan = expectOk(
      solveStintPlan(
        baseInput({
          raceSeconds: 6 * HOUR,
          fairnessWeight: 0,
          drivers: [driver('a'), driver('b'), driver('starter', { pinnedSequence: 1 })],
        }),
      ),
    )

    expect(plan.stints.filter((s) => s.driverId === 'starter')).toHaveLength(1)
  })

  it('refuses when two drivers claim the same stint', () => {
    const failure = expectFailure(
      solveStintPlan(
        baseInput({
          drivers: [driver('a', { pinnedSequence: 1 }), driver('b', { pinnedSequence: 1 })],
        }),
      ),
    )

    expect(failure.reason).toBe('conflicting_pins')
    expect(failure.detail).toMatch(/stint 1/)
  })
})
