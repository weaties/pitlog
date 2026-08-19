/**
 * What a visitor is allowed to see — SPEC §4.
 *
 * Family and friends get a link to the weekend: the stint schedule, lap times,
 * and standings. **First names only, and nothing else about a person.**
 *
 * The rule that matters is not "hide it in the UI" but "never put it in the
 * response". A last name that reaches the browser has been disclosed whether or
 * not a component renders it — anyone can open the network tab. So the payload
 * is built here, by construction, from a whitelist of fields, and a test walks
 * the finished object looking for anything that should not be in it.
 */

export interface VisitorSource {
  team: { id: string; name: string }
  event: { id: string; name: string; track_name: string | null; timezone: string } | null
  session: {
    id: string
    name: string
    starts_at: string | null
    scheduled_duration_seconds: number | null
  } | null
  drivers: {
    id: string
    first_name: string
    /** Present in the source and deliberately never copied out. */
    last_name?: string | null
    can_drive: boolean
  }[]
  stints: {
    id: string
    driver_id: string | null
    sequence: number
    planned_start_at: string | null
    planned_end_at: string | null
    started_at: string | null
    ended_at: string | null
  }[]
  laps: {
    id: string
    driver_id: string | null
    lap_number: number
    lap_time_ms: number | null
    position: number | null
    source: string
  }[]
}

export interface VisitorDriver {
  id: string
  firstName: string
}

export interface VisitorStint {
  sequence: number
  driverId: string | null
  plannedStartAt: string | null
  plannedEndAt: string | null
  startedAt: string | null
  endedAt: string | null
}

export interface VisitorLap {
  lapNumber: number
  driverId: string | null
  lapTimeMs: number | null
  position: number | null
}

export interface VisitorWeekend {
  team: { name: string }
  event: { name: string; trackName: string | null; timezone: string } | null
  session: { name: string; startsAt: string | null; scheduledDurationSeconds: number | null } | null
  drivers: VisitorDriver[]
  stints: VisitorStint[]
  laps: VisitorLap[]
  best: { lapTimeMs: number; driverId: string | null } | null
}

/**
 * Build the visitor payload.
 *
 * Every field is copied out by name. Nothing is spread from a source row, which
 * is the point: a column added to `drivers` tomorrow cannot leak through here
 * by accident, because nothing here says `...driver`.
 */
export function toVisitorWeekend(source: VisitorSource): VisitorWeekend {
  // Official timing is the truth for standings (SPEC §5.4); GPS laps are for
  // telemetry alignment and have no business in a public view.
  const official = source.laps.filter((lap) => lap.source === 'official')

  const timed = official.filter(
    (lap): lap is typeof lap & { lap_time_ms: number } => typeof lap.lap_time_ms === 'number',
  )
  const fastest = timed.reduce<(typeof timed)[number] | null>(
    (best, lap) => (best === null || lap.lap_time_ms < best.lap_time_ms ? lap : best),
    null,
  )

  return {
    team: { name: source.team.name },
    event: source.event
      ? {
          name: source.event.name,
          trackName: source.event.track_name,
          timezone: source.event.timezone,
        }
      : null,
    session: source.session
      ? {
          name: source.session.name,
          startsAt: source.session.starts_at,
          scheduledDurationSeconds: source.session.scheduled_duration_seconds,
        }
      : null,
    drivers: source.drivers.map((driver) => ({
      id: driver.id,
      firstName: driver.first_name,
    })),
    stints: [...source.stints]
      .sort((a, b) => a.sequence - b.sequence)
      .map((stint) => ({
        sequence: stint.sequence,
        driverId: stint.driver_id,
        plannedStartAt: stint.planned_start_at,
        plannedEndAt: stint.planned_end_at,
        startedAt: stint.started_at,
        endedAt: stint.ended_at,
      })),
    laps: official
      .map((lap) => ({
        lapNumber: lap.lap_number,
        driverId: lap.driver_id,
        lapTimeMs: lap.lap_time_ms,
        position: lap.position,
      }))
      .sort((a, b) => a.lapNumber - b.lapNumber),
    best: fastest ? { lapTimeMs: fastest.lap_time_ms, driverId: fastest.driver_id } : null,
  }
}
