/**
 * The running order the crew chose.
 *
 * The solver's last tiebreak is roster order (AGENTS.md → Decisions, objective
 * term 5). Its job is to make a plan reproducible and explainable: two devices
 * handed the same inputs must produce the same schedule, and a crew chief must
 * be able to say why Ana is starting.
 *
 * That only works if the order means something. Before this module it was
 * whatever order rows came out of storage in — primary-key order, and the keys
 * are client-generated UUIDs — so who started the race was arbitrary and
 * unchangeable. Ordering lives here, framework-free, so the planner and the
 * roster screen cannot disagree about it.
 */

export interface Orderable {
  id: string
  /** The crew's chosen position. Null means "not placed yet". */
  sort_order: number | null
  first_name: string
}

/**
 * Sort a roster into running order.
 *
 * Placed drivers first, in the order the crew set. Unplaced drivers follow,
 * alphabetically — somebody added on Saturday morning should not silently jump
 * to the front of a running order that was agreed on Friday night. Ties fall
 * back to id so the result is total and stable on every device.
 */
export function inRunningOrder<T extends Orderable>(drivers: readonly T[]): T[] {
  return [...drivers].sort(compareRunningOrder)
}

export function compareRunningOrder(a: Orderable, b: Orderable): number {
  const aPlaced = a.sort_order !== null
  const bPlaced = b.sort_order !== null

  if (aPlaced && bPlaced && a.sort_order !== b.sort_order) {
    return (a.sort_order ?? 0) - (b.sort_order ?? 0)
  }
  if (aPlaced !== bPlaced) return aPlaced ? -1 : 1

  const byName = a.first_name.localeCompare(b.first_name, undefined, { sensitivity: 'base' })
  return byName !== 0 ? byName : a.id.localeCompare(b.id)
}

/**
 * Move one driver up or down the order, returning the whole roster renumbered.
 *
 * Every driver comes back with an explicit position, including ones that had
 * none: the first reorder is what turns an incidental order into a chosen one.
 * Returning the full list rather than a swapped pair means the caller writes a
 * consistent set of rows, so a half-applied reorder cannot leave two drivers
 * claiming the same slot after a merge.
 */
export function moveInOrder<T extends Orderable>(
  drivers: readonly T[],
  driverId: string,
  direction: 'up' | 'down',
): T[] {
  const ordered = inRunningOrder(drivers)
  const index = ordered.findIndex((d) => d.id === driverId)
  if (index === -1) return ordered

  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= ordered.length) return renumber(ordered)

  const swapped = [...ordered]
  const a = swapped[index]
  const b = swapped[target]
  if (!a || !b) return renumber(ordered)
  swapped[index] = b
  swapped[target] = a

  return renumber(swapped)
}

/** Positions are 0-based and contiguous, so "first" is always 0. */
function renumber<T extends Orderable>(drivers: readonly T[]): T[] {
  return drivers.map((driver, index) => ({ ...driver, sort_order: index }))
}
