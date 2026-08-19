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
const QUEUE_STORE = '_outbox'
const META_STORE = '_meta'

/** Every object store the app needs, derived rather than hand-listed. */
const REQUIRED_STORES = [...PULLABLE_TABLES, QUEUE_STORE, META_STORE] as const

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

let handle: Promise<IDBDatabase> | null = null

/**
 * Open the local database, creating any store that is missing.
 *
 * The obvious implementation is a hand-maintained `DB_VERSION` constant that
 * somebody remembers to bump. That failed the first time it was tested: adding
 * a table to the sync list without touching the version left browsers on the
 * old schema with no store to write to, and every write threw
 * `NotFoundError` — silently, because nothing was watching.
 *
 * So the version is derived from the schema instead. Open once to see what is
 * actually there; if a store is missing, reopen one version higher and create
 * it. Adding a table to `PULLABLE_TABLES` is now the whole change.
 */
export function openLocalDb(): Promise<IDBDatabase> {
  if (handle) return handle
  handle = openWithMissingStores()
  return handle
}

async function openWithMissingStores(): Promise<IDBDatabase> {
  const existing = await open(DB_NAME)
  const missing = REQUIRED_STORES.filter((name) => !existing.objectStoreNames.contains(name))

  if (missing.length === 0) return existing

  const version = existing.version + 1
  existing.close()

  return open(DB_NAME, version, (db) => {
    for (const name of missing) {
      if (db.objectStoreNames.contains(name)) continue
      // The outbox is keyed by its own sequence; meta is a plain key/value
      // store; everything else is keyed on the client-generated row id.
      if (name === QUEUE_STORE) db.createObjectStore(name, { keyPath: 'seq' })
      else if (name === META_STORE) db.createObjectStore(name)
      else db.createObjectStore(name, { keyPath: 'id' })
    }
  })
}

function open(
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
    request.onupgradeneeded = () => upgrade?.(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error('another tab is holding the local database open; close it and reload'))
  })
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
