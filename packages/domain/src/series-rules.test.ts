import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  minDriversForRace,
  parseSeriesRules,
  RULE_FIELD_PATHS,
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
    min_rest_seconds: 3600,
    min_drivers_per_event: [{ min_race_hours: 0, drivers: 2 }],
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

  it('accepts null for a limit the series does not impose', () => {
    // Null is a *checked* answer — 24 Hours of Lemons imposes no minimum stop
    // and no stint limits at all. Forcing a number here is how a planner ends
    // up enforcing a rule nobody wrote.
    const cfg = parseSeriesRules({
      ...minimal,
      pit: { ...minimal.pit, min_stop_seconds: null },
      driver: {
        ...minimal.driver,
        min_stint_seconds: null,
        max_stint_seconds: null,
        max_consecutive_stint_seconds: null,
        min_rest_seconds: null,
        max_share_of_race: null,
      },
    })

    expect(cfg.pit.min_stop_seconds).toBeNull()
    expect(cfg.driver.max_stint_seconds).toBeNull()
  })

  it('does not compare stint bounds when either is unimposed', () => {
    expect(() =>
      parseSeriesRules({
        ...minimal,
        driver: { ...minimal.driver, min_stint_seconds: 3600, max_stint_seconds: null },
      }),
    ).not.toThrow()
  })

  it('requires at least one driver-count tier', () => {
    expect(() =>
      parseSeriesRules({ ...minimal, driver: { ...minimal.driver, min_drivers_per_event: [] } }),
    ).toThrow()
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

      it('never claims verification without a source', () => {
        // AGENTS.md: "Never move status without a source." This is the rule
        // that keeps a plausible-looking guess from being promoted to a fact,
        // and it matters more now that some configs really are checked.
        const { verification } = parseSeriesRules(raw)
        if (verification.status === 'UNVERIFIED') return

        expect(verification.source, `${file} claims ${verification.status}`).toBeTruthy()
        expect(verification.checked_at).toBeTruthy()
      })

      it('only lists real rule fields as verified', () => {
        // A typo in verified_fields would silently suppress the on-screen
        // warning for a field that was never actually checked.
        for (const field of parseSeriesRules(raw).verification.verified_fields) {
          expect(RULE_FIELD_PATHS, `${file} lists unknown field ${field}`).toContain(field)
        }
      })

      it('lists a verified field for every value it claims to have checked', () => {
        const config = parseSeriesRules(raw)
        if (config.verification.status === 'UNVERIFIED') {
          expect(config.verification.verified_fields).toEqual([])
        }
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

describe('minDriversForRace', () => {
  const tiered = parseSeriesRules({
    ...minimal,
    driver: {
      ...minimal.driver,
      // ChampCar's actual shape: 2 up to 8 h, 3 from 9, 4 from 17.
      min_drivers_per_event: [
        { min_race_hours: 0, drivers: 2 },
        { min_race_hours: 9, drivers: 3 },
        { min_race_hours: 17, drivers: 4 },
      ],
    },
  })

  it('takes the base tier for a short race', () => {
    expect(minDriversForRace(tiered, 8 * 3600)).toBe(2)
  })

  it('takes the longest tier the race reaches, not the first it satisfies', () => {
    // A 24-hour race satisfies every tier; the answer is the strictest.
    expect(minDriversForRace(tiered, 24 * 3600)).toBe(4)
  })

  it('steps up at each boundary', () => {
    expect(minDriversForRace(tiered, 9 * 3600)).toBe(3)
    expect(minDriversForRace(tiered, 16.5 * 3600)).toBe(3)
    expect(minDriversForRace(tiered, 17 * 3600)).toBe(4)
  })

  it('falls back to one driver when no tier applies', () => {
    const late = parseSeriesRules({
      ...minimal,
      driver: { ...minimal.driver, min_drivers_per_event: [{ min_race_hours: 12, drivers: 3 }] },
    })
    expect(minDriversForRace(late, 4 * 3600)).toBe(1)
  })
})
