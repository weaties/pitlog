import { describe, expect, it } from 'vitest'
import type { BurnRateFill, BurnRateStint } from './burn-rate.js'
import { estimateDriverBurnRates } from './driver-burn-rate.js'
import { EIGHT_HOUR_RACE, KNOWN_GOOD_SOLUTION } from './fixtures/eight-hour-race.js'

const T0 = new Date('2026-10-10T15:00:00.000Z')

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000)
}

/**
 * `n` back-to-back hour-long stints, alternating between the named drivers,
 * each followed by a brim fill. Every measurement window therefore contains
 * exactly one driver.
 */
function alternating(drivers: readonly string[], gallonsFor: Record<string, number>, n: number) {
  const stints: BurnRateStint[] = []
  const fills: BurnRateFill[] = []

  for (let i = 0; i < n; i++) {
    const driverId = drivers[i % drivers.length]
    if (!driverId) throw new Error('unreachable')
    const gallons = gallonsFor[driverId]
    if (gallons === undefined) throw new Error(`no volume for ${driverId}`)

    stints.push({
      id: `s${i}`,
      driverId,
      startedAt: at(i * 4000),
      endedAt: at(i * 4000 + 3600),
    })
    fills.push({
      id: `f${i}`,
      filledAt: at(i * 4000 + 3700),
      gallons,
      filledToFull: true,
    })
  }

  return { stints, fills }
}

/** Four stints each: A burns 16 gal/h, B burns 12, so the team pools to 14. */
const HEAVY_AND_LIGHT = alternating(['a', 'b'], { a: 16, b: 12 }, 8)

const BOTH_DRIVERS = [
  { id: 'a', storedFactor: null },
  { id: 'b', storedFactor: null },
]

function forDriver(result: ReturnType<typeof estimateDriverBurnRates>, id: string) {
  const found = result?.drivers.find((d) => d.driverId === id)
  if (!found) throw new Error(`no result for driver ${id}`)
  return found
}

describe('estimateDriverBurnRates — applying a factor', () => {
  const result = estimateDriverBurnRates({
    ...HEAVY_AND_LIGHT,
    drivers: BOTH_DRIVERS,
    knownFullAt: T0,
    seedGph: null,
    windowSize: 20,
  })

  it('derives a factor once a driver has enough data to justify one', () => {
    expect(forDriver(result, 'a').method).toBe('measured')
    expect(forDriver(result, 'a').factor).toBeCloseTo(16 / 14, 10)
    expect(forDriver(result, 'b').method).toBe('measured')
    expect(forDriver(result, 'b').factor).toBeCloseTo(12 / 14, 10)
  })

  it('reports the rate to plan with, not just the multiplier', () => {
    const team = result?.team.gph ?? Number.NaN
    expect(team).toBeCloseTo(14, 10)
    expect(forDriver(result, 'a').gph).toBeCloseTo(16, 10)
    expect(forDriver(result, 'b').gph).toBeCloseTo(12, 10)
    expect(forDriver(result, 'a').gph).toBeCloseTo(team * forDriver(result, 'a').factor, 10)
  })

  it('says which mode it used', () => {
    for (const driver of result?.drivers ?? []) {
      expect(driver.assumptions.length).toBeGreaterThan(0)
      expect(driver.assumptions.map((a) => a.code)).toContain('driver_measured')
    }
  })

  it('counts only the datapoints it attributed to that driver', () => {
    expect(forDriver(result, 'a').sampleCount).toBe(4)
    expect(forDriver(result, 'a').engineHours).toBeCloseTo(4, 10)
  })

  it('leaves the team estimate alone', () => {
    expect(result?.team.method).toBe('measured')
    expect(result?.team.gph).toBeCloseTo(14, 10)
  })
})

describe('estimateDriverBurnRates — knowing when not to', () => {
  it('uses the team average when a driver has too few datapoints', () => {
    // Two stints each: real, but not yet a trend.
    const result = estimateDriverBurnRates({
      ...alternating(['a', 'b'], { a: 16, b: 12 }, 4),
      drivers: BOTH_DRIVERS,
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    const a = forDriver(result, 'a')
    expect(a.method).toBe('team_average')
    expect(a.factor).toBe(1)
    expect(a.assumptions.map((x) => x.code)).toContain('insufficient_driver_data')
  })

  it('uses the team average when a driver has enough fills but too little time', () => {
    // Four fills, but each after only ten minutes of running: fill-measurement
    // error dominates over anything the driver is doing.
    const stints: BurnRateStint[] = []
    const fills: BurnRateFill[] = []
    for (let i = 0; i < 4; i++) {
      stints.push({
        id: `s${i}`,
        driverId: 'a',
        startedAt: at(i * 1200),
        endedAt: at(i * 1200 + 600),
      })
      fills.push({ id: `f${i}`, filledAt: at(i * 1200 + 700), gallons: 3, filledToFull: true })
    }

    const result = estimateDriverBurnRates({
      stints,
      fills,
      drivers: [{ id: 'a', storedFactor: null }],
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    expect(forDriver(result, 'a').method).toBe('team_average')
    expect(forDriver(result, 'a').assumptions.map((x) => x.code)).toContain(
      'insufficient_driver_data',
    )
  })

  it('uses the team average when the measured difference is inside the noise', () => {
    // 14.28 vs 13.72 — a 2% split either side of the team rate. Applying a
    // factor of 1.02 would be false precision.
    const result = estimateDriverBurnRates({
      ...alternating(['a', 'b'], { a: 14.28, b: 13.72 }, 8),
      drivers: BOTH_DRIVERS,
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    const a = forDriver(result, 'a')
    expect(a.method).toBe('team_average')
    expect(a.factor).toBe(1)
    expect(a.sampleCount).toBe(4)
    expect(a.assumptions.map((x) => x.code)).toContain('driver_deviation_within_noise')
  })

  it('never attributes a window that two drivers shared', () => {
    // A and B both ran before the only fill. The window measures the pair.
    const result = estimateDriverBurnRates({
      stints: [
        { id: 's0', driverId: 'a', startedAt: at(0), endedAt: at(3600) },
        { id: 's1', driverId: 'b', startedAt: at(3600), endedAt: at(7200) },
      ],
      fills: [{ id: 'f0', filledAt: at(7300), gallons: 28, filledToFull: true }],
      drivers: BOTH_DRIVERS,
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    expect(forDriver(result, 'a').sampleCount).toBe(0)
    expect(forDriver(result, 'b').sampleCount).toBe(0)
    expect(result?.team.sampleCount).toBe(1)
    for (const driver of result?.drivers ?? []) {
      expect(driver.assumptions.map((x) => x.code)).toContain('mixed_window_excluded')
    }
  })

  it('gives a driver who has never driven the team average without complaint', () => {
    const result = estimateDriverBurnRates({
      ...HEAVY_AND_LIGHT,
      drivers: [...BOTH_DRIVERS, { id: 'newcomer', storedFactor: null }],
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    const newcomer = forDriver(result, 'newcomer')
    expect(newcomer.method).toBe('team_average')
    expect(newcomer.factor).toBe(1)
    expect(newcomer.sampleCount).toBe(0)
  })
})

describe('estimateDriverBurnRates — the stored factor', () => {
  it('uses drivers.burn_rate_factor when there is not enough data to measure', () => {
    const result = estimateDriverBurnRates({
      ...alternating(['a', 'b'], { a: 16, b: 12 }, 4),
      drivers: [
        { id: 'a', storedFactor: 1.1 },
        { id: 'b', storedFactor: null },
      ],
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    const a = forDriver(result, 'a')
    expect(a.method).toBe('stored')
    expect(a.factor).toBe(1.1)
    expect(a.assumptions.map((x) => x.code)).toContain('stored_factor_used')
    expect(forDriver(result, 'b').method).toBe('team_average')
  })

  it('prefers its own measurement once it has one, and surfaces the disagreement', () => {
    const result = estimateDriverBurnRates({
      ...HEAVY_AND_LIGHT,
      drivers: [
        // Someone typed 0.9 for the driver the data says is the heavy one.
        { id: 'a', storedFactor: 0.9 },
        { id: 'b', storedFactor: null },
      ],
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    const a = forDriver(result, 'a')
    expect(a.method).toBe('measured')
    expect(a.factor).toBeCloseTo(16 / 14, 10)
    expect(a.assumptions.map((x) => x.code)).toContain('stored_factor_disagrees')
  })

  it('does not flag a stored factor that agrees with the measurement', () => {
    const result = estimateDriverBurnRates({
      ...HEAVY_AND_LIGHT,
      drivers: [
        { id: 'a', storedFactor: 16 / 14 },
        { id: 'b', storedFactor: null },
      ],
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })

    expect(forDriver(result, 'a').assumptions.map((x) => x.code)).not.toContain(
      'stored_factor_disagrees',
    )
  })

  it('rejects a non-positive stored factor rather than planning around it', () => {
    expect(() =>
      estimateDriverBurnRates({
        ...HEAVY_AND_LIGHT,
        drivers: [{ id: 'a', storedFactor: 0 }],
        knownFullAt: T0,
        seedGph: null,
      }),
    ).toThrow(/factor/i)
  })
})

describe('estimateDriverBurnRates — factors are a driver property, not a weather report', () => {
  it('measures a factor against every datapoint, not just the rolling team window', () => {
    // The team rate rolls over the last few fills; a driver's factor should
    // not lurch because an old stop fell out of that window.
    const wide = estimateDriverBurnRates({
      ...HEAVY_AND_LIGHT,
      drivers: BOTH_DRIVERS,
      knownFullAt: T0,
      seedGph: null,
      windowSize: 20,
    })
    const narrow = estimateDriverBurnRates({
      ...HEAVY_AND_LIGHT,
      drivers: BOTH_DRIVERS,
      knownFullAt: T0,
      seedGph: null,
      windowSize: 4,
    })

    expect(forDriver(narrow, 'a').factor).toBeCloseTo(forDriver(wide, 'a').factor, 10)
    expect(forDriver(narrow, 'a').sampleCount).toBe(forDriver(wide, 'a').sampleCount)
  })

  it('still plans with the current team rate', () => {
    const narrow = estimateDriverBurnRates({
      ...HEAVY_AND_LIGHT,
      drivers: BOTH_DRIVERS,
      knownFullAt: T0,
      seedGph: null,
      windowSize: 4,
    })

    const team = narrow?.team.gph ?? Number.NaN
    expect(forDriver(narrow, 'a').gph).toBeCloseTo(team * forDriver(narrow, 'a').factor, 10)
  })
})

describe('estimateDriverBurnRates — no data at all', () => {
  it('is null when the team estimate itself is unknown', () => {
    expect(
      estimateDriverBurnRates({
        stints: [],
        fills: [],
        drivers: BOTH_DRIVERS,
        knownFullAt: T0,
        seedGph: null,
      }),
    ).toBeNull()
  })

  it('gives every driver the seed when there are no fills yet', () => {
    const result = estimateDriverBurnRates({
      stints: [],
      fills: [],
      drivers: BOTH_DRIVERS,
      knownFullAt: T0,
      seedGph: 12.5,
    })

    expect(result?.team.method).toBe('seed')
    for (const driver of result?.drivers ?? []) {
      expect(driver.method).toBe('team_average')
      expect(driver.gph).toBe(12.5)
      expect(driver.factor).toBe(1)
    }
  })
})

describe('estimateDriverBurnRates — the fixture race', () => {
  const { race, drivers } = EIGHT_HOUR_RACE
  const start = new Date(race.startsAt)

  const stints: BurnRateStint[] = KNOWN_GOOD_SOLUTION.stints.map((s) => ({
    id: `stint-${s.sequence}`,
    driverId: s.driverKey,
    startedAt: new Date(start.getTime() + s.startOffsetSeconds * 1000),
    endedAt: new Date(start.getTime() + s.endOffsetSeconds * 1000),
  }))

  const fills: BurnRateFill[] = KNOWN_GOOD_SOLUTION.fills.map((f) => {
    const parent = KNOWN_GOOD_SOLUTION.stints.find((s) => s.sequence === f.afterStintSequence)
    if (!parent) throw new Error('unreachable')
    return {
      id: `fill-${f.afterStintSequence}`,
      filledAt: new Date(start.getTime() + (parent.endOffsetSeconds + 60) * 1000),
      gallons: f.gallons,
      filledToFull: true,
    }
  })

  const result = estimateDriverBurnRates({
    stints,
    fills,
    drivers: drivers.map((d) => ({ id: d.key, storedFactor: null })),
    knownFullAt: start,
    seedGph: null,
    windowSize: 20,
  })

  it('refuses to derive a factor from an eight-hour race — this is the point', () => {
    // Six stints over three drivers is two apiece. Two stops is not evidence
    // about a person, and a solver that acted on it would short-change one.
    for (const driver of result?.drivers ?? []) {
      expect(driver.method).toBe('team_average')
      expect(driver.factor).toBe(1)
      expect(driver.assumptions.map((a) => a.code)).toContain('insufficient_driver_data')
    }
  })

  it('still attributes the windows it can, so the count is visible', () => {
    expect(forDriver(result, 'ana').sampleCount).toBe(2)
    expect(forDriver(result, 'bo').sampleCount).toBe(2)
    expect(forDriver(result, 'cy').sampleCount).toBe(1)
  })

  it('plans every driver at the measured team rate', () => {
    for (const driver of result?.drivers ?? []) {
      expect(driver.gph).toBe(14)
    }
  })
})
