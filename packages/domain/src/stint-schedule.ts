/**
 * Building one candidate schedule: who drives each stint, and for how long.
 *
 * Split from `stint-solver.ts` because these are the mechanics of a single
 * candidate, while the solver owns the search over candidates and the
 * objective chain that ranks them. Both halves are long enough to want reading
 * on their own.
 */

import type { PlannerDriver, ScheduleContext } from './stint-solver.js'

const HOUR_SECONDS = 3600

/**
 * Hand each stint to whoever has driven least so far, roster order breaking
 * ties — objective terms 3 and 5. With equal-length stints this is a plain
 * round robin, which is what a crew would write on the whiteboard.
 */
export function assignDrivers(a: ScheduleContext, nominal: number): PlannerDriver[] | null {
  // Seat time starts from what has already been driven, not from zero: that is
  // what makes replanning fair across the whole race rather than the remainder.
  const seat = new Map<string, number>(
    a.eligible.map((d) => [d.id, a.fromNow?.priorSeatTimeSeconds[d.id] ?? 0]),
  )
  const assigned: PlannerDriver[] = []
  const cap = a.rules?.driver.max_consecutive_stint_seconds ?? Number.POSITIVE_INFINITY

  for (let index = 0; index < a.stintCount; index++) {
    // The driver on track cannot be swapped out by re-solving; the first
    // remaining stint is the rest of the one they are already driving.
    if (index === 0 && a.fromNow?.lockedFirstDriverId) {
      const locked = a.eligible.find((d) => d.id === a.fromNow?.lockedFirstDriverId)
      if (!locked) return null
      assigned.push(locked)
      seat.set(locked.id, (seat.get(locked.id) ?? 0) + nominal)
      continue
    }

    const previous = assigned.at(-1)
    const candidates = a.eligible.filter((driver) => {
      if (driver.id !== previous?.id) return nominal <= cap
      // Consecutive stints accumulate: a pit stop is not a rest if the driver
      // never got out. This reading of an UNVERIFIED field is the conservative
      // one; see `series-rules`.
      return consecutiveRun(assigned, nominal) + nominal <= cap
    })
    if (candidates.length === 0) return null

    let best = candidates[0]
    if (!best) return null
    for (const candidate of candidates) {
      if ((seat.get(candidate.id) ?? 0) < (seat.get(best.id) ?? 0)) best = candidate
    }

    assigned.push(best)
    seat.set(best.id, (seat.get(best.id) ?? 0) + nominal)
  }

  return assigned
}

/** Seconds the trailing driver has been in the car without getting out. */
function consecutiveRun(assigned: readonly PlannerDriver[], nominal: number): number {
  const last = assigned.at(-1)
  if (!last) return 0
  let run = 0
  for (let i = assigned.length - 1; i >= 0 && assigned[i]?.id === last.id; i--) run += nominal
  return run
}

/** Re-check the consecutive cap against real lengths rather than the nominal. */
export function withinConsecutiveCap(
  a: ScheduleContext,
  assigned: readonly PlannerDriver[],
  lengths: readonly number[],
): boolean {
  const cap = a.rules?.driver.max_consecutive_stint_seconds
  if (cap === undefined) return true

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
