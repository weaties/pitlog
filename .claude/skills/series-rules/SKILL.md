---
name: series-rules
description: The per-series rule-config schema (fields, constraints, verification status) and the procedure for adding a new series or verifying an existing one. Encodes the never-guess discipline: the shipped Lemons/Lucky Dog/ChampCar configs were read from the rulebooks on 2026-08-19 and are PARTIAL, and the fields still unverified must never be filled in from memory. TRIGGER when touching config/series/*.yaml, packages/domain/src/series-rules.ts, the rule_configs table, or any planner code that consumes rule values. DO NOT trigger for unrelated schema work or UI changes.
---

# Series rule configs

SPEC §5.1: **rule configs are data, not code.** They are YAML on disk for the
shipped defaults (`config/series/*.yaml`) and versioned JSON rows in
`rule_configs` once an admin edits them. One schema governs both, in
`packages/domain/src/series-rules.ts`.

## Where the shipped configs actually stand

All three were read from the published rulebooks on **2026-08-19** and carry a
`verification.source` naming the sections. All three are **PARTIAL**, not
VERIFIED: a few fields the rulebooks simply do not address are still unverified
and still show on the plan.

They differ in ways that change a schedule, which is the whole reason these are
data and not code:

| | Lemons | Lucky Dog | ChampCar |
|---|---|---|---|
| minimum stop | none | 5 min | 5 min (fuel stops, pit-in to pit-out) |
| driver change during fuelling | no | no | **yes** |
| max stint | none | 2 h | 2 h |
| rest between stints | none | 60 min | 60 min |
| min drivers | 2, 3 from 24 h | per event pack | 2 / 3 / 4 by length |

## `null` means "no such rule"

A null is a **checked answer**, not a blank waiting to be filled. Lemons imposes
no minimum stop and no stint limits at all; writing 1800 there would make the
planner refuse legal Lemons schedules. If you find a null and think it looks
unfinished, read the rulebook before touching it.

## The never-guess discipline — read this first

**SPEC §3 lists per-series rule details as an OPEN ITEM owned by Dan. Nobody
has read the rulebooks yet.** Every value in every shipped config is a
structurally-valid placeholder that exists so the schema, migrations, and
planner plumbing can be built and tested.

Therefore:

- **Do not invent rule values.** Not "a reasonable minimum stop time", not
  "what Lemons probably requires". A plausible wrong number is worse than an
  obvious placeholder, because it will be believed.
- **Do not change `verification.status` without a `source`.** The status is a
  claim that someone read a rulebook.
- **The planner must surface `unverifiedFields()`.** SPEC §5.1 requires showing
  assumptions, never a bare number. A schedule built on placeholders has to say
  so on screen.

If a task needs real rule values, that task is blocked on SPEC §3. Say so.

## Schema shape

`parseSeriesRules(yamlOrObject)` throws a `ZodError` on anything malformed —
configs are small and hand-edited, so failing loudly beats coercing. The object
is `.strict()`, so a typo in a field name is an error rather than a silently
ignored key.

```yaml
schema_version: 1        # must equal SERIES_RULES_SCHEMA_VERSION
series_key: lemons       # lowercase alnum slug; matches filename AND series.key
display_name: 24 Hours of Lemons
config_version: 1        # bump on every edit; rule_configs keeps history per version

verification:
  status: UNVERIFIED     # UNVERIFIED | PARTIAL | VERIFIED
  source: null           # citation once checked
  checked_at: null       # YYYY-MM-DD
  verified_fields: []    # dotted paths, only meaningful for PARTIAL

pit:
  min_stop_seconds:              # > 0
  engine_off_for_fueling:        # bool
  driver_in_car_during_fueling:  # bool
  driver_change_during_fueling:  # bool
  max_crew_over_wall:            # int > 0 or null

fueling:
  max_fuel_capacity_gallons:     # > 0 or null — series cap, not the car's tank
  refuel_allowed_under_yellow:   # bool
  fuel_can_only:                 # bool
  max_can_size_gallons:          # > 0 or null

driver:
  min_stint_seconds:             # > 0, or null where the series imposes none
  max_stint_seconds:             # >= min_stint_seconds when both are set
  max_consecutive_stint_seconds: # > 0
  min_rest_seconds:              # > 0, or null. Time out of the car between
                                 # stints. Binds hard on a two-driver entry.
  min_drivers_per_event:         # a list of tiers, because every series makes
                                 # this a function of race length:
                                 #   - min_race_hours: 0
                                 #     drivers: 2
                                 #   - min_race_hours: 9
                                 #     drivers: 3
                                 # Read longest-first by minDriversForRace().
  max_share_of_race:             # fraction in (0, 1]
```

Two subtleties in the implementation worth not undoing:

- `verification` uses zod's **`.prefault({})`, not `.default({})`** — in zod 4
  `.default()` bypasses parsing, so the nested per-field defaults would never
  apply and `status` would come back `undefined`.
- `driverFields` is a standalone object literal because `driverSchema` is
  wrapped by `.refine()`, and a refined schema has no `.shape` to enumerate for
  `RULE_FIELD_PATHS`.

## Adding a series

1. **Create `config/series/<key>.yaml`.** `<key>` is a lowercase alphanumeric
   slug and must equal `series_key` and the filename stem. Copy an existing
   file including its "!!! UNVERIFIED !!!" header — that header is load-bearing
   documentation, not boilerplate.
2. **Keep `status: UNVERIFIED`** unless you have actually read the rulebook.
   A search result, a forum post, or a summary of one is not a rulebook.
3. **Register it in the seed:** add the key to `SERIES_KEYS` and give it a
   `SERIES_IDS` and `RULE_CONFIG_IDS` entry in `packages/db/src/seed-data.ts`.
   Ids are fixed UUIDs so reseeding is deterministic.
4. **Update the shipped-set assertion** in
   `packages/domain/src/series-rules.test.ts` — it asserts the exact filename
   list on purpose, so a new series cannot appear without someone noticing.
5. `make seed`, then `make check`.

No code changes are needed anywhere else. If you find yourself adding a
`switch` on `series_key`, that is the rule engine leaking into code — put the
difference in the config schema instead.

## Verifying a series

1. Read the current rulebook. Cite it.
2. Replace the placeholder values.
3. Fill `verification.source` (URL or document + revision) and `checked_at`.
4. List the dotted paths you actually checked in `verified_fields`, and set
   `status: PARTIAL`. Only use `VERIFIED` when **every** field in
   `RULE_FIELD_PATHS` has been confirmed.
5. Bump `config_version`.
6. `make seed`. The `verification_status` column on `rule_configs` is
   denormalised from the blob so the UI can badge a config without parsing it —
   reseeding keeps them in step.

## Adding a rule *field*

Adding a field changes the contract for every series at once:

- Add it to the right sub-schema in `series-rules.ts`. It is automatically
  picked up by `RULE_FIELD_PATHS` and therefore by `unverifiedFields()`.
- Add it to **all three** shipped YAML files, or `.strict()` parsing of the
  others still passes but `unverifiedFields()` starts reporting a field nobody
  has heard of. Prefer a nullable field with a `null` placeholder over inventing
  a default.
- Bump `SERIES_RULES_SCHEMA_VERSION` **only** if the change is
  backwards-incompatible with configs already stored in `rule_configs`. Adding
  an optional/nullable field is not.
