/**
 * The offline sync contract — SPEC §6.2, M1 Phase 2.
 *
 * Framework-free on purpose: the merge rule is pure logic over two rows and a
 * comparator, so it is TDD-able in milliseconds with no browser and no
 * database. `apps/web` owns the IndexedDB store, `apps/api` owns the apply
 * endpoint; both depend on the rule defined here, and neither defines its own.
 *
 * See `.claude/skills/offline-sync/SKILL.md` for the design and the traps it
 * exists to prevent — above all: the comparator is `client_updated_at`, never
 * `server_updated_at`.
 *
 * This package is scaffolding until #20 lands the merge. Nothing imports it
 * yet, deliberately: the merge tests are written before the merge.
 */

/**
 * Bumped when the wire shape of a sync batch changes incompatibly. A pit
 * client that has been offline for a weekend may be a version behind, and the
 * server needs to say so rather than misparse the batch.
 */
export const SYNC_PROTOCOL_VERSION = 1
