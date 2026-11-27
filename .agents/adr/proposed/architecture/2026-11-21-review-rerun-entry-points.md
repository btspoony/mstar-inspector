# ADR: Add PR detail and GitHub badge entry points for review reruns
Status: proposed — neither entry point this record decides exists: the PR detail page issues no trigger request and the review comment carries no badge; what ships today is GitHub's own Check re-request reusing the shared enqueue path, the alternative this record set aside
Spec: docs/specs/feature/review-trigger-policy.md § 3. Bot-mention comment trigger (normative)

## Problem

Today the only user-facing on-demand entry is a bare bot mention in a PR comment, available only to the PR author or repository owner (review trigger policy [§ 2.1](../../../../docs/specs/feature/review-trigger-policy.md#21-auto-trigger-classification-matrix) and [§ 3](../../../../docs/specs/feature/review-trigger-policy.md#3-bot-mention-comment-trigger-normative); `docs/specs/feature/review-trigger-policy.md:16–18,30–41,53–60`). A user on the internal PR detail page cannot rerun from there, and the GitHub review comment has no rerun link (`docs/specs/feature/review-lifecycle.md:34`). The bare mention cannot express “this head, this attempt, right now.”

## Proposal

Put a one-click rerun control on the internal PR detail page. The static GitHub badge rides the review comment and links to that detail page or a lightweight trigger page. Nothing is injected into the PR description. The badge contains no token or execution state and grants no access.

Both entries require sign-in and the existing App-management permission (`canManageApp`) in the App’s owning workspace (`src/dashboard/index.ts:5773–5775,5832–5839`). This decision adds no access or execution permission: a user without that permission cannot access either the page or the trigger endpoint. The server refuses a direct trigger request regardless of what the client sends.

Both entries request a user-authorized **new attempt** carrying the current `head_sha`, never a retry of a live attempt. They reuse the webhook’s shared entry to `handleReviewJob` (`src/worker/index.ts:1026`), with the send in `src/worker/handlers.ts:390`. [Review trigger policy § 3](../../../../docs/specs/feature/review-trigger-policy.md#3-bot-mention-comment-trigger-normative) describes the current enqueue semantics; this decision adds entries, not a new trigger policy. The comment-specific `head_sha = null` and comment-ID claim do not carry over. The target’s trigger mode and business and operational pauses still apply; the existing execution guard, Check fence, and publication journal keep their present roles. Cron resend and maintenance replay are separate senders and are out of scope (`src/worker/sweep.ts:607`; `src/admin/maintenance-replay.ts:236,281`).

Today `handleReviewJob` skips an enqueue when KV marks the SHA queued or done, and the consumer ACKs a checkout it has already reviewed (`src/worker/handlers.ts:126–147,318–340`; `src/pipeline/consumer.ts:5087–5130`). A redelivery of the same attempt must stay deduplicated. A user-authorized new attempt for the same head is not a duplicate: it must carry an intent distinct from an automatic trigger so both pre-send SHA deduplication and the consumer’s already-reviewed short-circuit can distinguish the cases. This decision requires that distinction without prescribing how it is represented.

The execution guard runs after queue consumption (`src/pipeline/consumer.ts:4911`) and cannot prevent a second enqueue. A new **atomic pre-enqueue claim on (installation, repo, PR, head)** blocks a rerun on duplicate grounds only while a non-terminal attempt holds that head. In that case enqueue nothing and show the already-running status. A completed, failed, or exhausted attempt does not by itself block a rerun, but if publication for that head is unresolved, the consumer routes it to the existing publication recovery path and ACKs the rerun without starting another paid execution (`src/pipeline/consumer.ts:1460–1476,5132–5140`). This bounds the double-click case; billing for repeated attempts remains a separate decision.

The in-page states use their own approved wording, never a raw error:

- **Refusal:** “You don’t have permission to rerun this review here.” If the viewer is the PR author or repository owner, add “To rerun on GitHub, mention the bot in a PR comment” under the [existing comment trigger rules](../../../../docs/specs/feature/review-trigger-policy.md#3-bot-mention-comment-trigger-normative). A viewer with neither route gets “You don’t have permission to rerun this review,” with no next-step claim.
- **Already running:** “A review is already running for this commit.”
- **Starting:** “Starting the rerun.” On acceptance, show this state and return the user to the PR detail page.

A trigger refusal is not a review failure. The [failure-status ADR](2026-11-21-review-failure-user-facing-status.md) owns only the terminal Check summary, not these in-page states.

## Alternatives considered

- **Keep the mention as the only entry.** It makes an internal user switch to GitHub and write a comment, without expressing per-head intent.
- **Have the badge call the trigger endpoint directly.** A static link gives the product no place to authorize the viewer or show acceptance or refusal, and a public PR exposes the trigger endpoint itself.
- **Ship only the internal PR detail control.** It leaves no path from GitHub, where most review discussion happens.
- **Reuse GitHub’s Check re-request action.** Its action semantics are owned by GitHub, not this product, and the [trigger policy defers it](../../../../docs/specs/feature/review-trigger-policy.md#5-non-goals).

## Acceptance criteria

- After a completed, failed, or exhausted attempt with no unresolved publication for the current `head_sha`, one authorized click starts exactly one new round. A successful rerun publishes the new round instead of being skipped as already reviewed. If publication remains unresolved, the consumer hands off to existing recovery and ACKs without starting a new paid execution.
- While a non-terminal attempt holds that head, another rerun request enqueues nothing and shows the approved already-running status.
- Redelivery of the same attempt stays deduplicated and does not start or publish another round.
- The server refuses a direct trigger request without App-management permission. The refusal offers the GitHub comment route only to a PR author or repository owner. Acceptance shows the starting state before returning to the PR detail page.
- The badge resolves to the internal PR detail page or the authorized trigger page without carrying a token or execution state. For a public repository, the workspace setting can suppress the badge; without a setting row, the badge is shown on the review comment.
- Reading the shared `handleReviewJob` entry shows that both routes take the new claim before the same queue send and cannot bypass the existing policy or guards.

## Risks

- The rerun entries must not ship before the [billing posture for repeated attempts](2026-11-21-paid-review-step-at-most-once.md#risks) is decided. A one-click rerun combined with a terminal failure message that tells the user to retry can lead to repeated charges the user cannot see.
- A badge on a public PR advertises that the repository uses this tool. The review comment is already public when the App reviews a public repository. A workspace manager can suppress the badge for a public repository through the owning workspace’s Settings → Configuration surface (`/dashboard/<ref>/settings`, `src/spa/pages/WorkspaceSettingsPage.tsx:1–12`). The absent-row default is to show the badge.
- The App-management permission wins for both new entries because they act within the App’s owning workspace. The PR-author or repository-owner rule still governs GitHub comments; it offers an alternate entry, not permission to use the internal control.
