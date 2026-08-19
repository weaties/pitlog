/**
 * Building one candidate schedule: who drives each stint, and for how long.
 *
 * Split from `stint-solver.ts` because these are the mechanics of a single
 * candidate, while the solver owns the search over candidates and the
 * objective chain that ranks them. Both halves are long enough to want reading
 * on their own.
 */

import { isAvailableFor } from './availability.js'
import type { PlannerDriver, ScheduleContext } from './stint-solver.js'

const HOUR_SECONDS = 3600

/**
 * How many assignments the search will try before giving up.
 *
 * Backtracking over stints is exponential in the worst case, and a pit wall
 * cannot wait. This is generous for any real entry — a dozen stints over half a
 * dozen drivers — and the cap failing means "no plan found", which is reported
 * as a refusal rather than a wrong answer.
 */
const MAX_SEARCH_STEPS = 50_000

/**
 * Hand each stint to whoever has driven least so far, roster order breaking
 * ties — objective terms 3 and 5. With equal-length stints this is a plain
 * round robin, which is what a crew would write on the whiteboard.
 */
export function assignDrivers(a: ScheduleContext, nominal: number): PlannerDriver[] | null {
  // Both Lucky Dog and ChampCar require 60 minutes out of the car between
  // stints. It binds hardest on a small roster: two drivers on short stints
  // cannot legally alternate, however fair the split looks.
  const restSeconds = a.rules?.driver.min_rest_seconds ?? 0
  const cap = a.rules?.driver.max_consecutive_stint_seconds ?? Number.POSITIVE_INFINITY
  const seat = new Map<string, number>(
    a.eligible.map((d) => [d.id, a.fromNow?.priorSeatTimeSeconds[d.id] ?? 0]),
  )

  const assigned: PlannerDriver[] = []
  let steps = 0

  /**
   * Depth-first over stints, trying drivers in preference order.
   *
   * Without windows this explores exactly the path the old greedy loop took,
   * so the answer is unchanged and objective terms 3 and 5 still decide it: the
   * first complete assignment found is the preferred one. Backtracking only
   * does work when a constraint would otherwise strand a later stint — which
   * greedy could not see coming, because it committed before it knew.
   */
  const place = (index: number): boolean => {
    if (index === a.stintCount) return true
    if (++steps > MAX_SEARCH_STEPS) return false

    for (const driver of candidatesFor(a, assigned, index, nominal, restSeconds, cap, seat)) {
      assigned.push(driver)
      seat.set(driver.id, (seat.get(driver.id) ?? 0) + nominal)

      if (place(index + 1)) return true

      assigned.pop()
      seat.set(driver.id, (seat.get(driver.id) ?? 0) - nominal)
    }

    return false
  }

  return place(0) ? assigned : null
}

/** Drivers who could legally take this stint, best first. */
function candidatesFor(
  a: ScheduleContext,
  assigned: readonly PlannerDriver[],
  index: number,
  nominal: number,
  restSeconds: number,
  cap: number,
  seat: ReadonlyMap<string, number>,
): PlannerDriver[] {
  // The driver already on track cannot be swapped out by re-solving; the first
  // remaining stint is the rest of the one they are already driving.
  if (index === 0 && a.fromNow?.lockedFirstDriverId) {
    const locked = a.eligible.find((d) => d.id === a.fromNow?.lockedFirstDriverId)
    return locked ? [locked] : []
  }

  const sequence = index + 1
  const startSeconds = index * (nominal + a.pitStopSeconds)
  const endSeconds = startSeconds + nominal

  // A pin is absolute: this stint belongs to that driver and nobody else, and
  // that driver takes no other stint.
  const pinned = a.eligible.find((d) => d.pinnedSequence === sequence)
  const pool = pinned ? [pinned] : a.eligible.filter((d) => !d.pinnedSequence)

  const previous = assigned.at(-1)

  return pool
    .filter((driver) => {
      if (!isAvailableFor(driver, startSeconds, endSeconds)) return false

      if (
        restSeconds > 0 &&
        !hasRested(assigned, driver, index, nominal, a.pitStopSeconds, restSeconds)
      ) {
        return false
      }

      if (driver.id !== previous?.id) return nominal <= cap
      // Consecutive stints accumulate: a pit stop is not a rest if the driver
      // never got out. This reading of an UNVERIFIED field is the conservative
      // one; see `series-rules`.
      return consecutiveRun(assigned, nominal) + nominal <= cap
    })
    .sort(
      (x, y) =>
        (seat.get(x.id) ?? 0) - (seat.get(y.id) ?? 0) ||
        a.eligible.indexOf(x) - a.eligible.indexOf(y),
    )
}

/**
 * Whether this driver has been out of the car long enough to go back in.
 *
 * Measured from the end of their last stint to the start of this one, across
 * the stints and stops in between. Nominal lengths are used because assignment
 * runs before lengths are settled; the check is repeated against real lengths
 * once they are.
 */
function hasRested(
  assigned: readonly PlannerDriver[],
  driver: PlannerDriver,
  index: number,
  nominal: number,
  pitStopSeconds: number,
  restSeconds: number,
): boolean {
  const last = assigned.findLastIndex((d) => d.id === driver.id)
  if (last === -1) return true

  // Stints strictly between their last one and this one, plus every stop.
  const between = index - last - 1
  return between * nominal + (index - last) * pitStopSeconds >= restSeconds
}

/** Seconds the trailing driver has been in the car without getting out. */
function consecutiveRun(assigned: readonly PlannerDriver[], nominal: number): number {
  const last = assigned.at(-1)
  if (!last) return 0
  let run = 0
  for (let i = assigned.length - 1; i >= 0 && assigned[i]?.id === last.id; i--) run += nominal
  return run
}

/**
 * Re-check the rest requirement against real lengths.
 *
 * Assignment only ever saw the nominal split, and water-filling can shorten the
 * stints that were supposed to be somebody's rest.
 */
export function withinRestRequirement(
  a: ScheduleContext,
  assigned: readonly PlannerDriver[],
  lengths: readonly number[],
): boolean {
  const restSeconds = a.rules?.driver.min_rest_seconds
  if (!restSeconds) return true

  const lastSeen = new Map<string, number>()
  let clock = 0

  for (const [index, driver] of assigned.entries()) {
    const previousEnd = lastSeen.get(driver.id)
    if (previousEnd !== undefined && clock - previousEnd < restSeconds) return false

    const length = lengths[index] ?? 0
    lastSeen.set(driver.id, clock + length)
    clock += length + a.pitStopSeconds
  }

  return true
}

/**
 * Re-check availability against real lengths.
 *
 * Assignment reasons about nominal equal stints; water-filling can push a
 * boundary past somebody's window. Cheaper to re-check than to solve lengths
 * and assignment together.
 */
export function withinAvailability(
  a: ScheduleContext,
  assigned: readonly PlannerDriver[],
  lengths: readonly number[],
): boolean {
  let clock = 0
  for (const [index, driver] of assigned.entries()) {
    const length = lengths[index] ?? 0
    if (!isAvailableFor(driver, clock, clock + length)) return false
    clock += length + a.pitStopSeconds
  }
  return true
}

/** Re-check the consecutive cap against real lengths rather than the nominal. */
export function withinConsecutiveCap(
  a: ScheduleContext,
  assigned: readonly PlannerDriver[],
  lengths: readonly number[],
): boolean {
  const cap = a.rules?.driver.max_consecutive_stint_seconds
  if (cap === undefined || cap === null) return true

  let run = 0
  for (const [index, driver] of assigned.entries()) {
    run =
      driver.id === assigned[index - 1]?.id ? run + (lengths[index] ?? 0) : (lengths[index] ?? 0)
    if (run > cap) return false
  }
  return true
}

export interface Bounds {
  min: number
  max: number
}

/**
 * The window one stint may occupy, as whole seconds.
 *
 * Every source of a limit is intersected rather than ranked: the driver's own
 * row, the series rules, and how far the fuel goes. Rounding is outward-safe —
 * the minimum rounds up and the maximum rounds down — so the plan can never
 * land a second past a real limit.
 */
export function stintBounds(a: ScheduleContext, driver: PlannerDriver, isFirst: boolean): Bounds {
  // Time already spent in the car this stint counts against the driver's
  // maximum: someone an hour into a ninety-minute cap has thirty minutes left,
  // not ninety.
  const alreadyDriven =
    isFirst && a.fromNow?.lockedFirstDriverId === driver.id ? a.fromNow.firstStintElapsedSeconds : 0
  const fuelAtStart = isFirst ? a.startFuelGallons : a.fuelCapacityGallons
  const burnGph = a.burnRateGph * driver.burnRateFactor
  const fuelWindow = ((fuelAtStart - a.reserveGallons) / burnGph) * HOUR_SECONDS

  const min = Math.ceil(
    Math.max(
      0,
      Math.max(driver.minStintSeconds ?? 0, a.rules?.driver.min_stint_seconds ?? 0) - alreadyDriven,
    ),
  )
  const max = Math.floor(
    Math.min(
      (driver.maxStintSeconds ?? Number.POSITIVE_INFINITY) - alreadyDriven,
      (a.rules?.driver.max_stint_seconds ?? Number.POSITIVE_INFINITY) - alreadyDriven,
      (a.rules?.driver.max_consecutive_stint_seconds ?? Number.POSITIVE_INFINITY) - alreadyDriven,
      fuelWindow,
    ),
  )

  return { min, max }
}

/**
 * Split `total` whole seconds across the stints, as evenly as their bounds
 * allow — objective term 4.
 *
 * Every stint starts at its minimum and the surplus is then handed out in
 * equal rounds, so a stint only ends up shorter than its neighbours when a
 * limit forced it. The final odd seconds go to the earliest stints, which is
 * arbitrary but fixed: the alternative is a plan that differs between two
 * devices that were handed identical inputs.
 */
export function distributeSeconds(total: number, bounds: readonly Bounds[]): number[] | null {
  const values = bounds.map((b) => b.min)
  let surplus = total - values.reduce((sum, v) => sum + v, 0)
  if (surplus < 0) return null
  if (bounds.reduce((sum, b) => sum + (b.max - b.min), 0) < surplus) return null

  while (surplus > 0) {
    const open = values.flatMap((value, index) =>
      (bounds[index]?.max ?? 0) > value ? [index] : [],
    )
    if (open.length === 0) return null

    const step = Math.floor(surplus / open.length)
    if (step === 0) {
      for (const index of open.slice(0, surplus)) {
        values[index] = (values[index] ?? 0) + 1
        surplus -= 1
      }
      break
    }

    for (const index of open) {
      const headroom = (bounds[index]?.max ?? 0) - (values[index] ?? 0)
      const give = Math.min(step, headroom)
      values[index] = (values[index] ?? 0) + give
      surplus -= give
    }
  }

  return values
}
