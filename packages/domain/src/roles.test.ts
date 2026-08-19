import { describe, expect, it } from 'vitest'
import { can, isRole, outranks, type Permission, parseRole, ROLES, type Role } from './roles.js'

describe('roles', () => {
  it('defines exactly the three roles from SPEC §4', () => {
    expect(ROLES).toEqual(['admin', 'crew', 'visitor'])
  })

  it('recognises valid roles and rejects anything else', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('crew')).toBe(true)
    expect(isRole('visitor')).toBe(true)
    expect(isRole('owner')).toBe(false)
    expect(isRole('')).toBe(false)
    expect(isRole('Admin')).toBe(false)
  })

  it('parseRole throws on an unknown role rather than defaulting', () => {
    expect(parseRole('crew')).toBe('crew')
    expect(() => parseRole('superuser')).toThrow(/unknown role/i)
  })
})

describe('outranks', () => {
  it('orders admin > crew > visitor', () => {
    expect(outranks('admin', 'crew')).toBe(true)
    expect(outranks('crew', 'visitor')).toBe(true)
    expect(outranks('admin', 'visitor')).toBe(true)
  })

  it('is strict — a role does not outrank itself', () => {
    for (const r of ROLES) expect(outranks(r, r)).toBe(false)
  })

  it('does not let lower roles outrank higher ones', () => {
    expect(outranks('visitor', 'crew')).toBe(false)
    expect(outranks('crew', 'admin')).toBe(false)
  })
})

describe('can', () => {
  // SPEC §4: visitor is read-only; crew operates the race weekend and edits
  // their own entries; admin has full control including settlement and config.
  const matrix: Array<[Permission, Record<Role, boolean>]> = [
    ['weekend:read', { admin: true, crew: true, visitor: true }],
    ['log:write', { admin: true, crew: true, visitor: false }],
    ['log:edit:own', { admin: true, crew: true, visitor: false }],
    ['log:edit:any', { admin: true, crew: false, visitor: false }],
    ['log:delete', { admin: true, crew: false, visitor: false }],
    ['planner:run', { admin: true, crew: true, visitor: false }],
    ['expense:write', { admin: true, crew: true, visitor: false }],
    ['expense:settle', { admin: true, crew: false, visitor: false }],
    ['team:manage', { admin: true, crew: false, visitor: false }],
    ['member:manage', { admin: true, crew: false, visitor: false }],
    ['rules:manage', { admin: true, crew: false, visitor: false }],
  ]

  for (const [permission, expected] of matrix) {
    for (const role of ROLES) {
      it(`${role} ${expected[role] ? 'can' : 'cannot'} ${permission}`, () => {
        expect(can(role, permission)).toBe(expected[role])
      })
    }
  }

  it('visitors hold read permission only — never any write permission', () => {
    const granted = matrix.filter(([p]) => can('visitor', p)).map(([p]) => p)
    expect(granted).toEqual(['weekend:read'])
  })

  it('denies an unrecognised permission instead of throwing', () => {
    expect(can('admin', 'nonsense:permission' as Permission)).toBe(false)
  })
})
