import type { Permission, Role } from '@pitlog/domain'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AuthContext, MembershipResolver, TenancyEnv } from './tenancy.js'
import { requireAuth, requireTeamPermission } from './tenancy.js'

const TEAM = '00000000-0000-4000-8000-0000000000a1'
const OTHER_TEAM = '00000000-0000-4000-8000-0000000000a2'
const USER = '00000000-0000-4000-8000-0000000000b1'

/**
 * The gates are tested against an injected resolver rather than a database.
 * The rule under test is "does this role open this door", which has nothing to
 * do with Postgres; the real query is exercised by the browser smoke test.
 */
function resolverFor(memberships: Partial<Record<string, Role>>): MembershipResolver {
  return async (userId, teamId) => {
    if (userId !== USER) return null
    const role = memberships[teamId]
    return role ? { id: 'membership-1', team_id: teamId, user_id: userId, role } : null
  }
}

interface AppOptions {
  auth?: AuthContext
  memberships?: Partial<Record<string, Role>>
  /** Permission the guarded route demands. */
  permission?: Permission
}

function buildApp(options: AppOptions = {}) {
  const resolve = resolverFor(options.memberships ?? {})
  const app = new Hono<TenancyEnv>()

  app.use('*', async (c, next) => {
    if (options.auth) c.set('auth', options.auth)
    await next()
  })

  app.get('/me', requireAuth(), (c) => c.json({ userId: c.get('auth').userId }))

  app.get(
    '/teams/:teamId/thing',
    requireTeamPermission(options.permission ?? 'weekend:read', resolve),
    (c) => c.json({ role: c.get('auth').membership?.role }),
  )

  return app
}

const signedIn: AuthContext = { userId: USER, sessionId: 'session-1', kind: 'user' }

describe('requireAuth', () => {
  it('401s an anonymous request', async () => {
    const res = await buildApp().request('/me')
    expect(res.status).toBe(401)
  })

  it('passes a signed-in request through', async () => {
    const res = await buildApp({ auth: signedIn }).request('/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: USER })
  })

  it('does not leak why the request failed', async () => {
    const body = await (await buildApp().request('/me')).json()
    expect(JSON.stringify(body)).not.toContain(USER)
  })
})

describe('requireTeamPermission — SPEC §4 role gates', () => {
  it('401s an anonymous request before it can probe team membership', async () => {
    const res = await buildApp({ memberships: { [TEAM]: 'admin' } }).request(`/teams/${TEAM}/thing`)
    expect(res.status).toBe(401)
  })

  it('404s when the caller has no membership in the team', async () => {
    // 404, not 403: a 403 would confirm the team exists to someone who cannot
    // see it, which is a tenancy leak across the SPEC §4 boundary.
    const res = await buildApp({ auth: signedIn, memberships: {} }).request(`/teams/${TEAM}/thing`)
    expect(res.status).toBe(404)
  })

  it('404s when the caller is a member of a different team', async () => {
    const app = buildApp({ auth: signedIn, memberships: { [OTHER_TEAM]: 'admin' } })
    const res = await app.request(`/teams/${TEAM}/thing`)
    expect(res.status).toBe(404)
  })

  it('exposes the resolved membership to the handler', async () => {
    const app = buildApp({ auth: signedIn, memberships: { [TEAM]: 'crew' } })
    const res = await app.request(`/teams/${TEAM}/thing`)
    expect(await res.json()).toEqual({ role: 'crew' })
  })

  it('rejects a malformed team id without hitting the resolver', async () => {
    const app = buildApp({ auth: signedIn, memberships: { [TEAM]: 'admin' } })
    expect((await app.request('/teams/not-a-uuid/thing')).status).toBe(400)
  })
})

describe('the role matrix, exercised through the middleware', () => {
  const cases: Array<[Permission, Role, number]> = [
    // Everyone in the team can read the weekend dashboard.
    ['weekend:read', 'admin', 200],
    ['weekend:read', 'crew', 200],
    ['weekend:read', 'visitor', 200],
    // Crew operate the weekend; visitors are read-only.
    ['log:write', 'admin', 200],
    ['log:write', 'crew', 200],
    ['log:write', 'visitor', 403],
    ['planner:run', 'crew', 200],
    ['planner:run', 'visitor', 403],
    ['expense:write', 'crew', 200],
    ['expense:write', 'visitor', 403],
    // Admin-only.
    ['expense:settle', 'admin', 200],
    ['expense:settle', 'crew', 403],
    ['expense:settle', 'visitor', 403],
    ['team:manage', 'admin', 200],
    ['team:manage', 'crew', 403],
    ['team:manage', 'visitor', 403],
    ['member:manage', 'crew', 403],
    ['rules:manage', 'crew', 403],
    ['log:edit:any', 'crew', 403],
    ['log:delete', 'crew', 403],
  ]

  for (const [permission, role, expected] of cases) {
    it(`${role} → ${permission} → ${expected}`, async () => {
      const app = buildApp({ auth: signedIn, permission, memberships: { [TEAM]: role } })
      const res = await app.request(`/teams/${TEAM}/thing`)
      expect(res.status).toBe(expected)
    })
  }
})

describe('visitor sessions', () => {
  const visitorAuth: AuthContext = {
    userId: USER,
    sessionId: 'session-2',
    kind: 'visitor',
    visitorLinkId: 'link-1',
    visitorTeamId: TEAM,
  }

  it('can read the team the link was issued for', async () => {
    const app = buildApp({ auth: visitorAuth, memberships: { [TEAM]: 'visitor' } })
    expect((await app.request(`/teams/${TEAM}/thing`)).status).toBe(200)
  })

  it('needs no membership row at all — the link is the grant', async () => {
    // A token-scoped visitor has no account. Requiring a membership would make
    // every shared link 404, which is the reason `visitor_links` exists rather
    // than a bare `visitor` membership.
    const app = buildApp({ auth: visitorAuth, memberships: {} })
    expect((await app.request(`/teams/${TEAM}/thing`)).status).toBe(200)
  })

  it('is still refused a write with no membership row', async () => {
    const app = buildApp({ auth: visitorAuth, permission: 'log:write', memberships: {} })
    expect((await app.request(`/teams/${TEAM}/thing`)).status).toBe(403)
  })

  it('cannot reach a different team even with a membership row there', async () => {
    // A revocable visitor link is scoped to one team (SPEC §4). Honouring a
    // membership row for another team would let a shared link walk sideways.
    const app = buildApp({
      auth: visitorAuth,
      memberships: { [TEAM]: 'visitor', [OTHER_TEAM]: 'admin' },
    })
    expect((await app.request(`/teams/${OTHER_TEAM}/thing`)).status).toBe(404)
  })

  it('is read-only regardless of the membership row role', async () => {
    const app = buildApp({
      auth: visitorAuth,
      permission: 'log:write',
      memberships: { [TEAM]: 'admin' },
    })
    expect((await app.request(`/teams/${TEAM}/thing`)).status).toBe(403)
  })
})
