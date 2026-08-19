/**
 * Roles and permissions — SPEC §4.
 *
 * The permission set is deliberately a flat, closed list rather than a
 * capability tree: with three roles and one tenancy boundary, a lookup table
 * is auditable at a glance and the API middleware can name the exact
 * permission each route requires.
 *
 * Tenancy is orthogonal and is NOT expressed here. A permission grant answers
 * "may this role do this?"; the caller must separately have established that
 * the membership being consulted belongs to the team owning the row.
 */

export const ROLES = ['admin', 'crew', 'visitor'] as const

export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'weekend:read',
  'log:write',
  'log:edit:own',
  'log:edit:any',
  'log:delete',
  'planner:run',
  'expense:write',
  'expense:settle',
  'team:manage',
  'member:manage',
  'rules:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Higher number outranks lower. Used for invite/assignment guards. */
const RANK: Record<Role, number> = { admin: 3, crew: 2, visitor: 1 }

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(PERMISSIONS),
  crew: new Set<Permission>([
    'weekend:read',
    'log:write',
    'log:edit:own',
    'planner:run',
    'expense:write',
  ]),
  visitor: new Set<Permission>(['weekend:read']),
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/** Parse an untrusted role string. Throws rather than defaulting — a silent
 *  fallback to `visitor` would mask a broken membership row, and a fallback to
 *  anything else would be a privilege escalation. */
export function parseRole(value: unknown): Role {
  if (!isRole(value)) throw new Error(`unknown role: ${JSON.stringify(value)}`)
  return value
}

/** Strict: a role never outranks itself. */
export function outranks(a: Role, b: Role): boolean {
  return RANK[a] > RANK[b]
}

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].has(permission)
}
