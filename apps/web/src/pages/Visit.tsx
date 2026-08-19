/**
 * The weekend, for family and friends — SPEC §4.
 *
 * Deliberately not part of the pit client: it takes the token from the URL,
 * exchanges it for a read-only session, and renders what the server sends. It
 * does not sync, does not write, and never touches IndexedDB, because a visitor
 * has no writes to queue and no reason to leave a copy of the weekend on a
 * borrowed phone.
 *
 * The payload is stripped server-side (`toVisitorWeekend`). Nothing here has to
 * remember to hide a surname, because no surname is ever sent.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { Card, Empty } from '../ui/controls.js'

interface Weekend {
  team: { name: string }
  event: { name: string; trackName: string | null; timezone: string } | null
  session: { name: string; startsAt: string | null; scheduledDurationSeconds: number | null } | null
  drivers: { id: string; firstName: string }[]
  stints: {
    sequence: number
    driverId: string | null
    plannedStartAt: string | null
    startedAt: string | null
    endedAt: string | null
  }[]
  laps: { lapNumber: number; driverId: string | null; lapTimeMs: number | null }[]
  best: { lapTimeMs: number; driverId: string | null } | null
}

export function VisitPage() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const start = useMutation({
    mutationFn: () =>
      api<{ ok: true }>(`/api/auth/visitor?token=${encodeURIComponent(token ?? '')}`, {
        method: 'POST',
      }),
  })

  const exchange = start.mutate
  useEffect(() => {
    // Exchanged once per page load; the session cookie carries it after that.
    if (token) exchange()
  }, [token, exchange])

  // Not /api/teams: a visitor has no membership rows, so that endpoint is
  // empty for them by construction. The team comes from the link.
  const me = useQuery({
    queryKey: ['visitor-me'],
    enabled: start.isSuccess,
    queryFn: () => api<{ kind: string; teamId: string | null }>('/api/me'),
  })

  const teamId = me.data?.teamId ?? undefined

  const weekend = useQuery({
    queryKey: ['weekend', teamId],
    enabled: Boolean(teamId),
    queryFn: () => api<Weekend>(`/api/teams/${teamId}/weekend`),
  })

  if (!token) return <Frame>This link is missing its token.</Frame>
  if (start.isError) return <Frame>This link has expired or been revoked.</Frame>
  if (!weekend.data) return <Frame>Loading the weekend…</Frame>

  const data = weekend.data
  const name = (id: string | null) => data.drivers.find((d) => d.id === id)?.firstName ?? '—'

  return (
    <Frame>
      <header>
        <h1 className="font-bold text-2xl tracking-tight" data-testid="visit-team">
          {data.team.name}
        </h1>
        {data.event && (
          <p className="text-pit-muted">
            {data.event.name}
            {data.event.trackName && ` · ${data.event.trackName}`}
          </p>
        )}
      </header>

      {data.best && (
        <Card data-testid="visit-best">
          <p className="text-pit-muted text-sm">Best lap</p>
          <p className="font-bold text-3xl tabular-nums">{lapTime(data.best.lapTimeMs)}</p>
          <p className="text-pit-muted">{name(data.best.driverId)}</p>
        </Card>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">
          Who is driving
        </h2>
        {data.stints.length === 0 ? (
          <Empty>The schedule is not up yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="visit-stints">
            {data.stints.map((stint) => (
              <li key={stint.sequence}>
                <Card className="flex items-center justify-between">
                  <span className="text-lg">
                    <span className="text-pit-muted tabular-nums">{stint.sequence}.</span>{' '}
                    {name(stint.driverId)}
                  </span>
                  <span className="text-pit-muted text-sm">
                    {stint.endedAt ? 'done' : stint.startedAt ? 'on track' : 'to come'}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">
          Recent laps
        </h2>
        <ul className="flex flex-col gap-1" data-testid="visit-laps">
          {data.laps
            .slice(-10)
            .reverse()
            .map((lap) => (
              <li
                key={lap.lapNumber}
                className="flex justify-between rounded-lg bg-pit-surface px-3 py-2"
              >
                <span className="text-pit-muted tabular-nums">Lap {lap.lapNumber}</span>
                <span className="tabular-nums">{lapTime(lap.lapTimeMs)}</span>
              </li>
            ))}
        </ul>
      </section>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex max-w-2xl flex-col gap-5 p-4">{children}</main>
}

function lapTime(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.floor(ms / 60_000)
  const seconds = ((ms % 60_000) / 1000).toFixed(3).padStart(6, '0')
  return `${minutes}:${seconds}`
}
