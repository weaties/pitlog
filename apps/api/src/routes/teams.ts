import type { Db } from '@pitlog/db'
import * as s from '@pitlog/db/schema'
import { and, count, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { MembershipResolver, TenancyEnv } from '../middleware/tenancy.js'
import { requireAuth, requireTeamPermission } from '../middleware/tenancy.js'

export interface TeamRoutesOptions {
  db: Db
  resolveMembership: MembershipResolver
}

/**
 * Team-scoped reads. Every query filters on `team_id` explicitly — there is no
 * ambient tenant in the db client by design, so a missing scope is visible in
 * the query rather than hidden in a wrapper.
 */
export function teamRoutes({ db, resolveMembership }: TeamRoutesOptions) {
  const app = new Hono<TenancyEnv>()

  /** The teams the caller belongs to, with their role in each. */
  app.get('/', requireAuth(), async (c) => {
    const rows = await db
      .select({
        id: s.teams.id,
        name: s.teams.name,
        slug: s.teams.slug,
        role: s.memberships.role,
      })
      .from(s.memberships)
      .innerJoin(s.teams, eq(s.teams.id, s.memberships.team_id))
      .where(eq(s.memberships.user_id, c.get('auth').userId))

    return c.json({ teams: rows })
  })

  /**
   * The weekend dashboard. Empty for a fresh team; M1 fills it with the live
   * stint schedule, standings and lap times.
   */
  app.get(
    '/:teamId/dashboard',
    requireTeamPermission('weekend:read', resolveMembership),
    async (c) => {
      const auth = c.get('auth')
      const teamId = c.req.param('teamId')

      const [team] = await db.select().from(s.teams).where(eq(s.teams.id, teamId)).limit(1)
      if (!team) return c.json({ error: 'not found' }, 404)

      const live = and(eq(s.events.team_id, teamId), isNull(s.events.deleted_at))
      const events = await db
        .select({
          id: s.events.id,
          name: s.events.name,
          track_name: s.events.track_name,
          starts_at: s.events.starts_at,
          ends_at: s.events.ends_at,
        })
        .from(s.events)
        .where(live)

      const [driverCount] = await db
        .select({ n: count() })
        .from(s.drivers)
        .where(and(eq(s.drivers.team_id, teamId), isNull(s.drivers.deleted_at)))

      return c.json({
        team: { id: team.id, name: team.name, slug: team.slug },
        role: auth.membership?.role,
        events,
        counts: { drivers: driverCount?.n ?? 0, events: events.length },
      })
    },
  )

  return app
}
