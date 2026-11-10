# Architecture: GitHub review comment mapping

## Scope

GitHub publication vocabulary, COMMENT-only event discipline, user-visible comment structure, and ordering of publication, persistence and result side effects. The review JSON authority is harness `mstar.review/v1` (`validateMstarReviewV1` / `synthesizeReview`), not the retired M1 `ReviewOutput` shape.

## Current state

### Authoritative vocabulary

| Surface | Legal values | Retired M1 values rejected on persistence |
|---|---|---|
| verdict | `ship it` / `needs fixes` / `blocked` / `incomplete` | `comment` / `request_changes` / `approve` |
| finding class | `must-fix` / `should-fix` / `may-fix` / `nit` | `critical` / `warning` / `suggestion` / `info` |

`score_pct` never rewrites the verdict. The engine `computePrTally` owns formula and tally keys; Inspector invents neither. Score is one App Check gate condition alongside the passing-verdict set ([review lifecycle](../feature/review-lifecycle.md), §7.9); in the comment it remains display-only.

### GitHub Review event mapping

`event` is the fixed literal `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`.

| `mstar.review/v1` verdict | `pulls.createReview` event | Meaning |
|---|---|---|
| `ship it` | `COMMENT` | Advisory; even a high score does not emit `APPROVE` |
| `needs fixes` | `COMMENT` | Advisory only |
| `blocked` | `COMMENT` | Never emits `REQUEST_CHANGES` |
| `incomplete` | `COMMENT` | Neutral run-stopped marker, not a pass or merge authorization; never emits approval/change requests |

Issues Comments API has no event field and follows the same discipline; it must not be replaced with an approval/change-request path. The primary publication uses a single Issues comment upsert on the PR, with `<!-- mstar-inspector:review:v1 round=N -->` plus `<!-- mstar-inspector:publication:v1 id=<uuid> sha=<sha> kind=<review|degraded> -->`. A COMMENT review is the line-comment batch face, not a duplicate new overall review each round. The contractual alternative of COMMENT review publication also requires one non-duplicated overall discussion; per-round duplicate reviews are forbidden.

### Comment body

- Align with the review report: verdict line, tally (`must-fix` / `should-fix` / `may-fix` / `nit` / `unverified`), and findings grouped by merge class.
- Render verdict and finding class verbatim; never translate them into M1 verdict/severity vocabulary.
- For `incomplete`, immediately after verdict and any tally, render its required facts exactly once: `cause:` = `reason`, `unscanned:` = uncovered scope (`none` for an empty list). Rendering has a display budget; persistence retains validated original values. Other verdict bodies remain byte-identical.
- The overall comment is the publication authority for the round. Line-comment anchoring follows the existing line-comment implementation.
- A prior-round closure block may show typed finding status/evidence; repeat findings do not add to the new tally. Finding disposition (`addressed`) is distinct from actual remote thread resolution. Engine verdict/score authority is unchanged. The closure placement and bounds are in [review lifecycle](../feature/review-lifecycle.md), RL-8 and §7.10.
- `summary_md` is capped at 8000 characters. Redact model text before GitHub or D1 writes.

### Ordering and failures

1. Nonempty `head_sha` plus an idempotency hit means no review, publication or result write. Existing recovery remains due.
2. Parse / `validateMstarReviewV1` failure makes a best-effort summary-only degraded publication and ACK: no normal review insert, paid automatic replay or DLQ. Typed posted/not-posted outcomes are durable evidence; degraded comments never authorize closure/resolution. A confirmed degraded publication cannot meet the Check gate and concludes `failure`; failed degraded publication is honestly failed, not “degraded successfully”.
3. GitHub primary publication precedes public result persistence. Publication failure does not insert a result.
4. Preserve UNIQUE `(installation_id, owner, repo, pr_number, head_sha)`.
5. Thread resolution and Check terminalization are result side effects; they do not roll back or fabricate publication/persistence. Two pre-publication record classes are allowed: execution attempts without verdict/findings/disposition, and a private complete-payload recovery journal with no dashboard/insights/report read exposure. Review/findings/lifecycle/association writes apply idempotently only after positive publication proof. Failure/timeout Check terminalization without a publication is permitted as execution truth, not a fabricated result. Skip paths before a claim create no Check.
6. Resolution requires opaque Inspector association, authenticated App ownership, matching HEAD/discussion fences and remote-confirmed `isResolved`; failure/unknown remains visible. Worker uses purpose-scoped `review-write`; Sandbox receives repository-scoped read-only `sandbox-read`.

### Check and control boundaries

- A Check expresses the App gate: normal applied publication, passing verdict and score ≥ floor means `success`; missed/unreadable gate or review, degraded/unconfirmed publication, local error and execution failure mean `failure`. No normal consumer path produces `neutral`; the persisted historical enum remains in the lifecycle contract. Conclusions follow durable evidence, not code paths. Check failure never blocks review publication.
- Permissions include `checks: write`; production injects `CheckLifecycleHooks`. Multiple same-name runs on one commit are legitimate historical attempts: the newest applicable attempt governs, not universal cross-App authority. Omit `details_url`; branch protection is the user’s choice.
- GitHub `APPROVE` is not emitted as automatic merge authorization; `REQUEST_CHANGES` is never emitted.
- New enqueue is controlled by per-App `review_enabled` and the operator `review_global` server flag. Disabling the platform flag does not cancel already-queued work.

## Invariants

- Harness vocabulary and engine tally/verdict remain authoritative.
- Every `pulls.createReview` uses literal `COMMENT`.
- A successful primary publication is proved before public result writes or finding/thread mutation.
- A remote timeout is not proof of no publication or successful resolution.

## Where it lives

- `src/pipeline/comment.ts`: primary upsert, markers, body rendering, scoped token grants and line batches.
- `src/pipeline/consumer.ts`: publication staging/proof/apply order.
- `src/pipeline/checks.ts`, `src/store/review-checks.ts`: Check gates, intent and observation.
- `src/store/artifact-store.ts`: complete envelope validation and result persistence.
- `src/worker/index.ts`: per-App and platform enqueue gates.
- [Review lifecycle](../feature/review-lifecycle.md): exact schema, identity, journal, recovery and Check matrices.

## Change obligations

Explicitly review vocabulary/event/body changes. Update publication consumers, rendering, persistence validation and lifecycle documentation together; preserve COMMENT-only behavior, one overall upsert, redaction and bounded incomplete/closure rendering.
