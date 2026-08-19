# PitLog — Endurance Race Logging & Team Management Platform
**Specification v0.1 — Draft for review — 2026-08-19**

Working name "PitLog" is a placeholder. Rename at will.

---

## 1. Purpose

A logging and race-management platform for budget endurance racing (24 Hours of Lemons, Lucky Dog Racing League, ChampCar). Two halves:

1. **Team/pit-wall app** — stint and fuel planning, fuel-fill logging, expense capture and cost splitting, driver/crew coordination. This is the v1 product.
2. **Car-side data capture** — GPS (dedicated logger producing high-res GPX), high-resolution IMU, later OBD2/analog/voltage channels via ESP32 nodes, plus Insta360 X5 video. Data lands locally on the car, moves to the cloud service, and video ends up on YouTube time-synced to telemetry and laps.

Standalone codebase. Reuses HelmLog *patterns* (TDD, CI/CD, CLAUDE.md + skills, MQTT sensor architecture, agent workflow) but shares no code.

## 2. Decisions of record (from interview, 2026-08-19)

| Topic | Decision |
|---|---|
| Live car→pit telemetry | Not required for v1; architecture must allow evolving into it |
| Data offload from car | Undecided; spec recommends (see §6.3) |
| Weekend priorities | 1. Fuel/stint planning, 2. Expenses/logistics, 3. Video sync, 4. Lap analysis |
| v1 fuel data source | Manual fill logs + burn-rate model (no fuel sensor) |
| Lap times | Official timing (Race Monitor/RaceHero pull) **and** own GPS lap detection, cross-checked |
| Audience | Dan's team now; multi-team later. Design data model multi-tenant from day one, build single-tenant UX |
| Hosting | Undecided; spec recommends (see §6.4) |
| Expenses scope | Log expenses, split costs among drivers, receipt photo capture |
| Car channels (eventual) | GPS+IMU, OBD2 (if present), analog temps/pressures, battery voltage. **v1 ships GPS+IMU+voltage only**; OBD2/analog gated to M3 |
| Codebase | Standalone; HelmLog patterns only |
| Stint planner models | Fuel capacity + burn rate, driver min/max seat time, per-series pit/fueling rules, equal-seat-time fairness |
| Deadline | A race this fall (~6-10 weeks). Scope of v1 is cut accordingly |
| Video goal | YouTube uploads time-synced to telemetry/laps (deep link from a lap to its footage) |
| Team size | 2-4 drivers+crew per weekend |
| Pit devices | Mix of phones, tablet, laptop → responsive offline-capable web app (PWA) |

## 3. Open items (owner: Dan)

- [ ] GPS logger make/model and its GPX/log format
- [ ] IMU part number and interface
- [ ] Whether the race car has functional OBD2
- [x] Per-series rule details to encode: Lemons, Lucky Dog, ChampCar fueling/pit/driver rules.
      Read from the published rulebooks on 2026-08-19 and encoded in
      `config/series/*.yaml` with citations. Each config is `PARTIAL`: the fields
      listed in its `verified_fields` are checked, and the handful that the
      rulebooks simply do not address remain flagged on screen. **Which series
      the fall race runs under is still unstated**, and that decides which
      config the event should point at.
- [x] Fall target race + date — **29 August 2026**
- [x] Project name — **PitLog**
- [ ] YouTube channel/account to use; unlisted vs public default
- [ ] Clapper time source: own GPS module on the ESP32, or time sync from the car Pi (own GPS module keeps it usable when the Pi isn't installed)

## 4. Users and roles

- **Admin** — full control: team settings, users, series rule configs, delete/edit anything, expense settlement.
- **Crew** — operate race weekend: log fills, stints, laps notes, expenses, receipts; run the stint planner; edit their own entries.
- **Visitor** — read-only: live-ish weekend dashboard (stint schedule, standings, lap times), photos/video links. Intended for family/friends. Access via invite link; no PII beyond driver first names.

Team is the tenancy boundary. All data rows carry `team_id`. Auth: email magic-link or passkey (small team, no password resets at the track). Visitor links are token-scoped, revocable.

## 5. Functional requirements

### 5.1 Stint & fuel planner (v1 core)
- Inputs: race length, fuel capacity, burn rate (gal/hr, seeded manually, refined from logged fills + stint durations), driver roster with min/max seat time, per-series rule config, planned pit stop overhead, fairness weight.
- Output: stint schedule (who, when in/out, expected fuel state, fill amount per stop).
- **Live replanning**: during the race, actual stint start/end and fill volumes are logged; the plan re-solves from "now" — this is the killer feature. A yellow-flag "pit now?" what-if button re-solves with an immediate stop.
- Burn-rate model: rolling estimate from (fill volume ÷ engine hours since last fill), with per-driver adjustment factors once enough data exists. Show confidence/assumptions, never just a number.
- Rule configs are data, not code: YAML/JSON per series, versioned, editable by admin.

### 5.2 Race weekend logging (v1)
- One-tap event logging from any device: driver in / driver out / fuel fill (gallons + cost) / tire change or rotation / brake pad change / incident / black flag / note.
- Every entry timestamped, attributed, editable with history.
- Consumables tracking: tires (set ID, corners, laps on set), brake pads (laps/hours), oil.
- Works fully offline; syncs when connectivity returns (see §6.4).

### 5.3 Expenses (v1)
- Log expense: amount, category, payer, optional receipt photo, optional event association.
- Cost splitting: even split or custom shares per event; running "who owes whom" ledger with settle-up marks.
- Receipt photos stored with the expense; capture works offline.

### 5.4 Lap timing (M2)
- Ingest official timing via Race Monitor/RaceHero APIs during and after the race.
- Own lap detection from GPX (start/finish line crossing, track database of line coordinates).
- Cross-check view: flag disagreements > threshold; official timing is the source of truth for standings, GPS timing is the source of truth for telemetry alignment.

### 5.5 Car data capture (M2-M3)
- Pi is the car hub: ingests dedicated GPS logger output, IMU stream, later ESP32 sensor nodes over MQTT (HelmLog pattern: ESP32 + ADS1115 where analog).
- Local-first: everything written to on-car SQLite; nothing depends on connectivity.
- Time discipline: GPS time is the master clock. Pi syncs to it; IMU and sensor samples stamped against it. This is what makes video sync possible.
- v1 car install is minimal: GPS logger + camera + (if trivial) Pi passively logging IMU/voltage.

### 5.6 Video pipeline (M2)
- **Decision (2026-08-19): manual pipeline.** Automated Insta360 stitching was ruled out based on HelmLog experience (SDK/tooling bugs). Dan renders sessions in Insta360 tooling, uploads to YouTube manually, then links each video to a session in the app.
- **Linking UI**: paste YouTube URL → pick session → enter sync anchor (video timestamp of the clapper event) → app computes wall-clock↔video-time mapping.
- **Clapper device**: "race clapper" box — ESP32 + GPS time source (own GPS module or sync from Pi), bright LED, piezo buzzer, single button, 3D-printed enclosure. Button press emits LED flash pattern + beep sequence AND logs the exact GPS timestamp as a `clapper` log_entry. Dual light+sound signal so the anchor is findable whether or not the lens faces the operator. One clap at stint start standard; optional second clap at stint end for X5 clock-drift correction (two-point linear fit). Manual ±nudge control in the linking UI as fallback.
- Zero-hardware fallback: three raps on the roll bar, correlated between IMU spikes and video shake/audio — supported but secondary.
- Product surface: from any lap or logged event, "watch" deep-links to the YouTube timestamp. No auto-highlights or overlays in this milestone.

### 5.7 Live telemetry (M4, deferred)
- LTE modem on car publishing a low-rate MQTT summary (position, lap, voltage, temps) to the cloud broker. Architecture (MQTT topics, message schemas) is designed now so this bolts on without rework.

## 6. Architecture

### 6.1 Shape
Three components:
1. **Cloud service** — API + web app + Postgres + object storage (receipts, later media manifests). Multi-tenant schema.
2. **Pit clients** — the same web app as a PWA: offline-first, local store (IndexedDB), background sync. No native apps.
3. **Car node** — Pi + sensors, local SQLite, offload job.

### 6.2 Stack — selected in M0, criteria fixed here
Language/framework left open deliberately; the bootstrap agent evaluates candidates and Dan approves. Selection criteria, in priority order:
1. **Agent ergonomics** — heavily represented in model training data, strong typing, fast feedback loops (tests, typecheck), mainstream tooling. Agents will write most of this code.
2. **Well understood and supported** — large community, stable governance, boring failure modes.
3. **Evolvable over cutting-edge** — clear migration paths, modular boundaries (planner solver, sync layer, and rule engine must be swappable without a rewrite). Cutting-edge is acceptable where it doesn't mortgage evolvability.
4. **Fit** — offline-first PWA client, small multi-tenant API, Postgres, 2-4 concurrent users.
Constraints regardless of choice: strictly typed, Postgres + migration tooling, Docker Compose local dev, offline sync per the design below. Car-side remains Python (M2+), independent of the app stack.
- Offline sync: start dumb — client-generated UUIDs, append-mostly event log, last-write-wins on edits, explicit conflict surfacing for the rare collision (2-4 users; conflicts will be rare). Do not adopt a CRDT framework in v1.
- UI: pit-mode screens designed for gloves-and-sunlight — huge tap targets, dark/light auto, one-tap logging front and center. "Intuitive and attractive" gets its own design pass milestone, not an afterthought.

### 6.3 Getting data off the car (recommendation)
Phased:
- **v1 (fall race)**: none needed — pit app data is entered pit-side; GPX/video pulled by SD card after sessions.
- **M2**: paddock sync — car Pi joins a phone-hotspot or paddock WiFi when parked, pushes deltas (rsync/HTTP) to cloud. Zero moving parts during the race.
- **M4**: LTE modem for live low-rate telemetry. Bulk data still syncs in the paddock; cell coverage at club tracks is too unreliable to depend on for anything critical.

### 6.4 Hosting (recommendation)
- **Managed cloud, small footprint**: Fly.io or Railway — app + managed Postgres + S3-compatible object storage (Cloudflare R2 for receipts/photos). Rationale: 2-4 users, spiky weekend load, you don't want to be doing VPS ops from a paddock. Cost ~$10-25/mo.
- Offline-first PWA means a cloud outage during a race degrades to "sync later," not "planner dead" — this is the real availability strategy.
- Escape hatch: everything in Docker Compose so it can move to a VPS or home server later. No provider-proprietary services beyond Postgres/S3 APIs.

### 6.5 Data model (first cut)
`teams, users, memberships(role), series, rule_configs, events(race weekend), sessions(practice/quali/race), drivers, stints, fuel_fills, laps(source: official|gps), consumable_sets(tires/pads), consumable_events, expenses, receipts, expense_shares, media_assets(youtube_id, t0, duration), telemetry_files(gpx/imu manifests), log_entries(generic timestamped events)`

Laps carry both sources with a reconciliation view; telemetry stays in files/columnar blobs referenced by manifests, not row-per-sample in Postgres.

## 7. Development process

Modeled on HelmLog:
- Git repo, trunk-based, PRs even solo; CI runs tests + lint + typecheck on every push; CD to a staging env, tagged releases to prod.
- TDD for planner logic especially — the stint solver and burn-rate model get exhaustive unit tests with fixture races before any UI exists.
- `CLAUDE.md` + skills directory: project conventions, data model, series rule schemas, "how to add a sensor," "how to add a series." Agents in parallel worktrees as with HelmLog.
- Seed/fixture data: a synthetic 8-hour race with known-good stint solutions, for tests and UI development.

## 8. Roadmap

**M0 — Foundations (now → ~2 wks)**
Repo, CI/CD, CLAUDE.md, schema migration setup, auth + roles, team/event scaffolding. Fill in §3 open items.

**M1 — Fall race MVP (→ target race)**
Stint/fuel planner with live replanning; fill/stint/consumable/incident logging; expenses + receipts + splitting; offline PWA sync; visitor dashboard (basic). Car side: GPS logger + camera physically installed, no integration. **Cut line: anything not on this list waits.**

**M2 — Winter: data + video**
GPX/IMU ingest, track DB + GPS lap detection, Race Monitor ingest + cross-check, video batch pipeline + lap deep links, paddock sync from Pi. Design-polish pass on UI.

**M3 — Spring: car sensors**
ESP32/MQTT nodes: voltage, brake/coolant temps, pressures; OBD2 if the car has it. Burn-rate model upgraded with engine-hours from telemetry.

**M4 — Later**
LTE live telemetry, multi-team onboarding, auto-highlight video candidates (IMU spikes → clips).

## 9. Risks

1. **Fall deadline** — the race is **29 August 2026**. This was written expecting
   6-10 weeks and turned out to be days, not weeks; M1 is complete and merged,
   so the risk is no longer scope but confidence. First real-race use should
   still assume paper backup for stint planning, and the plan screen names
   every rule value that has not been checked against a rulebook.
2. **Video pipeline labor** — manual render/upload is a known-working path (per HelmLog experience) but costs Dan hours per weekend; acceptable trade. Clapper box is a small hardware build (ESP32 + GPS + LED + piezo + printed case) that should land in M2 alongside the linking UI.
3. **Track connectivity** — assume none. Everything critical must work offline; sync is a bonus.
4. **Timing API access** — Race Monitor/RaheHero API terms/availability for the specific series need verification before M2.
5. **Solo-maintainer bus factor** — Docker Compose portability + docs so the team isn't stranded if hosting or you are unavailable mid-season.
