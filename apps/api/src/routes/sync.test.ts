import * as schema from '@pitlog/db/schema'
import { SYNC_TABLES } from '@pitlog/sync'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { SYNC_TABLE_NAMES, syncTable } from '../sync/store.js'

/** Every table in the schema that carries the sync column contract. */
function syncableTables(): string[] {
  const names: string[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue
    const columns = Object.keys(value as unknown as Record<string, unknown>)
    if (columns.includes('client_updated_at') && columns.includes('deleted_at')) {
      names.push(getTableName(value))
    }
  }
  return names.sort()
}

/**
 * Tables that carry sync columns but which a phone must never push.
 *
 * These are M2 server-side ingest paths — official timing pulled from a timing
 * provider, video metadata, telemetry manifests. Listing them here rather than
 * leaving them out of the allowlist is what makes the test below meaningful: a
 * new syncable table has to be classified, not merely forgotten.
 */
const SERVER_WRITTEN_ONLY = ['laps', 'media_assets', 'telemetry_files']

describe('the sync allowlist and the schema cannot drift apart', () => {
  it('classifies every syncable table as client-writable or server-only', () => {
    expect([...SYNC_TABLES, ...SERVER_WRITTEN_ONLY].sort()).toEqual(syncableTables())
  })

  it('has no table in both lists', () => {
    for (const name of SYNC_TABLES) {
      expect(SERVER_WRITTEN_ONLY).not.toContain(name)
    }
  })

  it('maps every allowlisted table to a real Drizzle table', () => {
    for (const name of SYNC_TABLES) {
      expect(getTableName(syncTable(name))).toBe(name)
    }
  })

  it('exposes the same table set from the store as from the protocol', () => {
    expect([...SYNC_TABLE_NAMES].sort()).toEqual([...SYNC_TABLES].sort())
  })

  it('only lets the client write tables that are team-scoped', () => {
    // Tenancy has no exceptions on the sync path: the apply layer checks
    // team_id on every row, which is only possible if the column is there.
    for (const name of SYNC_TABLES) {
      expect(Object.keys(syncTable(name))).toContain('team_id')
    }
  })
})
