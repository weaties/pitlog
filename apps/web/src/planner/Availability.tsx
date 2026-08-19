/**
 * Who is around, and when — #57.
 *
 * On the Plan screen rather than the roster, because availability is a fact
 * about this weekend and not about the person: somebody who has to leave at one
 * on Saturday is there all day on Sunday.
 *
 * Times are entered as wall clock, because that is how people think about it —
 * "I have to be done by one" — and converted to offsets for the solver exactly
 * once, in `usePlan`.
 */

import type { SyncRow } from '@pitlog/sync'
import { useState } from 'react'
import { useLocalTable, useRefreshLocal } from '../offline/useLocalTable.js'
import { newId, saveRow } from '../offline/write.js'
import { Button, Card, Empty } from '../ui/controls.js'

interface AvailabilityRow {
  session_id: string
  driver_id: string
  available_from_at: string | null
  available_until_at: string | null
  pinned_sequence: number | null
}

export function Availability({
  teamId,
  userId,
  sessionId,
  sessionStart,
  drivers,
  canWrite,
}: {
  teamId: string
  userId: string | null
  sessionId: string
  /** Null when the session has no start time; windows need one to mean anything. */
  sessionStart: Date | null
  drivers: { id: string; firstName: string }[]
  canWrite: boolean
}) {
  const rows = useLocalTable<AvailabilityRow>('driver_availability')
  const refresh = useRefreshLocal()
  const [open, setOpen] = useState(false)

  const forDriver = (driverId: string) =>
    (rows.data ?? []).find((r) => r.session_id === sessionId && r.driver_id === driverId)

  const setWindow = async (driverId: string, field: 'from' | 'until', value: string) => {
    const existing = forDriver(driverId)
    const at = value === '' ? null : atClock(sessionStart, value)

    await saveRow(
      'driver_availability',
      {
        ...(existing ?? {
          id: newId(),
          deleted_at: null,
          session_id: sessionId,
          driver_id: driverId,
          available_from_at: null,
          available_until_at: null,
          pinned_sequence: null,
        }),
        ...(field === 'from' ? { available_from_at: at } : { available_until_at: at }),
      } as unknown as SyncRow<AvailabilityRow>,
      { teamId, userId },
    )
    refresh(['driver_availability'])
  }

  const constrained = drivers.filter((d) => {
    const row = forDriver(d.id)
    return row?.available_from_at || row?.available_until_at
  })

  if (!sessionStart) {
    return (
      <Card data-testid="availability">
        <p className="text-pit-muted text-sm">
          Give the session a start time before setting who is available when — a window has nothing
          to be relative to otherwise.
        </p>
      </Card>
    )
  }

  return (
    <section className="flex flex-col gap-2" data-testid="availability">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">
          Who is available
        </h2>
        {canWrite && (
          <Button onClick={() => setOpen(!open)} data-testid="toggle-availability">
            {open ? 'Done' : 'Set'}
          </Button>
        )}
      </div>

      {!open &&
        (constrained.length === 0 ? (
          <Empty>Everyone is around for the whole session.</Empty>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="availability-summary">
            {constrained.map((driver) => {
              const row = forDriver(driver.id)
              return (
                <li
                  key={driver.id}
                  className="flex justify-between rounded-lg bg-pit-surface px-3 py-2 text-sm"
                >
                  <span>{driver.firstName}</span>
                  <span className="text-pit-muted tabular-nums">
                    {row?.available_from_at ? `from ${hhmm(row.available_from_at)}` : ''}
                    {row?.available_from_at && row?.available_until_at ? ' · ' : ''}
                    {row?.available_until_at ? `until ${hhmm(row.available_until_at)}` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        ))}

      {open && (
        <Card className="flex flex-col gap-3">
          {drivers.map((driver) => {
            const row = forDriver(driver.id)
            return (
              <div key={driver.id} className="flex items-center justify-between gap-2">
                <span className="flex-1">{driver.firstName}</span>
                <input
                  type="time"
                  aria-label={`${driver.firstName} available from`}
                  data-testid={`from-${driver.id}`}
                  value={row?.available_from_at ? hhmm(row.available_from_at) : ''}
                  onChange={(e) => void setWindow(driver.id, 'from', e.target.value)}
                  className="min-h-tap rounded-xl border border-white/10 bg-pit-surface px-3 text-pit-fg"
                />
                <input
                  type="time"
                  aria-label={`${driver.firstName} available until`}
                  data-testid={`until-${driver.id}`}
                  value={row?.available_until_at ? hhmm(row.available_until_at) : ''}
                  onChange={(e) => void setWindow(driver.id, 'until', e.target.value)}
                  className="min-h-tap rounded-xl border border-white/10 bg-pit-surface px-3 text-pit-fg"
                />
              </div>
            )
          })}
          <p className="text-pit-muted text-xs">
            Leave blank for the whole session. A driver is only given a stint that fits entirely
            inside their window.
          </p>
        </Card>
      )}
    </section>
  )
}

/** "13:00" on the session's own day, so a window means what it says locally. */
function atClock(sessionStart: Date | null, value: string): string | null {
  if (!sessionStart) return null
  const [hours, minutes] = value.split(':').map(Number)
  const at = new Date(sessionStart)
  at.setHours(hours ?? 0, minutes ?? 0, 0, 0)
  return at.toISOString()
}

function hhmm(iso: string): string {
  const at = new Date(iso)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
