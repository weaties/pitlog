# PitLog

Endurance-racing logging and race-management platform for budget endurance
series (24 Hours of Lemons, Lucky Dog, ChampCar).

**The specification is the source of truth: [`docs/SPEC.md`](docs/SPEC.md).**
Agents and contributors start at [`AGENTS.md`](AGENTS.md).
Milestones and open work: [`ROADMAP.md`](ROADMAP.md).

## Bootstrap

Requires **Node 22+**, **npm 10+**, and **Docker** (for local Postgres).

```bash
git clone git@github.com:weaties/pitlog.git
cd pitlog
make dev
```

`make dev` is the one documented bootstrap sequence. It copies `.env.example`
to `.env` if needed, installs dependencies, starts Postgres in Docker and waits
for it to be healthy, applies migrations, seeds a demo team and the synthetic
8-hour fixture race, and runs the API and web app together.

Then open <http://localhost:5173>. Magic-link emails are printed to the API
console in local dev (`MAIL_TRANSPORT=console`) — copy the link from the
terminal to sign in.

| Command | What it does |
|---|---|
| `make dev` | Full bootstrap, then run api + web |
| `make run` | Run api + web without re-bootstrapping |
| `make check` | Typecheck, lint, unit tests — what CI runs minus the browser test |
| `make test` | Unit tests (Vitest) |
| `make e2e` | Browser smoke tests (Playwright) |
| `make seed` | Reset + reseed the database |
| `make nuke` | Stop Postgres and delete its data volume |
| `make help` | Everything else |

## Layout

```
apps/web/          React + Vite SPA, installable PWA — the pit client
apps/api/          Hono JSON API — auth, tenancy, persistence
packages/domain/   Framework-free domain: roles, entities, series rule configs
packages/db/       Drizzle schema, migrations, seed, fixture race
packages/sync/     Offline sync contract (client UUIDs, append log, LWW)
config/series/     Per-series rule configs — all UNVERIFIED, see SPEC §3
docs/SPEC.md       Source of truth
```

## Status

**M0 — foundations.** No planner, no offline sync implementation, no car-side
code, no deploy. See [`ROADMAP.md`](ROADMAP.md).
