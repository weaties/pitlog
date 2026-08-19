import { describe, expect, it } from 'vitest'
import {
  EIGHT_HOUR_RACE,
  generateFixtureLaps,
  KNOWN_GOOD_SOLUTION,
  seatTimeSecondsByDriver,
} from './eight-hour-race.js'

const { race, drivers } = EIGHT_HOUR_RACE

describe('EIGHT_HOUR_RACE parameters', () => {
  it('is an 8-hour race — SPEC §7', () => {
    expect(race.durationSeconds).toBe(8 * 3600)
  })

  it('has a fixed start instant so reseeding is deterministic', () => {
    expect(new Date(race.startsAt).toISOString()).toBe(race.startsAt)
  })

  it('has 2-4 drivers — SPEC §2 team size', () => {
    expect(drivers.length).toBeGreaterThanOrEqual(2)
    expect(drivers.length).toBeLessThanOrEqual(4)
  })
})

describe('KNOWN_GOOD_SOLUTION', () => {
  const stints = KNOWN_GOOD_SOLUTION.stints

  it('covers the full race with no gaps beyond the pit stops', () => {
    expect(stints[0]?.startOffsetSeconds).toBe(0)
    expect(stints.at(-1)?.endOffsetSeconds).toBe(race.durationSeconds)

    for (let i = 1; i < stints.length; i++) {
      const prev = stints[i - 1]
      const cur = stints[i]
      if (!prev || !cur) throw new Error('unreachable')
      expect(cur.startOffsetSeconds - prev.endOffsetSeconds).toBe(race.pitStopSeconds)
    }
  })

  it('never runs a stint longer than the driver maximum', () => {
    for (const stint of stints) {
      const driver = drivers.find((d) => d.key === stint.driverKey)
      expect(driver).toBeDefined()
      const length = stint.endOffsetSeconds - stint.startOffsetSeconds
      expect(length).toBeLessThanOrEqual(driver?.maxStintSeconds ?? 0)
      expect(length).toBeGreaterThanOrEqual(driver?.minStintSeconds ?? 0)
    }
  })

  it('never puts the same driver in two consecutive stints', () => {
    for (let i = 1; i < stints.length; i++) {
      expect(stints[i]?.driverKey).not.toBe(stints[i - 1]?.driverKey)
    }
  })

  it('splits seat time exactly evenly — this is the fairness target', () => {
    const seat = seatTimeSecondsByDriver(KNOWN_GOOD_SOLUTION)
    const values = [...seat.values()]
    expect(values).toHaveLength(drivers.length)
    expect(new Set(values).size).toBe(1)
    expect(values.reduce((a, b) => a + b, 0)).toBe(
      race.durationSeconds - race.pitStopSeconds * (stints.length - 1),
    )
  })

  it('never lets the tank go negative or overflow', () => {
    for (const stint of stints) {
      expect(stint.fuelAtStartGallons).toBeLessThanOrEqual(race.fuelCapacityGallons)
      expect(stint.fuelAtEndGallons).toBeGreaterThan(0)
    }
  })

  it('starts on a full tank', () => {
    expect(stints[0]?.fuelAtStartGallons).toBe(race.fuelCapacityGallons)
  })

  it('burns exactly the modelled rate over each stint', () => {
    for (const stint of stints) {
      const hours = (stint.endOffsetSeconds - stint.startOffsetSeconds) / 3600
      const burnt = stint.fuelAtStartGallons - stint.fuelAtEndGallons
      expect(burnt).toBeCloseTo(hours * race.burnRateGph, 6)
    }
  })

  it('fills back to full at every stop and not at the last stint', () => {
    const fills = KNOWN_GOOD_SOLUTION.fills
    expect(fills).toHaveLength(stints.length - 1)
    for (const fill of fills) {
      const before = stints.find((s) => s.sequence === fill.afterStintSequence)
      const after = stints.find((s) => s.sequence === fill.afterStintSequence + 1)
      expect(before).toBeDefined()
      expect(after).toBeDefined()
      expect((before?.fuelAtEndGallons ?? 0) + fill.gallons).toBeCloseTo(
        after?.fuelAtStartGallons ?? 0,
        6,
      )
    }
  })

  it('leaves a usable reserve at every stint end — a plan that lands on empty is not a plan', () => {
    for (const stint of stints) {
      expect(stint.fuelAtEndGallons).toBeGreaterThanOrEqual(race.reserveGallons)
    }
  })
})

describe('generateFixtureLaps', () => {
  const laps = generateFixtureLaps()

  it('is deterministic — two calls produce identical data', () => {
    expect(generateFixtureLaps()).toEqual(laps)
  })

  it('produces official and gps laps for every stint — SPEC §5.4', () => {
    for (const stint of KNOWN_GOOD_SOLUTION.stints) {
      for (const source of ['official', 'gps'] as const) {
        const forStint = laps.filter(
          (l) => l.stintSequence === stint.sequence && l.source === source,
        )
        expect(forStint.length, `${source} laps for stint ${stint.sequence}`).toBeGreaterThan(10)
      }
    }
  })

  it('numbers official laps consecutively from 1 across the race', () => {
    const official = laps.filter((l) => l.source === 'official')
    expect(official.map((l) => l.lapNumber)).toEqual(official.map((_, i) => i + 1))
  })

  it('keeps every lap inside its stint window', () => {
    for (const lap of laps) {
      const stint = KNOWN_GOOD_SOLUTION.stints.find((s) => s.sequence === lap.stintSequence)
      if (!stint) throw new Error(`lap references unknown stint ${lap.stintSequence}`)
      expect(lap.startOffsetSeconds).toBeGreaterThanOrEqual(stint.startOffsetSeconds)
      expect(lap.startOffsetSeconds + lap.lapTimeMs / 1000).toBeLessThanOrEqual(
        stint.endOffsetSeconds + 1e-6,
      )
    }
  })

  it('gives every lap a plausible time', () => {
    for (const lap of laps) {
      expect(lap.lapTimeMs).toBeGreaterThan(60_000)
      expect(lap.lapTimeMs).toBeLessThan(300_000)
    }
  })

  it('plants exactly one official-vs-gps disagreement past the cross-check threshold', () => {
    const official = new Map(
      laps.filter((l) => l.source === 'official').map((l) => [l.lapNumber, l]),
    )
    const disagreements = laps
      .filter((l) => l.source === 'gps')
      .filter((g) => {
        const o = official.get(g.lapNumber)
        return o !== undefined && Math.abs(o.lapTimeMs - g.lapTimeMs) > 2000
      })
    expect(disagreements).toHaveLength(1)
  })
})
