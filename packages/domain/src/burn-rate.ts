/**
 * The burn-rate model — SPEC §5.1.
 *
 * A rolling estimate of how fast the car drinks fuel, derived from logged
 * fills. Framework-free by design: the API hands it rows, it hands back a
 * number *and the reasons that number should or should not be trusted*.
 *
 * Two things about this module are load-bearing and easy to get wrong:
 *
 * 1. **Only a brim fill is a datapoint.** A fill measures consumption only if
 *    the tank was full at both ends of the window — "how much did it take to
 *    refill" is the measurement. A splash-and-go tells you nothing, because
 *    neither the starting nor the ending level is known.
 *
 * 2. **The denominator is engine hours, not wall-clock.** The car is not
 *    burning fuel while it sits in the box, and a long yellow or an overnight
 *    break would otherwise drag the estimate toward zero. Running time comes
 *    from the stint rows.
 *
 * SPEC §5.1: "Show confidence/assumptions, never just a number." That is why
 * there is no function here that returns a bare `number`, and why every
 * estimate carries at least one assumption.
 */

const MS_PER_HOUR = 3_600_000

/** How many of the most recent datapoints the rolling estimate uses. */
const DEFAULT_WINDOW_SIZE = 5

/**
 * Relative spread above which confidence drops a level. A judgment call, not a
 * derived constant: at 15% the difference between the optimistic and
 * pessimistic datapoint is roughly a lap of fuel on a 90-minute stint, which is
 * the point where a crew chief would want to know the number is soft rather
 * than see three significant figures.
 */
const WIDE_SPREAD_RATIO = 0.15

export interface BurnRateStint {
  id: string
  driverId: string | null
  startedAt: Date
  /** Null while the stint is still running. */
  endedAt: Date | null
}

export interface BurnRateFill {
  id: string
  filledAt: Date
  gallons: number
  /** Only a brim fill is a usable burn-rate datapoint. */
  filledToFull: boolean
}

export interface BurnRateInput {
  fills: readonly BurnRateFill[]
  stints: readonly BurnRateStint[]
  /**
   * The instant the tank was last known full before the first fill — normally
   * the session start, where the car rolls out brimmed. Null when nobody
   * recorded it, in which case the first brim fill becomes the baseline and
   * measures nothing itself.
   */
  knownFullAt: Date | null
  /** Hand-entered starting estimate (`events.burn_rate_gph`). */
  seedGph: number | null
  windowSize?: number
}

export type BurnRateMethod = 'seed' | 'measured'

export type BurnRateConfidence = 'none' | 'low' | 'medium' | 'high'

export type BurnRateAssumptionCode =
  | 'seeded_no_data'
  | 'single_datapoint'
  | 'ignored_partial_fills'
  | 'assumed_full_at_baseline'
  | 'baseline_from_first_fill'
  | 'excluded_no_engine_time'
  | 'rolling_window'
  | 'wide_spread'

/**
 * Generic over the code so the per-driver model can add its own vocabulary
 * without this module knowing about it, while #7 can still render a mixed list.
 */
export interface BurnRateAssumption<Code extends string = BurnRateAssumptionCode> {
  code: Code
  /** Plain-English statement for the UI. The code is what tests assert on. */
  detail: string
}

export interface BurnRateDatapoint {
  fillId: string
  gallons: number
  engineHours: number
  gph: number
  /** The tank was last known full here. */
  windowStart: Date
  /** …and full again here. Exposed so a per-driver model can ask who was
   *  actually driving for this measurement, and so the UI can show it. */
  windowEnd: Date
}

export interface BurnRateEstimate {
  gph: number
  method: BurnRateMethod
  confidence: BurnRateConfidence
  /** Datapoints inside the rolling window — the inputs behind `gph`. */
  datapoints: BurnRateDatapoint[]
  sampleCount: number
  /** Fastest minus slowest datapoint. Null with fewer than two. */
  spreadGph: number | null
  /** Never empty. SPEC §5.1 forbids presenting the number on its own. */
  assumptions: BurnRateAssumption[]
}

/**
 * Estimate the team's burn rate.
 *
 * Returns `null` when there is neither a seed nor a measurable fill — the
 * honest answer is "unknown", and the planner must refuse to run rather than
 * invent a fuel window.
 */
export function estimateBurnRate(input: BurnRateInput): BurnRateEstimate | null {
  const windowSize = input.windowSize ?? DEFAULT_WINDOW_SIZE
  if (!Number.isFinite(windowSize) || windowSize < 1) {
    throw new Error(`window size must be at least 1, got ${windowSize}`)
  }
  if (input.seedGph !== null && !(input.seedGph > 0)) {
    throw new Error(`seed burn rate must be positive, got ${input.seedGph}`)
  }

  const { datapoints: all, assumptions } = collectBurnRateDatapoints(input)

  if (all.length === 0) {
    if (input.seedGph === null) return null
    assumptions.push({
      code: 'seeded_no_data',
      detail: `No full-tank fills logged yet — using the hand-entered seed of ${input.seedGph} gal/h.`,
    })
    return {
      gph: input.seedGph,
      method: 'seed',
      confidence: 'none',
      datapoints: [],
      sampleCount: 0,
      spreadGph: null,
      assumptions,
    }
  }

  const datapoints = all.slice(-windowSize)
  if (all.length > datapoints.length) {
    assumptions.push({
      code: 'rolling_window',
      detail: `Using the most recent ${datapoints.length} of ${all.length} full-tank fills.`,
    })
  }

  if (input.knownFullAt !== null) {
    assumptions.push({
      code: 'assumed_full_at_baseline',
      detail: 'The tank was taken to be full at the start of the first measured window.',
    })
  }

  // Pool the window rather than averaging the per-fill rates: a two-hour run
  // is twice the evidence of a one-hour run, and averaging ratios would give
  // them equal weight.
  const gph = pooledGph(datapoints)

  const rates = datapoints.map((d) => d.gph)
  const spreadGph = datapoints.length < 2 ? null : Math.max(...rates) - Math.min(...rates)

  let confidence = baseConfidence(datapoints.length)
  if (spreadGph !== null && spreadGph / gph > WIDE_SPREAD_RATIO) {
    confidence = downgrade(confidence)
    assumptions.push({
      code: 'wide_spread',
      detail: `Fills disagree by ${spreadGph.toFixed(1)} gal/h; treat the fuel window as approximate.`,
    })
  }

  if (datapoints.length === 1) {
    assumptions.push({
      code: 'single_datapoint',
      detail: 'Based on one full-tank fill. One stop is not yet a trend.',
    })
  }

  return {
    gph,
    method: 'measured',
    confidence,
    datapoints,
    sampleCount: datapoints.length,
    spreadGph,
    assumptions,
  }
}

export interface BurnRateDatapointCollection {
  datapoints: BurnRateDatapoint[]
  assumptions: BurnRateAssumption[]
}

/**
 * Walk the fills and turn each measurable one into a datapoint.
 *
 * Extracted so `estimateBurnRate` and the per-driver model share exactly one
 * definition of "what a measurement window is". They differ in what they do
 * with the result — the team rate rolls over the recent few, a driver factor
 * uses every one it can attribute — but not in how a window is found.
 */
export function collectBurnRateDatapoints(
  input: Pick<BurnRateInput, 'fills' | 'stints' | 'knownFullAt'>,
): BurnRateDatapointCollection {
  const assumptions: BurnRateAssumption[] = []
  const running = mergeIntervals(input.stints)

  const brimFills = [...input.fills]
    .filter((f) => f.filledToFull)
    .sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime())

  const partialCount = input.fills.length - brimFills.length
  if (partialCount > 0) {
    assumptions.push({
      code: 'ignored_partial_fills',
      detail: `${partialCount} fill${partialCount === 1 ? ' was' : 's were'} not to the brim and cannot measure consumption.`,
    })
  }

  const datapoints: BurnRateDatapoint[] = []
  let baseline = input.knownFullAt
  let unmeasurable = 0

  for (const fill of brimFills) {
    if (baseline === null) {
      // Nothing to measure against, but the tank is full now, so this fill is
      // the baseline for the next one.
      baseline = fill.filledAt
      assumptions.push({
        code: 'baseline_from_first_fill',
        detail:
          'The starting fuel level was never recorded, so the first fill sets the baseline and is not itself a datapoint.',
      })
      continue
    }

    const windowStart = baseline
    const engineHours = runningHoursBetween(running, windowStart, fill.filledAt)
    baseline = fill.filledAt

    // A zero-volume brim fill means the tank was already full: it moves the
    // baseline and carries no information. Same for a fill after no running
    // time, which is also the divide-by-zero guard.
    if (!(fill.gallons > 0)) continue
    if (engineHours <= 0) {
      unmeasurable += 1
      continue
    }

    datapoints.push({
      fillId: fill.id,
      gallons: fill.gallons,
      engineHours,
      gph: fill.gallons / engineHours,
      windowStart,
      windowEnd: fill.filledAt,
    })
  }

  if (unmeasurable > 0) {
    assumptions.push({
      code: 'excluded_no_engine_time',
      detail: `${unmeasurable} fill${unmeasurable === 1 ? '' : 's'} followed no running time and could not be measured.`,
    })
  }

  return { datapoints, assumptions }
}

/** Pooled rate over a set of datapoints: total gallons over total hours. */
export function pooledGph(datapoints: readonly BurnRateDatapoint[]): number {
  const gallons = datapoints.reduce((sum, d) => sum + d.gallons, 0)
  const hours = datapoints.reduce((sum, d) => sum + d.engineHours, 0)
  return gallons / hours
}

function baseConfidence(sampleCount: number): BurnRateConfidence {
  if (sampleCount >= 3) return 'high'
  if (sampleCount === 2) return 'medium'
  return 'low'
}

function downgrade(confidence: BurnRateConfidence): BurnRateConfidence {
  if (confidence === 'high') return 'medium'
  if (confidence === 'medium') return 'low'
  return confidence
}

export interface Interval {
  start: number
  end: number
}

/**
 * Running time as non-overlapping intervals.
 *
 * Overlap is not hypothetical: two devices can log the same stint slightly
 * differently and both rows survive until someone reconciles them. Summing the
 * rows directly would double-count that time and halve the burn rate.
 */
export function mergeIntervals(stints: readonly BurnRateStint[]): Interval[] {
  const raw = stints
    .map((s) => ({
      start: s.startedAt.getTime(),
      // A running stint is open-ended; it is clipped to the window later.
      end: s.endedAt === null ? Number.POSITIVE_INFINITY : s.endedAt.getTime(),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)

  const merged: Interval[] = []
  for (const interval of raw) {
    const last = merged.at(-1)
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end)
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

/** Hours the car was running between two instants. */
export function runningHoursBetween(running: readonly Interval[], from: Date, to: Date): number {
  const start = from.getTime()
  const end = to.getTime()
  if (end <= start) return 0

  let ms = 0
  for (const interval of running) {
    if (interval.start >= end) break
    const overlap = Math.min(interval.end, end) - Math.max(interval.start, start)
    if (overlap > 0) ms += overlap
  }
  return ms / MS_PER_HOUR
}
