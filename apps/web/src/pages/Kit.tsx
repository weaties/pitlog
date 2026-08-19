/**
 * Tyres, pads and oil — SPEC §5.2.
 *
 * The number that matters is laps on the set, and it is **derived from the laps
 * table, never typed**. A crew hand-counting is wrong by Sunday afternoon, and
 * wrong in the direction that gets somebody sent out on cords.
 *
 * The set label is the human one written on the tyre in paint pen, because that
 * is what somebody standing over a stack of wheels can actually read.
 */

import type { ConsumableEvent, ConsumableLap } from '@pitlog/domain'
import { summariseConsumableSet } from '@pitlog/domain'
import type { SyncRow } from '@pitlog/sync'
import { useState } from 'react'
import { useCurrentTeam } from '../lib/team.js'
import { useLocalTable, useRefreshLocal } from '../offline/useLocalTable.js'
import { useSync } from '../offline/useSync.js'
import { newId, saveRow } from '../offline/write.js'
import { Button, Card, Empty, Field, Input, Select } from '../ui/controls.js'
import { Shell } from '../ui/Shell.js'

interface SetRow {
  kind: 'tires' | 'brake_pads' | 'oil'
  label: string
  spec: string | null
  retired_at: string | null
}
interface EventRow {
  consumable_set_id: string
  session_id: string | null
  kind: 'install' | 'rotate' | 'remove' | 'inspect'
  occurred_at: string
  corner: string | null
  laps_on_set: number | null
  hours_on_set: string | null
  notes: string | null
}
interface LapRow {
  started_at: string | null
  lap_time_ms: number | null
  source: string
}

const KINDS: SetRow['kind'][] = ['tires', 'brake_pads', 'oil']
const CORNERS = ['all', 'lf', 'rf', 'lr', 'rr']

export function KitPage() {
  const { teamId, userId, canWrite, loading } = useCurrentTeam()
  const sync = useSync(teamId)
  const sets = useLocalTable<SetRow>('consumable_sets')
  const events = useLocalTable<EventRow>('consumable_events')
  const laps = useLocalTable<LapRow>('laps')
  const refresh = useRefreshLocal()
  const [adding, setAdding] = useState(false)

  if (loading) return <Shell title="Kit">Loading…</Shell>
  if (!teamId) return <Shell title="Kit">You are not a member of any team yet.</Shell>

  const context = { teamId, userId }

  // Official timing only: a GPS lap and an official lap are the same lap, and
  // counting both would double every tyre's life.
  const timedLaps: ConsumableLap[] = (laps.data ?? [])
    .filter((lap) => lap.source === 'official' && lap.started_at !== null)
    .map((lap) => ({
      id: lap.id,
      startedAt: new Date(lap.started_at as string),
      lapTimeMs: lap.lap_time_ms,
    }))

  const logEvent = async (setId: string, kind: EventRow['kind'], corner: string | null) => {
    await saveRow(
      'consumable_events',
      {
        id: newId(),
        deleted_at: null,
        consumable_set_id: setId,
        session_id: null,
        kind,
        occurred_at: new Date().toISOString(),
        corner,
        laps_on_set: null,
        hours_on_set: null,
        notes: null,
      } as unknown as SyncRow<EventRow>,
      context,
    )
    refresh(['consumable_events'])
  }

  const live = (sets.data ?? []).filter((set) => set.retired_at === null)

  return (
    <Shell
      title="Kit"
      sync={sync}
      actions={
        canWrite ? (
          <Button tone="primary" onClick={() => setAdding(true)} data-testid="add-set">
            Add
          </Button>
        ) : null
      }
    >
      {adding && (
        <SetForm
          onCancel={() => setAdding(false)}
          onSave={async (draft) => {
            await saveRow(
              'consumable_sets',
              {
                id: newId(),
                deleted_at: null,
                retired_at: null,
                ...draft,
              } as unknown as SyncRow<SetRow>,
              context,
            )
            refresh(['consumable_sets'])
            setAdding(false)
          }}
        />
      )}

      {live.length === 0 && !adding && <Empty>No tyres, pads or oil tracked yet.</Empty>}

      <ul className="flex flex-col gap-3" data-testid="sets">
        {live.map((set) => {
          const own: ConsumableEvent[] = (events.data ?? [])
            .filter((e) => e.consumable_set_id === set.id)
            .map((e) => ({
              id: e.id,
              consumableSetId: e.consumable_set_id,
              kind: e.kind,
              occurredAt: new Date(e.occurred_at),
              corner: e.corner,
            }))

          const summary = summariseConsumableSet({ events: own, laps: timedLaps })

          return (
            <li key={set.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-lg">{set.label}</p>
                    <p className="text-pit-muted text-sm">
                      {set.kind.replace('_', ' ')}
                      {set.spec && ` · ${set.spec}`}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-sm ${
                      summary.fitted
                        ? 'bg-pit-accent/15 text-pit-accent'
                        : 'bg-pit-surface text-pit-muted'
                    }`}
                    data-testid={`state-${set.id}`}
                  >
                    {summary.fitted ? 'on the car' : 'off'}
                  </span>
                </div>

                <dl className="grid grid-cols-3 gap-2" data-testid={`life-${set.id}`}>
                  <Stat label="Laps" value={String(summary.laps)} />
                  <Stat label="Hours" value={summary.hours.toFixed(1)} />
                  <Stat label="Fitments" value={String(summary.spells)} />
                </dl>

                {canWrite && (
                  <div className="flex flex-wrap gap-2">
                    {summary.fitted ? (
                      <>
                        <Button
                          data-testid={`remove-${set.id}`}
                          onClick={() => void logEvent(set.id, 'remove', null)}
                        >
                          Take off
                        </Button>
                        <Button
                          data-testid={`rotate-${set.id}`}
                          onClick={() => void logEvent(set.id, 'rotate', 'all')}
                        >
                          Rotate
                        </Button>
                      </>
                    ) : (
                      <Button
                        tone="primary"
                        data-testid={`install-${set.id}`}
                        onClick={() => void logEvent(set.id, 'install', null)}
                      >
                        Fit
                      </Button>
                    )}
                    <Button
                      data-testid={`inspect-${set.id}`}
                      onClick={() => void logEvent(set.id, 'inspect', null)}
                    >
                      Inspect
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          )
        })}
      </ul>
    </Shell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/20 p-2">
      <dt className="text-pit-muted text-xs">{label}</dt>
      <dd className="font-semibold text-xl tabular-nums">{value}</dd>
    </div>
  )
}

function SetForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (draft: { kind: SetRow['kind']; label: string; spec: string | null }) => Promise<void>
}) {
  const [kind, setKind] = useState<SetRow['kind']>('tires')
  const [label, setLabel] = useState('')
  const [spec, setSpec] = useState('')

  return (
    <Card className="flex flex-col gap-4" data-testid="set-form">
      <Field label="Kind">
        {(id) => (
          <Select
            id={id}
            value={kind}
            onChange={(e) => setKind(e.target.value as SetRow['kind'])}
            data-testid="set-kind"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace('_', ' ')}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Set ID" hint="What is actually written on them in paint pen.">
        {(id) => (
          <Input
            id={id}
            value={label}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
            data-testid="set-label"
          />
        )}
      </Field>

      <Field label="Spec">
        {(id) => (
          <Input
            id={id}
            value={spec}
            placeholder="RT660 205/50R15"
            onChange={(e) => setSpec(e.target.value)}
          />
        )}
      </Field>

      <div className="flex gap-2">
        <Button
          tone="primary"
          className="flex-1"
          disabled={label.trim() === ''}
          data-testid="save-set"
          onClick={() => void onSave({ kind, label: label.trim(), spec: spec.trim() || null })}
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

export { CORNERS }
