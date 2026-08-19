import { EIGHT_HOUR_RACE, generateFixtureLaps, KNOWN_GOOD_SOLUTION } from '@pitlog/domain'
import type { Db } from './client.js'
import * as s from './schema.js'
import { DEMO_TEAM, RULE_CONFIG_IDS, SERIES_IDS } from './seed-data.js'

/**
 * Writes the SPEC §7 synthetic 8-hour race into the database.
 *
 * The shape of the data is defined in `@pitlog/domain` so the M1 planner can
 * test against it with no database at all; this function only projects it into
 * rows. Ids are derived deterministically from the fixture's own indices, so a
 * reseed produces the same ids and Playwright can hard-code them.
 */

const FIXTURE = {
  eventId: '00000000-0000-4000-8000-000000000101',
  sessionId: '00000000-0000-4000-8000-000000000102',
} as const

/** Deterministic v4-shaped uuid from a namespace byte and an index. */
function fixtureId(namespace: number, index: number): string {
  const hi = namespace.toString(16).padStart(4, '0')
  const lo = index.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${lo}`.slice(0, 24) + `${hi}${lo}`.slice(-12)
}

export async function seedFixtureRace(db: Db, log: (msg: string) => void): Promise<void> {
  const { race, drivers } = EIGHT_HOUR_RACE
  const startsAt = new Date(race.startsAt)
  const at = (offsetSeconds: number) => new Date(startsAt.getTime() + offsetSeconds * 1000)

  log(`fixture race "${race.name}" (${race.durationSeconds / 3600}h)`)

  await db.insert(s.events).values({
    id: FIXTURE.eventId,
    team_id: DEMO_TEAM.id,
    series_id: SERIES_IDS.lemons,
    rule_config_id: RULE_CONFIG_IDS.lemons,
    name: race.name,
    track_name: race.trackName,
    timezone: race.timezone,
    starts_at: startsAt,
    ends_at: at(race.durationSeconds),
    fuel_capacity_gallons: race.fuelCapacityGallons.toFixed(2),
    burn_rate_gph: race.burnRateGph.toFixed(3),
  })

  await db.insert(s.sessions).values({
    id: FIXTURE.sessionId,
    team_id: DEMO_TEAM.id,
    event_id: FIXTURE.eventId,
    kind: 'race',
    name: 'Race',
    starts_at: startsAt,
    ends_at: at(race.durationSeconds),
    scheduled_duration_seconds: race.durationSeconds,
  })

  const driverIds = new Map<string, string>()
  drivers.forEach((d, i) => {
    driverIds.set(d.key, fixtureId(0x201, i + 1))
  })

  await db.insert(s.drivers).values(
    drivers.map((d) => ({
      id: driverIds.get(d.key) as string,
      team_id: DEMO_TEAM.id,
      first_name: d.firstName,
      last_name: d.lastName,
      min_stint_seconds: d.minStintSeconds,
      max_stint_seconds: d.maxStintSeconds,
      burn_rate_factor: d.burnRateFactor.toFixed(3),
    })),
  )
  log(`  ${drivers.length} drivers`)

  const stintIds = new Map<number, string>()
  for (const stint of KNOWN_GOOD_SOLUTION.stints) {
    stintIds.set(stint.sequence, fixtureId(0x202, stint.sequence))
  }

  // The fixture is a completed race: planned and actual coincide exactly. That
  // is what makes it a known-good solution — an M1 planner fed these inputs
  // must reproduce these boundaries.
  await db.insert(s.stints).values(
    KNOWN_GOOD_SOLUTION.stints.map((stint) => ({
      id: stintIds.get(stint.sequence) as string,
      team_id: DEMO_TEAM.id,
      session_id: FIXTURE.sessionId,
      driver_id: driverIds.get(stint.driverKey) as string,
      sequence: stint.sequence,
      planned_start_at: at(stint.startOffsetSeconds),
      planned_end_at: at(stint.endOffsetSeconds),
      started_at: at(stint.startOffsetSeconds),
      ended_at: at(stint.endOffsetSeconds),
      fuel_at_start_gallons: stint.fuelAtStartGallons.toFixed(2),
      fuel_at_end_gallons: stint.fuelAtEndGallons.toFixed(2),
    })),
  )
  log(`  ${KNOWN_GOOD_SOLUTION.stints.length} stints`)

  await db.insert(s.fuel_fills).values(
    KNOWN_GOOD_SOLUTION.fills.map((fill, i) => {
      const stint = KNOWN_GOOD_SOLUTION.stints.find((x) => x.sequence === fill.afterStintSequence)
      if (!stint) throw new Error(`fill references unknown stint ${fill.afterStintSequence}`)
      return {
        id: fixtureId(0x203, i + 1),
        team_id: DEMO_TEAM.id,
        session_id: FIXTURE.sessionId,
        stint_id: stintIds.get(stint.sequence) as string,
        // Fuel goes in partway through the stop, not at the instant the car stops.
        filled_at: at(stint.endOffsetSeconds + 60),
        gallons: fill.gallons.toFixed(2),
        cost_cents: fill.costCents,
        filled_to_full: true,
      }
    }),
  )
  log(`  ${KNOWN_GOOD_SOLUTION.fills.length} fuel fills`)

  const laps = generateFixtureLaps()
  await db.insert(s.laps).values(
    laps.map((lap, i) => ({
      id: fixtureId(0x204, i + 1),
      team_id: DEMO_TEAM.id,
      session_id: FIXTURE.sessionId,
      driver_id: driverIds.get(lap.driverKey) as string,
      stint_id: stintIds.get(lap.stintSequence) as string,
      source: lap.source,
      lap_number: lap.lapNumber,
      started_at: at(lap.startOffsetSeconds),
      lap_time_ms: lap.lapTimeMs,
    })),
  )
  const official = laps.filter((l) => l.source === 'official').length
  log(`  ${laps.length} laps (${official} official + ${laps.length - official} gps)`)

  // Driver in/out entries so the one-tap log has realistic content.
  await db.insert(s.log_entries).values(
    KNOWN_GOOD_SOLUTION.stints.flatMap((stint, i) => {
      const driverId = driverIds.get(stint.driverKey) as string
      return [
        {
          id: fixtureId(0x205, i * 2 + 1),
          team_id: DEMO_TEAM.id,
          event_id: FIXTURE.eventId,
          session_id: FIXTURE.sessionId,
          driver_id: driverId,
          kind: 'driver_in' as const,
          occurred_at: at(stint.startOffsetSeconds),
        },
        {
          id: fixtureId(0x205, i * 2 + 2),
          team_id: DEMO_TEAM.id,
          event_id: FIXTURE.eventId,
          session_id: FIXTURE.sessionId,
          driver_id: driverId,
          kind: 'driver_out' as const,
          occurred_at: at(stint.endOffsetSeconds),
        },
      ]
    }),
  )
}
