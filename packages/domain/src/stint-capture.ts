/**
 * Turning "driver in" and "driver out" taps into stint rows — SPEC §5.2, #13.
 *
 * This is the join between the one-tap log and the planner's actuals, and it
 * is where a race weekend's mess has to be absorbed:
 *
 * - The plan already contains the stint that is about to start, so a driver-in
 *   must *start* it rather than create a second row beside it. Otherwise a plan
 *   of six stints becomes six plans plus six actuals, and live replanning
 *   double-counts everyone's seat time.
 * - The car pits for something nobody planned, and that stint has to exist.
 * - Two phones are logging, one of them offline, so a driver-out can arrive
 *   before the driver-in that precedes it.
 * - Somebody forgets to tap "out" entirely, because a driver change takes
 *   twenty seconds and finding the phone takes thirty.
 *
 * Framework-free and pure: it takes the stints it knows about and returns the
 * rows to write. Persisting them is `apps/web`'s problem.
 */

/** The subset of a `stints` row this module reasons about. */
export interface CapturedStint {
  id: string
  session_id: string
  driver_id: string | null
  sequence: number
  planned_start_at: Date | null
  planned_end_at: Date | null
  started_at: Date | null
  ended_at: Date | null
}

export interface CaptureInput {
  sessionId: string
  driverId?: string | null
  at: Date
  /**
   * Injected so the caller owns id generation — an id assigned on a device is
   * permanent, and the server never renumbers it.
   */
  newId?: () => string
}

export interface CaptureResult {
  /** The stint the tap applies to, with the actual filled in. */
  stint: CapturedStint
  /** True when no existing row fitted and one was invented. */
  created: boolean
  /**
   * A stint left open that this tap implicitly ended. Written alongside — an
   * open stint is a hole in the seat-time maths, and the planner would treat
   * the driver as still in the car.
   */
  closed?: CapturedStint
}

const forSession = (stints: readonly CapturedStint[], sessionId: string) =>
  stints.filter((s) => s.session_id === sessionId)

/** The driver currently in the car, if anyone is. */
export function openStint(
  stints: readonly CapturedStint[],
  sessionId: string,
): CapturedStint | null {
  const open = forSession(stints, sessionId).filter(
    (s) => s.started_at !== null && s.ended_at === null,
  )
  if (open.length === 0) return null

  return open.reduce((latest, s) =>
    (s.started_at?.getTime() ?? 0) > (latest.started_at?.getTime() ?? 0) ? s : latest,
  )
}

/**
 * A driver got in the car.
 *
 * Preference order: reconcile an orphan left by an early driver-out, then start
 * the nearest unstarted plan this driver could take, and only then invent a
 * stint.
 */
export function applyDriverIn(
  stints: readonly CapturedStint[],
  input: CaptureInput,
): CaptureResult {
  const mine = forSession(stints, input.sessionId)
  const driverId = input.driverId ?? null

  // Anyone still out is out no longer — this tap is the evidence their stint
  // ended, even though nobody said so.
  const stillOpen = openStint(stints, input.sessionId)
  const closed =
    stillOpen && stillOpen.driver_id !== driverId ? { ...stillOpen, ended_at: input.at } : undefined

  const orphan = mine
    .filter(
      (s) =>
        s.started_at === null &&
        s.ended_at !== null &&
        s.ended_at.getTime() > input.at.getTime() &&
        (s.driver_id === null || s.driver_id === driverId),
    )
    .sort((a, b) => (a.ended_at?.getTime() ?? 0) - (b.ended_at?.getTime() ?? 0))[0]

  if (orphan) {
    return {
      stint: { ...orphan, driver_id: driverId ?? orphan.driver_id, started_at: input.at },
      created: false,
      ...(closed ? { closed } : {}),
    }
  }

  const candidate = mine
    .filter(
      (s) =>
        s.started_at === null &&
        s.ended_at === null &&
        (s.driver_id === null || s.driver_id === driverId),
    )
    .sort(
      (a, b) => distance(a.planned_start_at, input.at) - distance(b.planned_start_at, input.at),
    )[0]

  if (candidate) {
    return {
      stint: { ...candidate, driver_id: driverId ?? candidate.driver_id, started_at: input.at },
      created: false,
      ...(closed ? { closed } : {}),
    }
  }

  return {
    stint: {
      id: makeId(input),
      session_id: input.sessionId,
      driver_id: driverId,
      sequence: nextSequence(mine),
      planned_start_at: null,
      planned_end_at: null,
      started_at: input.at,
      ended_at: null,
    },
    created: true,
    ...(closed ? { closed } : {}),
  }
}

/**
 * A driver got out.
 *
 * With no open stint this records the end anyway, leaving a row whose
 * `started_at` is null for the late driver-in to reconcile. Dropping the tap
 * would be the alternative, and a lost stint boundary is a lost hour of seat
 * time in the fairness maths.
 */
export function applyDriverOut(
  stints: readonly CapturedStint[],
  input: CaptureInput,
): CaptureResult {
  const open = openStint(stints, input.sessionId)
  if (open) return { stint: { ...open, ended_at: input.at }, created: false }

  return {
    stint: {
      id: makeId(input),
      session_id: input.sessionId,
      driver_id: input.driverId ?? null,
      sequence: nextSequence(forSession(stints, input.sessionId)),
      planned_start_at: null,
      planned_end_at: null,
      started_at: null,
      ended_at: input.at,
    },
    created: true,
  }
}

function makeId(input: CaptureInput): string {
  return input.newId ? input.newId() : crypto.randomUUID()
}

function distance(planned: Date | null, at: Date): number {
  // A stint with no planned start is a worse match than any planned one, but
  // still a match — it is what an admin adds by hand mid-weekend.
  if (planned === null) return Number.MAX_SAFE_INTEGER - 1
  return Math.abs(planned.getTime() - at.getTime())
}

function nextSequence(stints: readonly CapturedStint[]): number {
  return stints.reduce((max, s) => Math.max(max, s.sequence), 0) + 1
}
