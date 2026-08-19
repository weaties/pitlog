import type { MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthService } from '../auth/service.js'
import { SESSION_TTL_SECONDS } from '../auth/tokens.js'
import type { TenancyEnv } from './tenancy.js'

export const SESSION_COOKIE = 'pitlog_session'

/**
 * Reads the session cookie and, if it resolves, populates `auth`. It never
 * rejects — enforcement is `requireAuth` / `requireTeamPermission`'s job, so
 * public routes stay public and the gates stay the single place a 401 is
 * decided.
 */
export function loadSession(auth: AuthService): MiddlewareHandler<TenancyEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token) {
      // The session says what kind it is; this no longer assumes 'user'.
      // A visitor session carries the link and the one team it may address.
      const session = await auth.resolveSession(token)
      if (session) c.set('auth', session)
    }
    await next()
  }
}

export interface CookieOptions {
  /** Cookies are only marked Secure over https; local dev is plain http. */
  secure: boolean
}

export function setSessionCookie(
  c: Parameters<MiddlewareHandler<TenancyEnv>>[0],
  token: string,
  options: CookieOptions,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: the magic link arrives as a top-level navigation from
    // the user's mail client, and Strict would drop the cookie on that hop.
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure: options.secure,
  })
}

export function clearSessionCookie(c: Parameters<MiddlewareHandler<TenancyEnv>>[0]): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}
