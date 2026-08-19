/**
 * Active series rule configs, read-only.
 *
 * These are not part of the sync tables: a rule config is authored by an admin
 * and written by the server, never by a phone, and `rule_configs` has no
 * `server_updated_at` to drive a cursor. The client fetches them here and keeps
 * a copy on the device so a plan can still say which of its inputs are guesses
 * with no signal — which is the whole point of #7.
 */

import type { Db } from '@pitlog/db'
import * as s from '@pitlog/db/schema'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { MembershipResolver, TenancyEnv } from '../middleware/tenancy.js'
import { requireTeamPermission } from '../middleware/tenancy.js'

export function ruleRoutes({
  db,
  resolveMembership,
}: {
  db: Db
  resolveMembership: MembershipResolver
}) {
  const app = new Hono<TenancyEnv>()

  app.get('/:teamId/rules', requireTeamPermission('weekend:read', resolveMembership), async (c) => {
    const teamId = c.req.param('teamId')

    const rows = await db
      .select({
        id: s.rule_configs.id,
        series_id: s.rule_configs.series_id,
        version: s.rule_configs.version,
        verification_status: s.rule_configs.verification_status,
        config: s.rule_configs.config,
        series_key: s.series.key,
        series_name: s.series.display_name,
      })
      .from(s.rule_configs)
      .innerJoin(s.series, eq(s.series.id, s.rule_configs.series_id))
      .where(and(eq(s.rule_configs.team_id, teamId), eq(s.rule_configs.is_active, true)))

    return c.json({ rules: rows })
  })

  return app
}
