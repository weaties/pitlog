/**
 * Deterministic identifiers and reference data for the seed.
 *
 * Every id is a fixed UUID rather than a generated one so that reseeding
 * produces the same database, Playwright fixtures can hard-code ids, and a
 * failing test names a row you can go and look at.
 */

export const DEMO_TEAM = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Rusty Nail Racing',
  slug: 'rusty-nail-racing',
} as const

/**
 * One user per role so the role gates have something to exercise end to end.
 * Local dev uses `MAIL_TRANSPORT=console`, so signing in as any of these is a
 * matter of requesting a link and reading it out of the API log.
 */
export const DEMO_USERS = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    email: 'admin@example.com',
    display_name: 'Dana Admin',
    role: 'admin',
  },
  {
    id: '00000000-0000-4000-8000-000000000012',
    email: 'crew@example.com',
    display_name: 'Kim Crew',
    role: 'crew',
  },
  {
    id: '00000000-0000-4000-8000-000000000013',
    email: 'visitor@example.com',
    display_name: 'Sam Visitor',
    role: 'visitor',
  },
] as const

/** Filenames under `config/series/`, which are also the `series.key` values. */
export const SERIES_KEYS = ['lemons', 'luckydog', 'champcar'] as const

export const SERIES_IDS: Record<(typeof SERIES_KEYS)[number], string> = {
  lemons: '00000000-0000-4000-8000-000000000021',
  luckydog: '00000000-0000-4000-8000-000000000022',
  champcar: '00000000-0000-4000-8000-000000000023',
}

export const RULE_CONFIG_IDS: Record<(typeof SERIES_KEYS)[number], string> = {
  lemons: '00000000-0000-4000-8000-000000000031',
  luckydog: '00000000-0000-4000-8000-000000000032',
  champcar: '00000000-0000-4000-8000-000000000033',
}
