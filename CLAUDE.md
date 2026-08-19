# CLAUDE.md — PitLog

The canonical project guide for all agents (human or AI) lives in `AGENTS.md`.
It is imported here so Claude Code loads it as project instructions:

@AGENTS.md

Everything in `AGENTS.md` applies. The rest of this file is **only** the
Claude-Code-specific mechanics that implement or extend those rules — keep
project conventions in `AGENTS.md`, not here.

## Claude Code specifics

- **Worktrees.** `AGENTS.md`'s "work in a git worktree when agents run in
  parallel" rule is implemented here via the **`EnterWorktree`** tool: check
  `git worktree list` and `ls .claude/worktrees/` first, enter an existing
  worktree if the branch matches the task, otherwise create a new one.
  Read-only work doesn't need one.

- **Skills.** The harness lists available skills each session; invoke them with
  the Skill tool (`/name`). The ones that back rules in `AGENTS.md`:
  - `/data-model` — the SPEC §6.5 entities, the tenancy rule, and which table
    to reach for. Read before writing any query.
  - `/series-rules` — the rule-config schema and how to add or verify a series.
  - `/offline-sync` — the v1 sync design (client UUIDs, append-mostly log, LWW,
    conflict surfacing) and the traps it exists to stop you falling into.
  - `/new-migration` — Drizzle migration mechanics and the worktree collision
    hazard.
  - `/tdd` — PitLog test patterns and the anti-rationalization table.

- **Memory.** File-based memory persists across sessions under
  `~/.claude/projects/-Users-dweatbrook-src-pitlog/memory/`, indexed by
  `MEMORY.md`. Save durable facts there (user prefs, project state, external
  references); don't restate what the repo, `docs/SPEC.md`, or `AGENTS.md`
  already records.
