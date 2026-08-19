/**
 * The offline client: local writes, a draining queue, and a pull loop.
 *
 * The rule this module exists to enforce is that **a screen never awaits the
 * network**. Every mutation writes to IndexedDB, enqueues, and returns. The
 * row is on screen before the request is made, and stays there whether or not
 * one ever succeeds.
 */

import type {
  SyncPushRequest,
  SyncPushResponse,
  SyncRow,
  SyncTableName,
  SyncWriteResult,
} from '@pitlog/sync'
import { drainOnce, enqueue, queueDepth } from '@pitlog/sync'
import { api } from '../lib/api.js'
import { idbQueueStorage, readMeta, writeMeta, writeRows } from './idb.js'

const CURSOR_KEY = 'sync.cursor'
const SEQ_KEY = 'sync.nextSeq'

export interface PullResponse {
  protocolVersion: number
  changes: { table: SyncTableName; rows: SyncRow[] }[]
  cursor: string
}

function transport(teamId: string) {
  return {
    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      return api<SyncPushResponse>(`/api/teams/${teamId}/sync`, {
        method: 'POST',
        body: JSON.stringify(request),
      })
    },
  }
}

/**
 * Record a write locally and queue it for the server.
 *
 * The id is generated here and is permanent — see the `offline-sync` skill.
 * Returns once the write is durable on the device, which is the only thing the
 * caller should ever wait for.
 */
export async function writeLocal<T>(table: SyncTableName, row: SyncRow<T>): Promise<void> {
  await writeRows(table, [row])
  const nextSeq = (await readMeta<number>(SEQ_KEY)) ?? 1
  // The queue is table-agnostic, so rows enter it in their erased form; the
  // shape was already checked by the caller and is re-checked by the server.
  const after = await enqueue(idbQueueStorage, nextSeq, [{ table, row: row as unknown as SyncRow }])
  await writeMeta(SEQ_KEY, after)
}

export interface SyncRunResult {
  pushed: number
  pulled: number
  queued: number
  conflicts: SyncWriteResult[]
  rejected: { table: string; id: string; error: string }[]
  /** Null when everything is settled. */
  retryAfterMs: number | null
  online: boolean
}

/**
 * One push-then-pull cycle.
 *
 * Push first: a crew's own writes should reach the server before anything
 * overwrites the local copy of them, so that a conflict is decided against
 * what they actually typed rather than a half-synced version of it.
 */
export async function syncOnce(teamId: string): Promise<SyncRunResult> {
  const conflicts: SyncWriteResult[] = []
  const rejected: SyncRunResult['rejected'] = []
  let pushed = 0
  let retryAfterMs: number | null = null
  let online = true

  const drain = await drainOnce(idbQueueStorage, transport(teamId))
  pushed = drain.settled
  retryAfterMs = drain.retryAfterMs
  conflicts.push(...drain.conflicts)
  for (const write of drain.rejected) {
    rejected.push({ table: write.table, id: write.row.id, error: write.lastError ?? 'rejected' })
  }
  if (drain.attempted > 0 && drain.settled === 0 && drain.rejected.length === 0) online = false

  let pulled = 0
  if (online) {
    try {
      const since = await readMeta<string>(CURSOR_KEY)
      const query = since ? `?since=${encodeURIComponent(since)}` : ''
      const response = await api<PullResponse>(`/api/teams/${teamId}/sync${query}`)

      for (const change of response.changes) {
        await writeRows(change.table, change.rows)
        pulled += change.rows.length
      }
      await writeMeta(CURSOR_KEY, response.cursor)
    } catch {
      // A failed pull is not a failed weekend. Local reads keep working from
      // whatever was last stored, and the cursor stays put so nothing is
      // skipped when the network returns.
      online = false
    }
  }

  return {
    pushed,
    pulled,
    queued: await queueDepth(idbQueueStorage),
    conflicts,
    rejected,
    retryAfterMs,
    online,
  }
}
