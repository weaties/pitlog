# PitLog roadmap

Milestones are from [`docs/SPEC.md`](docs/SPEC.md) §8. The spec is the source of
truth; this file tracks what is done and breaks M1 into task-sized pieces.

**Deadline pressure is real.** SPEC §9 puts the fall race 6–10 weeks out and
names the planner solver as the only hard part. M1's cut line is deliberate:
anything not on the M1 list waits, whatever it costs in polish.

---

## M0 — Foundations ✅

Repo, CI, agent docs, schema, auth, fixture data.

- [x] Stack evaluated against SPEC §6.2 and approved; decision + losing
      candidates' dealbreakers recorded in `AGENTS.md` → Decisions
- [x] Monorepo scaffold: npm workspaces, strict TypeScript, Biome, Vitest,
      Playwright, Tailwind v4, Docker Compose Postgres
- [x] `make dev` — one documented bootstrap: env, install, up, migrate, seed, run
- [x] CI: typecheck, lint, unit, browser smoke, high-severity audit on every
      push and PR; PR-required trunk-based flow
- [x] CD stubbed with a TODO (**blocked on the SPEC §6.4 hosting decision**)
- [x] `AGENTS.md` + `CLAUDE.md` + skills (`data-model`, `series-rules`,
      `offline-sync`, `tdd`, `new-migration`)
- [x] Schema v1 — all SPEC §6.5 tables, `team_id` on every domain table,
      enforced by a test rather than a convention
- [x] Series rule config schema + three shipped configs, all `UNVERIFIED`
- [x] Magic-link auth + role middleware, role matrix tested exhaustively
- [x] Synthetic 8-hour fixture race with a known-good stint solution
- [x] Seed script

**Not done in M0, by design:** no planner solver, no offline sync
implementation, no car-side code, no video linking UI, no deploy.

---

## M1 — Fall race MVP

**Target: the fall race (SPEC §3 open item — date not yet set).**

Cut line from SPEC §8: stint/fuel planner with live replanning; fill / stint /
consumable / incident logging; expenses + receipts + splitting; offline PWA
sync; basic visitor dashboard. Car side is physical install only, no
integration.

### Planner — the hard part (SPEC §5.1)

The solver, the models behind it, and live replanning are done and live in
`packages/domain`, database-free and browser-free. What is left here is the UI
(#7, #10), which waits on the offline read path.

**Nothing below changes the standing warning:** every shipped rule config is
still UNVERIFIED, so the numbers a plan produces are structurally correct and
factually unconfirmed. The solver reports which fields are guesses; #7 is what
puts that on screen.

- [x] **Burn-rate model.** Rolling estimate from (fill volume ÷ elapsed since
      last full tank). Only `filled_to_full` fills are datapoints. Returns an
      estimate *with* a confidence and the inputs it used — never a bare number. — #3
- [x] **Per-driver burn adjustment.** Applies `drivers.burn_rate_factor` once
      there is enough data to justify one; states when there is not. — #4
- [x] **Stint solver v1.** Inputs: race length, fuel capacity, burn rate, driver
      roster with min/max seat time, rule config, pit overhead, fairness weight.
      Output: who, when in/out, expected fuel state, fill volume per stop.
      Must reproduce `KNOWN_GOOD_SOLUTION` exactly on the fixture race. — #5
- [x] **Rule-config enforcement in the solver.** Consumes `pit`, `fueling`, and
      `driver` constraints as data. No `switch` on `series_key`. — #6
- [ ] **UNVERIFIED banner.** Any plan built on a config with unverified fields
      says so on screen, listing which inputs are guesses (SPEC §5.1). — #7
- [x] **Live replanning.** Re-solve from "now" against logged actuals. — #8
- [x] **"Pit now?" what-if.** Re-solve with an immediate stop, show the delta
      against the current plan. — #9
- [ ] **Planner UI.** Schedule view, per-stop fill volumes, assumptions panel. — #10

### Race-weekend logging (SPEC §5.2)

- [ ] **One-tap log screen.** Driver in / out, fuel fill, tire change, tire
      rotation, brake pad change, incident, black flag, note. Gloves-and-sunlight
      sizing — nothing below the `--spacing-tap` minimum. — #11
- [ ] **Fuel fill entry.** Gallons + cost + `filled_to_full`, feeding the
      burn-rate model. — #12
- [ ] **Stint start/end capture,** wired to the planner's actuals. — #13
- [ ] **Edit with history.** Every entry attributable and editable; the previous
      value stays visible. — #14
- [ ] **Consumables tracking.** Tire sets and pads: laps and hours on set. — #15

### Expenses (SPEC §5.3)

- [ ] **Expense entry** — amount (integer cents), category, payer, optional
      event association. — #16
- [ ] **Receipt photo capture,** working offline; row syncs before the blob. — #17
- [ ] **Cost splitting** — even split or custom shares; shares must sum to the
      parent expense. — #18
- [ ] **Who-owes-whom ledger** with settle-up marks (admin only). — #19
- [ ] **Object storage for receipt blobs** — *blocked on SPEC §6.4* (Cloudflare
      R2 is the recommendation). — #17

### Offline sync (SPEC §6.2)

See the `offline-sync` skill for the design and its guardrails.

- [ ] **`packages/sync` merge logic**, TDD'd with no browser or database:
      remote-newer, local-newer, tie-break, delete-vs-edit, unseen row, replay. — #20
- [ ] **IndexedDB local store** in `apps/web`. — #21
- [ ] **Outbound queue** with retry; a write made offline survives a reload. — #22
- [ ] **Server-side apply endpoint** honouring LWW on `client_updated_at`. — #23
- [ ] **Conflict surfacing UI** — the losing value is shown, never discarded
      silently. — #24
- [ ] **Service worker shell caching**; API responses are never SW-cached. — #25

### Visitor dashboard (SPEC §4)

- [ ] **Token-scoped visitor links** — create, label, revoke. — #26
- [ ] **Read-only weekend view:** stint schedule, lap times, standings. — #27
- [ ] **First names only.** No PII beyond driver first names in any
      visitor-facing response. — #27

### Auth + team management

- [ ] **SMTP mail transport** (console-only in M0). Needs a sending domain —
      *touches the SPEC §6.4 hosting decision.* — #28
- [ ] **Invite flow** — admin invites by email with a role. — #29
- [ ] **Team settings + driver roster CRUD** (admin). — #30

M1 tasks are tracked as GitHub issues (#3–#30), labelled by area. `gh issue list --label M1`.

### Blocking open items (SPEC §3, owner: Dan)

- [ ] **Per-series rule values for Lemons / Lucky Dog / ChampCar.** Until these
      are read from rulebooks, every planner output is built on placeholders.
      **This is the highest-value unblock in M1.**
- [ ] **Fall target race + date** — sets the cut line.
- [ ] **Hosting decision** (SPEC §6.4) — unblocks CD, SMTP, and receipt storage.
- [ ] Project name.

---

## M2 — Winter: data + video

- [ ] GPX + IMU ingest into `telemetry_files`
- [ ] Track database (start/finish line coordinates) + GPS lap detection
- [ ] Race Monitor / RaceHero ingest — **verify API terms and availability
      first** (SPEC §9 risk 4)
- [ ] Official-vs-GPS cross-check view; the fixture race already carries one
      planted disagreement past threshold
- [ ] YouTube linking UI: paste URL → pick session → sync anchor → wall-clock ↔
      video-time mapping, with a manual ±nudge
- [ ] Clapper box (ESP32 + GPS time + LED + piezo + printed case) and its
      `clapper` log entries
- [ ] Deep link from a lap or logged event to its YouTube timestamp
- [ ] Paddock sync from the car Pi
- [ ] Design-polish pass on the UI (SPEC §6.2 gives this its own milestone)

## M3 — Spring: car sensors

- [ ] ESP32 / MQTT nodes: battery voltage, brake and coolant temps, pressures
- [ ] OBD2 if the car has it (SPEC §3 open item)
- [ ] Burn-rate model upgraded with engine hours from telemetry

## M4 — Later

- [ ] LTE live telemetry (low-rate MQTT summary)
- [ ] Multi-team onboarding (the schema is already multi-tenant)
- [ ] Auto-highlight video candidates from IMU spikes
