import type { SyncState } from './useSync.js'

/**
 * The answer to "has my fill actually synced?" — a question people genuinely
 * ask at a track, usually while holding a fuel jug.
 *
 * It is a button, not a badge: when the answer is "no", the next thing anyone
 * wants is to try again. Tapping is safe at any time because a drain is
 * idempotent.
 */
export function SyncStatus({
  state,
  onSync,
}: {
  state: SyncState & { syncNow: () => void }
  onSync?: () => void
}) {
  const { queued, online, syncing } = state

  const tone = !online
    ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
    : queued > 0
      ? 'border-white/10 bg-pit-surface text-pit-muted'
      : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'

  const label = syncing
    ? 'Syncing…'
    : !online
      ? queued > 0
        ? `Offline · ${queued} waiting`
        : 'Offline'
      : queued > 0
        ? `${queued} waiting`
        : 'Synced'

  return (
    <button
      type="button"
      onClick={() => {
        state.syncNow()
        onSync?.()
      }}
      data-testid="sync-status"
      data-online={online}
      data-queued={queued}
      className={`rounded-full border px-3 py-1 text-sm tabular-nums transition-colors ${tone}`}
    >
      {label}
    </button>
  )
}
