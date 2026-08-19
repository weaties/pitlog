import { describe, expect, it } from 'vitest'
import type { VisitorSource } from './visitor-view.js'
import { toVisitorWeekend } from './visitor-view.js'

const source: VisitorSource = {
  team: { id: 'team-1', name: 'Rusty Nail Racing' },
  event: { id: 'e1', name: 'Autumn Enduro 8', track_name: 'Thunderhill', timezone: 'UTC' },
  session: {
    id: 's1',
    name: 'Race',
    starts_at: '2026-10-10T15:00:00.000Z',
    scheduled_duration_seconds: 28800,
  },
  drivers: [
    { id: 'd1', first_name: 'Ana', last_name: 'Ruiz', can_drive: true },
    { id: 'd2', first_name: 'Bo', last_name: 'Nakamura', can_drive: true },
  ],
  stints: [
    {
      id: 'st2',
      driver_id: 'd2',
      sequence: 2,
      planned_start_at: null,
      planned_end_at: null,
      started_at: null,
      ended_at: null,
    },
    {
      id: 'st1',
      driver_id: 'd1',
      sequence: 1,
      planned_start_at: '2026-10-10T15:00:00.000Z',
      planned_end_at: null,
      started_at: '2026-10-10T15:01:00.000Z',
      ended_at: null,
    },
  ],
  laps: [
    {
      id: 'l1',
      driver_id: 'd1',
      lap_number: 1,
      lap_time_ms: 152_000,
      position: 12,
      source: 'official',
    },
    {
      id: 'l2',
      driver_id: 'd1',
      lap_number: 2,
      lap_time_ms: 149_500,
      position: 11,
      source: 'official',
    },
    {
      id: 'l3',
      driver_id: 'd1',
      lap_number: 2,
      lap_time_ms: 140_000,
      position: null,
      source: 'gps',
    },
  ],
}

/** Every string that appears anywhere in the payload, however deeply nested. */
function allStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.push(key)
      allStrings(item, found)
    }
  }
  return found
}

describe('toVisitorWeekend — what must never be in the payload', () => {
  const payload = toVisitorWeekend(source)
  const strings = allStrings(payload)

  it('carries no last names', () => {
    expect(strings).not.toContain('Ruiz')
    expect(strings).not.toContain('Nakamura')
    expect(strings).not.toContain('last_name')
    expect(strings).not.toContain('lastName')
  })

  it('carries no email addresses or user ids', () => {
    expect(strings.some((s) => s.includes('@'))).toBe(false)
    expect(strings).not.toContain('user_id')
    expect(strings).not.toContain('email')
  })

  it('carries nothing about money', () => {
    // Hiding expenses in the UI while shipping them in the JSON is not hiding
    // them. Anyone can open the network tab.
    for (const forbidden of ['expenses', 'amount_cents', 'amountCents', 'cost_cents', 'shares']) {
      expect(strings).not.toContain(forbidden)
    }
  })

  it('carries no team id, so a link cannot be used to address another team', () => {
    expect(strings).not.toContain('team-1')
  })

  it('leaks nothing when a driver row grows a new column', () => {
    // Nothing in the serializer spreads a source row, so a column added to
    // `drivers` tomorrow cannot arrive here by accident.
    const withSecret = {
      ...source,
      drivers: [{ ...source.drivers[0], home_address: '12 Pit Lane' } as never],
    }
    expect(allStrings(toVisitorWeekend(withSecret))).not.toContain('12 Pit Lane')
  })
})

describe('toVisitorWeekend — what visitors came for', () => {
  const payload = toVisitorWeekend(source)

  it('names the team, the race and the session', () => {
    expect(payload.team.name).toBe('Rusty Nail Racing')
    expect(payload.event?.name).toBe('Autumn Enduro 8')
    expect(payload.session?.name).toBe('Race')
  })

  it('gives first names', () => {
    expect(payload.drivers).toEqual([
      { id: 'd1', firstName: 'Ana' },
      { id: 'd2', firstName: 'Bo' },
    ])
  })

  it('puts the stint schedule in order', () => {
    expect(payload.stints.map((s) => s.sequence)).toEqual([1, 2])
    expect(payload.stints[0]?.startedAt).toBe('2026-10-10T15:01:00.000Z')
  })

  it('shows official timing only', () => {
    // Official timing is the truth for standings; GPS is for telemetry
    // alignment and has no business in a public view.
    expect(payload.laps).toHaveLength(2)
    expect(payload.laps.map((l) => l.lapTimeMs)).toEqual([152_000, 149_500])
  })

  it('picks the fastest official lap', () => {
    expect(payload.best).toEqual({ lapTimeMs: 149_500, driverId: 'd1' })
  })

  it('copes with a weekend that has not started', () => {
    const empty = toVisitorWeekend({ ...source, event: null, session: null, stints: [], laps: [] })
    expect(empty.best).toBeNull()
    expect(empty.laps).toEqual([])
    expect(empty.event).toBeNull()
  })
})
