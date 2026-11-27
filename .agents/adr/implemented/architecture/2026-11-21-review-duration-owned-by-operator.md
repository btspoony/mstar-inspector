# ADR: Put the hard end-to-end review duration cap under operator control

Status: implemented — `review.attempt.duration_cap_ms` is the single system row carrying the cap, enforcement reads the frozen deadline end to end, and the operator duration report ships alongside it
Spec: docs/specs/architecture/review-budget.md § Known limits

## Problem

The retired [Queue invocation clock](../../../../docs/specs/architecture/review-budget.md#one-absolute-deadline) described the non-configurable platform cap the review used to derive its budget from. A [handoff beyond that ceiling](../../../../docs/specs/architecture/review-budget.md#known-limits) removes the Queue invocation bound ([Cloudflare wall-time limits by invocation type](https://developers.cloudflare.com/workflows/reference/limits/#wall-time-limits-by-invocation-type)); this decision makes the replacement cap configurable and operator-owned.

## Decision

The platform operator owns one hard end-to-end cap on the Workflow route. The narrowest surface for this platform-wide number is one system row in the existing operator admin runtime settings (`review_runtime_settings`, `/api/runtime`; `AGENTS.md:79–95`), read as `REVIEW_ATTEMPT_CAP_KEY = "review.attempt.duration_cap_ms"` (`src/dashboard/runtime-config-store.ts:602`).

Before setting the number, the operator reads a duration analysis report in operator admin. It shows the distribution of observed review durations and separates queue wait, execution, and publication or recovery time so the operator can judge what the cap would cut off. `readReviewDurationReport` (`src/admin/duration-report.ts:208`) serves it at `GET /api/runtime/duration-report` (`src/admin/index.ts:1116`), and every percentile is nearest-rank — an observed duration, never an average. This record sets neither the value nor the clock origin; the absent-row default is the documented 20 minutes.

## Alternatives considered

- **Workspace-level duration limits.** Workspaces are metered per started review, not per minute: one `usage_events` row carrying an integer `rp` price per review (`chargeUsage`, `src/store/usage-store.ts:172`; `docs/specs/architecture/entitlement-and-deployment-modes.md` § RP metering and the monthly ceiling). A tenant-side duration limit has no cost rationale under that model; the cap addresses platform runtime and capacity.
- **App-level duration limits.** Copying the same platform cap across Apps fragments one operating policy and lets the values drift, without an App-specific reason to differ.

## Consequences

- The operator can point to the admin duration analysis report as evidence for the chosen value and set it in the single system runtime setting, with no workspace or App overrides — `readReviewDurationReport` (`src/admin/duration-report.ts:208`) at `GET /api/runtime/duration-report` (`src/admin/index.ts:1116`), answering nearest-rank percentiles per phase.
- One system runtime setting carries the cap, with no workspace or App override — `REVIEW_ATTEMPT_CAP_KEY` (`src/dashboard/runtime-config-store.ts:602`).
- Enforcement ships with the configuration surface and documents the absent-row default — `tests/pipeline/hard-stop.test.ts`, "an absent row answers the documented 20-minute default without a warn".
- The Workflow route enforces the cap end to end — `hard-stop.test.ts`, "the exec bound is taken after the claim, so the claim's round trip is charged" and "a claim that spends the whole window refuses the exec and records a confirmed stop".

## Risks

A cap set from averages alone can cut off valid long reviews; a cap set too high lets slow reviews hold shared capacity longer. The report must expose the upper tail before the operator sets the value.

The customer outcome stays open if the cap terminates a review that has already consumed paid work. What the customer receives and whether the review is billed are decided alongside the cap's value, not by this record.
