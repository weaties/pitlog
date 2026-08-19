const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Thin fetch wrapper. Credentials are always included — the session is an
 * HttpOnly cookie, so the client never sees or stores a token.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? res.statusText)
  }
  return (await res.json()) as T
}

export interface Team {
  id: string
  name: string
  slug: string
  role: 'admin' | 'crew' | 'visitor'
}

export interface DashboardEvent {
  id: string
  name: string
  track_name: string | null
  starts_at: string | null
  ends_at: string | null
}

export interface Dashboard {
  team: { id: string; name: string; slug: string }
  role: Team['role']
  events: DashboardEvent[]
  counts: { drivers: number; events: number }
}
