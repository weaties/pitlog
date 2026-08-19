/**
 * The race the crew is planning around: the event, its sessions, and the two
 * numbers the planner cannot run without.
 *
 * Fuel capacity and a seed burn rate live on the event because they are
 * properties of this car at this race — a different tank or a different
 * restrictor makes them different numbers. Until at least one full-tank fill
 * is logged, the seed *is* the burn-rate model, which is why the planner says
 * so on screen rather than presenting the seed as a measurement.
 */

import type { SyncRow } from '@pitlog/sync'
import { useState } from 'react'
import { useCurrentTeam } from '../lib/team.js'
import { useLocalTable, useRefreshLocal } from '../offline/useLocalTable.js'
import { useSync } from '../offline/useSync.js'
import { newId, saveRow } from '../offline/write.js'
import { useRules } from '../planner/usePlan.js'
import { Button, Card, Empty, Field, Input, Select } from '../ui/controls.js'
import { Shell } from '../ui/Shell.js'

interface Event {
  name: string
  track_name: string | null
  timezone: string
  starts_at: string | null
  ends_at: string | null
  fuel_capacity_gallons: string | null
  burn_rate_gph: string | null
  series_id: string | null
  rule_config_id: string | null
}

interface Session {
  event_id: string
  kind: 'practice' | 'qualifying' | 'race'
  name: string
  starts_at: string | null
  ends_at: string | null
  scheduled_duration_seconds: number | null
}

export function RacePage() {
  const { team, teamId, userId, canWrite, loading } = useCurrentTeam()
  const sync = useSync(teamId)
  const events = useLocalTable<Event>('events')
  const sessions = useLocalTable<Session>('sessions')
  const refresh = useRefreshLocal()
  const rules = useRules(teamId)
  const [editing, setEditing] = useState<SyncRow<Event> | 'new' | null>(null)
  const [addingSessionTo, setAddingSessionTo] = useState<string | null>(null)

  if (loading) return <Shell title="Race">Loading…</Shell>
  if (!teamId) return <Shell title="Race">You are not a member of any team yet.</Shell>

  const context = { teamId, userId }
  const seriesName = (id: string | null) =>
    (rules.data ?? []).find((r) => r.series_id === id)?.series_name
  const all = [...(events.data ?? [])].sort((a, b) =>
    String(a.starts_at ?? '').localeCompare(String(b.starts_at ?? '')),
  )

  return (
    <Shell
      title={team?.name ?? 'Race'}
      sync={sync}
      actions={
        canWrite ? (
          <Button tone="primary" onClick={() => setEditing('new')} data-testid="add-event">
            Add
          </Button>
        ) : null
      }
    >
      {all.length === 0 && !editing && (
        <Empty>{sync.lastRunAt ? 'No race weekends yet.' : 'Fetching the weekend…'}</Empty>
      )}

      <ul className="flex flex-col gap-3" data-testid="events">
        {all.map((event) => {
          const own = (sessions.data ?? []).filter((s) => s.event_id === event.id)
          return (
            <li key={event.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-lg">{event.name}</p>
                    {event.track_name && (
                      <p className="text-pit-muted text-sm">{event.track_name}</p>
                    )}
                    <p className="text-pit-muted text-sm tabular-nums">
                      {event.fuel_capacity_gallons ?? '—'} gal tank · {event.burn_rate_gph ?? '—'}{' '}
                      gal/h seed
                    </p>
                    {/* Which rulebook binds this race. Absent is worth saying
                        out loud: the planner will apply no series rules at all. */}
                    <p className="text-sm" data-testid={`series-${event.id}`}>
                      {seriesName(event.series_id) ?? (
                        <span className="text-amber-300">No series rules</span>
                      )}
                    </p>
                  </div>
                  {canWrite && <Button onClick={() => setEditing(event)}>Edit</Button>}
                </div>

                <ul className="flex flex-col gap-1">
                  {own.map((session) => (
                    <li
                      key={session.id}
                      className="flex justify-between rounded-lg bg-black/20 px-3 py-2 text-sm"
                    >
                      <span>{session.name}</span>
                      <span className="text-pit-muted tabular-nums">
                        {session.scheduled_duration_seconds
                          ? `${Math.round(session.scheduled_duration_seconds / 3600)} h`
                          : '—'}
                      </span>
                    </li>
                  ))}
                </ul>

                {canWrite && (
                  <Button onClick={() => setAddingSessionTo(event.id)}>Add session</Button>
                )}

                {addingSessionTo === event.id && (
                  <SessionForm
                    onCancel={() => setAddingSessionTo(null)}
                    onSave={async (session) => {
                      await saveRow(
                        'sessions',
                        { ...session, event_id: event.id } as never,
                        context,
                      )
                      refresh(['sessions'])
                      setAddingSessionTo(null)
                    }}
                  />
                )}
              </Card>
            </li>
          )
        })}
      </ul>

      {editing && (
        <EventForm
          teamId={teamId}
          event={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (row) => {
            await saveRow('events', row as never, context)
            refresh(['events'])
            setEditing(null)
          }}
        />
      )}
    </Shell>
  )
}

function EventForm({
  teamId,
  event,
  onCancel,
  onSave,
}: {
  teamId: string
  event: SyncRow<Event> | null
  onCancel: () => void
  onSave: (row: SyncRow<Event>) => Promise<void>
}) {
  const rules = useRules(teamId)
  const [form, setForm] = useState({
    name: event?.name ?? '',
    track_name: event?.track_name ?? '',
    timezone: event?.timezone ?? 'UTC',
    fuel_capacity_gallons: event?.fuel_capacity_gallons ?? '',
    burn_rate_gph: event?.burn_rate_gph ?? '',
  })
  const [chosenSeries, setChosenSeries] = useState<string | null>(null)
  const seriesId = chosenSeries ?? event?.series_id ?? ''

  return (
    <Card className="flex flex-col gap-4" data-testid="event-form">
      <Field label="Race name">
        {(id) => (
          <Input
            id={id}
            value={form.name}
            autoFocus
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            data-testid="event-name"
          />
        )}
      </Field>
      <Field label="Track">
        {(id) => (
          <Input
            id={id}
            value={form.track_name}
            onChange={(e) => setForm({ ...form, track_name: e.target.value })}
          />
        )}
      </Field>

      <Field
        label="Series"
        hint="Decides which rulebook the planner is bound by. The three differ."
      >
        {(id) => (
          <Select
            id={id}
            value={seriesId}
            onChange={(e) => setChosenSeries(e.target.value)}
            data-testid="event-series"
          >
            <option value="">No series rules</option>
            {(rules.data ?? []).map((rule) => (
              <option key={rule.series_id} value={rule.series_id}>
                {rule.series_name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Fuel capacity (gal)">
          {(id) => (
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              step="0.1"
              value={form.fuel_capacity_gallons}
              onChange={(e) => setForm({ ...form, fuel_capacity_gallons: e.target.value })}
              data-testid="event-capacity"
            />
          )}
        </Field>
        <Field
          label="Seed burn rate (gal/h)"
          hint="Replaced by measurement after the first brim fill."
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              step="0.1"
              value={form.burn_rate_gph}
              onChange={(e) => setForm({ ...form, burn_rate_gph: e.target.value })}
              data-testid="event-burn-rate"
            />
          )}
        </Field>
      </div>

      <div className="flex gap-2">
        <Button
          tone="primary"
          className="flex-1"
          disabled={form.name.trim() === ''}
          data-testid="save-event"
          onClick={() =>
            void onSave({
              ...(event ?? { id: newId(), deleted_at: null }),
              name: form.name.trim(),
              track_name: form.track_name.trim() || null,
              timezone: form.timezone,
              starts_at: event?.starts_at ?? null,
              ends_at: event?.ends_at ?? null,
              fuel_capacity_gallons: form.fuel_capacity_gallons || null,
              burn_rate_gph: form.burn_rate_gph || null,
              series_id: seriesId || null,
              rule_config_id: event?.rule_config_id ?? null,
            } as SyncRow<Event>)
          }
        >
          Save
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

function SessionForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (row: Record<string, unknown> & { id: string }) => Promise<void>
}) {
  const [form, setForm] = useState({ name: 'Race', kind: 'race' as Session['kind'], hours: 8 })

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/10 p-3">
      <Field label="Session name">
        {(id) => (
          <Input
            id={id}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind">
          {(id) => (
            <Select
              id={id}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as Session['kind'] })}
            >
              <option value="race">Race</option>
              <option value="practice">Practice</option>
              <option value="qualifying">Qualifying</option>
            </Select>
          )}
        </Field>
        <Field label="Length (hours)">
          {(id) => (
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              step="0.5"
              value={form.hours}
              onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}
            />
          )}
        </Field>
      </div>
      <div className="flex gap-2">
        <Button
          tone="primary"
          className="flex-1"
          onClick={() =>
            void onSave({
              id: newId(),
              deleted_at: null,
              kind: form.kind,
              name: form.name.trim() || 'Race',
              starts_at: null,
              ends_at: null,
              scheduled_duration_seconds: Math.round(form.hours * 3600),
            })
          }
        >
          Add
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
