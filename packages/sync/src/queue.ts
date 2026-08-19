/**
 * The outbound queue — every write the pit client makes, waiting its turn.
 *
 * Framework-free so the retry policy can be tested without a browser or a
 * network. `apps/web` supplies IndexedDB as the storage and `fetch` as the
 * transport; neither appears here.
 *
 * The shape of this is dictated by the track: **connectivity is assumed absent,
 * not flaky** (SPEC §6.1). A write is durable the instant it is made, is
 * displayed from the local store immediately, and reaches the server whenever
 * that becomes possible — which may be the next day, in a car park, on someone
 * else's phone hotspot. Nothing the crew does may block on a network.
 */

import type { SyncRow } from './merge.js'
import type { SyncPushRequest, SyncPushResponse, SyncWriteResult } from './protocol.js'
import { SYNC_PROTOCOL_VERSION } from './protocol.js'
import type { SyncTableName } from './tables.js'

export interface QueuedWrite {
  /** Monotonic per device. Preserves the order things were actually typed. */
  seq: number
  table: SyncTableName
  row: SyncRow
  attempts: number
  lastError: string | null
}

export interface QueueStorage {
  list(): Promise<QueuedWrite[]>
  put(writes: readonly QueuedWrite[]): Promise<void>
  remove(seqs: readonly number[]): Promise<void>
}

export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResponse>
}

export interface DrainResult {
  /** Writes handed to the server this attempt. */
  attempted: number
  /** Writes the server accounted for, and which have left the queue. */
  settled: number
  /** Still queued, awaiting another attempt. */
  remaining: number
  /**
   * Writes the server refused outright. They are off the queue — retrying a
   * row the server considers malformed just burns battery forever — but they
   * are handed back so a human can be told.
   */
  rejected: QueuedWrite[]
  /** Losing values the server reported, for the conflict UI (#24). */
  conflicts: SyncWriteResult[]
  /** How long to wait before trying again, or null if there is nothing left. */
  retryAfterMs: number | null
}

/** Writes per push. Small enough to survive a bad connection at a track. */
export const MAX_BATCH = 50

const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 5 * 60_000

/**
 * Backoff for the next attempt.
 *
 * Capped at five minutes rather than growing without bound: a crew that
 * regains signal after two hours should not wait another two because the
 * exponent ran away while they were out of range.
 */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS)
}

/**
 * Add writes to the queue.
 *
 * Sequence numbers come from the caller's counter so they survive a reload;
 * the queue never renumbers, exactly as the server never renumbers a
 * client-generated id.
 */
export async function enqueue(
  storage: QueueStorage,
  nextSeq: number,
  writes: readonly { table: SyncTableName; row: SyncRow }[],
): Promise<number> {
  const queued = writes.map((write, index) => ({
    seq: nextSeq + index,
    table: write.table,
    row: write.row,
    attempts: 0,
    lastError: null,
  }))

  await storage.put(queued)
  return nextSeq + writes.length
}

/**
 * Try to drain the queue once.
 *
 * One attempt, not a loop: the caller owns the schedule, because only it knows
 * whether the app is in the foreground, whether the screen is on, and whether
 * the user just pressed "sync now". A loop in here would be a loop nobody can
 * stop.
 */
export async function drainOnce(
  storage: QueueStorage,
  transport: SyncTransport,
): Promise<DrainResult> {
  const queued = (await storage.list()).sort((a, b) => a.seq - b.seq)
  if (queued.length === 0) {
    return {
      attempted: 0,
      settled: 0,
      remaining: 0,
      rejected: [],
      conflicts: [],
      retryAfterMs: null,
    }
  }

  const batch = queued.slice(0, MAX_BATCH)
  const request: SyncPushRequest = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    writes: batch.map((w) => ({ table: w.table, row: w.row })),
  }

  let response: SyncPushResponse
  try {
    response = await transport.push(request)
  } catch (error) {
    // No network, or the server fell over. Nothing is lost: every write stays
    // queued and the attempt count is what paces the next try.
    const retried = batch.map((w) => ({
      ...w,
      attempts: w.attempts + 1,
      lastError: error instanceof Error ? error.message : String(error),
    }))
    await storage.put(retried)

    const attempts = Math.min(...retried.map((w) => w.attempts))
    return {
      attempted: batch.length,
      settled: 0,
      remaining: queued.length,
      rejected: [],
      conflicts: [],
      retryAfterMs: backoffMs(attempts),
    }
  }

  const settled: number[] = []
  const rejected: QueuedWrite[] = []
  const conflicts: SyncWriteResult[] = []

  for (const [index, result] of response.results.entries()) {
    const write = batch[index]
    if (!write) continue

    if (result.outcome === 'rejected') {
      rejected.push({ ...write, lastError: result.error ?? 'rejected' })
      settled.push(write.seq)
      continue
    }

    // Every non-rejected outcome — insert, either side winning, or a replay —
    // means the server has accounted for this write. `current_wins` counts:
    // the server already holds something better, so resending is pointless.
    settled.push(write.seq)
    if (result.loser) conflicts.push(result)
  }

  await storage.remove(settled)
  const remaining = queued.length - settled.length

  return {
    attempted: batch.length,
    settled: settled.length,
    remaining,
    rejected,
    conflicts,
    // More waiting? Go straight round again — this is progress, not a retry.
    retryAfterMs: remaining > 0 ? 0 : null,
  }
}

/** How many writes are waiting. At a track, "has my fill synced?" is real. */
export async function queueDepth(storage: QueueStorage): Promise<number> {
  return (await storage.list()).length
}
