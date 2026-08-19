import { useRegisterSW } from 'virtual:pwa-register/react'

/**
 * "A new version is ready" — asked, never imposed.
 *
 * `registerType: 'prompt'` in `vite.config.ts` is what makes this necessary and
 * it is the point: activating a new service worker reloads the page, and a
 * reload while someone is entering a fuel fill on the pit wall loses the entry
 * and the crew's place. A deploy is never more urgent than the race.
 *
 * The offline-ready state is worth showing once too. "You can put this phone in
 * flight mode now" is the reassurance the whole PWA exists to earn.
 */
export function UpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!offlineReady && !needRefresh) return null

  return (
    <div
      role="status"
      data-testid="pwa-prompt"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md flex-col gap-3 rounded-xl border border-white/10 bg-pit-surface p-4 shadow-lg"
    >
      <p className="text-pit-fg">
        {needRefresh ? 'A new version of PitLog is ready.' : 'PitLog is ready to work offline.'}
      </p>

      <div className="flex gap-2">
        {needRefresh && (
          <button
            type="button"
            onClick={() => void updateServiceWorker(true)}
            className="min-h-tap flex-1 rounded-lg bg-pit-accent px-4 font-semibold text-pit-bg"
          >
            Reload now
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setOfflineReady(false)
            setNeedRefresh(false)
          }}
          className="min-h-tap flex-1 rounded-lg border border-white/15 px-4 text-pit-fg"
        >
          {needRefresh ? 'Not now' : 'Dismiss'}
        </button>
      </div>
    </div>
  )
}
