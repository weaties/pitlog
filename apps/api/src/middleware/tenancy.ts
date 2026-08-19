import { can, type Permission, type Role } from '@pitlog/domain'
import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * Authentication and tenancy gates — SPEC §4.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **A role check is never enough on its own.** Every guarded route names a
 *    team in its path, and the middleware resolves *that* team's membership.
 *    Being an admin of team A grants nothing in team B.
 *
 * 2. **Absence of access looks like absence of the resource.** A caller with no
 *    membership gets 404, not 403. A 403 would confirm the team exists to
 *    someone who is not allowed to know that.
 *
 * The membership lookup is injected rather than imported so the gates can be
 * tested without a database — the rule under test is "does this role open this
 * door", which has nothing to do with Postgres.
 */

export interface ResolvedMembership {
  id: string
  team_id: string
  user_id: string
  role: Role
}

export type MembershipResolver = (
  userId: string,
  teamId: string,
) => Promise<ResolvedMembership | null>

export interface AuthContext {
  userId: string
  sessionId: string
  kind: 'user' | 'visitor'
  /** Set only for visitor sessions; scopes the session to one team. */
  visitorLinkId?: string
  visitorTeamId?: string
  /** Populated by `requireTeamPermission` once the team is known. */
  membership?: ResolvedMembership
}

export interface TenancyEnv {
  Variables: { auth: AuthContext }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Bodies are intentionally uninformative — they must not confirm identities or
 * the existence of a team. The response is built here rather than left to an
 * app-level error handler so the gates behave identically wherever they are
 * mounted, including in tests.
 */
function httpError(status: 400 | 401 | 403 | 404, error: string): HTTPException {
  return new HTTPException(status, { res: Response.json({ error }, { status }) })
}

const unauthorized = () => httpError(401, 'authentication required')
const forbidden = () => httpError(403, 'not permitted')
const notFound = () => httpError(404, 'not found')
const badRequest = (msg: string) => httpError(400, msg)

export function requireAuth(): MiddlewareHandler<TenancyEnv> {
  return async (c, next) => {
    if (!c.get('auth')) throw unauthorized()
    await next()
  }
}

/**
 * Requires an authenticated caller who holds `permission` in the team named by
 * the `:teamId` path parameter.
 */
export function requireTeamPermission(
  permission: Permission,
  resolveMembership: MembershipResolver,
): MiddlewareHandler<TenancyEnv> {
  return async (c, next) => {
    const auth = c.get('auth')
    if (!auth) throw unauthorized()

    const teamId = c.req.param('teamId')
    if (!teamId || !UUID_RE.test(teamId)) {
      throw badRequest('invalid team id')
    }

    // A visitor link is issued for one team and is revocable (SPEC §4).
    // Checking this first means a shared link cannot walk sideways into another
    // team the account behind it happens to belong to.
    if (auth.kind === 'visitor') {
      if (auth.visitorTeamId !== teamId) throw notFound()

      // The link *is* the grant. A token-scoped visitor has no account and no
      // membership row — that is the whole reason `visitor_links` exists
      // rather than a bare `visitor` membership — so requiring one here would
      // make every shared link 404. Read-only, always, whatever else is true
      // of whoever opened it.
      if (!can('visitor', permission)) throw forbidden()

      c.set('auth', auth)
      await next()
      return
    }

    const membership = await resolveMembership(auth.userId, teamId)
    if (!membership) throw notFound()

    if (!can(membership.role, permission)) throw forbidden()

    c.set('auth', { ...auth, membership })
    await next()
  }
}
