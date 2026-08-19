import { describe, expect, it } from 'vitest'
import type { Orderable } from './roster-order.js'
import { compareRunningOrder, inRunningOrder, moveInOrder } from './roster-order.js'

const d = (id: string, first_name: string, sort_order: number | null = null): Orderable => ({
  id,
  first_name,
  sort_order,
})

describe('inRunningOrder', () => {
  it('puts the crew’s chosen order first', () => {
    const order = inRunningOrder([d('c', 'Cy', 2), d('a', 'Ana', 0), d('b', 'Bo', 1)])
    expect(order.map((x) => x.first_name)).toEqual(['Ana', 'Bo', 'Cy'])
  })

  it('does not let a late addition jump the queue', () => {
    // Somebody added on Saturday morning should not silently take the start
    // from an order agreed on Friday night.
    const order = inRunningOrder([d('new', 'Aaron'), d('a', 'Ana', 0), d('b', 'Bo', 1)])
    expect(order.map((x) => x.first_name)).toEqual(['Ana', 'Bo', 'Aaron'])
  })

  it('falls back to names while nobody has been placed', () => {
    const order = inRunningOrder([d('c', 'Cy'), d('a', 'Ana'), d('b', 'Bo')])
    expect(order.map((x) => x.first_name)).toEqual(['Ana', 'Bo', 'Cy'])
  })

  it('is total and stable, so two devices agree', () => {
    // The whole point of the tiebreak is reproducibility. Same names, same
    // positions, different ids — the answer must still be identical.
    const forward = inRunningOrder([d('z', 'Sam', 0), d('a', 'Sam', 0)])
    const reversed = inRunningOrder([d('a', 'Sam', 0), d('z', 'Sam', 0)])
    expect(forward.map((x) => x.id)).toEqual(reversed.map((x) => x.id))
  })

  it('does not mutate what it was given', () => {
    const roster = [d('c', 'Cy', 2), d('a', 'Ana', 0)]
    inRunningOrder(roster)
    expect(roster[0]?.first_name).toBe('Cy')
  })

  it('compares consistently for a sort', () => {
    expect(compareRunningOrder(d('a', 'Ana', 0), d('b', 'Bo', 1))).toBeLessThan(0)
    expect(compareRunningOrder(d('b', 'Bo', 1), d('a', 'Ana', 0))).toBeGreaterThan(0)
    expect(compareRunningOrder(d('a', 'Ana', 0), d('a', 'Ana', 0))).toBe(0)
  })
})

describe('moveInOrder', () => {
  const roster = [d('a', 'Ana', 0), d('b', 'Bo', 1), d('c', 'Cy', 2)]

  it('moves a driver up', () => {
    const moved = moveInOrder(roster, 'c', 'up')
    expect(moved.map((x) => x.first_name)).toEqual(['Ana', 'Cy', 'Bo'])
  })

  it('moves a driver down', () => {
    const moved = moveInOrder(roster, 'a', 'down')
    expect(moved.map((x) => x.first_name)).toEqual(['Bo', 'Ana', 'Cy'])
  })

  it('does nothing at the ends', () => {
    expect(moveInOrder(roster, 'a', 'up').map((x) => x.first_name)).toEqual(['Ana', 'Bo', 'Cy'])
    expect(moveInOrder(roster, 'c', 'down').map((x) => x.first_name)).toEqual(['Ana', 'Bo', 'Cy'])
  })

  it('gives every driver an explicit position, including the unplaced', () => {
    // The first reorder is what turns an incidental order into a chosen one.
    const mixed = [d('a', 'Ana'), d('b', 'Bo'), d('c', 'Cy')]
    const moved = moveInOrder(mixed, 'c', 'up')

    expect(moved.map((x) => x.sort_order)).toEqual([0, 1, 2])
    expect(moved.map((x) => x.first_name)).toEqual(['Ana', 'Cy', 'Bo'])
  })

  it('renumbers contiguously so no two drivers claim a slot', () => {
    // Returning the whole roster rather than a swapped pair is what keeps a
    // half-applied reorder from surviving a merge as a duplicate position.
    const gappy = [d('a', 'Ana', 0), d('b', 'Bo', 7), d('c', 'Cy', 99)]
    const moved = moveInOrder(gappy, 'b', 'down')

    expect(moved.map((x) => x.sort_order)).toEqual([0, 1, 2])
    expect(new Set(moved.map((x) => x.sort_order)).size).toBe(3)
  })

  it('ignores a driver who is not on the roster', () => {
    expect(moveInOrder(roster, 'nobody', 'up').map((x) => x.first_name)).toEqual([
      'Ana',
      'Bo',
      'Cy',
    ])
  })
})
