/**
 * The synthetic 8-hour fixture race — SPEC §7.
 *
 * This is the test bed for the M1 stint planner. It is deliberately
 * framework-free and database-free: the planner package can import
 * `EIGHT_HOUR_RACE` as inputs and assert against `KNOWN_GOOD_SOLUTION` without
 * a Postgres anywhere in sight. `@pitlog/db`'s seeder writes the same data into
 * a real database for UI work.
 *
 * The numbers are chosen so the correct answer is exact rather than
 * approximate — 6 stints of 75 minutes with 6-minute stops fill 8 hours to the
 * second, and 3 drivers taking 2 stints each split seat time perfectly. A
 * planner that gets fairness or the fuel window wrong will miss by a visible
 * margin, not by rounding.
 *
 * The parameters are plausible-but-invented. They are NOT series rules: SPEC §3
 * leaves real Lemons/Lucky Dog/ChampCar values unresolved, and nothing here
 * should be read back as one.
 */

export interface FixtureDriver {
  key: string
  firstName: string
  lastName: string
  minStintSeconds: number
  maxStintSeconds: number
  /** Multiplier on the team burn rate. 1.0 = the modelled average. */
  burnRateFactor: number
  /** Seconds added to the base lap time. Positive is slower. */
  paceOffsetSeconds: number
}

export interface FixtureRace {
  name: string
  trackName: string
  timezone: string
  /** ISO 8601, UTC, fixed so reseeding is byte-identical. */
  startsAt: string
  durationSeconds: number
  fuelCapacityGallons: number
  burnRateGph: number
  /** Fuel the plan refuses to dip below. */
  reserveGallons: number
  /** Modelled stationary time per stop, including the driver change. */
  pitStopSeconds: number
  baseLapTimeSeconds: number
}

export interface PlannedStint {
  sequence: number
  driverKey: string
  startOffsetSeconds: number
  endOffsetSeconds: number
  fuelAtStartGallons: number
  fuelAtEndGallons: number
}

export interface PlannedFill {
  /** The fill happens in the stop after this stint ends. */
  afterStintSequence: number
  gallons: number
  costCents: number
}

export interface StintSolution {
  stints: PlannedStint[]
  fills: PlannedFill[]
}

export interface FixtureLap {
  source: 'official' | 'gps'
  lapNumber: number
  stintSequence: number
  driverKey: string
  startOffsetSeconds: number
  lapTimeMs: number
}

const HOUR = 3600

const drivers: FixtureDriver[] = [
  {
    key: 'ana',
    firstName: 'Ana',
    lastName: 'Ruiz',
    minStintSeconds: 30 * 60,
    maxStintSeconds: 90 * 60,
    burnRateFactor: 1.0,
    paceOffsetSeconds: 0,
  },
  {
    key: 'bo',
    firstName: 'Bo',
    lastName: 'Nakamura',
    minStintSeconds: 30 * 60,
    maxStintSeconds: 90 * 60,
    burnRateFactor: 1.0,
    paceOffsetSeconds: 2.5,
  },
  {
    key: 'cy',
    firstName: 'Cy',
    lastName: 'Okonkwo',
    minStintSeconds: 30 * 60,
    maxStintSeconds: 90 * 60,
    burnRateFactor: 1.0,
    paceOffsetSeconds: 5,
  },
]

const race: FixtureRace = {
  name: 'Autumn Enduro 8',
  trackName: 'Thunderhill Raceway Park (East)',
  timezone: 'America/Los_Angeles',
  startsAt: '2026-10-10T15:00:00.000Z',
  durationSeconds: 8 * HOUR,
  fuelCapacityGallons: 20,
  burnRateGph: 14,
  reserveGallons: 2,
  pitStopSeconds: 6 * 60,
  baseLapTimeSeconds: 150,
}

/** 6 stints, 5 stops: 6 × 75 min + 5 × 6 min = 480 min = 8 h exactly. */
const STINT_COUNT = 6
const STINT_SECONDS = (race.durationSeconds - race.pitStopSeconds * (STINT_COUNT - 1)) / STINT_COUNT

/** Fuel price used to derive fill costs, in cents per gallon. */
const FUEL_PRICE_CENTS_PER_GALLON = 549

function buildSolution(): StintSolution {
  const stints: PlannedStint[] = []
  const fills: PlannedFill[] = []
  const burnPerStint = (STINT_SECONDS / HOUR) * race.burnRateGph

  let offset = 0
  let fuel = race.fuelCapacityGallons

  for (let i = 0; i < STINT_COUNT; i++) {
    // A, B, C, A, B, C — no driver runs back to back, and with 6 stints over
    // 3 drivers everyone gets exactly two.
    const driver = drivers[i % drivers.length]
    if (!driver) throw new Error('unreachable: driver roster is non-empty')

    const start = offset
    const end = start + STINT_SECONDS
    const fuelAtEnd = round(fuel - burnPerStint)

    stints.push({
      sequence: i + 1,
      driverKey: driver.key,
      startOffsetSeconds: start,
      endOffsetSeconds: end,
      fuelAtStartGallons: round(fuel),
      fuelAtEndGallons: fuelAtEnd,
    })

    const isLast = i === STINT_COUNT - 1
    if (!isLast) {
      // Fill back to the brim: it is the only fill that yields a usable
      // burn-rate datapoint (volume ÷ elapsed since the last full tank).
      const gallons = round(race.fuelCapacityGallons - fuelAtEnd)
      fills.push({
        afterStintSequence: i + 1,
        gallons,
        costCents: Math.round(gallons * FUEL_PRICE_CENTS_PER_GALLON),
      })
      fuel = race.fuelCapacityGallons
      offset = end + race.pitStopSeconds
    }
  }

  return { stints, fills }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export const EIGHT_HOUR_RACE = { race, drivers } as const

export const KNOWN_GOOD_SOLUTION: StintSolution = buildSolution()

/** Total seat time per driver key, the fairness metric the planner optimises. */
export function seatTimeSecondsByDriver(solution: StintSolution): Map<string, number> {
  const seat = new Map<string, number>()
  for (const stint of solution.stints) {
    const length = stint.endOffsetSeconds - stint.startOffsetSeconds
    seat.set(stint.driverKey, (seat.get(stint.driverKey) ?? 0) + length)
  }
  return seat
}

/**
 * A tiny deterministic PRNG. `Math.random()` would make the fixture different
 * on every seed, which defeats the point of a known-good test bed.
 * Mulberry32 — small, well-distributed enough for lap-time jitter.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The lap whose GPS and official times are made to disagree by more than the
 * cross-check threshold, so the M2 reconciliation view has a known case to
 * light up. A missed transponder read is the realistic cause.
 */
const PLANTED_DISAGREEMENT_LAP = 42
const PLANTED_DISAGREEMENT_MS = 4_800

/**
 * Laps for the whole race, from both timing sources (SPEC §5.4).
 *
 * Laps are generated to fill each stint exactly: the stint boundary is
 * authoritative, and a partial lap at the end of a stint is dropped rather than
 * overrunning into the pit stop.
 */
export function generateFixtureLaps(): FixtureLap[] {
  const rand = mulberry32(20261010)
  const laps: FixtureLap[] = []
  let lapNumber = 0

  for (const stint of KNOWN_GOOD_SOLUTION.stints) {
    const driver = drivers.find((d) => d.key === stint.driverKey)
    if (!driver) throw new Error(`unknown driver ${stint.driverKey}`)

    let cursor = stint.startOffsetSeconds
    // First lap out of the pits carries the out-lap penalty.
    let isOutLap = true

    while (true) {
      const jitter = (rand() - 0.5) * 6
      const outLapPenalty = isOutLap ? 12 : 0
      const officialSeconds =
        race.baseLapTimeSeconds + driver.paceOffsetSeconds + jitter + outLapPenalty

      if (cursor + officialSeconds > stint.endOffsetSeconds) break

      lapNumber += 1
      const officialMs = Math.round(officialSeconds * 1000)

      laps.push({
        source: 'official',
        lapNumber,
        stintSequence: stint.sequence,
        driverKey: driver.key,
        startOffsetSeconds: cursor,
        lapTimeMs: officialMs,
      })

      // GPS detection lands within a few hundred ms of the transponder, except
      // on the planted lap.
      const gpsDelta =
        lapNumber === PLANTED_DISAGREEMENT_LAP
          ? PLANTED_DISAGREEMENT_MS
          : Math.round((rand() - 0.5) * 600)

      laps.push({
        source: 'gps',
        lapNumber,
        stintSequence: stint.sequence,
        driverKey: driver.key,
        startOffsetSeconds: cursor,
        lapTimeMs: officialMs + gpsDelta,
      })

      cursor += officialSeconds
      isOutLap = false
    }
  }

  return laps
}
