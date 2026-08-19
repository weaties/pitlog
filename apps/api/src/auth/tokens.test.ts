import { describe, expect, it } from 'vitest'
import { generateToken, hashToken, MAGIC_LINK_TTL_SECONDS, safeEqual } from './tokens.js'

describe('generateToken', () => {
  it('returns a url-safe string', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('carries at least 128 bits of entropy', () => {
    // base64url: 4 chars per 3 bytes. 32 bytes -> 43 chars.
    expect(generateToken().length).toBeGreaterThanOrEqual(43)
  })

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateToken()))
    expect(seen.size).toBe(1000)
  })
})

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
  })

  it('differs for different inputs', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })

  it('does not return the token itself — a database leak must not yield usable links', () => {
    const token = generateToken()
    expect(hashToken(token)).not.toBe(token)
    expect(hashToken(token)).not.toContain(token)
  })

  it('returns lowercase hex of a sha-256 digest', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('safeEqual', () => {
  it('matches equal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
  })

  it('rejects different strings', () => {
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  it('rejects different-length strings without throwing', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'a')).toBe(false)
  })
})

describe('MAGIC_LINK_TTL_SECONDS', () => {
  it('is short enough to limit an intercepted link but long enough to read email at a track', () => {
    expect(MAGIC_LINK_TTL_SECONDS).toBeGreaterThanOrEqual(5 * 60)
    expect(MAGIC_LINK_TTL_SECONDS).toBeLessThanOrEqual(60 * 60)
  })
})
