import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ApiError, api } from './lib/api.js'
import { LogPage } from './pages/Log.js'
import { Login } from './pages/Login.js'
import { RacePage } from './pages/Race.js'
import { TeamPage } from './pages/Team.js'
import { TabBar } from './ui/Shell.js'

interface Me {
  userId: string
  kind: 'user' | 'visitor'
}

export function App() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/me'),
    // A 401 is the answer "not signed in", not a transient failure.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 2,
  })

  if (me.isPending) {
    return <main className="grid min-h-full place-items-center p-6">Loading…</main>
  }

  const signedIn = me.isSuccess

  if (!signedIn) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/" element={<RacePage />} />
        <Route path="/log" element={<LogPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <TabBar />
    </>
  )
}
