# ADR: Show actionable status for terminal review failures

Status: implemented — each terminal failure persists one approved category in `review_checks.terminal_failure_status` and the Check summary carries its frozen wording verbatim
Spec: docs/specs/feature/review-lifecycle.md § 7.9 App-owned Check attempt fencing and conclusions

## Problem

A failure used to surface an error string in the Check or leave the user on an unexplained generic error page. The user needs to know what happened and what they can do; the operator needs the underlying cause. One error message cannot serve both audiences.

## Decision

For a terminal review failure, one approved official-language status is persisted as part of the terminal outcome — the closed four-value vocabulary `CheckFailureStatus` (`src/store/review-checks.ts:80`) written to `review_checks.terminal_failure_status` (`migrations/0087_terminal_failure_status.sql`). When the Check update succeeds, its [output summary](../../../../docs/specs/feature/review-lifecycle.md#79-app-owned-check-attempt-fencing-and-conclusions) carries that wording from `TERMINAL_FAILURE_TEXT` (`src/pipeline/checks.ts:990`). If the Check request fails or the remote update is unconfirmed, the internal record still holds the cause and the reconciler owns delivery. The raw error, stack, and provider details stay in internal `review_failures` records or logs, with secrets redacted; no user-facing surface renders them.

An anchored time-budget stop is an expected platform decision, not an unexpected fault, so it keeps the dedicated [exhaustion summary](../../../../docs/specs/architecture/review-budget.md#exhaustion-outcome) as a distinct approved category rather than falling back to “Something went wrong.”

The wording does not promise automatic recovery or retry: the review does not re-run itself. Where the user can act, the one next step is to re-trigger the review through the [existing bot-mention comment path](../../../../docs/specs/feature/review-trigger-policy.md#3-bot-mention-comment-trigger-normative), creating a new attempt. A live Workflow that is still waiting keeps the Check in progress with no failure text, as required by the [two-tier lease decision](2026-11-21-two-tier-lease-for-long-review.md); a failure is not a pending state.

## Alternatives considered

- **Show the raw error.** It leaks internals and gives the user no next step.
- **Keep the silent generic page.** The current fallback does not say what happened to the review or what the user can do.
- **Show status without a next step.** Even accurate wording is a dead end when the user can re-trigger the review but is not told how.

## Consequences

- One approved status is persisted with each terminal failure — `migrations/0087_terminal_failure_status.sql` adds `review_checks.terminal_failure_status`, and `CheckFailureStatus` (`src/store/review-checks.ts:80`) is a closed four-value vocabulary.
- The wording carries one next step and promises no automatic retry — `TERMINAL_FAILURE_TEXT` (`src/pipeline/checks.ts:990`): the `paused` entry names the operator and asks nothing of the author.
- A successful Check update presents the persisted wording — `tests/pipeline/check-summary-wording.test.ts`, "a landed update sends the frozen text and its category verbatim".
- A failed or unconfirmed update belongs to the reconciler, not reported complete — `check-summary-wording.test.ts`, "a lost reply plus a matching read is reconciliation, not a resend" and "a reply without the frozen text is not delivery".
- No user-visible surface renders the raw cause — `check-summary-wording.test.ts`, "a conclusion-only match on a concluded run is never rewritten" and "a run finished with a DIFFERENT conclusion is reported, never overwritten".
- A live waiting attempt keeps no failure text — `check-summary-wording.test.ts`, "a waiting attempt keeps no failure text and is never examined".

## Risks

Generic approved wording can under-inform the user. Operators investigating a failure must correlate its Check attempt with the internal failure record and logs to recover the cause.
