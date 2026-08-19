import { useQuery } from '@tanstack/react-query'
import type { Dashboard as DashboardData, Team } from '../lib/api.js'
import { api } from '../lib/api.js'
import { SyncStatus } from '../offline/SyncStatus.js'
import { useSync } from '../offline/useSync.js'

/**
 * The weekend dashboard. M0 renders the shell and the empty state; M1 fills it
 * with the live stint schedule, standings, and lap times.
 */
export function Dashboard() {
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => api<{ teams: Team[] }>('/api/teams'),
  })

  const teamId = teams.data?.teams[0]?.id

  const dashboard = useQuery({
    queryKey: ['dashboard', teamId],
    queryFn: () => api<DashboardData>(`/api/teams/${teamId}/dashboard`),
    enabled: Boolean(teamId),
  })

  const sync = useSync(teamId)

  if (teams.isPending) return <Shell>Loading…</Shell>

  if (!teams.data?.teams.length) {
    return (
      <Shell>
        <p className="text-pit-muted" data-testid="no-teams">
          You are not a member of any team yet.
        </p>
      </Shell>
    )
  }

  return (
    <Shell>
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="font-bold text-3xl tracking-tight" data-testid="team-name">
          {dashboard.data?.team.name ?? teams.data.teams[0]?.name}
        </h1>
        <div className="flex items-center gap-2">
          <SyncStatus state={sync} />
          {dashboard.data && (
            <span className="rounded-full bg-pit-surface px-3 py-1 text-pit-muted text-sm">
              {dashboard.data.role}
            </span>
          )}
        </div>
      </header>

      {dashboard.isPending && <p className="text-pit-muted">Loading dashboard…</p>}

      {dashboard.data && (
        <section className="flex flex-col gap-4" data-testid="dashboard">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Drivers" value={dashboard.data.counts.drivers} />
            <Stat label="Events" value={dashboard.data.counts.events} />
          </div>

          <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">Events</h2>
          {dashboard.data.events.length === 0 ? (
            <p className="text-pit-muted" data-testid="no-events">
              No race weekends yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {dashboard.data.events.map((event) => (
                <li key={event.id} className="rounded-xl border border-white/10 bg-pit-surface p-4">
                  <p className="font-medium text-lg">{event.name}</p>
                  {event.track_name && <p className="text-pit-muted text-sm">{event.track_name}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">{children}</main>
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-pit-surface p-4">
      <p className="text-pit-muted text-sm">{label}</p>
      <p className="font-bold text-3xl tabular-nums">{value}</p>
    </div>
  )
}
