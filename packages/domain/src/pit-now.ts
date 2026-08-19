/**
 * The yellow-flag "pit now?" button — SPEC §5.1.
 *
 * A safety car is out and someone has about ten seconds to decide whether to
 * bring the car in. This answers that, and the shape of the answer matters as
 * much as its correctness: a crew chief under a yellow reads a verdict, not a
 * schedule. So the return carries a one-word `verdict` first, three numbers
 * that explain it, and only then the two full plans for anyone who wants to
 * look closer.
 *
 * **It is a what-if.** Nothing here mutates anything — it runs the ordinary
 * replan twice, once for staying out and once for coming in, and subtracts.
 * The live plan is whatever the crew last committed to; this does not touch it.
 */

import type { RaceProgress } from './replan.js'
import { replanFromNow } from './replan.js'
import { effectiveFuelCapacityGallons, effectivePitStopSeconds } from './stint-rules.js'
import type { StintPlanInput, StintPlanResult } from './stint-solver.js'

export interface PitNowOptions {
  /**
   * What will be in the tank when the car leaves. Defaults to a brim, which is
   * both the usual case and the only one that yields a burn-rate datapoint.
   */
  fuelAfterStopGallons?: number
}

export type PitNowVerdict =
  /** Same number of stops either way — the stop is on the house. */
  | 'free'
  | 'costs_a_stop'
  | 'saves_a_stop'
  /** Staying out has no legal plan. The only question left is who gets in. */
  | 'forced'
  /** Coming in now leaves the rest of the race unsolvable. */
  | 'unsolvable'
  | 'no_plan'

export interface PitNowDelta {
  /**
   * Stops this decision costs, counting the one about to be made.
   *
   * The pit-now plan describes the race *after* the stop, so its own stop count
   * is one short of what pitting actually costs. Positive means pitting now is
   * one stop worse.
   */
  stopCountDelta: number
  /** Seconds of running given up by coming in early. */
  stintCutShortSeconds: number
  /** What is still in the tank as the car comes in. */
  fuelAtStopGallons: number
  /** Change in seat-time spread. Negative is fairer. */
  seatTimeSpreadDeltaSeconds: number
}

export interface PitNowComparison {
  verdict: PitNowVerdict
  /** Null whenever one of the two options has no plan to compare. */
  delta: PitNowDelta | null
  /** The stop being contemplated, after any series minimum. */
  stopSeconds: number
  /** The race if the car stays out — the current plan, re-solved from now. */
  stayOut: StintPlanResult
  /** The race if the car comes in this lap. */
  pitNow: StintPlanResult
}

/**
 * Compare coming in now against staying out.
 *
 * `input` is the race as a whole and `progress` is where it has got to — the
 * same pair `replanFromNow` takes, because pitting now is not a different kind
 * of question, only a different starting point.
 */
export function evaluatePitNow(
  input: StintPlanInput,
  progress: RaceProgress,
  options: PitNowOptions = {},
): PitNowComparison {
  const stopSeconds = effectivePitStopSeconds(input.pitStopSeconds, input.rules)
  const stayOut = replanFromNow(input, progress)

  const fuelAfterStopGallons =
    options.fuelAfterStopGallons ??
    effectiveFuelCapacityGallons(input.fuelCapacityGallons, input.rules)

  // Coming in ends the current stint here and hands the car to whoever the
  // solver picks: a stop is exactly the moment that choice reopens.
  const pitNow = replanFromNow(input, {
    elapsedSeconds: progress.elapsedSeconds + stopSeconds,
    stints: progress.stints.map((stint) =>
      stint.endOffsetSeconds === null
        ? { ...stint, endOffsetSeconds: progress.elapsedSeconds }
        : stint,
    ),
    fuelGallons: fuelAfterStopGallons,
  })

  return {
    verdict: verdictFor(stayOut, pitNow),
    delta: deltaFor(stayOut, pitNow, progress),
    stopSeconds,
    stayOut,
    pitNow,
  }
}

function verdictFor(stayOut: StintPlanResult, pitNow: StintPlanResult): PitNowVerdict {
  if (!stayOut.ok && !pitNow.ok) return 'no_plan'
  if (!stayOut.ok) return 'forced'
  if (!pitNow.ok) return 'unsolvable'

  const stops = 1 + pitNow.plan.stopCount - stayOut.plan.stopCount
  if (stops > 0) return 'costs_a_stop'
  if (stops < 0) return 'saves_a_stop'
  return 'free'
}

function deltaFor(
  stayOut: StintPlanResult,
  pitNow: StintPlanResult,
  progress: RaceProgress,
): PitNowDelta | null {
  if (!stayOut.ok || !pitNow.ok) return null

  const next = stayOut.plan.stints[0]
  const stintCutShortSeconds = next ? next.endOffsetSeconds - next.startOffsetSeconds : 0

  return {
    stopCountDelta: 1 + pitNow.plan.stopCount - stayOut.plan.stopCount,
    stintCutShortSeconds,
    fuelAtStopGallons: progress.fuelGallons,
    seatTimeSpreadDeltaSeconds:
      pitNow.plan.seatTimeSpreadSeconds - stayOut.plan.seatTimeSpreadSeconds,
  }
}
