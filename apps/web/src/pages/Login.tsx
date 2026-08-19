import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'

interface RequestResult {
  ok: true
  /** Present only when the API runs the console mail transport (local dev, CI). */
  devLink?: string
}

export function Login() {
  const [email, setEmail] = useState('')

  const request = useMutation({
    mutationFn: (address: string) =>
      api<RequestResult>('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: address }),
      }),
  })

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-8 p-6">
      <div>
        <h1 className="font-bold text-4xl tracking-tight">PitLog</h1>
        <p className="mt-2 text-pit-muted">Sign in with a link. No passwords at the track.</p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          request.mutate(email)
        }}
      >
        <label className="flex flex-col gap-2" htmlFor="email">
          <span className="font-medium text-sm">Email</span>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-tap rounded-xl border border-white/15 bg-pit-surface px-4 text-lg outline-none focus:border-pit-accent"
          />
        </label>

        <button
          type="submit"
          disabled={request.isPending}
          className="h-tap rounded-xl bg-pit-accent font-semibold text-black text-lg disabled:opacity-60"
        >
          {request.isPending ? 'Sending…' : 'Send sign-in link'}
        </button>
      </form>

      {request.isSuccess && (
        <div className="rounded-xl border border-white/15 bg-pit-surface p-4" data-testid="sent">
          <p>Check your email for a sign-in link.</p>
          {request.data.devLink && (
            <p className="mt-3 text-sm">
              <span className="text-pit-muted">Dev mode — </span>
              <a
                className="text-pit-accent underline"
                href={request.data.devLink}
                data-testid="dev-link"
              >
                open the link
              </a>
            </p>
          )}
        </div>
      )}

      {request.isError && (
        <p className="text-red-400" role="alert">
          {request.error.message}
        </p>
      )}
    </main>
  )
}
