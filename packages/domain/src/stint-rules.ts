/**
 * How the planner reads a series rule config — SPEC §5.1, #6.
 *
 * "Rule configs are data, not code" means the difference between two series is
 * the numbers in their config and nothing else. Nothing in this module or the
 * solver branches on `series_key`; it is an identifier, not a switch.
 *
 * The two field lists below must between them cover every rule field in the
 * schema. A test asserts exactly that, which is what makes #6's "adding a rule
 * field requires no solver change beyond reading it" enforceable rather than
 * aspirational: a new field fails the test until someone decides whether the
 * planner acts on it or explicitly does not.
 */

import type { BurnRateAssumption, BurnRateEstimate } from './burn-rate.js'
import type { SeriesRulesConfig } from './series-rules.js'
import { unverifiedFields } from './series-rules.js'

/** Rule fields that change the plan. */
export const CONSUMED_RULE_FIELDS: readonly string[] = [
  'pit.min_stop_seconds',
  'fueling.max_fuel_capacity_gallons',
  'driver.min_stint_seconds',
  'driver.max_stint_seconds',
  'driver.max_consecutive_stint_seconds',
  'driver.min_drivers_per_event',
  'driver.max_share_of_race',
]

/**
 * Rule fields the v1 solver deliberately does not model.
 *
 * These describe pit *procedure* — whether the engine is off, who is over the
 * wall, how big a can is. Turning them into seconds would mean inventing
 * numbers, which is exactly what SPEC §3 and the `series-rules` skill forbid
 * while the rulebooks are unread. They are reported on the plan instead, so a
 * crew chief can see what the schedule does not account for.
 */
export const UNMODELLED_RULE_FIELDS: readonly string[] = [
  'pit.engine_off_for_fueling',
  'pit.driver_in_car_during_fueling',
  'pit.driver_change_during_fueling',
  'pit.max_crew_over_wall',
  'fueling.refuel_allowed_under_yellow',
  'fueling.fuel_can_only',
  'fueling.max_can_size_gallons',
]

/**
 * The stop length actually planned for: whichever is longer, the time the crew
 * expects to take or the minimum the series imposes. A series minimum is a
 * floor on how long you must sit there, not a target.
 */
export function effectivePitStopSeconds(
  pitStopSeconds: number,
  rules: SeriesRulesConfig | null,
): number {
  return Math.max(pitStopSeconds, rules?.pit.min_stop_seconds ?? 0)
}

/** The car's tank, or the series cap on it, whichever is smaller. */
export function effectiveFuelCapacityGallons(
  fuelCapacityGallons: number,
  rules: SeriesRulesConfig | null,
): number {
  return Math.min(
    fuelCapacityGallons,
    rules?.fueling.max_fuel_capacity_gallons ?? Number.POSITIVE_INFINITY,
  )
}

export interface PlanRuleConfig {
  seriesKey: string
  configVersion: number
  verificationStatus: SeriesRulesConfig['verification']['status']
  unverifiedFields: string[]
  unmodelledFields: string[]
}

/** Widened over the burn-rate codes so one panel can render the whole list. */
export type PlanAssumption = BurnRateAssumption<string>

export function describeRules(rules: SeriesRulesConfig | null): PlanRuleConfig | null {
  if (!rules) return null
  return {
    seriesKey: rules.series_key,
    configVersion: rules.config_version,
    verificationStatus: rules.verification.status,
    unverifiedFields: unverifiedFields(rules),
    unmodelledFields: [...UNMODELLED_RULE_FIELDS],
  }
}

export function buildAssumptions(
  burnRate: BurnRateEstimate,
  rules: SeriesRulesConfig | null,
): PlanAssumption[] {
  const assumptions: PlanAssumption[] = burnRate.assumptions.map((a) => ({ ...a }))

  if (!rules) {
    assumptions.push({
      code: 'no_rule_config',
      detail:
        'No series rule config was supplied, so the plan is bound only by the tank, the roster, and the pit time entered by hand.',
    })
    return assumptions
  }

  const unverified = unverifiedFields(rules)
  if (unverified.length > 0) {
    assumptions.push({
      code: 'unverified_rule_config',
      detail: `${unverified.length} of the ${rules.display_name} rule values have not been checked against a rulebook. This schedule is built on placeholders.`,
    })
  }

  assumptions.push({
    code: 'unmodelled_rule_fields',
    detail: `The plan does not model pit procedure: ${UNMODELLED_RULE_FIELDS.join(', ')}.`,
  })

  return assumptions
}
