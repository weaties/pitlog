import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AuthService } from '../auth/service.js'
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../middleware/session.js'
import type { TenancyEnv } from '../middleware/tenancy.js'

const requestSchema = z.object({ email: z.email() })

export interface AuthRoutesOptions {
  auth: AuthService
  appOrigin: string
  secureCookies: boolean
  /**
   * When the mailer is the console transport there is no inbox to check, so the
   * link is returned in the response body as well. Gated on the transport
   * rather than NODE_ENV because a console mailer is by definition not
   * production — `createMailer` throws before this matters if it ever is.
   */
  exposeDevLink: boolean
}

export function authRoutes({ auth, appOrigin, secureCookies, exposeDevLink }: AuthRoutesOptions) {
  const app = new Hono<TenancyEnv>()

  app.post('/request', async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'a valid email is required' }, 400)

    const { url } = await auth.requestMagicLink(parsed.data.email, appOrigin)

    // Always 202, whether or not the address is known. Distinguishing them
    // would turn this endpoint into an account-enumeration oracle.
    return c.json(exposeDevLink ? { ok: true, devLink: url } : { ok: true }, 202)
  })

  app.get('/callback', async (c) => {
    const token = c.req.query('token')
    if (!token) return c.redirect(`${appOrigin}/login?error=missing_token`)

    const result = await auth.consumeMagicLink(token)
    if (!result) return c.redirect(`${appOrigin}/login?error=invalid_or_expired`)

    setSessionCookie(c, result.sessionToken, { secure: secureCookies })
    return c.redirect(appOrigin)
  })

  /**
   * Exchange a visitor link token for a read-only session.
   *
   * A visitor never signs in: there is no account, no email, and nothing to
   * reset. The link is the credential, and revoking it ends every session it
   * ever created because the link is re-checked on each request.
   */
  app.post('/visitor', async (c) => {
    const token = c.req.query('token') ?? (await c.req.json().catch(() => null))?.token
    if (typeof token !== 'string' || token.length === 0) {
      return c.json({ error: 'a visitor token is required' }, 400)
    }

    const result = await auth.startVisitorSession(token)
    // Revoked, expired and never-existed are one answer on purpose: a caller
    // learns nothing about which links are real.
    if (!result) return c.json({ error: 'invalid or revoked link' }, 401)

    setSessionCookie(c, result.sessionToken, { secure: secureCookies })
    return c.json({ ok: true })
  })

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token) await auth.revokeSession(token)
    clearSessionCookie(c)
    return c.json({ ok: true })
  })

  return app
}
