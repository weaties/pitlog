/**
 * Live replanning — SPEC §5.1, which calls it the killer feature.
 *
 * During the race the crew logs what actually happened: when each driver went
 * out and came in, what went into the tank. This re-solves the rest of the race
 * from that, at the instant it is asked.
 *
 * The whole design is one idea: **the past is an input, not a plan**. Completed
 * stints are never re-solved, only counted — toward seat time, toward the
 * per-driver share cap, and toward how much of the current driver's maximum is
 * already spent. What is left is then handed to the ordinary solver, which does
 * not need to know that a race is underway.
 *
 * That is also what makes the drift test meaningful: a race that has run
 * exactly to plan must re-solve to precisely the rest of that same plan. If it
 * does not, replanning is inventing changes, and a crew that re-solves at every
 * stop would be handed a different schedule every time for no reason.
 */

import type { PlannerDriver, StintPlanInput, StintPlanResult } from './stint-solver.js'
import { solveStintPlan } from './stint-solver.js'

export interface ActualStint {
  driverId: string
  startOffsetSeconds: number
  /** Null while the driver is still in the car. */
  endOffsetSeconds: number | null
}

export interface RaceProgress {
  /** Seconds since the green flag. */
  elapsedSeconds: number
  /** What has actually been driven, in any order. */
  stints: readonly ActualStint[]
  /** Fuel believed to be in the tank right now. */
  fuelGallons: number
}

/**
 * Re-solve the remainder of a race from the current instant.
 *
 * `input` describes the race as a whole — the same object used to plan it on
 * the grid — and `progress` says where it has got to. Offsets in the returned
 * plan stay measured from the green flag, so a stint keeps the same number on
 * the pit board before and after a replan.
 */
export function replanFromNow(input: StintPlanInput, progress: RaceProgress): StintPlanResult {
  validate(input, progress)

  const remainingSeconds = input.raceSeconds - progress.elapsedSeconds
  if (remainingSeconds <= 0) {
    return {
      ok: false,
      reason: 'race_complete',
      detail: `The race is ${input.raceSeconds} s long and ${progress.elapsedSeconds} s have elapsed. There is nothing left to plan.`,
    }
  }

  const priorSeatTimeSeconds = seatTimeTaken(progress)
  const onTrack = progress.stints.find(
    (s) => s.endOffsetSeconds === null && s.startOffsetSeconds <= progress.elapsedSeconds,
  )

  const result = solveStintPlan({
    ...input,
    raceSeconds: remainingSeconds,
    // Windows are wall-clock, and a replan's zero is now. Shifting them is
    // what makes "I have to leave by one" keep meaning that at half past
    // twelve — the point at which the constraint actually earns its keep.
    drivers: input.drivers.map((driver) => clipToNow(driver, progress.elapsedSeconds)),
    startFuelGallons: progress.fuelGallons,
    fromNow: {
      priorSeatTimeSeconds,
      fullRaceSeconds: input.raceSeconds,
      lockedFirstDriverId: onTrack?.driverId ?? null,
      firstStintElapsedSeconds: onTrack ? progress.elapsedSeconds - onTrack.startOffsetSeconds : 0,
    },
  })

  if (!result.ok) return result

  // The solver works in a frame that starts now; the pit wall works in race
  // time. Shift once, here, rather than making every caller remember to.
  return {
    ok: true,
    plan: {
      ...result.plan,
      stints: result.plan.stints.map((stint) => ({
        ...stint,
        startOffsetSeconds: stint.startOffsetSeconds + progress.elapsedSeconds,
        endOffsetSeconds: stint.endOffsetSeconds + progress.elapsedSeconds,
      })),
    },
  }
}

/**
 * Move a driver's availability into the replan's frame.
 *
 * A driver whose window has already closed is marked unable to drive rather
 * than given an empty one: "nobody is available from 5h to 8h" is a better
 * refusal than a search that quietly finds no candidates.
 */
function clipToNow(driver: PlannerDriver, elapsedSeconds: number): PlannerDriver {
  const until = driver.availableUntilSeconds
  if (until !== null && until !== undefined && until <= elapsedSeconds) {
    return { ...driver, canDrive: false }
  }

  // Spread-then-overwrite only where there is something to shift, so an absent
  // window stays absent rather than becoming an explicit undefined.
  const shifted: PlannerDriver = { ...driver }
  if (typeof driver.availableFromSeconds === 'number') {
    shifted.availableFromSeconds = Math.max(0, driver.availableFromSeconds - elapsedSeconds)
  }
  if (typeof until === 'number') {
    shifted.availableUntilSeconds = until - elapsedSeconds
  }
  return shifted
}

/**
 * Seat time each driver has banked so far.
 *
 * A stint still in progress counts up to now, not to some end it has not
 * reached — otherwise the driver on track would look free of seat time until
 * they came in, and the solver would keep handing them more of it.
 */
function seatTimeTaken(progress: RaceProgress): Record<string, number> {
  const seat: Record<string, number> = {}

  for (const stint of progress.stints) {
    const end = Math.min(stint.endOffsetSeconds ?? progress.elapsedSeconds, progress.elapsedSeconds)
    const seconds = end - stint.startOffsetSeconds
    if (seconds <= 0) continue
    seat[stint.driverId] = (seat[stint.driverId] ?? 0) + seconds
  }

  return seat
}

function validate(input: StintPlanInput, progress: RaceProgress): void {
  if (!(progress.elapsedSeconds >= 0)) {
    throw new Error(`elapsed race time must not be negative, got ${progress.elapsedSeconds}`)
  }
  if (!(progress.fuelGallons >= 0) || progress.fuelGallons > input.fuelCapacityGallons) {
    throw new Error(
      `fuel in the tank must be between 0 and the tank size of ${input.fuelCapacityGallons} gal, got ${progress.fuelGallons}`,
    )
  }
  for (const stint of progress.stints) {
    if (stint.endOffsetSeconds !== null && stint.endOffsetSeconds < stint.startOffsetSeconds) {
      throw new Error(`stint for ${stint.driverId} ends before it starts`)
    }
  }
}
