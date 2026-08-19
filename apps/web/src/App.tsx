import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ApiError, api } from './lib/api.js'
import { Dashboard } from './pages/Dashboard.js'
import { Login } from './pages/Login.js'

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

  return (
    <Routes>
      <Route path="/login" element={signedIn ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/" element={signedIn ? <Dashboard /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
