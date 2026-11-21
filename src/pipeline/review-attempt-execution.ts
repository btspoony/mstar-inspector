/**
 * Review attempt execution — the five phases of one admitted review attempt.
 *
 * Layering: `consumer` (admission, dedupe, skip settlement) → this module
 * (prepare → review → collect → publish, plus failure settlement and cleanup)
 * → `review-attempt` (container provisioning and the paid launch).
 *
 * ## The phase rule
 *
 * **A phase may hold live objects internally; its input and output are data.**
 * Anything that crosses a boundary is JSON — durable identifiers, plain
 * record, arrays — never a `Set`, a promise, a live sandbox, a lease or a
 * credential. A phase that needs a live object re-derives it from `deps` (the
 * host channel: the App adapter, the sandbox factory, the delivery's resolved
 * runner config, the invocation's credential cache) plus that data; everything
 * the boundary must not lose is read back from its durable carrier. That is
 * what lets a restart resume at any boundary: the inline route and a resumed
 * Workflow step compose the same five calls, and a resumed step re-derives
 * exactly what the previous invocation held in memory.
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  classifyGithubRateLimit,
  GITHUB_PRIMARY_RATE_LIMIT_PREFIX,
  GITHUB_RATE_LIMIT_PREFIX,
} from "../contracts/failure-stages";
import {
  idemKey,
  IDEMPOTENCY_SECONDS,
  IDEM_DEGRADED,
  IDEM_DONE,
  IDEM_FAILED,
  putAbandonClaim,
  type IdempotencyKey,
} from "../contracts/idem";
import { dropAllSuggestionFences, parseReviewOutput, capFindings, clampFindingSizes } from "../review/schema";
import type { BudgetExhaustedOutcome, ReviewFinding, ReviewOutput } from "../review/schema";
import type { ReviewLevel } from "../../packages/shared/src/runtime";
import { redactExactSecrets, redactReviewOutput, redactReviewOutputExact, redactSecrets } from "./redact";
import { type D1ArtifactStore } from "../store/artifact-store";
import { type FailureStage, type FailureStore } from "../store/failure-store";
import {
  hasUsageEventForExecutionToken,
  recordUsageEvent,
  type UsageSource,
} from "../store/usage-store";
// The cost model the ledger charges: `rpFor` from the profile judging this
// month (D5), so a started review is priced by the same configuration the
// enqueue's ceiling check read.
import { quotaMonth, resolveQuotaProfile, rpFor } from "../store/quota-store";
import { computeFindingFingerprint } from "../store/fingerprint";
// The hand-off's two fenced writes live in the Check registry (§7.9/§7.11.2):
// linking the publication the probe found, and releasing the claim to recovery.
import {
  CHECK_BACKOFF_MS,
  attemptKey,
  deferCheckRecovery,
  readCheckIdentity,
  readOpenCheckIdentityForKey,
  linkCheckPublication,
  recordTerminalizeOutcome,
} from "../store/review-checks";
import {
  deliveryKeyOf,
  markAttemptSettled,
  recordSuccessorIntent,
  settlementObligationsOf,
  successorIntentOf,
  type SettlementEffect,
} from "../store/review-route-store";
import {
  applyPublishedLifecycle,
  claimPublication,
  countRecheckableFindings,
  findPublicationJournal,
  hasUnprovenDegradedPublication,
  PUBLICATION_HANDOFF_PHASES,
  markPublicationFailed,
  recordPublicationProof,
  readPublication,
  selectAssessmentTargets,
  stagePublication,
  type Lease,
  type LineIntent,
  type LifecycleRound,
  type PublicationPayload,
  type PublicationRow,
  type VerifiedResolution,
} from "../store/finding-lifecycle";
import {
  ASSESSMENT_TARGET_CAP,
  RECHECK_ASSIGNMENT_PROSE_BYTES,
  RECHECK_STATUS_ERROR_MAX_CHARS,
  type Assessment,
  type Coverage,
  type Discussion,
  type EvidenceSlice,
  type RecheckDoc,
  type RecheckInput,
  type RecheckStatus,
  type RecheckTarget,
  type Scope,
} from "../../packages/shared/src/recheck-wire";
import { BODY_TRUNCATED_SUFFIX, boundDiscussion } from "./discussion-context";
import { buildLineIntent, sha256Hex } from "./review-threads";
import { type RetentionProof, type ReviewSandbox } from "./sandbox";
import type { ShellCommand } from "./shell-command";
import {
  BudgetExhaustedError,
  RoundBudgetSpent,
  STDERR_TAIL_MAX,
  attemptSandboxId,
  boundedStepTimeout,
  chainHeadSelector,
  effectiveModelChain,
  mintSandboxReadToken,
  parseBoundedRead,
  prepareReviewAttempt,
  readReviewLaunch,
  recordReviewFailure,
  abandonReviewLaunch,
  launchVerdict,
  readAttemptIdentity,
  freezeAttemptIdentity,
  type AttemptIdentity,
  checkKeyOf,
  MovedHeadError,
  noLaunchState,
  noteCheckOwed,
  runReviewAttempt,
  AttemptUnknownError,
  discardReviewAttempt,
  type ReviewAttemptExecution,
  type ReviewAttemptProgress,
  type RunnerAppConfig,
} from "./review-attempt";
import {
  CLONE_DIR,
  compareGateCommand,
  DIFF_PATH,
  fetchDepthOneCommand,
  gitTransportEnv,
  incrementDiffCommand,
  isApiSha,
  isDiffTooLarge,
  issueViewCommand,
  localDiffCommand,
  mergeBaseCommand,
  parseCompareGate,
  prBodyCommand,
  pullRequestBaseRefCommand,
} from "./gitops";
import {
  PR_CONTEXT_MAX_CHARS,
  PR_CONTEXT_MAX_ISSUES,
  type PrContext,
} from "../../packages/shared/src/report-wire";
import {
  buildPreparedDegradedBody,
  buildPreparedReviewBody,
  buildPublicationMarker,
  buildRevalidatedSection,
  filterLineCommentFindings,
  PreparedSendRejected,
  PublicationDeadlineSpent,
  renderLineCommentText,
  type ClosureRow,
  type CommenterEnv,
  type ReviewCommenter,
  type UpsertPlan,
} from "./comment";
// Per-App credential resolution (lock L4): the consumer is a
// sanctioned reader of the dashboard store leaves (apps-store reads the
// review_bots row, secretbox decrypts the PEM) — the dashboard ↛
// pipeline/worker isolation is one-directional and unaffected.
import { createTargetsStore } from "../dashboard/targets-store";
// The operator default review depth (migration 0047 pairing): read ONLY when
// the target row's `review_level` is NULL, through the same runtime-config leaf
// the admission settings use.
import { getRecheckAssignmentMaxBytes } from "../dashboard/runtime-config-store";
// Per-App AI-config resolution: the same sanctioned reader
// edge — app-config-store reads bot_provider_keys / bot_model_config and
// decrypts keys via secretbox (itself a zero-dependency leaf, lock L1).
import { type CustomProviderConsumerConfig } from "../dashboard/app-config-store";
// §7.10 Check seam implementation: `checks.ts` owns the
// adapter AND the lifecycle it drives; this module owns the seam call sites.
import {
  CHECK_SUMMARIES,
  createCheckBeginLatch,
  type CheckBeginLatch,
  type CheckPromotion,
  type CheckTerminalOutcome,
} from "./checks";
// Review admission (review-concurrency §1.2): one `review_inflight` row is the
// per-PR lock and the capacity reservation; the cap comes from the pipeline's
// single runtime-config reader (never a dashboard route import).
import { releaseInflight, type InflightKey, type InflightRefusal } from "../store/inflight-store";
import { type DegradedReason } from "./concurrency-reader";
import {
  CHECK_TERMINALIZE_DEFAULT,
  CHECK_UPDATE_DEFAULT,
  type CheckBudgets,
} from "./check-budgets-reader";
// The attempt budget: the reserve ledger and the single runner-budget
// derivation. The Check store imports the same module, so neither side owns a
// second copy of the arithmetic.
import {
  anchorRunnerBudget,
  CHECK_HOOK_TIMEOUT_MS,
  deriveReviewBudget,
  EXEC_TIMEOUT_GIT_MS,
  INLINE_RESOLVE_BUDGET_MS,
  POST_RUNNER_READ_BUDGET_MS,
  runnerTimeoutMs,
  parseNumstatSize,
  requestRunnerBudget,
  type ReviewBudget,
} from "../review-budget";

export type PipelineEnv = {
  DB: D1Database;
  IDEMPOTENCY_KV: KVNamespace;
  SANDBOX: unknown; // binding shape = DurableObjectNamespace<SandboxV1> (pinned; the adapter casts)
  /**
   * Envelope master key for the per-App credential resolution (lock L4):
   * base64 of exactly 32 bytes (the same DASHBOARD_ENCRYPTION_KEY
   * Worker secret the dashboard write face uses, src/dashboard/secretbox.ts).
   * Missing / malformed → SecretboxKeyError → per-App resolution fails
   * closed (structured error + the existing retry/DLQ semantics, zero GitHub
   * writes). This face reads the key only — the consumer never encrypts.
   */
  DASHBOARD_ENCRYPTION_KEY?: string;
  /**
   * AL-24-5 (zero global fallback): provider keys and the model chain NEVER
   * come from the Worker env — OMP_MODEL_KEY / OMP_REVIEW_MODEL / the 18
   * per-provider key fields were retired. Every key and the chain resolve
   * from the App's own per-App config (resolveAppConfig keys map +
   * modelChain, custom declarations); an App missing either fails closed
   * (assertAppConfigComplete → F-001 channel). The review depth is per target
   * too (`review_targets.review_level`, falling back to the operator default in
   * `review_runtime_settings`) — this env carries no deployment-wide level.
   */
};

/**
 * Inline resolution admission (§7.11.1's thread-lane discipline applied to
 * the fast path, P67-QC-017). The inline lane runs AFTER the paid review in a
 * queue message that already spent most of its wall clock, so it must not
 * fan out unbounded sequential GitHub work: at most this many entries start,
 * each with its own slice of the budget, and everything else stays `pending`
 * for M8 — which owns long convergence with proper backoff.
 */
export const INLINE_RESOLVE_MAX_ENTRIES = 3;
/**
 * Discovery bound for the associations a round must bind BEFORE its discussion
 * capture (§7.5/§7.8): at most this many sequential GitHub lookups per message,
 * the rest stay unbound for a later round — same admission discipline as the
 * inline resolve lane above.
 */
export const BIND_UNBOUND_THREADS_MAX_ENTRIES = 5;
/** Per-entry slice (ms) — one §7.5 discover + resolve must fit inside it. */
export const INLINE_RESOLVE_ENTRY_MS = 6_000;

/** The named causes of a failed PR-context capture (`ConsumerLogFields.report_context`). */
export type ReportContextFailure = "pr-view" | "pr-view-json" | "issue-view" | "issue-view-json" | "budget";

/**
 * Why the oversized-diff fallback produced no capture
 * (`ConsumerLogFields.diff_fallback`). Each name is a distinct operational
 * fact: an admission decline is not a step failure, an exit-0 answer that is
 * not a sha is not an exec failure, and a hostile ref refused by a builder
 * guard is not a sandbox transport fault.
 */
export type DiffCaptureDeclineReason =
  | "budget"
  | "step-timeout"
  | "base-ref-empty"
  | "merge-base-empty"
  | "merge-base-unreadable"
  | "fetch-exit"
  | "local-diff-exit"
  | "guard-rejected"
  | "transport";

/** Where the fallback stopped, and the exec result the step ended with. */
type DiffCaptureDecline = {
  reason: DiffCaptureDeclineReason;
  /**
   * The step the attempt stopped at; `admission` only for the round-budget
   * refusal, which has no step. A guard refusal names the step whose command
   * was never built.
   */
  step: string;
  /** The step's exec result; absent when no exec ran (budget / timeout / guard). */
  run?: { stdout: string; stderr: string; exitCode: number };
};

/** Structured log fields: seven event fields + sandbox id + idempotency key
 * + the d5-budget visibility quartet (level / runner_timeout_ms /
 * elapsed_ms / orchestration — spec d5-budget L5: they ride THIS channel;
 * no new APM, no webhook sink). */
export type ConsumerLogFields = {
  /**
   * `pull_request` / `issue_comment` — the trigger that produced the job
   * (spec review-trigger-policy §3: the comment trigger is the bot mention;
   * the retired command's label went with it).
   * `review_paused` (architect lock L4 — union widened ADDITIVELY):
   * the ack-skip line for a paused App's in-flight message; it overrides the
   * trigger fields' event on that one log line.
   * `review_superseded` (union widened ADDITIVELY, same shape as
   * `review_paused`): the ack-skip line for a delivery the PR ledger has
   * overtaken — the outcome label an operator greps for a review that never
   * ran, instead of filtering the trigger label down by `reason`.
   * `review_concurrency_degraded` (the review-concurrency cutover, 2026-11 —
   * union widened ADDITIVELY): the
   * concurrency reader's degraded-read warn, relayed on this channel.
   * `review_check_budgets_degraded` (same channel, spec §7.10): the check-budget
   * reader's degraded-read warn.
   * `review_attempt_cap_degraded` (same channel): the end-to-end attempt cap's
   * degraded read — the delivery is retried so no attempt runs under a cap the
   * platform invented.
   * `review_level_degraded` (same channel, migration 0047): the operator-default
   * review-level read's degraded warn — a corrupt row falls back to `default`
   * and says so here instead of degrading silently.
   * `review_recheck_assignment_degraded` (same channel): the recheck seat's
   * ask-budget read's degraded warn — a corrupt row falls back to the runner's
   * documented budget and says so here.
   * `review_no_increment` (union widened ADDITIVELY): an incremental round whose
   * `base...head` is genuinely empty — the prior round already covers this head,
   * so the delivery is acked without a new review body.
   * `review_no_diff` (union widened ADDITIVELY): a first round whose diff FILE
   * holds no patch — the head adds no changes at all, so the delivery is acked
   * without a new review body rather than failing the sandbox stage.
   * `check_terminalize_budget_exceeded` / `check_terminalize_failed` /
   * `check_abandon_released` / `check_abandon_not_owned` /
   * `check_abandon_failed` (spec §7.10/§7.11, union widened ADDITIVELY): the
   * consumer gave the attempt up and handed it to the Check recovery lane.
   * `check_abandon_released` = the fenced release changed the row;
   * `check_abandon_not_owned` = it changed nothing because the attempt is no
   * longer ours (recovery claimed it, the lease expired, or it already ended) —
   * a legitimate no-op, not a fault; `check_abandon_failed` = the hand-off
   * itself faulted (a store error). The publication hand-off (§7.7 step 2)
   * emits only the two REFUSAL values: `check_abandon_not_owned` when either
   * fenced write (link, release) changed nothing, and `check_abandon_failed`
   * when a write threw — the message names which write refused. A COMPLETED
   * hand-off has no event of its own; its only line is the info above it
   * ("publication journal hit"), printed before the link.
   * `check_in_progress_failed` (union widened ADDITIVELY): the best-effort
   * promotion of a delivery-created (`queued`) run to `in_progress` failed or
   * ran out of budget — the review itself is unaffected.
   * `review_recheck_no_fit` (same channel, additive): the round's smallest
   * possible ask — the assignment's prose plus one finding's fixed fields plus
   * the discussion, with no body and no catalog — overruns the operator's byte
   * budget, so nothing is sent. It names both figures and is NOT a seat skip:
   * no seat was started.
   * `maintenance_defer` (same channel, additive): the invocation found the
   * platform closed (D20) and deferred the whole batch instead of running it —
   * one line per invocation, not per message.
   * `review_workflow_create_ambiguous` / `review_moved_head_successor` /
   * `review_moved_head_no_successor` / `review_successor_enqueue_failed`
   * (union widened ADDITIVELY, the Workflow route): the queue's hand-off could
   * not confirm the instance (the instance may exist — acked, never retried,
   * and the handoff row stays for recovery), and the moved-head path recorded
   * the observed head in the successor outbox (or named why it could not).
   */
  event: "pull_request" | "issue_comment" | "review_paused" | "review_superseded" | "review_concurrency_degraded" | "review_check_budgets_degraded" | "review_attempt_cap_degraded" | "review_level_degraded" | "review_recheck_assignment_degraded" | "review_recheck_no_fit" | "review_no_increment" | "review_no_diff" | "review_unresolved" | "sandbox_teardown_unproven" | "check_terminalize_budget_exceeded" | "check_terminalize_failed" | "check_abandon_released" | "check_abandon_not_owned" | "check_abandon_failed" | "check_settlement_not_adopted" | "check_settlement_owed" | "review_moved_head" | "check_skip_settle_failed" | "check_queued_relabel_failed" | "check_in_progress_failed" | "maintenance_defer" | "review_workflow_create_ambiguous" | "review_moved_head_successor" | "review_moved_head_no_successor" | "review_successor_enqueue_failed";
  action: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  sandbox_id?: string;
  /** review_bots.id the job resolves to (per-bot jobs only). */
  app_id?: string;
  /** review_targets.id the job's configuration came from (per-bot jobs only). */
  target_id?: string;
  /**
   * The queue binding the deferred batch arrived on (`maintenance_defer` only —
   * the window names the queue it deferred, not just the PR).
   */
  queue?: string;
  /** Deliveries the deferred batch carried (`maintenance_defer` only). */
  batch_size?: number;
  idempotency_key?: string;
  /**
   * review_checks.id — the Check attempt row a line is about, and the only
   * join key a give-up line carries: that row owns the remote run id.
   */
  attempt_id?: string;
  /**
   * Why the consumer stopped waiting on the Check hook (§7.10 give-up) — the
   * free-form detail, distinct from `reason`'s closed admission vocabulary.
   */
  check_reason?: string;
  /** Whether a refused settlement adoption could name a live row to hand over. */
  check_recovery_owed?: boolean;
  /**
   * The metered ledger identity (`usage_events.review_id`) and its workspace.
   * Carried on the usage-write failure lines so a dropped attempt can be
   * reconciled from logs as well as from the `usage` failure row.
   */
  review_id?: string;
  workspace_id?: string;
  /** The degraded concurrency read's cap (always the conservative 1 when degraded). */
  effective?: number;
  /** The degraded recheck ask-budget read's value (the runner's documented default). */
  max_bytes?: number;
  /**
   * The `review_recheck_no_fit` pair: the operator's ask budget for that round
   * and the bytes the SMALLEST document it could build still needs (the ask's
   * prose, one finding's fixed fields and the discussion — no body, no
   * catalog). Together they say whether the budget or the ask is the limit.
   */
  assignment_max_bytes?: number;
  required_bytes?: number;
  /** Selected-row count on a round-level line (`review_recheck_no_fit`). */
  selected?: number;
  /**
   * Why a degraded settings read answered conservatively — the runtime-config
   * store's cause (`read-failed` / `malformed` / `untrusted`), relayed by the
   * concurrency and check-budget readers. Its own key because `reason` here is
   * the closed admission vocabulary.
   */
  degraded_reason?: DegradedReason;
  /**
   * Review admission (§1.3): WHY the in-flight guard held this message —
   * `pr-held` (this PR already has a live review), `system-cap` /
   * `workspace-cap` (that capacity bound was reached), or `error` (the
   * storage decision failed and fail-closed refused). Set on the guard-held
   * lines only.
   * `superseded` is the ONE non-admission value: the ledger already holds a
   * newer commit for this PR, so the delivery was acked before the guard,
   * the config gate and any container (never a retry, never a failure row).
   */
  reason?: InflightRefusal | "superseded";
  /**
   * On a `superseded` line only: the ledger's newer `head_at` that overtook
   * this delivery, so an operator can explain the missing review without a
   * second query.
   */
  superseded_by_head_at?: string;
  /** The system-wide cap the refusal was measured against (the admission-time read). */
  system_cap?: number;
  /** The workspace's own cap at that same decision — both ride the line so an
   * operator can tell a busy tenant from a full deployment. */
  workspace_cap?: number;
  /**
   * Only on an `error` refusal: the storage cause. A dead D1 binding and a
   * capacity released between the two admission statements share the refusal
   * code, and this string is what tells them apart on the log line and in the
   * terminal drop's `review_failures` row.
   */
  error_cause?: string;
  /** Whether a failed usage insert landed: true, false (verified absent), or unreadable. */
  usage_applied?: boolean | "unknown";
  /** Review depth resolved for this message (the App row, else the operator default). */
  level?: ReviewLevel;
  /** Runner wall-clock ceiling for `level` (ms) — runnerTimeoutMs(level). */
  runner_timeout_ms?: number;
  /** The tier request the anchor planned (ms) — the derivation's requested budget. */
  runner_requested_ms?: number;
  /** `min(request, cutoff - anchor)` (ms): what the exec actually received. */
  runner_effective_ms?: number;
  /** The absolute pre-runner cutoff the effective value was capped against. */
  runner_cutoff_ms?: number;
  /** The absolute instant the input write, the wire deadline and the exec all end at. */
  runner_deadline_ms?: number;
  /** The diff-size estimate the request was sized from (null: size unknown → tier max). */
  runner_work_units?: number | null;
  /** Runner exec elapsed wall-clock (ms) — set on runner-attempt log lines. */
  elapsed_ms?: number;
  /** Runner orchestration: deep = parent session; quick/default = Bun fan-out. */
  orchestration?: "bun-fanout" | "parent";
  /**
   * Per-App key assembly (per-App messages only): the provider id
   * (a PROVIDERS key) the key_source field refers to. An id, never a
   * credential — key material is NEVER logged.
   */
  provider?: string;
  /**
   * Which source supplied `provider`'s key for the runner env: the App's own
   * per-App BYOK config ("app") or a custom-provider declaration keyed by
   * provider id ("custom" — AL-23-1). AL-24-5: the former
   * "global" source was retired with the zero-global-fallback cutover —
   * there is no Worker-env key to fall back to.
   */
  key_source?: "app" | "custom";
  /**
   * The runner env's config source for a per-App message: ALWAYS "app" —
   * keys and the model chain come only from the App's own config
   * (AL-24-5 zero global fallback; the "fallback" variant was retired with
   * the global env surface).
   */
  config_source?: "app";
  /**
   * AL-3: the line-comments createReview FAILED after the
   * overall comment landed (residual 422 position validation or any other
   * Octokit error) — the review degraded to overall-comment-only for this
   * round. The overall comment + D1 row + KV done are unaffected.
   */
  line_comments_fallback?: boolean;
  /**
   * Bugbot round-2 fix: the degraded-comment cleanup outcome on the success
   * path — how many stale bot-authored `review-degraded:v1` comments were
   * deleted vs skipped (403/404 foreign/already-gone, or any other
   * per-match error). Counts, never content; the error messages ride the
   * warn line's message text.
   */
  degraded_delete_deleted?: number;
  degraded_delete_skipped?: number;
  /**
   * S-3 / qc3 F-003: the previous-round fingerprint query
   * THREW — repeat dedup degraded to first-round semantics (empty set).
   * Set only on the dedup-failure warn; an empty previous round is silent.
   */
  dedup?: "degraded";
  /**
   * Recheck round attribution (§7.8): the seat's own status outcome
   * (`ok` / `skipped` / `failed`, or `absent` when no status document was
   * written), its reason, the redacted error, the rows the gate rejected and
   * the rows the document actually assessed. Present on the round's single
   * accounting line.
   */
  recheck_outcome?: RecheckStatus["outcome"] | "absent";
  recheck_reason?: string | null;
  recheck_error?: string | null;
  rejected?: number;
  /**
   * Unnamed gate drops the status claimed beyond the rows that could
   * legitimately have produced them (sent, unanswered, unnamed). Ignored, and
   * counted here so a seat-authored overcount is visible rather than silent.
   */
  rejected_unnamed_ignored?: number;
  assessed?: number;
  /**
   * Set on the diff-capture warn, naming WHY the captured text cannot prove a
   * row: `empty` (the exec exited 0 and delivered nothing while the same
   * round's numstat shows a diff — a capture failure), `overflow` (the diff
   * exists but is over DIFF_PREFETCH_MAX_BYTES) or `unreadable` (the sandbox
   * reply carried no flag line — the command itself always terminates one, so
   * this can only be a broken transport). All three make the round's recheck
   * context unavailable; none is published as `no-evidence`.
   */
  diff_capture?: "empty" | "overflow" | "unreadable";
  /**
   * Set on the oversized-diff line: `gh pr diff` refused the PR (GitHub's
   * 20,000-line API ceiling) and the captured diff came from the clone's
   * merge-base..head diff instead. The capture then takes the ordinary
   * bounded-read path, so `diff_capture` keeps its failure-only meaning.
   */
  diff_source?: "oversized-local";
  /**
   * Set on the fallback's ONE decline warn: why the oversized-diff capture
   * produced nothing, and the step it stopped at. `budget` / `step-timeout`
   * declined before that step's exec ran, `guard-rejected` is a hostile
   * ref/sha refused before it reached a shell string, `merge-base-unreadable`
   * is an exit-0 answer that is not a COMPLETE object id (a truncated reply, or
   * `--jq`'s `null` for an absent field), `transport` is a sandbox fault, and
   * the rest name the step that exited non-zero or answered empty. The message
   * carries that step's exit code and redacted stderr tail; the round's durable
   * failure keeps the ORIGINAL 406.
   */
  diff_fallback?: DiffCaptureDeclineReason;
  diff_fallback_step?: string;
  /**
   * Increment-round diagnostics: the compare gate's answer when the round
   * reviewed the full diff — the verdict (`ahead` is the only one that CAN
   * start an increment round), `unusable` (exit 0 without a readable gate
   * answer) or `ahead-merge` (an ahead range carrying a merge commit or a
   * truncated commit list). The base sha rides the increment capture-failure
   * line.
   */
  increment_status?: string;
  increment_since?: string;
  /**
   * Set when the increment base read itself failed (a D1/schema fault): the
   * round keeps the full-diff fallback, and this is the only trace of it.
   */
  increment_base?: "lookup-failed";
  /**
   * Why the increment capture could not be trusted — `empty` (exit 0, nothing
   * delivered), `unreadable` (no flag line) or `too_large` (the compare API
   * refused the base...head diff, GitHub's 20,000-line ceiling). Its own field,
   * so a full-diff capture failure and an increment capture failure never read
   * alike. `too_large` is the degrade: the message names the step, its exit
   * code and its redacted stderr tail, and the round reviews the full diff.
   */
  increment_capture?: "empty" | "unreadable" | "too_large";
  /**
   * Why the report seat's PR-context capture yielded nothing: `pr-view` (the
   * `gh pr view` exec failed), `pr-view-json` (its reply was not the JSON shape
   * asked for), `issue-view` (one referenced issue could not be read),
   * `issue-view-json` (an issue reply was not that shape) or `budget` (the round
   * no longer had the wall clock the capture costs, so it was skipped). The
   * issue number rides `report_context_issue`. The sections then degrade to
   * `none`.
   */
  report_context?: ReportContextFailure;
  report_context_issue?: number;
  /**
   * Why the seat's report document yielded no sections (the `none` headings):
   * one named cause per rejected read, so a missing narrative is attributable
   * instead of silently absent. `absent` means the read itself proved the seat
   * wrote no document; `unreadable` is a broken read of it, so the two never
   * read alike. `invalid-document` carries the gate's own reason in
   * `report_doc_error`; `stale-head` carries the head the document was bound to
   * in `report_doc_head_sha` (a validated sha, never free text).
   */
  /**
   * The runner's applied-model document read: `absent` is the ordinary
   * no-model-served shape; the rest name a fault that left `reviews.provider`
   * unrecorded (never replaced by the chain head).
   */
  applied_model?: "absent" | "unreadable" | "overflow" | "empty" | "invalid-json" | "invalid-document";
  report_doc?: "absent" | "unreadable" | "overflow" | "empty" | "invalid-json" | "invalid-document" | "stale-head";
  report_doc_error?: string;
  report_doc_head_sha?: string;
  /** The resolved `budget-exhausted` record, on the one `review failed` line the stop emits. */
  budget_outcome?: BudgetExhaustedOutcome;
  /**
   * A sandbox kill's redacted provider stderr tail: untrusted text that rides
   * ONE log line so the durable row can carry only trusted budget fields.
   */
  stderr_tail?: string;
};

export type ConsumerLog = {
  info: (fields: ConsumerLogFields, msg?: string) => void;
  warn: (fields: ConsumerLogFields, msg?: string) => void;
  error: (fields: ConsumerLogFields, msg?: string) => void;
};

/**
 * Outcome of one message pass (bugbot BB-3 + architect lock L4 + AL-1).
 * SIX DISTINCT typed outcomes never throw: a guard-held message
 * is scheduled for a per-message delayed retry and finally acked with a
 * warning — it is never rethrown into the immediate-retry ×3 → DLQ path; a
 * PAUSED message (the App's review_enabled=0) is acked directly after its
 * payload sha's claim is stamped `paused` — no review, no sandbox, never a
 * retry or a DLQ entry (a throw would be the wrong semantics for an operator
 * pause); a DEGRADED message (parse-fail) is acked directly after its
 * best-effort review_failures row + degraded comment and a `degraded` claim
 * stamp — a deterministic model-output failure where retry is deterministic
 * waste; a SUPERSEDED message is acked
 * directly because the ledger already holds a newer commit for its PR; a
 * BUDGET-EXHAUSTED message (the wall clock ended the review) is acked
 * directly after its Check `failure` and `budget-exhausted:` failure row —
 * a confirmed stop is terminal, so another paid delivery can only lose the
 * same clock again; an UNKNOWN message (the attempt's container could not be
 * proven) is acked directly with nothing changed — no result claimed, no
 * failure recorded, no container destroyed, no capacity released. Infra
 * failures keep the existing throw → retry → DLQ behavior (plus the AL-6
 * best-effort failure row before the rethrow).
 */
export type ProcessOutcome =
  | { kind: "ok" }
  /**
   * The admitted attempt was handed to its Workflow instance. The delivery's
   * work is over here: the instance owns every later settlement, so the queue
   * acks and never redelivers into a second attempt.
   */
  | { kind: "routed" }
  /**
   * `heldHeadSha` is the commit the live row was taken for (`null` when the
   * refusal was a cap/storage one, so no row holds this PR): the terminal ack
   * records the drop unless the live review covers this message's own sha.
   */
  | {
      kind: "guard-held";
      admission: AdmissionRefusalFields;
      heldHeadSha: string | null;
      commentClaimConsumed: boolean;
      /**
       * The App's resolved review depth, carried from the same row read that
       * admitted this message: the retry schedule must follow the App, and the
       * ack path runs AFTER processMessage returns — never a second lookup.
       */
      level: ReviewLevel;
    }
  | { kind: "paused" }
  | { kind: "degraded" }
  /**
   * The ledger already holds a NEWER commit for this PR (`pull_requests`
   * migration 0044): this delivery is acked after per-App credential
   * resolution (the paused gate needs it) and before admission, sandbox, Check
   * or publication — no retry, no DLQ, no failure row. The next delivery for
   * the PR reviews the newest commit.
   */
  | { kind: "superseded" }
  /**
   * The wall clock ended the attempt: a `budget-exhausted:` failure row and
   * a Check `failure` already landed inside `processMessage`; the message is
   * acked directly — terminal, so no paid queue retry and no DLQ entry. The
   * typed record rides for the report.
   */
  | { kind: "budget-exhausted"; outcome: BudgetExhaustedOutcome }
  /**
   * The attempt's container could not be proven to be the one it prepared, so
   * its result was not collected. No result was claimed from it, nothing was
   * failed, destroyed or reclaimed: the Check stays `in_progress`, the admission
   * row holds until its TTL and the container is left alone (it may carry the
   * only result). The message is acked — a paid retry could only launch a second
   * attempt on ambiguous acceptance, which is exactly what an unknown outcome
   * forbids.
   */
  | { kind: "unknown" };

/**
 * Why the guard held a message plus the caps it was measured against
 * (spec §1.3: the refusal is otherwise invisible — a held line without the
 * reason cannot tell a busy PR from a full deployment). `error` additionally
 * carries the storage cause, so a D1 fault is never read as the benign
 * released-between-statements race.
 */
export type AdmissionRefusalFields = Required<Pick<ConsumerLogFields, "system_cap" | "workspace_cap">> &
  Pick<ConsumerLogFields, "error_cause"> & {
    /** Narrowed: the guard outcomes never carry the `superseded` skip value. */
    reason: InflightRefusal;
  };

/**
 * §7.9 skip settlement over one delivery's identity: a delivery that ACKs
 * before (or without) a handle leaves its attached run with nobody to
 * terminalize it, so the lifecycle takes that row and concludes it from the
 * head's own persisted review against the App's current gate — `neutral`
 * (with the skip reason) only when there is nothing to inherit.
 *
 * `attachedHeadSha` MUST be the head the delivery ATTACHED with — the payload's
 * own `head_sha`, or the PR watermark a mention carried — never the
 * authoritative checkout SHA: after a force push the checkout names a commit
 * with no attach row, and settling on it would be a silent no-op while the
 * stale run waited out its window. Dedup KEYS still use the checkout SHA; only
 * this settlement identity follows the attach.
 *
 * Best-effort by contract: one warn on a fault, and the caller's ACK/return is
 * never changed. A delivery with nothing to settle is announced only when the
 * caller asks for it (`announceNoOp`): every other caller has already logged
 * WHY it skipped, so a second line would merely repeat the reason — a paused
 * App must log exactly one line.
 */
export async function settleSkippedRow(
  deps: ProcessDeps,
  payload: ReviewJobPayload,
  attachedHeadSha: string | null | undefined,
  reason: string,
  /** Name a no-op settlement (the moved-head path, whose only other line says why). */
  announceNoOp = false,
): Promise<void> {
  if (
    deps.checks?.settleSkipped === undefined ||
    attachedHeadSha === null ||
    attachedHeadSha === undefined ||
    // No attach identity means the delivery attached no run at all (a mention
    // with no SHA the webhook could attach for): the lifecycle would answer
    // `false` silently.
    payload.attachDeliveryId === undefined
  ) {
    if (announceNoOp) {
      deps.log.info(
        payloadIdentityFields(payload),
        `check skip settlement skipped — nothing to settle for this delivery (${reason})`,
      );
    }
    return;
  }
  try {
    await deps.checks.settleSkipped({
      scope: {
        appId: payload.botRef.appId,
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
      },
      headSha: attachedHeadSha,
      triggeredBy: payload.triggered_by,
      action: payload.action,
      // THIS delivery's attach identity: a message whose attach found the key
      // owned (or whose inline budget expired) carries none, so it settles
      // nothing rather than taking another delivery's run (§7.9).
      attachDeliveryId: payload.attachDeliveryId,
      reason,
      warn: (detail) => deps.log.warn(payloadIdentityFields(payload), detail),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { ...payloadIdentityFields(payload), event: "check_skip_settle_failed" },
      `check skip settlement failed (the row is left to the recovery lane): ${detail}`,
    );
  }
}

/**
 * Run one best-effort step under a hard deadline. Resolves `null` when the
 * deadline wins: the step keeps running (a fetch or a D1 statement cannot be
 * cancelled from here) but the caller stops waiting for it. A rejection still
 * propagates — the caller's single catch is what reports it.
 */
export async function boundedBestEffort<T>(step: Promise<T>, budgetMs: number): Promise<{ value: T } | null> {
  const { promise: deadline, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => resolve(null), budgetMs);
  try {
    return await Promise.race([step.then((value) => ({ value })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type CheckHandle = { attemptId: string; scope: Scope; githubAppId: number; headSha: string; lease: Lease };

/**
 * The invocation's lifetime hook: the queue handler passes
 * `ctx.waitUntil` so a terminalize promise that outlives the consumer still
 * finishes. A rejection it sees after the consumer's budget elapsed is
 * reported from the hand-off as a warn, never left as an unhandled rejection.
 */
export type CheckBackgroundSink = { waitUntil(promise: Promise<unknown>): void };

export type CheckLifecycleHooks = {
  begin(input: {
    scope: Scope;
    githubAppId: number;
    headSha: string;
    triggeredBy: string;
    action: string;
    executionDeadlineMs: number;
    /**
     * The per-invocation abandonment latch for THIS call: the
     * consumer trips it when its §7.10 budget elapses, and a lifecycle that
     * reads it stops attaching on behalf of a caller that is gone. Optional and
     * additive — an implementation may ignore it, and the field is never shared
     * or reset across invocations.
     */
    latch?: CheckBeginLatch;
  }): Promise<CheckHandle | null>;
  /**
   * §7.9 status truthfulness (optional, additive): the run was created
   * `queued` at delivery acceptance, so the review's own begin is what makes
   * the public status `in_progress`. A settled answer means the send is over
   * (landed or cleanly refused); `abandoned` means its budget ended the wait
   * while the PATCH may still be in flight, so the terminalize below must hand
   * the attempt to recovery instead of writing over a run it could still
   * reopen. A hook that cannot reach a Checks surface simply omits this.
   */
  markInProgress?(input: {
    handle: CheckHandle;
    /** The one text the promoted run carries. */
    summary: string;
    /** `review.check.update_timeout_ms` — its own bound, not the begin hook's. */
    updateBudgetMs: number;
    /** One warn when the best-effort send failed or ran out of budget. */
    warn: (detail: string) => void;
  }): Promise<CheckPromotion>;
  terminalize(input: { handle: CheckHandle; publicationId: string | null;
    outcome: CheckTerminalOutcome;
    /**
     * The reviewed head an EMPTY increment inherits: the Check carries that
     * head's result against the current gate instead of a free-standing
     * `neutral`; an unreadable baseline fails closed. Omitted → nothing to
     * inherit.
     */
    inheritedHeadSha?: string;
    /** Required with `outcome: "budget-exhausted"`: this attempt's typed stop record — the frozen Check summary's budget facts. */
    budgetExhaustion?: BudgetExhaustedOutcome;
    /** The operator-configured bound on the terminal `checks.update` (spec §7.10). */
    updateBudgetMs: number }): Promise<void>;
  /**
   * §7.10 give-up handoff (optional, additive): the consumer stopped waiting
   * on `terminalize` — its budget elapsed, the hook threw, or the checkout
   * contradicted the claim. The lifecycle freezes a terminal intent ONLY when
   * none is frozen (the predicate is in the UPDATE, so a concurrent
   * terminalize's text wins) and releases the lease to recovery WITHOUT a
   * remote request, so the minute reconciler closes the run instead of waiting
   * out the execution deadline. The frozen fallback is ONLY what the caller
   * already knew: an outcome-only conclusion (`superseded`, `local-error`,
   * `pre-publication-failure`) or, for `skipped`, the inherited head's gate
   * result — never a blanket `unconfirmed` over a decided result. It is not the
   * proof-derived conclusion (`publication-unknown`, `expired`,
   * `degraded-not-posted` carry no proof here); the recovery lane re-reads the
   * proof as the last writer and corrects it. An `abandoned` promotion's
   * handoff also carries `firstRecoveryDelayMs`, so recovery writes only after
   * that request can no longer land. Resolves
   * `true` only when the fenced release changed the row — a lease recovery
   * already claimed, or an expired lease, changed nothing and resolves
   * `false`; a store fault rejects.
   */
  abandonTerminalize?(input: {
    handle: CheckHandle;
    reason: string;
    /** The terminal knowledge this hand-off carries; omitted → `unconfirmed`. */
    outcome?: CheckTerminalOutcome;
    /** Required with `outcome: "budget-exhausted"`: the same record the terminal path carries. */
    budgetExhaustion?: BudgetExhaustedOutcome;
    /** Set with `outcome: "skipped"`: the head whose result the run inherits. */
    inheritedHeadSha?: string;
    /** Delay this row's first recovery attempt past an abandoned send's lifetime. */
    firstRecoveryDelayMs?: number;
  }): Promise<boolean>;
  /**
   * §7.9 skip settlement (optional, additive): the delivery ACKs before (or
   * without) a handle — an idempotency hit, a publication-journal hand-off, an
   * in-flight guard rejection, a paused App — so its attached run has nobody to
   * terminalize it. The lifecycle takes that row and concludes it from the
   * head's own published result against the App's current gate — `neutral`
   * with the skip reason only when there is nothing to inherit. `false` means
   * there was nothing to settle; a fault rejects and the caller logs it.
   */
  settleSkipped?(input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    /** THIS delivery's attach identity — absent means it created no row. */
    attachDeliveryId?: string;
    reason: string;
    /** One warn when the proof cannot be parsed (fallback) or read (nothing settled). */
    warn?: (detail: string) => void;
    updateBudgetMs?: number;
  }): Promise<boolean>;
  /**
   * §7.10 held-Check visibility (optional, additive): the in-flight guard
   * refused this delivery while its Check was already attached. The run is
   * created `queued` at delivery acceptance, so the relabel adds which live
   * review holds the slot — the status stays `queued` and only the text moves.
   * Best-effort: `false` means there was nothing to label, a fault rejects, and
   * neither changes the retry outcome.
   */
  markQueuedBehindInflight?(input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    attachDeliveryId?: string;
    summary: string;
    /** `review.check.update_timeout_ms` — the relabel sits before this path's retry. */
    updateBudgetMs: number;
    /** One warn when the best-effort send failed or ran out of budget. */
    warn: (detail: string) => void;
  }): Promise<boolean>;
};

/**
 * §7.3 catalog budget: "Diff capture plus catalog is bounded to 256 KiB; at
 * most 4 slices per target, 80 lines/8 KiB per slice." Oversized evidence is
 * excluded (no eligible slice), never silently truncated.
 */
const RECHECK_CATALOG_MAX_BYTES = 262_144;
const RECHECK_SLICE_MAX_LINES = 80;
const RECHECK_SLICE_MAX_BYTES = 8 * 1024;
const RECHECK_SLICES_PER_TARGET = 4;
/** §7.3 input cap: oversized whole targets are excluded with coverage. */
const RECHECK_INPUT_MAX_BYTES = 512 * 1024;
/** The wire schema this consumer serializes (measured and written as one). */
const RECHECK_INPUT_SCHEMA = "mstar.recheck-input/v1";

/**
 * Await a promise with the relevant §7.10 hook budget as a hard consumer-side
 * bound. The bound is on the CONSUMER's wait, not on the hook's work: a hook
 * that settles late keeps running detached — this guard creates no AbortSignal
 * (the locked seam exposes none), so a late create can still complete durably
 * on its own, but `onBudgetElapsed` fires at the instant this invocation gives
 * up on it, which is what lets the lifecycle stop attaching a run on behalf of
 * a caller that is no longer waiting. `budgetMs` is REQUIRED — the two cases
 * differ by an order of magnitude (`CHECK_HOOK_TIMEOUT_MS` for begin, the
 * operator-configured `review.check.terminalize_timeout_ms` for terminalize)
 * and neither may silently inherit the other's bound. The consumer never waits
 * past it; a rejection that lands after the timeout is contained by the
 * caller's hand-off, not left as an unhandled rejection.
 */
async function withHookTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  budgetMs: number,
  onBudgetElapsed?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onBudgetElapsed?.();
      resolve(fallback);
    }, budgetMs);
  });
  // A hook rejecting AFTER its timeout won the race must not surface as an
  // unhandled rejection — the failure is already treated as the fallback.
  promise.catch(() => {});
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One JSON.stringify size in UTF-8 bytes (bounded-input accounting). */
function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * `body` cut to at most `length` code units and marked truncated — the same
 * marker a clamped discussion item carries, so the seat reads a short body and
 * never mistakes it for the whole concern. A surrogate pair is never split: a
 * lone half would serialize as a replacement escape and change the bytes the
 * caller's bound was measured on.
 */
function truncatedBody(body: string, length: number): string {
  const cut = Math.max(0, Math.min(length, body.length));
  // Nothing was cut: a body that fits whole must never claim it was shortened.
  if (cut >= body.length) return body;
  const end = cut > 0 && /[\uD800-\uDBFF]/.test(body[cut - 1]!) ? cut - 1 : cut;
  return body.slice(0, end) + BODY_TRUNCATED_SUFFIX;
}

/**
 * §7.7 step 2 journal check: an existing non-terminal publication row for
 * this exact scope/SHA (prepared/sending/unknown/confirmed) hands off to
 * recovery and ACKs — never a second paid review for the same head.
 * Terminal rows (applied/failed/superseded) do not hand off: the D1
 * idempotency check above already covered applied rows, and failed/superseded
 * heads are legitimately re-reviewable on a new trigger.
 */
export async function journalHandoffRow(
  db: PipelineEnv["DB"],
  scope: Scope,
  headSha: string,
): Promise<{ id: string; phase: PublicationRow["phase"] } | null> {
  // The predicate is SHARED with the Check recovery lane's wait-for-proof probe
  // (`findPublicationJournal`); only the phase set differs, because a delivery
  // also hands off a `confirmed` row whose proof is about to be applied.
  return findPublicationJournal(db, { scope, headSha, phases: PUBLICATION_HANDOFF_PHASES });
}

/**
 * §7.7 step 3: apply this scope's pending CONFIRMED journals in original
 * publication order (oldest first) before the lifecycle assessment — an
 * older assessment must never lose to a newer unapplied recurrence. Each
 * row: conditional claim (epoch-fenced) → proof-gated idempotent apply. Any
 * failure leaves that row (and the rest) for M8 recovery and reports false —
 * the caller records context-unavailable and cannot close stale state.
 */
async function applyPendingLifecycleJournals(
  db: PipelineEnv["DB"],
  scope: Scope,
  nowMs: number,
): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT id FROM review_publications
       WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
         AND phase = 'confirmed' AND recovery_state = 'pending'
       ORDER BY created_ms, id LIMIT 10`,
    )
    .bind(scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber)
    .all<{ id: string }>();
  for (const { id } of rows.results) {
    const lease = await claimPublication(db, id, `consumer-journal-apply:${id}`, nowMs);
    if (lease === null) return false;
    let applied = false;
    try {
      applied = await applyPublishedLifecycle(db, id, lease, Date.now());
    } catch {
      return false;
    }
    if (!applied) return false;
  }
  return true;
}

/**
 * The most recent REVIEWED head of this PR, BY THIS APP, whose review was not
 * an `incomplete` (stopped) run and whose own capture did not fail — the base
 * an incremental round diffs against. Both exclusions are on purpose: a stopped
 * round never scanned its scope, and a round whose diff capture failed
 * published a verdict without evidence. Diffing against either would silently
 * inherit that gap.
 *
 * `bot_id` is part of the identity: two bots can review one installation's PRs,
 * and `reviews` is keyed per (installation, owner, repo, pr) without it, so an
 * unfiltered read could hand bot B the head bot A reviewed and skip exactly the
 * commits B never saw. Legacy rows (`bot_id` NULL) predate per-bot attribution
 * and belong to the retired global bot, so no current bot can match them.
 *
 * One row per reviewed sha, and `reviewed_at` is second-resolution, so `rowid`
 * breaks same-second ties in insertion order.
 */
export async function findIncrementBase(db: PipelineEnv["DB"], scope: Scope): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT head_sha FROM reviews
       WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
         AND verdict <> 'incomplete'
         AND context_incomplete = 0
       ORDER BY reviewed_at DESC, rowid DESC
       LIMIT 1`,
    )
    .bind(scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber)
    .first<{ head_sha: string }>();
  return row?.head_sha ?? null;
}

/**
 * Closing/mentioning issue refs the report seat may read (finite vocabulary).
 * Every keyword is accepted bare (`Fix #12`) or colon-prefixed (`Fixes: #12`);
 * the colon must follow the keyword directly, because GitHub does not close
 * from `fix : #12`, and the leading `\b` keeps `unfixes #3` out of the table.
 */
const ISSUE_REF_RE =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|refs?|references?)(?::\s*|\s+)#(\d+)\b/gi;

/**
 * Extract the issue numbers a PR body claims to close or reference. A finite
 * keyword table over the body text; duplicates collapse, order is first
 * appearance, and the list is capped by the caller (`PR_CONTEXT_MAX_ISSUES`).
 */
export function extractIssueRefs(prBody: string): number[] {
  const seen = new Set<number>();
  for (const match of prBody.matchAll(ISSUE_REF_RE)) {
    const issueNumber = Number(match[1]);
    if (Number.isInteger(issueNumber) && issueNumber > 0) seen.add(issueNumber);
  }
  return [...seen];
}

/** Bound untrusted text by characters, marking the cut. */
function clampContextText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[... truncated ...]`;
}

/**
 * Per-call bound for the capture's own `gh` reads (ms). Far below
 * `EXEC_TIMEOUT_GIT_MS` because the capture is best-effort narrative, and each
 * read is further capped by what the DERIVED runner deadline still owes.
 *
 * Budget arithmetic (the attempt's frozen deadline minus the 234_000 ms reserve
 * at the defaults → a 966_000 ms pre-runner cutoff at the 20-minute cap): the
 * gate needs the capture's worst case (1 + PR_CONTEXT_MAX_ISSUES) × 30_000 =
 * 120_000 ms plus the post-runner bounded reads (3 × POST_RUNNER_READ_TIMEOUT_MS
 * = 90_000 ms) still ahead of that cutoff, so it fits on every level — `deep`
 * included, whose 646_000 ms maximum is a ceiling the cutoff never grants in
 * full. Changing any term re-derives the gate.
 */
export const PR_CONTEXT_EXEC_TIMEOUT_MS = 30_000;

/**
 * Worst-case cost of the whole capture: the PR read plus every allowed issue
 * read, each able to consume its full `PR_CONTEXT_EXEC_TIMEOUT_MS` window.
 * 120_000ms at the current cap — the sum the gate reserves before it runs.
 */
export const PR_CONTEXT_WORST_CASE_MS = (1 + PR_CONTEXT_MAX_ISSUES) * PR_CONTEXT_EXEC_TIMEOUT_MS;

/**
 * Capture the PR context the report seat reads: the PR description, then up
 * to `PR_CONTEXT_MAX_ISSUES` issues it closes/references. Every value is
 * clamped — this is attacker-controlled prose that rides into a prompt.
 *
 * Bounded by the DERIVED runner deadline: the capture runs before the paid run
 * and each gh read can consume its whole `PR_CONTEXT_EXEC_TIMEOUT_MS`, so a
 * slow sandbox could spend the window on a narrative. The gate therefore
 * requires that deadline to still cover the worst-case capture AND the
 * post-runner bounded reads, and each read's own timeout is what that deadline
 * still owes — a read that would start past it is skipped, never issued on a
 * fresh window. Only then does the remaining time bound how many issue reads
 * start, so the review itself never carries the cost.
 *
 * Any failure (gh missing, API error, non-JSON output, no budget) resolves
 * `undefined` after ONE warn naming the cause: the report sections then degrade
 * to `none`, which is a smaller loss than failing a review over its narrative —
 * but an unattributed gap is indistinguishable from a PR that simply has no
 * context.
 */
async function capturePrContext(
  sandbox: ReviewSandbox,
  payload: ReviewJobPayload,
  token: string,
  log: ConsumerLog,
  fields: ConsumerLogFields,
  runnerDeadlineMs: number,
): Promise<PrContext | undefined> {
  const warn = (cause: ReportContextFailure, issue?: number): void => {
    log.warn(
      { ...fields, report_context: cause, ...(issue === undefined ? {} : { report_context_issue: issue }) },
      `report context ${cause}${issue === undefined ? "" : ` (issue #${issue})`} — report sections degrade to none`,
    );
  };
  // What the DERIVED deadline still owes one read; null once it is spent, so a
  // read never starts on a fresh window.
  const readBudget = (): number | null => {
    const left = Math.min(PR_CONTEXT_EXEC_TIMEOUT_MS, runnerDeadlineMs - Date.now());
    return left > 0 ? left : null;
  };
  // The capture is spent BEFORE the paid run, and the post-runner bounded reads
  // share the same derived deadline, so both worst cases must still fit ahead
  // of it — a capture that consumed the whole remainder would starve them.
  const remainingMs = runnerDeadlineMs - Date.now();
  const captureBudgetMs = PR_CONTEXT_WORST_CASE_MS + POST_RUNNER_READ_BUDGET_MS;
  if (remainingMs < captureBudgetMs) {
    log.warn(
      { ...fields, report_context: "budget" },
      `report context budget — ${remainingMs}ms left before the derived runner deadline, the capture costs up to ${PR_CONTEXT_WORST_CASE_MS}ms and the post-runner reads ${POST_RUNNER_READ_BUDGET_MS}ms — skipped, report sections degrade to none`,
    );
    return undefined;
  }
  const prTimeout = readBudget();
  if (prTimeout === null) {
    warn("budget");
    return undefined;
  }
  const prRead = await sandbox
    .runCommand(prBodyCommand(payload.owner, payload.repo, payload.pr_number), {
      env: { GH_TOKEN: token },
      timeout: prTimeout,
    })
    .catch(() => null);
  if (prRead === null || prRead.exitCode !== 0) {
    warn("pr-view");
    return undefined;
  }
  let prBody: string;
  try {
    const parsed = JSON.parse(prRead.stdout) as { body?: unknown };
    prBody = typeof parsed.body === "string" ? parsed.body : "";
  } catch {
    warn("pr-view-json");
    return undefined;
  }
  const issues: PrContext["issues"] = [];
  // One gh read may burn its whole window, so the remaining time also bounds
  // how many issue reads start: never more than the deadline can still fund.
  const maxIssueReads = Math.min(
    PR_CONTEXT_MAX_ISSUES,
    Math.floor((runnerDeadlineMs - Date.now()) / PR_CONTEXT_EXEC_TIMEOUT_MS),
  );
  for (const issueNumber of extractIssueRefs(prBody).slice(0, Math.max(0, maxIssueReads))) {
    const issueTimeout = readBudget();
    if (issueTimeout === null) {
      warn("budget");
      break;
    }
    const issueRead = await sandbox
      .runCommand(issueViewCommand(payload.owner, payload.repo, issueNumber), {
        env: { GH_TOKEN: token },
        timeout: issueTimeout,
      })
      .catch(() => null);
    if (issueRead === null || issueRead.exitCode !== 0) {
      warn("issue-view", issueNumber);
      continue;
    }
    try {
      const parsed = JSON.parse(issueRead.stdout) as { number?: unknown; title?: unknown; body?: unknown };
      if (typeof parsed.number !== "number" || typeof parsed.title !== "string") {
        warn("issue-view-json", issueNumber);
        continue;
      }
      issues.push({
        number: parsed.number,
        title: clampContextText(parsed.title, PR_CONTEXT_MAX_CHARS),
        body: clampContextText(typeof parsed.body === "string" ? parsed.body : "", PR_CONTEXT_MAX_CHARS),
      });
    } catch {
      warn("issue-view-json", issueNumber);
      continue;
    }
  }
  return { prBody: clampContextText(prBody, PR_CONTEXT_MAX_CHARS), issues };
}

/**
 * One hunk line: `old`/`new` are its own file line numbers (null when the
 * side has no counterpart), `oldBefore`/`newBefore` the counters BEFORE the
 * line was consumed, and `text` the line content without the diff marker.
 * A sub-window of an oversized hunk states its start lines from these
 * counters, so the arithmetic stays exact against the hunk header.
 */
type HunkLine = { old: number | null; new: number | null; oldBefore: number; newBefore: number; text: string };

/** A parsed unified-diff hunk with its old/new line arrays (evidence raw material). */
type ParsedDiffHunk = {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  lines: HunkLine[];
};

type ParsedDiffFile = {
  path: string;
  oldPath: string | null;
  /** Deleted file (`+++ /dev/null`): absent at HEAD. */
  deleted: boolean;
  oldBlobOid: string | null;
  headBlobOid: string | null;
  hunks: ParsedDiffHunk[];
};

/**
 * Parse a unified diff into per-file hunks (worker-controlled §7.3 trusted
 * capture raw material — never model output). Handles renames (b-side new
 * path), deleted files (`+++ /dev/null`), new files, multiple hunks per
 * file, abbreviated `index <old>..<head>` blob oids, and skips binary files
 * (no hunks). Hunk bodies are consumed by COUNT like parseDiffHunkRanges.
 */
function parseUnifiedDiffFiles(diffText: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let hunk: ParsedDiffHunk | null = null;
  let remainingOld = 0;
  let remainingNew = 0;
  // Running file line numbers for the hunk being read (the header's starts).
  let oldNo = 0;
  let newNo = 0;
  for (const line of diffText.split("\n")) {
    if (hunk !== null && (remainingOld > 0 || remainingNew > 0)) {
      const marker = line.charAt(0);
      const text = line.slice(1);
      if (marker === " " || marker === "-" || marker === "+") {
        hunk.lines.push({
          old: marker === "+" ? null : oldNo,
          new: marker === "-" ? null : newNo,
          oldBefore: oldNo,
          newBefore: newNo,
          text,
        });
      }
      if (marker === " " || marker === "-") {
        hunk.oldLines.push(text);
        oldNo += 1;
        remainingOld -= 1;
      }
      if (marker === " " || marker === "+") {
        hunk.newLines.push(text);
        newNo += 1;
        remainingNew -= 1;
      }
      // "\" ("\ No newline at end of file") consumes neither tally.
      if (remainingOld <= 0 && remainingNew <= 0) hunk = null;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = { path: "", oldPath: null, deleted: false, oldBlobOid: null, headBlobOid: null, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("index ")) {
      const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
      if (match) {
        current.oldBlobOid = match[1]!;
        current.headBlobOid = match[2]!;
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      const target = line.slice(4).trim();
      current.oldPath = target === "/dev/null" ? null : target.startsWith("a/") ? target.slice(2) : target;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current.deleted = true;
        current.path = current.oldPath ?? "";
      } else {
        current.path = target.startsWith("b/") ? target.slice(2) : target;
      }
      continue;
    }
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHeader) {
      hunk = {
        oldStart: Number(hunkHeader[1]),
        oldLines: [],
        newStart: Number(hunkHeader[3]),
        newLines: [],
        lines: [],
      };
      current.hunks.push(hunk);
      remainingOld = hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]);
      remainingNew = hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      if (remainingOld <= 0 && remainingNew <= 0) hunk = null;
    }
  }
  return files;
}

/**
 * Build the §7.3 trusted evidence catalog for the selected targets from the
 * worker-captured diff: per target at most `RECHECK_SLICES_PER_TARGET`
 * slices from its file (nearest the original concern's line first), each
 * bounded to 80 lines / 8 KiB per side, whole catalog bounded to 256 KiB.
 * A hunk that fits becomes ONE slice; an oversized hunk is split into
 * consecutive ≤80-line windows (nearest the original concern first), so a
 * finding inside a large hunk still has provable local evidence instead of
 * losing the whole hunk. A slice still over the per-side line/byte bound is
 * EXCLUDED (no eligible slice), never silently truncated. Deleted files yield
 * one `deleted-file` slice proving absence at HEAD (complete when the hunk
 * starts at old line 1). Every slice is pinned to the capture's anchor:
 * `headSha`/`baseSha` both carry the AUTHORITATIVE checkout SHA the diff was
 * captured for (the worker runs one diff per pinned checkout — the per-file
 * old/new blob oids on each slice carry the finer-grained pins). Returns the
 * slices plus the per-target excluded flags (honest coverage) — split by WHY
 * a target got no slice: no eligible slice exists for it (`excludedTargets`)
 * or its slices exist but the catalog byte budget dropped them
 * (`catalogBudgetExcluded`) — and, for every provable target, the slice ids
 * it references — the input builder keeps only those slices, so a row that
 * never rides the wire leaves no orphan evidence behind.
 */
function buildEvidenceCatalog(
  diffText: string,
  targets: RecheckTarget[],
  captureSha: string,
): {
  slices: EvidenceSlice[];
  excludedTargets: Set<string>;
  catalogBudgetExcluded: Set<string>;
  sliceIdsByRowId: Map<string, string[]>;
} {
  const slices: EvidenceSlice[] = [];
  const excludedTargets = new Set<string>();
  const catalogBudgetExcluded = new Set<string>();
  const sliceIdsByRowId = new Map<string, string[]>();
  if (diffText === "") {
    for (const target of targets) excludedTargets.add(target.rowId);
    return { slices, excludedTargets, catalogBudgetExcluded, sliceIdsByRowId };
  }
  const files = parseUnifiedDiffFiles(diffText);
  let budget = RECHECK_CATALOG_MAX_BYTES;
  const sliceIdByKey = new Map<string, string>();
  const sizeOf = (slice: EvidenceSlice): number => jsonByteLength(slice);

  /**
   * One candidate slice body. `oldStart`/`newStart` come straight from the
   * hunk's own per-line counters, so a window's arithmetic stays exact against
   * the hunk header (the file lines it names are the lines it carries), and
   * `addedNewLines` carries the new-side numbers the hunk ADDED — the material
   * a `current-code` closure must cite at least one of.
   */
  type Draft = {
    file: ParsedDiffFile;
    kind: EvidenceSlice["kind"];
    oldStart: number;
    oldLines: string[];
    newStart: number;
    newLines: string[];
    addedNewLines: number[];
    complete: boolean;
  };

  const windowDraft = (file: ParsedDiffFile, hunk: ParsedDiffHunk, from: number, to: number): Draft => {
    const window = hunk.lines.slice(from, to);
    return {
      file,
      kind: "hunk",
      oldStart: window[0]!.oldBefore,
      oldLines: window.flatMap((line) => (line.old === null ? [] : [line.text])),
      newStart: window[0]!.newBefore,
      newLines: window.flatMap((line) => (line.new === null ? [] : [line.text])),
      addedNewLines: window.flatMap((line) => (line.old === null && line.new !== null ? [line.new] : [])),
      complete: true,
    };
  };

  /** A hunk as ONE draft when it fits, else consecutive ≤80-line windows. */
  const draftsOf = (file: ParsedDiffFile, hunk: ParsedDiffHunk): Draft[] => {
    const fits =
      hunk.oldLines.length <= RECHECK_SLICE_MAX_LINES && hunk.newLines.length <= RECHECK_SLICE_MAX_LINES;
    if (fits) {
      return [
        {
          file,
          kind: file.deleted ? "deleted-file" : "hunk",
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          addedNewLines: file.deleted
            ? []
            : hunk.lines.flatMap((line) => (line.old === null && line.new !== null ? [line.new] : [])),
          complete: file.deleted ? hunk.oldStart === 1 : true,
        },
      ];
    }
    // An oversized DELETED file stays excluded: absence is proven by the whole
    // file, so a fragment of it would be a weaker claim, not a local one.
    if (file.deleted) return [];
    const drafts: Draft[] = [];
    for (let from = 0; from < hunk.lines.length; from += RECHECK_SLICE_MAX_LINES) {
      drafts.push(windowDraft(file, hunk, from, Math.min(from + RECHECK_SLICE_MAX_LINES, hunk.lines.length)));
    }
    return drafts;
  };

  /**
   * One catalog entry, or WHY it could not be added: `size` is a slice that
   * cannot be trusted within the per-slice bound (no eligible slice exists
   * for this draft), `catalog` is a well-formed slice the catalog byte budget
   * no longer fits (a budget exclusion, not a missing proof). The caller's id
   * arrives FIRST: it is part of the serialized slice, so the bound must see it.
   */
  const addSlice = (draft: Draft, id: string): EvidenceSlice | "size" | "catalog" => {
    const slice: EvidenceSlice = {
      id,
      headSha: captureSha,
      baseSha: captureSha,
      path: draft.file.path,
      oldPath: draft.file.oldPath,
      kind: draft.kind,
      oldStart: draft.oldStart,
      oldLines: draft.oldLines,
      newStart: draft.newStart,
      newLines: draft.newLines,
      addedNewLines: draft.addedNewLines,
      oldBlobOid: draft.file.oldBlobOid,
      headBlobOid: draft.file.headBlobOid,
      absentAtHead: draft.file.deleted,
      complete: draft.complete,
    };
    const bytes = sizeOf(slice);
    if (bytes > RECHECK_SLICE_MAX_BYTES) return "size";
    if (bytes > budget) return "catalog";
    return slice;
  };

  for (const target of targets) {
    const filePath = target.original.filePath;
    if (filePath === null) {
      excludedTargets.add(target.rowId); // repo-level concern: no diff slice can prove it
      continue;
    }
    const matching = files.filter((f) => f.path === filePath || f.oldPath === filePath);
    if (matching.length === 0) {
      excludedTargets.add(target.rowId);
      continue;
    }
    const lineAnchor = target.original.lineStart ?? 0;
    const candidates: Draft[] = matching.flatMap((file) => file.hunks.flatMap((hunk) => draftsOf(file, hunk)));
    candidates.sort(
      (a, b) =>
        Math.abs(a.oldStart - lineAnchor) - Math.abs(b.oldStart - lineAnchor) ||
        a.oldStart - b.oldStart,
    );
    let included = 0;
    let catalogDenied = false;
    const referenced: string[] = [];
    for (const draft of candidates) {
      if (included >= RECHECK_SLICES_PER_TARGET) break;
      const key = `${draft.file.path}\u0000${draft.oldStart}:${draft.oldLines.length}+${draft.newStart}:${draft.newLines.length}`;
      const shared = sliceIdByKey.get(key);
      if (shared !== undefined) {
        referenced.push(shared);
        included += 1; // the hunk is already in the catalog — targets share slices
        continue;
      }
      const built = addSlice(draft, `ev-${slices.length + 1}`);
      if (built === "size") continue;
      if (built === "catalog") {
        catalogDenied = true;
        continue;
      }
      slices.push(built);
      budget -= sizeOf(built);
      sliceIdByKey.set(key, built.id);
      referenced.push(built.id);
      included += 1;
    }
    if (included === 0) {
      // A row whose slices exist but lost the catalog byte budget is a budget
      // exclusion, never "no evidence".
      if (catalogDenied) catalogBudgetExcluded.add(target.rowId);
      else excludedTargets.add(target.rowId);
    } else sliceIdsByRowId.set(target.rowId, referenced);
  }
  return { slices, excludedTargets, catalogBudgetExcluded, sliceIdsByRowId };
}

/**
 * Project a current envelope finding onto the §7.3 OriginalFinding wire
 * (the durable original concern shape lifecycle rows store).
 */
function projectOriginalFinding(finding: ReviewFinding): OriginalFindingProjection {
  return {
    title: finding.title,
    body: finding.body,
    filePath: finding.file_path ?? null,
    lineStart: finding.line_start ?? null,
    lineEnd: finding.line_end ?? null,
    mergeClass: finding.mergeClass,
    category: finding.category ?? null,
    fingerprintHint: finding.fingerprint_hint ?? null,
  };
}

/** Local alias so the projection needs no runtime import of the contract type. */
type OriginalFindingProjection = RecheckTarget["original"];

/**
 * §7.4 reconciliation: validate the recheck document
 * against the trusted input AND the final current findings, applying the
 * CONSERVATIVE precedence —
 *   - same-round recurrence (same fingerprint, or exact normalized original
 *     equality under a different fingerprint) forces `unverifiable/conflict`
 *     over any recheck closure (the current review's recurrence wins);
 *   - model-reported related current finding indexes are validated against
 *     the final envelope (never blindly trusted): any related unresolved
 *     concern wins over addressed; an out-of-range index is fabrication and
 *     forces unverifiable;
 *   - an unavailable prior-journal apply means stale lifecycle state — no
 *     closure is trusted (context-incomplete).
 * Per-row reason precedence (first match wins): stale context, then catalog
 * exclusion (`no-evidence` — no slice can prove the row, so it was never
 * sent), then catalog budget exhaustion (`budget` — its slices exist but the
 * catalog byte budget dropped them, so it was never sent), then gate
 * rejection (`invalid-output` — it WAS sent and answered badly), then the
 * input size budget (`budget`), then a seat skip (`budget`), then a round the
 * runner CANCELLED by design (`omitted` — stopped, not answered), then
 * `invalid-output` for an absent document, then `omitted`.
 *
 * ATTEMPTED vs never-sent is the accounting split (§7.2 fair rotation): a row
 * the seat was given — whether the gate kept its answer or dropped it — is
 * attempted and enters `lifecycle.assessments`, so `last_assessed_ms` advances
 * and the rotation clock moves. A row that was never sent (size budget,
 * catalog exclusion, seat skip, no document at all) is NOT attempted: it is
 * accounted as `omitted` for coverage and leaves `last_assessed_ms` alone.
 *
 * ONE round therefore yields THREE coverage terms, and they partition the
 * selected rows exactly once — `assessed + invalid-output + omitted ===
 * selected`. `assessedCount` is the rows carrying a real `docResult` (the REAL
 * seat answers the published coverage line reports); `invalidOutputCount` is
 * the unanswered rows the closure table labels `invalid-output` (gate-rejected,
 * or sent into a round whose document was absent); `unansweredCount` is the
 * rest — never sent, never attempted. `assessments.length` is NOT any of these:
 * it is the lifecycle clock, which also carries the gate-rejected rows
 * (attempted, answered badly), so reporting it as "assessed" would claim
 * reassessments the seat never delivered.
 */
function reconcileRecheckRound(input: {
  targets: RecheckTarget[];
  doc: RecheckDoc | null;
  /** The seat's own status document — the reason a round produced no document row. */
  status: RecheckStatus | null;
  discussion: Discussion;
  output: ReviewOutput;
  /** Stale lifecycle state (failed pending-journal apply or capture): no closure. */
  staleContext: boolean;
  /** Selected rows the trusted catalog could not prove: never sent, never assessable. */
  catalogExcluded: ReadonlySet<string>;
  /** Selected rows whose slices the catalog byte budget dropped: never sent either. */
  catalogBudgetExcluded: ReadonlySet<string>;
  /** Selected rows excluded from the recheck input by the §7.3 size budget. */
  budgetExcluded: ReadonlySet<string>;
  /** Rows the gate dropped from an otherwise accepted document (row content errors). */
  rejectedRowIds: ReadonlySet<string>;
  /**
   * Gate-dropped rows that carried no usable rowId, so they name no target.
   * They are attributed by position among the SENT-and-unanswered rows.
   */
  anonymousRejectedRows: number;
}): {
  assessments: Assessment[];
  outcomeByRowId: Map<string, Assessment>;
  resolutions: { associationId: string; verified: VerifiedResolution }[];
  /** Rows carrying a real seat answer — the published coverage/tally count. */
  assessedCount: number;
  /**
   * Unanswered rows whose outcome is `invalid-output` — the same term the
   * closure table renders for them: gate-rejected rows, rows sent into a round
   * whose document was absent/invalid, and empty-result rounds. Attempted, so
   * the lifecycle clock moved, but no answer survived.
   */
  invalidOutputCount: number;
  /**
   * Unanswered rows that were never attempted (`budget` / `no-evidence` /
   * `omitted` / `context-incomplete`). Together with the two counts above this
   * accounts for every selected row exactly once:
   * `assessed + invalid-output + omitted === selected`.
   */
  unansweredCount: number;
  /**
   * Unnamed gate drops actually attributed — `min(claimed, pool)`. The caller
   * logs `anonymousRejectedRows - anonymousRejectedCount` as the ignored excess
   * of a seat-authored count that outran the rows it could legitimately claim.
   */
  anonymousRejectedCount: number;
} {
  const {
    targets,
    doc,
    status,
    discussion,
    output,
    staleContext,
    catalogExcluded,
    catalogBudgetExcluded,
    budgetExcluded,
    rejectedRowIds,
    anonymousRejectedRows,
  } = input;
  const outcomeByRowId = new Map<string, Assessment>();
  const assessments: Assessment[] = [];
  const forceUnverifiable = (rowId: string, reason: Assessment["reason"]): Assessment => ({
    rowId,
    disposition: "unverifiable",
    reason,
    evidence: null,
    relatedCurrentFindingIndexes: [],
  });

  const currentFingerprints = new Set(output.findings.map((f) => computeFindingFingerprint(f)));
  const currentComposites = new Set(
    output.findings.map((f) => computeFindingFingerprint({ ...f, fingerprint_hint: null })),
  );
  const answeredRowIds = new Set((doc?.results ?? []).map((row) => row.rowId));

  // A gate rejection with no usable rowId names no target, so the only honest
  // mapping is POSITION among the rows that were sent and left unanswered: the
  // seat emitted N results we cannot identify, so the first N such rows are
  // the attempted-and-bad ones. Never-sent rows (catalog exclusion, catalog or
  // size budget, capture failure) stay out of the pool — dropping one into
  // `invalid-output` would blame a row the seat never received.
  //
  // The status's count is a seat-authored number with no ceiling: a foreign or
  // broken status may claim more drops than there are rows to blame. It is
  // therefore CLAMPED to the pool it can legitimately claim (sent, unanswered,
  // not named by id), never spread past it.
  const anonymousPool = targets.filter(
    (target) =>
      !answeredRowIds.has(target.rowId) &&
      !rejectedRowIds.has(target.rowId) &&
      !catalogExcluded.has(target.rowId) &&
      !catalogBudgetExcluded.has(target.rowId) &&
      !budgetExcluded.has(target.rowId),
  );
  const anonymousRejectedCount = Math.min(anonymousRejectedRows, anonymousPool.length);
  const anonymouslyRejected = new Set<string>();
  for (const target of anonymousPool.slice(0, anonymousRejectedCount)) {
    anonymouslyRejected.add(target.rowId);
  }

  // An `empty-result` round is the all-rows-rejected case without a gate drop:
  // the seat returned a valid document with zero results for a non-empty
  // target list, so every row it SENT came back unusable. Those rows were
  // ATTEMPTED, never "never ran" — the per-target exclusion branches below
  // still win, so a catalog/size-budget row stays `no-evidence`/`budget`.
  const emptyResultRound = status?.reason === "empty-result";

  for (const target of targets) {
    const docResult = doc?.results.find((r) => r.rowId === target.rowId) ?? undefined;
    // Never-sent rows: the catalog could not prove them, the catalog byte
    // budget dropped their slices, or the §7.3 size budget excluded them.
    // They keep BOTH their own reason and their own rotation clock — a seat
    // that never received the row cannot have answered it.
    const neverSent =
      catalogExcluded.has(target.rowId) ||
      catalogBudgetExcluded.has(target.rowId) ||
      budgetExcluded.has(target.rowId);
    const rejected =
      rejectedRowIds.has(target.rowId) ||
      anonymouslyRejected.has(target.rowId) ||
      // Only a row that actually rode the wire can be blamed for the empty
      // result; `neverSent` keeps every excluded row out of the attempt set.
      (emptyResultRound && docResult === undefined && !neverSent);
    let assessment: Assessment;
    if (staleContext) {
      // Stale lifecycle state (pending-journal apply or capture failed):
      // nothing may close this round, assessed or not.
      assessment = forceUnverifiable(target.rowId, "context-incomplete");
    } else if (catalogExcluded.has(target.rowId)) {
      // The trusted catalog could not prove this row from the captured diff,
      // so it never rode the wire — `no-evidence`, never a blamed seat and
      // never the size `budget` (the row was unprovable, not oversized).
      assessment = forceUnverifiable(target.rowId, "no-evidence");
    } else if (catalogBudgetExcluded.has(target.rowId)) {
      // Slices for this row exist, but the §7.3 catalog byte budget ran out
      // before they were added — ALSO never sent, yet a budget exclusion:
      // `no-evidence` would claim nothing could prove a provable row.
      assessment = forceUnverifiable(target.rowId, "budget");
    } else if (rejected) {
      // The seat answered this row but the gate dropped it (shape / enum /
      // evidence error) — the row WAS attempted, so it is invalid output,
      // never "omitted" (never ran) or "budget" (never sent).
      assessment = forceUnverifiable(target.rowId, "invalid-output");
    } else if (docResult === undefined) {
      // Omitted selected row: no recheck ran for it. Honest conservative
      // accounting by WHY — the §7.3 size budget excluded it from the input
      // (so it was never sent), the seat's own budget skip, invalid/absent
      // document, or omitted from an otherwise valid document. Never
      // "assessed". The size budget wins over `doc === null`: when it excluded
      // every target nothing was sent, so `invalid-output` would blame a seat
      // that never ran.
      const reason: Assessment["reason"] = budgetExcluded.has(target.rowId)
        ? "budget"
        : status?.outcome === "skipped"
          ? status.reason === "aborted"
            ? "omitted"
            : "budget"
          : doc === null
            ? "invalid-output"
            : "omitted";
      assessment = forceUnverifiable(target.rowId, reason);
    } else {
      assessment = { ...docResult };
      // Conservative precedence vs the SAME round's current findings.
      const original = target.original;
      const projected = {
        file_path: original.filePath,
        line_start: original.lineStart,
        line_end: original.lineEnd,
        title: original.title,
        category: original.category,
        mergeClass: original.mergeClass,
        fingerprint_hint: original.fingerprintHint,
      };
      const fingerprint = computeFindingFingerprint(projected);
      const composite = computeFindingFingerprint({ ...projected, fingerprint_hint: null });
      if (currentFingerprints.has(fingerprint) || currentComposites.has(composite)) {
        // Same-round recurrence (exact or normalized-original match) wins
        // over recheck closure — never false `addressed`.
        assessment = forceUnverifiable(target.rowId, "conflict");
      } else {
        // Validate model-reported related indexes against the FINAL
        // envelope; any related unresolved concern wins over addressed.
        const inRange = assessment.relatedCurrentFindingIndexes.every((i) => i < output.findings.length);
        if (!inRange) {
          assessment = forceUnverifiable(target.rowId, "conflict");
        } else if (
          assessment.disposition === "addressed" &&
          assessment.relatedCurrentFindingIndexes.length > 0
        ) {
          assessment = forceUnverifiable(target.rowId, "conflict");
        }
      }
    }
    outcomeByRowId.set(target.rowId, assessment);
    // ATTEMPTED rows — answered, or answered and dropped by the gate — are the
    // ones whose rotation clock moves. A row with no document row was never
    // accounted by the seat, so it stays un-assessed (§7.2 fair rotation).
    if (docResult !== undefined || rejected) assessments.push(assessment);
  }

  // Resolution eligibility (§7.4/§7.5): addressed verdicts only, with the
  // snapshot fences actually captured this round. The ISSUE side needs its
  // FETCH and its MODEL view complete plus a digest: a model that never saw
  // part of the human discussion could miss a rebuttal or a still-open
  // concern, so that evidence never authorizes a resolve.
  const resolutions: { associationId: string; verified: VerifiedResolution }[] = [];
  for (const target of targets) {
    const assessment = outcomeByRowId.get(target.rowId);
    if (assessment === undefined || assessment.disposition !== "addressed") continue;
    if (
      discussion.issueCoverage !== "complete" ||
      discussion.issueModelCoverage !== "complete" ||
      discussion.issueDigest === ""
    ) {
      continue;
    }
    for (const associationId of target.associationIds) {
      const snapshot = discussion.threads.find((t) => t.associationId === associationId);
      if (
        snapshot === undefined ||
        snapshot.coverage !== "complete" ||
        snapshot.modelCoverage !== "complete" ||
        snapshot.digest === ""
      ) {
        continue;
      }
      resolutions.push({
        associationId,
        verified: {
          assessment,
          snapshot,
          issueDigest: discussion.issueDigest,
          issueCoverage: discussion.issueCoverage,
        },
      });
    }
  }

  // Coverage counts REAL seat answers, not the lifecycle clock: a
  // gate-rejected row advances `last_assessed_ms` but was never assessed.
  // Every selected row lands in exactly one of these three terms, and the
  // published line states the identity `assessed + invalid-output + omitted =
  // selected`. `invalid-output` is the term the closure table renders for the
  // same rows, so the line and the table cannot disagree.
  let assessedCount = 0;
  let invalidOutputCount = 0;
  for (const target of targets) {
    if (answeredRowIds.has(target.rowId)) {
      assessedCount += 1;
    } else if (outcomeByRowId.get(target.rowId)?.reason === "invalid-output") {
      invalidOutputCount += 1;
    }
  }
  return {
    assessments,
    outcomeByRowId,
    resolutions,
    assessedCount,
    invalidOutputCount,
    // Neither a surviving answer nor a gate rejection: `assessments.length` is
    // the lifecycle clock (attempted rows), so it cannot stand in for this.
    unansweredCount: targets.length - assessedCount - invalidOutputCount,
    anonymousRejectedCount,
  };
}

/** The empty discussion for rounds with no open rows (nothing to capture). */
function emptyDiscussion(nowMs: number): Discussion {
  return {
    items: [],
    issueCoverage: "complete",
    issueModelCoverage: "complete",
    issueDigest: "",
    capturedMs: nowMs,
    threads: [],
  };
}

/**
 * The round's context coverage (§7.4): complete only when the issue capture
 * AND every captured thread snapshot (fetch AND model coverage) are
 * complete — a truncated or unavailable capture never labels a round
 * complete.
 */
function roundContextCoverage(discussion: Discussion): Coverage {
  if (discussion.issueCoverage === "unavailable") return "unavailable";
  if (discussion.issueCoverage !== "complete" || discussion.issueModelCoverage !== "complete") {
    return "truncated";
  }
  for (const thread of discussion.threads) {
    if (thread.coverage !== "complete" || thread.modelCoverage !== "complete") return "truncated";
  }
  return "complete";
}

/**
 * The degraded publication outcome (§7.7 degraded payload). `confirmed` =
 * proof persisted (the Check hook reads it and concludes `failure` — a
 * degraded publication cannot prove the review gate was met);
 * `unknown` = a send was attempted but the proof could not be persisted
 * (read-only discovery owns it); `failed` = a definitive no-send
 * (pre-publication failure / lease loss / send rejection).
 */
type DegradedPublicationOutcome =
  | { phase: "confirmed"; publicationId: string }
  | { phase: "unknown"; publicationId: string }
  | { phase: "failed"; reason: string };

/**
 * The frozen instant fences a FIRST publication: at or past the attempt's
 * deadline no first result may be sent (plan: the cap "prevents starting new
 * review work or a first result publication at or after expiry"). Both
 * first-send call sites use it — the normal `publish` phase and the degraded
 * notice `collect` stages — because a delayed or resumed host must not publish
 * what the instant already refused. It fences nothing else: reconciliation of
 * an earlier send, the Check settlement and cleanup each have their own rule.
 *
 * A refusal is a typed wall-clock stop, so it settles exactly like every other
 * confirmed stop (failure row, Check conclusion, safe cleanup) instead of
 * becoming a generic pre-publication failure.
 */
function refusePublicationPastDeadline(deadlineMs: number): void {
  const lateMs = Date.now() - deadlineMs;
  if (lateMs < 0) return;
  throw new RoundBudgetSpent(
    `round budget spent: no first publication ${lateMs}ms past the attempt's frozen deadline`,
    "runner",
  );
}

/**
 * Publish the parse-degrade notice through the §7.7 journal (plan: stage →
 * claim → send the EXACT prepared body → proof → applied mark). The
 * degraded payload has `artifact: null`, `lifecycle: null`, empty line
 * intents and the bounded final degraded body — no normal review or
 * lifecycle rows are ever created from it. Every failure is a typed outcome
 * (the caller acks regardless — a parse fail is a deterministic model-output
 * failure where retry is waste); the only throw is the deadline refusal above,
 * taken before anything is staged.
 */
async function publishDegradedPublication(input: {
  db: PipelineEnv["DB"];
  commenter: ReviewCommenter;
  scope: Scope;
  headSha: string;
  redactedError: string;
  redactedStdout: string;
  /** The attempt's frozen instant, enforced at the mutation (see `guardMutations`). */
  notAfterMs: number;
}): Promise<DegradedPublicationOutcome> {
  const { commenter } = input;
  const target = {
    installationId: input.scope.installationId,
    owner: input.scope.owner,
    repo: input.scope.repo,
    prNumber: input.scope.prNumber,
  };
  try {
    const plan = await commenter.planDegradedUpsert(target);
    const publicationId = crypto.randomUUID();
    const publicationMarker = buildPublicationMarker({ publicationId, headSha: input.headSha, kind: "degraded" });
    const body = buildPreparedDegradedBody({
      error: input.redactedError,
      rawOutput: input.redactedStdout,
      round: plan.round,
      publicationMarker,
    });
    const payload: PublicationPayload = {
      version: 1,
      scope: input.scope,
      headSha: input.headSha,
      kind: "degraded",
      round: plan.round,
      targetCommentId: plan.action === "update" ? plan.commentId : null,
      body,
      bodySha256: await sha256Hex(body),
      artifact: null,
      lifecycle: null,
      lineIntents: [],
    };
    const staged = await stagePublication(input.db, { id: publicationId, payload, nowMs: Date.now() });
    // §7.7: an insert conflict returns the EXISTING immutable payload — never
    // overwrite a prepared/confirmed publication with a second model result.
    // Same guard as the review chain: send the STORED payload's identity, or
    // refuse to send at all. Here the caller has no journal payload to fall
    // back to, so the honest outcome is a definitive not-sent failure.
    if (staged.id !== publicationId) {
      return {
        phase: "failed",
        reason: `publication journal conflict (existing row ${staged.id}, phase ${staged.phase}) — the immutable payload wins; not sending a second degraded notice`,
      };
    }
    const lease = await claimPublication(input.db, staged.id, `consumer-degraded:${staged.id}`, Date.now());
    if (lease === null) {
      return { phase: "failed", reason: "publication journal claim failed — degraded notice not sent" };
    }
    let sent: { posted: boolean; commentId: number | null };
    try {
      sent = await commenter.postPreparedDegraded({
        ...target,
        headSha: input.headSha,
        round: plan.round,
        targetCommentId: plan.action === "update" ? plan.commentId : null,
        body,
        publicationId: staged.id,
        notAfterMs: input.notAfterMs,
      });
    } catch (err) {
      // Refused AT the mutation because the instant had passed: nothing left
      // the Worker, so this is a WALL-CLOCK STOP, never the `unknown` of a
      // possibly-sent request — and never the generic `failed` below either.
      // Mapped to the same typed stop the normal publish path raises, so the
      // caller's settlement takes its budget branch (failure row, Check
      // conclusion, safe cleanup) instead of a pre-publication failure.
      if (err instanceof PublicationDeadlineSpent) {
        throw new RoundBudgetSpent(`round budget spent: ${err.message}`, "runner");
      }
      if (err instanceof PreparedSendRejected) {
        // A definitive pre-send rejection (§7.7): NO request left the
        // Worker, so the truthful durable phase is `failed` — never the
        // post-attempt `unknown`. The complete payload and its digest stay
        // retained for operator inspection; the row is never re-sent.
        try {
          await markPublicationFailed(input.db, staged.id, lease, err.message, Date.now());
        } catch {
          // A D1 failure of the failed-mark does not change the verdict: the
          // degraded notice was still definitively not sent.
        }
        return { phase: "failed", reason: err.message };
      }
      // A throw AT the send is post-attempt uncertainty: whether GitHub
      // received it is unknown (§7.9 — only a definitive rejection is "not
      // published"). The staged row stays sending for read-only discovery;
      // the Check fallback classification is publication-unknown.
      return { phase: "unknown", publicationId: staged.id };
    }
    const proof = {
      publicationId: staged.id,
      scope: input.scope,
      headSha: input.headSha,
      kind: "degraded" as const,
      round: plan.round,
      // 0 = posted but the response carried no id — the typed sentinel for
      // "sent, id uncaptured" (never a fabricated GitHub id); §7.5 marker
      // discovery can still bind the exact comment later.
      commentId: sent.commentId ?? 0,
      bodySha256: payload.bodySha256,
      confirmedMs: Date.now(),
    };
    let proofOk = false;
    try {
      proofOk = await recordPublicationProof(input.db, staged.id, lease, proof);
    } catch {
      proofOk = false;
    }
    if (!proofOk) {
      return { phase: "unknown", publicationId: staged.id };
    }
    let applied = false;
    try {
      applied = await applyPublishedLifecycle(input.db, staged.id, lease, Date.now());
    } catch {
      applied = false;
    }
    if (!applied) {
      return { phase: "unknown", publicationId: staged.id };
    }
    return { phase: "confirmed", publicationId: staged.id };
  } catch (err) {
    // The typed wall-clock stop is the ONE error this function does not fold
    // into a typed outcome: swallowing it here would be the "a refusal is not
    // an observation" mistake — the stop must reach the settlement as itself.
    if (err instanceof RoundBudgetSpent) throw err;
    return { phase: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

export type ProcessDeps = {
  env: PipelineEnv;
  store: D1ArtifactStore;
  /**
   * The `review_targets` store, built ONCE per consumer (and injectable in
   * tests) like the bot store: every message resolves its target through it,
   * and rebuilding the narrow face per message would be pure overhead.
   */
  targets: ReturnType<typeof createTargetsStore>;
  /**
   * review_failures leaf (AL-1 + AL-6): the parse-fail
   * degrade branch and the infra-failure catch record through it. Both call
   * sites are best-effort (try/catch at the call site — an insert failure
   * never masks the ack or the rethrow).
   */
  failureStore: FailureStore;
  /**
   * Per-App commenter instance cache keyed by appId (lock L4; the
   * credential-fingerprint hardening, architect lock L1). Entry = `{ commenter, fingerprint }` where the
   * fingerprint is the EXACT string pair `github_app_id` +
   * `private_key_enc` (the envelope as stored) from the per-message row the
   * resolver already re-reads: a fingerprint match reuses the instance
   * (auth-app token caches stay warm), a mismatch (rotation — a new AES-GCM
   * envelope, even for a re-saved identical PEM) decrypts + rebuilds +
   * REPLACES, and the not-found/disabled/deleted gates evict before their
   * unchanged throw. Deliberately NOT keyed or fingerprinted on
   * `updated_at` (the per-webhook `touchLastWebhook` would make it
   * high-frequency) and not on a decrypted-PEM digest (that would spend the
   * decrypt the cache exists to spare). The row status is still re-checked
   * per message — the cache only spares the decrypt + construction, never
   * the active/not-deleted gate. auth-app's installation-token cache is
   * per-instance, so one instance per App keeps token caches isolated AND
   * prevents credentials from crossing instances.
   */
  appCommenters: Map<string, { commenter: ReviewCommenter; fingerprint: string; githubAppId: number }>;
  /**
   * Per-App commenter factory — `createReviewCommenter` in production (the
   * ONLY createAppAuth construction point stays src/pipeline/comment.ts,
   * lock L4); tests inject a spy to assert the exact credentials each App
   * instance is built from.
   */
  createAppCommenter: (cred: CommenterEnv) => ReviewCommenter;
  log: ConsumerLog;
  getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
  /**
   * Optional Check lifecycle seam (§7.10): ABSENT → no Checks, M8
   * fully operational. `createReviewConsumer` injects the checks.ts
   * implementation by default; the field stays optional so the seam's
   * absent-dependency contract holds. Hook exceptions/timeouts are caught by
   * the consumer; `begin` runs at §7.7 step 4 (after the authoritative SHA and
   * dedup, before model work), `terminalize` at step 12 on every terminal path
   * with the publication identity so the terminal decision reads the persisted
   * proof.
   */
  checks?: CheckLifecycleHooks;
  /**
   * The invocation's lifetime hook (`ctx.waitUntil` in the queue handler):
   * the terminalize promise is handed to it, so a hook that outlives the
   * consumer still finishes instead of dying with the isolate. Absent in
   * tests that do not watch the detached promise.
   */
  background?: CheckBackgroundSink;
  /**
   * The PR head watermark read (migration 0044) — `createReviewBotsStore(env.DB)
   * .selectPrHead` in production, built ONCE per consumer (and injectable in
   * tests), never per message. The supersede decision needs one point read per
   * stamped delivery, so rebuilding the store for it would be pure overhead.
   */
  selectPrHead: (input: {
    targetId: string;
    owner: string;
    repo: string;
    prNumber: number;
  }) => Promise<{ headSha: string | null; headAt: string | null } | null>;
  /**
   * The incremental round's base lookup. A seam because the failure path is
   * the contract under test: the round must survive ANY throw from it with the
   * full-diff fallback, and injecting that throw through the DB would need the
   * query text.
   */
  findIncrementBase: (db: PipelineEnv["DB"], scope: Scope) => Promise<string | null>;
  /**
   * TEST SEAM ONLY: an explicit attempt cap (ms) that overrides the operator
   * settings read at admission, so a suite can put the attempt's frozen
   * deadline where it wants it. Production leaves it undefined — the cap comes
   * from `review_runtime_settings`, and the deadline is then stored on the
   * attempt, not carried here.
   */
  attemptCapMs?: number;
  /**
   * The App's resolved runner config per App id — the HOST channel a phase
   * re-derives its live objects from (the adapter is in `appCommenters`, the
   * keys here, the container through `getSandbox`). A resumed step's host
   * resolves the credential again and registers it before calling the phase;
   * the keys never enter a handoff.
   */
  runnerConfigs: Map<string, RunnerConfig>;
  /**
   * The §7.10 Check settlements this invocation created, by attempt id: the
   * live handle on rows whose writes are D1-fenced. A resumed invocation that
   * did not claim has none, so it terminalizes nothing and leaves the run to
   * the reconciler — the documented abandoned-attempt outcome.
   */
  checkSettlements: Map<string, CheckSettlement>;
  /**
   * The attempt's re-derived session credential, cached on the host channel so
   * the inline route mints once: `prepare` registers the token it minted, the
   * paid step replaces the entry with the session's full exact-value set, and a
   * RESUMED host (empty map) mints and derives again. No token ever crosses a
   * phase boundary.
   */
  credentials: Map<string, { token: string; secretValues: string[] }>;
};

/**
 * The job's PR identity, derivable WITHOUT either id — the AL-24-4 in-flight
 * legacy message (no `botRef`) throws in toBaseFields, but the structured
 * failure channel still carries these (only app_id needed the deref, and
 * ConsumerLogFields requires the base identity).
 */
export function payloadIdentityFields(payload: ReviewJobPayload): ConsumerLogFields {
  return {
    event: payload.triggered_by === "pull_request" ? "pull_request" : "issue_comment",
    action: payload.action,
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: payload.head_sha,
  };
}

/** Structured base fields derived from the job payload (no sandbox/sha yet). */
export function toBaseFields(payload: ReviewJobPayload): ConsumerLogFields {
  return {
    ...payloadIdentityFields(payload),
    // Every job carries the bot id reference in every structured log line
    // (an id, never a credential — lock L4; `botRef` is required).
    app_id: payload.botRef.appId,
    // …and the target, so a line that attributes a review names both rows.
    target_id: payload.targetId,
  };
}

/**
 * A git stage's failure detail (diff / increment diff / numstat). stderr is the
 * ONLY diagnosis a non-zero exit carries — an oversized diff fails `gh pr diff`
 * with HTTP 406 on stderr and 0B of stdout — so a redacted tail rides the
 * message that reaches the durable review_failures row. `stdout` is measured in
 * UTF-8 BYTES (a diff carries non-ASCII), and redaction runs BEFORE the tail
 * cut, so a secret straddling the cap cannot survive as a fragment. Both passes
 * run: the shape one, then the session's exact values.
 */
function gitStageFailureDetail(
  stage: string,
  run: { stdout: string; stderr: string; exitCode: number },
  secretValues: readonly string[],
): string {
  const base = `${stage} failed: exit ${run.exitCode}, stdout ${new TextEncoder().encode(run.stdout).length}B`;
  // Redaction BEFORE the cut: a secret sliced in half would survive it.
  const tail = redactExactSecrets(redactSecrets(run.stderr), secretValues).trim().slice(-STDERR_TAIL_MAX);
  return tail === "" ? `${base}, stderr empty` : `${base}, stderr tail: ${tail}`;
}

/**
 * Capture a PR diff GitHub refuses to serve: `gh pr diff` 406s once the PR
 * passes its 20,000-line API ceiling, so the same unified diff comes from the
 * clone instead — base ref → merge base → depth-1 fetch of that merge base →
 * `git diff <merge-base> <head>` into DIFF_PATH, read back through the SAME
 * bounded transport `diffCommand` uses (2 MiB overflow semantics unchanged).
 * The head commit is already in the clone (`cloneCommand` fetched
 * `pull/<n>/head`), so only the merge base has to be fetched.
 *
 * Bounded twice over: every exec draws its timeout from `diffCaptureDeadlineMs`
 * — the ONE window the refused `gh pr diff` already started — capped at
 * `PR_CONTEXT_EXEC_TIMEOUT_MS`, so the whole diff stage can never spend more
 * than one `full-diff` ledger window however it splits between the two
 * captures. And the fallback is declined unless the DERIVED runner deadline
 * still leaves the runner more than one `EXEC_TIMEOUT_GIT_MS` step — that step
 * is the capture's own allowance — so an oversized round keeps the fast 406
 * failure row instead of being killed mid-fallback. `deep` fits: its 646s
 * maximum is capped by the derived cutoff, not reserved in full.
 *
 * Every decline names itself and the step it stopped at. The caller turns that
 * into ONE structured warn (reason, step, that step's exit code and redacted
 * stderr tail) plus a suffix on the rethrown ORIGINAL 406 — so "not attempted
 * (budget)", "failed at fetch", "the API's answer was unusable" and "hostile
 * ref rejected" never collapse into the same silent nothing. A capture is still
 * never partial, and the fallback's own fault still never replaces the cause
 * that was diagnosed.
 */
async function oversizedDiffCapture(
  sandbox: ReviewSandbox,
  token: string,
  target: { owner: string; repo: string; prNumber: number },
  headSha: string,
  runnerDeadlineMs: number,
  diffCaptureDeadlineMs: number,
): Promise<{ run: { stdout: string; stderr: string; exitCode: number } } | DiffCaptureDecline> {
  if (runnerDeadlineMs - Date.now() <= EXEC_TIMEOUT_GIT_MS) {
    return { reason: "budget", step: "admission" };
  }
  // What is left of the shared diff window, capped per step; null once spent.
  const stepTimeout = (): number | null => {
    const left = Math.min(PR_CONTEXT_EXEC_TIMEOUT_MS, diffCaptureDeadlineMs - Date.now());
    return left > 0 ? left : null;
  };
  /** A guard refuses a hostile ref/sha BEFORE any exec — no shell string, no transport. */
  const buildCommand = (step: string, make: () => ShellCommand): ShellCommand | DiffCaptureDecline => {
    try {
      return make();
    } catch {
      return { reason: "guard-rejected", step };
    }
  };
  let step = "base ref";
  try {
    let left = stepTimeout();
    if (left === null) return { reason: "step-timeout", step };
    const baseCmd = buildCommand(step, () => pullRequestBaseRefCommand(target.owner, target.repo, target.prNumber));
    if (typeof baseCmd !== "string") return baseCmd;
    const base = await sandbox.runCommand(baseCmd, { env: { GH_TOKEN: token }, timeout: left });
    const baseRef = base.stdout.trim();
    if (base.exitCode !== 0 || baseRef === "") return { reason: "base-ref-empty", step, run: base };

    step = "merge base";
    left = stepTimeout();
    if (left === null) return { reason: "step-timeout", step };
    const mergeCmd = buildCommand(step, () => mergeBaseCommand(target.owner, target.repo, baseRef, headSha));
    if (typeof mergeCmd !== "string") return mergeCmd;
    const merge = await sandbox.runCommand(mergeCmd, { env: { GH_TOKEN: token }, timeout: left });
    const mergeBaseSha = merge.stdout.trim();
    if (merge.exitCode !== 0 || mergeBaseSha === "") return { reason: "merge-base-empty", step, run: merge };
    // An exit-0 answer that is not a COMPLETE object id is an UNUSABLE answer,
    // never a hostile ref: `gh api --jq` prints `null` for an absent field, and
    // a truncated or proxied reply prints anything. The shell allowlist would
    // accept a truncated 7-char reply, so it cannot make this call.
    if (!isApiSha(mergeBaseSha)) return { reason: "merge-base-unreadable", step, run: merge };

    step = "fetch";
    left = stepTimeout();
    if (left === null) return { reason: "step-timeout", step };
    const fetchCmd = buildCommand(step, () => fetchDepthOneCommand(CLONE_DIR, mergeBaseSha));
    if (typeof fetchCmd !== "string") return fetchCmd;
    const fetched = await sandbox.runCommand(fetchCmd, { env: gitTransportEnv(token), timeout: left });
    if (fetched.exitCode !== 0) return { reason: "fetch-exit", step, run: fetched };

    step = "local diff";
    left = stepTimeout();
    if (left === null) return { reason: "step-timeout", step };
    const diffCmd = buildCommand(step, () => localDiffCommand(CLONE_DIR, mergeBaseSha, headSha, DIFF_PATH));
    if (typeof diffCmd !== "string") return diffCmd;
    const local = await sandbox.runCommand(diffCmd, { timeout: left });
    return local.exitCode === 0 ? { run: local } : { reason: "local-diff-exit", step, run: local };
  } catch {
    // A sandbox transport fault leaves the original diff failure as the cause.
    return { reason: "transport", step };
  }
}

/**
 * KV done-state read (B3): `done` means a review was already POSTED for this
 * sha (the consumer writes it right after posting, before the D1 insert).
 * The worker's enqueue marker uses the SAME key format with value "1", so
 * only the literal "done" counts as completed — "1" means "enqueued, not yet
 * processed" and falls through to the D1 check. KV failure → warn + fall
 * through (D1 is the durable backstop).
 */
export async function kvDoneHit(
  kv: KVNamespace,
  key: string,
  fields: ConsumerLogFields,
  log: ConsumerLog,
): Promise<boolean> {
  try {
    return (await kv.get(key)) === IDEM_DONE;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `idempotency KV read failed — falling back to D1: ${detail}`);
    return false;
  }
}

/**
 * §7.5 discovery ahead of the §7.8 discussion capture. The recheck round can
 * only emit a resolution for an association whose thread id is BOUND, but the
 * lane that binds it runs after the capture — so an association whose send
 * response was lost would never appear in the discussion and could never earn
 * a verified resolution. Binding here spends at most
 * {@link BIND_UNBOUND_THREADS_MAX_ENTRIES} sequential GitHub discoveries per
 * message; anything left over stays unbound for a later round and is counted
 * in `skipped`. `discoverThreadWithDeps` persists the ids itself — this helper
 * writes no SQL.
 */
export async function bindUnboundThreads(
  deps: { DB: D1Database; commenter: ReviewCommenter; log: ConsumerLog; fields: ConsumerLogFields },
  scope: Scope,
  targets: RecheckTarget[],
): Promise<{ bound: number; skipped: number }> {
  const result = { bound: 0, skipped: 0 };
  if (targets.length === 0 || deps.commenter.discoverThread === undefined) return result;
  const placeholders = targets.map(() => "?").join(",");
  let rows: Array<{ id: string; intent_json: string }>;
  try {
    const read = await deps.DB
      .prepare(
        // `updated_ms` is the rotation cursor: a row this pass could not bind
        // is stamped with the pass time below, so it moves behind the rows the
        // cap never reached instead of being retried as the oldest head.
        `SELECT id, intent_json FROM review_threads
         WHERE finding_row_id IN (${placeholders}) AND thread_id IS NULL
           AND superseded_by_publication_id IS NULL
         ORDER BY updated_ms, id
         LIMIT ?`,
      )
      .bind(...targets.map((target) => target.rowId), BIND_UNBOUND_THREADS_MAX_ENTRIES)
      .all<{ id: string; intent_json: string }>();
    rows = read.results;
  } catch (err) {
    // Context binding is best-effort: a failed read leaves the associations to
    // a later round instead of failing a round that could still run.
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(deps.fields, `unbound thread read failed — binding left to a later round: ${detail}`);
    return result;
  }
  // Best-effort rotation stamp: a row this pass could not bind moves to the
  // back of the next pass's queue, so a permanently undiscoverable head can
  // never consume the budget of the rows behind it.
  const stampRotation = async (rowId: string): Promise<void> => {
    try {
      await deps.DB.prepare(`UPDATE review_threads SET updated_ms = ? WHERE id = ? AND thread_id IS NULL`)
        .bind(Date.now(), rowId)
        .run();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(deps.fields, `bind rotation stamp failed for association ${rowId}: ${detail}`);
    }
  };
  for (const row of rows) {
    let intent: LineIntent;
    try {
      intent = JSON.parse(row.intent_json) as LineIntent;
    } catch {
      result.skipped += 1;
      deps.log.warn(deps.fields, `association ${row.id} intent_json unreadable — left unbound for a later round`);
      await stampRotation(row.id);
      continue;
    }
    try {
      const discovery = await deps.commenter.discoverThread({ scope, intent, reviewId: null });
      if (discovery.kind === "found") {
        result.bound += 1;
        continue;
      }
      result.skipped += 1;
      deps.log.warn(
        deps.fields,
        `thread discovery for association ${row.id} returned ${discovery.kind} — left unbound for a later round`,
      );
    } catch (err) {
      result.skipped += 1;
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        deps.fields,
        `thread binding for association ${row.id} failed (left unbound for a later round): ${detail}`,
      );
    }
    await stampRotation(row.id);
  }
  return result;
}

/**
 * The data every phase receives: the attempt's durable ids plus the delivery's
 * own facts. Nothing here is live, secret or mutable — a step host rebuilds it
 * from the queue message and the admission row it already read.
 */
export type AttemptRef = {
  /** The attempt identity: the container name, the launch fence and the marker derive from it. */
  attemptId: string;
  payload: ReviewJobPayload;
  level: ReviewLevel;
  /** The instant this delivery's admission entry began — the preparation anchor. */
  roundStartedAt: number;
  /**
   * The attempt's ONE absolute hard stop (`queue send + operator cap`), frozen
   * when the attempt was first admitted and replayed by every later delivery.
   * Every step and the container read THIS instant; none re-derives it.
   */
  deadlineMs: number;
  /** The App's numeric GitHub id (the credential row's identity). */
  githubAppId: number;
  /** The workspace the usage ledger charges. */
  usageWorkspaceId: string;
  /** Which credential paid for the round: the shared pool or the App's own key. */
  usageSource: UsageSource;
  /** The per-delivery Check budgets read at admission. */
  checkBudgets: CheckBudgets | null;
  /** The head the admission-time Check claim is over; `null` when none was made. */
  checkClaimSha: string | null;
  /** The live admission row this attempt owns — its cleanup releases it. */
  inflight: { key: InflightKey; attemptId: string; ttlSeconds: number };
  /**
   * The queue delivery number of the message that admitted this attempt. It no
   * longer gates the failed-claim stamp (the Workflow instance is the terminal
   * owner); it identifies the delivery in diagnostics.
   */
  attempts: number;
};

/**
 * The App's resolved runner config for ONE delivery: the keys-bearing config
 * the host resolved, plus the two optional overrides. It is a host-side
 * credential holder (`deps.runnerConfigs`), never a phase handoff — a phase
 * reads it to build the runner env and persists nothing of it.
 */
export type RunnerConfig = {
  appCfg: RunnerAppConfig;
  modelOverrides: Record<string, string> | undefined;
  customProviders: readonly CustomProviderConsumerConfig[] | undefined;
};

/**
 * One phase's failure, carrying the AL-6/SEC-01 facts as DATA: the stage in
 * flight, the session's exact secret values, the runner's observed start and
 * return, and the publication a send was attempted for. A resumed settlement
 * therefore reads what the failing phase knew instead of a phase local.
 */
export type FailureFacts = {
  phase: "prepare" | "review" | "collect" | "publish";
  stage: FailureStage;
  headSha: string | null;
  secretValues: string[];
  runnerStartedAt: number | undefined;
  runnerReturned: boolean;
  /** The anchored allocation this invocation froze, when it got that far. */
  runnerEffectiveBudgetMs: number | undefined;
  /** The selected numstat's line count (the budget outcome's own counter). */
  changedLines: number | null;
  /** Set once the prepared publication send was ATTEMPTED (post-send uncertainty). */
  sendAttemptPublicationId: string | null;
};

/** A phase failure: the cause stays intact for the settlement's typed branches. */
export class AttemptPhaseError extends Error {
  constructor(
    readonly facts: FailureFacts,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AttemptPhaseError";
  }
}


/**
 * The §7.10 Check seam: the claim that opens this attempt's run and the ONE
 * terminalize that settles it. The D1 row is the authority — every write below
 * is lease-fenced, and a refused or faulted write is a warn, never a second
 * claim — so this object is the invocation's live handle on it, not a handoff.
 * A resumed invocation that did not claim leaves the run to the reconciler.
 */
export type CheckSettlement = {
  handle: CheckHandle | null;
  claimAttempted: boolean;
  /** The round's derived log fields, when the phase that claimed them has them. */
  fields?: ConsumerLogFields;
  /**
   * The attempt whose promotion was ABANDONED: its update budget ended the
   * wait while the PATCH may still be in flight, so this attempt must not write
   * the terminal state itself. Cleared by every new begin.
   */
  promotionAbandoned: string | null;
  terminalized: boolean;
  /**
   * `expect` is the frozen Check identity (key + generation) a RESUMED phase
   * must act on; the claim refuses any other generation. A fresh review omits
   * it — its own claim IS the identity.
   */
  begin(
    scope: Scope,
    githubAppId: number,
    headSha: string,
    expect?: AttemptIdentity,
  ): Promise<CheckHandle | null>;
  abandon(
    handle: CheckHandle,
    reason: string,
    options?: { outcome?: CheckTerminalOutcome; inheritedHeadSha?: string; budgetExhaustion?: BudgetExhaustedOutcome },
  ): Promise<boolean>;
  terminalize(
    publicationId: string | null,
    outcome: CheckTerminalOutcome,
    inheritedHeadSha?: string,
    budgetExhaustion?: BudgetExhaustedOutcome,
  ): Promise<void>;
};

export type CheckSettlementInput = {
  deps: ProcessDeps;
  /** The delivery's identity, for the log lines the settlement emits. */
  payload: ReviewJobPayload;
  attemptId: string;
  checkBudgets: CheckBudgets | null;
  /**
   * The attempt's frozen absolute deadline. A claim or adoption writes it as the
   * Check row's `execution_deadline_ms`, so the reconciler reads the SAME
   * instant the execution fence does — never a fresh `now + window`.
   */
  deadlineMs: number;
};

/** A phase's early settlement: the attempt owes nothing more. */
export type SettledAttempt = { kind: "settled"; outcome: ProcessOutcome };

/** The App/PR identity, derived from the payload without dereferencing a legacy `botRef`. */
function scopeOf(payload: ReviewJobPayload): Scope | undefined {
  const bot = payload.botRef as { appId?: string } | undefined;
  if (bot?.appId === undefined) return undefined;
  return {
    appId: bot.appId,
    installationId: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
  };
}

/**
 * What `prepare` hands the paid step, as data: the authoritative checkout, the
 * round's captured context and the ONE anchored deadline. No container handle,
 * no token, no `Set` — a resumed `review` re-derives those from `deps` plus
 * this document, and a JSON round-trip of it is a faithful restart input.
 */
export type PreparedAttempt = {
  headSha: string;
  /** The absolute instant every later step bills: the anchored exec deadline. */
  runnerDeadlineMs: number;
  /** The frozen allocation the exec was anchored with (requested, then clamped). */
  runnerRequestedMs: number;
  runnerEffectiveMs: number;
  /**
   * The budget quartet the round logs on every line from the anchor on, so a
   * resumed phase logs the SAME numbers instead of re-deriving them.
   */
  budget: {
    requested_ms: number;
    effective_ms: number;
    cutoff_ms: number;
    deadline_ms: number;
    work_units: number | null;
  };
  /** The App's model selector chain (never its keys), for the artifact record. */
  modelChain: string | undefined;
  observedChangedLines: number | null;
  reconFacts: string[];
  recheckInput: RecheckInput | undefined;
  recheckAssignmentMaxBytes: number | undefined;
  prContext: PrContext | undefined;
  sinceSha: string | null;
  diffText: string;
  targets: RecheckTarget[];
  totalOpen: number;
  captureFailed: boolean;
  pendingApplyFailed: boolean;
  discussion: Discussion;
  askedDiscussion: Discussion;
  catalogExcluded: string[];
  catalogBudgetExcluded: string[];
  budgetExcluded: string[];
};

export type PrepareStep = { kind: "prepared"; prepared: PreparedAttempt } | SettledAttempt;

/** The paid step's durable outcome: the launch row's own state. */
export type ReviewOutcome = { state: "persisted"; persistedAtMs: number };

/**
 * What `collect` hands `publish`: the durable reference. The staged journal row
 * is the authority for everything the send needs, so a restart after staging
 * publishes from that row alone.
 */
export type CollectedAttempt = { publicationId: string };

export type CollectStep = { kind: "collected"; collected: CollectedAttempt } | SettledAttempt;

/** What `cleanup` concluded about the container, from durable facts only. */
export type CleanupOutcome = { retention: "no-paid-work" | "retained" | "unknown" };

/**
 * The §7.10 Check settlement of one attempt. Hook exceptions and timeouts are
 * isolated warns; the begin is bounded by the 2 s consumer hook bound and the
 * terminalize by the operator's update budget, and every terminal path reports
 * exactly one outcome.
 */
export function createCheckSettlement(input: CheckSettlementInput): CheckSettlement {
  const { deps, payload, attemptId, checkBudgets, deadlineMs } = input;
  const sandboxId = attemptSandboxId(attemptId);
  /** The base log identity every line carries (the delivery's own facts). */
  const baseLog = (): ConsumerLogFields => toBaseFields(payload);
  /** The round's log fields when the caller already derived them, else the base. */
  const roundLog = (): ConsumerLogFields => settlement.fields ?? baseLog();
  const abandonCheck = (
    handle: CheckHandle,
    reason: string,
    options?: { outcome?: CheckTerminalOutcome; inheritedHeadSha?: string; budgetExhaustion?: BudgetExhaustedOutcome },
  ): Promise<boolean> => {
    const abandon = deps.checks?.abandonTerminalize;
    // No give-up seam (test doubles only; production always supplies it):
    // nothing can prove this attempt released, so report the handoff as failed.
    if (abandon === undefined) return Promise.resolve(false);
    const line = {
      ...baseLog(),
      sandbox_id: sandboxId,
      attempt_id: handle.attemptId,
      check_reason: reason,
    };
    // Two budgets of margin past the abandoned send itself (the promotion runs
    // on the operator's update budget), never shorter than the shared rung.
    const firstRecoveryDelayMs =
      settlement.promotionAbandoned === handle.attemptId
        ? Math.max(
            CHECK_BACKOFF_MS[0]!,
            2 * (checkBudgets?.updateMs ?? CHECK_UPDATE_DEFAULT) + 60_000,
          )
        : undefined;
    const release = abandon({
      handle,
      reason,
      ...(options?.outcome === undefined ? {} : { outcome: options.outcome }),
      ...(options?.inheritedHeadSha === undefined ? {} : { inheritedHeadSha: options.inheritedHeadSha }),
      ...(options?.budgetExhaustion === undefined ? {} : { budgetExhaustion: options.budgetExhaustion }),
      ...(firstRecoveryDelayMs === undefined ? {} : { firstRecoveryDelayMs }),
    }).then(
      (released) => {
        if (released) {
          deps.log.warn(
            { ...line, event: "check_abandon_released" },
            `check attempt released to the recovery lane (${reason})`,
          );
          return true;
        }
        // The fenced release wrote NOTHING: the attempt is no longer ours to
        // hand over (recovery already claimed it, its lease expired, or it
        // already ended). That is a legitimate no-op — never a fault.
        deps.log.warn(
          { ...line, event: "check_abandon_not_owned" },
          `check attempt not released — recovery already owns it, or its lease is no longer live (${reason})`,
        );
        return false;
      },
      (err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...line, event: "check_abandon_failed" },
          `check attempt release failed (the hand-off itself faulted): ${detail}`,
        );
        return false;
      },
    );
    deps.background?.waitUntil(release);
    return release;
  };

  const runTerminalize = async (
    handle: CheckHandle,
    publicationId: string | null,
    outcome: CheckTerminalOutcome,
    inheritedHeadSha?: string,
    budgetExhaustion?: BudgetExhaustedOutcome,
  ): Promise<void> => {
    // The per-attempt read always precedes every terminal path; the fallback
    // keeps a future caller bounded by the store's documented defaults.
    const budgets = checkBudgets ?? {
      terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
      updateMs: CHECK_UPDATE_DEFAULT,
      degraded: false,
    };
    // Set when this attempt stops waiting on the hook: only past that point is
    // a later rejection detached, so only then does the sink report it.
    let abandoned = false;
    // The give-up handoff the overrun callback starts: awaited below when no
    // invocation context can own it (spec §7.10's no-context fallback).
    let giveUpRelease: Promise<boolean> | undefined;
    // Elapsed time is the diagnostic that separates "the hook never ran" from
    // "it ran and timed out"; recorded on the attempt (migration 0052) because
    // the log lines below are not queryable after the fact.
    const startedMs = Date.now();
    const record = (outcome: "completed" | "budget-exceeded" | "hook-failed"): Promise<void> =>
      recordTerminalizeOutcome(deps.env.DB, handle.attemptId, outcome, Date.now() - startedMs).catch(
        () => {},
      );
    /**
     * The overrun callback cannot await, and it must not add a second
     * `waitUntil` entry: the invocation already holds the abandon release,
     * whose D1 round-trip keeps the isolate alive long enough for this one-line
     * diagnostic write to land. Losing it costs a diagnostic row, never a Check.
     */
    const recordDetached = (outcome: "budget-exceeded"): void => {
      void record(outcome);
    };
    if (settlement.promotionAbandoned === handle.attemptId) {
      // The promotion's PATCH may still be on the wire (its bound only stopped
      // the wait). A terminal write from THIS attempt could be overtaken by
      // it and the finished run reopened — and a reopened run is no longer due
      // for recovery (`terminal_ms` is set), so it would read `in_progress`
      // forever. Hand the attempt over with the conclusion this attempt
      // already computed (the inherited head included) and let the recovery
      // lane be the last writer, minutes behind the abandoned request.
      const release = abandonCheck(
        handle,
        "check promotion exceeded its update budget (the terminal send is left to recovery)",
        {
          outcome,
          ...(budgetExhaustion === undefined ? {} : { budgetExhaustion }),
          ...(inheritedHeadSha === undefined ? {} : { inheritedHeadSha }),
        },
      );
      if (deps.background === undefined) await release;
      // This exit hands the attempt over without ever calling the hook. Record
      // it with a NULL elapsed so `handed-off` never reads as a fast success:
      // the column exists to separate "never ran" from "ran and timed out". The
      // store turns `completed` into `handed-off` for a row whose observation
      // never met its intent.
      await recordTerminalizeOutcome(deps.env.DB, handle.attemptId, "completed", null).catch(() => {});
      return;
    }
    try {
      const terminalize = deps.checks!.terminalize({
        handle,
        publicationId,
        outcome,
        ...(budgetExhaustion === undefined ? {} : { budgetExhaustion }),
        ...(inheritedHeadSha === undefined ? {} : { inheritedHeadSha }),
        updateBudgetMs: budgets.updateMs,
      });
      // The invocation owns the promise: if the budget below expires, the hook
      // still finishes after this attempt returns. A rejection landing after
      // that point has no inline waiter left to report it.
      deps.background?.waitUntil(
        terminalize.catch((err: unknown) => {
          if (!abandoned) return; // the inline await below already reports it
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            {
              ...baseLog(),
              sandbox_id: sandboxId,
              attempt_id: handle.attemptId,
            },
            `check terminalize hook failed after its budget (detached): ${detail}`,
          );
        }),
      );
      await withHookTimeout(
        terminalize,
        undefined as void,
        budgets.terminalizeMs,
        () => {
          abandoned = true;
          deps.log.warn(
            {
              ...baseLog(),
              sandbox_id: sandboxId,
              attempt_id: handle.attemptId,
              event: "check_terminalize_budget_exceeded",
            },
            deps.background === undefined
              ? "check terminalize hook exceeded its budget (detached; no invocation context to finish it)"
              : "check terminalize hook exceeded its budget (left to the invocation context)",
          );
          // Released at the instant we give up: the attempt would otherwise
          // hold its lease until the immutable execution deadline, which is
          // what made the Check terminalize up to 15 minutes late. The promise
          // is awaited right below when no invocation context can own it.
          giveUpRelease = abandonCheck(handle, `terminalize budget exceeded (${budgets.terminalizeMs}ms)`, {
            // A wall-clock stop's frozen intent is decidable from the outcome
            // alone, so the hand-off carries it; every other outcome keeps the
            // generic unconfirmed fallback the recovery lane corrects.
            ...(outcome === "budget-exhausted" ? { outcome, budgetExhaustion } : {}),
          });
          recordDetached("budget-exceeded");
        },
      );
      // The overrun path has the same no-context fallback as the throw path:
      // one fenced D1 write, never a remote send, so the lease is released
      // before this attempt returns even without `waitUntil`.
      if (giveUpRelease !== undefined && deps.background === undefined) await giveUpRelease;
      if (!abandoned) await record("completed");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        {
          ...baseLog(),
          sandbox_id: sandboxId,
          attempt_id: handle.attemptId,
          event: "check_terminalize_failed",
        },
        `check terminalize hook failed (isolated): ${detail}`,
      );
      // The hook never sent a conclusion, so this exit is NOT a completed
      // send. Recorded while the row still has no outcome, so a failed hook
      // stays distinguishable from one that ran and landed.
      await record("hook-failed");
      const release = abandonCheck(handle, `terminalize hook threw: ${detail}`, {
        ...(outcome === "budget-exhausted" ? { outcome, budgetExhaustion } : {}),
      });
      // Awaited only when no invocation context can own it (one fenced write).
      if (deps.background === undefined) await release;
    }
  };

  const terminalizeCheck = async (
    publicationId: string | null,
    outcome: CheckTerminalOutcome,
    inheritedHeadSha?: string,
    budgetExhaustion?: BudgetExhaustedOutcome,
  ): Promise<void> => {
    if (deps.checks === undefined || settlement.handle === null || settlement.terminalized) return;
    settlement.terminalized = true;
    await runTerminalize(settlement.handle, publicationId, outcome, inheritedHeadSha, budgetExhaustion);
  };

  /**
   * The run is created `queued` at delivery acceptance (spec §7.9), so the
   * review's own begin is what makes the public status truthful. Promoted
   * here under the operator's update budget — NEVER the begin hook's 2 s,
   * which bounds a different step — and this wait is bounded too, but the
   * FAILURE REPORT belongs to the adapter alone: it owns the same budget and
   * names the real cause, so warning again here would log one hung PATCH
   * twice. Only an unexpected rejection (the adapter promises never to throw)
   * is reported at this layer, as the unhandled-rejection guard.
   *
   * The ANSWER is what matters to the caller: `abandoned` means the PATCH may
   * still be on the wire, so the terminal write must not be issued from this
   * attempt.
   */
  const promoteCheckInProgress = async (handle: CheckHandle): Promise<CheckPromotion["kind"]> => {
    if (deps.checks?.markInProgress === undefined) return "settled";
    const budgetMs = checkBudgets?.updateMs ?? CHECK_UPDATE_DEFAULT;
    const warn = (detail: string) =>
      deps.log.warn(
        {
          ...roundLog(),
          attempt_id: handle.attemptId,
          event: "check_in_progress_failed",
        },
        detail,
      );
    try {
      const waited = await boundedBestEffort(
        deps.checks
          .markInProgress({
            handle,
            summary: CHECK_SUMMARIES.inProgress(handle.headSha.slice(0, 7)),
            updateBudgetMs: budgetMs,
            warn,
          })
          .catch((err: unknown): CheckPromotion => {
            // A rejection that lands after this layer stopped waiting still
            // gets its warn instead of becoming an unhandled rejection.
            warn(`check in-progress promotion failed (the review is unaffected): ${err instanceof Error ? err.message : String(err)}`);
            return { kind: "settled", promoted: false };
          }),
        budgetMs,
      );
      // This layer stopped waiting: the adapter may still be mid-send, so the
      // only safe reading is "abandoned" (its own warn carries the cause).
      if (waited === null) return "abandoned";
      return waited.value.kind;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warn(`check in-progress promotion failed (the review is unaffected): ${detail}`);
      return "settled";
    }
  };

  /**
   * The §7.10 begin hook over one SHA, isolated exactly as before: its own
   * latch (never shared or reset), the 2 s consumer bound, and a throw that
   * only warns — a Check never prevents the review.
   */
  const beginCheck = async (
    scope: Scope,
    githubAppId: number,
    headSha: string,
    expect?: AttemptIdentity,
  ): Promise<CheckHandle | null> => {
    if (deps.checks === undefined) return null;
    // Every begin owns the flag: it must always describe the handle we return.
    settlement.promotionAbandoned = null;
    // One latch per `begin` call, created HERE and never stored anywhere: a
    // later message cannot clear or reuse it, so a detached begin from this
    // message stays abandoned for its whole lifetime (QC1-001 replacement
    // race).
    const beginLatch = createCheckBeginLatch();
    let handle: CheckHandle | null;
    try {
      handle = await withHookTimeout(
        deps.checks.begin({
          scope,
          githubAppId,
          headSha,
          triggeredBy: payload.triggered_by,
          action: payload.action,
          // The check row's execution deadline IS the attempt's frozen hard
          // stop (adoption narrows the attach window to this same instant), so
          // the reconciler and the execution fence agree without a re-read.
          executionDeadlineMs: deadlineMs,
          latch: beginLatch,
          ...(expect === undefined ? {} : { expect }),
        }),
        null,
        // The begin hook keeps §7.10's 2 s: it runs before model work.
        CHECK_HOOK_TIMEOUT_MS,
        // The attempt gave up waiting: a lifecycle that reads this call's
        // latch stops attaching state on behalf of this abandoned invocation
        // and leaves the created run with a terminal obligation (§7.10's
        // budget is a consumer bound, not a licence to create an attempt
        // nobody will ever terminalize).
        () => {
          beginLatch.abandon();
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        roundLog(),
        `check begin hook failed (isolated, no Check): ${detail}`,
      );
      return null;
    }
    // A handle means THIS review is starting, so the run may say so — and if
    // that send was abandoned rather than settled, this attempt must not
    // terminalize the run itself (the promotion may still land).
    settlement.handle = handle;
    if (handle !== null && (await promoteCheckInProgress(handle)) === "abandoned") {
      settlement.promotionAbandoned = handle.attemptId;
    }
    return handle;
  };
  const settlement: CheckSettlement = {
    handle: null,
    claimAttempted: false,
    fields: undefined,
    promotionAbandoned: null,
    terminalized: false,
    begin: beginCheck,
    abandon: abandonCheck,
    terminalize: terminalizeCheck,
  };
  return settlement;
}

/** The AL-6/SEC-01 facts carrier a phase starts from. */
function beginProgress(): ReviewAttemptProgress {
  return {
    failureStage: "pipeline",
    secretValues: [],
    runnerStartedAt: undefined,
    runnerReturned: false,
  };
}

/** The App adapter this delivery's host resolved — never a phase input. */
function requireCommenter(deps: ProcessDeps, payload: ReviewJobPayload): ReviewCommenter {
  const entry = deps.appCommenters.get(payload.botRef.appId);
  if (entry === undefined) {
    throw new Error(
      `review attempt: no credential adapter is registered for app ${payload.botRef.appId} — the host resolves the App before it runs an attempt step`,
    );
  }
  return entry.commenter;
}

/** The App's resolved runner config this delivery's host registered. */
function requireRunnerConfig(deps: ProcessDeps, payload: ReviewJobPayload): RunnerConfig {
  const config = deps.runnerConfigs.get(payload.botRef.appId);
  if (config === undefined) {
    throw new Error(
      `review attempt: no runner config is registered for app ${payload.botRef.appId} — the host resolves the App's AI config before it runs an attempt step`,
    );
  }
  return config;
}

/** The §7.10 settlement this invocation created, when it created one. */
function maybeSettlement(deps: ProcessDeps, attemptId: string): CheckSettlement | undefined {
  return deps.checkSettlements.get(attemptId);
}

/**
 * The settlement a LATER phase terminalizes through, re-adopted when this host
 * did not prepare. An empty cache must not mean "leave the Check in progress
 * forever after a successful publication": the settlement is re-created and
 * adopted through the same claim path `prepare` used (the lifecycle attaches to
 * the existing attempt for this scope+head). When adoption is impossible — no
 * Checks surface, or nothing adoptable — the run is handed to the reconciler
 * explicitly, which is the documented outcome for an abandoned attempt.
 */
async function settlementFor(
  deps: ProcessDeps,
  ref: AttemptRef,
  headSha: string,
): Promise<CheckSettlement | undefined> {
  const cached = deps.checkSettlements.get(ref.attemptId);
  if (cached !== undefined) return cached;
  const scope = scopeOf(ref.payload);
  if (deps.checks === undefined || scope === undefined) return undefined;
  const settlement = createCheckSettlement({
    deps,
    payload: ref.payload,
    attemptId: ref.attemptId,
    checkBudgets: ref.checkBudgets,
    deadlineMs: ref.deadlineMs,
  });
  settlement.fields = attemptFields(ref.payload, ref.level, ref.attemptId, headSha);
  // Adoption IS a claim attempt: the fallback path must not claim twice.
  settlement.claimAttempted = true;
  // ADOPTION USES THE FROZEN PAIR, never "the latest open generation of this
  // key": the launch row recorded which generation this attempt owns when it
  // was created, and a newer one belongs to another attempt. NO PAIR, NO CLAIM:
  // passing `undefined` would select the unrestricted fresh-claim path, which
  // can MINT a generation for a key this attempt does not own — so a resumed
  // settlement with no frozen identity claims nothing at all and leaves the run
  // to the reconciler.
  const identity = await readAttemptIdentity(deps.env.DB, ref.attemptId);
  if (identity === null) {
    deps.log.warn(
      { ...settlement.fields, event: "check_settlement_not_adopted" },
      "check settlement not adopted on a resumed step — the attempt row froze no Check identity, so nothing is claimed",
    );
    return undefined;
  }
  const handle = await settlement.begin(scope, ref.githubAppId, headSha, identity);
  if (handle === null) {
    // No adoption: a live holder owns the row (the real lifecycle refuses to
    // take it) or nothing was adoptable. Cache NOTHING — a settlement without
    // a handle is worse than none — and record the obligation on the ATTEMPT
    // row, never on the Check row: that row's lease, suspension and error
    // fields belong to its own owner. One conditional write on the row that
    // outlives this invocation, and the recovery lane is due once the holder
    // releases.
    deps.log.warn(
      { ...settlement.fields, event: "check_settlement_not_adopted" },
      "check settlement not adopted on a resumed step — the obligation is recorded once its publication is durable",
    );
    return undefined;
  }
  deps.checkSettlements.set(ref.attemptId, settlement);
  return settlement;
}

/**
 * The publication path may use ONLY the identity the launch row froze. A row
 * without one means the attempt never learned its head — nothing can be
 * associated, and the miss is named rather than papered over with a guess.
 */
function assertFrozenIdentity(identity: AttemptIdentity | null, attemptId: string, headSha: string): void {
  if (identity !== null) return;
  throw new Error(
    `attempt ${attemptId}: the launch row carries no frozen attempt identity (head ${headSha}) — refusing to associate a derived one`,
  );
}

/**
 * Settle a MOVED HEAD: this attempt concludes its Check as skipped, writes the
 * skip row, and throws so the delivery retries under a fresh attempt id. It
 * never reviews the observed head under the previous identity.
 */
async function settleMovedHead(
  deps: ProcessDeps,
  ref: AttemptRef,
  check: CheckSettlement,
  headSha: string,
  frozenKey: string,
  observedKey: string,
): Promise<never> {
  // THE OUTBOX ROW PRECEDES THE SETTLEMENT. This attempt is about to conclude
  // its Check as skipped, and once that is done nothing else records the head
  // that displaced it — an interruption below would leave a head with no review
  // and no record of what was owed. The intent is written first (idempotent, so
  // a retry writes the same row), and a failure to write it aborts the
  // settlement: the delivery retries and detects the moved head again, instead
  // of terminalizing a run whose successor was never recorded.
  const intent = successorIntentOf(ref.payload, headSha);
  if (intent !== null) {
    await recordSuccessorIntent(deps.env.DB, {
      dedupeKey: intent.dedupeKey,
      payload: intent.payload,
      nowMs: Date.now(),
    });
  }
  await check.terminalize(null, "skipped", headSha);
  // A skip-settlement fault must not mask the moved head: the attempt is over
  // either way, and the error below is what starts the new one.
  await settleSkippedRow(deps, ref.payload, headSha, "the head moved between admission and the checkout", true).catch(
    () => {},
  );
  deps.log.warn(
    { ...attemptFields(ref.payload, ref.level, ref.attemptId, headSha), event: "review_moved_head" },
    `observed head ${observedKey} is not the frozen ${frozenKey} — settled as skipped; the delivery retries under a new attempt`,
  );
  throw new MovedHeadError(ref.attemptId, frozenKey, observedKey);
}

/**
 * Record that this attempt's Check settlement is still owed — ONLY once a
 * publication for it is durable and the Check has not concluded. The key is the
 * Check row's own `attempt_key` (the association is that derived identity, not
 * two random UUIDs) and the due instant is the recovery lane's first backoff
 * rung, so the select honours it instead of bypassing `next_attempt_ms`.
 */
async function noteOwedCheck(
  deps: ProcessDeps,
  ref: AttemptRef,
  headSha: string,
  /** The Check row THIS attempt held, when its settlement had one. */
  checkAttemptId?: string,
): Promise<void> {
  const scope = scopeOf(ref.payload);
  if (scope === undefined || deps.checks === undefined) return;
  // The identity comes from the ROW — key AND generation, both frozen at
  // creation. Neither is re-derived and neither is looked up: with the key
  // frozen, a later generation can only be another attempt's row.
  const identity = await readAttemptIdentity(deps.env.DB, ref.attemptId);
  if (identity === null) {
    // No frozen identity means no Check was ever associated with this attempt,
    // so there is nothing to owe. A REAL Check row behind the handle with no
    // frozen identity is the genuine inconsistency — the assertion names it
    // instead of deriving one (a stub handle has no row and is simply nothing).
    if (checkAttemptId !== undefined && (await readCheckIdentity(deps.env.DB, checkAttemptId)) !== null) {
      assertFrozenIdentity(identity, ref.attemptId, headSha);
    }
    return;
  }
  // No handle is fine: the obligation is derived from the durable publication
  // and the frozen identity, and the reconciler is the consumer.
  const owed = await noteCheckOwed(deps.env.DB, {
    attemptId: ref.attemptId,
    checkKey: identity.key,
    checkGeneration: identity.generation,
    dueMs: Date.now() + CHECK_BACKOFF_MS[0]!,
  });
  if (!owed) return; // the Check is settled (or has no open row): nothing is owed
  deps.log.warn(
    { ...attemptFields(ref.payload, ref.level, ref.attemptId, headSha), event: "check_settlement_owed" },
    "check settlement owed — the attempt row carries the obligation for the recovery lane",
  );
}

/** The round's structured log fields, derived from data alone. */
function attemptFields(
  payload: ReviewJobPayload,
  level: ReviewLevel,
  attemptId: string,
  headSha: string | null,
  budget?: PreparedAttempt["budget"],
): ConsumerLogFields {
  return {
    ...toBaseFields(payload),
    level,
    runner_timeout_ms: runnerTimeoutMs(level),
    orchestration: level === "deep" ? "parent" : "bun-fanout",
    sandbox_id: attemptSandboxId(attemptId),
    ...(budget === undefined
      ? {}
      : {
          runner_requested_ms: budget.requested_ms,
          runner_effective_ms: budget.effective_ms,
          runner_cutoff_ms: budget.cutoff_ms,
          runner_deadline_ms: budget.deadline_ms,
          runner_work_units: budget.work_units,
        }),
    ...(headSha === null
      ? {}
      : {
          head_sha: headSha,
          idempotency_key: idemKey({
            installation_id: payload.installation_id,
            owner: payload.owner,
            repo: payload.repo,
            pr_number: payload.pr_number,
            head_sha: headSha,
          }),
        }),
  };
}

/** A phase failure carrying the facts as data, with the cause intact. */
function phaseFailure(
  phase: FailureFacts["phase"],
  err: unknown,
  facts: Omit<FailureFacts, "phase">,
): AttemptPhaseError {
  return new AttemptPhaseError({ phase, ...facts }, err);
}

/**
 * The launch row's own state — the durable outcome a phase reports. Only a
 * `persisted` row carries one; every other state (a container cleanup owns, a
 * paid call with no durable outcome, a failed one, an unclaimed attempt) is
 * `unknown` for this reader, and nothing may be published from it.
 */
async function readPersistedLaunch(deps: ProcessDeps, attemptId: string): Promise<ReviewOutcome> {
  const verdict = launchVerdict(await readReviewLaunch(deps.env.DB, attemptId));
  switch (verdict.kind) {
    case "persisted":
      return { state: "persisted", persistedAtMs: verdict.persistedAtMs };
    case "never-claimed":
    case "never-paid":
    case "owned-by-cleanup":
    case "unrecognised":
    case "paid-unknown":
    case "paid-failed":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: the paid result is not durable (${verdict.kind}) — nothing may be published from it`,
      );
    default:
      return noLaunchState(verdict);
  }
}

/** The paid result, read from the launch row rather than a predecessor's return value. */
async function readPaidExecution(deps: ProcessDeps, attemptId: string): Promise<ReviewAttemptExecution> {
  const verdict = launchVerdict(await readReviewLaunch(deps.env.DB, attemptId));
  switch (verdict.kind) {
    case "persisted":
      return verdict.execution;
    case "never-claimed":
    case "never-paid":
    case "owned-by-cleanup":
    case "unrecognised":
    case "paid-unknown":
    case "paid-failed":
      throw new AttemptUnknownError(
        `attempt ${attemptId}: the paid result is not durable (${verdict.kind}) — nothing may be published from it`,
      );
    default:
      return noLaunchState(verdict);
  }
}

/**
 * Phase 1 — prepare. Container, purpose-scoped credential and the
 * authoritative checkout, then the dedupe/journal/usage gates, the lifecycle
 * context, the trusted diff evidence and the ONE derived round budget. Every
 * early exit here is a settlement: the attempt owes nothing more.
 */
export async function prepareAttempt(deps: ProcessDeps, ref: AttemptRef): Promise<PrepareStep> {
  const progress = beginProgress();
  const observed: { headSha: string | null; runnerEffectiveBudgetMs: number | undefined } = {
    headSha: null,
    runnerEffectiveBudgetMs: undefined,
  };
  try {
    return await preparePhase(deps, ref, progress, observed);
  } catch (err) {
    throw phaseFailure("prepare", err, {
      stage: progress.failureStage,
      headSha: observed.headSha,
      secretValues: progress.secretValues,
      runnerStartedAt: progress.runnerStartedAt,
      runnerReturned: progress.runnerReturned,
      runnerEffectiveBudgetMs: observed.runnerEffectiveBudgetMs,
      changedLines: null,
      sendAttemptPublicationId: null,
    });
  }
}

async function preparePhase(
  deps: ProcessDeps,
  ref: AttemptRef,
  progress: ReviewAttemptProgress,
  observed: { headSha: string | null; runnerEffectiveBudgetMs: number | undefined },
): Promise<PrepareStep> {
  const {
    payload,
    attemptId,
    roundStartedAt,
    level,
    githubAppId,
    usageWorkspaceId,
    usageSource,
  } = ref;
  const sandboxId = attemptSandboxId(attemptId);
  const commenter = requireCommenter(deps, payload);
  const check = createCheckSettlement({
    deps,
    payload,
    attemptId,
    checkBudgets: ref.checkBudgets,
    deadlineMs: ref.deadlineMs,
  });
  deps.checkSettlements.set(attemptId, check);
  let baseFields: ConsumerLogFields | undefined;
  let fields: ConsumerLogFields | undefined;
  let sandbox: ReviewSandbox | null = null;
  let lifecycleScope: Scope | undefined;
  let roundBudget: ReviewBudget | null = null;
  let observedChangedLines: number | null = null;
  // F-001 (QC wave-1): toBaseFields derefs payload.botRef.appId, so an
  // in-flight pre-deploy message (no `botRef` — AL-24-4 accepts the
  // TypeError) must throw INSIDE the try: it then flows through the
  // established structured channel (review failed: log + AL-6
  // review_failures row + rethrow). Pure relocation — no runtime guard
  // (AL-24-4 forbids one).
  baseFields = toBaseFields(payload);
  // §7.10 Check lane scope — the same App/PR identity the publication journal
  // and the attempt key use, derivable from the payload alone.
  lifecycleScope = {
    appId: payload.botRef.appId,
    installationId: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
  };
  if (ref.checkClaimSha !== null) {
    // The claim the consumer decided the head of: it runs here, before any
    // provisioning, so the settlement that terminalizes it lives beside it.
    check.claimAttempted = true;
    await check.begin(lifecycleScope, githubAppId, ref.checkClaimSha);
  }
  // The identity is NOT frozen here: the checkout may contradict the admitted
  // claim, and the Check lane then re-claims at the authoritative head. The
  // identity frozen is the one the LIVE claim owns, below.
  // 1-3. Container + purpose-scoped credential + authoritative checkout:
  // the attempt body acquires them and advances `progress.failureStage`.
  const prepared = await prepareReviewAttempt({
    payload,
    deps,
    commenter,
    attemptId,
    identity: null,
    sandbox,
    onSandbox: (acquired) => {
      sandbox = acquired;
    },
    progress,
  });
  sandbox = prepared.sandbox;
  const token = prepared.token;
  const cmds = prepared.cmds;
  const headSha = prepared.headSha;
  observed.headSha = headSha;
  // A MOVED HEAD never continues on the old identity. The identity frozen below
  // is the one the LIVE claim owns — the claim the checkout settled on, after
  // any supersede — so a frozen key that disagrees with it can only mean another
  // caller froze a DIFFERENT head, and that attempt settles as skipped.
  // The host caches the credential it just minted, so the phases of THIS
  // invocation never re-mint; a resumed host starts empty and mints again.
  deps.credentials.set(attemptId, { token, secretValues: progress.secretValues });

  const key: IdempotencyKey = {
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: headSha,
  };
  fields = {
    ...baseFields,
    // d5-budget L5: the level's clock rides every structured log from here
    // on (same ConsumerLogFields channel — no new sink).
    level,
    runner_timeout_ms: runnerTimeoutMs(level),
    // deep = parent session; quick/default = Bun seat fan-out. Never a
    // fabricated seat_count for deep (spec § Queue visibility).
    orchestration: level === "deep" ? "parent" : "bun-fanout",
    head_sha: headSha,
    idempotency_key: idemKey(key),
    sandbox_id: sandboxId,
  };
  check.fields = fields;

  // §7.7 step 4 / §7.9: resolve a CONTRADICTED claim against the
  // authoritative checkout HERE — before any dedup/journal early exit, so a
  // delivery whose claimed SHA was disproved can never close the wrong head's
  // run as `skipped`. (A message that had no knowable SHA at admission is a
  // different case: its claim stays at the post-capture fallback below, so a
  // duplicate or journal hand-off of a comment trigger never creates a run.)
  // The checkout's OWN claim waits for the dedup read below: an already
  // reviewed head is acked, never claimed.
  let supersededClaimReleased = false;
  if (check.handle !== null && check.handle.headSha !== headSha) {
    const supersededHandle = check.handle;
    check.handle = null;
    deps.log.warn(
      fields,
      `check attempt superseded: claimed ${supersededHandle.headSha.slice(0, 7)}, checked out ${headSha.slice(0, 7)}`,
    );
    // Freeze the contradicted attempt's `superseded` intent and release it —
    // TWO fenced D1 writes (intent + release), no remote request. Its remote
    // send belongs to the minute recovery cron, so the new head's review
    // never waits on the Check hook.
    supersededClaimReleased = await check.abandon(
      supersededHandle,
      "the checkout proved a newer commit than the claim",
      { outcome: "superseded" },
    );
    if (!supersededClaimReleased) {
      // The handoff failed, so the old attempt may still hold this
      // consumer's lease: claiming the new head anyway would put two live
      // consumer-owned claims on one invocation. A Check fault never blocks
      // the review — this message reviews the checked-out commit with NO
      // Check, and the old attempt's own deadline hands it to recovery.
      deps.log.warn(
        fields,
        `check supersede handoff failed — continuing the review for ${headSha.slice(0, 7)} with no Check`,
      );
    }
  }

  // 4. Dedup (§7.7 step 2, first half): already completed for this
  // checked-out sha → ack (no post, no insert). KV done-state first (B3),
  // then D1. Keyed off the checkout, so a force-push between delivery and
  // processing is never mis-deduped against the stale payload sha.
  const done = await kvDoneHit(deps.env.IDEMPOTENCY_KV, idemKey(key), fields, deps.log);
  if (done) {
    deps.log.info(fields, "KV idempotency hit — ack");
    // A handle exists only when the claim's SHA WAS the checkout (a
    // concurrent duplicate): that run must be closed, carrying THIS head's
    // existing result (inherited like an empty increment), never a `neutral`
    // that would mask a failing gate.
    await check?.terminalize(null, "skipped", headSha);
    // §7.9: with no handle (the adoption refused) the attached run would
    // otherwise wait out the attach window and close red. The settlement is
    // keyed on the PAYLOAD SHA — what the attach used — not this checkout SHA.
    await settleSkippedRow(deps, payload, payload.head_sha, "already reviewed for this head");
    return { kind: "settled", outcome: { kind: "ok" } };
  }
  const existing = await deps.store.findByIdempotencyKey(key);
  if (existing) {
    deps.log.info(fields, "idempotency hit — ack");
    await check?.terminalize(null, "skipped", headSha);
    await settleSkippedRow(deps, payload, payload.head_sha, "already reviewed for this head");
    return { kind: "settled", outcome: { kind: "ok" } };
  }
  // §7.7 step 2 (second half) — the publication journal: an existing
  // prepared/sending/unknown/confirmed row for this exact scope/SHA hands
  // off to recovery and ACKs without another paid review. Pending recovery
  // is never deleted by a same-SHA mention re-run.
  const journalRow = await journalHandoffRow(deps.env.DB, lifecycleScope, headSha);
  if (journalRow !== null) {
    deps.log.info(
      fields,
      `publication journal hit (phase ${journalRow.phase}, id ${journalRow.id}) — handing off to recovery, ack without a second paid review`,
    );
    // A `prepared` row hands delivery to the recovery lane; it does NOT
    // claim the review is visible — the publication still owes its send, and
    // recovery owns it. Nothing here waits for it or asserts it.
    // Deliberately NOT terminalized: this attempt published nothing, and the
    // publication on this head belongs to an earlier generation. LINKING that
    // row is what makes it this attempt's proof, so the conclusion stays with
    // the publication: an applied proof decides `success`, and only the
    // execution deadline decides the honest failure. Freezing an intent here
    // would instead close the run for good — the correction seam needs a
    // non-null `publication_id` (which is exactly what this link supplies).
    //
    // Both writes are fenced on the claim lease, and either can refuse: the
    // claim runs 900s while the intervening sandbox/token/inflight/journal
    // steps are network calls with no enforced clock. A refusal writes
    // nothing, which is the honest outcome — the row keeps its current owner
    // and stays `in_progress`; once `lease_until_ms` passes, the reconcile
    // selector picks it up and the deadline path concludes it. A store fault
    // is a warn too: a Check fault never blocks the review's ack.
    if (check.handle !== null) {
      const nowMs = Date.now();
      const handoffFields = {
        ...fields,
        sandbox_id: sandboxId,
        attempt_id: check.handle.attemptId,
        check_reason: "publication journal handoff",
      };
      try {
        if (
          !(await linkCheckPublication(
            deps.env.DB,
            check.handle.attemptId,
            check.handle.lease,
            journalRow.id,
            nowMs,
          ))
        ) {
          deps.log.warn(
            { ...handoffFields, event: "check_abandon_not_owned" },
            "publication link refused by the check lease fence — the row keeps its owner and the deadline path concludes it (publication journal handoff)",
          );
        }
        if (
          !(await deferCheckRecovery(
            deps.env.DB,
            check.handle.attemptId,
            check.handle.lease,
            {
              state: "remote-unconfirmed",
              nextAttemptMs: nowMs + CHECK_BACKOFF_MS[0]!,
              reason: "publication journal handoff",
            },
            nowMs,
          ))
        ) {
          deps.log.warn(
            { ...handoffFields, event: "check_abandon_not_owned" },
            "claim release refused by the check lease fence — the row keeps its lease and the deadline path concludes it (publication journal handoff)",
          );
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...handoffFields, event: "check_abandon_failed" },
          `publication journal handoff faulted (the Check row is left to the recovery lane): ${detail}`,
        );
      }
    } else {
      // §7.9: no handle was adopted for this hand-off, so the delivery's own
      // attached run has nobody to close it — settlement carries the head's
      // own gate result (or `neutral` when it has none).
      await settleSkippedRow(deps, payload, payload.head_sha, "a publication for this head already exists");
    }
    return { kind: "settled", outcome: { kind: "ok" } };
  }
  // §7.7 step 4: claim the CHECKED-OUT head — only on a dedup AND journal
  // miss. The admission claim named the payload sha (or the watermark), which
  // this checkout just disproved; a head already reviewed or already
  // published never reaches here.
  if (supersededClaimReleased) {
    await check.begin(lifecycleScope, githubAppId, headSha);
  }

  // 4b. Usage ledger (migration 0031): one row per STARTED execution. Both
  // dedup reads and the journal handoff above have missed, so a duplicate
  // delivery of a completed review never reaches this insert; a genuine
  // re-execution after a runner failure mints the next `seq` for the same
  // review. The product rule is "count, never refuse": a write failure is
  // logged and recorded as a `usage` failure row carrying the metered
  // identity (`reviewId` + `workspaceId`) so the dropped attempt can be
  // reconciled. The review continues either way.
  const reviewId = idemKey({
    // The metered identity is the PAYLOAD identity (plan § Consumer write
    // point 3): the authoritative checkout sha refines the review row only,
    // so a force-push between delivery and retry cannot split one review
    // into two ledger identities. A comment-mention job has no payload sha
    // and shares one stable per-PR identity — `idemKey` refuses an empty
    // sha, so the "no commit" sentinel stands in.
    ...key,
    head_sha: payload.head_sha || "no-sha",
  });
  // The charge (D2, D5, D7): this execution's own resolved strength against
  // the source its bot scope selects, priced by the profile judging THIS UTC
  // month's first day — the same profile the enqueue's ceiling read, so the
  // rows and the ceiling can never be denominated differently. Recomputed
  // here instead of carried on the queue message: `level` is already resolved
  // and `scope` rides the credential read, so the charge costs one profile
  // read per started review and the message gains no field (a level change
  // between enqueue and consume is then priced at what actually ran).
  //
  // EVERYTHING that computes or writes this row is inside ONE boundary, the
  // profile read above all: `resolveQuotaProfile` THROWS when the profile
  // table is empty, and `self-hosted` never runs the enqueue gate that would
  // have absorbed it, so a charge priced outside this `try` would abort the
  // review — queue retry ×3, DLQ, no review posted and no ledger row. The
  // product rule here is "count, never refuse", and the recorded `usage`
  // failure row below is how a charge that could not be computed is
  // reconciled instead.
  const usageNow = new Date();
  // Named once so the price and its source cannot disagree: `rpFor` reads the
  // same value in the same expression.
  // Minted BEFORE the profile read: the failure row and the read-back must
  // name THIS attempt even when the charge never got computed. The row input
  // itself is built INSIDE the `try`, so no path can write a placeholder price.
  const executionToken = crypto.randomUUID();
  const usageOccurredAt = usageNow.toISOString();
  try {
    // No retry: a replay of the SAME token is already idempotent (the unique
    // index rejects it), and a retry that minted a NEW token would be a
    // different execution by definition — a second count for one attempt. A
    // dropped row stays reconcilable through the `usage` failure row below.
    await recordUsageEvent(deps.env.DB, {
      reviewId,
      executionToken,
      workspaceId: usageWorkspaceId,
      occurredAt: usageOccurredAt,
      rp: rpFor(level, usageSource, await resolveQuotaProfile(deps.env.DB, quotaMonth(usageNow).startIso)),
      source: usageSource,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A pre-commit failure and an ambiguous one (the write landed, the driver
    // threw) reach this catch identically. The token read-back separates them
    // and reports THREE states: `true` — this execution's row is present, so
    // the failure is noise; `false` — the read succeeded and found nothing,
    // the only state a backfill may act on; `"unknown"` — the read itself
    // failed, so nothing is known. A backfill must re-check the token before
    // inserting: the unique index only rejects a replay that REUSES the
    // recorded token, and a fresh token would mint another `seq`.
    //
    // A CHARGE that could not be computed (an empty profile table) reaches
    // this same catch: no row was attempted, so the read-back answers `false`
    // and the reconciliation below applies unchanged.
    const applied: true | false | "unknown" = await hasUsageEventForExecutionToken(
      deps.env.DB,
      executionToken,
    ).catch(() => "unknown" as const);
    deps.log.warn(
      { ...fields, review_id: reviewId, workspace_id: usageWorkspaceId, usage_applied: applied },
      `usage_events row not written (review continues): ${detail}`,
    );
    // The failure row is best-effort too — its own guard keeps a recording
    // failure from reaching the pipeline.
    try {
      await deps.failureStore.record({
        target_id: payload.targetId,
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        head_sha: headSha,
        stage: "usage",
        // The identity a backfill would write, and the source its price
        // comes from: `usageWorkspaceId` IS the charged workspace (the
        // target's), never the bot's.
        error: `usage_events row not written: ${detail} ${JSON.stringify({
          reviewId,
          workspaceId: usageWorkspaceId,
          executionToken,
          source: usageSource,
          applied,
        })}`,
      });
    } catch (recordErr) {
      const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      deps.log.warn(fields, `review_failures insert failed (usage failure, review continues): ${recordDetail}`);
    }
  }

  // 5. §7.7 step 3 — lifecycle context: apply this scope's pending
  // CONFIRMED journals in original publication order (an older assessment
  // never loses to a newer unapplied recurrence), then capture targets,
  // trusted diff evidence and discussions. Any capture/apply failure is
  // honest context-unavailable — the round cannot close stale lifecycle
  // state, never a false first-round closure.
  const captureMs = Date.now();
  let pendingApplyFailed = false;
  try {
    pendingApplyFailed = !(await applyPendingLifecycleJournals(deps.env.DB, lifecycleScope, captureMs));
    if (pendingApplyFailed) {
      deps.log.warn(fields, "pending lifecycle journal apply failed — proceeding with context-unavailable coverage (no closure this round)");
    }
  } catch (err) {
    pendingApplyFailed = true;
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `pending lifecycle journal read failed — context-unavailable: ${detail}`);
  }

  let targets: RecheckTarget[] = [];
  let totalOpen = 0;
  let captureFailed = false;
  try {
    targets = await selectAssessmentTargets(deps.env.DB, lifecycleScope, ASSESSMENT_TARGET_CAP);
    totalOpen = await countRecheckableFindings(deps.env.DB, lifecycleScope);
  } catch (err) {
    captureFailed = true;
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `lifecycle target capture failed — context-unavailable: ${detail}`);
  }

  // Incremental round selection: when this PR has a previously REVIEWED head,
  // ask GitHub whether it is an ancestor of this one AND whether the range is
  // this branch's own work. Only that combination is an honest increment
  // (base...head is then exactly the work since the last review);
  // `behind`/`diverged`/`identical`/a 404 after a force-push, any non-zero
  // exit, a merge commit or a truncated commit list keep the FULL diff. A
  // failed base read degrades the same way, but it is warned: a silent
  // fallback would disable incremental rounds forever with no trace.
  let incrementBase: string | null = null;
  try {
    incrementBase = await deps.findIncrementBase(deps.env.DB, lifecycleScope);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { ...fields, increment_base: "lookup-failed" },
      `increment base lookup failed — reviewing the full diff: ${detail}`,
    );
  }
  let sinceSha: string | null = null;
  if (incrementBase !== null && incrementBase !== headSha) {
    try {
      const compare = await sandbox.runCommand(
        compareGateCommand(payload.owner, payload.repo, incrementBase, headSha),
        { env: { GH_TOKEN: token }, timeout: EXEC_TIMEOUT_GIT_MS },
      );
      if (compare.exitCode !== 0) {
        deps.log.info(
          { ...fields, increment_status: `exit ${compare.exitCode}` },
          "incremental base not an ancestor of this head — reviewing the full diff",
        );
      } else {
        const gate = parseCompareGate(compare.stdout);
        // shortcut: any merge commit in the increment forces a full-diff round,
        // upgrade when merge-heavy PR branches make re-reviews common.
        if (gate === null) {
          deps.log.info(
            { ...fields, increment_status: "unusable" },
            "compare answer unusable — reviewing the full diff",
          );
        } else if (gate.branchWork) {
          sinceSha = incrementBase;
        } else if (gate.status === "ahead") {
          deps.log.info(
            { ...fields, increment_status: "ahead-merge" },
            "increment cannot be proven to be this branch's own work — reviewing the full PR diff",
          );
        } else {
          deps.log.info(
            { ...fields, increment_status: gate.status },
            "incremental base not an ancestor of this head — reviewing the full diff",
          );
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.info({ ...fields, increment_status: "unavailable" }, `compare status unavailable — full diff: ${detail}`);
    }
  }

  // Diff (GH_TOKEN via exec env only — never in the command). The command
  // writes the file for numstat AND streams a BOUNDED copy back: that stdout
  // is the WORKER-CONTROLLED §7.3 trusted capture the evidence catalog
  // slices and the line-intent hunk prefilter both derive from. The bounded
  // read names three outcomes, deliberately distinct:
  //   fit        → the text IS the capture;
  //   overflow   → over DIFF_PREFETCH_MAX_BYTES: the diff exists but cannot
  //                prove any row (no slices; base-filter line comments),
  //                never truncated slices;
  //   unreadable → no flag line at all: the transport broke, so the capture
  //                failed whatever the file holds (a zero-change PR still
  //                prints its `\n0\n` flag line).
  // An empty `fit` payload is NOT decided here: `gh pr diff` also writes
  // nothing for a PR with no changes, and only the numstat of the same round
  // can tell the two apart (see step 6).
  // An incremental round captures the FULL diff here as well: the prior
  // findings live in files the increment may not touch, so their evidence
  // catalog can only be proven against the whole PR diff. The increment
  // capture below feeds the numstat partition ONLY.
  // ONE window for the whole diff stage: the refused `gh pr diff` and the
  // oversized fallback draw their timeouts from this same deadline, so the
  // stage can never spend more than the `full-diff` ledger window it bills —
  // and never more than what the derived runner deadline still leaves.
  // EVERY post-diff sandbox step below (the increment capture, numstat, the
  // runner-input write, the PR-context reads) and the paid runner itself draw
  // from this ONE derived deadline, and a spent deadline declines explicitly
  // — no step starts on a fresh 120s window once the fallback was admitted.
  const terminalizeBudgetMs = ref.checkBudgets?.terminalizeMs ?? CHECK_TERMINALIZE_DEFAULT;
  // ONE derivation for the whole attempt: the FROZEN deadline (queue send +
  // operator cap, recorded at admission — never a fresh cap read here), the
  // live terminalize budget and the tier decide the reserve, the absolute
  // pre-runner cutoff and every window other owners bill from it. A replayed
  // prepare therefore derives the SAME cutoff.
  roundBudget = deriveReviewBudget({
    roundStartMs: roundStartedAt,
    deadlineMs: ref.deadlineMs,
    terminalizeMs: terminalizeBudgetMs,
    level,
  });
  const runnerDeadlineMs = roundBudget.runnerCutoffMs;
  const diffStageNow = Date.now();
  const diffWindowMs = boundedStepTimeout(runnerDeadlineMs, EXEC_TIMEOUT_GIT_MS, "diff capture", "preparation");
  const diffCaptureDeadlineMs = diffStageNow + diffWindowMs;
  const diff = await sandbox.runCommand(cmds.diff, {
    env: { GH_TOKEN: token },
    timeout: diffWindowMs,
  });
  let diffStdout = diff.stdout;
  if (diff.exitCode !== 0) {
    // Only GitHub's oversized-diff refusal has a local substitute; an auth or
    // network failure keeps today's rethrow (a fallback would mask the cause).
    // The fallback shares this round's clock and the diff stage's window, and
    // declines when either the derived runner deadline or that window is spent.
    const captured = isDiffTooLarge(diff.stderr)
      ? await oversizedDiffCapture(
          sandbox,
          token,
          { owner: payload.owner, repo: payload.repo, prNumber: payload.pr_number },
          headSha,
          runnerDeadlineMs,
          diffCaptureDeadlineMs,
        )
      : null;
    if (captured === null) {
      throw new Error(gitStageFailureDetail("diff", diff, progress.secretValues));
    }
    if ("reason" in captured) {
      // ONE warn per attempt, and never silence: the step that ended it, that
      // step's exit code and a redacted stderr tail (redaction BEFORE the tail
      // cut, exactly as the stage detail does). The durable failure keeps the
      // ORIGINAL 406 and gains the reason, so "not attempted (budget)",
      // "failed at fetch" and "hostile ref rejected" stay distinguishable.
      const tail =
        captured.run === undefined
          ? ""
          : redactExactSecrets(redactSecrets(captured.run.stderr), progress.secretValues).trim().slice(-STDERR_TAIL_MAX);
      deps.log.warn(
        { ...fields, diff_fallback: captured.reason, diff_fallback_step: captured.step },
        `oversized diff fallback declined: ${captured.step} (${captured.reason})` +
          (captured.run === undefined ? ", no exec ran" : `, exit ${captured.run.exitCode}`) +
          (tail === "" ? ", stderr empty" : `, stderr tail: ${tail}`),
      );
      if (captured.reason === "budget") {
        // The derived deadline, not a code fault, declined the fallback —
        // resolve it into the same `budget-exhausted` outcome the runner
        // window produces (the record keeps the git-stage cause verbatim).
        throw new RoundBudgetSpent(
          `${gitStageFailureDetail("diff", diff, progress.secretValues)}; oversized fallback: ${captured.reason} at ${captured.step}`,
          "preparation",
        );
      }
      throw new Error(`${gitStageFailureDetail("diff", diff, progress.secretValues)}; oversized fallback: ${captured.reason} at ${captured.step}`);
    }
    diffStdout = captured.run.stdout;
    deps.log.info(
      { ...fields, diff_source: "oversized-local" },
      "oversized PR diff (github 406) — captured the merge-base..head diff from the clone",
    );
  }
  const diffRead = parseBoundedRead(diffStdout);
  const diffText = diffRead.text ?? "";
  // The diff FILE's state, from the SAME round's bounded read of that file —
  // the one evidence that separates an EMPTY file (nothing to review) from a
  // capture that never delivered one. `git apply --numstat` rejects an empty
  // file as unusable input, so the numstat exit below is classified against
  // this state, never against the exit code alone.
  let diffFileState: "empty" | "captured" | "overflow" | "unreadable" =
    diffRead.failure ?? (diffRead.text === "" ? "empty" : "captured");

  // Increment capture (numstat partition only): base...head replaces the
  // file AFTER the full diff text is already in memory, so the evidence
  // catalog above keeps proving prior findings against the whole PR.
  // A non-zero exit has two documented outcomes: a too-large refusal (the
  // compare API's own 20,000-line ceiling) downgrades the round to the full
  // diff it already captured — logged, with the `since` fact dropped — while
  // any other failure throws with its own cause. An unreadable/empty capture
  // marks the round context-incomplete. Nothing here falls back silently: the
  // `since` fact would then be a lie.
  // An empty bounded read is NOT decided here: as with the full diff, only
  // the same round's numstat tells a genuinely unchanged increment (empty
  // file) from a capture that delivered nothing. Until that read, an empty
  // capture counts as a failure — the conservative side, which also keeps the
  // recheck input unbuilt exactly as before.
  if (sinceSha !== null) {
    const increment = await sandbox.runCommand(
      incrementDiffCommand(payload.owner, payload.repo, sinceSha, headSha, DIFF_PATH),
      {
        env: { GH_TOKEN: token },
        timeout: boundedStepTimeout(runnerDeadlineMs, EXEC_TIMEOUT_GIT_MS, "increment diff", "preparation"),
      },
    );
    if (increment.exitCode !== 0) {
      // The compare API refuses an oversized base...head diff with the same
      // 20,000-line ceiling `gh pr diff` answers, and that refusal has a
      // documented outcome: the round reviews the full diff it already
      // captured (the refused capture never replaced that file). The `since`
      // fact is DROPPED for the rest of the round — keeping it would describe
      // the file as an increment it no longer is — and this one warn is its
      // whole trace, so the degrade is never silent. A genuine capture
      // failure keeps its own cause and stays a round failure.
      if (!isDiffTooLarge(increment.stderr)) {
        throw new Error(gitStageFailureDetail("increment diff", increment, progress.secretValues));
      }
      const tail = redactExactSecrets(redactSecrets(increment.stderr), progress.secretValues).trim().slice(-STDERR_TAIL_MAX);
      deps.log.warn(
        { ...fields, increment_capture: "too_large", increment_since: sinceSha },
        `increment diff capture too large (github 406) — reviewing the full diff instead, exit ${increment.exitCode}` +
          (tail === "" ? ", stderr empty" : `, stderr tail: ${tail}`),
      );
      sinceSha = null;
    } else {
      const incrementRead = parseBoundedRead(increment.stdout);
      diffFileState = incrementRead.failure ?? (incrementRead.text === "" ? "empty" : "captured");
      if (incrementRead.failure === "unreadable") {
        captureFailed = true;
        deps.log.warn(
          { ...fields, increment_capture: "unreadable", increment_since: sinceSha },
          `increment diff capture unreadable — context-unavailable (no evidence catalog; rows stay context-incomplete)`,
        );
      } else if (diffFileState === "empty") {
        captureFailed = true;
      }
    }
  }

  // Trusted evidence catalog (§7.3) for the selected targets, pinned to
  // the authoritative checkout SHA. A target the captured diff cannot prove
  // is EXCLUDED from the recheck input: without catalog evidence the seat
  // could only guess, so sending it would invite a misattributed verdict.
  const catalog =
    targets.length > 0
      ? buildEvidenceCatalog(diffText, targets, headSha)
      : {
          slices: [] as EvidenceSlice[],
          excludedTargets: new Set<string>(),
          catalogBudgetExcluded: new Set<string>(),
          sliceIdsByRowId: new Map<string, string[]>(),
        };
  const catalogExcluded: ReadonlySet<string> = catalog.excludedTargets;
  const catalogBudgetExcluded: ReadonlySet<string> = catalog.catalogBudgetExcluded;

  // §7.5 discovery BEFORE the §7.8 capture: an association whose remote
  // thread was never bound cannot enter the discussion, and the recheck's
  // resolution fences only ever verify a thread the seat actually saw — so
  // binding it first is what lets this round resolve it at all. Bounded: any
  // association the budget could not reach stays unbound for a later round.
  const bound = await bindUnboundThreads({ DB: deps.env.DB, commenter, log: deps.log, fields }, lifecycleScope, targets);
  if (bound.skipped > 0) {
    deps.log.warn(fields, `${bound.skipped} association(s) left unbound for a later round`);
  }

  // Bounded discussion capture (§7.8) for the selected targets' known
  // threads. API failure is unavailable — never empty/complete.
  let discussion = emptyDiscussion(captureMs);
  if (targets.length > 0) {
    try {
      const placeholders = targets.map(() => "?").join(",");
      const threadRows = await deps.env.DB
        .prepare(
          `SELECT id, thread_id FROM review_threads
           WHERE finding_row_id IN (${placeholders}) AND thread_id IS NOT NULL
             AND superseded_by_publication_id IS NULL`,
        )
        .bind(...targets.map((t) => t.rowId))
        .all<{ id: string; thread_id: string }>();
      discussion = await commenter.listDiscussion({
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
        threads: threadRows.results.map((row) => ({ associationId: row.id, threadId: row.thread_id })),
        nowMs: captureMs,
      });
      // §7.8: the model-context bounds and untrusted-text neutralization are
      // NOT cosmetic — this bounded view is what rides the wire, so the seat
      // never sees a raw captured body, and the pass is what marks the thread
      // snapshots (and a cap-truncated issue capture) whose items were
      // dropped or clamped — the resolution fences read exactly those flags.
      discussion = boundDiscussion(discussion);
    } catch (err) {
      captureFailed = true;
      discussion = {
        items: [],
        issueCoverage: "unavailable",
        issueModelCoverage: "unavailable",
        issueDigest: "",
        capturedMs: captureMs,
        threads: [],
      };
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `discussion capture failed — context-unavailable: ${detail}`);
    }
  }

  // The typed recheck input (§7.3): omitted ENTIRELY when no open rows
  // exist — the runner input stays byte-identical on a first round. Only
  // rows the trusted catalog can prove ride the wire, and only the slices
  // those rows reference: a never-sent row leaves no orphan evidence, and
  // no slice it owns consumes the byte budget.
  let recheckInput: RecheckInput | undefined;
  const budgetExcluded = new Set<string>();
  // What the seat is actually handed. Narrowed to the sent rows'
  // associations once they are known: a thread of a row this round could not
  // fit was not seen by the seat, so it must never be offered for resolution.
  let askedDiscussion = discussion;
  let recheckAssignmentMaxBytes: number | undefined;
  if (targets.length > 0 && !captureFailed) {
    // §7.8: the seat's ask budget is an operator setting, read ONCE per
    // message and only when a recheck round will actually be asked, so a
    // delivery with no open rows pays nothing. It rides the runner input as
    // its own top-level field — the `mstar.recheck-input/v1` document stays
    // frozen — and it FITS this ask instead of refusing it whole: the prose
    // is fixed, so the document gets what the budget leaves, and the rows the
    // budget could not reach are accounted `budget` rather than skipped by a
    // seat that never ran.
    const budget = await getRecheckAssignmentMaxBytes(deps.env.DB);
    // A degraded read answers the documented default and owes the operator
    // one structured warn (the level/concurrency readers' contract). It is
    // reported even when nothing fits below: the budget decided that.
    if (budget.degraded) {
      deps.log.warn(
        {
          ...(baseFields ?? payloadIdentityFields(payload)),
          event: "review_recheck_assignment_degraded",
          max_bytes: budget.maxBytes,
        },
        "recheck assignment budget read degraded — using the documented default",
      );
    }
    // The one byte cap a row must fit: the §7.3 wire cap, or the room the
    // assignment budget leaves once its own prose is paid.
    const documentMaxBytes = Math.min(
      RECHECK_INPUT_MAX_BYTES,
      budget.maxBytes - RECHECK_ASSIGNMENT_PROSE_BYTES,
    );
    const candidates = targets.filter(
      (target) => !catalogExcluded.has(target.rowId) && !catalogBudgetExcluded.has(target.rowId),
    );
    // Each row is measured against the evidence of the rows ALREADY
    // accepted, never against slices a pending row might still bring: a row
    // that does not fit is dropped and contributes nothing, so a later row
    // is measured against the set that will really ride — it cannot lose its
    // place to a row that was itself excluded, and byte accounting is
    // monotone (adding a row only grows the serialized input), so a row
    // dropped here cannot fit the final input either.
    const included: RecheckTarget[] = [];
    const referenced = new Set<string>();
    let evidence: EvidenceSlice[] = [];
    for (const target of candidates) {
      const withRow = new Set([...referenced, ...(catalog.sliceIdsByRowId.get(target.rowId) ?? [])]);
      const nextEvidence = catalog.slices.filter((slice) => withRow.has(slice.id));
      // The cap is measured on the SERIALIZED input — schema, headSha,
      // evidence, discussion, array brackets and separators included — so
      // the accepted document is exactly what the cap counts. The discussion
      // measured here is the whole capture: narrowing it to the sent rows can
      // only shrink the document, so this stays an upper bound.
      const candidate = {
        schema: RECHECK_INPUT_SCHEMA,
        headSha,
        targets: [...included, target],
        evidence: nextEvidence,
        discussion,
      };
      if (jsonByteLength(candidate) > documentMaxBytes) continue;
      included.push(target);
      evidence = nextEvidence;
      for (const id of withRow) referenced.add(id);
    }
    // The rotation HEAD is the one row the fit must never drop for want of
    // room. A row it omits never advances the clock, so the same row comes
    // back first on every round and is dropped again — permanently
    // `budget`, the deadlock this fitting removes. So whenever the head did
    // not fit whole, its ORIGINAL body is bounded into the room that is left
    // (beside the rows that did fit, or alone when none did) and its own
    // catalog rides as far as it fits, so the seat can still cite its proof.
    // The rowId, title, file path, line anchors and every other field stay
    // exactly as captured: the same finding row, never a rewritten one.
    const head = candidates[0];
    if (head !== undefined && !included.some((target) => target.rowId === head.rowId)) {
      // Measured against the WHOLE discussion: the head is not included yet,
      // so the narrowed view would also drop its own threads. Probes are the
      // serialized document itself, so a multi-byte body is bounded by real
      // UTF-8 bytes, and the binary search is logarithmic in body length.
      const bytesOf = (targets: RecheckTarget[], slices: EvidenceSlice[], target: RecheckTarget): number =>
        jsonByteLength({
          schema: RECHECK_INPUT_SCHEMA,
          headSha,
          targets: [...targets, target],
          evidence: slices,
          discussion,
        });
      const withBody = (length: number): RecheckTarget => ({
        ...head,
        original: { ...head.original, body: truncatedBody(head.original.body, length) },
      });
      /** The head bounded into `slices` beside `targets`, or null when not even an empty body fits. */
      const rescue = (targets: RecheckTarget[], slices: EvidenceSlice[]): RecheckTarget | null => {
        if (bytesOf(targets, slices, withBody(0)) > documentMaxBytes) return null;
        let low = 0;
        let high = head.original.body.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (bytesOf(targets, slices, withBody(mid)) <= documentMaxBytes) low = mid;
          else high = mid - 1;
        }
        return withBody(low);
      };
      const own = new Set(catalog.sliceIdsByRowId.get(head.rowId) ?? []);
      // The head's own catalog, and the union a shared document needs — never
      // a slice of a row that ends up unsent (that would be orphan evidence).
      const headSlices = catalog.slices.filter((slice) => own.has(slice.id));
      const withOwn = catalog.slices.filter((slice) => own.has(slice.id) || referenced.has(slice.id));
      // Room for the rows that fit comes first; the head gives up its catalog
      // before those rows give up their place. A head that cannot share the
      // budget at all still rides alone — its clock moves, and the rows it
      // displaced keep their own place for the next round.
      const attempts: { targets: RecheckTarget[]; slices: EvidenceSlice[] }[] =
        included.length === 0
          ? [
              { targets: [], slices: headSlices },
              { targets: [], slices: [] },
            ]
          : [
              { targets: included, slices: withOwn },
              { targets: included, slices: evidence },
              { targets: [], slices: headSlices },
              { targets: [], slices: [] },
            ];
      for (const attempt of attempts) {
        const bounded = rescue(attempt.targets, attempt.slices);
        if (bounded === null) continue;
        // Array order does not change a serialized document's byte count, so
        // the head goes back where the rotation had it: first.
        included.splice(0, included.length, ...attempt.targets);
        included.unshift(bounded);
        evidence = attempt.slices;
        break;
      }
    }
    const sentIds = new Set(included.map((target) => target.rowId));
    for (const target of candidates) if (!sentIds.has(target.rowId)) budgetExcluded.add(target.rowId);
    if (included.length === 0) {
      // Nothing can be asked: even the head's fixed fields plus the discussion
      // overrun the budget, so no body length and no catalog can rescue it.
      // Name both figures so the operator can tell a budget that is too small
      // from an ask that grew, and never report it as a seat skip — no seat was
      // started.
      const requiredBytes =
        RECHECK_ASSIGNMENT_PROSE_BYTES +
        jsonByteLength({
          schema: RECHECK_INPUT_SCHEMA,
          headSha,
          targets:
            head === undefined ? [] : [{ ...head, original: { ...head.original, body: "" } }],
          evidence: [],
          discussion,
        });
      deps.log.warn(
        {
          ...(baseFields ?? payloadIdentityFields(payload)),
          event: "review_recheck_no_fit",
          assignment_max_bytes: budget.maxBytes,
          required_bytes: requiredBytes,
          selected: targets.length,
        },
        `recheck ask cannot fit the assignment budget — the smallest document this round can ask (prose + one finding's fixed fields + discussion) needs ${requiredBytes} bytes, the budget is ${budget.maxBytes}; nothing was sent, so every row keeps its budget reason and its rotation clock (raise review.recheck.assignment_max_bytes to let the round run)`,
      );
    }
    // The seat's view of the discussion: issue items and their coverage and
    // digest are the round's context and stay, while a thread is offered only
    // for a row that rides — a resolve verifies a thread the seat saw.
    const sentAssociations = new Set(included.flatMap((target) => target.associationIds));
    askedDiscussion = {
      ...discussion,
      items: discussion.items.filter(
        (item) =>
          item.source === "issue" ||
          (item.associationId !== null && sentAssociations.has(item.associationId)),
      ),
      threads: discussion.threads.filter((thread) => sentAssociations.has(thread.associationId)),
    };
    if (included.length > 0) {
      recheckAssignmentMaxBytes = budget.maxBytes;
      recheckInput = {
        schema: RECHECK_INPUT_SCHEMA,
        headSha,
        targets: included,
        evidence,
        discussion: askedDiscussion,
      };
    }
  }

  // 6. §7.7 step 4 — the Check claim was made at ADMISSION. What remains is
  // the FALLBACK (no SHA was knowable there) and the SUPERSEDE check: the
  // authoritative checkout is the only SHA the review itself will use.

  // 6. §7.7 step 4 — the fallback claim for a message whose SHA was not
  // knowable at admission (a comment trigger with no readable head
  // watermark): it lands here, after dedup/journal handed their duplicates
  // off, BEFORE model work. Absent `checks` dep = no Checks; hook failure is
  // isolated and cannot prevent the review (step 5).
  if (deps.checks !== undefined && !check.claimAttempted) {
    check.claimAttempted = true;
    await check.begin(lifecycleScope, githubAppId, headSha);
  }


  // IDENTITY, frozen once, from the claim this attempt actually owns (the
  // admitted one, or the authoritative re-claim the checkout forced). Every
  // later phase reads it from the row; a concurrent freeze of a DIFFERENT head
  // wins the CAS and this attempt settles as skipped instead of continuing.
  const admittedKey = ref.checkClaimSha === null ? null : checkKeyOf(payload, ref.checkClaimSha);
  const liveIdentity =
    check.handle !== null
      ? await readCheckIdentity(deps.env.DB, check.handle.attemptId)
      : // No handle (a refused claim): the identity is still the admitted claim's
        // open row for that key — a property of the ATTEMPT, not of the handle.
        admittedKey === null
        ? null
        : await readOpenCheckIdentityForKey(deps.env.DB, admittedKey);
  if (liveIdentity !== null) {
    const frozenNow = await readAttemptIdentity(deps.env.DB, attemptId);
    if (frozenNow === null) {
      if (!(await freezeAttemptIdentity(deps.env.DB, attemptId, liveIdentity))) {
        const winner = await readAttemptIdentity(deps.env.DB, attemptId);
        await settleMovedHead(
          deps,
          ref,
          check,
          headSha,
          winner?.key ?? "another caller's head",
          liveIdentity.key,
        );
      }
    } else if (frozenNow.key !== liveIdentity.key || frozenNow.generation !== liveIdentity.generation) {
      // WHOLE identity: an identical (key, generation) pair is our own and
      // proceeds; anything else is a foreign freeze and skips.
      await settleMovedHead(deps, ref, check, headSha, frozenNow.key, liveIdentity.key);
    }
  }

  // 6. Numstat of the PR diff — `git apply --numstat` reads the unified
  // diff without applying it. The lines ("<add>\t<del>\t<path>") are the
  // runner's seat-partition universe (reconFacts convention). On an
  // incremental round the file holds base...head, so the seats partition the
  // work done since the last review instead of the whole PR. Its window is
  // what the DERIVED runner deadline still owes (declines once spent).
  const numstat = await sandbox.runCommand(cmds.numstat, {
    timeout: boundedStepTimeout(runnerDeadlineMs, EXEC_TIMEOUT_GIT_MS, "numstat", "preparation"),
  });
  // A non-zero exit is the FILE's answer about itself: an empty file is what
  // `git apply` rejects as unusable input (exit 128, "unrecognized input"),
  // so the same round's read of that file classifies the exit. Any other
  // failure keeps its own detail — git stderr plus the diff-path state — so
  // "the file is empty" and "the file could not be read" never collapse into
  // one message.
  if (numstat.exitCode !== 0 && diffFileState !== "empty") {
    throw new Error(`${gitStageFailureDetail("numstat", numstat, progress.secretValues)}; diff file: ${diffFileState}`);
  }
  const numstatLines = numstat.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

  // An empty diff FILE is nothing to review — `git apply --numstat` exits
  // non-zero on it precisely because it holds no patch — so the round acks
  // instead of failing the sandbox stage: no publication, no review row.
  // The numstat's own stdout must be empty too: lines there would prove the
  // read lost a real diff, which is the capture failure below, never an ack.
  // Both rounds land here: an empty increment (the prior round already covers
  // this head's content, and the Check inherits that head's result so an
  // empty commit never launders a failing baseline into a neutral required
  // check) and a first round whose head adds no diff (nothing to inherit, so
  // the Check concludes skipped). A first round also needs the failing exit:
  // an exit-0 numstat keeps the historical normal-round path.
  const emptyDiffFile =
    diffFileState === "empty" && numstatLines.length === 0 && (sinceSha !== null || numstat.exitCode !== 0);
  if (emptyDiffFile) {
    if (sinceSha !== null) {
      deps.log.info(
        { ...fields, event: "review_no_increment", increment_since: sinceSha },
        `no increment to review — ${sinceSha.slice(0, 7)}..${headSha.slice(0, 7)} is empty and the last reviewed head already covers this content; acking without a new review`,
      );
      await check?.terminalize(null, "skipped", sinceSha);
    } else {
      deps.log.info(
        { ...fields, event: "review_no_diff" },
        `no diff to review — ${headSha.slice(0, 7)} adds no changes; acking without a new review`,
      );
      await check?.terminalize(null, "skipped");
    }
    return { kind: "settled", outcome: { kind: "ok" } };
  }
  if (sinceSha !== null && diffFileState === "empty") {
    deps.log.warn(
      { ...fields, increment_capture: "empty", increment_since: sinceSha },
      `increment diff capture empty — context-unavailable (no evidence catalog; rows stay context-incomplete)`,
    );
  }

  // A non-delivered diff capture is ambiguous, and only THIS round's
  // numstat — the diff FILE `git apply` read, not the bounded stdout — can
  // resolve the EMPTY case. Non-empty numstat means the redirect wrote a diff
  // the read did not deliver: a CAPTURE FAILURE, so the round is
  // context-incomplete, never every row published as a confident
  // `no-evidence`. Both empty with an exit-0 numstat keeps the normal-round
  // path; a genuinely empty FILE answers the failing exit and acks above.
  // `overflow` and `unreadable` are capture failures by construction — the
  // diff exists but is over the bound, or the transport broke — so they take
  // the same accounting with their own `diff_capture` cause: an over-bound
  // capture is "too large to prove", never "nothing to prove". The recheck
  // input built above cannot change: any of the three leaves the catalog
  // with no slices and every target excluded, so no input was built either
  // way. Line comments keep the over-size behaviour — `diffText` stays "",
  // so the hunk prefilter degrades to the base filter.
  const diffCaptureFailure =
    diffRead.failure ?? (diffRead.text === "" && numstatLines.length > 0 ? "empty" : undefined);
  if (diffCaptureFailure !== undefined) {
    captureFailed = true;
    deps.log.warn(
      { ...fields, diff_capture: diffCaptureFailure },
      `diff capture ${diffCaptureFailure} — context-unavailable (no evidence catalog; rows stay context-incomplete)`,
    );
  }

  // 7. Runner input JSON (reconFacts): `<owner>/<repo>#<pr>` and
  // `head <sha>` fold into the envelope target INSIDE the runtime — the
  // AUTHORITATIVE checkout sha is used so the ArtifactStore.put target
  // cross-check agrees with the idempotency key — plus the numstat
  // universe. base64-transported so the JSON never touches shell quoting;
  // worktreePath = the clone (the seats' read cwd). An incremental round
  // adds `since <base>` so the seats know their universe is a delta.
  const reconFacts = [
    `${payload.owner}/${payload.repo}#${payload.pr_number}`,
    `head ${headSha}`,
    ...(sinceSha !== null ? [`since ${sinceSha}`] : []),
    ...numstatLines,
  ];
  // The App's per-role model overrides ride as an OPTIONAL
  // input field, included ONLY when a role map resolved above — no-map
  // messages serialize byte-identically to the pre-overrides payload
  // (the runner-side guard + type extension ride alongside).
  // The App's custom-provider declarations ride as an OPTIONAL
  // input field — keyless (toRunnerCustomProvider strips the decrypted
  // key; keys reach the container ONLY via the exec env) — included ONLY
  // when declarations resolved above. No-declaration messages serialize
  // byte-identically to the pre-declarations payload (the runner-side guard +
  // synthesis ride alongside).
  // The capability-host base rides ALWAYS as an EMPTY array: the image
  // declares no provider, so the per-review models.yml is the App's own
  // declarations (a built-in provider resolves from the SDK catalog).
  // PR context for the report seat (best-effort): the description plus the
  // issues it closes/references, read through gh with the same exec env the
  // diff uses. Bounded by the DERIVED runner deadline (each read gets what
  // that deadline still owes, capped at PR_CONTEXT_EXEC_TIMEOUT_MS) and gated
  // so the post-runner bounded reads survive the capture; any failure or a
  // budget skip resolves undefined (with one named warn) so the published
  // report sections degrade to `none` — a narrative gap never fails a review.
  const prContext = await capturePrContext(
    sandbox,
    payload,
    token,
    deps.log,
    fields,
    runnerDeadlineMs,
  );

  // Anchor the derived budget HERE, just before the input write: the one
  // tier clamp the whole pipeline applies (`anchorRunnerBudget`), and the
  // write, the wire value and the exec timeout all spend its absolute end.
  // Its refusals — an oversized request, a spent cutoff — throw before any
  // paid work — never a 1ms exec.
  // The same numstat stdout the seat partition consumed sizes the runner
  // request — one read, one size value, `null` when the read cannot prove
  // a complete row set (unavailable, unproven-empty or truncated/malformed
  // rows). The request is what the allocation asks for inside the tier;
  // `anchorRunnerBudget` remains the only clamp that decides the outcome.
  // A malformed size outcome reuses the `invalid` vocabulary: it carries
  // NaN, which the anchor's entry check rejects the same way an explicit
  // bad request is — no second refusal path, no silent fallback.
  const diffSize = parseNumstatSize(numstat.stdout, diffFileState === "empty");
  // The outcome's own counter: the selected numstat's textual line count —
  // a null size is the recorded unknown, never invented.
  observedChangedLines = diffSize?.changedLines ?? null;
  const sizeRequest = requestRunnerBudget(level, diffSize);

  const anchor = anchorRunnerBudget(roundBudget, Date.now(), sizeRequest.requestedBudgetMs);
  if (anchor.kind === "invalid") {
    throw new Error(
      `runner request declined — an explicit ${anchor.requestedBudgetMs}ms is not a usable duration`,
    );
  }
  if (anchor.kind === "oversized") {
    throw new Error(
      `runner request declined — ${anchor.requestedBudgetMs}ms exceeds the tier maximum (${anchor.tierMaxMs}ms)`,
    );
  }
  if (anchor.kind === "exhausted") {
    throw new RoundBudgetSpent(
      `round budget spent: runner declined — the pre-runner cutoff is spent (${anchor.remainingMs}ms left for it)`,
      "preparation",
    );
  }
  // The allocation is immutable from here on: the typed record's runner
  // budget is this frozen effective duration.
  observed.runnerEffectiveBudgetMs = anchor.effectiveBudgetMs;
  fields = {
    ...fields,
    runner_requested_ms: anchor.requestedBudgetMs,
    runner_effective_ms: anchor.effectiveBudgetMs,
    runner_cutoff_ms: roundBudget.runnerCutoffMs,
    runner_deadline_ms: anchor.execDeadlineMs,
    // The estimate the request was sized from — one work unit per changed
    // line, minimum one per file; `null` records an unknown size, so an
    // investigation can tell a tier-max request from a sized one.
    runner_work_units: sizeRequest.kind === "requested" ? sizeRequest.workUnits : null,
  };
  check.fields = fields;
  return {
    kind: "prepared",
    prepared: {
      headSha,
      runnerDeadlineMs: anchor.execDeadlineMs,
      runnerRequestedMs: anchor.requestedBudgetMs,
      runnerEffectiveMs: anchor.effectiveBudgetMs,
      budget: {
        requested_ms: anchor.requestedBudgetMs,
        effective_ms: anchor.effectiveBudgetMs,
        cutoff_ms: roundBudget.runnerCutoffMs,
        deadline_ms: anchor.execDeadlineMs,
        work_units: sizeRequest.kind === "requested" ? sizeRequest.workUnits : null,
      },
      modelChain: effectiveModelChain(requireRunnerConfig(deps, payload).appCfg).chain,
      observedChangedLines,
      reconFacts,
      recheckInput,
      recheckAssignmentMaxBytes,
      prContext,
      sinceSha,
      diffText,
      targets,
      totalOpen,
      captureFailed,
      pendingApplyFailed,
      discussion,
      askedDiscussion,
      catalogExcluded: [...catalogExcluded],
      catalogBudgetExcluded: [...catalogBudgetExcluded],
      budgetExcluded: [...budgetExcluded],
    },
  };
}

/**
 * Phase 2 — review. Re-derives the container handle and the purpose-scoped
 * credential from `deps` + the prepare handoff, then takes the one-way launch
 * fence and makes the blocking paid call. Its OUTPUT is the launch row's own
 * state: a reply is not a completion, so an ambiguous one leads to collection
 * or recovery, never to a second launch.
 */
export async function reviewAttempt(
  deps: ProcessDeps,
  ref: AttemptRef,
  prepared: PreparedAttempt,
): Promise<ReviewOutcome> {
  const { payload, attemptId, level } = ref;
  const runner = requireRunnerConfig(deps, payload);
  const progress = beginProgress();
  // The live objects are this phase's own. The container is resolved by attempt
  // id (which never starts one) and every PAID action runs through the guarded
  // form inside `runReviewAttempt`: ONE request proves the attempt's marker and
  // executes, so there is no proof-then-act window to race.
  const sandbox = await deps.getSandbox(deps.env.SANDBOX, attemptSandboxId(attemptId));
  const cached = deps.credentials.get(attemptId);
  const token = cached?.token ?? (await mintSandboxReadToken({ payload, commenter: requireCommenter(deps, payload) }));
  const fields = attemptFields(payload, level, attemptId, prepared.headSha, prepared.budget);
  try {
    await runReviewAttempt({
      deps,
      deadlineMs: prepared.runnerDeadlineMs,
      sandbox,
      headSha: prepared.headSha,
      token,
      level,
      appCfg: runner.appCfg,
      fields,
      reconFacts: prepared.reconFacts,
      modelOverrides: runner.modelOverrides,
      customProviders: runner.customProviders,
      recheckInput: prepared.recheckInput,
      recheckAssignmentMaxBytes: prepared.recheckAssignmentMaxBytes,
      prContext: prepared.prContext,
      runnerAnchor: {
        kind: "allocated",
        requestedBudgetMs: prepared.runnerRequestedMs,
        effectiveBudgetMs: prepared.runnerEffectiveMs,
        execDeadlineMs: prepared.runnerDeadlineMs,
      },
      observedChangedLines: prepared.observedChangedLines,
      progress,
      attemptId,
    });
    // The session's full exact-value set, for the phases that redact its
    // output without having run it (and for a resumed collect, which has no
    // progress of its own).
    deps.credentials.set(attemptId, { token, secretValues: progress.secretValues });
  } catch (err) {
    throw phaseFailure("review", err, {
      stage: progress.failureStage,
      headSha: prepared.headSha,
      secretValues: progress.secretValues,
      runnerStartedAt: progress.runnerStartedAt,
      runnerReturned: progress.runnerReturned,
      runnerEffectiveBudgetMs: prepared.runnerEffectiveMs,
      changedLines: prepared.observedChangedLines,
      sendAttemptPublicationId: null,
    });
  }
  return readPersistedLaunch(deps, attemptId);
}

/**
 * Phase 3 — collect. Parses and validates the envelope, takes the degrade
 * path when the output is not a verdict, reconciles the recheck round, builds
 * the FINAL body and stages the complete private payload BEFORE any GitHub
 * mutation. Staging failure means no publication, no line comments and no
 * local result writes at all.
 */
export async function collectAttempt(
  deps: ProcessDeps,
  ref: AttemptRef,
  prepared: PreparedAttempt,
): Promise<CollectStep> {
  const progress = beginProgress();
  try {
    return await collectPhase(deps, ref, prepared, progress);
  } catch (err) {
    throw phaseFailure("collect", err, {
      stage: progress.failureStage,
      headSha: prepared.headSha,
      secretValues: progress.secretValues,
      runnerStartedAt: progress.runnerStartedAt,
      runnerReturned: progress.runnerReturned,
      runnerEffectiveBudgetMs: prepared.runnerEffectiveMs,
      changedLines: prepared.observedChangedLines,
      sendAttemptPublicationId: null,
    });
  }
}

async function collectPhase(
  deps: ProcessDeps,
  ref: AttemptRef,
  prepared: PreparedAttempt,
  progress: ReviewAttemptProgress,
): Promise<CollectStep> {
  const { payload, attemptId, level, roundStartedAt } = ref;
  const commenter = requireCommenter(deps, payload);
  const check = await settlementFor(deps, ref, prepared.headSha);
  const {
    headSha,
    targets,
    totalOpen,
    captureFailed,
    pendingApplyFailed,
    sinceSha,
    diffText,
    discussion,
    askedDiscussion,
    recheckInput,
  } = prepared;
  const fields = attemptFields(payload, level, attemptId, headSha, prepared.budget);
  const lifecycleScope: Scope = {
    appId: payload.botRef.appId,
    installationId: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
  };
  const key: IdempotencyKey = {
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: headSha,
  };
  // The context sets ride as arrays on the handoff (JSON) and become sets here.
  const catalogExcluded: ReadonlySet<string> = new Set(prepared.catalogExcluded);
  const catalogBudgetExcluded: ReadonlySet<string> = new Set(prepared.catalogBudgetExcluded);
  const budgetExcluded = new Set(prepared.budgetExcluded);
  // SEC-01, bounded by the plan: exact-value redaction is a SAME-HOST guarantee.
  // This host holds the session's ACTUAL values only when it ran the paid step;
  // a resumed host has none, and it must not substitute values it mints now (a
  // different token, rotated provider keys) and present them as exact. It
  // redacts by SHAPE instead — the recorded residual, never a silent claim of
  // exact coverage. Persisting the secrets to make the resumed set exact would
  // put credentials in D1, which is worse than the gap.
  progress.secretValues = deps.credentials.get(attemptId)?.secretValues ?? [];
  // The paid result is the LAUNCH ROW's, never a predecessor's return value.
  const execution = await readPaidExecution(deps, attemptId);
  const { run, recheck, report, appliedProvider } = execution;
  const recheckDoc = recheck?.doc ?? null;
  const rejectedRowIds = recheck?.rejected ?? new Set<string>();
  const anonymousRejectedRows = recheck?.anonymousRejectedRows ?? 0;
  // 9. Parse + validate the envelope (engine gate inside parseReviewOutput;
  // mapping spec §4.2). Parse-fail is the DEGRADE path (architect AL-1):
  // parseReviewOutput is a pure function of run.stdout —
  // the same stdout fails identically on a retry (a deterministic
  // model-output failure), so the message ACKS instead of throwing. Order:
  // review_failures row (best-effort — an insert failure must never mask
  // the degrade) → degraded comment (best-effort — a post failure is a
  // structured log line only) → the `degraded` outcome the queue handler
  const parsed = parseReviewOutput(run.stdout);
  if (!parsed.ok) {
    // SEC-01 exact-value defense: the session's ACTUAL secret values
    // (runner env provider keys + the minted installation token) are
    // exact-redacted from the parse error and the raw stdout BEFORE they
    // reach the durable failure row or the public degraded comment — a
    // credential that evades every shape pattern is still removed.
    const redactedError = redactExactSecrets(redactSecrets(parsed.error), progress.secretValues);
    const redactedStdout = redactExactSecrets(redactSecrets(run.stdout), progress.secretValues);
    try {
      await deps.failureStore.record({
        target_id: payload.targetId,
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        head_sha: headSha,
        stage: "parse",
        // qc3 F-001 / qc2 F-001: the zod/engine error can echo a
        // model-emitted secret-shaped value (`verdict "ghp_…" is not one
        // of …`) — redactSecrets BEFORE the durable D1 row, same face as
        // buildDegradedBody's public-comment choke point. SEC-01 adds the
        // exact-value pass on top.
        error: redactedError,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `review_failures insert failed (degrade continues): ${detail}`);
    }
    // §7.7 degraded publication (plan: stage → claim → send the exact
    // prepared body → proof → applied mark). The same resolved commenter
    // instance as the token mint above (lock L4). Best-effort with typed
    // outcomes — the message acks regardless (deterministic model-output
    // failure; retry is waste), and the Check hook terminalizes with the
    // publication identity so the lifecycle reads the persisted proof.
    // The cap fences the FIRST degraded send exactly as it fences the normal
    // one: a resumed collect whose instant already passed stages nothing.
    refusePublicationPastDeadline(ref.deadlineMs);
    const degradedOutcome = await publishDegradedPublication({
      db: deps.env.DB,
      commenter,
      scope: lifecycleScope,
      headSha,
      redactedError,
      redactedStdout,
      notAfterMs: ref.deadlineMs,
    });
    if (degradedOutcome.phase === "failed") {
      await check?.terminalize(null, "degraded-not-posted");
    } else {
      await check?.terminalize(degradedOutcome.publicationId, "publication-unknown");
      // A durable degraded publication is the proof the Check concludes from:
      // the obligation is recorded from that fact, and the Check row decides
      // whether it is still open.
      if (degradedOutcome.phase === "confirmed") {
        await noteOwedCheck(deps, ref, headSha, check?.handle?.attemptId);
      }
    }
    deps.log.warn(
      fields,
      `review degraded: output failed schema validation (${redactedError}) — degraded publication ${degradedOutcome.phase}` +
        `${degradedOutcome.phase === "failed" ? ` (${degradedOutcome.reason})` : ""}; acked, no retry/DLQ`,
    );
    // A degraded notice is not a review: stamp the payload sha (the same
    // key the worker claimed) so neither reader keeps accepting the "1".
    // Best-effort — a KV fault only leaves the stale claim behind.
    if (payload.head_sha) {
      try {
        await putAbandonClaim(
          deps.env.IDEMPOTENCY_KV,
          idemKey({
            installation_id: payload.installation_id,
            owner: payload.owner,
            repo: payload.repo,
            pr_number: payload.pr_number,
            head_sha: payload.head_sha,
          }),
          IDEM_DEGRADED,
          IDEMPOTENCY_SECONDS,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(fields, `degraded-claim KV write failed (the skip may still treat this commit as queued): ${detail}`);
      }
    }
    return { kind: "settled", outcome: { kind: "degraded" } };
  }

  // 10. SEC-02 + B4 + size-budget choke point: redact secret-shaped spans
  // (PEM, tokens, keys, long hex — F-001: every model-controlled field),
  // clamp per-finding title/body to their budgets (qc2 F-003), then cap
  // findings to the Top-50 by merge class BEFORE anything can reach the
  // public review body or the D1 envelope. The SAME capped array feeds
  // both the post and the put (B4: 渲染与落库同一裁剪数组). SEC-01 adds
  // the exact-value second pass (the session's ACTUAL secret values) on
  // top of the shape-based redaction — a credential that evades every
  // pattern is still removed before the post or the put.
  const capped = capFindings(
    clampFindingSizes(redactReviewOutputExact(redactReviewOutput(parsed.output), progress.secretValues)),
  );
  const output = capped.output;
  // 11. §7.7 step 6 — validation + conservative reconciliation + closure
  // assembly + final body. The recheck document is reconciled against the
  // SAME round's final capped findings (§7.4 conservative precedence:
  // same-round recurrence and related unresolved concerns force
  // unverifiable; rows the seat was never given are accounted but never
  // "assessed").
  const staleContext = pendingApplyFailed || captureFailed;
  const reconciled = reconcileRecheckRound({
    targets,
    doc: recheckDoc,
    status: recheck?.status ?? null,
    // The seat's own view: a thread of a row this round could not fit was
    // never handed over, so it cannot authorize a resolve either.
    discussion: askedDiscussion,
    output,
    staleContext,
    catalogExcluded,
    catalogBudgetExcluded,
    budgetExcluded,
    rejectedRowIds,
    anonymousRejectedRows,
  });
  // §7.8 attribution: ONE line per recheck round carrying the seat's own
  // status next to this round's accounting. A lost round therefore leaves a
  // D1 failure row and this line even when the container's stderr is gone.
  // Emitted whenever rows were selected: a round the §7.3 size budget emptied
  // sent nothing, and without this line that silence would be invisible.
  if (targets.length > 0) {
    const status = recheck?.status ?? null;
    const recheckOutcome = status?.outcome ?? "absent";
    // The runner cancels an unfinished seat when the main review settles
    // (spec §7.8): the round answered nothing because it was STOPPED, not
    // because it ran and lost. That is neither a failure row nor an
    // `invalid-output` for a row the seat never answered.
    const roundCancelled = recheckOutcome === "skipped" && status?.reason === "aborted";
    // The status document belongs to the SEAT; a round whose document was
    // lost has its real cause on the read side (absent / overflow /
    // validation failure), so that cause LEADS the detail instead of the
    // seat's `ok: null: null`, which says nothing about what went wrong.
    // `failed` already names the seat's own fault, so it keeps its triple.
    const docFailure = recheck?.docFailure ?? null;
    const recheckDetail = redactExactSecrets(
      redactSecrets(
        recheckDoc === null && docFailure !== null && recheckOutcome === "ok"
          ? `document ${docFailure}: ${recheckOutcome}: ${status?.reason ?? null}: ${status?.error ?? null}`
          : `${recheckOutcome}: ${status?.reason ?? null}: ${status?.error ?? null}`,
      ),
      progress.secretValues,
    ).slice(0, RECHECK_STATUS_ERROR_MAX_CHARS);
    deps.log[recheckDoc === null && !roundCancelled ? "warn" : "info"](
      {
        ...fields,
        recheck_outcome: recheckOutcome,
        // Same wrapper as `error`: a seat-authored `reason` can echo a
        // credential exactly like `error` can.
        recheck_reason: status?.reason === null || status?.reason === undefined
          ? null
          : redactExactSecrets(redactSecrets(status.reason), progress.secretValues),
        recheck_error: status?.error === null || status?.error === undefined
          ? null
          : redactExactSecrets(redactSecrets(status.error), progress.secretValues),
        // Named drops + the unnamed ones actually attributed (no usable
        // rowId, so mapped by position): the count reports what happened,
        // not only what could be named.
        rejected: rejectedRowIds.size + reconciled.anonymousRejectedCount,
        // A seat-authored `rejected_unnamed` is unbounded; any claim beyond
        // the sent-and-unanswered pool is excess that can claim no row. It is
        // dropped, and reported here so the silence has a number.
        rejected_unnamed_ignored: anonymousRejectedRows - reconciled.anonymousRejectedCount,
        // Real seat answers (the published coverage count), never the
        // lifecycle clock — a gate-rejected row advances `last_assessed_ms`
        // without ever having been assessed.
        assessed: reconciled.assessedCount,
      },
      recheckInput !== undefined
        ? recheckDoc === null
          ? roundCancelled
            ? "recheck round cancelled by the runner — no row was answered, no failure recorded"
            : "recheck output absent or failed validation — proceeding with selected rows conservatively unverifiable"
          : "recheck round accounted"
        : captureFailed
          ? "recheck round accounted — no input sent: lifecycle context capture failed, so no recheck could run"
          : "recheck round accounted — no input sent: no selected row was both catalog-provable and within the §7.3 size budget",
    );
    // Shipped failure rule: a round that SENT rows records one row when its
    // document is absent or the seat reported `failed` — a seat budget skip
    // records one too, because that round ran and answered nothing. A round
    // the runner cancelled by design, and a round that sent nothing at all
    // (capture failed, catalog exclusion, §7.3 size budget), records none:
    // its rows are already accounted as `budget`/`no-evidence`/`omitted` in
    // the closure section.
    if (
      recheckInput !== undefined &&
      !roundCancelled &&
      (recheckDoc === null || recheckOutcome === "failed")
    ) {
      // Best-effort: the insert must never mask the round (AL-6 pattern).
      try {
        await deps.failureStore.record({
          target_id: payload.targetId,
          installation_id: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          pr_number: payload.pr_number,
          head_sha: headSha,
          stage: "recheck",
          error: recheckDetail,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(fields, `review_failures insert failed (recheck round continues): ${detail}`);
      }
    }
  }
  // The ROUND's coverage reads the whole capture, never the narrowed wire
  // view: an unsent row's truncated thread still leaves this round's context
  // short, and publication must not claim more than capture could read.
  const contextCoverage: Coverage = staleContext
    ? "unavailable"
    : roundContextCoverage(discussion);
  const coverage = {
    totalOpen,
    selected: targets.length,
    assessed: reconciled.assessedCount,
    invalidOutput: reconciled.invalidOutputCount,
    omitted: reconciled.unansweredCount,
    capped: Math.max(0, totalOpen - targets.length),
    contextCoverage,
  };
  const queuedAssociations = new Set(reconciled.resolutions.map((r) => r.associationId));
  const closureRows: ClosureRow[] = targets.map((target) => {
    const outcome = reconciled.outcomeByRowId.get(target.rowId)!;
    return {
      title: target.original.title,
      disposition: outcome.disposition,
      reason: outcome.reason,
      evidenceKind: outcome.evidence?.kind ?? null,
      // A pending resolve renders not-yet-resolved, not a prediction —
      // remote outcomes appear in the NEXT round's single upsert (§7.10).
      thread: target.associationIds.some((id) => queuedAssociations.has(id)) ? "not yet resolved" : "-",
    };
  });
  // The §7.10 facts (coverage line, display cap, thread state) render ONCE,
  // in the body's revalidated section — there is no second rendering.
  // 12. §7.7 step 7 — calculate round/target from the App's current single
  // comment (pre-staging read), assemble the FINAL body, and stage the
  // COMPLETE private payload BEFORE any GitHub mutation. Staging failure
  // means no publication/line comments/result writes at all.
  const plan: UpsertPlan = await commenter.planReviewUpsert({
    installationId: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
  });
  const round = plan.round;
  const publicationId = crypto.randomUUID();
  const publicationMarker = buildPublicationMarker({ publicationId, headSha, kind: "review" });
  const preparedBody = buildPreparedReviewBody({
    output,
    omittedFindings: capped.omitted,
    round,
    headSha,
    publicationMarker,
    ...(sinceSha !== null ? { sinceSha } : {}),
    // The revalidated table is rendered mechanically from the closure rows
    // and carries the round's full prior-findings set; the report may be null
    // (no prContext / seat failure), in which case every heading still
    // renders with `none`.
    reportParts: { report, revalidated: buildRevalidatedSection(coverage, closureRows) },
  });
  const bodySha256 = await sha256Hex(preparedBody);

  // Seen records for the current findings: the stable finding identity is
  // the fingerprint — an existing lifecycle row (open or CLOSED) with the
  // same finding_id REUSES its row id so the apply's upsert reopens it
  // (§7.2 recurrence) instead of minting a duplicate.
  const seenRowIdByFindingId = new Map<string, string>();
  if (output.findings.length > 0) {
    const findingIdPlaceholders = output.findings.map(() => "?").join(",");
    const findingIds = output.findings.map((f) => computeFindingFingerprint(f));
    const knownRows = await deps.env.DB
      .prepare(
        `SELECT id, finding_id FROM review_findings
         WHERE bot_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
           AND finding_id IN (${findingIdPlaceholders})`,
      )
      .bind(
        lifecycleScope.appId,
        lifecycleScope.installationId,
        lifecycleScope.owner,
        lifecycleScope.repo,
        lifecycleScope.prNumber,
        ...findingIds,
      )
      .all<{ id: string; finding_id: string }>();
    for (const known of knownRows.results) seenRowIdByFindingId.set(known.finding_id, known.id);
  }
  const seen: LifecycleRound["seen"] = output.findings.map((finding) => {
    const findingId = computeFindingFingerprint(finding);
    let rowId = seenRowIdByFindingId.get(findingId);
    if (rowId === undefined) {
      rowId = crypto.randomUUID();
      seenRowIdByFindingId.set(findingId, rowId);
    }
    return { rowId, findingId, original: projectOriginalFinding(finding) };
  });

  // Line intents for the line-commentable findings (hunk prefilter over
  // the SAME worker-captured diff as the evidence catalog): preallocated
  // opaque UUIDs, trusted marker bodies, digest computed at staging.
  const qualifying = filterLineCommentFindings(
    output.findings,
    diffText !== "" ? diffText : undefined,
  );
  const lineIntents: LineIntent[] = [];
  for (const { finding, lineStart } of qualifying) {
    const rowId = seenRowIdByFindingId.get(computeFindingFingerprint(finding));
    if (rowId === undefined) continue; // unreachable — seen covers every finding
    // A range the wire cannot publish (cross-hunk, or a start that is not a
    // real range) falls back to the single-line anchor at line_end; the body
    // must not keep an applyable multi-line replacement for the dropped range.
    const rangeDemoted =
      typeof finding.line_start === "number" &&
      finding.line_start < finding.line_end! &&
      !(typeof lineStart === "number" && lineStart >= 1 && lineStart < finding.line_end!);
    lineIntents.push(
      await buildLineIntent({
        findingRowId: rowId,
        publicationId,
        associationId: crypto.randomUUID(),
        scope: lifecycleScope,
        originalSha: headSha,
        round,
        path: finding.file_path!,
        line: finding.line_end!,
        lineStart,
        body: renderLineCommentText(
          rangeDemoted ? { ...finding, body: dropAllSuggestionFences(finding.body) } : finding,
        ),
      }),
    );
  }

  const lifecycleRound: LifecycleRound = {
    // The clock moves for every selected row EXCEPT the rows the FIT omitted
    // for room. A row the catalog could not prove, or one a capture failure
    // never offered, is re-proved by a later round's diff — parking it at the
    // rotation head would keep it inside the 25-row cap forever. A fit-omitted
    // row is different: it was provable and simply did not fit, so it holds its
    // clock, stays at the head and is rescued when the next round reaches it.
    selectedRowIds: targets
      .filter((target) => !budgetExcluded.has(target.rowId))
      .map((target) => target.rowId),
    assessments: reconciled.assessments,
    seen,
    resolutions: reconciled.resolutions,
    coverage,
  };
  const payloadDoc: PublicationPayload = {
    version: 1,
    scope: lifecycleScope,
    headSha,
    kind: "review",
    round,
    targetCommentId: plan.action === "update" ? plan.commentId : null,
    body: preparedBody,
    bodySha256,
    artifact: {
      kind: "review",
      key: idemKey(key),
      schema: "mstar.review/v1",
      payload: output,
      appId: payload.botRef.appId,
      targetId: payload.targetId,
      model: chainHeadSelector(prepared.modelChain),
      provider: appliedProvider,
      // A stale-context round (its pending lifecycle journal failed to
      // apply OR its capture failed) still publishes, but its row must
      // never be an incremental base: the flag rides the staged artifact
      // so the put that writes it (here or on recovery) persists it.
      contextIncomplete: staleContext,
      // The round's own wall clock: the same `roundStartedAt` every budget
      // check reads, so the stored duration is the run's, not a second clock.
      durationMs: Date.now() - roundStartedAt,
    },
    lifecycle: lifecycleRound,
    lineIntents,
  };
  const staged = await stagePublication(deps.env.DB, { id: publicationId, payload: payloadDoc, nowMs: Date.now() });
  // An insert conflict returns the EXISTING immutable payload — a
  // prepared/confirmed publication is never overwritten with a second
  // model result (spec §7.7). The existing row owns this scope+SHA: hand
  // it to recovery instead of sending OUR newer body over it.
  if (staged.id !== publicationId) {
    deps.log.warn(
      fields,
      `publication journal conflict (existing row ${staged.id}, phase ${staged.phase}) — the immutable payload wins; not sending a second publication`,
    );
    await check?.terminalize(null, "pre-publication-failure");
    return { kind: "settled", outcome: { kind: "ok" } };
  }
  const stagedId = staged.id;
  return {
    kind: "collected",
    collected: { publicationId: stagedId },
  };
}

/**
 * Phase 4 — publish. Epoch-fenced claim, phase `sending`, the EXACT prepared
 * upsert, validated proof and the applied mark, then the intent-prepared line
 * comments and the resolution lane. No runner work: the paid result is already
 * durable before this phase starts.
 */
export async function publishAttempt(
  deps: ProcessDeps,
  ref: AttemptRef,
  publicationId: string,
): Promise<ProcessOutcome> {
  const progress = beginProgress();
  const sent: { publicationId: string | null } = { publicationId: null };
  try {
    return await publishPhase(deps, ref, publicationId, progress, sent);
  } catch (err) {
    throw phaseFailure("publish", err, {
      stage: progress.failureStage,
      headSha: null,
      secretValues: progress.secretValues,
      runnerStartedAt: progress.runnerStartedAt,
      runnerReturned: progress.runnerReturned,
      runnerEffectiveBudgetMs: undefined,
      changedLines: null,
      sendAttemptPublicationId: sent.publicationId,
    });
  }
}

async function publishPhase(
  deps: ProcessDeps,
  ref: AttemptRef,
  publicationId: string,
  progress: ReviewAttemptProgress,
  sentRecord: { publicationId: string | null },
): Promise<ProcessOutcome> {
  const { payload, attemptId, level } = ref;
  const commenter = requireCommenter(deps, payload);
  const sandboxId = attemptSandboxId(attemptId);
  // The JOURNAL ROW is the authority: a restart after staging publishes
  // exactly what was staged — its body, digest, target comment, round, line
  // intents and lifecycle — never an in-memory copy.
  const publication = await readPublication(deps.env.DB, publicationId);
  if (publication === null) {
    throw new Error(`publication ${publicationId}: its staged journal row is gone — nothing may be sent`);
  }
  const stagedPayload = publication.payload;
  const lifecycleScope = stagedPayload.scope;
  const headSha = stagedPayload.headSha;
  const round = stagedPayload.round;
  const preparedBody = stagedPayload.body;
  const bodySha256 = stagedPayload.bodySha256;
  const lineIntents = stagedPayload.lineIntents;
  const resolutions: { associationId: string; verified: VerifiedResolution }[] =
    stagedPayload.lifecycle?.resolutions ?? [];
  const key: IdempotencyKey = {
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: headSha,
  };
  const fields = attemptFields(payload, level, attemptId, headSha);
  // A resumed publication must still conclude the attempt's Check: the
  // settlement is adopted from the D1 attempt row when this host has none.
  const check = await settlementFor(deps, ref, headSha);
  const stagedId = publicationId;
  // The frozen instant fences the FIRST send BEFORE the journal is claimed, so
  // a refused publication leaves no `sending` row behind for a reconciler to
  // read as an attempted send.
  refusePublicationPastDeadline(ref.deadlineMs);
  // 13. §7.7 step 8 — epoch-fenced claim, phase sending, publish the EXACT
  // prepared upsert, validate the response id, persist proof BEFORE KV
  // done. A response/proof loss retains the staged payload for read-only
  // discovery — never a second paid review, never a blind re-send.
  const lease = await claimPublication(deps.env.DB, stagedId, `consumer:${sandboxId}`, Date.now());
  if (lease === null) {
    throw new Error("publication journal claim failed — refusing to send without the epoch-fenced lease");
  }
  sentRecord.publicationId = stagedId;
  let sent: { commentId: number };
  try {
    sent = await commenter.postPreparedReview({
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      headSha,
      round,
      targetCommentId: stagedPayload.targetCommentId,
      body: preparedBody,
      publicationId: stagedId,
      notAfterMs: ref.deadlineMs,
    });
  } catch (err) {
    // The adapter refused at the mutation because the instant had passed:
    // nothing was sent, so the attempt settles as a confirmed wall-clock stop
    // (the same rule the early refusal takes) rather than as a send with an
    // unknown outcome, and the staged row stays `prepared` for discovery.
    if (err instanceof PublicationDeadlineSpent) {
      throw new RoundBudgetSpent(`round budget spent: ${err.message}`, "runner");
    }
    if (err instanceof PreparedSendRejected) {
      // Definitive pre-send rejection (§7.7): no request left the Worker.
      // `failed` is the truthful durable phase (never the post-attempt
      // `unknown`); payload/digest/attempts are retained and recovery
      // never re-sends. The Check conclusion is the honest
      // pre-publication failure.
      try {
        await markPublicationFailed(deps.env.DB, stagedId, lease, err.message, Date.now());
      } catch (markErr) {
        const detail = markErr instanceof Error ? markErr.message : String(markErr);
        deps.log.warn(fields, `failed-phase mark could not be persisted: ${detail}`);
      }
      await check?.terminalize(null, "pre-publication-failure");
      deps.log.warn(fields, `prepared review definitively rejected before send — recorded failed: ${err.message}`);
      return { kind: "ok" };
    }
    throw err;
  }
  const proof = {
    publicationId: stagedId,
    scope: lifecycleScope,
    headSha,
    kind: "review" as const,
    round,
    commentId: sent.commentId,
    bodySha256,
    confirmedMs: Date.now(),
  };
  let proofOk = false;
  try {
    proofOk = await recordPublicationProof(deps.env.DB, stagedId, lease, proof);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `publication proof write threw: ${detail}`);
  }
  if (!proofOk) {
    // The honest unknown-publication window: the send happened but the
    // proof is not durable — no KV done, no local rows, no claim of
    // publication. The staged payload stays for M8 read-only discovery.
    deps.log.warn(
      fields,
      "publication proof could not be persisted after the send — retaining staged/sending for read-only discovery; no local completion is claimed",
    );
    await check?.terminalize(stagedId, "publication-unknown");
    return { kind: "ok" };
  }
  // 13a. KV done-state fence (BUG-01): follows durable confirmation (the
  // persisted proof) — a crash in the steps below redelivers into the
  // journal handoff ack, never a duplicate paid review.
  try {
    await deps.env.IDEMPOTENCY_KV.put(idemKey(key), IDEM_DONE, {
      expirationTtl: IDEMPOTENCY_SECONDS,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `KV completion write failed: ${detail}`);
  }

  // 14. §7.7 step 9 — with positive persisted proof only: the artifact
  // store.put + ONE idempotent lifecycle batch (inside
  // applyPublishedLifecycle, ending with the applied mark under the
  // lease). Local write failures do not undo the publication and never
  // rerun the model — the confirmed row stays due for M8 recovery.
  let applied = false;
  try {
    applied = await applyPublishedLifecycle(deps.env.DB, stagedId, lease, Date.now());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `lifecycle apply threw after a confirmed publication: ${detail}`);
  }
  if (!applied) {
    deps.log.warn(
      fields,
      "review published and confirmed but the lifecycle apply did not complete — publication stays confirmed for M8 recovery; acking to avoid a duplicate comment",
    );
    await check?.terminalize(stagedId, "publication-unknown");
    return { kind: "ok" };
  }

  // 15. §7.7 step 10 — post/capture the intent-prepared COMMENT-only line
  // review AFTER the result/lifecycle apply; persist the exact returned
  // review/comment ids against the associations. NEVER throwing: a remote
  // line failure is an explicit fallback log (the intents stay staged and
  // discoverable), never fabricated mappings.
  if (lineIntents.length > 0) {
    try {
      const postedLine = await commenter.postLineComments({
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
        headSha,
        round,
        publicationId: stagedId,
        intents: lineIntents,
      });
      if (postedLine.posted.length > 0) {
        try {
          const captureStmts = postedLine.posted.map((p) =>
            deps.env.DB
              .prepare(`UPDATE review_threads SET review_id = ?, comment_id = ?, updated_ms = ? WHERE id = ?`)
              .bind(postedLine.reviewId, p.commentId, Date.now(), p.associationId),
          );
          await deps.env.DB.batch(captureStmts);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(fields, `line-comment id capture failed (intents stay discoverable): ${detail}`);
        }
      }
      if (!postedLine.captured || postedLine.ambiguous.length > 0) {
        deps.log.warn(
          { ...fields, line_comments_fallback: true },
          `line-comment capture incomplete (ambiguous: ${postedLine.ambiguous.join(", ") || "none"}) — never fabricated`,
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { ...fields, line_comments_fallback: true },
        `line comments failed — overall comment already published, continuing overall-only: ${detail}`,
      );
    }
  }

  // 16. §7.7 step 11 — resolution LAST: persist the verified snapshot and
  // enqueue the pending row BEFORE the single inline attempt (a crash
  // before the first attempt stays discoverable by M8), then discover +
  // resolve. Never throws out of the message; never reruns the model.
  // Newly-created threads of THIS round are never resolved inline — their
  // associations carry no verified snapshot, so only PRIOR associations
  // with a complete verification are attempted here.
  //
  // The inline lane is a fast path, not the recovery engine: M8 owns
  // unbounded convergence with its own request/deadline discipline
  // (§7.11.1). Bounding it here keeps one queue message from spending
  // hundreds of sequential GitHub requests (P67-QC-017) — an entry that
  // cannot be admitted is simply left `pending`, which is exactly the
  // durable state M8 picks up, so nothing is lost and no attempt is spent
  // on skipped work.
  if (resolutions.length > 0) {
    const assocPlaceholders = resolutions.map(() => "?").join(",");
    const assocRows = await deps.env.DB
      .prepare(`SELECT id, intent_json FROM review_threads WHERE id IN (${assocPlaceholders})`)
      .bind(...resolutions.map((r) => r.associationId))
      .all<{ id: string; intent_json: string }>();
    const intentById = new Map(assocRows.results.map((row) => [row.id, row.intent_json]));
    let inlineResolveBudgetMs = INLINE_RESOLVE_BUDGET_MS;
    let inlineResolveAttempts = 0;
    for (const resolution of resolutions) {
      try {
        const enqueued = await deps.env.DB
          .prepare(
            // A CURRENT round supplies fresh verified_json — that is a
            // genuinely NEW assessment, so the retry budget and any stale
            // give-up/backoff state reset with it (§7.11.1: "resets
            // attempts only for a genuinely new assessment"). Without this
            // reset a row that had reached the cap could be re-enqueued as
            // `pending` while still `attempts >= 5`, making it permanently
            // invisible to `listResolutionRecovery` (a silent stall) and
            // preserving a stale backoff (P67-QC-005).
            `UPDATE review_threads
             SET verified_json = ?, resolution_state = 'pending', attempts = 0,
                 next_attempt_ms = NULL, last_error = NULL, updated_ms = ?
             WHERE id = ? AND superseded_by_publication_id IS NULL`,
          )
          .bind(JSON.stringify(resolution.verified), Date.now(), resolution.associationId)
          .run();
        if (enqueued.meta.changes === 0) continue; // superseded — nothing to resolve
        // The row is durably queued from here on, so any entry this lane
        // declines to start is picked up by M8 without spending an attempt.
        if (inlineResolveAttempts >= INLINE_RESOLVE_MAX_ENTRIES || inlineResolveBudgetMs <= 0) {
          deps.log.warn(
            fields,
            `inline resolution admission exhausted (${inlineResolveAttempts}/${INLINE_RESOLVE_MAX_ENTRIES} entries, ${inlineResolveBudgetMs}ms left) — association ${resolution.associationId} stays pending for scheduled recovery`,
          );
          continue;
        }
        const intentJson = intentById.get(resolution.associationId);
        if (intentJson === undefined || commenter.discoverThread === undefined || commenter.resolveFindingThread === undefined) {
          deps.log.warn(
            fields,
            `resolution for association ${resolution.associationId} enqueued but discovery is unavailable — left pending for recovery`,
          );
          continue;
        }
        // Admission for the entry about to start: it may spend up to the
        // same per-operation request envelope M8 uses, bounded by the
        // remaining inline deadline.
        inlineResolveAttempts += 1;
        const entryDeadline = Date.now() + Math.min(INLINE_RESOLVE_ENTRY_MS, inlineResolveBudgetMs);
        const entryStartedMs = Date.now();
        const discovery = await commenter.discoverThread({
          scope: lifecycleScope,
          intent: JSON.parse(intentJson) as LineIntent,
          reviewId: null,
        });
        inlineResolveBudgetMs -= Date.now() - entryStartedMs;
        if (discovery.kind !== "found") {
          deps.log.warn(
            fields,
            `thread discovery for association ${resolution.associationId} returned ${discovery.kind} — verified resolve stays queued (never claims a foreign or ambiguous thread)`,
          );
          continue;
        }
        if (Date.now() >= entryDeadline || inlineResolveBudgetMs <= 0) {
          deps.log.warn(
            fields,
            `inline resolve deadline passed before the mutation for association ${resolution.associationId} — left pending for scheduled recovery`,
          );
          continue;
        }
        const outcome = await commenter.resolveFindingThread({
          scope: lifecycleScope,
          associationId: resolution.associationId,
          verified: resolution.verified,
        });
        inlineResolveBudgetMs -= Date.now() - entryStartedMs;
        if (outcome.kind === "resolved") {
          deps.log.info(
            fields,
            `resolved association ${resolution.associationId} (thread ${outcome.threadId}${outcome.adopted ? ", adopted" : ""}${outcome.lateChange ? ", LATE CHANGE recorded" : ""})`,
          );
        } else {
          const reason = outcome.kind === "needs-recheck" || outcome.kind === "retry" || outcome.kind === "abandoned" ? outcome.reason : "";
          deps.log.warn(
            fields,
            `resolve for association ${resolution.associationId} returned ${outcome.kind} (${reason}) — durable queue state owns the follow-up`,
          );
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(fields, `resolution attempt for ${resolution.associationId} failed (queued state intact): ${detail}`);
      }
    }
  }

  // 17. Degraded-comment lifecycle (Bugbot finding): the successful
  // review supersedes any earlier degradation — best-effort cleanup AFTER
  // the normal publication proof, never deleting unconfirmed evidence.
  // §7.7 step 11 gate: while ANY degraded journal row for this scope is
  // still prepared/sending/unknown WITHOUT persisted proof, that comment's
  // exact body is the sole recovery evidence for a possibly-landed send —
  // deleting it would make the publication permanently unprovable, so the
  // cleanup is skipped and the condition is logged for the operator.
  try {
    const mustPreserve = await hasUnprovenDegradedPublication(deps.env.DB, lifecycleScope);
    if (mustPreserve) {
      deps.log.warn(
        fields,
        "stale degraded comment cleanup skipped — an unconfirmed degraded publication still depends on its body as recovery evidence",
      );
    } else {
      const deleteOutcome = await commenter.deleteDegradedComment({
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
        error: "",
        rawOutput: "",
      });
      if (deleteOutcome.deleted > 0 || deleteOutcome.skipped > 0 || deleteOutcome.errors.length > 0) {
        deps.log.warn(
          { ...fields, degraded_delete_deleted: deleteOutcome.deleted, degraded_delete_skipped: deleteOutcome.skipped },
          `stale degraded comment cleanup (review stands): deleted=${deleteOutcome.deleted}, skipped=${deleteOutcome.skipped}${
            deleteOutcome.errors.length > 0 ? `, errors=[${deleteOutcome.errors.join("; ")}]` : ""
          }`,
        );
      }
      // A throttled sweep is a CONTINUATION event, not a failure of this
      // review: ONE row per non-zero kind under the non-failure `rate-limit`
      // stage (excluded from every failure count) so the throttle is not
      // silently dropped. Each row carries its own kind's prefix, so a
      // primary 429 never inflates the secondary-limit count. Its own
      // try/catch — the insert must never mask the review that stands, and
      // the round is never retried for it.
      const rateLimitKinds = [
        { kind: "primary", prefix: GITHUB_PRIMARY_RATE_LIMIT_PREFIX, count: deleteOutcome.rateLimited.primary },
        { kind: "secondary", prefix: GITHUB_RATE_LIMIT_PREFIX, count: deleteOutcome.rateLimited.secondary },
      ] as const;
      for (const { kind, prefix, count } of rateLimitKinds) {
        if (count === 0) continue;
        try {
          await deps.failureStore.record({
            target_id: payload.targetId,
            installation_id: payload.installation_id,
            owner: payload.owner,
            repo: payload.repo,
            pr_number: payload.pr_number,
            head_sha: headSha,
            stage: "rate-limit",
            error: `${prefix}${count} stale degraded comment deletion(s) rejected by the GitHub ${kind} rate limit — the review stands`,
          });
        } catch (recordErr) {
          const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
          deps.log.warn(fields, `review_failures insert failed (degraded cleanup continues): ${recordDetail}`);
        }
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `stale degraded comment delete failed (review stands): ${detail}`);
  }

  // 18. §7.7 step 12 — the Check terminal decision reads the persisted
  // proof for this publication (a degraded publication derives `failure`
  // from it, never a pass; the inline outcome value is only the honest
  // fallback when the proof is unreadable).
  await check?.terminalize(stagedId, "publication-unknown");
  // Written from the DURABLE facts — a publication is confirmed, and the Check
  // row itself decides whether it is still open — never from whether this host
  // happened to cache a handle. A settled Check makes the note a no-op.
  await noteOwedCheck(deps, ref, headSha, check?.handle?.attemptId);
  return { kind: "ok" };
}

/**
 * The attempt's failure settlement: every throw past admission lands here —
 * the exhaustion stop, an unprovable container, or an infra failure. It
 * records the durable outcome, resolves the Check's conclusion from it and
 * decides whether this delivery may be retried. An unproven container is never
 * a failure: it changes nothing and is left to the reconciler.
 */
export async function settleAttemptFailure(
  deps: ProcessDeps,
  ref: AttemptRef,
  thrown: unknown,
  /** The facts this settlement hands cleanup (a durable proof, or an unknown verdict). */
  cleanup: CleanupInput,
): Promise<ProcessOutcome> {
  const { payload, level, attemptId, githubAppId } = ref;
  // The phase's facts arrive as data; the cause keeps its type for the branches
  // below, so a wrapped rejection is settled exactly as the raw one was.
  const failure = thrown instanceof AttemptPhaseError ? thrown : undefined;
  const facts = failure?.facts;
  const err = failure?.cause ?? thrown;
  const detail = err instanceof Error ? err.message : String(err);
  /**
   * The settle-once mark is written HERE, at the settlement's own completion,
   * never at its entry: a host interrupted mid-settlement leaves the mark
   * unset, so the next execution settles again. It certifies only effects that
   * actually landed:
   * - the failure row is a PRECONDITION (`durableOutcome`): a rejected insert
   *   leaves no mark, so a replay finishes the settlement instead of skipping
   *   it — that is why the generic path passes `durableOutcome` here;
   * - the Check conclusion is a precondition by construction: a throwing
   *   `terminalize` propagates before this is reached;
   * - the failed-claim KV stamp is NOT: it is best-effort by its own contract,
   *   and requiring a KV write would let a KV fault block settlement forever.
   * A delivery with no handoff row (a direct phase caller) matches no row.
   */
  const markSettled = async (landed: readonly SettlementEffect[], required: readonly SettlementEffect[]): Promise<void> => {
    try {
      await markAttemptSettled(
        deps.env.DB,
        deliveryKeyOf(payload),
        landed,
        required,
        Date.now(),
      );
    } catch (markErr) {
      deps.log.warn(
        { ...payloadIdentityFields(payload), attempt_id: attemptId },
        `settle-once mark write failed — a replay will settle again: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
      );
    }
  };
  // A moved head is a SKIP, not a failure: the attempt already concluded its
  // Check as skipped and wrote its skip row, so it acks here — no failure row,
  // no pre-publication settlement, no retry. (Quiet instead of rethrowing: the
  // queue's next delivery would mint a fresh attempt id and could pay twice.)
  if (err instanceof MovedHeadError) {
    // The moved head's own settlement (skip row + Check conclusion + outbox
    // row) ran before this settlement was called, so there is nothing left to
    // finish and the mark can say so.
    await markSettled(["skip"], ["skip"]);
    return { kind: "ok" };
  }
  const progress: ReviewAttemptProgress = {
    failureStage: facts?.stage ?? "pipeline",
    secretValues: facts?.secretValues ?? [],
    runnerStartedAt: facts?.runnerStartedAt,
    runnerReturned: facts?.runnerReturned ?? false,
  };
  const sandboxId = attemptSandboxId(attemptId);
  const headSha = facts?.headSha ?? null;
  if (cleanup.headSha === undefined) cleanup.headSha = headSha;
  // The paid exec STARTED and its return was never observed: the child may
  // still be running, so nothing may authorise destruction. This only REMOVES
  // authorisation — the durable records remain the gate that grants it.
  if (facts !== undefined && facts.runnerStartedAt !== undefined && !facts.runnerReturned) {
    cleanup.unproven = true;
  }
  const fields = headSha === null ? undefined : attemptFields(payload, level, attemptId, headSha);
  const baseFields: ConsumerLogFields | undefined = undefined;
  const lifecycleScope = scopeOf(payload);
  const sendAttempt =
    facts?.sendAttemptPublicationId === null || facts?.sendAttemptPublicationId === undefined
      ? null
      : { publicationId: facts.sendAttemptPublicationId };
  const observedChangedLines = facts?.changedLines ?? null;
  const terminalizeBudgetMs = ref.checkBudgets?.terminalizeMs ?? CHECK_TERMINALIZE_DEFAULT;
  const roundBudget = deriveReviewBudget({
    roundStartMs: ref.roundStartedAt,
    deadlineMs: ref.deadlineMs,
    terminalizeMs: terminalizeBudgetMs,
    level,
  });
  const check = maybeSettlement(deps, attemptId);
  // A container may exist only when the provisioning claim was written; that
  // row is the durable fact the "nothing to reclaim" decision reads.
  const launch = await readReviewLaunch(deps.env.DB, attemptId);
  const sandboxMayExist = launch !== null;
  // THE DURABLE ROW OUTRANKS THIS HOST'S BELIEF (plan Task 4b): `launched` with
  // no stored outcome means the paid call's fate is unknown, whatever the
  // failing phase seems to have seen. A step-level rejection — a Workflow
  // timeout waiting for the paid reply or for a post-run read — carries no
  // `runnerReturned` fact at all, so it may not conclude the Check, stamp the
  // commit or release capacity. Only a settlement whose phase facts OBSERVED
  // the return continues to the terminal path below.
  //
  // An UNREADABLE row is the same refusal, unconditionally: this build cannot
  // say which outcome that row records, so the outcome is unobservable — no
  // phase's story may substitute for it, not even an observed return.
  const paidStateObserved = progress.runnerReturned;
  const launchJudgement = launchVerdict(launch);
  const outcomeUnobservable =
    launchJudgement.kind === "unrecognised" ||
    (launchJudgement.kind === "paid-unknown" && !paidStateObserved);
  if (outcomeUnobservable) {
    deps.log.warn(
      {
        ...(fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId }),
        event: "review_unresolved",
      },
      `review unresolved: ${detail} — the launch row records no readable paid outcome (${launchJudgement.kind}), so nothing was concluded, destroyed or reclaimed`,
    );
    cleanup.unproven = true;
    return { kind: "unknown" };
  }
  let durableOutcome = false;
  // § Exhaustion (the ONE typed terminal outcome outside the verdict
  // envelope): every wall-clock stop funnels here — the runner's own
  // exit-0 signal, the sandbox exec killed at the anchored deadline, and
  // the consumer's derived-deadline refusals, all already resolved to (or
  // resolvable from) the attempt's own facts. A confirmed stop is terminal
  // and is published with its own outcome FIRST — the generic outcome
  // resolution below must never freeze `pre-publication-failure` over the
  // Check this stop owes. Check `failure` with the typed record, the
  // durable `budget-exhausted:` row, then `{kind:"budget-exhausted"}` so
  // the handler acks — a paid queue retry can only lose the same clock
  // again, and the spec forbids implying otherwise. Journal staging,
  // recheck resolve/rotate and comment writes never ran (all post-parse),
  // so this catch is the only publication step the outcome needs.
  if (err instanceof BudgetExhaustedError || err instanceof RoundBudgetSpent) {
    const budgetOutcome: BudgetExhaustedOutcome =
      err instanceof BudgetExhaustedError
        ? err.outcome
        : {
            kind: "budget-exhausted",
            cause: "consumer-deadline",
            // Every derived-deadline refusal sits past level resolution
            // and budget derivation — the `!`s encode that ordering fact,
            // never a guess.
            tier: level!,
            budgetWindow: err.window,
            budgetMs:
              err.window === "runner"
                ? (facts?.runnerEffectiveBudgetMs ?? roundBudget.preparationBudgetMs)
                : roundBudget.preparationBudgetMs,
            // A consumer decline fires before the runner exec starts:
            // provably no seat was dispatched or stopped.
            seatsDispatched: 0,
            seatsStopped: 0,
            changedLines: observedChangedLines,
          };
    // A stop that fired BEFORE the fallback claim (the diff stage, its
    // oversized substitute, or the numstat that follows) can reach here with
    // no Check at all: an issue-comment delivery carries no payload SHA and
    // may have no readable head watermark, so the admission-time claim was
    // skipped and the fallback never ran. The checkout SHA IS known by then,
    // so claim here — an ACK that publishes nothing would leave the frozen
    // failure this stop owes with no trace and no recovery intent. A claim
    // already ATTEMPTED is never retried: the claim insert is the one
    // race-decided gate, and a second try could mint a second generation.
    // A deadline already SPENT cannot own a Check lease (the row's deadline IS
    // that instant), so the claim is skipped there: the recovery lane closes
    // the row at its own expiry and the durable failure above is the stop's
    // record. Claiming would throw and mask the typed stop.
    if (
      deps.checks !== undefined &&
      check !== undefined &&
      check.handle === null &&
      !check.claimAttempted &&
      lifecycleScope !== undefined &&
      headSha !== null &&
      ref.deadlineMs > Date.now()
    ) {
      check.claimAttempted = true;
      await check.begin(lifecycleScope, githubAppId, headSha);
    }
    const budgetDetail = `budget-exhausted: ${JSON.stringify(budgetOutcome)} — ${err instanceof Error ? err.message : String(err)}`;
    deps.log.error(
      {
        ...(fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId }),
        ...(level === undefined
          ? {}
          : {
              level,
              runner_timeout_ms: runnerTimeoutMs(level),
              orchestration: level === "deep" ? "parent" : "bun-fanout",
            }),
        ...(progress.runnerStartedAt === undefined ? {} : { elapsed_ms: Date.now() - progress.runnerStartedAt }),
        budget_outcome: budgetOutcome,
      },
      `review failed: ${budgetDetail}`,
    );
    try {
      await deps.failureStore.record({
        target_id: payload.targetId,
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        head_sha: fields?.head_sha ?? payload.head_sha ?? "",
        stage: progress.failureStage,
        error: redactExactSecrets(redactSecrets(budgetDetail), progress.secretValues),
      });
      // Confirmed by the await above: only a write that RESOLVED is durable.
      durableOutcome = true;
    } catch (recordErr) {
      const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      deps.log.warn(
        fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
        `review_failures insert failed (exhaustion path continues): ${recordDetail}`,
      );
    }
    if (!durableOutcome) {
      // No durable record of this stop: the Check is left alive for the
      // recovery lane (a terminal conclusion here could never be undone) and
      // the attempt ends unknown — no destruction, no capacity release.
      deps.log.warn(
        {
          ...(fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId }),
          ...(level === undefined
            ? {}
            : {
                level,
                runner_timeout_ms: runnerTimeoutMs(level),
                orchestration: level === "deep" ? "parent" : "bun-fanout",
              }),
          ...(progress.runnerStartedAt === undefined ? {} : { elapsed_ms: Date.now() - progress.runnerStartedAt }),
          event: "review_unresolved",
        },
        `review unresolved: ${budgetDetail} — no durable outcome was recorded, so nothing was destroyed or reclaimed`,
      );
        cleanup.unproven = true;
        return { kind: "unknown" };
      }
      // The row is durable — and it was durable BEFORE this transition, which
      // is the whole point: a phase that observed the paid call return (a
      // nonzero status, the exec killed at the deadline, the runner's own
      // exhaustion signal) makes the attempt's OTHER terminal fact durable
      // here, after the failure row, never before it. A stop whose exec never
      // started already moved the row itself (it alone could prove that).
      if (paidStateObserved) await recordReviewFailure(deps.env.DB, attemptId, Date.now());
      // The row is durable: now the Check may carry the stop's conclusion.
    await check?.terminalize(null, "budget-exhausted", undefined, budgetOutcome);
    // The row is durable here (the !durableOutcome case returned `unknown`
    // above) and the Check conclusion just landed. The budget stop writes no
    // failed-claim stamp on this route, so none is owed.
    await markSettled(
      check === undefined ? ["failure-row"] : ["failure-row", "check"],
      settlementObligationsOf(payload, check !== undefined),
    );
    return { kind: "budget-exhausted", outcome: budgetOutcome };
  }

  // An unproven container is NOT a failure: a missing/different marker (or a
  // lost read) says nothing about whether the review ran. No Check change, no
  // failure row, no failed-claim stamp, no destroy, no capacity release, and
  // no retry — a second delivery would provision a second container and pay
  // the model again on ambiguous acceptance. The Check stays `in_progress`
  // for the reconciler, which owns the abandoned-attempt outcome.
  if (err instanceof AttemptUnknownError) {
    deps.log.warn(
      {
        ...(fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId }),
        ...(level === undefined
          ? {}
          : {
              level,
              runner_timeout_ms: runnerTimeoutMs(level),
              orchestration: level === "deep" ? "parent" : "bun-fanout",
            }),
        ...(progress.runnerStartedAt === undefined ? {} : { elapsed_ms: Date.now() - progress.runnerStartedAt }),
        event: "review_unresolved",
      },
      `review unresolved: ${err.message} — nothing was collected, destroyed or reclaimed`,
    );
      cleanup.unproven = true;
      return { kind: "unknown" };
    }
    // Structured failure log carrying the idempotency key + sandbox id
  // (the failure log must carry the idempotency key: 失败路径错误日志含幂等键), then
  // rethrow so the worker retries and eventually DLQs.
  deps.log.error(
    {
      ...(fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId }),
      // d5-budget AC-S10-logs: the failure line carries the level's budget
      // once known (post-step-3 `fields` already has it; this spread covers
      // the pre-checkout fallback) and the runner's elapsed wall-clock once
      // it started. elapsed never aborts — the sandbox exec timeout is the
      // only wall-clock failure (spec 不 abort).
      ...(level === undefined
        ? {}
        : {
            level,
            runner_timeout_ms: runnerTimeoutMs(level),
            orchestration: level === "deep" ? "parent" : "bun-fanout",
          }),
      ...(progress.runnerStartedAt === undefined ? {} : { elapsed_ms: Date.now() - progress.runnerStartedAt }),
    },
    `review failed: ${detail}`,
  );

  // AL-6: best-effort review_failures row BEFORE the
  // rethrow — an unresolved attempt otherwise leaves zero D1 trace (the audit
  // blind spot). `stage` = the coarse phase in flight (failureStage); rows are
  // per-attempt events, so a re-executed settlement can append one duplicate
  // event row, never a second terminal claim. The insert
  // must never mask the rethrow: its own failure is a warn line only.
  // SEC-03: the error detail is redacted (shape + exact-value passes)
  // before the durable row — an infra error can interpolate a
  // secret-shaped value (defense-in-depth; clean strings pass through).
  // The GitHub secondary-rate-limit cause is tagged HERE — once, before
  // redaction — so the row's text and the store's prefix count share one
  // source of truth (a second detection site would drift).
  const persistedDetail =
    classifyGithubRateLimit(err) === "secondary" ? `${GITHUB_RATE_LIMIT_PREFIX}${detail}` : detail;
  try {
    await deps.failureStore.record({
      target_id: payload.targetId,
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      // The authoritative sha once the checkout resolved it; before that
      // the payload sha, else "" (= never resolved).
      head_sha: fields?.head_sha ?? payload.head_sha ?? "",
      stage: progress.failureStage,
      error: redactExactSecrets(redactSecrets(persistedDetail), progress.secretValues),
    });
    // Confirmed by the await above: a resolved write is the attempt's durable
    // terminal no-result outcome. A rejection leaves the latch false.
    durableOutcome = true;
  } catch (recordErr) {
    const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
    deps.log.warn(
      fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
      `review_failures insert failed: ${recordDetail}`,
    );
  }
  if (!durableOutcome && sandboxMayExist) {
    // A container exists and nothing durable came of this attempt: no row
    // landed, so no terminal outcome can be claimed. It ends `unknown` — no
    // destruction, no capacity release, no Check conclusion — instead of a
    // failure nobody can read back later. (A failure BEFORE any container —
    // credential gate, configuration — keeps the retry → DLQ path: there is
    // nothing unresolved to leave behind.)
    deps.log.warn(
      {
        ...(fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId }),
        ...(level === undefined
          ? {}
          : {
              level,
              runner_timeout_ms: runnerTimeoutMs(level),
              orchestration: level === "deep" ? "parent" : "bun-fanout",
            }),
        ...(progress.runnerStartedAt === undefined ? {} : { elapsed_ms: Date.now() - progress.runnerStartedAt }),
        event: "review_unresolved",
      },
      `review unresolved: ${detail} — no durable outcome was recorded, so nothing was destroyed or reclaimed`,
    );
      cleanup.unproven = true;
      return { kind: "unknown" };
    }
    // A returned status is a terminal fact only together with the failure row
    // written above: the row moves to `failed` AFTER that write, so cleanup
    // can never read "terminal" without something durable to read it against.
    if (paidStateObserved && durableOutcome) {
      await recordReviewFailure(deps.env.DB, attemptId, Date.now());
    }
  // §7.7 step 12 on the failure path: a Check begun at step 4 must
  // terminalize even when the pipeline throws. After a send ATTEMPT the
  // publication status is unknown (the request may have landed); before
  // any send the honest outcome is pre-publication-failure. Isolated —
  // never masks the throw.
  if (sendAttempt !== null) {
    await check?.terminalize(sendAttempt.publicationId, "publication-unknown");
  } else {
    await check?.terminalize(null, "pre-publication-failure");
  }

  // The Workflow instance is the attempt's TERMINAL owner: on this route there
  // is no further queue delivery ladder to wait out, so a settled failure
  // stamps the commit's claim `failed` (the worker's claim TTL) immediately —
  // neither the worker's pre-check nor the supersede skip may keep treating the
  // stale "1" as proof of a review that is coming. The owner is the claim this
  // delivery actually took: the payload head's idempotency key. A comment-only
  // delivery states no commit, so it has no such claim; its consumed comment
  // claim already refuses replay and the failure row is the trace.
  // `putAbandonClaim` never downgrades a completed review. Best-effort: a KV
  // fault only leaves "1" behind, which the failure row above traces, and it
  // never masks the rethrow.
  let claimStampLanded = payload.head_sha === null || payload.head_sha === undefined || payload.head_sha === "";
  if (payload.head_sha) {
    try {
      await putAbandonClaim(
        deps.env.IDEMPOTENCY_KV,
        idemKey({
          installation_id: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          pr_number: payload.pr_number,
          head_sha: payload.head_sha,
        }),
        IDEM_FAILED,
        IDEMPOTENCY_SECONDS,
      );
      claimStampLanded = true;
    } catch (kvErr) {
      const kvDetail = kvErr instanceof Error ? kvErr.message : String(kvErr);
      deps.log.warn(
        fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
        `failed-claim KV write failed — the mark records the missing stamp and a replay finishes it (the skip may still treat this commit as queued): ${kvDetail}`,
      );
    }
  }
  // The mark records the effects that ACTUALLY landed, and completes only when
  // the set this settlement owed is closed: the failure row (when a container
  // may exist, a settlement with no durable outcome returned `unknown` above;
  // otherwise a replay retries the write), the Check conclusion when this
  // attempt had a Check, and the failed-claim stamp when the delivery names a
  // commit. A missing effect is not swallowed: it is recorded, so an operator
  // reads it and a replay finishes it — a KV blip never leaves the review
  // unsettled, and a lost row is never certified.
  const effects: SettlementEffect[] = [];
  if (durableOutcome) effects.push("failure-row");
  if (check !== undefined) effects.push("check");
  if (claimStampLanded) effects.push("claim-stamp");
  // The required set is the settlement's own obligation (`settlementObligationsOf`):
  // the mark completes only when the UNION of every settlement execution for
  // this delivery covers it, so two racing settlements cannot erase each
  // other's progress and neither can certify a missing effect.
  await markSettled(effects, settlementObligationsOf(payload, check !== undefined));
  throw err;
}
/**
 * Phase 5 — cleanup. Destroy only the proven container, once its result or a
 * confirmed no-result outcome is durable, then release the admission row.
 * Neither ordering nor evidence changed: capacity is never released on
 * unknown container state, and cleanup never replaces collection.
 */
export type CleanupInput = {
  /**
   * The failure path established the container's state is unknown: it can only
   * REMOVE authorisation, never add it.
   */
  unproven?: boolean;
  /** The checkout sha, when this invocation knew it, so the teardown line keeps the round's identity. */
  headSha?: string | null;
};

export async function cleanupAttempt(
  deps: ProcessDeps,
  ref: AttemptRef,
  input: CleanupInput = {},
): Promise<CleanupOutcome> {
  const { payload, attemptId, inflight } = ref;
  const sandboxId = attemptSandboxId(attemptId);
  const fields = attemptFields(payload, ref.level, attemptId, input.headSha ?? null);
  const baseFields: ConsumerLogFields | undefined = undefined;
  // THE RETENTION CONTRACT, read from the attempt row and nothing else (plan
  // Task 4b's table, one row per state):
  //   absent                    → no-paid-work (never claimed)
  //   provisioned               → no-paid-work (container may exist, the paid
  //                               exec was never sent, nothing was charged)
  //   launched                  → unknown: hold container and capacity. The
  //                               schema couples `launched` to NULL outcome, so
  //                               there is no "launched with an outcome" row.
  //   persisted | failed        → retained (each carries its own outcome)
  // No phase-local value participates: the row's state was written by whatever
  // observed the fact, and cleanup only reads it.
  // DESTRUCTION CLAIMS THE ROW FIRST: reading `provisioned` is not permission,
  // because a concurrent attempt can move the row to `launched` between the
  // read and the destroy. The CAS is the authority — only a won CAS may destroy,
  // and a loser reports `unknown` because the container may be paying.
  // The claim is the ONLY way to authorise destroying an attempt that has not
  // reached a terminal state — and `absent` is no exception. A faulted claim
  // (the write's reply was lost) is a LOSING claim: nothing is destroyed.
  let claimed = false;
  try {
    claimed = await abandonReviewLaunch(deps.env.DB, attemptId, Date.now());
  } catch {
    claimed = false;
  }
  let retention: RetentionProof | undefined;
  let containerMayExist = claimed;
  if (claimed) {
    // This caller WON the row: the container, if any, is ours to destroy.
    retention = { kind: "no-paid-work" };
  } else {
    const verdict = launchVerdict(await readReviewLaunch(deps.env.DB, attemptId));
    switch (verdict.kind) {
      case "never-claimed":
      case "never-paid":
        // The claim was lost or faulted, so this caller does not own the
        // attempt: hold, and never fall back to `no-paid-work`.
        containerMayExist = false;
        retention = undefined;
        break;
      case "persisted":
      case "paid-failed":
        // Terminal states cannot move to `launched`, so no claim is needed.
        containerMayExist = true;
        retention = { kind: "retained" };
        break;
      case "owned-by-cleanup":
        // ANOTHER cleanup owns this container: return unknown and touch
        // neither the container nor capacity — never `no-paid-work`.
        containerMayExist = false;
        retention = undefined;
        break;
      case "unrecognised":
        // A row this build cannot interpret is never permission: hold.
        containerMayExist = true;
        retention = undefined;
        break;
      case "paid-unknown":
        containerMayExist = true;
        retention = undefined;
        break;
      default:
        return noLaunchState(verdict);
    }
  }
  let containerUnproven = retention === undefined || input.unproven === true;
  // Destroy FIRST, then release the admission row. Releasing first would let
  // the next attempt for this PR acquire the slot and start its container
  // while this one is still alive, so live containers could exceed
  // min(system, workspace) by the destroy latency. Both blocks warn only.
  if (containerUnproven) {
    deps.log.warn(
      {
        ...(fields ?? baseFields ?? payloadIdentityFields(payload)),
        sandbox_id: sandboxId,
        event: "sandbox_teardown_unproven",
      },
      input.unproven === true
        ? "sandbox not destroyed: the failure left the container's state unknown — capacity held, nothing released"
        : "sandbox not destroyed: no durable outcome to justify it — capacity held, nothing released",
    );
  } else if (containerMayExist) {
    try {
      // The handle is re-derived by attempt id — a resumed invocation has no
      // previous one — and the marker gate inside `destroyMarked` decides
      // whether this really is the attempt's container.
      const sandbox = await deps.getSandbox(deps.env.SANDBOX, sandboxId);
      // Proven sameness, not a name: a container this attempt cannot prove
      // it prepared is left alone (its result may be the only copy) and the
      // teardown is reported as unknown.
      if ((await discardReviewAttempt(sandbox, attemptId, retention!)) !== "destroyed") {
        containerUnproven = true;
        deps.log.warn(
          {
            ...(fields ?? baseFields ?? payloadIdentityFields(payload)),
            sandbox_id: sandboxId,
            event: "sandbox_teardown_unproven",
          },
          "sandbox not destroyed: the container is not proven to be this attempt's — capacity held, nothing released",
        );
      }
    } catch (err) {
      // A LOST proof is the same fact as a refused one: the container's
      // state is unknown, so capacity must not be handed to a new attempt.
      containerUnproven = true;
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        {
          ...(fields ?? baseFields ?? payloadIdentityFields(payload)),
          sandbox_id: sandboxId,
          event: "sandbox_teardown_unproven",
        },
        `sandbox teardown unproven: ${detail} — capacity held, nothing released`,
      );
    }
  }
  // Release the admission row once the review settled (posted, KV done,
  // put attempted) OR failed — either way the next attempt may proceed.
  // Scoped to THIS attempt's id, so an older attempt can never delete a row
  // a newer one reclaimed after expiry; a release failure only warns (the
  // row expires by TTL), never masks the review's own outcome.
  if (inflight !== null && !containerUnproven) {
    try {
      await releaseInflight(deps.env.DB, inflight.key, inflight.attemptId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { ...(fields ?? baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
        `review admission release failed — the row expires by TTL (${inflight.ttlSeconds}s): ${detail}`,
      );
    }
  }
  return {
    retention:
      retention === undefined ? "unknown" : retention.kind === "retained" ? "retained" : "no-paid-work",
  };
}
