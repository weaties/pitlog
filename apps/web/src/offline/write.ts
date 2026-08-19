/**
 * Making a row on a device that may never have met the server.
 *
 * The id is generated here and is permanent — the server never renumbers it
 * (see the `offline-sync` skill). That is what lets a phone with no signal log
 * a fill, attach a photo to it, and render it, all before anyone else has heard
 * of the row.
 */

import type { SyncRow, SyncTableName } from '@pitlog/sync'
import { writeLocal } from './client.js'
import { recordWriteFailure } from './writeFailures.js'

export function newId(): string {
  return crypto.randomUUID()
}

export interface RowContext {
  teamId: string
  /** The signed-in user: attribution, and the merge tie-break. */
  userId: string | null
}

/**
 * Stamp the sync envelope onto a row being written.
 *
 * `client_updated_at` comes from *this device's* clock on purpose. It is the
 * merge comparator, and using the server's would silently reorder writes made
 * offline hours earlier — the failure the whole design exists to prevent.
 */
export async function saveRow<T>(
  table: SyncTableName,
  row: SyncRow<T>,
  context: RowContext,
): Promise<SyncRow<T>> {
  const stamped: SyncRow<T> = {
    ...row,
    team_id: context.teamId,
    client_updated_at: new Date(),
    updated_by: context.userId,
  }

  // A write that cannot reach the device is worse than one that cannot reach
  // the server: the second is normal at a track, the first means the app is
  // lying about what it stored. Surfaced rather than swallowed by the `void`
  // at every call site.
  try {
    await writeLocal(table, stamped)
  } catch (error) {
    recordWriteFailure(error)
    throw error
  }
  return stamped
}

/**
 * Soft delete. The row stays, so the delete can be replayed onto a device that
 * never saw it and so a delete that loses a merge can still be surfaced.
 */
export async function deleteRow<T>(
  table: SyncTableName,
  row: SyncRow<T>,
  context: RowContext,
): Promise<void> {
  try {
    await writeLocal(table, {
      ...row,
      team_id: context.teamId,
      deleted_at: new Date(),
      client_updated_at: new Date(),
      updated_by: context.userId,
    })
  } catch (error) {
    recordWriteFailure(error)
    throw error
  }
}
