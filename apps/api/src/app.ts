import type { Db } from '@pitlog/db'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { createMailer } from './auth/mailer.js'
import { createAuthService, createMembershipResolver } from './auth/service.js'
import { loadSession } from './middleware/session.js'
import type { TenancyEnv } from './middleware/tenancy.js'
import { requireAuth } from './middleware/tenancy.js'
import { authRoutes } from './routes/auth.js'
import { ruleRoutes } from './routes/rules.js'
import { syncRoutes } from './routes/sync.js'
import { teamRoutes } from './routes/teams.js'
import { inviteRoutes, visitorRoutes } from './routes/visitors.js'

export interface AppOptions {
  db: Db
  appOrigin: string
  apiOrigin: string
  mailTransport: 'console' | 'smtp'
  secureCookies: boolean
}

/**
 * Builds the Hono app. Kept separate from `server.ts` (which owns the port and
 * the process) so tests can drive it in-process via `app.request()` with no
 * network involved.
 */
export function createApp(options: AppOptions) {
  const { db, appOrigin } = options
  const mailer = createMailer(options.mailTransport)
  const auth = createAuthService({ db, mailer, apiOrigin: options.apiOrigin })
  const resolveMembership = createMembershipResolver(db)

  const app = new Hono<TenancyEnv>()

  app.use('*', logger())
  app.use('/api/*', cors({ origin: appOrigin, credentials: true }))
  app.use('/api/*', loadSession(auth))

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.get('/api/me', requireAuth(), (c) => {
    const { userId, kind, visitorTeamId } = c.get('auth')
    // A visitor has no membership rows, so `/api/teams` is empty for them by
    // construction. Their team comes from the link they opened, and this is
    // the only place they can learn it.
    return c.json({ userId, kind, teamId: visitorTeamId ?? null })
  })

  app.route(
    '/api/auth',
    authRoutes({
      auth,
      appOrigin,
      secureCookies: options.secureCookies,
      exposeDevLink: options.mailTransport === 'console',
    }),
  )
  app.route('/api/teams', teamRoutes({ db, resolveMembership }))
  app.route('/api/teams', syncRoutes({ db, resolveMembership }))
  app.route('/api/teams', ruleRoutes({ db, resolveMembership }))
  app.route('/api/teams', visitorRoutes({ db, resolveMembership, appOrigin }))
  app.route('/api/teams', inviteRoutes({ auth, resolveMembership }))

  return app
}

export type App = ReturnType<typeof createApp>
