# AGENTS.md — PitLog

Endurance-racing logging and race-management platform for budget series
(24 Hours of Lemons, Lucky Dog, ChampCar). Two halves: a **team/pit-wall web
app** — stint and fuel planning, fill logging, expenses and cost splitting,
driver coordination — and, from M2, **car-side data capture** (GPS, IMU, later
OBD2/analog via ESP32 nodes) with video time-synced to telemetry. The pit app
is v1; the car side is later.

Everything is offline-first: assume no connectivity at the track. The pit
client is a PWA that keeps working when the network is gone and syncs when it
returns, so a cloud outage during a race degrades to "sync later", not "planner
dead".

**[`docs/SPEC.md`](docs/SPEC.md) is the source of truth.** If what you are
building contradicts it, either follow the spec or open a PR changing the spec
— never silently diverge. This file is the canonical guide for **any** coding
agent and for humans; Claude Code reads it via an `@AGENTS.md` import in
`CLAUDE.md`, which adds only Claude-Code-specific mechanics. References to
`/name` below are Claude Code skill shortcuts; what they wrap is described in
`.claude/skills/<name>/SKILL.md`, so any agent can follow the rule without them.

Milestones and open work: [`ROADMAP.md`](ROADMAP.md).

## Top rules — read first

- **Never push directly to `main`.** Trunk-based: every change lands via a
  merged PR from a feature branch, even solo. CI must be green before merge.
- **TDD for anything with logic.** Failing test first, then implement, then
  green, then lint. Scaffold and config code is exempt; the planner, the
  burn-rate model, the sync merge, the rule engine, and the role gates are not.
  See `/tdd`.
- **Every query filters on `team_id`.** Team is the tenancy boundary (SPEC §4).
  There is deliberately no ambient tenant in the db client, so a missing scope
  is visible in the query rather than hidden in a wrapper. See `/data-model`.
- **Series rule values are UNVERIFIED.** SPEC §3 leaves the real Lemons /
  Lucky Dog / ChampCar rules unresolved. The shipped configs are structurally
  valid placeholders. **Do not invent real rule values**, and do not "improve"
  the placeholders by guessing. See `/series-rules`.
- **Work in a git worktree when agents run in parallel.** Two agents sharing a
  checkout collide on uncommitted changes and branch switches, and migration
  version numbers collide silently. Read-only work doesn't need one.
- **Small conventional commits, one PR per deliverable group.** Not one giant
  PR.

### Judgment rules (not just process)

- **Surface assumptions before building.** If a task is underspecified, state
  the assumption you are proceeding on rather than silently guessing.
- **Stop and ask when requirements conflict** — with `docs/SPEC.md`, with an
  issue, or with existing behaviour. Don't pick a side unasked.
- **Push back when warranted.** A worse plan you were handed is still worse.
- **Prefer boring, obvious solutions.** This software runs on a phone in a hot
  pit box with no signal while someone in gloves taps it. Reliability and
  legibility beat cleverness.
- **Touch only what you're asked to touch.** No drive-by refactors of adjacent
  code; they widen the blast radius and the diff.
- **Never present a planner number without its assumptions.** SPEC §5.1 is
  explicit: show confidence and inputs, never just a number. A schedule built
  on UNVERIFIED rules must say so on screen.

## Stack & tooling

Selected in M0 against the SPEC §6.2 criteria; the decision and the losing
candidates' dealbreakers are in **Decisions** below.

| Concern | Tool |
|---|---|
| Package manager | `npm` workspaces (Node 22+) |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Web client | React 19 + Vite, installable PWA (`vite-plugin-pwa`) |
| Client state | TanStack Query (`networkMode: 'offlineFirst'`) |
| Routing | React Router |
| Styling | Tailwind v4 (`@tailwindcss/vite`), pit-mode tokens in `apps/web/src/index.css` |
| API | Hono on `@hono/node-server` |
| Validation | Zod at every boundary (env, request bodies, rule configs) |
| Database | Postgres 17, Drizzle ORM + drizzle-kit migrations |
| Auth | magic link, hand-rolled on `node:crypto` (`apps/api/src/auth/`) |
| Lint + format | Biome (one binary, replaces eslint + prettier) |
| Unit tests | Vitest |
| Browser tests | Playwright |
| Local infra | Docker Compose (Postgres on host port **5433**) |

Car-side code remains Python and lands in M2+, independent of this stack
(SPEC §6.2).

## Project structure

```
apps/web/            React + Vite SPA, the PWA pit client
  src/pages/         one component per screen
  src/lib/api.ts     fetch wrapper; credentials always included
apps/api/            Hono JSON API
  src/app.ts         route wiring — no business logic
  src/env.ts         zod-parsed process config, loaded once at boot
  src/auth/          magic-link tokens, session service, mailer
  src/middleware/    session loading + the tenancy/role gates
  src/routes/        one module per resource group
packages/domain/     framework-free: roles, series rule schema, fixtures
  src/fixtures/      the SPEC §7 8-hour race + its known-good solution
packages/db/         Drizzle schema, migrations, seed
  drizzle/           generated SQL migrations — committed, forward-only
packages/sync/       offline sync contract (M1)
config/series/       per-series rule configs — ALL UNVERIFIED
tests/e2e/           Playwright browser smoke tests
docs/SPEC.md         source of truth
```

Use `ls`/`tree` for detail — don't ask the docs to enumerate every file.

## Common commands

```bash
make dev          # bootstrap everything and run: env, install, up, migrate, seed, run
make run          # run api + web without re-bootstrapping
make check        # typecheck + lint + unit tests (what CI runs, minus the browser test)
make test         # unit tests (vitest)
make e2e          # browser smoke tests (playwright); needs a seeded db
make seed         # reset + reseed (demo team, 3 UNVERIFIED series, fixture race)
make up / down    # local Postgres
make nuke         # stop Postgres and DELETE its data volume
make fix          # autofix lint + formatting
make help         # everything else
```

`make check` and `make e2e` must both pass before a PR.

Local sign-in: `MAIL_TRANSPORT=console` prints the magic link to the API log,
and the API also returns it as `devLink` in the `POST /api/auth/request`
response. Seeded accounts are `admin@example.com`, `crew@example.com`,
`visitor@example.com`.

## Architecture principles

- **The domain is framework-free.** `packages/domain` imports no HTTP, no
  database, no React. The stint planner, the burn-rate model, and the rule
  engine live there so they are unit-testable in milliseconds and swappable
  without a rewrite (SPEC §6.2 ¶3 requires exactly this).
- **The API is transport, not logic.** `apps/api` parses, authenticates,
  authorizes, and persists. Decisions belong in `packages/domain`.
- **Team is the tenancy boundary.** Every domain table carries a non-null
  `team_id`; every query filters on it. The only exceptions are the tenant root
  (`teams`) and the identity tables (`users`, `login_tokens`, `auth_sessions`),
  which are cross-tenant by construction. Enforced by
  `packages/db/src/schema.test.ts`.
- **Absence of access looks like absence of the resource.** No membership →
  404, not 403. A 403 confirms the team exists to someone not allowed to know.
- **Offline-first is a data-model property, not a UI feature.** Client-generated
  UUID primary keys, an append-mostly log, LWW on the *client* clock, soft
  deletes. See `/offline-sync`.
- **Timestamps are UTC everywhere.** Convert to the event's timezone only at
  display.
- **Money is integer cents.** Never floats.
- **Telemetry stays in files.** `telemetry_files` holds manifests and object
  keys; there is no row-per-sample table (SPEC §6.5).
- **Rule configs are data, not code** (SPEC §5.1). Versioned rows in
  `rule_configs`, seeded from `config/series/*.yaml`.

## Coding conventions

Most style is enforced by Biome and `tsc` — don't restate those rules. The
non-enforceable ones:

- **Modules are small and single-purpose.** Past ~200 lines, consider splitting.
- **Comment the *why*, never the *what*.** A comment that restates the code is
  noise; a comment explaining why 404 and not 403, or why `prefault` and not
  `default`, is the reason the next agent doesn't undo your work.
- **Parse at the boundary, trust inside.** Zod on every input; the interior
  works with parsed types.
- **Throw on unknown enum values, never default.** `parseRole` throws rather
  than falling back to `visitor`, because a silent fallback either masks a
  broken row or escalates privilege.
- **No `console.*` outside CLI output and startup banners.** Biome enforces it;
  the `biome-ignore` comments mark the legitimate cases.

## Testing

- **Failing test first** for planner, model, sync, rule-engine, and auth logic.
- **Unit tests never need a database or a browser.** Inject the dependency
  instead — the tenancy gates take a `MembershipResolver` precisely so the role
  matrix can be tested without Postgres.
- **Test the invariant, not the instance.** `schema.test.ts` asserts *every*
  domain table carries `team_id` rather than listing the ones that do, so a new
  table cannot quietly skip it.
- **The fixture race is the planner's test bed** (SPEC §7). Its numbers are
  chosen so the correct answer is exact — assert equality, not tolerance, on
  seat time and stint boundaries.
- **Browser tests are thin.** They prove the app boots, login works, and the
  shell renders. Behavioural depth belongs in Vitest.

## How to add a series rule config

Short version; full detail and the schema field list are in `/series-rules`.

1. Add `config/series/<key>.yaml`. `<key>` is a lowercase slug and must match
   `series_key` and the filename.
2. Copy an existing file's shape. Keep `verification.status: UNVERIFIED` unless
   you have actually read the rulebook.
3. Add `<key>` to `SERIES_KEYS` and give it ids in `packages/db/src/seed-data.ts`.
4. `packages/domain/src/series-rules.test.ts` asserts the shipped set — update
   the expected filenames there.
5. `make seed`.

To **verify** an existing config: read the rulebook, replace the placeholder
values, put the citation in `verification.source`, list the checked dotted paths
in `verified_fields`, move `status` to `PARTIAL`/`VERIFIED`, and bump
`config_version`. Never move `status` without a `source`.

## Do / Don't

| Do | Don't |
|---|---|
| Land changes via a merged PR on a feature branch. | Push to `main`. |
| Write the failing test first for logic. | Bolt tests on after the code works. |
| Filter every query on `team_id`. | Rely on a wrapper to scope it for you. |
| Return 404 when the caller has no membership. | Return 403 and confirm the team exists. |
| Keep planner/model logic in `packages/domain`. | Put it in a route handler or a React component. |
| Leave series rule values `UNVERIFIED` until a rulebook is read. | Guess plausible-looking pit or stint numbers. |
| Store integer cents. | Store money as a float. |
| Add a new migration for a schema change. | Edit a migration that has already been applied. |
| Show planner assumptions and confidence alongside any number. | Render a bare schedule as if it were authoritative. |
| Use `client_updated_at` as the LWW comparator. | Use `server_updated_at` — it reorders offline writes. |

## Decisions

Recorded here so the next agent doesn't relitigate them.

### Stack: Vite + React SPA / Hono API / Drizzle / Postgres (M0)

Evaluated against SPEC §6.2's criteria in priority order. The decisive argument
was criterion 4 plus §5.2: **offline-first is non-negotiable, and offline-first
wants a client-owned SPA.** A static shell plus IndexedDB plus a plain JSON API
is the shape the whole PWA ecosystem is built around. It also keeps the hard
parts of this project — the planner and the sync log — in framework-free
TypeScript packages that agents can TDD in milliseconds.

Losing candidates and their dealbreakers:

- **Next.js (App Router / RSC)** — server-render-first, structurally hostile to
  an offline-first PWA; there is no first-class offline story and service
  workers plus RSC payloads is a known bad marriage. Separately, RSC pulls data
  fetching into the view layer, which mortgages the SPEC §6.2 ¶3 requirement
  that the planner solver and sync layer stay swappable. Vendor gravity toward
  one host also conflicts with §6.4's escape-hatch clause.
- **SvelteKit** — no technical dealbreaker; it loses on criterion 1 only.
  Svelte 5 runes postdate the bulk of model training data, so agents write
  stale Svelte 4 store patterns that typecheck and then misbehave. A real cost
  against a 6–10 week deadline for no offsetting win.

Hono over Fastify for the zero-codegen end-to-end types. If that ever bites,
swapping the HTTP layer is cheap precisely because the domain logic is not in it.

### Deliberate deviations from HelmLog conventions

- **No mypy-style error baseline.** HelmLog's CI tolerates 110 pre-existing
  mypy errors and fails on 111. PitLog starts clean, so CI enforces zero. Never
  introduce a baseline here; fix the error.
- **No `RELEASES.md` promote gate.** HelmLog gates `main → stage` on a release
  note. PitLog has nothing to promote to until hosting is decided (SPEC §6.4).
  Revisit when CD is wired up.
- **Biome instead of ruff + a separate formatter.** Same role HelmLog gives
  `ruff`: one fast binary doing lint and format, so the feedback loop stays
  sub-second.
- **A tenancy skill exists that HelmLog has no analogue for.** HelmLog is
  single-boat and has no tenant concept at all. Multi-tenancy is the invariant
  most likely to be violated silently here, so it gets `/data-model` and a
  schema test rather than a convention.
- **No hardware, deploy, or Pi skills yet.** Those arrive with M2/M3.

### Smaller calls

- **`series` is team-scoped, not global reference data.** Costs a few duplicated
  rows; buys a §4 tenancy rule with no exceptions, and lets a team fork a rule
  set without an admin surface for editing shared rows.
- **Expenses reference `drivers`, not `memberships`.** SPEC §5.3 says "split
  costs among drivers". `drivers` is the per-team person record; crew who share
  costs but never take a seat get a row with `can_drive = false`. If M1 needs
  cost shares for people who are not in `drivers` at all, widen it then.
- **Three auth tables beyond the SPEC §6.5 list** — `login_tokens`,
  `auth_sessions`, `visitor_links`. §6.5 is described as a first cut and §4
  requires revocable token-scoped visitor links, which a bare `visitor`
  membership cannot provide.
- **Auth is hand-rolled on `node:crypto`.** Lucia is archived and its author now
  recommends copying the code; the alternatives bring an adapter layer and a
  provider model that one email flow does not need. The surface is three
  functions and a service, all tested.
- **The magic link is returned in the API response under the console mail
  transport.** Gated on the transport, not `NODE_ENV`, because a console mailer
  is by definition not production. It is what makes the browser smoke test able
  to actually log in.
- **Postgres is on host port 5433.** 5432 is too often already taken by a local
  install, and the resulting "connects to the wrong database" failure is
  miserable to diagnose.
- **`npm audit` gates at `high`, not `moderate`.** The four moderate advisories
  as of M0 are all `drizzle-kit`'s dev-only transitive `esbuild`; drizzle-kit is
  a CLI run by hand, never a served dev server. Revisit when it drops the
  dependency.

## Open items blocking work (SPEC §3, owner: Dan)

These are not agent decisions. If a task needs one, say so and stop.

- Per-series rule details for Lemons / Lucky Dog / ChampCar — **blocks
  verifying any rule config, and blocks trusting any planner output.**
- Fall target race + date — drives the M1 cut line.
- Hosting choice (SPEC §6.4) — blocks CD.
- GPS logger make/model and format; IMU part; whether the car has OBD2 — M2/M3.
- YouTube account and default visibility; clapper time source — M2.
- Project name.

## Where to look next

- **The spec:** [`docs/SPEC.md`](docs/SPEC.md). Read §5 before building a
  feature and §6 before changing architecture.
- **Milestones and M1 task breakdown:** [`ROADMAP.md`](ROADMAP.md).
- **Data model:** `packages/db/src/schema.ts` is the source of truth; the
  `/data-model` skill covers the rules that aren't visible in it.
- **The role matrix:** `packages/domain/src/roles.ts`, exercised end to end in
  `apps/api/src/middleware/tenancy.test.ts`.
- **The fixture race:** `packages/domain/src/fixtures/eight-hour-race.ts` — the
  M1 planner's test bed, database-free by design.
