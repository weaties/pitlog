import { describe, expect, it } from 'vitest'
import type { ConsumableEvent, ConsumableLap } from './consumables.js'
import { summariseConsumableSet } from './consumables.js'

const T = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 15, minutes))
const SET = 'set-1'

function event(
  kind: ConsumableEvent['kind'],
  minutes: number,
  corner: string | null = null,
): ConsumableEvent {
  return { id: `${kind}-${minutes}`, consumableSetId: SET, kind, occurredAt: T(minutes), corner }
}

function lap(minutes: number, ms = 150_000): ConsumableLap {
  return { id: `lap-${minutes}`, startedAt: T(minutes), lapTimeMs: ms }
}

describe('summariseConsumableSet — laps are counted, never typed', () => {
  it('counts the laps run between install and removal', () => {
    // Hand-counted laps on a tyre set are wrong by Sunday afternoon. The laps
    // table already knows.
    const summary = summariseConsumableSet({
      events: [event('install', 0), event('remove', 120)],
      laps: [lap(10), lap(30), lap(60), lap(130)],
    })

    expect(summary.laps).toBe(3)
    expect(summary.fitted).toBe(false)
  })

  it('counts up to now while the set is still on the car', () => {
    const summary = summariseConsumableSet({
      events: [event('install', 0)],
      laps: [lap(10), lap(30)],
      now: T(45),
    })

    expect(summary.laps).toBe(2)
    expect(summary.fitted).toBe(true)
  })

  it('adds up several stints on the same set', () => {
    // Tyres come off for a rain set and go back on. Both spells count.
    const summary = summariseConsumableSet({
      events: [
        event('install', 0),
        event('remove', 60),
        event('install', 180),
        event('remove', 240),
      ],
      laps: [lap(10), lap(30), lap(90), lap(200), lap(220), lap(300)],
    })

    expect(summary.laps).toBe(4)
    expect(summary.spells).toBe(2)
  })

  it('does not count laps run while the set was in the truck', () => {
    const summary = summariseConsumableSet({
      events: [event('install', 0), event('remove', 60)],
      laps: [lap(90), lap(120)],
    })

    expect(summary.laps).toBe(0)
  })

  it('reports hours on the set as well as laps', () => {
    const summary = summariseConsumableSet({
      events: [event('install', 0), event('remove', 120)],
      laps: [lap(10)],
    })

    expect(summary.hours).toBeCloseTo(2, 6)
  })

  it('sums the actual lap times when it has them', () => {
    const summary = summariseConsumableSet({
      events: [event('install', 0), event('remove', 120)],
      laps: [lap(10, 150_000), lap(30, 160_000)],
    })

    expect(summary.lapTimeMs).toBe(310_000)
  })
})

describe('summariseConsumableSet — the mess of a real weekend', () => {
  it('copes with a set removed before it was ever installed', () => {
    // Two phones, one offline: the remove synced first.
    const summary = summariseConsumableSet({ events: [event('remove', 60)], laps: [lap(10)] })
    expect(summary.laps).toBe(0)
    expect(summary.fitted).toBe(false)
  })

  it('ignores a second install while already fitted', () => {
    const summary = summariseConsumableSet({
      events: [event('install', 0), event('install', 30), event('remove', 60)],
      laps: [lap(10), lap(40)],
      now: T(90),
    })

    expect(summary.laps).toBe(2)
    expect(summary.spells).toBe(1)
  })

  it('is unbothered by events arriving out of order', () => {
    const inOrder = summariseConsumableSet({
      events: [event('install', 0), event('remove', 60)],
      laps: [lap(10)],
    })
    const shuffled = summariseConsumableSet({
      events: [event('remove', 60), event('install', 0)],
      laps: [lap(10)],
    })

    expect(shuffled).toEqual(inOrder)
  })

  it('treats rotation and inspection as things that happened, not spells', () => {
    const summary = summariseConsumableSet({
      events: [
        event('install', 0),
        event('rotate', 30, 'lf'),
        event('inspect', 45),
        event('remove', 60),
      ],
      laps: [lap(10), lap(40)],
    })

    expect(summary.laps).toBe(2)
    expect(summary.spells).toBe(1)
    expect(summary.rotations).toBe(1)
  })

  it('says nothing has happened when nothing has', () => {
    const summary = summariseConsumableSet({ events: [], laps: [] })
    expect(summary).toEqual({
      laps: 0,
      hours: 0,
      lapTimeMs: 0,
      spells: 0,
      rotations: 0,
      fitted: false,
      installedAt: null,
    })
  })

  it('reports when the current spell began, for a set that is on the car', () => {
    const summary = summariseConsumableSet({
      events: [event('install', 15)],
      laps: [],
      now: T(60),
    })
    expect(summary.installedAt).toEqual(T(15))
  })
})
