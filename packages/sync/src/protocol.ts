/**
 * The sync wire protocol — one endpoint for every write the pit client makes.
 *
 * AGENTS.md → Decisions records why this is a single batched endpoint rather
 * than REST per resource: offline-first makes the write path uniform whether or
 * not there is a network, and the queue has exactly one drain.
 *
 * ## The pull cursor
 *
 * A cursor is a `server_updated_at` instant, and a pull deliberately re-reads
 * an overlap window before it. That is not sloppiness, it is the only cheap
 * correct option:
 *
 * Postgres `now()` is *transaction start* time, so a transaction that begins at
 * 10:00:00.000 and commits after one that began at 10:00:00.001 becomes
 * invisible to any client that already advanced its cursor past it. A
 * monotonic sequence column has the same hazard — the value is assigned at
 * insert, not at commit — so it would buy a migration and fix nothing. Only
 * snapshot-based cursors or a commit-time outbox actually close the gap, and
 * both are far more machinery than 2-4 people and one car need.
 *
 * Re-reading the last `PULL_OVERLAP_SECONDS` closes it instead, and is safe
 * because replaying a write is a proven no-op — see `merge.test.ts`. The window
 * only has to exceed the longest write transaction, which here is a single
 * batch insert.
 */

import { z } from 'zod'
import type { MergeOutcome, SyncRow } from './merge.js'
import { isSyncTable, SYNC_TABLE_SCHEMAS, type SyncTableName } from './tables.js'

/**
 * How far before the cursor a pull re-reads. Generous on purpose: the cost of
 * being wrong is a row that never arrives, and the cost of being generous is a
 * few idempotent re-merges.
 */
export const PULL_OVERLAP_SECONDS = 60

export const SYNC_PROTOCOL_VERSION = 1

const pushRowSchema = z.object({ table: z.string(), row: z.unknown() }).strict()

export const syncPushRequestSchema = z
  .object({
    protocolVersion: z.int().positive(),
    writes: z.array(pushRowSchema).max(500),
  })
  .strict()

export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>

export type SyncWriteOutcome = MergeOutcome | 'rejected'

export interface SyncWriteResult {
  table: string
  id: string
  outcome: SyncWriteOutcome
  /**
   * The value that lost, when one did and it is worth a human seeing. The
   * client surfaces it (#24) — nothing is discarded silently.
   */
  loser: SyncRow | null
  /** Why the row was refused. Present only on `rejected`. */
  error?: string
}

export interface SyncPushResponse {
  protocolVersion: number
  results: SyncWriteResult[]
  /** Feed this back as `since` on the next pull. */
  cursor: string
}

export interface SyncPullResponse {
  protocolVersion: number
  /** Rows changed since the cursor, grouped by table. Includes soft-deleted. */
  changes: { table: SyncTableName; rows: SyncRow[] }[]
  cursor: string
}

/**
 * Parse one row against the table it claims to belong to.
 *
 * Returns a message rather than throwing: one malformed row must not cost a
 * crew the other forty-nine in the batch.
 */
export function parseSyncRow(
  table: string,
  row: unknown,
): { ok: true; table: SyncTableName; row: SyncRow } | { ok: false; error: string } {
  if (!isSyncTable(table)) {
    return { ok: false, error: `${table} is not a table the pit client may write` }
  }

  const parsed = SYNC_TABLE_SCHEMAS[table].safeParse(row)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      error: first ? `${first.path.join('.') || 'row'}: ${first.message}` : 'malformed row',
    }
  }

  return { ok: true, table, row: parsed.data as unknown as SyncRow }
}

/** The instant a pull should read from, given the cursor a client sends. */
export function pullFloor(since: Date | null): Date | null {
  if (since === null) return null
  return new Date(since.getTime() - PULL_OVERLAP_SECONDS * 1000)
}
