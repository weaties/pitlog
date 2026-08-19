import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { SyncStatus } from '../offline/SyncStatus.js'
import type { SyncState } from '../offline/useSync.js'

/**
 * The frame every screen sits in.
 *
 * The sync pill lives in the header rather than on a settings page because
 * "has my fill actually synced?" is asked mid-stop, not at leisure.
 */
export function Shell({
  title,
  sync,
  actions,
  children,
}: {
  title: ReactNode
  sync?: SyncState & { syncNow: () => void }
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-5 p-4 pb-24">
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-bold text-2xl tracking-tight">{title}</h1>
        <div className="flex items-center gap-2">
          {actions}
          {sync && <SyncStatus state={sync} />}
        </div>
      </header>
      {children}
    </div>
  )
}

const TABS = [
  { to: '/', label: 'Race' },
  { to: '/log', label: 'Log' },
  { to: '/plan', label: 'Plan' },
  { to: '/money', label: 'Money' },
  { to: '/team', label: 'Team' },
]

/**
 * Bottom navigation, because a phone held in one gloved hand is reachable at
 * the bottom and not at the top.
 */
export function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-white/10 border-t bg-pit-bg/95 backdrop-blur">
      <ul className="mx-auto flex max-w-3xl">
        {TABS.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                `flex min-h-tap flex-col items-center justify-center text-sm ${
                  isActive ? 'text-pit-accent' : 'text-pit-muted'
                }`
              }
            >
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
