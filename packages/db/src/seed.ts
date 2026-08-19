import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSeriesRules } from '@pitlog/domain'
import { createDb } from './client.js'
import { requireDatabaseUrl } from './load-env.js'
import * as s from './schema.js'
import { DEMO_TEAM, DEMO_USERS, RULE_CONFIG_IDS, SERIES_IDS, SERIES_KEYS } from './seed-data.js'
import { seedFixtureRace } from './seed-fixture-race.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const log = (msg: string) => {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`seed: ${msg}`)
}

const { db, sql, close } = createDb({ databaseUrl: requireDatabaseUrl(), max: 1, quiet: true })

try {
  // Truncating rather than upserting keeps the seed honest: whatever you were
  // poking at in the UI is gone, and what remains is exactly what this script
  // writes. `make seed` is a reset, not a merge.
  log('truncating')
  // teams + users are the two roots; `cascade` reaches every domain table
  // through their foreign keys.
  await sql`truncate table teams, users restart identity cascade`

  log(`team ${DEMO_TEAM.slug}`)
  await db.insert(s.teams).values({ id: DEMO_TEAM.id, name: DEMO_TEAM.name, slug: DEMO_TEAM.slug })

  log(`${DEMO_USERS.length} users + memberships`)
  await db
    .insert(s.users)
    .values(DEMO_USERS.map((u) => ({ id: u.id, email: u.email, display_name: u.display_name })))
  await db.insert(s.memberships).values(
    DEMO_USERS.map((u, i) => ({
      id: `00000000-0000-4000-8000-0000000001${String(i + 10)}`,
      team_id: DEMO_TEAM.id,
      user_id: u.id,
      role: u.role,
    })),
  )

  log(`${SERIES_KEYS.length} series + UNVERIFIED rule configs`)
  for (const key of SERIES_KEYS) {
    const yaml = readFileSync(resolve(repoRoot, 'config/series', `${key}.yaml`), 'utf8')
    const config = parseSeriesRules(yaml)

    await db.insert(s.series).values({
      id: SERIES_IDS[key],
      team_id: DEMO_TEAM.id,
      key: config.series_key,
      display_name: config.display_name,
    })

    await db.insert(s.rule_configs).values({
      id: RULE_CONFIG_IDS[key],
      team_id: DEMO_TEAM.id,
      series_id: SERIES_IDS[key],
      version: config.config_version,
      config,
      verification_status: config.verification.status,
      is_active: true,
    })
  }

  await seedFixtureRace(db, log)

  log('done')
} finally {
  await close()
}
