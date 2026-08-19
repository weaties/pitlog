/**
 * The stint & fuel planner — SPEC §5.1, and the only hard part of M1 (§9).
 *
 * Framework-free: no HTTP, no database, no React. The API hands it numbers and
 * a rule config; it hands back a schedule and the reasons to doubt it.
 *
 * **The objective is lexicographic, not a weighted score** (AGENTS.md →
 * Decisions). Plans are compared on one term at a time, moving to the next only
 * on an exact tie:
 *
 *   1. feasibility  2. fewest stops  3. smallest seat-time spread
 *   4. smallest stint-length variance  5. roster order
 *
 * That is why the search below is a scan upward from the smallest stint count
 * rather than an optimiser: term 2 dominates everything after it, so the first
 * feasible stint count *is* the answer, and terms 3-5 only choose between plans
 * of that size. A weighted sum would land somewhere near this by accident of
 * the weights, and "reproduces the known-good solution exactly" would stop
 * being a testable claim.
 *
 * **Rule configs are data** (SPEC §5.1, #6). Nothing here branches on
 * `series_key`; a series differs from another only in the numbers it supplies.
 * `CONSUMED_RULE_FIELDS` and `UNMODELLED_RULE_FIELDS` between them must cover
 * every field in the schema, so a field added later cannot be silently ignored
 * — a test enforces that.
 *
 * Every shipped rule config is UNVERIFIED (SPEC §3), so a plan carries the
 * config's verification state with it. #7 renders it. Never show a schedule
 * from this module as though it were authoritative.
 */

import type { BurnRateEstimate } from './burn-rate.js'
import type { SeriesRulesConfig } from './series-rules.js'
import { minDriversForRace } from './series-rules.js'
import type { PlanAssumption, PlanRuleConfig } from './stint-rules.js'
import {
  buildAssumptions,
  describeRules,
  effectiveFuelCapacityGallons,
  effectivePitStopSeconds,
} from './stint-rules.js'
import {
  assignDrivers,
  distributeSeconds,
  stintBounds,
  withinConsecutiveCap,
  withinRestRequirement,
} from './stint-schedule.js'

export type { PlanAssumption, PlanRuleConfig } from './stint-rules.js'
export {
  CONSUMED_RULE_FIELDS,
  effectiveFuelCapacityGallons,
  effectivePitStopSeconds,
  UNMODELLED_RULE_FIELDS,
} from './stint-rules.js'

/** A runaway guard. A 24-hour race on 30-minute stints is 48. */
const MAX_STINTS = 200

const HOUR_SECONDS = 3600

export interface PlannerDriver {
  id: string
  /** False for crew who share costs but never take a seat. */
  canDrive: boolean
  minStintSeconds: number | null
  maxStintSeconds: number | null
  /** Multiplier on the team burn rate — see `estimateDriverBurnRates`. */
  burnRateFactor: number
}

export interface StintPlanInput {
  raceSeconds: number
  fuelCapacityGallons: number
  /** Fuel the plan refuses to dip below. */
  reserveGallons: number
  /** Modelled stationary time per stop, including the driver change. */
  pitStopSeconds: number
  /** An estimate, never a bare number — SPEC §5.1. */
  burnRate: BurnRateEstimate
  drivers: readonly PlannerDriver[]
  rules: SeriesRulesConfig | null
  /**
   * How hard to insist on an even split, 0..1.
   *
   * SPEC §5.1 names "fairness weight" as an input without defining it. The v1
   * reading is a tolerance: the seat-time spread may not exceed
   * `(1 - fairnessWeight)` of the average seat time. At 1 the split must be
   * exact, at 0 anything goes. It cannot trade against stop count, which
   * outranks it in the objective chain.
   */
  fairnessWeight?: number
  /** Defaults to a full tank. Set by live replanning. */
  startFuelGallons?: number
  /** Set by live replanning; absent when planning a race from the grid. */
  fromNow?: PlanFromNow
}

/**
 * What the solver needs to know about a race already in progress.
 *
 * Held in one object rather than four loose fields so that "this is a replan"
 * is a single visible fact at the call site, and so a future field cannot be
 * forgotten at one of them.
 */
export interface PlanFromNow {
  /**
   * Seat time each driver has already taken. Fairness is measured across the
   * whole race, so a driver who has done two stints is behind on nothing.
   */
  priorSeatTimeSeconds: Readonly<Record<string, number>>
  /** The whole race, which is what the per-driver share cap is a share of. */
  fullRaceSeconds: number
  /** The driver already on track, who cannot be swapped out from the pit wall. */
  lockedFirstDriverId: string | null
  /** How long they have already been in the car this stint. */
  firstStintElapsedSeconds: number
}

export interface PlannedStint {
  sequence: number
  driverId: string
  startOffsetSeconds: number
  endOffsetSeconds: number
  fuelAtStartGallons: number
  fuelAtEndGallons: number
  /** The rate used for this stint: team rate × this driver's factor. */
  burnGph: number
}

export interface PlannedFill {
  /** The fill happens in the stop after this stint ends. */
  afterStintSequence: number
  gallons: number
}

export interface StintPlan {
  stints: PlannedStint[]
  fills: PlannedFill[]
  stopCount: number
  /** Across the whole race: already taken plus newly planned. */
  seatTimeSecondsByDriver: Record<string, number>
  /** The part of that already driven. Empty when planning from the grid. */
  seatTimeTakenSecondsByDriver: Record<string, number>
  seatTimeSpreadSeconds: number
  /** After applying any series minimum. */
  pitStopSeconds: number
  /** After applying any series cap. */
  fuelCapacityGallons: number
  burnRate: BurnRateEstimate
  ruleConfig: PlanRuleConfig | null
  /** Never empty. SPEC §5.1 forbids a bare schedule. */
  assumptions: PlanAssumption[]
}

export type StintPlanFailureReason =
  | 'no_eligible_drivers'
  | 'no_usable_fuel'
  | 'insufficient_drivers_for_rules'
  | 'share_cap_unsatisfiable'
  | 'stint_bounds_unsatisfiable'
  | 'fuel_window_below_minimum_stint'
  | 'race_complete'

export type StintPlanResult =
  | { ok: true; plan: StintPlan }
  | { ok: false; reason: StintPlanFailureReason; detail: string }

/**
 * Solve a stint schedule for a whole race.
 *
 * Returns a diagnosable refusal rather than a degraded plan: a schedule that
 * quietly breaks a driver minimum or runs the tank dry is worse than no
 * schedule, because it looks like an answer.
 */
export function solveStintPlan(input: StintPlanInput): StintPlanResult {
  validate(input)

  const rules = input.rules
  const fairnessWeight = input.fairnessWeight ?? 0.5

  const pitStopSeconds = effectivePitStopSeconds(input.pitStopSeconds, rules)
  const fuelCapacityGallons = effectiveFuelCapacityGallons(input.fuelCapacityGallons, rules)
  const startFuelGallons = Math.min(
    input.startFuelGallons ?? fuelCapacityGallons,
    fuelCapacityGallons,
  )

  const eligible = input.drivers.filter((d) => d.canDrive)
  if (eligible.length === 0) {
    return fail('no_eligible_drivers', 'No driver on the roster is marked as able to drive.')
  }

  if (fuelCapacityGallons - input.reserveGallons <= 0) {
    return fail(
      'no_usable_fuel',
      `The reserve of ${input.reserveGallons} gal leaves nothing usable in a ${fuelCapacityGallons} gal tank.`,
    )
  }

  // The requirement is a function of race length in all three shipped series,
  // so it is read against this race rather than taken as a constant.
  const requiredDrivers = rules ? minDriversForRace(rules, input.raceSeconds) : 1
  if (eligible.length < requiredDrivers) {
    return fail(
      'insufficient_drivers_for_rules',
      `A ${(input.raceSeconds / 3600).toFixed(1)} h race in this series requires ${requiredDrivers} drivers; ${eligible.length} on the roster can drive.`,
    )
  }

  const shareCap = rules?.driver.max_share_of_race ?? 1
  if (shareCap * eligible.length < 1) {
    return fail(
      'share_cap_unsatisfiable',
      `${eligible.length} drivers capped at ${shareCap} of the race each cannot cover it. More drivers are needed.`,
    )
  }

  const probe: ScheduleContext = {
    stintCount: 1,
    driveSeconds: input.raceSeconds,
    eligible,
    rules,
    shareCap,
    fairnessWeight,
    pitStopSeconds,
    fuelCapacityGallons,
    startFuelGallons,
    raceSeconds: input.raceSeconds,
    reserveGallons: input.reserveGallons,
    burnRateGph: input.burnRate.gph,
    fromNow: input.fromNow ?? null,
  }

  // A first stint that runs the tank to reserve before reaching the shortest
  // legal stint length makes every stint count unsatisfiable. Worth its own
  // reason: the generic "no stint count works" would send a crew looking at the
  // roster when the answer is in the fuel churn.
  const openingBounds = eligible.map((driver) => stintBounds(probe, driver, true))
  if (openingBounds.every((b) => b.min > b.max)) {
    const bestWindow = Math.max(...openingBounds.map((b) => b.max))
    const shortest = Math.min(...openingBounds.map((b) => b.min))
    return fail(
      'fuel_window_below_minimum_stint',
      `${startFuelGallons} gal above a ${input.reserveGallons} gal reserve is ${(bestWindow / 60).toFixed(0)} min of running, but the shortest stint allowed is ${(shortest / 60).toFixed(0)} min.`,
    )
  }

  for (let stintCount = 1; stintCount <= MAX_STINTS; stintCount++) {
    const driveSeconds = input.raceSeconds - pitStopSeconds * (stintCount - 1)
    if (driveSeconds <= 0) break

    const attempt = tryStintCount({
      stintCount,
      driveSeconds,
      eligible,
      rules,
      shareCap,
      fairnessWeight,
      pitStopSeconds,
      fuelCapacityGallons,
      startFuelGallons,
      raceSeconds: input.raceSeconds,
      reserveGallons: input.reserveGallons,
      burnRateGph: input.burnRate.gph,
      fromNow: input.fromNow ?? null,
    })

    if (attempt) {
      return {
        ok: true,
        plan: {
          ...attempt,
          pitStopSeconds,
          fuelCapacityGallons,
          burnRate: input.burnRate,
          ruleConfig: describeRules(rules),
          assumptions: buildAssumptions(input.burnRate, rules),
        },
      }
    }
  }

  return fail(
    'stint_bounds_unsatisfiable',
    'No stint count satisfies the driver minimums and maximums, the consecutive-driving cap, and the fuel window at once.',
  )
}

/**
 * Everything one candidate schedule needs, after the series rules have been
 * folded into plain numbers. Shared with `stint-schedule.ts`.
 */
export interface ScheduleContext {
  stintCount: number
  driveSeconds: number
  eligible: readonly PlannerDriver[]
  rules: SeriesRulesConfig | null
  shareCap: number
  fairnessWeight: number
  pitStopSeconds: number
  fuelCapacityGallons: number
  startFuelGallons: number
  raceSeconds: number
  reserveGallons: number
  burnRateGph: number
  fromNow: PlanFromNow | null
}

type Attempt = Pick<
  StintPlan,
  | 'stints'
  | 'fills'
  | 'stopCount'
  | 'seatTimeSecondsByDriver'
  | 'seatTimeTakenSecondsByDriver'
  | 'seatTimeSpreadSeconds'
>

/** Build the best plan for exactly this many stints, or null if there isn't one. */
function tryStintCount(a: ScheduleContext): Attempt | null {
  const nominal = a.driveSeconds / a.stintCount
  const assigned = assignDrivers(a, nominal)
  if (!assigned) return null

  const bounds = assigned.map((driver, index) => stintBounds(a, driver, index === 0))
  // A stint with no room in it is not a stint. Without this a driver already
  // at their maximum would be "planned" a zero-length run rather than the
  // schedule reporting that they have to get out of the car.
  if (bounds.some((b) => b.min > b.max || b.max <= 0)) return null

  const lengths = distributeSeconds(a.driveSeconds, bounds)
  if (!lengths) return null

  const taken = a.fromNow?.priorSeatTimeSeconds ?? {}
  const seatTime: Record<string, number> = {}
  // Every eligible driver appears, so a driver planned no future stints still
  // counts toward the spread rather than vanishing from the fairness maths.
  for (const driver of a.eligible) seatTime[driver.id] = taken[driver.id] ?? 0
  for (const [index, driver] of assigned.entries()) {
    seatTime[driver.id] = (seatTime[driver.id] ?? 0) + (lengths[index] ?? 0)
  }

  // The share cap and the fairness tolerance are re-checked against the actual
  // lengths: assignment only ever saw the nominal equal split. Both are
  // measured across the whole race — a driver who has already used their share
  // cannot be given more of it just because this solve started at half time.
  const fullRaceSeconds = a.fromNow?.fullRaceSeconds ?? a.raceSeconds
  for (const seconds of Object.values(seatTime)) {
    if (seconds / fullRaceSeconds > a.shareCap) return null
  }

  const seatValues = Object.values(seatTime)
  const spread = Math.max(...seatValues) - Math.min(...seatValues)
  const averageSeat = seatValues.reduce((sum, v) => sum + v, 0) / seatValues.length
  if (spread > (1 - a.fairnessWeight) * averageSeat) return null

  if (!withinConsecutiveCap(a, assigned, lengths)) return null
  if (!withinRestRequirement(a, assigned, lengths)) return null

  const stints: PlannedStint[] = []
  const fills: PlannedFill[] = []
  let offset = 0
  let fuel = a.startFuelGallons

  for (const [index, driver] of assigned.entries()) {
    const length = lengths[index] ?? 0
    const burnGph = a.burnRateGph * driver.burnRateFactor
    const fuelAtEnd = fuel - (length / HOUR_SECONDS) * burnGph

    stints.push({
      sequence: index + 1,
      driverId: driver.id,
      startOffsetSeconds: offset,
      endOffsetSeconds: offset + length,
      fuelAtStartGallons: round(fuel),
      fuelAtEndGallons: round(fuelAtEnd),
      burnGph,
    })

    const isLast = index === assigned.length - 1
    if (!isLast) {
      // Brim every stop. It is the only fill that yields a burn-rate datapoint,
      // and carrying less fuel than the tank holds buys nothing here.
      fills.push({
        afterStintSequence: index + 1,
        gallons: round(a.fuelCapacityGallons - fuelAtEnd),
      })
      fuel = a.fuelCapacityGallons
      offset += length + a.pitStopSeconds
    }
  }

  return {
    stints,
    fills,
    stopCount: a.stintCount - 1,
    seatTimeSecondsByDriver: seatTime,
    seatTimeTakenSecondsByDriver: { ...taken },
    seatTimeSpreadSeconds: spread,
  }
}

function fail(reason: StintPlanFailureReason, detail: string): StintPlanResult {
  return { ok: false, reason, detail }
}

/** Trim binary-float dust so a plan compares equal to the one beside it. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function validate(input: StintPlanInput): void {
  if (!(input.raceSeconds > 0)) {
    throw new Error(`race length must be positive, got ${input.raceSeconds}`)
  }
  if (!(input.fuelCapacityGallons > 0)) {
    throw new Error(`fuel capacity must be positive, got ${input.fuelCapacityGallons}`)
  }
  if (input.reserveGallons < 0 || input.reserveGallons > input.fuelCapacityGallons) {
    throw new Error(
      `reserve of ${input.reserveGallons} gal must be between 0 and the tank size of ${input.fuelCapacityGallons} gal`,
    )
  }
  if (!(input.pitStopSeconds >= 0)) {
    throw new Error(`pit stop must not be negative, got ${input.pitStopSeconds}`)
  }
  if (!(input.burnRate.gph > 0)) {
    throw new Error(`burn rate must be positive, got ${input.burnRate.gph}`)
  }
  const weight = input.fairnessWeight ?? 0.5
  if (weight < 0 || weight > 1) {
    throw new Error(`fairness weight must be between 0 and 1, got ${weight}`)
  }
  for (const driver of input.drivers) {
    if (!(driver.burnRateFactor > 0)) {
      throw new Error(
        `burn rate factor for ${driver.id} must be positive, got ${driver.burnRateFactor}`,
      )
    }
  }
}
