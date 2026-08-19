/**
 * The one-tap log — the primary race-weekend surface (SPEC §5.2).
 *
 * Two rules shape this screen and neither is negotiable:
 *
 * **One tap logs the common case.** Every button writes a row the instant it is
 * pressed. Detail is an optional second step that opens *after* the write, so
 * an interrupted crew member has still recorded the thing that happened.
 *
 * **No confirmation dialogs on the hot path.** An accidental entry is cheap to
 * delete; a missed one has to be reconstructed from memory hours later, by
 * which point nobody agrees on it.
 */

import type { CapturedStint } from '@pitlog/domain'
import { applyDriverIn, applyDriverOut, openStint } from '@pitlog/domain'
import type { SyncRow } from '@pitlog/sync'
import { useState } from 'react'
import { useCurrentTeam } from '../lib/team.js'
import { Conflicts } from '../offline/Conflicts.js'
import { useLocalTable, useRefreshLocal } from '../offline/useLocalTable.js'
import { useSync } from '../offline/useSync.js'
import { newId, saveRow } from '../offline/write.js'
import { Button, Card, Empty, Field, Input, Toggle } from '../ui/controls.js'
import { Shell } from '../ui/Shell.js'

type LogKind =
  | 'driver_in'
  | 'driver_out'
  | 'fuel_fill'
  | 'tire_change'
  | 'tire_rotation'
  | 'brake_pad_change'
  | 'incident'
  | 'black_flag'
  | 'note'

interface LogEntry {
  event_id: string | null
  session_id: string | null
  driver_id: string | null
  kind: LogKind
  occurred_at: string
  note: string | null
  payload: unknown
  logged_by: string | null
}

interface Driver {
  first_name: string
  can_drive: boolean
}

interface Session {
  event_id: string
  name: string
  kind: string
}

interface Stint extends Record<string, unknown> {
  session_id: string
  driver_id: string | null
  sequence: number
  planned_start_at: string | null
  planned_end_at: string | null
  started_at: string | null
  ended_at: string | null
}

const BUTTONS: { kind: LogKind; label: string; tone?: 'primary' | 'danger' }[] = [
  { kind: 'driver_in', label: 'Driver in', tone: 'primary' },
  { kind: 'driver_out', label: 'Driver out', tone: 'primary' },
  { kind: 'fuel_fill', label: 'Fuel fill' },
  { kind: 'tire_change', label: 'Tire change' },
  { kind: 'tire_rotation', label: 'Tire rotation' },
  { kind: 'brake_pad_change', label: 'Brake pads' },
  { kind: 'incident', label: 'Incident', tone: 'danger' },
  { kind: 'black_flag', label: 'Black flag', tone: 'danger' },
  { kind: 'note', label: 'Note' },
]

export function LogPage() {
  const { teamId, userId, canWrite, loading } = useCurrentTeam()
  const sync = useSync(teamId)
  const drivers = useLocalTable<Driver>('drivers')
  const sessions = useLocalTable<Session>('sessions')
  const stints = useLocalTable<Stint>('stints')
  const entries = useLocalTable<LogEntry>('log_entries')
  const refresh = useRefreshLocal()

  const [detail, setDetail] = useState<{ kind: LogKind; entryId: string } | null>(null)
  const [pendingDriverIn, setPendingDriverIn] = useState(false)

  if (loading) return <Shell title="Log">Loading…</Shell>
  if (!teamId) return <Shell title="Log">You are not a member of any team yet.</Shell>

  const context = { teamId, userId }
  const session = (sessions.data ?? [])[0]
  const sessionStints = asCaptured(stints.data ?? [])
  const inCar = session ? openStint(sessionStints, session.id) : null
  const driverName = (id: string | null) =>
    (drivers.data ?? []).find((d) => d.id === id)?.first_name ?? 'Unknown'

  /** Write the log entry first, always. Detail can follow; the fact cannot. */
  const log = async (kind: LogKind, extra: Partial<LogEntry> = {}) => {
    const id = newId()
    await saveRow(
      'log_entries',
      {
        id,
        deleted_at: null,
        event_id: session?.event_id ?? null,
        session_id: session?.id ?? null,
        driver_id: null,
        kind,
        occurred_at: new Date().toISOString(),
        note: null,
        payload: null,
        logged_by: userId,
        ...extra,
      } as unknown as SyncRow<LogEntry>,
      context,
    )
    refresh(['log_entries'])
    return id
  }

  const captureDriverIn = async (driverId: string) => {
    if (!session) return
    const at = new Date()
    const result = applyDriverIn(sessionStints, {
      sessionId: session.id,
      driverId,
      at,
      newId,
    })

    if (result.closed) await saveRow('stints', toRow(result.closed), context)
    await saveRow('stints', toRow(result.stint), context)
    await log('driver_in', { driver_id: driverId })
    refresh(['stints', 'log_entries'])
    setPendingDriverIn(false)
  }

  const captureDriverOut = async () => {
    if (!session) return
    const result = applyDriverOut(sessionStints, {
      sessionId: session.id,
      at: new Date(),
      driverId: inCar?.driver_id ?? null,
      newId,
    })
    await saveRow('stints', toRow(result.stint), context)
    await log('driver_out', { driver_id: result.stint.driver_id })
    refresh(['stints', 'log_entries'])
  }

  const onTap = async (kind: LogKind) => {
    if (kind === 'driver_in') {
      setPendingDriverIn(true)
      return
    }
    if (kind === 'driver_out') {
      await captureDriverOut()
      return
    }
    const entryId = await log(kind)
    // Detail is offered, never demanded — the row already exists.
    setDetail({ kind, entryId })
  }

  const recent = [...(entries.data ?? [])]
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
    .slice(0, 12)

  return (
    <Shell title="Log" sync={sync}>
      <Conflicts teamId={teamId} userId={userId} nameFor={() => 'Another device'} />

      <Card className="flex items-center justify-between">
        <div>
          <p className="text-pit-muted text-sm">On track</p>
          <p className="text-xl" data-testid="in-car">
            {inCar ? driverName(inCar.driver_id) : 'Nobody — car in the pits'}
          </p>
        </div>
      </Card>

      {!session && <Empty>Add a race and a session first.</Empty>}

      {canWrite && session && (
        <div className="grid grid-cols-2 gap-3" data-testid="log-buttons">
          {BUTTONS.map((button) => (
            <Button
              key={button.kind}
              tone={button.tone ?? 'default'}
              className="min-h-[5rem]"
              data-testid={`log-${button.kind}`}
              disabled={button.kind === 'driver_out' && !inCar}
              onClick={() => void onTap(button.kind)}
            >
              {button.label}
            </Button>
          ))}
        </div>
      )}

      {pendingDriverIn && (
        <Card className="flex flex-col gap-3" data-testid="driver-picker">
          <p className="text-pit-muted text-sm">Who got in?</p>
          {(drivers.data ?? [])
            .filter((d) => d.can_drive)
            .map((driver) => (
              <Button
                key={driver.id}
                tone="primary"
                data-testid={`pick-driver-${driver.first_name}`}
                onClick={() => void captureDriverIn(driver.id)}
              >
                {driver.first_name}
              </Button>
            ))}
          <Button onClick={() => setPendingDriverIn(false)}>Cancel</Button>
        </Card>
      )}

      {detail?.kind === 'fuel_fill' && session && (
        <FuelFillForm
          onCancel={() => setDetail(null)}
          onSave={async (fill) => {
            await saveRow(
              'fuel_fills',
              {
                id: newId(),
                deleted_at: null,
                session_id: session.id,
                stint_id: inCar?.id ?? null,
                filled_at: new Date().toISOString(),
                notes: null,
                ...fill,
              } as unknown as SyncRow<Record<string, unknown>>,
              context,
            )
            refresh(['fuel_fills'])
            setDetail(null)
          }}
        />
      )}

      {detail && detail.kind !== 'fuel_fill' && (
        <NoteForm
          onCancel={() => setDetail(null)}
          onSave={async (note) => {
            const existing = (entries.data ?? []).find((e) => e.id === detail.entryId)
            if (existing) {
              await saveRow('log_entries', { ...existing, note }, context)
              refresh(['log_entries'])
            }
            setDetail(null)
          }}
        />
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">Recent</h2>
        {recent.length === 0 && <Empty>Nothing logged yet.</Empty>}
        <ul className="flex flex-col gap-1" data-testid="recent-log">
          {recent.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline justify-between gap-3 rounded-lg bg-pit-surface px-3 py-2"
            >
              <span>
                {label(entry.kind)}
                {entry.driver_id && (
                  <span className="text-pit-muted"> · {driverName(entry.driver_id)}</span>
                )}
                {entry.note && <span className="text-pit-muted"> · {entry.note}</span>}
              </span>
              <span className="text-pit-muted text-sm tabular-nums">
                {new Date(entry.occurred_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  )
}

function label(kind: LogKind): string {
  return BUTTONS.find((b) => b.kind === kind)?.label ?? kind
}

/** IndexedDB hands back ISO strings; the domain works in instants. */
function asCaptured(rows: SyncRow<Stint>[]): CapturedStint[] {
  return rows.map((row) => ({
    id: row.id,
    session_id: row.session_id,
    driver_id: row.driver_id,
    sequence: row.sequence,
    planned_start_at: date(row.planned_start_at),
    planned_end_at: date(row.planned_end_at),
    started_at: date(row.started_at),
    ended_at: date(row.ended_at),
  }))
}

function date(value: string | null): Date | null {
  return value ? new Date(value) : null
}

function toRow(stint: CapturedStint): SyncRow<Record<string, unknown>> {
  return {
    id: stint.id,
    deleted_at: null,
    session_id: stint.session_id,
    driver_id: stint.driver_id,
    sequence: stint.sequence,
    planned_start_at: stint.planned_start_at?.toISOString() ?? null,
    planned_end_at: stint.planned_end_at?.toISOString() ?? null,
    started_at: stint.started_at?.toISOString() ?? null,
    ended_at: stint.ended_at?.toISOString() ?? null,
  } as unknown as SyncRow<Record<string, unknown>>
}

/**
 * A fill is only a burn-rate datapoint if the tank went to the brim, so
 * `filled_to_full` is a deliberate switch rather than a buried checkbox — and
 * it defaults on, because brimming is what a crew actually does.
 */
function FuelFillForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (fill: {
    gallons: string
    cost_cents: number | null
    filled_to_full: boolean
  }) => Promise<void>
}) {
  const [gallons, setGallons] = useState('')
  const [dollars, setDollars] = useState('')
  const [full, setFull] = useState(true)

  return (
    <Card className="flex flex-col gap-4" data-testid="fuel-fill-form">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Gallons">
          {(id) => (
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              step="0.1"
              autoFocus
              value={gallons}
              onChange={(e) => setGallons(e.target.value)}
              data-testid="fill-gallons"
            />
          )}
        </Field>
        <Field label="Cost ($)">
          {(id) => (
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              step="0.01"
              value={dollars}
              onChange={(e) => setDollars(e.target.value)}
              data-testid="fill-cost"
            />
          )}
        </Field>
      </div>

      <Toggle
        label="Filled to the brim"
        hint="Only a brim fill can measure consumption. A splash tells the planner nothing."
        checked={full}
        onChange={setFull}
      />

      <div className="flex gap-2">
        <Button
          tone="primary"
          className="flex-1"
          disabled={!(Number(gallons) > 0)}
          data-testid="save-fill"
          onClick={() =>
            void onSave({
              gallons,
              // Money is integer cents, never a float — AGENTS.md.
              cost_cents: dollars === '' ? null : Math.round(Number(dollars) * 100),
              filled_to_full: full,
            })
          }
        >
          Save fill
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          Skip
        </Button>
      </div>
    </Card>
  )
}

function NoteForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (note: string) => Promise<void>
}) {
  const [note, setNote] = useState('')

  return (
    <Card className="flex flex-col gap-3" data-testid="note-form">
      <Field label="Add detail (optional)">
        {(id) => (
          <Input
            id={id}
            value={note}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            data-testid="detail-note"
          />
        )}
      </Field>
      <div className="flex gap-2">
        <Button
          tone="primary"
          className="flex-1"
          data-testid="save-detail"
          onClick={() => void onSave(note.trim())}
        >
          Save
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          Skip
        </Button>
      </div>
    </Card>
  )
}
