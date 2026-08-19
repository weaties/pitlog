/**
 * What a pit client is allowed to write, and what shape it must be in.
 *
 * SPEC's "parse at the boundary, trust inside" applies with force here: a sync
 * batch is untrusted input that arrives hours after it was typed, from a device
 * that may be running an older build. Every row is parsed against the table it
 * claims to belong to, unknown columns are rejected rather than ignored, and
 * `team_id` is checked against the team in the path — a payload cannot reach
 * sideways into another tenant by asserting a different one.
 *
 * The allowlist is deliberately narrower than the schema. `laps`,
 * `media_assets` and `telemetry_files` carry sync columns but are M2 ingest
 * paths written by the server, so a phone has no business pushing them.
 *
 * These schemas mirror `packages/db/src/schema.ts` by hand. That duplication is
 * checked rather than trusted: `apps/api/src/routes/sync.test.ts` asserts the
 * two lists agree, so a new syncable table cannot silently go unwritable.
 */

import { z } from 'zod'

export const SYNC_TABLES = [
  'events',
  'sessions',
  'drivers',
  'stints',
  'fuel_fills',
  'consumable_sets',
  'consumable_events',
  'expenses',
  'receipts',
  'expense_shares',
  'log_entries',
] as const

export type SyncTableName = (typeof SYNC_TABLES)[number]

/**
 * Tables the client may **read** but never write.
 *
 * `laps` are ingested from a timing provider by the server (SPEC §5.4), so a
 * phone has no business pushing them — but it very much needs to read them:
 * laps on a tyre set are derived from this table, never hand-counted.
 *
 * `media_assets` and `telemetry_files` are deliberately absent. They are M2,
 * and pulling manifests nobody reads onto every phone would cost bandwidth at
 * exactly the place there is none.
 */
export const PULL_ONLY_TABLES = ['laps'] as const

export type PullOnlyTableName = (typeof PULL_ONLY_TABLES)[number]

/** Everything the client keeps a local copy of. */
export const PULLABLE_TABLES = [...SYNC_TABLES, ...PULL_ONLY_TABLES] as const

export type PullableTableName = SyncTableName | PullOnlyTableName

export function isSyncTable(value: unknown): value is SyncTableName {
  return typeof value === 'string' && (SYNC_TABLES as readonly string[]).includes(value)
}

const uuid = z.string().uuid()
const optionalUuid = uuid.nullable().default(null)
/** Timestamps cross the wire as ISO strings and are UTC everywhere. */
const timestamp = z.coerce.date()
const optionalTimestamp = timestamp.nullable().default(null)
const text = z.string()
const optionalText = z.string().nullable().default(null)
const optionalInt = z.int().nullable().default(null)

/**
 * Postgres `numeric` round-trips as a string through postgres.js. Accepting a
 * number and storing the string keeps the client free to send JSON numbers
 * without either side quietly going through a float.
 */
const decimal = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
const optionalDecimal = decimal.nullable().default(null)

/** The columns every syncable row carries — `syncColumns` in the db schema. */
const envelope = {
  id: uuid,
  team_id: uuid,
  client_updated_at: timestamp,
  deleted_at: optionalTimestamp,
  updated_by: optionalUuid,
}

/**
 * `.strict()` is the point: a client that sends a column this build does not
 * know about gets a named rejection rather than having it dropped on the floor.
 */
const table = <S extends z.ZodRawShape>(shape: S) => z.object({ ...envelope, ...shape }).strict()

export const SYNC_TABLE_SCHEMAS = {
  events: table({
    series_id: optionalUuid,
    rule_config_id: optionalUuid,
    name: text,
    track_name: optionalText,
    timezone: z.string().default('UTC'),
    starts_at: optionalTimestamp,
    ends_at: optionalTimestamp,
    fuel_capacity_gallons: optionalDecimal,
    burn_rate_gph: optionalDecimal,
  }),
  sessions: table({
    event_id: uuid,
    kind: z.enum(['practice', 'qualifying', 'race']),
    name: text,
    starts_at: optionalTimestamp,
    ends_at: optionalTimestamp,
    scheduled_duration_seconds: optionalInt,
  }),
  drivers: table({
    user_id: optionalUuid,
    first_name: text,
    last_name: optionalText,
    can_drive: z.boolean().default(true),
    min_stint_seconds: optionalInt,
    max_stint_seconds: optionalInt,
    burn_rate_factor: optionalDecimal,
    /** The crew's running order. Null sorts last — see the db schema. */
    sort_order: optionalInt,
    notes: optionalText,
  }),
  stints: table({
    session_id: uuid,
    driver_id: optionalUuid,
    sequence: z.int(),
    planned_start_at: optionalTimestamp,
    planned_end_at: optionalTimestamp,
    started_at: optionalTimestamp,
    ended_at: optionalTimestamp,
    fuel_at_start_gallons: optionalDecimal,
    fuel_at_end_gallons: optionalDecimal,
    notes: optionalText,
  }),
  fuel_fills: table({
    session_id: uuid,
    stint_id: optionalUuid,
    filled_at: timestamp,
    gallons: decimal,
    /** Integer cents. Never a float — AGENTS.md. */
    cost_cents: optionalInt,
    filled_to_full: z.boolean().default(true),
    notes: optionalText,
  }),
  consumable_sets: table({
    kind: z.enum(['tires', 'brake_pads', 'oil']),
    label: text,
    spec: optionalText,
    retired_at: optionalTimestamp,
  }),
  consumable_events: table({
    consumable_set_id: uuid,
    session_id: optionalUuid,
    kind: z.enum(['install', 'rotate', 'remove', 'inspect']),
    occurred_at: timestamp,
    corner: optionalText,
    laps_on_set: optionalInt,
    hours_on_set: optionalDecimal,
    notes: optionalText,
  }),
  expenses: table({
    event_id: optionalUuid,
    payer_driver_id: optionalUuid,
    amount_cents: z.int(),
    currency: z.string().default('USD'),
    category: z.enum([
      'entry_fee',
      'fuel',
      'tires',
      'parts',
      'tools',
      'lodging',
      'travel',
      'food',
      'other',
    ]),
    description: text,
    spent_at: timestamp,
  }),
  receipts: table({
    expense_id: uuid,
    /** Null until the blob follows the row — SPEC §5.3, capture works offline. */
    storage_key: optionalText,
    upload_state: z.enum(['pending', 'uploaded', 'failed']).default('pending'),
    content_type: optionalText,
    byte_size: optionalInt,
    sha256: optionalText,
    captured_at: optionalTimestamp,
  }),
  expense_shares: table({
    expense_id: uuid,
    driver_id: uuid,
    share_cents: z.int(),
    settled_at: optionalTimestamp,
  }),
  log_entries: table({
    event_id: optionalUuid,
    session_id: optionalUuid,
    driver_id: optionalUuid,
    kind: z.enum([
      'driver_in',
      'driver_out',
      'fuel_fill',
      'tire_change',
      'tire_rotation',
      'brake_pad_change',
      'incident',
      'black_flag',
      'clapper',
      'note',
    ]),
    occurred_at: timestamp,
    note: optionalText,
    payload: z.unknown().nullable().default(null),
    logged_by: optionalUuid,
  }),
} as const satisfies Record<SyncTableName, z.ZodType>

export type SyncTableSchemas = typeof SYNC_TABLE_SCHEMAS
