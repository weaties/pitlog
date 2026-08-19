/**
 * How much life is on a set of tyres or pads — SPEC §5.2.
 *
 * The rule that matters: **laps on a set are derived, never typed.** A crew
 * hand-counting laps on a tyre set is wrong by Sunday afternoon, and it is
 * wrong in the direction that gets somebody sent out on cords. The `laps` table
 * already knows; this only has to ask it the right question.
 *
 * A set can come off and go back on — a rain set goes on, the slicks return —
 * so life accumulates over every spell the set spent fitted, not just the last.
 */

export interface ConsumableEvent {
  id: string
  consumableSetId: string
  kind: 'install' | 'rotate' | 'remove' | 'inspect'
  occurredAt: Date
  /** Which corner, for tyres. Not meaningful for pads or oil. */
  corner: string | null
}

export interface ConsumableLap {
  id: string
  startedAt: Date
  lapTimeMs: number | null
}

export interface ConsumableSummary {
  laps: number
  /** Wall-clock hours the set spent fitted. */
  hours: number
  /** Summed lap times where they are known. */
  lapTimeMs: number
  /** How many separate times the set has been fitted. */
  spells: number
  rotations: number
  fitted: boolean
  /** When the current spell began, if it is on the car now. */
  installedAt: Date | null
}

export interface ConsumableInput {
  events: readonly ConsumableEvent[]
  /** Laps for the whole weekend; this picks the ones that count. */
  laps: readonly ConsumableLap[]
  /** Defaults to the current instant, for a set still on the car. */
  now?: Date
}

interface Spell {
  from: Date
  to: Date
}

export function summariseConsumableSet(input: ConsumableInput): ConsumableSummary {
  const now = input.now ?? new Date()
  const ordered = [...input.events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  const spells: Spell[] = []
  let openedAt: Date | null = null
  let rotations = 0

  for (const event of ordered) {
    if (event.kind === 'rotate') {
      rotations += 1
      continue
    }
    // An inspection is a thing that happened to the set, not a change in
    // whether it is fitted.
    if (event.kind === 'inspect') continue

    if (event.kind === 'install') {
      // A second install while already fitted is a duplicate tap, not a new
      // spell — someone pressed the button twice, or two phones both logged it.
      if (openedAt === null) openedAt = event.occurredAt
      continue
    }

    // A removal with no matching install measures nothing. Dropping it beats
    // inventing a start time and over-reporting the life on the set.
    if (openedAt === null) continue
    spells.push({ from: openedAt, to: event.occurredAt })
    openedAt = null
  }

  const fitted = openedAt !== null
  if (openedAt !== null) spells.push({ from: openedAt, to: now })

  let laps = 0
  let lapTimeMs = 0
  for (const lap of input.laps) {
    if (!spells.some((spell) => within(lap.startedAt, spell))) continue
    laps += 1
    lapTimeMs += lap.lapTimeMs ?? 0
  }

  const ms = spells.reduce((total, spell) => total + (spell.to.getTime() - spell.from.getTime()), 0)

  return {
    laps,
    hours: ms / 3_600_000,
    lapTimeMs,
    spells: spells.length,
    rotations,
    fitted,
    installedAt: fitted ? (spells.at(-1)?.from ?? null) : null,
  }
}

/** Inclusive of the start, exclusive of the end: a lap begun as the car came in
 *  belongs to the spell it was begun in, and one begun after does not. */
function within(at: Date, spell: Spell): boolean {
  return at.getTime() >= spell.from.getTime() && at.getTime() < spell.to.getTime()
}
