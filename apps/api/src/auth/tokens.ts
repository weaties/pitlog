import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Token primitives for magic-link auth (SPEC §4 — no password auth).
 *
 * Deliberately hand-rolled on `node:crypto` rather than pulled from a library.
 * The whole surface is three functions; the well-known options are either
 * archived (Lucia, whose author now recommends exactly this) or bring an
 * adapter layer and a provider model we do not need for one email flow. See
 * the "Decisions" section of AGENTS.md.
 */

/** How long a magic link stays usable. */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60

/** How long a signed-in session lasts. A race weekend plus travel. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/** 256 bits, base64url — safe to put in a URL and in an email. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Only the hash is ever stored. A database leak then yields no usable links or
 * sessions. SHA-256 without a salt is correct here: the input is already 256
 * bits of uniform entropy, so there is nothing to brute-force and a slow KDF
 * would only cost latency on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time comparison that tolerates length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
