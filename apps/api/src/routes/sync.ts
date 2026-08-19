/**
 * The one endpoint every pit-client write goes through — AGENTS.md → Decisions.
 *
 * Two verbs on one path: POST pushes a batch of local writes, GET pulls
 * everything that has changed since a cursor. Both are gated on `log:write` and
 * `weekend:read` respectively, and both re-check `team_id` on every row inside
 * `@pitlog/sync` — a batch that arrived six hours late is still untrusted input.
 */

import type { Db } from '@pitlog/db'
import {
  applySyncPush,
  pullFloor,
  SYNC_PROTOCOL_VERSION,
  syncPushRequestSchema,
} from '@pitlog/sync'
import { Hono } from 'hono'
import type { MembershipResolver, TenancyEnv } from '../middleware/tenancy.js'
import { requireTeamPermission } from '../middleware/tenancy.js'
import { createSyncStore, loadChangesSince } from '../sync/store.js'

export interface SyncRoutesOptions {
  db: Db
  resolveMembership: MembershipResolver
}

export function syncRoutes({ db, resolveMembership }: SyncRoutesOptions) {
  const app = new Hono<TenancyEnv>()

  app.post('/:teamId/sync', requireTeamPermission('log:write', resolveMembership), async (c) => {
    const parsed = syncPushRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'malformed sync batch' }, 400)

    if (parsed.data.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      // Say so rather than misparse it. A phone that spent the weekend in a
      // pit box may be a build behind.
      return c.json(
        {
          error: 'unsupported sync protocol version',
          expected: SYNC_PROTOCOL_VERSION,
          received: parsed.data.protocolVersion,
        },
        409,
      )
    }

    const teamId = c.req.param('teamId')
    const response = await applySyncPush(createSyncStore(db, teamId), parsed.data, {
      teamId,
      now: new Date(),
    })

    return c.json(response)
  })

  app.get('/:teamId/sync', requireTeamPermission('weekend:read', resolveMembership), async (c) => {
    const since = c.req.query('since')
    const parsedSince = since ? new Date(since) : null
    if (parsedSince !== null && Number.isNaN(parsedSince.getTime())) {
      return c.json({ error: 'invalid since cursor' }, 400)
    }

    const teamId = c.req.param('teamId')
    // The cursor is stamped before the read, never after: anything committed
    // while this query runs must fall inside the next pull, not between them.
    const cursor = new Date().toISOString()
    const changes = await loadChangesSince(db, teamId, pullFloor(parsedSince))

    return c.json({ protocolVersion: SYNC_PROTOCOL_VERSION, changes, cursor })
  })

  return app
}
