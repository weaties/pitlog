import { describe, expect, it } from 'vitest'
import type { BurnRateFill, BurnRateStint } from './burn-rate.js'
import { estimateBurnRate } from './burn-rate.js'
import { EIGHT_HOUR_RACE, KNOWN_GOOD_SOLUTION } from './fixtures/eight-hour-race.js'

const T0 = new Date('2026-10-10T15:00:00.000Z')

/** Instant `seconds` after the reference start. Keeps the tests readable. */
function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000)
}

function stint(id: string, startSeconds: number, endSeconds: number | null): BurnRateStint {
  return {
    id,
    driverId: null,
    startedAt: at(startSeconds),
    endedAt: endSeconds === null ? null : at(endSeconds),
  }
}

function fill(id: string, atSeconds: number, gallons: number, filledToFull = true): BurnRateFill {
  return { id, filledAt: at(atSeconds), gallons, filledToFull }
}

describe('estimateBurnRate — no measured data', () => {
  it('falls back to the hand-entered seed and says so', () => {
    const estimate = estimateBurnRate({
      fills: [],
      stints: [],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    expect(estimate).not.toBeNull()
    expect(estimate?.gph).toBe(12.5)
    expect(estimate?.method).toBe('seed')
    expect(estimate?.confidence).toBe('none')
    expect(estimate?.sampleCount).toBe(0)
    expect(estimate?.assumptions.map((a) => a.code)).toContain('seeded_no_data')
  })

  it('returns null when there is neither a seed nor a datapoint', () => {
    // The planner must refuse to run rather than invent a burn rate.
    expect(estimateBurnRate({ fills: [], stints: [], knownFullAt: T0, seedGph: null })).toBeNull()
  })
})

describe('estimateBurnRate — measurement', () => {
  it('measures one brim fill against the engine time since the tank was last full', () => {
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 2 * 3600)],
      fills: [fill('f1', 2 * 3600 + 60, 28)],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    // 28 gallons over 2 engine-hours.
    expect(estimate?.gph).toBe(14)
    expect(estimate?.method).toBe('measured')
    expect(estimate?.sampleCount).toBe(1)
    expect(estimate?.confidence).toBe('low')
    expect(estimate?.assumptions.map((a) => a.code)).toContain('single_datapoint')
  })

  it('counts engine hours, not wall-clock — pit time is not burning fuel', () => {
    // Two 1-hour stints separated by a 30-minute stop. Wall clock from the
    // baseline to the second fill is 2.5 h and would give 11.2 gal/h; the car
    // only ran for 2 h, which is 14.
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 5400, 9000)],
      fills: [fill('f1', 3660, 14), fill('f2', 9060, 14)],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    expect(estimate?.gph).toBe(14)
    expect(estimate?.sampleCount).toBe(2)
  })

  it('ignores fills that were not to the brim', () => {
    const withoutPartial = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 5400, 9000)],
      fills: [fill('f1', 3660, 14), fill('f2', 9060, 14)],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    const withPartial = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 5400, 9000)],
      fills: [
        fill('f1', 3660, 14),
        // A splash-and-go mid-stint. It tells you nothing about consumption:
        // the tank was not full before it and is not full after it.
        fill('partial', 7200, 5, false),
        fill('f2', 9060, 14),
      ],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    expect(withPartial?.gph).toBe(withoutPartial?.gph)
    expect(withPartial?.sampleCount).toBe(2)
    expect(withPartial?.assumptions.map((a) => a.code)).toContain('ignored_partial_fills')
  })

  it('pools total gallons over total hours rather than averaging the ratios', () => {
    // 10 gal/h then 15 gal/h. The mean of the ratios is 12.5; the honest
    // answer weights the longer run more heavily: 40 gal over 3 h.
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 3600, 3600 + 2 * 3600)],
      fills: [fill('f1', 3600, 10), fill('f2', 3600 + 2 * 3600, 30)],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    expect(estimate?.gph).toBeCloseTo(40 / 3, 10)
    expect(estimate?.gph).not.toBeCloseTo(12.5, 3)
  })

  it('uses the first brim fill as a baseline when the tank was never known full', () => {
    // Nobody recorded rolling out on a full tank, so the first fill measures
    // an unknown starting level and cannot be a datapoint.
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 3600, 7200)],
      fills: [fill('f1', 3600, 99), fill('f2', 7200, 14)],
      knownFullAt: null,
      seedGph: 12.5,
    })

    expect(estimate?.sampleCount).toBe(1)
    expect(estimate?.gph).toBe(14)
  })

  it('reports the datapoints it used, so the UI can show its inputs', () => {
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600)],
      fills: [fill('f1', 3600, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(estimate?.datapoints).toEqual([{ fillId: 'f1', gallons: 14, engineHours: 1, gph: 14 }])
  })

  it('sorts fills before measuring, so an out-of-order sync cannot corrupt the estimate', () => {
    const inOrder = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 5400, 9000)],
      fills: [fill('f1', 3660, 14), fill('f2', 9060, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    const shuffled = estimateBurnRate({
      stints: [stint('s2', 5400, 9000), stint('s1', 0, 3600)],
      fills: [fill('f2', 9060, 14), fill('f1', 3660, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(shuffled).toEqual(inOrder)
  })

  it('counts a still-running stint up to the fill instant', () => {
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, null)],
      fills: [fill('f1', 3600, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(estimate?.gph).toBe(14)
  })
})

describe('estimateBurnRate — degenerate inputs', () => {
  it('never divides by zero when a fill follows no running time at all', () => {
    // Two fills back to back in the same stop. The second measures nothing.
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600)],
      fills: [fill('f1', 3660, 14), fill('f2', 3720, 0.2)],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    expect(estimate?.gph).toBe(14)
    expect(estimate?.sampleCount).toBe(1)
    expect(Number.isFinite(estimate?.gph ?? Number.NaN)).toBe(true)
    expect(estimate?.assumptions.map((a) => a.code)).toContain('excluded_no_engine_time')
  })

  it('falls back to the seed when every fill is unmeasurable', () => {
    const estimate = estimateBurnRate({
      stints: [],
      fills: [fill('f1', 3600, 14)],
      knownFullAt: T0,
      seedGph: 12.5,
    })

    expect(estimate?.method).toBe('seed')
    expect(estimate?.gph).toBe(12.5)
  })
})

describe('estimateBurnRate — rolling window and confidence', () => {
  const steady = (n: number) => {
    const stints: BurnRateStint[] = []
    const fills: BurnRateFill[] = []
    for (let i = 0; i < n; i++) {
      stints.push(stint(`s${i}`, i * 3600, (i + 1) * 3600))
      fills.push(fill(`f${i}`, (i + 1) * 3600, 14))
    }
    return { stints, fills }
  }

  it('grows in confidence as datapoints accumulate', () => {
    expect(estimateBurnRate({ ...steady(1), knownFullAt: T0, seedGph: null })?.confidence).toBe(
      'low',
    )
    expect(estimateBurnRate({ ...steady(2), knownFullAt: T0, seedGph: null })?.confidence).toBe(
      'medium',
    )
    expect(estimateBurnRate({ ...steady(3), knownFullAt: T0, seedGph: null })?.confidence).toBe(
      'high',
    )
  })

  it('only uses the most recent datapoints — the rolling part of the estimate', () => {
    const { stints, fills } = steady(6)
    // Rewrite the oldest fill to a wildly different volume. With a window of
    // 5 it is out of scope and must not move the answer.
    const first = fills[0]
    if (!first) throw new Error('unreachable')
    fills[0] = { ...first, gallons: 40 }

    const estimate = estimateBurnRate({ stints, fills, knownFullAt: T0, seedGph: null })

    expect(estimate?.gph).toBe(14)
    expect(estimate?.sampleCount).toBe(5)
    expect(estimate?.assumptions.map((a) => a.code)).toContain('rolling_window')
  })

  it('downgrades confidence when the datapoints disagree with each other', () => {
    const { stints, fills } = steady(3)
    const second = fills[1]
    if (!second) throw new Error('unreachable')
    // 14, 20, 14 — a spread wide enough that the pooled number is not
    // something to plan a fuel window around without saying so.
    fills[1] = { ...second, gallons: 20 }

    const estimate = estimateBurnRate({ stints, fills, knownFullAt: T0, seedGph: null })

    expect(estimate?.confidence).toBe('medium')
    expect(estimate?.spreadGph).toBeCloseTo(6, 10)
    expect(estimate?.assumptions.map((a) => a.code)).toContain('wide_spread')
  })

  it('reports no spread with a single datapoint', () => {
    expect(estimateBurnRate({ ...steady(1), knownFullAt: T0, seedGph: null })?.spreadGph).toBeNull()
  })
})

describe('estimateBurnRate — the fixture race', () => {
  const { race } = EIGHT_HOUR_RACE
  const start = new Date(race.startsAt)

  const stints: BurnRateStint[] = KNOWN_GOOD_SOLUTION.stints.map((s) => ({
    id: `stint-${s.sequence}`,
    driverId: s.driverKey,
    startedAt: new Date(start.getTime() + s.startOffsetSeconds * 1000),
    endedAt: new Date(start.getTime() + s.endOffsetSeconds * 1000),
  }))

  const fills: BurnRateFill[] = KNOWN_GOOD_SOLUTION.fills.map((f) => {
    const parent = KNOWN_GOOD_SOLUTION.stints.find((s) => s.sequence === f.afterStintSequence)
    if (!parent) throw new Error('unreachable: every fill follows a stint')
    return {
      id: `fill-${f.afterStintSequence}`,
      // Mid-stop, which is where a fill actually happens.
      filledAt: new Date(start.getTime() + (parent.endOffsetSeconds + 60) * 1000),
      gallons: f.gallons,
      filledToFull: true,
    }
  })

  it('recovers the modelled burn rate exactly — SPEC §7', () => {
    const estimate = estimateBurnRate({
      stints,
      fills,
      knownFullAt: start,
      seedGph: 11,
      windowSize: 10,
    })

    expect(estimate?.method).toBe('measured')
    expect(estimate?.gph).toBe(race.burnRateGph)
    expect(estimate?.gph).toBe(14)
    expect(estimate?.sampleCount).toBe(KNOWN_GOOD_SOLUTION.fills.length)
    expect(estimate?.spreadGph).toBe(0)
    expect(estimate?.confidence).toBe('high')
  })

  it('measures each stop at exactly the modelled rate', () => {
    const estimate = estimateBurnRate({
      stints,
      fills,
      knownFullAt: start,
      seedGph: 11,
      windowSize: 10,
    })

    for (const point of estimate?.datapoints ?? []) {
      expect(point.gph).toBe(14)
      expect(point.engineHours).toBe(4500 / 3600)
    }
  })

  it('ignores the hand-entered seed once there is real data', () => {
    const estimate = estimateBurnRate({ stints, fills, knownFullAt: start, seedGph: 99 })
    expect(estimate?.gph).toBe(14)
  })
})

describe('engine-hour accounting', () => {
  it('clips stints to the measurement window', () => {
    // The window opens mid-stint: only the part after the baseline counts.
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 2 * 3600)],
      fills: [fill('f1', 3600, 14), fill('f2', 2 * 3600, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(estimate?.datapoints.map((d) => d.engineHours)).toEqual([1, 1])
    expect(estimate?.gph).toBe(14)
  })

  it('is unaffected by how long the car sat between sessions', () => {
    const short = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 4000, 7600)],
      fills: [fill('f1', 3700, 14), fill('f2', 7700, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    const overnight = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 12 * 3600, 12 * 3600 + 3600)],
      fills: [fill('f1', 3700, 14), fill('f2', 12 * 3600 + 3700, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(short?.gph).toBe(14)
    expect(overnight?.gph).toBe(short?.gph)
  })

  it('does not double-count overlapping stint rows', () => {
    // Two devices logged the same stint slightly differently before syncing.
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s1-dup', 1800, 3600)],
      fills: [fill('f1', 3600, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(estimate?.datapoints[0]?.engineHours).toBe(1)
    expect(estimate?.gph).toBe(14)
  })
})

describe('the returned estimate is renderable without a bare number', () => {
  it('always carries at least one assumption the UI can show', () => {
    const seeded = estimateBurnRate({ fills: [], stints: [], knownFullAt: T0, seedGph: 12 })
    const measured = estimateBurnRate({
      stints: [stint('s1', 0, 3600)],
      fills: [fill('f1', 3600, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    for (const estimate of [seeded, measured]) {
      expect(estimate?.assumptions.length).toBeGreaterThan(0)
      for (const assumption of estimate?.assumptions ?? []) {
        expect(assumption.detail.length).toBeGreaterThan(0)
      }
    }
  })

  it('states that the starting tank was assumed full when that is what happened', () => {
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600)],
      fills: [fill('f1', 3600, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(estimate?.assumptions.map((a) => a.code)).toContain('assumed_full_at_baseline')
  })
})

describe('input validation', () => {
  it('rejects a negative or zero seed rather than planning around it', () => {
    expect(() => estimateBurnRate({ fills: [], stints: [], knownFullAt: T0, seedGph: 0 })).toThrow(
      /seed/i,
    )
  })

  it('rejects a window size below one', () => {
    expect(() =>
      estimateBurnRate({ fills: [], stints: [], knownFullAt: T0, seedGph: 12, windowSize: 0 }),
    ).toThrow(/window/i)
  })

  it('ignores a fill with a non-positive volume', () => {
    const estimate = estimateBurnRate({
      stints: [stint('s1', 0, 3600), stint('s2', 3600, 7200)],
      fills: [fill('f1', 3600, 0), fill('f2', 7200, 14)],
      knownFullAt: T0,
      seedGph: null,
    })

    expect(estimate?.sampleCount).toBe(1)
    expect(estimate?.gph).toBe(14)
  })
})
