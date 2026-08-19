/**
 * PitLog schema v1 — SPEC §6.5.
 *
 * Three rules hold across this file; the invariants are enforced by
 * `schema.test.ts`, not by convention:
 *
 * 1. **Tenancy.** Every domain table carries a non-null `team_id` (SPEC §4).
 *    The only exceptions are the tenant root itself (`teams`) and the identity
 *    tables (`users`, `login_tokens`, `auth_sessions`), which are cross-tenant
 *    by construction — a user belongs to zero or more teams, and a login token
 *    is issued before we know which team the login lands in.
 *
 * 2. **Offline-first.** Every table a pit client can write to has a
 *    client-generated `uuid` primary key, a `client_updated_at` LWW
 *    comparator taken from the writing device's clock, a `server_updated_at`
 *    receipt stamp, and a `deleted_at` soft delete. See the `offline-sync`
 *    skill.
 *
 * 3. **Telemetry stays in files.** `telemetry_files` holds manifests and object
 *    keys. There is deliberately no row-per-sample table (SPEC §6.5).
 */

import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['admin', 'crew', 'visitor'])
export const sessionKindEnum = pgEnum('session_kind', ['practice', 'qualifying', 'race'])
export const lapSourceEnum = pgEnum('lap_source', ['official', 'gps'])
export const consumableKindEnum = pgEnum('consumable_kind', ['tires', 'brake_pads', 'oil'])
export const consumableEventKindEnum = pgEnum('consumable_event_kind', [
  'install',
  'rotate',
  'remove',
  'inspect',
])
export const expenseCategoryEnum = pgEnum('expense_category', [
  'entry_fee',
  'fuel',
  'tires',
  'parts',
  'tools',
  'lodging',
  'travel',
  'food',
  'other',
])
export const uploadStateEnum = pgEnum('upload_state', ['pending', 'uploaded', 'failed'])
export const mediaKindEnum = pgEnum('media_kind', ['youtube', 'photo', 'other'])
export const mediaAnchorSourceEnum = pgEnum('media_anchor_source', [
  'clapper',
  'manual',
  'imu',
  'none',
])
export const telemetryKindEnum = pgEnum('telemetry_kind', ['gpx', 'imu', 'can', 'video_manifest'])
export const verificationStatusEnum = pgEnum('verification_status', [
  'UNVERIFIED',
  'PARTIAL',
  'VERIFIED',
])
/** SPEC §5.2 one-tap log kinds, plus `clapper` from §5.6. */
export const logEntryKindEnum = pgEnum('log_entry_kind', [
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
])
export const authSessionKindEnum = pgEnum('auth_session_kind', ['user', 'visitor'])

// ---------------------------------------------------------------------------
// Shared column sets
// ---------------------------------------------------------------------------

const now = sql`now()`

/**
 * Columns every syncable domain row carries.
 *
 * `client_updated_at` is the last-write-wins comparator and comes from the
 * *writing device's* clock. `server_updated_at` is the receipt stamp and is
 * never used for conflict resolution — trusting it would silently reorder
 * writes that were made offline hours earlier. Ties on `client_updated_at`
 * break on `updated_by` so two devices converge on the same winner.
 */
const syncColumns = {
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  client_updated_at: timestamp('client_updated_at', { withTimezone: true }).notNull().default(now),
  server_updated_at: timestamp('server_updated_at', { withTimezone: true }).notNull().default(now),
  /** Soft delete: an offline delete must be replayable and surfaceable. */
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  updated_by: uuid('updated_by'),
}

// ---------------------------------------------------------------------------
// Tenancy + identity
// ---------------------------------------------------------------------------

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  server_updated_at: timestamp('server_updated_at', { withTimezone: true }).notNull().default(now),
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  /** Stored lowercased; the unique index is the login identity. */
  email: text('email').notNull().unique(),
  display_name: text('display_name'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  last_login_at: timestamp('last_login_at', { withTimezone: true }),
})

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    invited_by: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    server_updated_at: timestamp('server_updated_at', { withTimezone: true })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex('memberships_team_user_uq').on(t.team_id, t.user_id)],
)

/**
 * Magic-link tokens (SPEC §4 — no password auth). Only the hash is stored, so
 * a database leak does not yield usable links. `team_id` is set when the link
 * is an invite into a specific team, null for a plain sign-in.
 */
export const login_tokens = pgTable(
  'login_tokens',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    token_hash: text('token_hash').notNull().unique(),
    invite_team_id: uuid('invite_team_id').references(() => teams.id, { onDelete: 'cascade' }),
    invite_role: roleEnum('invite_role'),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('login_tokens_email_idx').on(t.email)],
)

export const auth_sessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey(),
    token_hash: text('token_hash').notNull().unique(),
    kind: authSessionKindEnum('kind').notNull().default('user'),
    /** Null for a visitor session, which is scoped by `visitor_link_id`. */
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    visitor_link_id: uuid('visitor_link_id'),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('auth_sessions_user_idx').on(t.user_id)],
)

/**
 * Token-scoped, revocable read-only access for family and friends (SPEC §4).
 * Not in the §6.5 first cut; added because §4 requires revocable visitor links
 * and a bare `visitor` membership cannot be revoked without deleting a user.
 */
export const visitor_links = pgTable(
  'visitor_links',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Null scopes the link to the whole team rather than one race weekend. */
    event_id: uuid('event_id'),
    token_hash: text('token_hash').notNull().unique(),
    label: text('label').notNull(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [index('visitor_links_team_idx').on(t.team_id)],
)

// ---------------------------------------------------------------------------
// Series + rules
// ---------------------------------------------------------------------------

/**
 * Series are team-scoped rather than global reference data. It costs a few
 * duplicated rows and buys two things: the SPEC §4 tenancy rule holds without
 * exception, and a team can fork a rule set (a regional variant, a one-off
 * enduro) without an admin surface for editing shared rows.
 */
export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Matches `config/series/<key>.yaml`. */
    key: text('key').notNull(),
    display_name: text('display_name').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    server_updated_at: timestamp('server_updated_at', { withTimezone: true })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex('series_team_key_uq').on(t.team_id, t.key)],
)

/**
 * Versioned rule configs — SPEC §5.1 "rule configs are data, not code".
 * `config` holds a document validated by `seriesRulesConfigSchema` in
 * @pitlog/domain. History is kept by inserting a new `version`, never by
 * updating in place.
 */
export const rule_configs = pgTable(
  'rule_configs',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    series_id: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    config: jsonb('config').notNull(),
    /** Denormalised from `config.verification.status` so the UI can badge a
     *  config as UNVERIFIED without parsing every blob. */
    verification_status: verificationStatusEnum('verification_status')
      .notNull()
      .default('UNVERIFIED'),
    is_active: boolean('is_active').notNull().default(false),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [uniqueIndex('rule_configs_series_version_uq').on(t.series_id, t.version)],
)

// ---------------------------------------------------------------------------
// Race weekend
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    series_id: uuid('series_id').references(() => series.id, { onDelete: 'set null' }),
    rule_config_id: uuid('rule_config_id').references(() => rule_configs.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    track_name: text('track_name'),
    /** IANA zone; all timestamps are stored UTC and rendered in this zone. */
    timezone: text('timezone').notNull().default('UTC'),
    starts_at: timestamp('starts_at', { withTimezone: true }),
    ends_at: timestamp('ends_at', { withTimezone: true }),
    fuel_capacity_gallons: numeric('fuel_capacity_gallons', { precision: 6, scale: 2 }),
    /** Seeded by hand, refined from logged fills — SPEC §5.1. */
    burn_rate_gph: numeric('burn_rate_gph', { precision: 6, scale: 3 }),
    ...syncColumns,
  },
  (t) => [index('events_team_idx').on(t.team_id, t.starts_at)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    event_id: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    kind: sessionKindEnum('kind').notNull(),
    name: text('name').notNull(),
    starts_at: timestamp('starts_at', { withTimezone: true }),
    ends_at: timestamp('ends_at', { withTimezone: true }),
    /** Scheduled length; the planner's race horizon. */
    scheduled_duration_seconds: integer('scheduled_duration_seconds'),
    ...syncColumns,
  },
  (t) => [index('sessions_event_idx').on(t.event_id, t.starts_at)],
)

/**
 * A person who can hold a seat or a cost share. `user_id` links to a login when
 * they have one — crew without an account still get a row so expenses can be
 * split. Visitors only ever see `first_name` (SPEC §4: no PII beyond first
 * names).
 */
export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    first_name: text('first_name').notNull(),
    last_name: text('last_name'),
    /** False for crew who never take a seat but do share costs. */
    can_drive: boolean('can_drive').notNull().default(true),
    min_stint_seconds: integer('min_stint_seconds'),
    max_stint_seconds: integer('max_stint_seconds'),
    /** Multiplier on the team burn rate once enough data exists — SPEC §5.1. */
    burn_rate_factor: numeric('burn_rate_factor', { precision: 5, scale: 3 }),
    /**
     * Where this driver sits in the running order the crew chose.
     *
     * The planner's last tiebreak is "roster order" (AGENTS.md → Decisions),
     * and before this column that meant whatever order the rows happened to
     * come back in — primary-key order, and the keys are client-generated
     * UUIDs. So who started the race was effectively arbitrary. This makes the
     * order a thing the crew owns.
     *
     * Null sorts last, so a driver added mid-weekend does not silently jump
     * the queue.
     */
    sort_order: integer('sort_order'),
    notes: text('notes'),
    ...syncColumns,
  },
  (t) => [index('drivers_team_idx').on(t.team_id)],
)

/**
 * Planned and actual seat time. A row starts as a plan (`planned_*` set,
 * `started_at` null) and gains actuals as the race runs; the planner re-solves
 * from "now" against the actuals (SPEC §5.1 live replanning).
 */
export const stints = pgTable(
  'stints',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    session_id: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    driver_id: uuid('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    sequence: integer('sequence').notNull(),
    planned_start_at: timestamp('planned_start_at', { withTimezone: true }),
    planned_end_at: timestamp('planned_end_at', { withTimezone: true }),
    started_at: timestamp('started_at', { withTimezone: true }),
    ended_at: timestamp('ended_at', { withTimezone: true }),
    fuel_at_start_gallons: numeric('fuel_at_start_gallons', { precision: 6, scale: 2 }),
    fuel_at_end_gallons: numeric('fuel_at_end_gallons', { precision: 6, scale: 2 }),
    notes: text('notes'),
    ...syncColumns,
  },
  (t) => [
    index('stints_session_idx').on(t.session_id, t.sequence),
    index('stints_driver_idx').on(t.driver_id),
  ],
)

export const fuel_fills = pgTable(
  'fuel_fills',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    session_id: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stint_id: uuid('stint_id').references(() => stints.id, { onDelete: 'set null' }),
    filled_at: timestamp('filled_at', { withTimezone: true }).notNull(),
    gallons: numeric('gallons', { precision: 6, scale: 2 }).notNull(),
    cost_cents: integer('cost_cents'),
    /** True when the tank was filled to the brim, which is what makes a fill
     *  usable as a burn-rate datapoint (SPEC §5.1). */
    filled_to_full: boolean('filled_to_full').notNull().default(true),
    notes: text('notes'),
    ...syncColumns,
  },
  (t) => [index('fuel_fills_session_idx').on(t.session_id, t.filled_at)],
)

/**
 * Both timing sources live here side by side (SPEC §5.4). Official timing is
 * the truth for standings; GPS timing is the truth for telemetry and video
 * alignment. Reconciliation is a view over this table, not a merge into it.
 */
export const laps = pgTable(
  'laps',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    session_id: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    driver_id: uuid('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    stint_id: uuid('stint_id').references(() => stints.id, { onDelete: 'set null' }),
    source: lapSourceEnum('source').notNull(),
    lap_number: integer('lap_number').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }),
    lap_time_ms: integer('lap_time_ms'),
    position: integer('position'),
    /** Provider row id, so a re-pull updates rather than duplicates. */
    external_id: text('external_id'),
    flags: jsonb('flags'),
    ...syncColumns,
  },
  (t) => [
    index('laps_session_source_idx').on(t.session_id, t.source, t.lap_number),
    uniqueIndex('laps_external_uq')
      .on(t.session_id, t.source, t.external_id)
      .where(sql`${t.external_id} is not null`),
  ],
)

// ---------------------------------------------------------------------------
// Consumables
// ---------------------------------------------------------------------------

export const consumable_sets = pgTable(
  'consumable_sets',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    kind: consumableKindEnum('kind').notNull(),
    /** Human set ID written on the tyre — "R7 set B". */
    label: text('label').notNull(),
    spec: text('spec'),
    retired_at: timestamp('retired_at', { withTimezone: true }),
    ...syncColumns,
  },
  (t) => [index('consumable_sets_team_idx').on(t.team_id, t.kind)],
)

export const consumable_events = pgTable(
  'consumable_events',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    consumable_set_id: uuid('consumable_set_id')
      .notNull()
      .references(() => consumable_sets.id, { onDelete: 'cascade' }),
    session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    kind: consumableEventKindEnum('kind').notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Which corner, for tyres — 'lf' | 'rf' | 'lr' | 'rr' | 'all'. Free text
     *  rather than an enum because pad and oil events do not use it. */
    corner: text('corner'),
    laps_on_set: integer('laps_on_set'),
    hours_on_set: numeric('hours_on_set', { precision: 7, scale: 2 }),
    notes: text('notes'),
    ...syncColumns,
  },
  (t) => [index('consumable_events_set_idx').on(t.consumable_set_id, t.occurred_at)],
)

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    event_id: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    /** Who actually paid. References `drivers` because that is the per-team
     *  person record — crew without a login still have one. */
    payer_driver_id: uuid('payer_driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    /** Integer cents; never floats for money. */
    amount_cents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    category: expenseCategoryEnum('category').notNull().default('other'),
    description: text('description').notNull(),
    spent_at: timestamp('spent_at', { withTimezone: true }).notNull(),
    ...syncColumns,
  },
  (t) => [index('expenses_team_idx').on(t.team_id, t.spent_at)],
)

export const receipts = pgTable(
  'receipts',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    expense_id: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    /** Object-storage key. Null while the photo is still only on the device —
     *  capture works offline (SPEC §5.3), upload catches up later. */
    storage_key: text('storage_key'),
    upload_state: uploadStateEnum('upload_state').notNull().default('pending'),
    content_type: text('content_type'),
    byte_size: bigint('byte_size', { mode: 'number' }),
    sha256: text('sha256'),
    captured_at: timestamp('captured_at', { withTimezone: true }),
    ...syncColumns,
  },
  (t) => [index('receipts_expense_idx').on(t.expense_id)],
)

export const expense_shares = pgTable(
  'expense_shares',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    expense_id: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    driver_id: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    /** Shares must sum to the parent expense; enforced in the domain layer so
     *  the error can name the shortfall rather than raising a constraint. */
    share_cents: integer('share_cents').notNull(),
    settled_at: timestamp('settled_at', { withTimezone: true }),
    ...syncColumns,
  },
  (t) => [uniqueIndex('expense_shares_expense_driver_uq').on(t.expense_id, t.driver_id)],
)

// ---------------------------------------------------------------------------
// Media + telemetry
// ---------------------------------------------------------------------------

/**
 * A YouTube upload (or photo) tied to a session — SPEC §5.6. `t0` is the
 * wall-clock instant corresponding to video time zero, derived from the
 * clapper anchor. `clock_scale` carries the optional two-point drift fit; 1.0
 * means "no correction applied".
 */
export const media_assets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    kind: mediaKindEnum('kind').notNull().default('youtube'),
    youtube_id: text('youtube_id'),
    url: text('url'),
    title: text('title'),
    t0: timestamp('t0', { withTimezone: true }),
    duration_seconds: integer('duration_seconds'),
    clock_scale: numeric('clock_scale', { precision: 10, scale: 8 }),
    anchor_source: mediaAnchorSourceEnum('anchor_source').notNull().default('none'),
    /** Manual ±nudge in the linking UI, kept separate from `t0` so the derived
     *  anchor and the human correction stay distinguishable. */
    anchor_offset_ms: integer('anchor_offset_ms').notNull().default(0),
    ...syncColumns,
  },
  (t) => [index('media_assets_session_idx').on(t.session_id)],
)

/**
 * Manifests for GPX / IMU / CAN captures. The samples themselves live in object
 * storage or columnar blobs — SPEC §6.5 explicitly rules out row-per-sample.
 */
export const telemetry_files = pgTable(
  'telemetry_files',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    kind: telemetryKindEnum('kind').notNull(),
    storage_key: text('storage_key'),
    upload_state: uploadStateEnum('upload_state').notNull().default('pending'),
    byte_size: bigint('byte_size', { mode: 'number' }),
    sha256: text('sha256'),
    sample_start_at: timestamp('sample_start_at', { withTimezone: true }),
    sample_end_at: timestamp('sample_end_at', { withTimezone: true }),
    /** Channel list, sample rates, GPS clock provenance. */
    manifest: jsonb('manifest'),
    ...syncColumns,
  },
  (t) => [index('telemetry_files_session_idx').on(t.session_id, t.sample_start_at)],
)

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Superseded versions of syncable rows — SPEC §5.2 "editable with history",
 * and the evidence behind conflict surfacing (SPEC §6.2).
 *
 * One mechanism serves both, because they are the same event seen from two
 * angles: something was overwritten. A correction the same person made is
 * history; an overwrite of somebody *else's* value is a conflict worth
 * interrupting them about. `superseded_by` records which write did it.
 *
 * Append-only. Rows here are never updated and never deleted, which is what
 * makes last-write-wins survivable: the person whose value lost can always
 * find out what they entered.
 */
export const row_versions = pgTable(
  'row_versions',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** The table the superseded row belongs to, e.g. `fuel_fills`. */
    table_name: text('table_name').notNull(),
    /** The client-generated id of the row, stable across every version. */
    row_id: uuid('row_id').notNull(),
    /** The whole previous row, as it was before being overwritten. */
    snapshot: jsonb('snapshot').notNull(),
    /** The losing write's own comparator and author. */
    client_updated_at: timestamp('client_updated_at', { withTimezone: true }).notNull(),
    updated_by: uuid('updated_by'),
    /** Who overwrote it. Null when the writer was unattributed. */
    superseded_by: uuid('superseded_by'),
    /** True when the winner was a different person — see `mergeRow`. */
    was_conflict: boolean('was_conflict').notNull().default(false),
    /** Cleared when a human has looked at it. Only meaningful for conflicts. */
    acknowledged_at: timestamp('acknowledged_at', { withTimezone: true }),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull().default(now),
  },
  (t) => [
    index('row_versions_row_idx').on(t.team_id, t.table_name, t.row_id),
    index('row_versions_conflict_idx').on(t.team_id, t.was_conflict, t.recorded_at),
  ],
)

// ---------------------------------------------------------------------------
// Generic log
// ---------------------------------------------------------------------------

/**
 * The append-mostly stream behind one-tap logging (SPEC §5.2). Structured rows
 * (`stints`, `fuel_fills`, …) are the queryable projection; a log entry is the
 * raw "someone tapped this at this instant" record and is what the offline
 * queue replays.
 */
export const log_entries = pgTable(
  'log_entries',
  {
    id: uuid('id').primaryKey(),
    team_id: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    event_id: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    driver_id: uuid('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    kind: logEntryKindEnum('kind').notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    note: text('note'),
    /** Kind-specific detail; the structured tables own anything queryable. */
    payload: jsonb('payload'),
    logged_by: uuid('logged_by').references(() => users.id, { onDelete: 'set null' }),
    ...syncColumns,
  },
  (t) => [index('log_entries_session_idx').on(t.session_id, t.occurred_at)],
)
