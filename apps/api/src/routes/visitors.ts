/**
 * Visitor links and the read-only weekend — SPEC §4.
 *
 * A visitor link is scoped to one team and revocable without touching anybody's
 * account. That is why `visitor_links` exists rather than a bare `visitor`
 * membership: family and friends should not need a login, and a link that gets
 * forwarded around a paddock has to be killable mid-weekend.
 *
 * Only the hash of the token is stored, so the plaintext is shown exactly once
 * — at creation — and a database leak yields no usable links.
 */

import { randomUUID } from 'node:crypto'
import type { Db } from '@pitlog/db'
import * as s from '@pitlog/db/schema'
import { outranks, toVisitorWeekend } from '@pitlog/domain'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AuthService } from '../auth/service.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import type { MembershipResolver, TenancyEnv } from '../middleware/tenancy.js'
import { requireTeamPermission } from '../middleware/tenancy.js'

const createLinkSchema = z
  .object({
    label: z.string().min(1).max(120),
    /** Optional: a link for one weekend should be able to die with it. */
    expiresAt: z.iso.datetime().nullable().default(null),
  })
  .strict()

export function visitorRoutes({
  db,
  resolveMembership,
  appOrigin,
}: {
  db: Db
  resolveMembership: MembershipResolver
  appOrigin: string
}) {
  const app = new Hono<TenancyEnv>()

  app.get(
    '/:teamId/visitor-links',
    requireTeamPermission('member:manage', resolveMembership),
    async (c) => {
      const teamId = c.req.param('teamId')
      const rows = await db
        .select({
          id: s.visitor_links.id,
          label: s.visitor_links.label,
          created_at: s.visitor_links.created_at,
          expires_at: s.visitor_links.expires_at,
          revoked_at: s.visitor_links.revoked_at,
        })
        .from(s.visitor_links)
        .where(eq(s.visitor_links.team_id, teamId))

      // Deliberately no token, not even a prefix. It exists in one response,
      // once, and then only as a hash.
      return c.json({ links: rows })
    },
  )

  app.post(
    '/:teamId/visitor-links',
    requireTeamPermission('member:manage', resolveMembership),
    async (c) => {
      const parsed = createLinkSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid visitor link' }, 400)

      const teamId = c.req.param('teamId')
      const token = generateToken()
      const id = randomUUID()

      await db.insert(s.visitor_links).values({
        id,
        team_id: teamId,
        token_hash: hashToken(token),
        label: parsed.data.label,
        created_by: c.get('auth').userId,
        expires_at: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      })

      const url = new URL('/visit', appOrigin)
      url.searchParams.set('token', token)

      // The only time the plaintext is ever returned.
      return c.json({ id, label: parsed.data.label, url: url.toString() }, 201)
    },
  )

  app.delete(
    '/:teamId/visitor-links/:linkId',
    requireTeamPermission('member:manage', resolveMembership),
    async (c) => {
      const teamId = c.req.param('teamId')

      // Scoped to the team in the path: an admin of one team cannot revoke
      // another team's links by guessing an id.
      const [revoked] = await db
        .update(s.visitor_links)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(s.visitor_links.id, c.req.param('linkId')),
            eq(s.visitor_links.team_id, teamId),
            isNull(s.visitor_links.revoked_at),
          ),
        )
        .returning({ id: s.visitor_links.id })

      if (!revoked) return c.json({ error: 'not found' }, 404)
      return c.json({ id: revoked.id, revoked: true })
    },
  )

  /**
   * The weekend, as family and friends see it.
   *
   * The payload is assembled by `toVisitorWeekend` in the domain, which copies
   * every field out by name. Nothing here spreads a database row, so a column
   * added to `drivers` tomorrow cannot leak through by accident.
   */
  app.get(
    '/:teamId/weekend',
    requireTeamPermission('weekend:read', resolveMembership),
    async (c) => {
      const teamId = c.req.param('teamId')

      const [team] = await db.select().from(s.teams).where(eq(s.teams.id, teamId)).limit(1)
      if (!team) return c.json({ error: 'not found' }, 404)

      // Every query filters on team_id explicitly (SPEC §4). Written out rather
      // than wrapped in a helper so a missing scope would be visible here.
      const [event] = await db
        .select()
        .from(s.events)
        .where(and(eq(s.events.team_id, teamId), isNull(s.events.deleted_at)))
        .limit(1)

      const [session] = event
        ? await db
            .select()
            .from(s.sessions)
            .where(
              and(
                eq(s.sessions.team_id, teamId),
                isNull(s.sessions.deleted_at),
                eq(s.sessions.event_id, event.id),
              ),
            )
            .limit(1)
        : []

      const drivers = await db
        .select()
        .from(s.drivers)
        .where(and(eq(s.drivers.team_id, teamId), isNull(s.drivers.deleted_at)))

      const stints = session
        ? await db
            .select()
            .from(s.stints)
            .where(
              and(
                eq(s.stints.team_id, teamId),
                isNull(s.stints.deleted_at),
                eq(s.stints.session_id, session.id),
              ),
            )
        : []

      const laps = session
        ? await db
            .select()
            .from(s.laps)
            .where(
              and(
                eq(s.laps.team_id, teamId),
                isNull(s.laps.deleted_at),
                eq(s.laps.session_id, session.id),
              ),
            )
        : []

      return c.json(
        toVisitorWeekend({
          team: { id: team.id, name: team.name },
          event: event
            ? {
                id: event.id,
                name: event.name,
                track_name: event.track_name,
                timezone: event.timezone,
              }
            : null,
          session: session
            ? {
                id: session.id,
                name: session.name,
                starts_at: session.starts_at?.toISOString() ?? null,
                scheduled_duration_seconds: session.scheduled_duration_seconds,
              }
            : null,
          drivers: drivers.map((d) => ({
            id: d.id,
            first_name: d.first_name,
            can_drive: d.can_drive,
          })),
          stints: stints.map((st) => ({
            id: st.id,
            driver_id: st.driver_id,
            sequence: st.sequence,
            planned_start_at: st.planned_start_at?.toISOString() ?? null,
            planned_end_at: st.planned_end_at?.toISOString() ?? null,
            started_at: st.started_at?.toISOString() ?? null,
            ended_at: st.ended_at?.toISOString() ?? null,
          })),
          laps: laps.map((lap) => ({
            id: lap.id,
            driver_id: lap.driver_id,
            lap_number: lap.lap_number,
            lap_time_ms: lap.lap_time_ms,
            position: lap.position,
            source: lap.source,
          })),
        }),
      )
    },
  )

  return app
}

const inviteSchema = z
  .object({
    email: z.email(),
    role: z.enum(['admin', 'crew', 'visitor']),
  })
  .strict()

/**
 * Invites — SPEC §4.
 *
 * Admin-only, and an invite can never grant a role above the inviter's own.
 * Without that rule `member:manage` is a privilege-escalation primitive: invite
 * yourself back at a higher role, or hand somebody else more than you have.
 */
export function inviteRoutes({
  auth,
  resolveMembership,
}: {
  auth: AuthService
  resolveMembership: MembershipResolver
}) {
  const app = new Hono<TenancyEnv>()

  app.post(
    '/:teamId/invites',
    requireTeamPermission('member:manage', resolveMembership),
    async (c) => {
      const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid invite' }, 400)

      const context = c.get('auth')
      const inviterRole = context.membership?.role
      if (!inviterRole) return c.json({ error: 'not found' }, 404)

      // Equal is fine — an admin may invite another admin. Above is not.
      //
      // Defence in depth rather than the live gate: only `admin` currently
      // holds `member:manage`, and admin is the top rank, so this cannot fire
      // today. It exists so that granting `member:manage` to another role
      // later is not silently a privilege-escalation primitive. `outranks` is
      // the same comparison the role matrix is tested on.
      if (outranks(parsed.data.role, inviterRole)) {
        return c.json({ error: 'cannot invite someone above your own role' }, 403)
      }

      const teamId = c.req.param('teamId')
      const { url } = await auth.inviteToTeam({
        email: parsed.data.email,
        teamId,
        role: parsed.data.role,
        invitedBy: context.userId,
      })

      return c.json({ email: parsed.data.email, role: parsed.data.role, url }, 201)
    },
  )

  return app
}
