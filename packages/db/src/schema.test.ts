import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.js'

// `schema` exports both tables and pgEnums; keep only the tables.
const tables = (Object.values(schema) as unknown[])
  .flatMap((v) => (is(v, PgTable) ? [v as PgTable] : []))
  .map((t) => ({ name: getTableName(t), table: t, columns: getTableColumns(t) }))

const named = (name: string) => {
  const t = tables.find((x) => x.name === name)
  if (!t) throw new Error(`table ${name} not defined`)
  return t
}

/**
 * Identity tables are cross-tenant by construction: a user belongs to zero or
 * more teams, and a login token is issued before we know which team the login
 * lands in. `teams` is the tenant root — its `id` IS the team id.
 */
const NOT_TENANT_SCOPED = new Set(['teams', 'users', 'login_tokens', 'auth_sessions'])

describe('schema v1 covers SPEC §6.5', () => {
  const required = [
    'teams',
    'users',
    'memberships',
    'series',
    'rule_configs',
    'events',
    'sessions',
    'drivers',
    'stints',
    'fuel_fills',
    'laps',
    'consumable_sets',
    'consumable_events',
    'expenses',
    'receipts',
    'expense_shares',
    'media_assets',
    'telemetry_files',
    'log_entries',
  ]

  for (const name of required) {
    it(`defines ${name}`, () => {
      expect(tables.map((t) => t.name)).toContain(name)
    })
  }
})

describe('tenancy invariant', () => {
  it('gives every domain table a non-null team_id — SPEC §4', () => {
    const offenders = tables
      .filter((t) => !NOT_TENANT_SCOPED.has(t.name))
      .filter((t) => {
        return !t.columns.team_id?.notNull
      })
      .map((t) => t.name)
    expect(offenders).toEqual([])
  })

  it('does not put team_id on identity tables', () => {
    for (const name of ['users', 'login_tokens', 'auth_sessions']) {
      expect(named(name).columns.team_id, name).toBeUndefined()
    }
  })
})

describe('offline sync invariant — SPEC §6.2', () => {
  // Client-generated UUID primary keys, an LWW comparator sourced from the
  // client clock, and soft deletes so an offline delete can be replayed.
  const SYNC_TABLES = [
    'events',
    'sessions',
    'drivers',
    'stints',
    'fuel_fills',
    'laps',
    'consumable_sets',
    'consumable_events',
    'expenses',
    'receipts',
    'expense_shares',
    'media_assets',
    'telemetry_files',
    'log_entries',
  ]

  for (const name of SYNC_TABLES) {
    describe(name, () => {
      const t = named(name)

      it('has a uuid primary key the client can generate offline', () => {
        const id = t.columns.id
        expect(id).toBeDefined()
        expect(id?.primary).toBe(true)
        expect(id?.columnType).toBe('PgUUID')
      })

      it('carries the LWW + soft-delete sync columns', () => {
        for (const col of ['client_updated_at', 'server_updated_at', 'deleted_at']) {
          expect(t.columns[col], `${name}.${col}`).toBeDefined()
        }
      })

      it('never hard-requires deleted_at', () => {
        expect(t.columns.deleted_at?.notNull).toBe(false)
      })
    })
  }
})

describe('laps', () => {
  it('records which clock a lap came from — SPEC §5.4', () => {
    const source = named('laps').columns.source
    expect(source).toBeDefined()
    expect(source?.enumValues).toEqual(['official', 'gps'])
  })
})

describe('memberships', () => {
  it('constrains role to the three SPEC §4 roles', () => {
    expect(named('memberships').columns.role?.enumValues).toEqual(['admin', 'crew', 'visitor'])
  })
})
