/**
 * Applying a pushed batch — the server half of sync.
 *
 * The store is injected rather than imported so this is testable with no
 * Postgres anywhere, exactly as the tenancy gates take a `MembershipResolver`.
 * The rule under test is "which write wins and what gets told to whom", which
 * has nothing to do with a database.
 *
 * **A batch is atomic per row, not all-or-nothing.** A crew that has been
 * offline for six hours may push fifty writes; one malformed row losing the
 * other forty-nine would be indefensible, and they would have no way to tell
 * which one was at fault.
 */

import type { SyncRow } from './merge.js'
import { mergeRow } from './merge.js'
import type { SyncPushRequest, SyncPushResponse, SyncWriteResult } from './protocol.js'
import { parseSyncRow } from './protocol.js'
import type { SyncTableName } from './tables.js'

export interface SupersededRow {
  table: SyncTableName
  /** The row exactly as it was before being overwritten. */
  previous: SyncRow
  /** Who overwrote it. */
  supersededBy: string | null
  /**
   * True when a human should be shown this. One person correcting themselves
   * is history; being overwritten by somebody *else* is a conflict.
   */
  wasConflict: boolean
}

export interface SyncStore {
  /** Rows this team already holds for these ids. Missing ids are simply absent. */
  load(table: SyncTableName, ids: readonly string[]): Promise<Map<string, SyncRow>>
  /** Persist the winners. Called once per table with everything that changed. */
  save(table: SyncTableName, rows: readonly SyncRow[]): Promise<void>
  /**
   * Keep what was overwritten.
   *
   * Append-only, and the reason last-write-wins is survivable: without it the
   * losing value is gone and the person who typed it can never find out what
   * happened to it (SPEC §5.2, §6.2).
   */
  recordSuperseded?(rows: readonly SupersededRow[]): Promise<void>
}

export interface ApplyOptions {
  /** The team in the request path. Every row must claim this one. */
  teamId: string
  /** Stamped onto the response so the client knows where to pull from. */
  now: Date
}

/**
 * Merge a pushed batch into the store and report what happened to each row.
 */
export async function applySyncPush(
  store: SyncStore,
  request: SyncPushRequest,
  options: ApplyOptions,
): Promise<SyncPushResponse> {
  // Results are positional: the client correlates them against the batch it
  // sent, so a rejected row must not jump ahead of an accepted one just
  // because it was decided in an earlier pass.
  const results = new Array<SyncWriteResult | undefined>(request.writes.length)
  const accepted = new Map<SyncTableName, { index: number; row: SyncRow }[]>()

  for (const [index, write] of request.writes.entries()) {
    const parsed = parseSyncRow(write.table, write.row)
    if (!parsed.ok) {
      results[index] = {
        table: write.table,
        id: idOf(write.row),
        outcome: 'rejected',
        loser: null,
        error: parsed.error,
      }
      continue
    }

    // A sync payload is untrusted input like any other. Being a member of the
    // team in the path grants nothing over rows that claim a different one.
    if (parsed.row.team_id !== options.teamId) {
      results[index] = {
        table: parsed.table,
        id: parsed.row.id,
        outcome: 'rejected',
        loser: null,
        error: 'row belongs to another team',
      }
      continue
    }

    const bucket = accepted.get(parsed.table) ?? []
    bucket.push({ index, row: parsed.row })
    accepted.set(parsed.table, bucket)
  }

  const superseded: SupersededRow[] = []

  for (const [table, entries] of accepted) {
    const held = await store.load(
      table,
      entries.map((e) => e.row.id),
    )
    const winners: SyncRow[] = []

    for (const { index, row } of entries) {
      // Fold within the batch too: two writes to the same row in one push must
      // behave exactly as they would have arriving one at a time.
      const current = held.get(row.id) ?? null
      const decision = mergeRow(current, row)
      held.set(row.id, decision.winner)

      if (decision.outcome !== 'unchanged' && decision.outcome !== 'current_wins') {
        winners.push(decision.winner)
      }

      // Every value that lost is kept, whether or not it is worth interrupting
      // anybody about. An edit nobody flags today is still the history somebody
      // wants on Sunday night.
      if (decision.loser) {
        superseded.push({
          table,
          previous: decision.loser,
          supersededBy: decision.winner.updated_by,
          wasConflict: decision.conflict,
        })
      }

      results[index] = {
        table,
        id: row.id,
        outcome: decision.outcome,
        loser: decision.conflict ? decision.loser : null,
      }
    }

    if (winners.length > 0) await store.save(table, winners)
  }

  if (superseded.length > 0) await store.recordSuperseded?.(superseded)

  return {
    protocolVersion: request.protocolVersion,
    // Every slot is filled: each write is either rejected or decided.
    results: results.filter((r): r is SyncWriteResult => r !== undefined),
    cursor: options.now.toISOString(),
  }
}

/** Best effort, for reporting a rejection on a row too malformed to parse. */
function idOf(row: unknown): string {
  if (row && typeof row === 'object' && 'id' in row && typeof row.id === 'string') return row.id
  return 'unknown'
}
