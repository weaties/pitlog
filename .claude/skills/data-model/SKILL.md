---
name: data-model
description: PitLog's entities (SPEC §6.5), the multi-tenancy rule every query must obey, and which table to reach for. Covers only what packages/db/src/schema.ts does not make obvious — the tenancy invariant, the identity-table exceptions, the sync column contract, and the modelling calls that look wrong until you know why. TRIGGER when writing any database query, adding or changing a table, or deciding where a new piece of data belongs. DO NOT trigger for UI-only changes, docs, or config.
---

# PitLog data model

`packages/db/src/schema.ts` is the source of truth for columns, types, and
indexes — read it, don't ask this skill to restate it. What follows is the
rules that are not visible in the file.

## The tenancy rule

**Team is the tenancy boundary (SPEC §4). Every domain table carries a
non-null `team_id`, and every query filters on it.**

There is deliberately **no ambient tenant** in the db client. `createDb()`
returns a plain Drizzle handle, so a missing scope shows up in the query text
rather than hiding inside a wrapper that someone will later bypass.

```ts
// Right — the scope is visible at the call site.
await db.select().from(s.stints)
  .where(and(eq(s.stints.team_id, teamId), eq(s.stints.session_id, sessionId)))

// Wrong — reachable from any team that can guess a session id.
await db.select().from(s.stints).where(eq(s.stints.session_id, sessionId))
```

Filtering by a child key (`session_id`, `expense_id`) is **not** a substitute.
Ids are UUIDs, not secrets: they appear in URLs, in sync payloads, and in
exported data.

### The four exceptions

`teams`, `users`, `login_tokens`, `auth_sessions` have no `team_id`:

- `teams` **is** the tenant — its `id` is the team id.
- `users` is cross-tenant: one account, zero or more teams. Tenancy lives in
  `memberships`.
- `login_tokens` is issued before we know which team a login lands in.
- `auth_sessions` belongs to the account, not a team.

`packages/db/src/schema.test.ts` asserts this allowlist **in both directions** —
a new domain table without `team_id` fails, and adding `team_id` to an identity
table also fails. If you are about to edit that allowlist, stop and think about
whether you actually want a cross-tenant table.

## The sync column contract

Every table a pit client can write to carries:

| Column | Why |
|---|---|
| `id` (uuid, PK) | **Client-generated.** A phone with no signal must be able to create a row and know its id. Never use a database default here. |
| `client_updated_at` | The LWW comparator. Comes from the **writing device's** clock. |
| `server_updated_at` | Receipt stamp. **Never** the comparator. |
| `deleted_at` | Soft delete, so an offline delete can be replayed and surfaced. |
| `updated_by` | Ties the write to a user; also the deterministic LWW tie-break. |

Using `server_updated_at` to resolve conflicts is the single most tempting
mistake here: it silently reorders a write made offline hours earlier behind
one made online seconds ago. See `/offline-sync`.

**Reads must exclude soft-deleted rows** (`isNull(table.deleted_at)`) unless
you are deliberately building a history or conflict view.

## Which table

| You want to record | Table | Note |
|---|---|---|
| "someone tapped a button at this instant" | `log_entries` | The append-mostly stream. Kinds are the SPEC §5.2 list plus `clapper`. |
| a seat, planned or actual | `stints` | `planned_*` vs `started_at`/`ended_at`. A plan is a stint row with no actuals yet. |
| fuel going into the car | `fuel_fills` | `filled_to_full` matters — only a brim fill is a usable burn-rate datapoint. |
| a lap time | `laps` | Both `official` and `gps` rows coexist. Never merge them. |
| tyres or pads as a unit | `consumable_sets` + `consumable_events` | The set is the thing; events are what happened to it. |
| money spent | `expenses` (+ `expense_shares`, `receipts`) | Integer cents. Shares must sum to the parent. |
| a YouTube video tied to a session | `media_assets` | `t0` is wall-clock at video time zero; `clock_scale` is the optional drift fit. |
| a GPX/IMU capture | `telemetry_files` | Manifest + object key only. |

**There is no row-per-sample table and there must not be one** (SPEC §6.5).
Telemetry lives in files referenced by manifests. A schema change that adds a
samples table is a spec change — open a PR against `docs/SPEC.md` first.

## Modelling calls that look wrong until you know why

- **`series` is team-scoped**, not shared reference data. Duplicated rows are
  the price of a tenancy rule with zero exceptions, and it lets a team fork a
  rule set without an admin UI for editing global rows.
- **`rule_configs` is append-only.** An edit is a new `version` row, not an
  `UPDATE`. The active one is flagged `is_active`. History matters: a schedule
  run last season was run against specific rules.
- **Expenses reference `drivers`, not `memberships` or `users`.** SPEC §5.3
  says "split costs among drivers"; `drivers` is the per-team person record.
  Crew who share costs but never take a seat get `can_drive = false`.
- **`laps` has no unique constraint on `(session, source, lap_number)`**, only
  an index. Official timing renumbers after a protest. The unique constraint is
  on `external_id` where present, so a re-pull updates instead of duplicating.
- **Drivers have `first_name` and `last_name` separately** because visitors see
  first names only (SPEC §4: no PII beyond driver first names). Any
  visitor-facing serializer must respect that.

## Adding a table

1. Add it to `schema.ts` with `team_id` and the sync columns (copy the
   `syncColumns` spread from a neighbour).
2. Run `npm run db:generate` — see `/new-migration` for the mechanics.
3. `schema.test.ts` will fail if you missed the invariants. That is the test
   doing its job; fix the schema, not the test.
4. If the table is not in SPEC §6.5, say so in the PR body and explain why the
   spec's first cut needs widening.
