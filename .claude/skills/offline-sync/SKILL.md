---
name: offline-sync
description: PitLog's v1 offline sync design — client-generated UUIDs, an append-mostly log, last-write-wins on the client clock, and explicit conflict surfacing — plus the traps it exists to prevent (server-clock LWW, hard deletes, CRDTs, auto-merge). TRIGGER when building or changing anything that writes data from the pit client, the sync queue, the IndexedDB store, or a mutation endpoint. DO NOT trigger for read-only views, server-side jobs, or car-side ingest.
---

# Offline sync — v1 design

SPEC §6.2: **"start dumb — client-generated UUIDs, append-mostly event log,
last-write-wins on edits, explicit conflict surfacing for the rare collision.
Do not adopt a CRDT framework in v1."**

The constraint that makes "dumb" correct: 2–4 people, one pit box, one car.
Genuine concurrent edits to the same row are rare, and when they happen a human
standing three feet away can resolve them. Engineering for automatic
convergence would cost weeks and buy nothing before the fall race (SPEC §9).

**Connectivity at a track is assumed absent, not flaky.** Offline is the normal
case; sync is the bonus.

## The four rules

### 1. The client generates ids

Every syncable row has a `uuid` primary key created on the device. A phone with
no signal must be able to log a fuel fill, get an id back, attach a receipt
photo to it, and render it — all before the server has ever heard of it.

Never use a database-side default for a syncable `id`. Never renumber on the
server. An id assigned offline is the permanent id.

### 2. Writes are an append-mostly log

`log_entries` is the raw stream: "someone tapped this kind of button at this
instant". The structured tables (`stints`, `fuel_fills`, `laps`, …) are the
queryable projection.

Prefer appending a new entry over mutating an existing row. An append never
conflicts. Reserve edits for genuine corrections ("that fill was 12.4 not 14.2"),
which is exactly the rare case LWW is for.

### 3. Last write wins — on the *client* clock

The comparator is **`client_updated_at`**, taken from the writing device.

**Never use `server_updated_at`.** It is a receipt stamp. Using it means a
correction typed at 14:02 offline and synced at 18:30 silently overwrites one
typed at 17:00 online. That is the exact failure this design has to avoid, and
it is the most tempting shortcut in the codebase.

Ties break on `updated_by` (lexicographic on the uuid) so every device
independently reaches the same winner.

Device clocks drift. That is acceptable here: the cost of a wrong winner is one
wrong number that a human notices, and rule 4 makes sure they do.

### 4. Conflicts are surfaced, never silently merged

When a write loses, the losing value is **not** discarded quietly. Record it and
show it: "Kim's phone also set this fill to 14.2 at 14:02. Yours won." The
person who typed the losing value must be able to see that it lost.

Never auto-merge field-by-field. Two half-applied edits produce a row neither
person entered, which is worse than either.

## Explicitly out of scope for v1

- **CRDTs / Yjs / Automerge.** Ruled out by SPEC §6.2. Do not introduce one.
- **Operational transform.** Same.
- **Vector clocks / causal ordering.** LWW plus a tie-break is the design.
- **Optimistic concurrency tokens / rejecting stale writes.** A pit client that
  has been offline for six hours is *always* stale. Rejecting its writes is the
  same as losing them.
- **Background conflict resolution by heuristics.** Humans resolve; software
  surfaces.

If a task seems to need one of these, that is a signal the requirement changed —
raise it against SPEC §6.2 rather than building it.

## Deletes

Soft only. `deleted_at` is set; the row stays. A hard delete cannot be replayed
onto a device that never saw the row, and it destroys the evidence needed to
surface a delete-vs-edit conflict.

Every ordinary read filters `isNull(table.deleted_at)`. History and conflict
views deliberately do not.

## Where the pieces live

| Concern | Location |
|---|---|
| Sync column contract on every table | `packages/db/src/schema.ts` (`syncColumns`), asserted in `schema.test.ts` |
| Queue + merge contract | `packages/sync` (M1) |
| Client store (IndexedDB) | `apps/web` (M1) |
| Server-side apply | `apps/api/src/routes` (M1) |

`packages/sync` is framework-free on purpose: the merge rule is pure logic over
two rows and a comparator, so it is TDD-able in milliseconds with no browser and
no database. **Write the merge tests before the merge.** Cases that must exist:

- remote newer than local → remote wins
- local newer than remote → local wins
- equal `client_updated_at`, different `updated_by` → deterministic winner, same
  on both sides
- delete vs edit → the later `client_updated_at` wins; a losing delete is
  surfaced, not dropped
- a row the server has never seen → insert, never an error
- a replayed write (same id, same `client_updated_at`) → idempotent no-op

## Receipts and photos

Binary capture works offline (SPEC §5.3). The `receipts` row syncs immediately
with `upload_state: 'pending'` and a null `storage_key`; the blob is uploaded
later and the row updated. The expense is complete and splittable before the
photo ever leaves the phone — never block an expense on an upload.
