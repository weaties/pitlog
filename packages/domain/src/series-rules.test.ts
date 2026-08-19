import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseSeriesRules,
  SERIES_RULES_SCHEMA_VERSION,
  seriesRulesConfigSchema,
  unverifiedFields,
} from './series-rules.js'

const SERIES_DIR = join(import.meta.dirname, '../../../config/series')

const minimal = {
  schema_version: SERIES_RULES_SCHEMA_VERSION,
  series_key: 'testseries',
  display_name: 'Test Series',
  config_version: 1,
  verification: { status: 'UNVERIFIED', source: null, checked_at: null, verified_fields: [] },
  pit: {
    min_stop_seconds: 300,
    engine_off_for_fueling: true,
    driver_in_car_during_fueling: false,
    driver_change_during_fueling: false,
    max_crew_over_wall: null,
  },
  fueling: {
    max_fuel_capacity_gallons: null,
    refuel_allowed_under_yellow: true,
    fuel_can_only: true,
    max_can_size_gallons: null,
  },
  driver: {
    min_stint_seconds: 1800,
    max_stint_seconds: 7200,
    max_consecutive_stint_seconds: 7200,
    min_drivers_per_event: 2,
    max_share_of_race: 0.6,
  },
}

describe('seriesRulesConfigSchema', () => {
  it('accepts a well-formed config', () => {
    expect(() => parseSeriesRules(minimal)).not.toThrow()
  })

  it('rejects a config with the wrong schema_version', () => {
    expect(() => parseSeriesRules({ ...minimal, schema_version: 99 })).toThrow()
  })

  it('rejects a series_key that is not a lowercase slug', () => {
    for (const bad of ['Lemons', 'lucky dog', 'champ_car!', '']) {
      expect(() => parseSeriesRules({ ...minimal, series_key: bad }), bad).toThrow()
    }
  })

  it('rejects non-positive durations', () => {
    expect(() =>
      parseSeriesRules({ ...minimal, pit: { ...minimal.pit, min_stop_seconds: 0 } }),
    ).toThrow()
    expect(() =>
      parseSeriesRules({ ...minimal, driver: { ...minimal.driver, min_stint_seconds: -1 } }),
    ).toThrow()
  })

  it('rejects a driver max_stint shorter than min_stint', () => {
    expect(() =>
      parseSeriesRules({
        ...minimal,
        driver: { ...minimal.driver, min_stint_seconds: 3600, max_stint_seconds: 1800 },
      }),
    ).toThrow(/max_stint_seconds/)
  })

  it('rejects a max_share_of_race outside (0,1]', () => {
    for (const bad of [0, 1.5, -0.2]) {
      expect(() =>
        parseSeriesRules({ ...minimal, driver: { ...minimal.driver, max_share_of_race: bad } }),
      ).toThrow()
    }
  })

  it('defaults verification.status to UNVERIFIED when the block is absent', () => {
    const { verification, ...withoutVerification } = minimal
    void verification
    expect(parseSeriesRules(withoutVerification).verification.status).toBe('UNVERIFIED')
  })

  it('is strict about unknown keys so a typo in a rule name is not silently ignored', () => {
    expect(() => parseSeriesRules({ ...minimal, min_stop_secondz: 1 })).toThrow()
  })
})

describe('unverifiedFields', () => {
  it('reports every rule field when nothing is verified', () => {
    const cfg = parseSeriesRules(minimal)
    const fields = unverifiedFields(cfg)
    expect(fields).toContain('pit.min_stop_seconds')
    expect(fields).toContain('driver.min_stint_seconds')
    expect(fields).toContain('fueling.fuel_can_only')
    expect(fields).not.toContain('display_name')
  })

  it('omits fields listed in verification.verified_fields', () => {
    const cfg = parseSeriesRules({
      ...minimal,
      verification: {
        status: 'PARTIAL',
        source: 'https://example.invalid/rulebook.pdf',
        checked_at: '2026-08-19',
        verified_fields: ['pit.min_stop_seconds'],
      },
    })
    expect(unverifiedFields(cfg)).not.toContain('pit.min_stop_seconds')
    expect(unverifiedFields(cfg)).toContain('driver.min_stint_seconds')
  })

  it('reports nothing when the config is fully VERIFIED', () => {
    const cfg = parseSeriesRules({ ...minimal, verification: { status: 'VERIFIED' } })
    expect(unverifiedFields(cfg)).toEqual([])
  })
})

describe('shipped series configs (config/series/*.yaml)', () => {
  const files = readdirSync(SERIES_DIR).filter((f) => f.endsWith('.yaml'))

  it('ships a config for each series named in SPEC §1', () => {
    expect(files.sort()).toEqual(['champcar.yaml', 'lemons.yaml', 'luckydog.yaml'])
  })

  for (const file of files) {
    describe(file, () => {
      const raw = readFileSync(join(SERIES_DIR, file), 'utf8')

      it('parses against the schema', () => {
        expect(() => parseSeriesRules(raw)).not.toThrow()
      })

      it('is marked UNVERIFIED — SPEC §3 leaves real rule values unresolved', () => {
        expect(parseSeriesRules(raw).verification.status).toBe('UNVERIFIED')
      })

      it('has a series_key matching its filename', () => {
        expect(parseSeriesRules(raw).series_key).toBe(file.replace(/\.yaml$/, ''))
      })
    })
  }
})

describe('seriesRulesConfigSchema export', () => {
  it('is the zod schema, exported so callers can compose it', () => {
    expect(seriesRulesConfigSchema.safeParse(minimal).success).toBe(true)
  })
})
