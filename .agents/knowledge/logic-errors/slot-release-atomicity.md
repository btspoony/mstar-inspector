# A held slot is released by the write that settles the attempt

## The shape

A review attempt's queue slot is held while `review_launches` reads `state = 'launched' AND result_outcome IS NULL` — the "a paid step may still be live" predicate, independent of any TTL. Release therefore has to happen where the attempt is settled: the same batch that writes the failure record must also terminalize the launch row.

## Three traps this shape sets

1. **Recording with a generated id.** If the settlement writes its failure row under a random id, no recovery lane can ask "does this attempt already have a record?" by key. A re-executed settlement then writes a second row and loses the ability to recognise its own work. Key the record by the attempt.
2. **Deciding existence before the write.** A read taken before the batch is a race: a record committed in between makes the pass take the owner path and act on a row it did not create. Put the predicate inside the statement —
   `INSERT ... SELECT ... WHERE NOT EXISTS (id = attempt OR (track_id = attempt AND id NOT LIKE 'attempt:%' AND stage NOT IN (<sub-record stages>)))` — and gate the dependent writes on that insert's own row count.
3. **Revoking to "retire" the attempt.** A revoked launch row makes cleanup refuse the container handle, so teardown can never be proven and the slot is held forever. Release by terminalizing state, and let the successor's stop proof open the next admission.

## Why the predicate names stages

Diagnostic rows share the attempt's `track_id` — a `usage` or `rate-limit` row can carry a random uuid. Excluding only the `attempt:<stage>` id shape misses those, and a diagnostic row then suppresses the real settlement record. Reuse the dashboard's own attribution exclusion (`stage NOT IN (ATTRIBUTION_EXCLUDED_STAGES)`) instead of enumerating ids, so the guard and the UI agree on what a settlement record is.

## What to test

- A crash between the record and the launch move: the row must still be released, exactly once.
- An insert fault: nothing revokes, the slot stays held, a clean retry becomes the owner.
- A record written by a previous build (random uuid, `track_id = attempt`): reused, never duplicated.
- Diagnostic rows (`:recheck`, `:usage`, random-uuid `usage`): never stand in for the record.
- The released slot is proved usable through the production takeover, not only through the ledger.

Each of these must fail when its guard is removed; a test that passes with and without the fix proves nothing.
