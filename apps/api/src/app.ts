import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

export interface AppOptions {
  appOrigin: string
}

/**
 * Builds the Hono app. Kept separate from `server.ts` (which owns the port and
 * the process) so tests can drive it in-process via `app.request()` with no
 * network involved.
 */
export function createApp(options: AppOptions) {
  const app = new Hono()

  app.use('*', logger())
  app.use('/api/*', cors({ origin: options.appOrigin, credentials: true }))

  app.get('/api/health', (c) => c.json({ ok: true }))

  return app
}

export type App = ReturnType<typeof createApp>
