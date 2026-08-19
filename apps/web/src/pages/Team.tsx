/**
 * The roster, and the race the crew is planning around.
 *
 * Both are edited in the paddock, where there is no signal, so both are
 * ordinary offline writes: they land in IndexedDB and reach the server later.
 * Nothing on this screen awaits a network.
 */

import type { SyncRow } from '@pitlog/sync'
import { useState } from 'react'
import { useCurrentTeam } from '../lib/team.js'
import { byText, useLocalTable, useRefreshLocal } from '../offline/useLocalTable.js'
import { useSync } from '../offline/useSync.js'
import { deleteRow, newId, saveRow } from '../offline/write.js'
import { Button, Card, Empty, Field, Input, Toggle } from '../ui/controls.js'
import { Shell } from '../ui/Shell.js'

interface Driver {
  first_name: string
  last_name: string | null
  can_drive: boolean
  min_stint_seconds: number | null
  max_stint_seconds: number | null
  burn_rate_factor: string | null
  notes: string | null
}

const MINUTES = 60

export function TeamPage() {
  const { team, teamId, userId, canWrite, isAdmin, loading } = useCurrentTeam()
  const sync = useSync(teamId)
  const drivers = useLocalTable<Driver>('drivers')
  const refresh = useRefreshLocal()
  const [editing, setEditing] = useState<SyncRow<Driver> | 'new' | null>(null)

  if (loading) return <Shell title="Team">Loading…</Shell>
  if (!teamId) return <Shell title="Team">You are not a member of any team yet.</Shell>

  const context = { teamId, userId }
  const roster = byText(drivers.data ?? [], 'first_name')

  const save = async (row: SyncRow<Driver>) => {
    await saveRow('drivers', row as never, context)
    refresh(['drivers'])
    setEditing(null)
  }

  return (
    <Shell
      title={team?.name ?? 'Team'}
      sync={sync}
      actions={
        canWrite ? (
          <Button tone="primary" onClick={() => setEditing('new')} data-testid="add-driver">
            Add
          </Button>
        ) : null
      }
    >
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">
          Roster ({roster.length})
        </h2>

        {roster.length === 0 && <Empty>Nobody on the roster yet.</Empty>}

        <ul className="flex flex-col gap-2" data-testid="roster">
          {roster.map((driver) => (
            <li key={driver.id}>
              <Card>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-lg">
                      {driver.first_name} {driver.last_name ?? ''}
                    </p>
                    <p className="text-pit-muted text-sm">
                      {driver.can_drive
                        ? `${seconds(driver.min_stint_seconds)}–${seconds(driver.max_stint_seconds)} stint`
                        : 'Shares costs, does not drive'}
                    </p>
                  </div>
                  {canWrite && (
                    <Button
                      onClick={() => setEditing(driver)}
                      aria-label={`Edit ${driver.first_name}`}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      {editing && (
        <DriverForm
          driver={editing === 'new' ? null : editing}
          canDelete={isAdmin && editing !== 'new'}
          onCancel={() => setEditing(null)}
          onSave={save}
          onDelete={async (row) => {
            await deleteRow('drivers', row, context)
            refresh(['drivers'])
            setEditing(null)
          }}
        />
      )}
    </Shell>
  )
}

function seconds(value: number | null): string {
  return value === null ? '—' : `${Math.round(value / MINUTES)}m`
}

function DriverForm({
  driver,
  canDelete,
  onCancel,
  onSave,
  onDelete,
}: {
  driver: SyncRow<Driver> | null
  canDelete: boolean
  onCancel: () => void
  onSave: (row: SyncRow<Driver>) => Promise<void>
  onDelete: (row: SyncRow<Driver>) => Promise<void>
}) {
  const [form, setForm] = useState({
    first_name: driver?.first_name ?? '',
    last_name: driver?.last_name ?? '',
    can_drive: driver?.can_drive ?? true,
    min_minutes: driver?.min_stint_seconds ? driver.min_stint_seconds / MINUTES : 30,
    max_minutes: driver?.max_stint_seconds ? driver.max_stint_seconds / MINUTES : 90,
  })

  const invalid = form.first_name.trim() === '' || form.max_minutes < form.min_minutes

  return (
    <Card className="flex flex-col gap-4" data-testid="driver-form">
      <Field label="First name">
        {(id) => (
          <Input
            id={id}
            value={form.first_name}
            autoFocus
            onChange={(e) => setForm({ ...form, first_name: e.target.value })}
            data-testid="driver-first-name"
          />
        )}
      </Field>

      <Field label="Last name" hint="Visitors only ever see first names — SPEC §4.">
        {(id) => (
          <Input
            id={id}
            value={form.last_name}
            onChange={(e) => setForm({ ...form, last_name: e.target.value })}
          />
        )}
      </Field>

      <Toggle
        label="Takes a seat"
        hint="Crew who share costs but never drive still need a row."
        checked={form.can_drive}
        onChange={(can_drive) => setForm({ ...form, can_drive })}
      />

      {form.can_drive && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min stint (min)">
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                value={form.min_minutes}
                onChange={(e) => setForm({ ...form, min_minutes: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Max stint (min)">
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                value={form.max_minutes}
                onChange={(e) => setForm({ ...form, max_minutes: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
      )}

      {form.max_minutes < form.min_minutes && (
        <p className="text-red-300 text-sm">Maximum stint cannot be shorter than the minimum.</p>
      )}

      <div className="flex gap-2">
        <Button
          tone="primary"
          className="flex-1"
          disabled={invalid}
          data-testid="save-driver"
          onClick={() =>
            void onSave({
              ...(driver ?? { id: newId(), deleted_at: null }),
              first_name: form.first_name.trim(),
              last_name: form.last_name.trim() || null,
              can_drive: form.can_drive,
              min_stint_seconds: form.can_drive ? form.min_minutes * MINUTES : null,
              max_stint_seconds: form.can_drive ? form.max_minutes * MINUTES : null,
              burn_rate_factor: driver?.burn_rate_factor ?? null,
              notes: driver?.notes ?? null,
            } as SyncRow<Driver>)
          }
        >
          Save
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {canDelete && driver && (
        <Button tone="danger" onClick={() => void onDelete(driver)}>
          Remove from roster
        </Button>
      )}
    </Card>
  )
}
