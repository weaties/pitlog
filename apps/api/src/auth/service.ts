import { randomUUID } from 'node:crypto'
import type { Db } from '@pitlog/db'
import * as s from '@pitlog/db/schema'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { Mailer } from './mailer.js'
import { generateToken, hashToken, MAGIC_LINK_TTL_SECONDS, SESSION_TTL_SECONDS } from './tokens.js'

/**
 * The magic-link flow (SPEC §4 — no password auth, no password resets at the
 * track).
 *
 * Request → a single-use token is stored as a hash and emailed as a URL.
 * Callback → the token is consumed, the user is created if new, and a session
 * token is issued. Both tokens are only ever stored hashed.
 */

export interface AuthService {
  requestMagicLink(email: string, redirectTo?: string): Promise<{ url: string }>
  consumeMagicLink(token: string): Promise<{ sessionToken: string; userId: string } | null>
  resolveSession(sessionToken: string): Promise<{ userId: string; sessionId: string } | null>
  revokeSession(sessionToken: string): Promise<void>
}

export interface AuthServiceOptions {
  db: Db
  mailer: Mailer
  /** Origin the magic link points back at, e.g. http://localhost:8787 */
  apiOrigin: string
}

const normaliseEmail = (email: string) => email.trim().toLowerCase()

export function createAuthService({ db, mailer, apiOrigin }: AuthServiceOptions): AuthService {
  return {
    async requestMagicLink(email, redirectTo) {
      const normalised = normaliseEmail(email)
      const token = generateToken()
      const expires = new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000)

      await db.insert(s.login_tokens).values({
        id: randomUUID(),
        email: normalised,
        token_hash: hashToken(token),
        expires_at: expires,
      })

      const url = new URL('/api/auth/callback', apiOrigin)
      url.searchParams.set('token', token)
      if (redirectTo) url.searchParams.set('redirect', redirectTo)

      await mailer.sendMagicLink(normalised, url.toString())
      return { url: url.toString() }
    },

    async consumeMagicLink(token) {
      const hash = hashToken(token)

      // Single-use: the update only matches a row that is unconsumed and
      // unexpired, so two clicks on the same link cannot both mint a session.
      const [claimed] = await db
        .update(s.login_tokens)
        .set({ consumed_at: new Date() })
        .where(
          and(
            eq(s.login_tokens.token_hash, hash),
            isNull(s.login_tokens.consumed_at),
            gt(s.login_tokens.expires_at, new Date()),
          ),
        )
        .returning()

      if (!claimed) return null

      const [existing] = await db
        .select()
        .from(s.users)
        .where(eq(s.users.email, claimed.email))
        .limit(1)

      const userId = existing?.id ?? randomUUID()
      if (existing) {
        await db.update(s.users).set({ last_login_at: new Date() }).where(eq(s.users.id, userId))
      } else {
        await db
          .insert(s.users)
          .values({ id: userId, email: claimed.email, last_login_at: new Date() })
      }

      const sessionToken = generateToken()
      const sessionId = randomUUID()
      await db.insert(s.auth_sessions).values({
        id: sessionId,
        token_hash: hashToken(sessionToken),
        kind: 'user',
        user_id: userId,
        expires_at: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      })

      return { sessionToken, userId }
    },

    async resolveSession(sessionToken) {
      const [row] = await db
        .select()
        .from(s.auth_sessions)
        .where(
          and(
            eq(s.auth_sessions.token_hash, hashToken(sessionToken)),
            gt(s.auth_sessions.expires_at, new Date()),
          ),
        )
        .limit(1)

      if (!row?.user_id) return null

      // Best-effort liveness stamp; never block the request on it.
      await db
        .update(s.auth_sessions)
        .set({ last_seen_at: sql`now()` })
        .where(eq(s.auth_sessions.id, row.id))

      return { userId: row.user_id, sessionId: row.id }
    },

    async revokeSession(sessionToken) {
      await db
        .delete(s.auth_sessions)
        .where(eq(s.auth_sessions.token_hash, hashToken(sessionToken)))
    },
  }
}

/** Looks up the caller's membership in one team. The tenancy gate's data half. */
export function createMembershipResolver(db: Db) {
  return async (userId: string, teamId: string) => {
    const [row] = await db
      .select()
      .from(s.memberships)
      .where(and(eq(s.memberships.user_id, userId), eq(s.memberships.team_id, teamId)))
      .limit(1)
    return row ?? null
  }
}
