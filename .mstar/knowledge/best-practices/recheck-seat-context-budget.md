# Recheck seat context budget and catalog alignment

> A structured subagent that is asked more than its context can hold fails by yielding nothing at
> all — and a validator that checks the yield against a wider catalog than the seat saw will accept
> evidence the seat could not have read.

## Symptom

A recheck round reports `Reassessed 0/N open prior finding(s) this round` while the open-finding
count only grows. The runner's status document says `failed`/`seat-failed` and carries the thrown
message as its `error` — for an absent yield, `recheck seat produced no valid structured output
(status unavailable)`; the EMPTY stderr belongs to the SDK child result, not to that document. Every
sent row is counted `invalid-output`. No finding is ever closed, so the review never converges no
matter how many fixes land.

## Cause: one confirmed defect, one observed correlation

1. **Confirmed defect.** The runner validated the yield against the ORIGINAL input while the seat had
   only been shown the FITTED one. A seat that cites a slice it never received — the slice exists in
   the original catalog and was omitted by the fit — passed validation and could be published
   `addressed` on evidence it could not have read.
2. **Observed correlation, cause unproven.** The seat's ask used to be the whole recheck input
   serialized verbatim; at the documented input limits (25 targets, up to four evidence slices per
   target) that is ~280 KB — ≈ 72k–82k tokens at 3.5–4 bytes per token, not the 512 KiB cap's figure —
   and the rounds it produced were lost with
   `structuredOutput.status = "unavailable"` and an empty stderr. The RCA could NOT separate context
   pressure from the seat's own time cap: both surface as an absent yield. Treat the size limit as a
   mitigation for an observed failure shape, not as a proven root cause.

## Rule

- **Fit the ask to a budget, and make the budget operable.** Targets and discussion always ride;
  evidence slices are kept whole or omitted entirely (never truncated mid-slice, so line numbers
  stay exact). Give every row at least one slice before deepening any row, otherwise a sort order
  starves rows. The byte budget belongs on the configuration surface
  (`review.recheck.assignment_max_bytes`, system layer, audited, degraded-safe), not in a source
  constant.
- **Validate against exactly what the seat received.** The validator's catalog must be the fitted
  one; a citation of an omitted slice is a row-level rejection with a named reason. Document-level
  distrust (schema, HEAD, foreign/duplicate row ids, over-cap) stays whole-document fail-closed.
- **Never let a round vanish.** A seat that cannot be dispatched returns the closed
  `skipped`/`budget` status and the consumer attributes every sent row `unverifiable`/`budget`;
  a seat that ran and produced nothing attributes its sent rows `invalid-output`. The published
  coverage line keeps `assessed + invalid-output + omitted === selected`.

## Test the path, not the contract

A test that calls the validator directly with the fitted catalog proves only that the validator
works; it says nothing about the dispatch path. The regression test must drive the real
`runRecheckSeat` (fake only at the SDK seam), answer with the assignment the seat was actually
handed, and assert both directions: an omitted-slice citation is rejected and never published, and
a received-slice citation still publishes. Reverting the one-line gate must make that test fail.

## Related

- `docs/runtime-configuration.md` — where the assignment budget is listed with its layer and default.
- `cf-queue-consumer-wall-clock.md` — the outer bound that a recheck round shares with the review.
