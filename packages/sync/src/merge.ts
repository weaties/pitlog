/**
 * The last-write-wins merge — SPEC §6.2, and the `offline-sync` skill.
 *
 * Pure logic over two rows and a comparator: no browser, no database, no HTTP.
 * `apps/web` applies it to IndexedDB and `apps/api` applies it to Postgres, and
 * because it is the same function on both sides, a device and the server cannot
 * disagree about who won.
 *
 * Three rules carry the design, and each has a test that fails loudly if it is
 * ever quietly relaxed:
 *
 * 1. **The comparator is `client_updated_at`** — the writing device's clock.
 *    `server_updated_at` is a receipt stamp and is deliberately absent from the
 *    types here. Using it would mean a correction typed at 14:02 offline and
 *    synced at 18:30 silently overwrites one typed at 14:30 online, which is
 *    the exact failure this design exists to prevent.
 *
 * 2. **Ties break on `updated_by`**, so two devices that never speak still
 *    reach the same winner. Arrival order must never decide anything.
 *
 * 3. **A losing value is returned, never dropped.** The person who typed it has
 *    to be able to find out that it lost — see #24.
 *
 * Deliberately not here: CRDTs, operational transform, vector clocks, and
 * field-by-field auto-merge. SPEC §6.2 rules them out for v1, and two
 * half-applied edits produce a row neither person entered.
 */

/** The sync columns every writable row carries — `packages/db` `syncColumns`. */
export interface SyncEnvelope {
  id: string
  /** The comparator. From the writing device's clock, never the server's. */
  client_updated_at: Date
  /** Soft delete. A deleted row is still a row. */
  deleted_at: Date | null
  /** Tie-breaker, and who to name when surfacing a conflict. */
  updated_by: string | null
}

export type SyncRow<T = Record<string, unknown>> = T & SyncEnvelope

export type MergeOutcome =
  /** This side had never seen the row. */
  | 'insert'
  /** The arriving write supersedes what this side held. */
  | 'incoming_wins'
  /** What this side holds is newer; the arriving write is stale. */
  | 'current_wins'
  /** A replay of a write already applied. */
  | 'unchanged'

export interface MergeDecision<T = Record<string, unknown>> {
  outcome: MergeOutcome
  /** What this side should hold afterwards. */
  winner: SyncRow<T>
  /** The value that lost, when one genuinely did. Null on insert or replay. */
  loser: SyncRow<T> | null
  /** Whether a human should be shown the loser. See `isWorthSurfacing`. */
  conflict: boolean
}

/**
 * Merge one arriving row against what this side already holds.
 *
 * `current` is null when the row has never been seen here — which is the normal
 * case for anything created on a phone with no signal, not an error.
 */
export function mergeRow<T>(current: SyncRow<T> | null, incoming: SyncRow<T>): MergeDecision<T> {
  if (current === null) {
    return { outcome: 'insert', winner: incoming, loser: null, conflict: false }
  }

  const comparison = compare(current, incoming)

  if (comparison === 0) {
    // Same instant, same author: the same write arriving twice. Replays are
    // routine — a queue that retries after an ambiguous network failure will
    // send one — so this is a no-op rather than anything to report.
    return { outcome: 'unchanged', winner: current, loser: null, conflict: false }
  }

  const incomingWins = comparison < 0
  const winner = incomingWins ? incoming : current
  const loser = incomingWins ? current : incoming

  // Two rows that say the same thing are not a disagreement, whoever wrote
  // them and whenever they arrived.
  const differ = !sameContent(winner, loser)

  return {
    outcome: incomingWins ? 'incoming_wins' : 'current_wins',
    winner,
    loser: differ ? loser : null,
    conflict: differ && isWorthSurfacing(winner, loser),
  }
}

/**
 * Merge a batch, keyed on id.
 *
 * Each row is decided on its own: one stale write must never block a fresh
 * write to a different row. Two writes to the *same* row inside one batch fold
 * into each other in order, so a batch behaves the same as the writes arriving
 * one at a time — which, after six hours offline, is exactly what it is.
 */
export function mergeAll<T>(
  current: ReadonlyMap<string, SyncRow<T>>,
  incoming: readonly SyncRow<T>[],
): MergeDecision<T>[] {
  const state = new Map(current)
  const decisions: MergeDecision<T>[] = []

  for (const row of incoming) {
    const decision = mergeRow(state.get(row.id) ?? null, row)
    state.set(row.id, decision.winner)
    decisions.push(decision)
  }

  return decisions
}

/**
 * Order two versions of a row. Negative means `incoming` wins.
 *
 * Exported because the server needs the same ordering when it folds a batch
 * against stored rows, and a second implementation would be a second chance to
 * reach for the server clock.
 */
export function compare<T>(current: SyncRow<T>, incoming: SyncRow<T>): number {
  const currentAt = current.client_updated_at.getTime()
  const incomingAt = incoming.client_updated_at.getTime()
  if (currentAt !== incomingAt) return incomingAt - currentAt > 0 ? -1 : 1

  // Same instant on two clocks that have never been compared. Any rule works
  // provided both devices apply it identically; the greater id wins, and an
  // unattributed write ranks below every attributed one.
  const currentBy = current.updated_by ?? ''
  const incomingBy = incoming.updated_by ?? ''
  if (currentBy === incomingBy) return 0
  return incomingBy > currentBy ? -1 : 1
}

/**
 * Whether a human should be told about the value that lost.
 *
 * One person correcting their own entry is not a conflict — it is a Tuesday.
 * Surfacing those would train a crew to swipe the conflict UI away, which is
 * worse than not having one. Two *different* people disagreeing is worth an
 * interruption.
 *
 * A losing delete is always worth surfacing, same author or not: somebody
 * believes that row is gone, and it is not.
 */
function isWorthSurfacing<T>(winner: SyncRow<T>, loser: SyncRow<T>): boolean {
  if (loser.deleted_at !== null && winner.deleted_at === null) return true
  return winner.updated_by !== loser.updated_by
}

/**
 * Whether two versions of a row say the same thing.
 *
 * Compares the payload and the soft-delete state, and deliberately ignores the
 * comparator and the author: the question is whether a human would see a
 * different value, not whether the bytes match.
 */
function sameContent<T>(a: SyncRow<T>, b: SyncRow<T>): boolean {
  if ((a.deleted_at === null) !== (b.deleted_at === null)) return false

  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (IGNORED_IN_CONTENT.has(key)) continue
    if (!Object.is(normalise(a[key as keyof typeof a]), normalise(b[key as keyof typeof b]))) {
      return false
    }
  }
  return true
}

/**
 * Fields that say when and by whom, not what.
 *
 * `server_updated_at` is here rather than absent because a row handed to this
 * module may still carry one from the database; naming it is how it stays
 * excluded from every decision rather than accidentally becoming a comparator.
 */
const IGNORED_IN_CONTENT = new Set([
  'client_updated_at',
  'updated_by',
  'server_updated_at',
  'deleted_at',
])

/** Dates compare by value; everything else by identity. */
function normalise(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}
