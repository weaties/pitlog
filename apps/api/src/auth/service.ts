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

export interface ResolvedSession {
  userId: string
  sessionId: string
  kind: 'user' | 'visitor'
  /** Set only for a visitor session; scopes it to exactly one team. */
  visitorLinkId?: string
  visitorTeamId?: string
}

export interface InviteOptions {
  email: string
  teamId: string
  role: 'admin' | 'crew' | 'visitor'
  invitedBy: string
}

export interface AuthService {
  requestMagicLink(email: string, redirectTo?: string): Promise<{ url: string }>
  consumeMagicLink(token: string): Promise<{ sessionToken: string; userId: string } | null>
  resolveSession(sessionToken: string): Promise<ResolvedSession | null>
  revokeSession(sessionToken: string): Promise<void>
  /** An admin invites someone into a team at a named role — SPEC §4. */
  inviteToTeam(options: InviteOptions): Promise<{ url: string }>
  /** Exchange a visitor link token for a read-only session. */
  startVisitorSession(token: string): Promise<{ sessionToken: string } | null>
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

      // An invite link carries the team and role it was issued for, so
      // accepting the invite and signing in are the same click. The membership
      // is created here rather than on a separate "accept" screen nobody would
      // find.
      if (claimed.invite_team_id && claimed.invite_role) {
        await db
          .insert(s.memberships)
          .values({
            id: randomUUID(),
            team_id: claimed.invite_team_id,
            user_id: userId,
            role: claimed.invite_role,
          })
          // Already a member: an invite never demotes or promotes someone who
          // is already in the team. Changing a role is its own deliberate act.
          .onConflictDoNothing()
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

      if (!row) return null

      if (row.kind === 'visitor') {
        if (!row.visitor_link_id) return null

        // Revocation has to bite immediately, so the link is re-checked on
        // every request rather than trusted because a session exists. A shared
        // link that cannot be killed mid-weekend is not revocable at all.
        const [link] = await db
          .select()
          .from(s.visitor_links)
          .where(eq(s.visitor_links.id, row.visitor_link_id))
          .limit(1)

        if (!link || link.revoked_at !== null) return null
        if (link.expires_at && link.expires_at.getTime() <= Date.now()) return null

        await db
          .update(s.auth_sessions)
          .set({ last_seen_at: sql`now()` })
          .where(eq(s.auth_sessions.id, row.id))

        return {
          // A visitor is not a user; the id is the link, and it is only ever
          // used for logging. It must never match a `memberships.user_id`.
          userId: `visitor:${link.id}`,
          sessionId: row.id,
          kind: 'visitor',
          visitorLinkId: link.id,
          visitorTeamId: link.team_id,
        }
      }

      if (!row.user_id) return null

      // Best-effort liveness stamp; never block the request on it.
      await db
        .update(s.auth_sessions)
        .set({ last_seen_at: sql`now()` })
        .where(eq(s.auth_sessions.id, row.id))

      return { userId: row.user_id, sessionId: row.id, kind: 'user' }
    },

    async revokeSession(sessionToken) {
      await db
        .delete(s.auth_sessions)
        .where(eq(s.auth_sessions.token_hash, hashToken(sessionToken)))
    },

    async inviteToTeam({ email, teamId, role, invitedBy }) {
      const normalised = normaliseEmail(email)
      const token = generateToken()

      // An invite is a magic link that also carries a team and a role, so
      // accepting it and signing in are the same click.
      await db.insert(s.login_tokens).values({
        id: randomUUID(),
        email: normalised,
        token_hash: hashToken(token),
        invite_team_id: teamId,
        invite_role: role,
        expires_at: new Date(Date.now() + INVITE_TTL_SECONDS * 1000),
      })

      const url = new URL('/api/auth/callback', apiOrigin)
      url.searchParams.set('token', token)

      await mailer.sendMagicLink(normalised, url.toString())
      void invitedBy
      return { url: url.toString() }
    },

    async startVisitorSession(token) {
      const [link] = await db
        .select()
        .from(s.visitor_links)
        .where(
          and(eq(s.visitor_links.token_hash, hashToken(token)), isNull(s.visitor_links.revoked_at)),
        )
        .limit(1)

      if (!link) return null
      if (link.expires_at && link.expires_at.getTime() <= Date.now()) return null

      const sessionToken = generateToken()
      await db.insert(s.auth_sessions).values({
        id: randomUUID(),
        token_hash: hashToken(sessionToken),
        kind: 'visitor',
        user_id: null,
        visitor_link_id: link.id,
        expires_at: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      })

      return { sessionToken }
    },
  }
}

/**
 * Invites last a week rather than the fifteen minutes a sign-in link gets.
 * Somebody being added to a team is not necessarily at their laptop, and an
 * invite that expires before they read the email is an invite that generates a
 * support conversation instead of a membership.
 */
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60

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
