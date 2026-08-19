/**
 * Reading the weekend from the device.
 *
 * Every screen reads through here rather than from `fetch`, which is what makes
 * "works with no signal" a property of the data layer instead of something each
 * page has to remember. The network only ever writes *into* IndexedDB, in the
 * background, via `useSync`.
 */

import type { SyncRow, SyncTableName } from '@pitlog/sync'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { readTable, readTableWithDeleted } from './idb.js'

export function localTableKey(table: SyncTableName, includeDeleted = false) {
  return ['local', table, includeDeleted] as const
}

export function useLocalTable<T = Record<string, unknown>>(
  table: SyncTableName,
  options: { includeDeleted?: boolean } = {},
) {
  const includeDeleted = options.includeDeleted ?? false

  return useQuery({
    queryKey: localTableKey(table, includeDeleted),
    queryFn: () => (includeDeleted ? readTableWithDeleted<T>(table) : readTable<T>(table)),
    // IndexedDB is the source of truth for reads. It is never stale the way a
    // network response is, so there is nothing to revalidate against, and
    // 'always' keeps it readable when the browser thinks it is offline.
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: 'always',
  })
}

/** Re-read after a local write or an incoming pull. */
export function useRefreshLocal() {
  const client = useQueryClient()
  return useCallback(
    (tables?: readonly SyncTableName[]) => {
      if (!tables) {
        void client.invalidateQueries({ queryKey: ['local'] })
        return
      }
      for (const table of tables) void client.invalidateQueries({ queryKey: ['local', table] })
    },
    [client],
  )
}

/** Sorted by a text field, case-insensitively. */
export function byText<T>(rows: SyncRow<T>[], field: keyof T) {
  return [...rows].sort((a, b) =>
    String(a[field] ?? '').localeCompare(String(b[field] ?? ''), undefined, {
      sensitivity: 'base',
    }),
  )
}
