# Feature: review trigger policy

## Scope

Per-repository automatic modes with a workspace default, the bare bot-mention trigger, durable per-comment claims, webhook body limits and membership revocation.

## Current state
### 1. Product contract

Each repository target runs with the trigger mode its effective settings answer — the workspace default unless the target overrides it:

1. **`open`** — review a PR the first time it opens (the `opened` event only). New pushes and reopens never auto-trigger; a reviewer mentions the bot when they want another pass.
2. **`every_push`** (the workspace default) — review on `opened`, `synchronize`, and `reopened`. This is the automatic behavior, and the default preserves it exactly for human-authored PRs.
3. **`manual`** — the target never auto-reviews. Only a bot mention starts a review.

In every mode, a comment that @mentions the App's bot can (re-)start a review — on-demand re-run for auto modes, the only trigger for `manual`. This excludes PRs opened by a bot account (§2.1), which are never reviewed on either face.

The comment trigger is a **bare mention**: no slash command, no magic wording. `/review` is retired.

### 2. Trigger modes (normative)

| Field | Contract |
|---|---|
| Storage | `review_targets.review_trigger_mode TEXT NOT NULL DEFAULT 'every_push' CHECK (review_trigger_mode IN ('open','every_push','manual'))` — moved there by `0057_review_targets.sql`; the bot row does not hold it, and the workspace default is `workspaces.default_review_trigger_mode` (`0067`) |
| Scope | Per review target, which may inherit the workspace default (`follow_workspace_defaults`). No deployment-level override; the target's business pause or the bot's operational pause governs every enqueue path alongside the platform flag |
| Default | the workspace default is `every_push` (`default_review_trigger_mode`); a new target is created inheriting it |
| Write path | the repository detail's 评审配置 tab (`POST …/api/targets/:targetId`) and its 所有仓库 twin (`POST …/api/targets/defaults`), one validated body parser each; an off-vocabulary mode is a keyed 400 with nothing stored |
| Read path | The webhook resolves the delivery's target by repository identity and passes that target's effective trigger mode (plus the bot row's cached `github_slug` and its numeric `github_app_id`) into classification — one defaults read per delivery, no second lookup. A `check_run` delivery's write path needs no operator action at all: the manifest declares `check_run` in `default_events`, and an App already holding `checks: write` is auto-subscribed to the event by GitHub, so an existing App needs no settings change; the read path resolves the rerequested run back through `review_checks (github_app_id, check_run_id)` — indexed by `idx_review_checks_app_run` (migration `0109`) — which is the authoritative source for the run's `pr_number` and `head_sha` because a fork PR's delivery carries an empty `pull_requests` list and a null `head_branch`; the job's `owner`/`repo` follow the delivery's current name so a renamed repository keeps the target and the job in agreement |

### 2.1 Auto-trigger classification matrix

| Event | `open` | `every_push` | `manual` |
|---|---|---|---|
| `pull_request.opened` | enqueue | enqueue | ignore |
| `pull_request.synchronize` | ignore | enqueue | ignore |
| `pull_request.reopened` | ignore | enqueue | ignore |
| other `pull_request` actions | ignore | ignore | ignore |
| any `pull_request` action whose PR author login ends in `[bot]` (case-insensitive; `dependabot[bot]`, `github-actions[bot]`, another App's `<slug>[bot]`) | ignore | ignore | ignore |
| any `pull_request` action whose payload carries no author login | ignore | ignore | ignore |
| `issue_comment.created` (allowed actor, bot mention, on a PR) | enqueue | enqueue | enqueue |
| `check_run.rerequested` (a run this App's `review_checks` names — Re-run on the Checks page) | enqueue | enqueue | enqueue |
| `check_run` — any other action, a run another App created, or a run id no `review_checks` row names | ignore | ignore | ignore |
| `issue_comment.created` (disallowed actor / no mention / not a PR / bot sender / PR opened by a `[bot]` account / PR author login missing) | ignore | ignore | ignore |

Ignored paths keep today's structured-log discipline; classification never rejects (4xx) an event for policy reasons — reject is reserved for malformed payloads. The action whitelist still runs first; the malformed reject then precedes every author/mode/mention policy gate on both faces (the comment face's 400 can therefore fire earlier than it used to, on a whitelisted action that could not have enqueued anyway).

Guard precedence (the order the ignore `reason` labels follow): the action
whitelist first, then the malformed-payload reject, then the author rule
(bot login, then missing login), then the mode gate on the `pull_request`
face. On `issue_comment`: whitelist, reject, not-a-PR gate, author rule,
mention grammar, sender-bot guard, actor allowlist. A `pull_request.closed`
by a bot therefore reports the action reason, while an `opened` by a bot in
`open` mode reports the author reason.

On `check_run`: whitelist (`rerequested` only), reject, then the owning-App
check (`check_run.app.id` vs. the resolved row's `github_app_id`) — a run
another App created is ignored, never resolved. A `rerequested` delivery
that names a run id no `review_checks` row owns is a 200 `ignored`, and a
lookup error is a recorded `check_rerun_lookup_failed` warn that still
answers 200 (fail-closed: a rerun that cannot prove ownership is a retry,
not a review). A resolved rerun enters the same business-pause /
operational-pause / review-flag / entitlement gates as any other job —
rerequested is a trigger, never a bypass.

### 2.2 Check-run rerequested semantics

- **Rerun means re-run the review on the run's own head.** The enqueued job
  carries `triggered_by: "check_run"`, `action: "rerequested"`, the
  `rerun_check_run_id` it was asked to rerun, `pr_number`/`head_sha` read
  from the `review_checks` row, and `owner`/`repo` from the delivery's current
  name (the row may predate a rename) — the delivery's own `pull_requests` is
  advisory only (empty on fork PRs).
- **GitHub requires a new run.** A concluded run cannot be re-queued, so
  acceptance attaches a fresh `review_checks` attempt under
  `(triggered_by=check_run, action=rerequested)` — the same
  `attachCheckAtAcceptance` path every job takes; the new `attempt_key`
  distinguishes it from the run being rerun.
- **An already-reviewed head is never paid twice.** The rerun's KV claims
  key under `{idemKey}:rerun:{check_run_id}`, so the plain key's `done`
  never swallows it and the redelivery of the same rerequested event still
  dedups; the pipeline's existing `reviews` lookup then settles its attached
  run with the head's persisted review against the App's current gate
  (`success`/`failure`), or `neutral` with the skip reason when there is
  nothing to inherit, instead of running the model again (RL-10). There is no
- **A head that was never successfully reviewed really re-reviews — while it
  is still the PR head.** When the run's head has been overtaken, the rerun
  never reviews new code: the consumer settles its attached run with the old
  head's persisted review against the App's current gate (`success`/`failure`)
  when that head was reviewed, or `neutral` with the skip reason ("rerun
  targets a commit that is no longer the PR head") when it was not, and acks.
  On either leg, a persisted review/publication row that EXISTS but cannot be
  READ settles `unknown-failure` → `failure` (fail-closed), never `neutral`.


### 3. Bot-mention comment trigger (normative)

- **Mention target:** the App's own bot identity, taken from the row's cached `github_slug` — GitHub's App slug, refreshed from `GET /app` at manifest conversion and on every metadata refresh (migration `0036`). The webhook face routes by `{workspaceId}/{appId}` (workspace id and internal App id) and resolves the row before classification, so matching is keyed to the resolved row — one App's mention never triggers another App. A comment body matches when it contains `@{github_slug}` (ASCII case-insensitive compare against the cached slug, matched as a literal) as a **standalone token**: the character immediately before `@` and the character immediately after the match, when present, must both be outside the GitHub login continuation set `A-Z a-z 0-9 -`. GitHub logins may contain hyphens, so `-` continues a mention rather than ending it: `@{github_slug}-other` and `@{github_slug}bot` never match, and an email-shaped body (`name@{github_slug}.host`) never matches. `@{github_slug}`, the canonical `@{github_slug}[bot]`, `@{github_slug},`, `@{github_slug}.` and a match at either end of the body all match (`[` is not a continuation character, so the `[bot]` suffix needs no separate grammar).
- **No target before the first sync:** `github_slug` is NULL until the first successful metadata fetch, so a comment has nothing to match and no review starts — fail-safe, never a guessed slug. An App renamed on GitHub answers to the new slug from the next refresh (24h TTL, or immediately via the manager's manual refresh), never to the old one.
- **Bare mention:** any position in the body; no required wording. Presence of the mention is the entire grammar — no natural-language interpretation (RL-7 discipline of [review lifecycle](review-lifecycle.md) is preserved).
- **Authorization gate (extended by the bot-author exclusion):** `issue_comment.created` only; the comment must be on a PR thread; `sender.type === "Bot"` is ignored (self-comment loop guard); a PR whose author login ends in `[bot]` is ignored regardless of commenter; only the PR author or the repository owner may trigger; disallowed actors produce the existing structured warn.
- **Guard order:** malformed payloads reject (400) before any author policy on both faces; the PR-thread gate and the bot/missing-author check then run before the mention grammar and the sender guard, so a bot-authored PR never surfaces the unsynced-App `mention_unresolved` diagnose (its reason is the author one, never the mention miss) — with or without a cached slug the outcome is the same ignore. A comment on a plain issue reports the not-a-PR reason rather than the mention miss, so it never emits that diagnose either.
- **Enqueue semantics:** `head_sha = null`, the target's business pause and the bot's operational pause checked before enqueue, and a **durable per-comment claim**. The worker inserts one `comment_trigger_claims` row (`state='queued'`, the full payload, `attempts=0`) into D1 **before** the queue send, keyed by the primary key `(installation_id, owner, repo, pr_number, comment_id)`; a second delivery of the same comment — concurrent, or after the KV claim's 24h TTL lapsed — finds the row already present and is skipped (`duplicate comment trigger`). The KV key `idemc:{installation_id}:{owner}/{repo}:{pr_number}:{comment_id}` remains a 24h fast path only, never the proof. The pipeline consumes the row atomically before any expensive step (`UPDATE … SET state='consumed', consumed_ms=?, payload_json=NULL … WHERE … AND state='queued'`); `changes === 0` acks without running, which turns at-least-once queue delivery into at-most-once execution. A send failure deletes the row so GitHub's retry can claim again; a crash between insert and send is recovered by the cron sweep, which re-sends `queued` rows older than the retry window (bounded batch; the attempt cap flips a row to `expired`, clearing its payload too; the retry window, attempt cap and batch size are global runtime-config settings — `review.comment_claim.*`, absent-row defaults 300000 ms / 3 / 20 — written only through the operator `/runtime` surface, never source constants). A `consumed` row is never re-executed, even when the run failed: a comment-triggered review is re-run by posting a new comment (a new id). A terminal row is a permanent tombstone — payload cleared, scope keys + `state` + timestamps retained, never deleted, because deleting it would let a late redelivery of the same comment re-insert and execute. A payload whose `comment.id` is absent omits `ReviewJobPayload.comment_id` and enqueues unclaimed (fail-safe: a duplicate costs a review, never a lost one); a present-but-invalid id fails the existing malformed-payload gate with 400. The enqueued payload's `triggered_by` is `"issue_comment"`: the `ReviewJobPayload.triggered_by` wire union is `"pull_request" | "issue_comment"` and the `"review_command"` member is removed together with the command; the pipeline-side `review_failures` event label retires `"review_command"` with it.
- **Retirement:** the `/review` prefix constant, its grammar, its tests, and any documentation of it are removed. No compatibility alias, no deprecation window (development-stage clean new-App contract).
- **Operator visibility:** the application detail's 应用设置 tab displays the exact mention string built from the cached `github_slug` (the bare `@{github_slug}` form; a trailing `[bot]` is accepted by the matcher but never required), so operators know what to type; while the cache is NULL the page renders no mention at all rather than a placeholder. The authorization and grammar clauses above are unchanged by this cache — only the source of the slug name is.

### 4. Webhook and membership hardening

- **Webhook body cap (61-R1):** the pre-buffer 413 cap is enforced on streamed bytes read, independent of the client-supplied `content-length` header. The cap applies while reading the request stream — reading past `WEBHOOK_BODY_LIMIT` bytes rejects 413 before the remainder is consumed — never after a full buffered read. The streamed read stays byte-authoritative for signature verification: the accumulated bytes are the exact request body, UTF-8-decoded identically to today's buffered read, so HMAC verification is unchanged. Same `WEBHOOK_BODY_LIMIT` value; a truthful over-limit header may still short-circuit early; headerless/chunked/lying-header requests can no longer buffer past the cap, and oversized requests reject 413 with the existing structured warn.
- **No deployment-level bootstrap input (current):** the former deployment-level admin bootstrap allowlist, its fail-closed pre-deploy gate, its post-deploy settings assertion and its `--var` bind are removed. Sign-in is open: a GitHub-verified login gets a `role = 'member'` row unless it is recorded as removed or the operator has closed the `signup_open` flag — closed means no new row, while a login that already has one signs in unchanged. The deployment operator allowlist (`PLATFORM_OPERATORS`) grants tenant access only through a live `support_grants` row.

- **Admin removal is authoritative (revocation):** removing a member records the login in `removed_logins` (migration `0023`, NOCASE-keyed like `users.github_login`; `removed_at` required, `removed_by` = the acting admin) **in the same transaction** as the `users` row delete — ONE D1 `batch` with the last-admin guard carried by both statements — so a removal can never be recorded without the row actually being gone, a row can never be deleted without being recorded, and a refused (last-admin) removal records nothing. Sign-in precedence is therefore: existing `users` row → allow; recorded removal (deny, zero writes); otherwise create a `member` row and allow, joined to no workspace. An existing row still wins; the allowlist never resurrects a removed login; an explicit re-invite (`createUser`, which clears the record in the batch with its insert) restores normal bootstrap. The automatic path never clears removal state and its insert refuses **at the write boundary**: `bootstrapCreateAdmin` carries `WHERE NOT EXISTS (removal record for the login, NOCASE)` in the same statement as the insert, so a removal landing after the callback's reads still resolves to the ordinary deny (no read-then-insert window to lose). The deny shape (403 page, **zero Set-Cookie**, zero writes) is unchanged and the last-admin removal protection is untouched.

### 5. Non-goals

- Check annotations and check-suite triggers (still deferred in [review lifecycle](review-lifecycle.md)).
- Natural-language comment interpretation, `/review`-family parsing, per-comment sub-commands.
- Old-App migration/compatibility UX for the mode column; implicit database resets.
- Per-installation trigger overrides (none exist); per-repository overrides are the contract above, with the workspace default as their fallback.
- Changes to `mstar.review/v1`, publication faces, or harness skill bodies.

## Invariants

- `/review` has no alias or compatibility window; mention presence is the entire grammar.
- Bot-authored and authorless PRs never trigger; malformed-payload rejection precedes policy gates after action whitelisting.
- The target's business pause, the bot's operational pause and the platform review flag gate enqueue. Terminal comment claims retain permanent tombstones.

## Where it lives

- `src/worker/webhooks.ts`: `classifyWebhook`, `classifyEvent`, `classifyPullRequest`, `classifyIssueComment`, `checkRunSchema`, `classifyCheckRun`.
- `src/worker/index.ts`: streamed-body cap, target resolution by repository, pause gates and durable comment claim/enqueue; `check_rerun` → `review_checks` resolution via `findCheckAttemptByRunId` and the job merge (`resolveCheckRerunOutcome` maps the unresolved arm to `ignored`; the delivery's own owner/repo win over the row's historical names).
- `src/store/review-checks.ts`: `findCheckAttemptByRunId` — the `(github_app_id, check_run_id)` attempt lookup.
- `src/contracts/review-job.ts`: `ReviewJobPayload`.
- `src/contracts/idem.ts`: `rerunIdemKey`, `kvClaimKey` — the rerun's KV claim dimension (`reviews.id`/`parseIdemKey` keep the strict five-part key).
- `src/dashboard/index.ts`: the target and defaults settings routes, OAuth bootstrap and removal; `src/dashboard/targets-store.ts`: `readEffectiveTargetSettings`.
- `migrations/0022_app_trigger_mode.sql`, `migrations/0023_removed_logins.sql`, `migrations/0048_comment_trigger_claims.sql`, `migrations/0067_repo_target_identity.sql` (target columns and workspace defaults), `migrations/0109_check_run_id_index.sql` (`idx_review_checks_app_run`, the rerequested lookup), `migrations/0110_review_checks_open_head_index.sql` (`idx_review_checks_open_head`, the supersede probe's nonterminal head): storage contracts.
- `src/admin/index.ts`: operator runtime settings for `review.comment_claim.*`.

## Change obligations

Keep the mode/event/actor/author matrix, mention boundaries, guard precedence, claim lifecycle and wire labels synchronized with classification/pipeline tests. Body-cap coverage includes truthful/lying headers, headerless chunking, and at-limit acceptance. Membership tests preserve last-admin protection and zero-cookie/zero-write denial.

Decision history: [bare mention](../../../.agents/adr/implemented/feature/2026-09-17-bare-bot-mention.md).
