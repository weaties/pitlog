/**
 * Local writes that threw.
 *
 * Every mutation in this app is `void saveRow(...)` — fire and forget, because
 * a screen must never await the network. The cost of that shape is that a
 * failure disappears: the row does not appear, nothing is said, and the crew
 * assumes they mis-tapped.
 *
 * That is how a broken IndexedDB schema went unnoticed through a whole feature
 * (#57): every write threw `NotFoundError` and the UI simply rendered nothing.
 * In a pit box the same silence would swallow a fuel fill.
 *
 * So failures are recorded here and shown. A write that cannot reach the
 * device is far worse than one that cannot reach the server — the latter is
 * normal and expected, the former means the app is lying about what it stored.
 */

type Listener = () => void

let lastFailure: string | null = null
const listeners = new Set<Listener>()

export function recordWriteFailure(error: unknown): void {
  lastFailure = error instanceof Error ? error.message : String(error)
  for (const listener of listeners) listener()
}

export function clearWriteFailure(): void {
  lastFailure = null
  for (const listener of listeners) listener()
}

export function subscribeToWriteFailures(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getWriteFailure(): string | null {
  return lastFailure
}
