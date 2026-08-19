/**
 * The Postgres side of sync.
 *
 * Deliberately thin: every decision about who wins lives in `@pitlog/sync`, so
 * the server and the pit client cannot disagree. This module only knows how to
 * read some rows by id and write some rows back.
 *
 * Every query filters on `team_id` (SPEC §4). The store is constructed for one
 * team and closes over it, because the alternative — passing the team to each
 * call — is one forgotten argument away from a cross-tenant write.
 */

import { randomUUID } from 'node:crypto'
import type { Db } from '@pitlog/db'
import * as s from '@pitlog/db/schema'
import type { SyncRow, SyncStore, SyncTableName } from '@pitlog/sync'
import { and, eq, gt, inArray } from 'drizzle-orm'

/** The tables a pit client may write, mapped to their Drizzle definitions. */
const TABLES = {
  events: s.events,
  sessions: s.sessions,
  drivers: s.drivers,
  stints: s.stints,
  fuel_fills: s.fuel_fills,
  consumable_sets: s.consumable_sets,
  consumable_events: s.consumable_events,
  expenses: s.expenses,
  receipts: s.receipts,
  expense_shares: s.expense_shares,
  log_entries: s.log_entries,
} as const satisfies Record<SyncTableName, unknown>

export type SyncTables = typeof TABLES

export function syncTable(name: SyncTableName) {
  return TABLES[name]
}

export const SYNC_TABLE_NAMES = Object.keys(TABLES) as SyncTableName[]

/**
 * A store scoped to one team.
 *
 * `save` upserts on the primary key. The id was generated on the device, so an
 * insert and an update are the same operation from here — which is the whole
 * point of client-generated ids (see the `offline-sync` skill).
 */
export function createSyncStore(db: Db, teamId: string): SyncStore {
  return {
    async load(name, ids) {
      if (ids.length === 0) return new Map()
      const table = TABLES[name]

      const rows = await db
        .select()
        .from(table)
        .where(and(eq(table.team_id, teamId), inArray(table.id, [...ids])))

      return new Map(rows.map((row) => [row.id, row as unknown as SyncRow]))
    },

    async save(name, rows) {
      if (rows.length === 0) return
      const table = TABLES[name]

      for (const row of rows) {
        // server_updated_at is stamped here and never comes from the client:
        // it is a receipt, and letting a device set it would make the pull
        // cursor a thing the client controls.
        const values = { ...row, team_id: teamId, server_updated_at: new Date() }

        await db
          .insert(table)
          .values(values as never)
          .onConflictDoUpdate({ target: table.id, set: values as never })
      }
    },

    async recordSuperseded(rows) {
      if (rows.length === 0) return

      // Append-only. Nothing here is ever updated or deleted, which is what
      // makes last-write-wins survivable: whoever typed the losing value can
      // always find out what became of it.
      await db.insert(s.row_versions).values(
        rows.map((row) => ({
          id: randomUUID(),
          team_id: teamId,
          table_name: row.table,
          row_id: row.previous.id,
          snapshot: row.previous as unknown as Record<string, unknown>,
          client_updated_at: new Date(row.previous.client_updated_at),
          updated_by: row.previous.updated_by,
          superseded_by: row.supersededBy,
          was_conflict: row.wasConflict,
        })),
      )
    },
  }
}

/**
 * Rows changed at or after `floor`, for the pull half of sync.
 *
 * Soft-deleted rows are included on purpose: a device that has not synced since
 * before a delete needs to learn about it, and `deleted_at` is how. Ordinary
 * reads elsewhere filter them out; this is not an ordinary read.
 */
export async function loadChangesSince(
  db: Db,
  teamId: string,
  floor: Date | null,
): Promise<{ table: SyncTableName; rows: SyncRow[] }[]> {
  const changes: { table: SyncTableName; rows: SyncRow[] }[] = []

  for (const name of SYNC_TABLE_NAMES) {
    const table = TABLES[name]
    const scope =
      floor === null
        ? eq(table.team_id, teamId)
        : and(eq(table.team_id, teamId), gt(table.server_updated_at, floor))

    const rows = await db.select().from(table).where(scope)
    if (rows.length > 0) changes.push({ table: name, rows: rows as unknown as SyncRow[] })
  }

  return changes
}
