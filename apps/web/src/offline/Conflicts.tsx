/**
 * When a write loses, show it — SPEC §6.2, #24.
 *
 * The design rule this exists to honour: **never auto-merge, never discard.**
 * Two half-applied edits produce a row neither person entered, which is worse
 * than either of them. So the software surfaces, and a human resolves.
 *
 * What is shown is the *losing* value, who entered it, and when — because the
 * person who typed it is the one who needs to know it did not stick. Restoring
 * it is one tap, and is an ordinary write: it goes through the same queue, wins
 * on the same comparator, and can itself be overwritten.
 */

import type { SyncRow, SyncTableName } from '@pitlog/sync'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { Button, Card } from '../ui/controls.js'
import { useRefreshLocal } from './useLocalTable.js'
import { saveRow } from './write.js'

export interface ConflictVersion {
  id: string
  table_name: SyncTableName
  row_id: string
  snapshot: Record<string, unknown>
  client_updated_at: string
  updated_by: string | null
  superseded_by: string | null
  recorded_at: string
}

export function useConflicts(teamId: string | undefined) {
  return useQuery({
    queryKey: ['conflicts', teamId],
    enabled: Boolean(teamId),
    refetchInterval: 60_000,
    queryFn: () => api<{ conflicts: ConflictVersion[] }>(`/api/teams/${teamId}/conflicts`),
  })
}

export function Conflicts({
  teamId,
  userId,
  nameFor,
}: {
  teamId: string
  userId: string | null
  /** Turns a user id into something a human recognises. */
  nameFor?: (userId: string | null) => string
}) {
  const client = useQueryClient()
  const refresh = useRefreshLocal()
  const conflicts = useConflicts(teamId)

  const settle = useMutation({
    mutationFn: (versionId: string) =>
      api<{ acknowledged: true }>(`/api/teams/${teamId}/conflicts/${versionId}/acknowledge`, {
        method: 'POST',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['conflicts', teamId] }),
  })

  const restore = useMutation({
    mutationFn: async (version: ConflictVersion) => {
      // An ordinary write, not a special path: it queues, syncs, and wins on
      // `client_updated_at` like anything else. Restoring is a decision
      // somebody made now, so it carries now's timestamp.
      await saveRow(version.table_name, version.snapshot as unknown as SyncRow, { teamId, userId })
      await api(`/api/teams/${teamId}/conflicts/${version.id}/acknowledge`, { method: 'POST' })
    },
    onSuccess: () => {
      refresh()
      void client.invalidateQueries({ queryKey: ['conflicts', teamId] })
    },
  })

  const list = conflicts.data?.conflicts ?? []
  if (list.length === 0) return null

  const who = (id: string | null) => nameFor?.(id) ?? (id ? 'Someone else' : 'An unnamed device')

  return (
    <section className="flex flex-col gap-2" data-testid="conflicts">
      <h2 className="font-semibold text-amber-200 text-sm uppercase tracking-wide">
        Overwritten ({list.length})
      </h2>

      <ul className="flex flex-col gap-2">
        {list.map((version) => (
          <li key={version.id}>
            <Card className="flex flex-col gap-2 border-amber-400/40 bg-amber-400/10">
              <p className="text-sm">
                {who(version.updated_by)} set this {version.table_name.replace('_', ' ')} at{' '}
                {new Date(version.client_updated_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                . {who(version.superseded_by)} overwrote it.
              </p>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-black/25 p-2 text-sm">
                {summarise(version.snapshot).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-pit-muted">{key.replace(/_/g, ' ')}</dt>
                    <dd className="tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>

              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  data-testid={`restore-${version.id}`}
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(version)}
                >
                  Put it back
                </Button>
                <Button
                  className="flex-1"
                  data-testid={`dismiss-${version.id}`}
                  onClick={() => settle.mutate(version.id)}
                >
                  Keep the new value
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The fields worth showing. Bookkeeping columns are noise to a human. */
const HIDDEN = new Set([
  'id',
  'team_id',
  'client_updated_at',
  'server_updated_at',
  'updated_by',
  'deleted_at',
  'created_at',
])

function summarise(snapshot: Record<string, unknown>): [string, string][] {
  return Object.entries(snapshot)
    .filter(([key, value]) => !HIDDEN.has(key) && value !== null && value !== '')
    .slice(0, 6)
    .map(([key, value]) => [key, String(value)])
}
