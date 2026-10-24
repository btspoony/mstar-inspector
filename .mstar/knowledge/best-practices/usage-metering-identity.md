# Usage metering identity — mint it from the ledger, never from the queue

A review ledger answers "how many review executions did this tenant start". Three plausible identity sources are wrong, and each fails in a different way.

## 1. The queue delivery counter is not an execution

A queue message can be re-delivered because an in-flight guard held it, because the runtime retried after a crash, or because a duplicate webhook arrived. `message.attempts` counts deliveries. A guard-held delivery has not started a review, so metering on it inflates the tenant's bill for work that never ran.

**Rule:** an attempt is minted where the execution actually begins, never from a delivery counter.

## 2. The checkout SHA is not the metered identity

Reviews dedup on the authoritative `git rev-parse HEAD` (the checked-out sha), because a force-push between delivery and processing must not be mis-deduped. Reusing that same value as the metering key splits one logical review into two identities whenever the checkout changes between a failed attempt and its retry.

**Rule:** dedup may use the authoritative sha; metering uses the payload identity (app, owner, repo, PR, payload `head_sha`). Keep the two keyed separately even though they are usually equal — the cases where they differ are exactly the ones that matter. A delivery with no payload sha needs a stable sentinel (`"no-sha"`), not a fallback to the checkout value, or the identity moves on every retry.

## 3. The ledger mints its own sequence

```sql
INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at)
SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4
  FROM usage_events WHERE review_id = ?1
```

One statement, no read-then-write window: SQLite's write lock serialises the max-and-insert. `seq` is 1, 2, 3… per `review_id`; a genuine re-execution after a runner failure legitimately mints the next number.

`execution_token` is the producer-minted (UUID), `UNIQUE` identity of **this** attempt: `seq` answers "which attempt of the review", the token answers "this attempt". That distinction is what makes a failed insert readable — a review may already hold earlier rows, so "does any row exist" would report a failed second attempt as applied.

## Where the write sits

Inside the sandbox, **after** the authoritative sha and **after** both idempotency reads (KV done-state, D1 row) and the publication-journal handoff have missed, **before** the runner starts. A dedup hit therefore acks without metering; a real execution meters once per start.

## Failure policy is a product decision, not a default

"Count, never refuse" (metering must not block a review) still has a failure story: a swallowed insert makes the ledger silently lossy. Record a structured failure row instead, and check the recording path cannot throw:

- the failure table enforces a producer-side stage vocabulary — add the new stage there (`usage`) or the recorder throws inside your catch;
- if that vocabulary lives only in code (no DDL `CHECK`), widening it costs one line and no migration;
- wrap the recording call in its own guard so a doubly-failed write still cannot mask the review;
- read the failed attempt back by its `execution_token` and record `applied` as `true | false | "unknown"`: `true` means this execution's row is present (the failure is noise), `false` means the read succeeded and found nothing — the only state that authorises a backfill — and `"unknown"` means the read itself failed. A backfill must re-check the token before inserting: the unique index only rejects a replay that reuses the recorded token, and a fresh token mints another `seq`.

## Index for the read you will add

A per-request dashboard read like "rows for this workspace this month" needs `(workspace_id, occurred_at)`; the ledger's `(review_id, seq)` primary key cannot serve it. Add that index while the migration is still unapplied — afterwards it costs a new migration.
