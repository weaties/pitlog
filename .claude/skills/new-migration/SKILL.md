---
name: new-migration
description: Mechanics for adding a Drizzle/Postgres schema migration — generate, name, review the SQL, and the concurrent-worktree collision hazard. Migrations are forward-only and committed. TRIGGER when changing packages/db/src/schema.ts or anything under packages/db/drizzle/. DO NOT trigger for read-only query work or non-schema database code.
disable-model-invocation: true
---

# New schema migration

The general flow (branch, TDD, lint) is in AGENTS.md. `packages/db/drizzle/`
shows every prior migration as a worked example. This skill captures only the
migration-specific hazards.

## Procedure

```bash
# 1. Edit packages/db/src/schema.ts
# 2. Generate the SQL
make up                 # drizzle-kit needs a reachable database
npm run db:generate
# 3. Rename the generated file to something meaningful
#    e.g. 0001_lively_hawkeye.sql -> 0001_add_pit_notes.sql
#    and update the matching `tag` in packages/db/drizzle/meta/_journal.json
# 4. Read the generated SQL. Every line.
npm run db:migrate
make seed
make check
```

## Hazards

- **Read the generated SQL before committing it.** drizzle-kit infers intent
  from a schema diff. A rename reads as a drop plus an add — which is a data
  loss on a deployed database. If the SQL contains a `DROP COLUMN` or
  `DROP TABLE` you did not intend, fix the schema or hand-write the migration.

- **Migrations are forward-only and committed to git. Never edit one that has
  been applied anywhere.** Add a new migration instead. "Anywhere" includes
  another agent's local database and CI.

- **Version numbers collide across concurrent worktrees.** Two agents both
  generating `0003_*` produce a journal that silently applies only one. This is
  the main reason AGENTS.md asks for worktree isolation. At PR time, check that
  no other branch shipped the same number while you were branched.

- **Rename the generated file.** drizzle-kit's random names
  (`0001_curious_magneto`) make the history unreadable. Rename the `.sql` and
  the `tag` in `meta/_journal.json` together — they must match or the migration
  will not be found.

- **`schema.test.ts` enforces the invariants.** A new domain table without
  `team_id` or without the sync columns fails there. That failure is the test
  doing its job — fix the schema, not the test. See `/data-model`.

- **Reseed after migrating.** `make seed` truncates and rewrites; a migration
  that changes a column type will otherwise leave you debugging stale rows.

- **One migration per logical change.** Don't bundle unrelated tables into one
  version — it makes reverting and reasoning harder.
