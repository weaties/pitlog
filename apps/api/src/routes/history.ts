/**
 * What was overwritten — SPEC §5.2 "editable with history" and §6.2's
 * "explicit conflict surfacing".
 *
 * One table serves both, because they are the same event from two angles:
 * something was overwritten. A correction somebody made to their own entry is
 * history. Being overwritten by *somebody else* is a conflict worth
 * interrupting them about.
 */

import type { Db } from '@pitlog/db'
import * as s from '@pitlog/db/schema'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { MembershipResolver, TenancyEnv } from '../middleware/tenancy.js'
import { requireTeamPermission } from '../middleware/tenancy.js'

export function historyRoutes({
  db,
  resolveMembership,
}: {
  db: Db
  resolveMembership: MembershipResolver
}) {
  const app = new Hono<TenancyEnv>()

  /** Every previous version of one row, newest first. */
  app.get(
    '/:teamId/history',
    requireTeamPermission('weekend:read', resolveMembership),
    async (c) => {
      const table = c.req.query('table')
      const rowId = c.req.query('rowId')
      if (!table || !rowId) return c.json({ error: 'table and rowId are required' }, 400)

      const versions = await db
        .select()
        .from(s.row_versions)
        .where(
          and(
            eq(s.row_versions.team_id, c.req.param('teamId')),
            eq(s.row_versions.table_name, table),
            eq(s.row_versions.row_id, rowId),
          ),
        )
        .orderBy(desc(s.row_versions.recorded_at))

      return c.json({ versions })
    },
  )

  /**
   * Conflicts nobody has looked at yet.
   *
   * Unacknowledged only: a conflict that has been seen is history, and leaving
   * it in the list forever would train a crew to ignore the list.
   */
  app.get(
    '/:teamId/conflicts',
    requireTeamPermission('weekend:read', resolveMembership),
    async (c) => {
      const conflicts = await db
        .select()
        .from(s.row_versions)
        .where(
          and(
            eq(s.row_versions.team_id, c.req.param('teamId')),
            eq(s.row_versions.was_conflict, true),
            isNull(s.row_versions.acknowledged_at),
          ),
        )
        .orderBy(desc(s.row_versions.recorded_at))
        .limit(50)

      return c.json({ conflicts })
    },
  )

  /** Mark one as seen. Does not restore anything — that is a deliberate write. */
  app.post(
    '/:teamId/conflicts/:versionId/acknowledge',
    requireTeamPermission('log:write', resolveMembership),
    async (c) => {
      const [updated] = await db
        .update(s.row_versions)
        .set({ acknowledged_at: new Date() })
        .where(
          and(
            eq(s.row_versions.id, c.req.param('versionId')),
            eq(s.row_versions.team_id, c.req.param('teamId')),
          ),
        )
        .returning({ id: s.row_versions.id })

      if (!updated) return c.json({ error: 'not found' }, 404)
      return c.json({ id: updated.id, acknowledged: true })
    },
  )

  return app
}
