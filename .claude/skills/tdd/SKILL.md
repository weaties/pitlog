---
name: tdd
description: PitLog test patterns and the anti-rationalization table. The Red-Green-Refactor cycle itself is already mandated in AGENTS.md — this skill encodes only the project-specific patterns (dependency injection over database fixtures, invariant tests, the exact-answer fixture race) and the excuses for skipping the cycle. TRIGGER when writing or modifying code in packages/ or apps/api/src/. DO NOT trigger for documentation, YAML config, CI workflow files, or styling-only changes.
---

# TDD — PitLog patterns

AGENTS.md already mandates: **failing test → implement → green → lint.** This
skill encodes only the bits that aren't obvious from reading the existing tests.

## Patterns

**Unit tests never touch a database or a browser.** Inject the dependency
instead. The tenancy gates take a `MembershipResolver` precisely so the whole
role matrix can be tested with a plain object:

```ts
function resolverFor(memberships: Partial<Record<string, Role>>): MembershipResolver {
  return async (userId, teamId) => { /* … */ }
}
```

The real query is exercised once, by the browser smoke test. Do not stand up
Postgres to test a rule about roles.

**API route tests drive Hono in-process** — no port, no network:

```ts
const res = await app.request(`/teams/${TEAM}/thing`)
expect(res.status).toBe(403)
```

**Test the invariant, not the instance.** `packages/db/src/schema.test.ts`
asserts that *every* domain table carries `team_id`, enumerated from the schema
module, rather than listing the tables that do. A new table cannot quietly skip
the rule. When you add a cross-cutting requirement, write the test that way.

**The fixture race is the planner's test bed** (SPEC §7). Its numbers are chosen
so the correct answer is exact — 6 stints × 75 min + 5 stops × 6 min = 8 h to
the second, 3 drivers × 2 stints = perfectly equal seat time. Assert **equality**
on seat time and stint boundaries, not tolerance. A planner that is "close" on
fairness is wrong.

Import it from `@pitlog/domain`; it has no database dependency:

```ts
import { EIGHT_HOUR_RACE, KNOWN_GOOD_SOLUTION } from '@pitlog/domain'
```

**Determinism is a test requirement.** `generateFixtureLaps()` uses a seeded
Mulberry32 PRNG, not `Math.random()`, and there is a test asserting two calls
are identical. Any new fixture data follows the same rule — a fixture that
differs per run cannot be a known-good answer.

**Browser tests are thin.** `tests/e2e/` proves the app boots, login works, and
the shell renders. Behavioural depth belongs in Vitest, which runs in under a
second.

## What must be TDD'd

Logic, always: the stint planner, the burn-rate model, the sync merge, the rule
engine, expense splitting, the role gates, anything that computes a number a
human will act on at 3am.

Exempt: scaffolding, config files, CI workflows, Tailwind classes, route wiring
that only calls into tested code.

## Don't rationalize skipping the cycle

The cycle only helps if you don't talk yourself out of it.

| Rationalization | Rebuttal |
|---|---|
| "This change is too small to need a test." | Size predicts neither breakage nor regression. The failing test is what proves the change does what you think. |
| "I'll write the test after I see it work." | Test-after rationalizes whatever the code already does, bugs included. |
| "It's just a route handler — I'll eyeball it." | Route handlers are the easiest place to ship a silent 500 or a missing `team_id` filter. `app.request()` costs you three lines. |
| "Testing this properly needs a database." | Then the dependency is in the wrong place. Inject it. That is why `MembershipResolver` exists. |
| "Tests pass, so it's correct." | Passing tests are evidence, not proof. Confirm the test would actually fail without your change — if you didn't see it red, you don't know. |
| "The planner is close enough on fairness." | The fixture race has an exact answer on purpose. "Close" means a driver gets short-changed on seat time at a real race. |
| "I'll use `Math.random()` in the fixture, it's only test data." | Then the known-good solution isn't known. Seed the PRNG. |
| "Lint is noisy here, I'll skip the gate." | There is no pre-existing-error allowlist in this repo and there must never be one. Zero, always. |
| "I'll add the `team_id` filter in a follow-up." | That follow-up is a data leak across a tenancy boundary. Do it now. |

## Running things

```bash
make test        # vitest, sub-second
make e2e         # playwright; needs make up && make migrate && make seed first
make check       # typecheck + lint + test — the pre-PR gate
npx vitest packages/domain   # watch one package while iterating
```

There is **no pre-existing-error allowlist** in this repo, deliberately (see
AGENTS.md → Decisions). If lint or typecheck is red, fix it.
