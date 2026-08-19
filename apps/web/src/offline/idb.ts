/**
 * IndexedDB, wrapped just enough.
 *
 * The pit client reads from here, not from the network (SPEC §6.1). A phone in
 * a pit box with no signal must render the whole weekend, accept new writes,
 * and hand back ids — the network is a background reconciliation, not a
 * dependency.
 *
 * Deliberately not a library: the surface needed is four operations over two
 * kinds of store, and the raw API for that is smaller than the wrapper's
 * documentation. Everything with a decision in it lives in `@pitlog/sync`
 * instead, where it is tested without a browser.
 */

import type { PullableTableName, QueuedWrite, QueueStorage, SyncRow } from '@pitlog/sync'
import { PULLABLE_TABLES } from '@pitlog/sync'

const DB_NAME = 'pitlog'
// Bumped to 2 when `laps` became readable on the device (#15): tyre life is
// derived from laps, never typed, so the client needs a local copy.
const DB_VERSION = 2
const QUEUE_STORE = '_outbox'
const META_STORE = '_meta'

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

let handle: Promise<IDBDatabase> | null = null

export function openLocalDb(): Promise<IDBDatabase> {
  if (handle) return handle

  handle = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      // One object store per syncable table, keyed on the client-generated id.
      // Ids are assigned on the device and never renumbered, so the primary
      // key is stable from the moment a write is made.
      for (const table of PULLABLE_TABLES) {
        if (!db.objectStoreNames.contains(table)) db.createObjectStore(table, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'seq' })
      }
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE)
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return handle
}

/** Rows a screen should show: soft-deleted rows are excluded, per the skill. */
export async function readTable<T = Record<string, unknown>>(
  table: PullableTableName,
): Promise<SyncRow<T>[]> {
  const db = await openLocalDb()
  const rows = await promisify<SyncRow<T>[]>(
    db.transaction(table, 'readonly').objectStore(table).getAll(),
  )
  return rows.filter((row) => row.deleted_at === null || row.deleted_at === undefined)
}

/** Including soft-deleted rows — for history and conflict views only. */
export async function readTableWithDeleted<T = Record<string, unknown>>(
  table: PullableTableName,
): Promise<SyncRow<T>[]> {
  const db = await openLocalDb()
  return promisify<SyncRow<T>[]>(db.transaction(table, 'readonly').objectStore(table).getAll())
}

export async function writeRows<T>(
  table: PullableTableName,
  rows: readonly SyncRow<T>[],
): Promise<void> {
  if (rows.length === 0) return
  const db = await openLocalDb()
  const tx = db.transaction(table, 'readwrite')
  const store = tx.objectStore(table)
  for (const row of rows) store.put(row)
  await transactionDone(tx)
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** The durable outbox behind `@pitlog/sync`'s queue. */
export const idbQueueStorage: QueueStorage = {
  async list() {
    const db = await openLocalDb()
    return promisify<QueuedWrite[]>(
      db.transaction(QUEUE_STORE, 'readonly').objectStore(QUEUE_STORE).getAll(),
    )
  },
  async put(writes) {
    const db = await openLocalDb()
    const tx = db.transaction(QUEUE_STORE, 'readwrite')
    for (const write of writes) tx.objectStore(QUEUE_STORE).put(write)
    await transactionDone(tx)
  },
  async remove(seqs) {
    const db = await openLocalDb()
    const tx = db.transaction(QUEUE_STORE, 'readwrite')
    for (const seq of seqs) tx.objectStore(QUEUE_STORE).delete(seq)
    await transactionDone(tx)
  },
}

export async function readMeta<T>(key: string): Promise<T | undefined> {
  const db = await openLocalDb()
  return promisify<T | undefined>(
    db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key),
  )
}

export async function writeMeta(key: string, value: unknown): Promise<void> {
  const db = await openLocalDb()
  const tx = db.transaction(META_STORE, 'readwrite')
  tx.objectStore(META_STORE).put(value, key)
  await transactionDone(tx)
}
