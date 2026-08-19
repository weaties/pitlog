/**
 * Series rule configs — SPEC §5.1 ("rule configs are data, not code").
 *
 * A config is YAML on disk (`config/series/*.yaml`) for the shipped defaults
 * and a JSON blob in `rule_configs` once an admin edits it. This module owns
 * the schema for both, so there is exactly one definition of what a rule
 * config may contain.
 *
 * SPEC §3 leaves the actual Lemons / Lucky Dog / ChampCar rule values
 * unresolved. Every shipped config is therefore `UNVERIFIED` with placeholder
 * numbers. `unverifiedFields()` exists so the planner can show which inputs
 * are guesses rather than presenting a schedule as authoritative.
 *
 * To add a series, see `.claude/skills/series-rules/SKILL.md`.
 */

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

export const SERIES_RULES_SCHEMA_VERSION = 1

const positiveSeconds = z.int().positive()
const optionalPositive = z.number().positive().nullable().default(null)

const verificationSchema = z
  .object({
    /**
     * UNVERIFIED — no value in this file has been checked against a rulebook.
     * PARTIAL    — the fields in `verified_fields` have been checked.
     * VERIFIED   — every rule field has been checked against `source`.
     */
    status: z.enum(['UNVERIFIED', 'PARTIAL', 'VERIFIED']).default('UNVERIFIED'),
    /** Citation for the rulebook the values came from. */
    source: z.string().nullable().default(null),
    /** ISO date (YYYY-MM-DD) the check was made. */
    checked_at: z.iso.date().nullable().default(null),
    /** Dotted paths, e.g. `pit.min_stop_seconds`. Only meaningful for PARTIAL. */
    verified_fields: z.array(z.string()).default([]),
  })
  .strict()
  .prefault({}) // prefault, not default: zod4 .default() bypasses parsing so inner defaults would not apply

const pitSchema = z
  .object({
    /** Minimum time the car must be stationary in the box. */
    min_stop_seconds: positiveSeconds,
    engine_off_for_fueling: z.boolean(),
    driver_in_car_during_fueling: z.boolean(),
    driver_change_during_fueling: z.boolean(),
    max_crew_over_wall: z.int().positive().nullable().default(null),
  })
  .strict()

const fuelingSchema = z
  .object({
    /** Series-imposed cap on tank size, independent of the car's actual tank. */
    max_fuel_capacity_gallons: optionalPositive,
    refuel_allowed_under_yellow: z.boolean(),
    /** True where fuel must come from cans rather than a rig/pump. */
    fuel_can_only: z.boolean(),
    max_can_size_gallons: optionalPositive,
  })
  .strict()

const driverFields = {
  min_stint_seconds: positiveSeconds,
  max_stint_seconds: positiveSeconds,
  max_consecutive_stint_seconds: positiveSeconds,
  min_drivers_per_event: z.int().positive(),
  /** Cap on one driver's share of total race time, as a fraction in (0,1]. */
  max_share_of_race: z.number().gt(0).lte(1),
} as const

const driverSchema = z
  .object(driverFields)
  .strict()
  .refine((d) => d.max_stint_seconds >= d.min_stint_seconds, {
    message: 'max_stint_seconds must be >= min_stint_seconds',
    path: ['max_stint_seconds'],
  })

export const seriesRulesConfigSchema = z
  .object({
    schema_version: z.literal(SERIES_RULES_SCHEMA_VERSION),
    /** Stable slug; matches the filename and the `series.key` column. */
    series_key: z
      .string()
      .regex(/^[a-z][a-z0-9]*$/, 'series_key must be a lowercase alphanumeric slug'),
    display_name: z.string().min(1),
    /** Bumped by hand on every edit; `rule_configs` keeps history per version. */
    config_version: z.int().positive(),
    notes: z.string().optional(),
    verification: verificationSchema,
    pit: pitSchema,
    fueling: fuelingSchema,
    driver: driverSchema,
  })
  .strict()

export type SeriesRulesConfig = z.infer<typeof seriesRulesConfigSchema>

/** Dotted paths of every rule value a planner run actually consumes. */
export const RULE_FIELD_PATHS: readonly string[] = [
  ...Object.keys(pitSchema.shape).map((k) => `pit.${k}`),
  ...Object.keys(fuelingSchema.shape).map((k) => `fueling.${k}`),
  ...Object.keys(driverFields).map((k) => `driver.${k}`),
]

/**
 * Parse a rule config from a YAML string or an already-decoded object.
 * Throws a `ZodError` on anything malformed — configs are small and
 * hand-edited, so failing loudly beats coercing.
 */
export function parseSeriesRules(input: string | unknown): SeriesRulesConfig {
  const raw = typeof input === 'string' ? parseYaml(input) : input
  return seriesRulesConfigSchema.parse(raw)
}

/**
 * Rule fields whose values have not been checked against a rulebook.
 * The planner must surface these; SPEC §5.1 requires showing assumptions
 * rather than a bare number.
 */
export function unverifiedFields(config: SeriesRulesConfig): string[] {
  if (config.verification.status === 'VERIFIED') return []
  const verified = new Set(config.verification.verified_fields)
  return RULE_FIELD_PATHS.filter((path) => !verified.has(path))
}
