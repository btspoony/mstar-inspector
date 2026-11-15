# ADR: Make the lifecycle apply deterministic, and chunk its two halves separately

Status: implemented — retrospective: the derived apply ids and the separately chunked, doubly fenced apply shipped in `9977373b`, `7de6d75a` and `50b2328b`; this record was filed after the fact.
Spec: docs/specs/feature/review-lifecycle.md § 7.11.1 M8 publication and thread recovery

## Problem

Applying a confirmed publication is two different jobs in one recovery pass: writing the review artifact (`reviews` plus every `findings` row) and advancing the lifecycle rows (rounds, associations, the applied marker). One payload can be dozens of statements, D1 batches them in bounded chunks, and the whole apply runs under a publication lease that another invocation may replace mid-flight.

Two failure modes followed. A retry that keyed its writes on freshly generated ids either duplicated rows or, worse, skipped work: the pre-fix code composed the artifact only when no review row existed for the head, so a retry after a chunk boundary found the committed review, skipped composition, and never wrote the findings past the boundary. And a fence probed *before* a batch proves nothing about the writes inside it — a replacement landing between probe and write mutates rows under a lease the writer no longer holds.

## Decision

**The ids are derived, and each INSERT states its own dedup key.** The review row's id is the apply's idempotency key itself (`const reviewId = doc.key` in `src/store/artifact-store.ts`), and each finding's id is `<key>#<index>`. A retry therefore computes exactly the rows the previous attempt computed, so a repeat is a no-op — but the two inserts dedup on different keys: the review INSERT conflicts on the natural key `(installation_id, owner, repo, pr_number, head_sha)`, while the finding INSERT conflicts on `id`. That asymmetry is load-bearing: a finding resolves its review as `COALESCE((SELECT id FROM reviews WHERE <natural key>), <derived review id>)`, so a review written historically under a UUID keeps receiving findings, and a new head gets the derived id.

**The artifact is composed on every attempt.** `applyPublishedLifecycle` (`src/store/finding-lifecycle.ts`) calls `createArtifactStore().statementsFor(...)` unconditionally, with `guard: { sql: APPLY_LEASE_GUARD_SQL, binds: [...leaseGuard] }`. Composition is cheap; skipping it is what loses data.

**The two halves never share a chunk, and the artifact's chunks come first.** The apply emits `chunkStatements(artifactStatements, LIFECYCLE_APPLY_BATCH_STATEMENTS)` followed by `chunkStatements(lifecycleApplyBatch(...), LIFECYCLE_APPLY_BATCH_STATEMENTS)`, where `LIFECYCLE_APPLY_BATCH_STATEMENTS` is 25. A failed lifecycle chunk therefore leaves a complete, idempotent artifact that the next attempt no-ops; a failed artifact chunk is repaired because the next attempt recomposes it.

**Both halves carry the fence in the statement that writes.** `APPLY_LEASE_GUARD_SQL` is one predicate, re-checked inline by every mutating statement: the artifact receives it through `ArtifactPutOptions.guard` (`src/store/artifact-store.ts`), which turns the review INSERT into `INSERT … SELECT … WHERE <guard>` and gives every finding INSERT the same `WHERE <guard>` (a bare `WHERE 1` when no guard is passed); every lifecycle statement embeds it directly. A per-chunk `publicationLeaseIsLive` probe stops a long apply early, so a stale invocation does not spend its remaining chunks; the probe is an optimisation, never the fence. The applied marker is the final statement of the final chunk, under the same predicate.

## Alternatives considered

- **One ordered chunk list over both halves.** The list would not interleave anything — the artifact's statements lead and the lifecycle's follow. What changes is the batch: past the 25-statement bound a lifecycle statement shares a batch with artifact statements, so a fence failure there stops the apply with the finding set truncated in the same transaction, and nothing distinguishes that cause from an artifact failure. The split never puts the two halves in one batch, so a lifecycle fence failure cannot truncate the finding set, and each half replays on its own.
- **Keep the split but compose only when no review row exists (the pre-fix probe).** Repairing the probe does not make the retry correct by itself: a failure inside the artifact chunk still commits its leading statements, and it is the unconditional recomposition plus the derived ids that repairs them, not the presence check.
- **Always recompose but keep a generated review id.** The review INSERT would no-op on the natural key while the retry's second id names no row, so its findings either violate the foreign key or attach to nothing.
- **Generated finding ids.** `ON CONFLICT (id)` would never fire, so every attempt duplicates the findings it already wrote; a chunked apply cannot have unstable finding ids.
- **Probe the lease before each chunk and trust the probe.** A replacement or expiry between the probe and the write is invisible to it; only the predicate inside the mutating statement closes that window.
- **Mark applied first, then write.** A crash then leaves an "applied" marker over rows that do not exist — the one state recovery cannot repair.
- **Serialize applies behind a stronger lock.** D1 has no cross-invocation lock to take; the lease plus inline predicates is the available fence.

## Consequences

- A retry converges in both directions: a committed artifact is no-oped, a missing or partial one is completed, and findings past a chunk boundary are written on the next attempt.
- A replaced or expired lease aborts at the next statement, not at the next chunk, and can never mark the publication applied.
- The apply's per-statement cost rises by one `EXISTS` subquery per row; the alternative is a write that a stale holder can commit.
- Rows written by the artifact half before an aborted apply remain visible as a review with fewer findings until the retry completes — a state the retry repairs, never a phantom "applied". What a future change must not undo, and the tests that pin it, are recorded in [review lifecycle](../../../../docs/specs/feature/review-lifecycle.md) § 7.11.3.
- The ids are now part of the contract: a change to the derivation is a data-visible migration, not an internal refactor.
