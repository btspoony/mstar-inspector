# Refusal accounting must be a durable replayable effect, not an inline marker

When a publish gate (or any fail-closed check) refuses an already-paid review and that refusal carries side-effect obligations — a shipped-failure row, an attribution log line, a claim stamp — the accounting cannot be implemented as best-effort inline writes with markers read back later. Four review rounds on `publish-gate-resume` (v1.24) converged on the same failure modes for every marker-based variant:

- **Unregistered = invisible.** If the obligation's own registration write (a duty/intent row) can fail silently, every downstream settlement sees "no obligation" and stamps the attempt settled — the exact outcome the accounting exists to prevent.
- **A committed row is not a delivered log.** Treating `INSERT ... changes > 0` as proof that a separate log line was emitted loses the line whenever the commit succeeds but the reply is lost or the host dies before logging.
- **Inline bookkeeping on the happy path converts telemetry faults into failed publications.** Marker reads/writes that run unconditionally before staging route an otherwise-valid paid review to terminal failure when an accounting-only store faults.
- **Recovery must own the completion.** A "still owed" row that only collect can satisfy strands forever once collect's retry budget dies; the scheduled reconcile pass has to be able to write the missing effects.

## The shape that survived review

1. A durable **intent** record (per-attempt, written at the refusal path's entry, fail-closed on write failure) that every settlement path — live, the workflow's terminal catch, and recovery — treats as required effects. Absence of the intent means ordinary failure semantics; presence means the effects are owed.
2. **Durable facts for each effect** (`review_recheck_duties`, `review_recheck_attributions` — attempt+round keyed, idempotent). Emission is at-least-once, gated on the fact's existence, never on an insert's change count or a post-log timestamp.
3. The **reconcile/recovery pass is the named owner** for writing missing effects and discharging the settlement (`settlementPlan` derives required vs landed from the durable facts, shared by live and recovery).
4. The **clean path is best-effort end to end**: on a gate-cleared publish, a fault anywhere in accounting bookkeeping is logged and skipped — it must never block staging or publication.

Residual boundaries are disclosed, not hidden: a fault confined to the intent's own write still has a window, and recovery replays a summarized attribution line rather than a byte-identical copy. See `I-000689` and `src/store/review-route-store.ts` (`settlementPlan`), `src/pipeline/route-reconcile.ts` (`ensureRecheckAccounting`).
