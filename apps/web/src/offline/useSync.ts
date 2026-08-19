/**
 * The sync loop, as a hook.
 *
 * Runs on a timer and on the browser coming back online. It deliberately does
 * not run on every mutation: a crew logging six things in a pit stop should
 * produce one batch when the network next allows, not six failed requests.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncRunResult } from './client.js'
import { syncOnce } from './client.js'
import { useRefreshLocal } from './useLocalTable.js'

/** Idle poll. Long enough not to burn a phone battery over a race weekend. */
const IDLE_INTERVAL_MS = 30_000

export interface SyncState {
  queued: number
  online: boolean
  /** Null until the first cycle finishes — "empty" and "not yet" differ. */
  lastRunAt: Date | null
  conflicts: SyncRunResult['conflicts']
  rejected: SyncRunResult['rejected']
  syncing: boolean
}

export function useSync(teamId: string | undefined): SyncState & { syncNow: () => void } {
  const [state, setState] = useState<SyncState>({
    queued: 0,
    online: true,
    lastRunAt: null,
    conflicts: [],
    rejected: [],
    syncing: false,
  })

  // A run in flight must not be started again by the timer landing on top of
  // it: two drains would push the same batch twice. Harmless, but it doubles
  // the traffic at exactly the moment there is least of it to spare.
  const running = useRef(false)
  const refreshLocal = useRefreshLocal()

  const run = useCallback(async () => {
    if (!teamId || running.current) return
    running.current = true
    setState((s) => ({ ...s, syncing: true }))

    try {
      const result = await syncOnce(teamId)

      // A pull writes straight into IndexedDB, which no screen is watching.
      // Without this the rows are on the device and invisible — the weekend
      // downloads and the app still says there are no races.
      if (result.pulled > 0) refreshLocal()

      setState({
        queued: result.queued,
        online: result.online,
        lastRunAt: new Date(),
        // Conflicts and rejections accumulate until a human clears them;
        // dropping them on the next tick would defeat the point.
        conflicts: result.conflicts,
        rejected: result.rejected,
        syncing: false,
      })
    } catch {
      setState((s) => ({ ...s, online: false, syncing: false }))
    } finally {
      running.current = false
    }
  }, [teamId, refreshLocal])

  useEffect(() => {
    if (!teamId) return
    void run()

    const timer = setInterval(() => void run(), IDLE_INTERVAL_MS)
    const onOnline = () => void run()
    window.addEventListener('online', onOnline)

    return () => {
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [teamId, run])

  return { ...state, syncNow: () => void run() }
}
