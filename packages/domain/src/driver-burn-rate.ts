/**
 * Per-driver burn-rate adjustment — SPEC §5.1.
 *
 * Drivers do not all drink fuel at the same rate, and `drivers.burn_rate_factor`
 * exists to say so. The interesting part of this module is not applying the
 * factor; it is **refusing to**.
 *
 * With three stints on the board, per-driver variance is fill-measurement
 * error wearing a hat. A solver that acted on it would plan a shorter fuel
 * window for whoever happened to get the two stints with a slightly generous
 * brim, and short-change a real person at a real race. So the model states
 * which mode it used and why, every time, and falls back to the team average
 * unless the data clears three explicit bars.
 *
 * A factor is measured against **every** attributable datapoint rather than the
 * team's rolling window: how heavy-footed someone is belongs to the person, not
 * to this afternoon's weather. The rate to plan with is then the *current* team
 * rate times that factor, so the driver's number tracks changing conditions
 * while the factor stays still.
 */

import type {
  BurnRateAssumption,
  BurnRateDatapoint,
  BurnRateEstimate,
  BurnRateInput,
} from './burn-rate.js'
import {
  collectBurnRateDatapoints,
  estimateBurnRate,
  mergeIntervals,
  pooledGph,
  runningHoursBetween,
} from './burn-rate.js'

/**
 * Fills attributable to one driver before a factor is derived from them.
 *
 * Three is the first count at which a disagreement can outvote a single bad
 * measurement. Two datapoints that differ tell you nothing about which one is
 * wrong, and a brim fill is easy to get wrong: a slightly different nozzle
 * angle is a quarter of a gallon, which is 2% of a stint.
 */
const MIN_DRIVER_DATAPOINTS = 3

/**
 * Engine hours attributable to one driver before a factor is derived.
 *
 * The count bar alone can be cleared by three ten-minute runs, where the fixed
 * error in each brim measurement is a large fraction of a small volume. Two
 * hours is roughly two race stints — enough that the volumes being divided are
 * big enough for the error to wash out.
 */
const MIN_DRIVER_ENGINE_HOURS = 2

/**
 * How far from the team rate a driver must be before the difference is worth
 * acting on. Below 5% the honest answer is "the same as everyone else": the
 * measurement error on a brim fill is itself a couple of percent, and planning
 * a fuel window on a factor of 1.02 is false precision that reads as knowledge.
 */
const MIN_MEANINGFUL_DEVIATION = 0.05

/**
 * Share of a window's engine time one driver must hold for the window to be
 * theirs. Not 100%, because a driver-change lap is logged to the second by a
 * human with a clipboard and the boundaries will never line up exactly.
 */
const SINGLE_DRIVER_COVERAGE = 0.99

export interface DriverBurnRateSubject {
  id: string
  /** `drivers.burn_rate_factor` — hand-entered, or derived on a previous run. */
  storedFactor: number | null
}

export interface DriverBurnRateInput extends BurnRateInput {
  drivers: readonly DriverBurnRateSubject[]
}

export type DriverBurnRateMethod = 'measured' | 'stored' | 'team_average'

export type DriverBurnRateAssumptionCode =
  | 'driver_measured'
  | 'insufficient_driver_data'
  | 'driver_deviation_within_noise'
  | 'mixed_window_excluded'
  | 'stored_factor_used'
  | 'stored_factor_disagrees'

export interface DriverBurnRate {
  driverId: string
  /** Multiplier on the team rate. Exactly 1 whenever it was not measured. */
  factor: number
  /** The rate to plan this driver's stints with: team rate × factor. */
  gph: number
  method: DriverBurnRateMethod
  /** Datapoints attributed to this driver alone. */
  sampleCount: number
  engineHours: number
  /** Never empty. SPEC §5.1 forbids presenting the number on its own. */
  assumptions: BurnRateAssumption<DriverBurnRateAssumptionCode>[]
}

export interface DriverBurnRates {
  team: BurnRateEstimate
  drivers: DriverBurnRate[]
}

/**
 * Team burn rate plus a per-driver adjustment for each named driver.
 *
 * Returns `null` for the same reason `estimateBurnRate` does: with neither a
 * seed nor a measurable fill, the honest answer is that nobody knows.
 */
export function estimateDriverBurnRates(input: DriverBurnRateInput): DriverBurnRates | null {
  for (const driver of input.drivers) {
    if (driver.storedFactor !== null && !(driver.storedFactor > 0)) {
      throw new Error(
        `stored burn rate factor for ${driver.id} must be positive, got ${driver.storedFactor}`,
      )
    }
  }

  const team = estimateBurnRate(input)
  if (team === null) return null

  const { datapoints } = collectBurnRateDatapoints(input)
  const teamBaseline = datapoints.length > 0 ? pooledGph(datapoints) : team.gph
  const attribution = attribute(datapoints, input.stints)

  const drivers = input.drivers.map((driver) =>
    resolveDriver(driver, attribution.get(driver.id), team.gph, teamBaseline),
  )

  return { team, drivers }
}

interface Attributed {
  datapoints: BurnRateDatapoint[]
  /** Windows this driver drove part of, but not all of. */
  mixedWindows: number
}

/**
 * Assign each datapoint to the driver who ran all of it, if there is one.
 *
 * A window two drivers shared measures the pair, not either of them. Splitting
 * it proportionally would be inferring individual rates from a blend, which is
 * a regression problem the v1 model has no business attempting — and would
 * quietly manufacture exactly the confident-looking number this module exists
 * to withhold.
 */
function attribute(
  datapoints: readonly BurnRateDatapoint[],
  stints: DriverBurnRateInput['stints'],
): Map<string, Attributed> {
  const byDriver = new Map<string, DriverBurnRateInput['stints'][number][]>()
  for (const stint of stints) {
    if (stint.driverId === null) continue
    const list = byDriver.get(stint.driverId) ?? []
    list.push(stint)
    byDriver.set(stint.driverId, list)
  }

  const merged = new Map<string, ReturnType<typeof mergeIntervals>>()
  for (const [driverId, list] of byDriver) merged.set(driverId, mergeIntervals(list))

  const result = new Map<string, Attributed>()
  const ensure = (driverId: string): Attributed => {
    const existing = result.get(driverId)
    if (existing) return existing
    const fresh: Attributed = { datapoints: [], mixedWindows: 0 }
    result.set(driverId, fresh)
    return fresh
  }

  for (const point of datapoints) {
    const shares: { driverId: string; hours: number }[] = []
    for (const [driverId, intervals] of merged) {
      const hours = runningHoursBetween(intervals, point.windowStart, point.windowEnd)
      if (hours > 0) shares.push({ driverId, hours })
    }

    const sole = shares.find((s) => s.hours >= point.engineHours * SINGLE_DRIVER_COVERAGE)
    if (sole) {
      ensure(sole.driverId).datapoints.push(point)
      continue
    }
    for (const share of shares) ensure(share.driverId).mixedWindows += 1
  }

  return result
}

function resolveDriver(
  driver: DriverBurnRateSubject,
  attributed: Attributed | undefined,
  teamGph: number,
  teamBaseline: number,
): DriverBurnRate {
  const datapoints = attributed?.datapoints ?? []
  const mixedWindows = attributed?.mixedWindows ?? 0
  const engineHours = datapoints.reduce((sum, d) => sum + d.engineHours, 0)
  const assumptions: BurnRateAssumption<DriverBurnRateAssumptionCode>[] = []

  if (mixedWindows > 0) {
    assumptions.push({
      code: 'mixed_window_excluded',
      detail: `${mixedWindows} fill${mixedWindows === 1 ? '' : 's'} covered more than one driver and cannot be attributed to anyone.`,
    })
  }

  const hasEnoughData =
    datapoints.length >= MIN_DRIVER_DATAPOINTS && engineHours >= MIN_DRIVER_ENGINE_HOURS

  const teamAverage = (): DriverBurnRate => ({
    driverId: driver.id,
    factor: 1,
    gph: teamGph,
    method: 'team_average',
    sampleCount: datapoints.length,
    engineHours,
    assumptions,
  })

  if (!hasEnoughData) {
    if (driver.storedFactor !== null) {
      assumptions.push({
        code: 'stored_factor_used',
        detail: `Not enough data to measure this driver, so the saved factor of ${driver.storedFactor} is being applied.`,
      })
      return {
        driverId: driver.id,
        factor: driver.storedFactor,
        gph: teamGph * driver.storedFactor,
        method: 'stored',
        sampleCount: datapoints.length,
        engineHours,
        assumptions,
      }
    }

    assumptions.push({
      code: 'insufficient_driver_data',
      detail: `Planning at the team rate: ${datapoints.length} full-tank fill${datapoints.length === 1 ? '' : 's'} and ${engineHours.toFixed(1)} h attributable to this driver, below the ${MIN_DRIVER_DATAPOINTS} fills and ${MIN_DRIVER_ENGINE_HOURS} h needed to justify a factor.`,
    })
    return teamAverage()
  }

  const factor = pooledGph(datapoints) / teamBaseline
  const deviation = Math.abs(factor - 1)

  if (
    driver.storedFactor !== null &&
    Math.abs(driver.storedFactor - factor) > MIN_MEANINGFUL_DEVIATION
  ) {
    // Surfaced rather than silently overwritten: whoever typed the saved value
    // may know something the fills do not, and should get to see the clash.
    assumptions.push({
      code: 'stored_factor_disagrees',
      detail: `The saved factor is ${driver.storedFactor}; the logged fills measure ${factor.toFixed(2)}.`,
    })
  }

  if (deviation < MIN_MEANINGFUL_DEVIATION) {
    assumptions.push({
      code: 'driver_deviation_within_noise',
      detail: `Measured within ${(deviation * 100).toFixed(1)}% of the team rate, which is inside fill-measurement error. Planning at the team rate.`,
    })
    return teamAverage()
  }

  assumptions.push({
    code: 'driver_measured',
    detail: `Measured from ${datapoints.length} full-tank fills over ${engineHours.toFixed(1)} h: ${(factor * 100 - 100).toFixed(0)}% ${factor > 1 ? 'heavier' : 'lighter'} than the team rate.`,
  })

  return {
    driverId: driver.id,
    factor,
    gph: teamGph * factor,
    method: 'measured',
    sampleCount: datapoints.length,
    engineHours,
    assumptions,
  }
}
