# ADR: Show actionable status for terminal review failures
Status: proposed — the failure wording and its Check summary carrier have been chosen but have not shipped
Spec: docs/specs/feature/review-lifecycle.md § 7.9 App-owned Check attempt fencing and conclusions

## Problem

Today a failure can surface an error string in the Check or leave the user on an unexplained generic error page (`src/pipeline/checks.ts:1089–1090,1439`; `src/spa/components/state/ErrorState.tsx:27`). The user needs to know what happened and what they can do; the operator needs the underlying cause. One error message cannot serve both audiences.

## Proposal

For a terminal review failure, choose approved official-language status, such as “This service is paused right now” or “Something went wrong; please retry later,” and persist it as part of the terminal outcome. When the Check update succeeds, its [output summary](../../../../docs/specs/feature/review-lifecycle.md#79-app-owned-check-attempt-fencing-and-conclusions) carries that wording. If the Check request fails or the remote update is unconfirmed, the internal record still holds the cause and the reconciler owns delivery. The raw error, stack, and provider details stay in internal `review_failures` records or logs, with secrets redacted; no user-facing surface renders them.

An anchored time-budget stop is an expected platform decision, not an unexpected fault, so it keeps the dedicated [exhaustion summary](../../../../docs/specs/architecture/review-budget.md#exhaustion-outcome) as a distinct approved category rather than falling back to “Something went wrong.”

The wording does not promise automatic recovery or retry: the review does not re-run itself. Where the user can act, the one next step is to re-trigger the review through the [existing bot-mention comment path](../../../../docs/specs/feature/review-trigger-policy.md#3-bot-mention-comment-trigger-normative), creating a new attempt. A live Workflow that is still waiting keeps the Check in progress with no failure text, as required by the [two-tier lease decision](2026-11-21-two-tier-lease-for-long-review.md); a failure is not a pending state.

## Alternatives considered

- **Show the raw error.** It leaks internals and gives the user no next step.
- **Keep the silent generic page.** The current fallback does not say what happened to the review or what the user can do.
- **Show status without a next step.** Even accurate wording is a dead end when the user can re-trigger the review but is not told how.

## Acceptance criteria

- Persist one approved status with each terminal review failure, including one next step where the user can act and no promise of automatic retry or recovery. Keep the underlying cause in the internal record with secrets redacted.
- A successful Check update presents the persisted wording in the summary. If the request fails or the update is unconfirmed, delivery belongs to the reconciler and is not reported as complete. No user-visible review failure surface renders the underlying error string, stack, or provider details. A live waiting attempt stays in progress with no failure text.

## Risks

Generic approved wording can under-inform the user. Operators investigating a failure must correlate its Check attempt with the internal failure record and logs to recover the cause.
