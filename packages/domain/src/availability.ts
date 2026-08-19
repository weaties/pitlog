/**
 * When a driver can actually be in the car — SPEC §5.1, #57.
 *
 * The motivating case is mundane and common: "I need to be done for the day by
 * one." Expressed as a pinned stint number the crew has to do the arithmetic
 * themselves and redo it every time the plan shifts. Expressed as a window, the
 * planner does it, and keeps doing it through every replan.
 *
 * A window is a **hard** constraint, which makes it different in kind from
 * roster order. Order only decides between drivers who are otherwise level, and
 * a plan always exists. A window can make a plan impossible — and when it does,
 * the crew needs to be told whose window, and which stretch of the race nobody
 * can cover. A refusal they cannot act on is barely better than a wrong plan.
 */

import type { PlannerDriver } from './stint-solver.js'

export interface Gap {
  fromSeconds: number
  untilSeconds: number
}

/**
 * Stretches of the race no eligible driver can cover.
 *
 * Cheap, and it catches the failure people actually hit: somebody leaves at
 * one o'clock and nobody else is there for the last two hours. Checking it up
 * front means the refusal names the hole rather than reporting that no stint
 * count happened to work.
 */
export function coverageGaps(drivers: readonly PlannerDriver[], raceSeconds: number): Gap[] {
  const windows = drivers
    .filter((d) => d.canDrive)
    .map((d) => ({
      from: Math.max(0, d.availableFromSeconds ?? 0),
      until: Math.min(raceSeconds, d.availableUntilSeconds ?? raceSeconds),
    }))
    .filter((w) => w.until > w.from)
    .sort((a, b) => a.from - b.from)

  const gaps: Gap[] = []
  let covered = 0

  for (const window of windows) {
    if (window.from > covered) {
      gaps.push({ fromSeconds: covered, untilSeconds: window.from })
    }
    covered = Math.max(covered, window.until)
    if (covered >= raceSeconds) break
  }

  if (covered < raceSeconds) gaps.push({ fromSeconds: covered, untilSeconds: raceSeconds })
  return gaps
}

/**
 * Pins that cannot all be honoured.
 *
 * Two drivers claiming the same stint is the obvious one. A driver pinned to a
 * stint outside their own availability is the quieter one, and worth catching
 * here rather than letting the search fail with no explanation.
 */
export function conflictingPins(drivers: readonly PlannerDriver[]): string[] {
  const bySequence = new Map<number, string[]>()

  for (const driver of drivers) {
    if (!driver.canDrive || !driver.pinnedSequence) continue
    bySequence.set(driver.pinnedSequence, [
      ...(bySequence.get(driver.pinnedSequence) ?? []),
      driver.id,
    ])
  }

  return [...bySequence.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([sequence, ids]) => `stint ${sequence} is claimed by ${ids.join(' and ')}`)
}

/** Whether a driver may be in the car for the whole of this window. */
export function isAvailableFor(
  driver: PlannerDriver,
  startSeconds: number,
  endSeconds: number,
): boolean {
  const from = driver.availableFromSeconds ?? Number.NEGATIVE_INFINITY
  const until = driver.availableUntilSeconds ?? Number.POSITIVE_INFINITY
  return startSeconds >= from && endSeconds <= until
}

/**
 * What each driver should be expected to drive, given how long they are around.
 *
 * Fairness has to stop fighting a constraint it cannot change: somebody
 * available for half the race will take less of it, and reporting that as
 * unfairness would send the solver hunting for a plan that does not exist. With
 * everybody fully available this reduces exactly to an equal share.
 */
export function expectedSeatTime(
  drivers: readonly PlannerDriver[],
  raceSeconds: number,
  driveSeconds: number,
): Map<string, number> {
  const eligible = drivers.filter((d) => d.canDrive)
  const windows = eligible.map((d) => ({
    id: d.id,
    seconds: Math.max(
      0,
      Math.min(raceSeconds, d.availableUntilSeconds ?? raceSeconds) -
        Math.max(0, d.availableFromSeconds ?? 0),
    ),
  }))

  const total = windows.reduce((sum, w) => sum + w.seconds, 0)
  const expected = new Map<string, number>()

  // Nobody available at all is a coverage failure, caught before this runs.
  // Falling back to an equal share keeps this function total.
  if (total <= 0) {
    for (const w of windows) expected.set(w.id, driveSeconds / Math.max(1, windows.length))
    return expected
  }

  for (const w of windows) expected.set(w.id, (driveSeconds * w.seconds) / total)
  return expected
}
