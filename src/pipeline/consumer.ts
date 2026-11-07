/**
 * Queue consumer — the review pipeline main flow.
 *
 * Flow (compass S7): message → resolve the App's sandbox
 * image (the stored github_apps.sandbox_image_id through the closed
 * registry — unknown/disabled ids fail closed BEFORE the guard/sandbox) →
 * getSandbox (unique id per attempt) → clone the PR head branch (git
 * transport auth via scoped extraheader env) → `git rev-parse HEAD` for the
 * AUTHORITATIVE sha →
 * dedup by that sha (hit → ack) → diff → numstat (the seat-partition
 * universe) → write the runner `--input` JSON (reconFacts, plus the per-App
 * `modelOverrides` role map; no-map App = byte-identical
 * payload; plus the resolved image's capability hosts (the
 * in-image synthesis base) → exec the
 * in-image runner `--level <quick|default|deep>` (exec env =
 * provider credential pools + PI_CODING_AGENT_DIR/HARNESS_PLUGIN_ROOT +
 * OMP_REVIEW_MODEL; all key material and the model chain come ONLY from
 * the App's own per-App config (AL-24-5 zero global fallback: an App missing
 * its model chain or a chain provider's key fails closed after App
 * resolution via the F-001 channel — review failed log + review_failures
 * row + rethrow → retry×3 → DLQ); GH_TOKEN rides ONLY the git/gh step
 * envs) → parse
 * the mstar.review/v1 envelope → (spec §7.7 FROZEN ORDER) dedup +
 * publication-journal handoff read BEFORE model work → pending confirmed
 * lifecycle apply + targets/evidence/discussion capture → optional fenced
 * Check claim (the §7.10 seam; absent `checks` dep = no Checks, M8 fully
 * operational) → runner + concurrent bounded recheck → validation +
 * conservative §7.4 reconciliation + §7.10 closure + final body →
 * STAGE the complete private payload BEFORE any GitHub mutation →
 * epoch-fenced claim + proof-based publication (proof persisted before KV
 * done) → proof-gated store.put + ONE idempotent lifecycle batch →
 * intent-prepared line comments + id capture → resolution LAST (verified
 * snapshots enqueued before the single inline discover+resolve attempt) →
 * proof-read Check terminalize → finally destroy. Any step throwing →
 * structured log
 * + a best-effort review_failures row (stage classified from the phase in
 * flight; AL-6 — DLQ-bound infra failures otherwise leave
 * zero D1 trace) + rethrow (queue retry → DLQ). The runtime runner has NO
 * summary-degrade path: exit 0 means stdout is the engine-validated
 * envelope; a non-zero exit keeps the no-post/no-insert rethrow. A
 * parse/validate failure takes the DEGRADE path instead (AL-1, now routed
 * through the §7.7 journal as a `degraded` publication):
 * review_failures row (stage=parse) + staged→sent degraded comment (both
 * best-effort) + ack — parseReviewOutput is a pure function of
 * run.stdout, so retry is deterministic waste. No reviews row and NO KV
 * done-state on degrade; a later trigger for the same sha re-runs the
 * review UNLESS the §7.7 step-2 journal read finds a non-terminal row for
 * that scope/SHA (which hands off to recovery and acks — the applied
 * degraded publication is terminal and never blocks a legitimate re-run).
 * Three typed outcomes never throw: the in-flight
 * guard (bugbot BB-3) — guard-held schedules a per-message delayed retry
 * (60s/120s/240s) and finally acks with a warning instead of DLQing — a
 * PAUSED App's message (review_enabled=0), which acks
 * immediately with ZERO side effects (no guard, no sandbox, no token
 * mint, no app-config read, no GitHub write, no retry, no DLQ) — and the
 * parse-fail degrade.
 *
 * Sha consistency (bugbot A2): every downstream use — idempotency key, D1
 * row, posted commit_id, KV completion — is keyed off the sha read back
 * from the checked-out HEAD, never the webhook payload sha (which only
 * feeds the pre-enqueue KV fast path in the worker). The diff, the clone
 * files and the commit_id therefore always describe the same commit; a
 * force-push between webhook delivery and processing is captured by the
 * rev-parse instead of drifting silently. The pre-clone payload-sha dedup
 * is gone for the same reason: it could skip a review that the live clone
 * would have picked up (force-push between delivery and processing).
 *
 * Module boundary (compass contracts A): this is the ONLY legal edge from
 * worker → pipeline (worker/index.ts queue wiring). It imports contracts/
 * (payload + idempotency key), review/schema (pure zod) + packages/shared/src/runtime
 * (pure port types/constants — dual-face, zero omp SDK),
 * store/artifact-store (07 D1 ArtifactStore) + store/failure-store (the
 * review_failures leaf), and the pipeline modules —
 * never src/worker/**.
 */

import type { D1Database, KVNamespace, Message, MessageBatch } from "@cloudflare/workers-types";
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
  IDEM_DROPPED,
  IDEM_FAILED,
  IDEM_PAUSED,
  IDEM_SUPERSEDED,
  isReviewClaim,
  putAbandonClaim,
  type IdempotencyKey,
} from "../contracts/idem";
import { parseReviewOutput, capFindings, clampFindingSizes } from "../review/schema";
import type { ReviewFinding, ReviewOutput } from "../review/schema";
import type { CustomProviderDeclaration, ReviewLevel } from "../../packages/shared/src/runtime";
import { providerEnvName } from "./provider-catalog";
import { encodeCredentialPayload, type CredentialPools } from "../../packages/shared/src/credential-payload";
import { redactExactSecrets, redactReviewOutput, redactReviewOutputExact, redactSecrets } from "./redact";
import { createArtifactStore, type D1ArtifactStore } from "../store/artifact-store";
import { createFailureStore, type FailureStage, type FailureStore } from "../store/failure-store";
import { hasUsageEventForExecutionToken, recordUsageEvent } from "../store/usage-store";
import { computeFindingFingerprint } from "../store/fingerprint";
// The hand-off's two fenced writes live in the Check registry (§7.9/§7.11.2):
// linking the publication the probe found, and releasing the claim to recovery.
import { CHECK_BACKOFF_MS, deferCheckRecovery, linkCheckPublication } from "../store/review-checks";
import {
  applyPublishedLifecycle,
  claimPublication,
  countRecheckableFindings,
  findPublicationJournal,
  hasUnprovenDegradedPublication,
  PUBLICATION_HANDOFF_PHASES,
  markPublicationFailed,
  recordPublicationProof,
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
  isRecheckStatusReason,
  RECHECK_OUTPUT_PATH,
  RECHECK_STATUS_ERROR_MAX_CHARS,
  validateRecheckDoc,
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
import { boundDiscussion } from "./discussion-context";
import { buildLineIntent, sha256Hex } from "./review-threads";
import { getSandbox, type ReviewSandbox } from "./sandbox";
import type { ShellCommand } from "./shell-command";
import {
  BOUNDED_READ_ABSENT_FLAG,
  buildGitOpsCommands,
  CLONE_DIR,
  compareStatusCommand,
  DIFF_PATH,
  incrementDiffCommand,
  issueViewCommand,
  prBodyCommand,
  readRecheckCommand,
  readRecheckStatusCommand,
  readReportCommand,
  RUNNER_INPUT_PATH,
  RUNNER_PATH,
  runnerCommand,
  writeJsonCommand,
} from "./gitops";
import {
  PR_CONTEXT_MAX_CHARS,
  PR_CONTEXT_MAX_ISSUES,
  REPORT_OUTPUT_PATH,
  validateReportDoc,
  type PrContext,
  type ReportDoc,
} from "../../packages/shared/src/report-wire";
import {
  assertSandboxGrant,
  buildPreparedDegradedBody,
  buildPreparedReviewBody,
  buildPublicationMarker,
  buildRevalidatedSection,
  createReviewCommenter,
  filterLineCommentFindings,
  PreparedSendRejected,
  renderLineCommentText,
  type ClosureRow,
  type CommenterEnv,
  type ReviewCommenter,
  type UpsertPlan,
} from "./comment";
// Per-App credential resolution (lock L4): the consumer is a
// sanctioned reader of the dashboard store leaves (apps-store reads the
// github_apps row, secretbox decrypts the PEM) — the dashboard ↛
// pipeline/worker isolation is one-directional and unaffected.
import { createAppsStore, parseAppReviewLevel } from "../dashboard/apps-store";
import { createSecretbox } from "../dashboard/secretbox";
// The operator default review depth (migration 0047 pairing): read ONLY when
// the App row's `review_level` is NULL, through the same runtime-config leaf
// the admission settings use.
import { getRecheckAssignmentMaxBytes, readDefaultReviewLevel } from "../dashboard/runtime-config-store";
// Per-App AI-config resolution: the same sanctioned reader
// edge — app-config-store reads app_provider_keys / app_model_config and
// decrypts keys via secretbox (itself a zero-dependency leaf, lock L1).
import {
  createAppConfigStore,
  type CustomProviderConsumerConfig,
} from "../dashboard/app-config-store";
import { getSandboxImage, type SandboxImageDefinition } from "../contracts/sandbox-images";
// §7.10 Check seam implementation: `checks.ts` owns the
// adapter AND the lifecycle it drives; this module owns the seam call sites.
import {
  createCheckBeginLatch,
  createCheckLifecycle,
  type CheckBeginLatch,
  type CheckTerminalOutcome,
} from "./checks";
// Review admission (review-concurrency §1.2): one `review_inflight` row is the
// per-PR lock and the capacity reservation; the cap comes from the pipeline's
// single runtime-config reader (never a dashboard route import).
import {
  acquireInflight,
  describeInflightError,
  releaseInflight,
  type InflightKey,
  type InflightRefusal,
} from "../store/inflight-store";
import { readReviewConcurrency, type DegradedReason } from "./concurrency-reader";
import {
  CHECK_TERMINALIZE_DEFAULT,
  CHECK_UPDATE_DEFAULT,
  readCheckBudgets,
  type CheckBudgets,
} from "./check-budgets-reader";

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
   * (assertAppConfigComplete → F-001 channel). The review depth is per App
   * too (`github_apps.review_level`, falling back to the operator default in
   * `review_runtime_settings`) — this env carries no deployment-wide level.
   */
};

/** In-image paths (Dockerfile v2 / smoke — the gitops constants are the SSOT). */
const HARNESS_ROOT = "/opt/mstar-harness";
const OMP_AGENT_DIR = "/opt/omp-agent";

// Per-call exec bounds (ms) — every sandbox exec carries an explicit timeout
// so a hung gh/git/model call fails deterministically instead of silently
// eating a container (qc3 F-001).
/** gh/git steps (clone, rev-parse, diff, numstat, runner-input write) — measured ~2.6s total, 2min each is generous. */
export const EXEC_TIMEOUT_GIT_MS = 120_000;
/**
 * Bound for the bounded reads issued AFTER the paid runner (ms): the recheck
 * document, the recheck status and the report document. They are local file
 * reads — no git-sized window — and they share the round clock with the
 * capture and the runner, so the PR-context gate reserves their worst case.
 */
export const POST_RUNNER_READ_TIMEOUT_MS = 30_000;
/** Post-runner bounded reads per round — the count the gate reserves. */
const POST_RUNNER_READ_COUNT = 3;
/**
 * Worst case the round clock owes those reads (ms): every one may consume its
 * whole `POST_RUNNER_READ_TIMEOUT_MS`. 90_000ms at the current count.
 */
export const POST_RUNNER_READ_BUDGET_MS = POST_RUNNER_READ_COUNT * POST_RUNNER_READ_TIMEOUT_MS;
/**
 * In-image runner budget per review level (ms) — each App resolves its own
 * depth, so one deployment serves several tables at once (spec d5-budget
 * § Trigger): quick/default keep the frozen 10min ceiling (measured ~52s on a
 * real model call); deep gets 14min: Cloudflare Queue consumers cap at 15min
 * wall-clock, so the grill-me 30min budget could never finish in-consumer
 * (force-kill skips finally, retries DLQ — the d5-budget review's qc2/qc3
 * Critical); 14min still covers the three-phase parent-session run without
 * false-timeout into the DLQ. Record<ReviewLevel, …> makes a future level
 * widen fail at compile time, never silently fall back.
 */
const RUNNER_TIMEOUT_MS: Record<ReviewLevel, number> = {
  quick: 600_000,
  default: 600_000,
  deep: 840_000,
};

/**
 * Total deliveries a message gets before the queue DLQs it: wrangler.jsonc's
 * `queues.consumers[].max_retries` is 3, so 1 initial delivery + 3 retries.
 * The FINAL delivery stamps its idempotency key `failed` (processMessage's
 * catch) because that commit was never reviewed.
 *
 * Exported so the coupling is ASSERTED, not just commented:
 * `tests/pipeline/queue-config-contract.test.ts` reads wrangler.jsonc and
 * fails when the two numbers drift.
 */
export const QUEUE_MAX_ATTEMPTS = 4;

/**
 * Runner exec timeout for the job's review level (spec d5-budget L4 — the
 * helper trio runnerTimeoutMs / reviewGuardTtlSeconds /
 * guardRetryDelaysSeconds is the naming SSOT; no bare re-exported constants).
 */
export function runnerTimeoutMs(level: ReviewLevel): number {
  return RUNNER_TIMEOUT_MS[level];
}

/**
 * Inline resolution admission (§7.11.1's thread-lane discipline applied to
 * the fast path, P67-QC-017). The inline lane runs AFTER the paid review in a
 * queue message that already spent most of its wall clock, so it must not
 * fan out unbounded sequential GitHub work: at most this many entries start,
 * each with its own slice of the budget, and everything else stays `pending`
 * for M8 — which owns long convergence with proper backoff.
 */
export const INLINE_RESOLVE_MAX_ENTRIES = 3;
/** Whole inline resolution budget (ms) across every entry of this message. */
export const INLINE_RESOLVE_BUDGET_MS = 12_000;
/** Per-entry slice (ms) — one §7.5 discover + resolve must fit inside it. */
export const INLINE_RESOLVE_ENTRY_MS = 6_000;

/** The named causes of a failed PR-context capture (`ConsumerLogFields.report_context`). */
export type ReportContextFailure = "pr-view" | "pr-view-json" | "issue-view" | "issue-view-json" | "budget";

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
   * `review_level_degraded` (same channel, migration 0047): the operator-default
   * review-level read's degraded warn — a corrupt row falls back to `default`
   * and says so here instead of degrading silently.
   * `review_recheck_assignment_degraded` (same channel): the recheck seat's
   * ask-budget read's degraded warn — a corrupt row falls back to the runner's
   * documented budget and says so here.
   * `review_no_increment` (union widened ADDITIVELY): an incremental round whose
   * `base...head` is genuinely empty — the prior round already covers this head,
   * so the delivery is acked without a new review body.
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
   */
  event: "pull_request" | "issue_comment" | "review_paused" | "review_superseded" | "review_concurrency_degraded" | "review_check_budgets_degraded" | "review_level_degraded" | "review_recheck_assignment_degraded" | "review_no_increment" | "check_terminalize_budget_exceeded" | "check_terminalize_failed" | "check_abandon_released" | "check_abandon_not_owned" | "check_abandon_failed";
  action: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  sandbox_id?: string;
  /** github_apps.id the job resolves to (per-App jobs only). */
  app_id?: string;
  idempotency_key?: string;
  /**
   * review_check_attempts.attempt_id — the Check attempt a line is about, and
   * the only join key a give-up line carries: it names the `review_checks` row
   * that owns the remote run id.
   */
  attempt_id?: string;
  /**
   * Why the consumer stopped waiting on the Check hook (§7.10 give-up) — the
   * free-form detail, distinct from `reason`'s closed admission vocabulary.
   */
  check_reason?: string;
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
  /** Runner wall-clock budget for `level` (ms) — runnerTimeoutMs(level). */
  runner_timeout_ms?: number;
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
   * Increment-round diagnostics: the compare verdict (`ahead` is the only one
   * that starts an increment round) when the round reviewed the full diff, and
   * the base sha on the increment capture-failure line.
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
   * delivered) or `unreadable` (no flag line). Its own field, so a full-diff
   * capture failure and an increment capture failure never read alike.
   */
  increment_capture?: "empty" | "unreadable";
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
  report_doc?: "absent" | "unreadable" | "overflow" | "empty" | "invalid-json" | "invalid-document" | "stale-head";
  report_doc_error?: string;
  report_doc_head_sha?: string;
};

export type ConsumerLog = {
  info: (fields: ConsumerLogFields, msg?: string) => void;
  warn: (fields: ConsumerLogFields, msg?: string) => void;
  error: (fields: ConsumerLogFields, msg?: string) => void;
};

/** Default sink: structured JSON lines on stdout/stderr. No secrets logged. */
export const defaultConsumerLog: ConsumerLog = {
  info: (fields, msg) => console.log(JSON.stringify({ ...fields, msg: msg ?? "" })),
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
  error: (fields, msg) => console.error(JSON.stringify({ ...fields, msg: msg ?? "" })),
};

// ---------------------------------------------------------------------------
// Review admission (WF-002 + review-concurrency §1.2): one review per PR at a
// time, bounded by the system and workspace caps. The KV mutex is gone — the
// `review_inflight` row (src/store/inflight-store.ts) is the lock AND the
// reservation, written before any sandbox starts and released in the finally.
// ---------------------------------------------------------------------------

/**
 * The 120s windows a maximal round can consume, in execution order. Each entry
 * is ONE window, not one command: `readRecheckDoc` issues the document and
 * status reads in a single `Promise.all`, so the pair bills once.
 *
 * This list is the TTL's single source of truth (`reviewGuardTtlSeconds` bills
 * its length) and it is pinned against a real round: consumer.test.ts runs the
 * maximal round and requires exactly this many bounded commands. The four
 * PR-context reads run under the tighter `PR_CONTEXT_EXEC_TIMEOUT_MS` (30s)
 * and the post-runner document/status/report reads under
 * `POST_RUNNER_READ_TIMEOUT_MS` (also 30s), but all still bill at 120s here —
 * a deliberate over-count, so the TTL stays conservative. An uncounted step
 * lets the row expire while a legal review is still posting, so a new one must
 * fail that test until it is added here.
 */
export const GUARD_TIMED_SANDBOX_STEPS: readonly string[] = [
  "clone",
  "rev-parse",
  "compare-status",
  "full-diff",
  "increment-diff",
  "numstat",
  "pr-context-view",
  "pr-context-issue-1",
  "pr-context-issue-2",
  "pr-context-issue-3",
  "runner-input-write",
  "recheck-reads",
  "report-document-read",
];
/** Slack for the untimed steps (token mint, sandbox create, comment post, D1 puts). */
const GUARD_SLACK_MS = 120_000;

/**
 * Admission row TTL (seconds): must exceed the max review wall-clock — every
 * timed sandbox command (`GUARD_TIMED_SANDBOX_STEPS` × 120s), the LEVEL's
 * runner step (runnerTimeoutMs(level) — 600s quick/default, 840s deep), the
 * whole inline-resolution budget (`INLINE_RESOLVE_BUDGET_MS`, which runs
 * last), plus `GUARD_SLACK_MS` — so the row can never expire mid-review and
 * unblock a concurrent duplicate. 2292s quick/default, 2532s deep. Pinned
 * exactly by consumer.test.ts — the per-level arithmetic AND a maximal round's
 * command count — so a future step addition re-breaks loudly.
 */
export function reviewGuardTtlSeconds(level: ReviewLevel): number {
  return Math.ceil(
    (runnerTimeoutMs(level) +
      GUARD_TIMED_SANDBOX_STEPS.length * EXEC_TIMEOUT_GIT_MS +
      INLINE_RESOLVE_BUDGET_MS +
      GUARD_SLACK_MS) /
      1000,
  );
}

/**
 * Wall-clock budget of ONE round, measured from the top of `processMessage`:
 * Cloudflare caps a Queue consumer invocation at 15 minutes
 * (knowledge: best-practices/cf-queue-consumer-wall-clock), and that cap — not
 * the admission TTL, which only bounds how long the row may be held — is the
 * clock a best-effort step must fit inside. The paid runner owns its own
 * `runnerTimeoutMs(level)` out of the same window.
 *
 * Deepest tier (`deep`), worst case at the documented budgets:
 *   runnerTimeoutMs("deep")      840_000
 *   CHECK_HOOK_TIMEOUT_MS          2_000  (begin hook, before the model work)
 *   CHECK_TERMINALIZE_DEFAULT     10_000  (terminalize hook, every terminal path)
 *                               ---------
 *                                852_000  → 48_000 of the 900_000 window left.
 *
 * That sum covers ONLY the paid runner and the two Check hooks. The steps that
 * share the window around them are NOT in it: admission/claim, container
 * create + token mint + clone + rev-parse, the dedup/journal reads, diff
 * capture, recheck reads, PR context capture (always skipped at `deep`), and
 * the runner input write before the run; then the bounded report/recheck
 * reads, inline resolution (`INLINE_RESOLVE_BUDGET_MS`), the comment publish
 * and the D1 puts after it. Those spend the 48_000 margin, so the sum must
 * stay below the cap for every step to fit.
 *
 * The terminalize term is the default: an operator may configure it up to
 * 30_000 (`CHECK_TERMINALIZE_MAX`), which leaves 28_000. Pinned by
 * consumer.test.ts (round-budget case) — any change to a term, the cap or the
 * margin re-derives that pin.
 */
export const ROUND_BUDGET_MS = 900_000;

/**
 * Guard-held backoff schedule (seconds), indexed by message.attempts (1-based
 * — the first delivery is attempt 1). quick/default: 60s → 300s → 2040s; deep: 90s → 480s → 2040s.
 *
 * The schedule must COVER the level's guard TTL, and its last entry must be
 * able to reclaim it: every entry stays BELOW the level's guard TTL
 * (2292s / 2532s) so no single delay outlives the lock, while the CUMULATIVE
 * sum (2400s / 2610s) EXCEEDS it — so by the final delayed attempt the
 * in-flight row has expired and the admission's expired-reclaim branch lets
 * this message take the lock instead of being dropped. Without that sum, a
 * legal review (600s+ runner) could hold the PR past the whole backoff and a
 * `synchronize` for a NEW commit would never be reviewed.
 *
 * Attempts past the schedule's end have consumed the queue's max_retries and
 * must be acked, not retried (a further retry() would land the job on the
 * DLQ).
 */
const GUARD_RETRY_DELAYS_SECONDS: Record<ReviewLevel, readonly [number, number, number]> = {
  quick: [60, 300, 2040],
  default: [60, 300, 2040],
  deep: [90, 480, 2040],
};

/** Guard-held backoff schedule for the job's review level (spec d5-budget L4). */
export function guardRetryDelaysSeconds(level: ReviewLevel): readonly number[] {
  return GUARD_RETRY_DELAYS_SECONDS[level];
}

/**
 * Outcome of one message pass (bugbot BB-3 + architect lock L4 + AL-1).
 * FOUR DISTINCT typed outcomes never throw: a guard-held message
 * is scheduled for a per-message delayed retry and finally acked with a
 * warning — it is never rethrown into the immediate-retry ×3 → DLQ path; a
 * PAUSED message (the App's review_enabled=0) is acked directly after its
 * payload sha's claim is stamped `paused` — no review, no sandbox, never a
 * retry or a DLQ entry (a throw would be the wrong semantics for an operator
 * pause); a DEGRADED message (parse-fail) is acked directly after its
 * best-effort review_failures row + degraded comment and a `degraded` claim
 * stamp — a deterministic model-output failure where retry is deterministic
 * waste; a SUPERSEDED message is acked
 * directly because the ledger already holds a newer commit for its PR.
 * Infra failures keep the
 * existing throw → retry → DLQ behavior (plus the AL-6 best-effort failure
 * row before the rethrow).
 */
export type ProcessOutcome =
  | { kind: "ok" }
  /**
   * `heldHeadSha` is the commit the live row was taken for (`null` when the
   * refusal was a cap/storage one, so no row holds this PR): the terminal ack
   * records the drop unless the live review covers this message's own sha.
   */
  | {
      kind: "guard-held";
      admission: AdmissionRefusalFields;
      heldHeadSha: string | null;
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
   * migration 0044): this delivery is acked directly before any config read,
   * admission row or container — no retry, no DLQ, no failure row. The next
   * delivery for the PR reviews the newest commit.
   */
  | { kind: "superseded" };

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
 * Handle a guard-held message (bugbot BB-3). The guard is not an error
 * state: instead of throwing (which burns the queue's three immediate
 * retries and DLQs the job — including later synchronize events for the same
 * PR — while the first review is still running), schedule a per-message
 * DELAYED retry via `message.retry({ delaySeconds })`. After the final
 * delayed attempt, ack with a warning: the job is dropped cleanly and the
 * next event for the PR (e.g. a later synchronize) re-reviews. Structured
 * log fields carry the PR identity + attempt count + the admission refusal
 * (`reason` and both caps — spec §1.3: a held line must say which bound held
 * it); the idempotency key is not yet derivable at guard time (it comes from
 * the checked-out sha).
 *
 * `heldHeadSha` is the live row's sha: a `pr-held` drop is only benign while
 * that review covers THIS message's commit. The cumulative backoff
 * (2400s quick/default, 2610s deep) now EXCEEDS the level's guard TTL
 * (2292s / 2532s), so the final delayed attempt can reclaim the expired row
 * and review the new commit. A drop that still happens — a cap/storage
 * refusal, or a row that outlived the schedule — must leave a trace, so the
 * terminal ack records the drop row for a commit the live review never
 * covers, and stamps that commit's idempotency claim `dropped` so both the
 * supersede skip and the worker's pre-check stop treating the abandoned job
 * as proof: a redelivery for that commit enqueues again.
 */
async function handleGuardHeld(
  message: Message<ReviewJobPayload>,
  deps: ProcessDeps,
  admission: AdmissionRefusalFields,
  heldHeadSha: string | null,
  level: ReviewLevel,
): Promise<void> {
  const fields = { ...toBaseFields(message.body), ...admission };
  // Why this message was held, appended to both lines: the delay schedule alone
  // never says whether the PR, the tenant, or the deployment is full. A storage
  // refusal adds its own cause — "error" alone cannot tell a dead D1 binding
  // from a capacity released between the admission's two statements.
  const cause = admission.error_cause === undefined ? "" : `; cause ${admission.error_cause}`;
  const heldBecause = `held by ${admission.reason} (system_cap ${admission.system_cap}, workspace_cap ${admission.workspace_cap}${cause})`;
  // Only a `pr-held` refusal means a review for THIS PR is running; a cap or
  // storage refusal means none exists at all — saying "still in flight" there
  // would send an operator looking for a review that was never started.
  const what = admission.reason === "pr-held" ? "review already in flight" : "review not admitted";
  // The App's resolved depth rides the outcome: processMessage resolved it from
  // the App row BEFORE the guard, so this retry path reads no storage at all.
  const delays = guardRetryDelaysSeconds(level);
  const delaySeconds = delays[message.attempts - 1];
  if (delaySeconds !== undefined) {
    deps.log.info(
      fields,
      `${what} — scheduling delayed retry in ${delaySeconds}s (attempt ${message.attempts}; ${heldBecause})`,
    );
    message.retry({ delaySeconds });
    return;
  }
  deps.log.warn(
    fields,
    `${what} after ${delays.length} delayed retries (attempt ${message.attempts}; ${heldBecause}) — acking, no DLQ (guard-held is not an error; the next event for the PR re-reviews)`,
  );
  message.ack();
  // A cap/storage refusal that survived the whole backoff leaves the review
  // DROPPED with no other D1 trace: no attempt for this PR ever reached the
  // runner, so neither `reviews` nor the failure sweep (which counts
  // `review_failures`) would see it. Record one row here — the terminal drop
  // is the failure event, not each refused attempt. Best-effort: a warn only.
  //
  // `pr-held` is silent only while the live review covers THIS commit: a
  // duplicate of the same sha is normal traffic, and an unresolved identity on
  // either side proves nothing — a null payload sha (comment trigger) and a
  // held row's `""` (that same convention, persisted) both mean "no commit
  // identity recorded", NOT "a different commit". Only two non-empty shas that
  // differ name a commit the live review will never cover, so only that takes
  // the drop-record branch below.
  const payloadSha = message.body.head_sha;
  const heldSha = heldHeadSha ?? "";
  if (
    admission.reason === "pr-held" &&
    (payloadSha === null || payloadSha === "" || heldSha === "" || payloadSha === heldSha)
  ) {
    return;
  }
  // Convention for a job that never resolved a sha (comment trigger —
  // `head_sha` is null in the payload): the row's `head_sha` is `""` (the
  // 0010 column allows it; only `reviews` forbids it), and the PR identity
  // stays in the error text so the row is joinable back to the PR — a bare
  // `""` row tells an operator nothing about which PR was dropped.
  const headSha = payloadSha ?? "";
  // The newer commit's enqueue claim is the supersede skip's ONLY proof, so a
  // job dropped here for good must stop being proof: overwrite its key with
  // "dropped" (the same TTL the worker claim used), the value both readers
  // treat as "not reviewed". `putAbandonClaim` never downgrades `done` — a sha
  // this consumer already reviewed stays proof, or the redelivery would
  // re-review a reviewed commit. Best-effort — a KV fault only leaves a stale
  // "1", which the skip then accepts and `review_failures` traces (the drop
  // row below).
  if (headSha !== "") {
    const claimKey = idemKey({
      installation_id: message.body.installation_id,
      owner: message.body.owner,
      repo: message.body.repo,
      pr_number: message.body.pr_number,
      head_sha: headSha,
    });
    try {
      await putAbandonClaim(deps.env.IDEMPOTENCY_KV, claimKey, IDEM_DROPPED, IDEMPOTENCY_SECONDS);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `dropped-claim KV update failed (the skip may still treat this commit as queued): ${detail}`);
    }
  }
  const identity = `${message.body.owner}/${message.body.repo}#${message.body.pr_number}`;
  // A shifted-sha drop names the sha the live review holds, so an operator can
  // see which commit was skipped rather than guessing from the refusal code.
  // Reaching here on `pr-held` means both shas are non-empty and differ.
  const heldNote =
    admission.reason === "pr-held"
      ? ` — the in-flight review holds head_sha ${heldSha}, so this commit was never reviewed`
      : "";
  return deps.failureStore
    .record({
      installation_id: message.body.installation_id,
      owner: message.body.owner,
      repo: message.body.repo,
      pr_number: message.body.pr_number,
      head_sha: headSha,
      stage: "pipeline",
      error: `review dropped after ${delays.length} refused retries: ${admission.reason} (system_cap ${admission.system_cap}, workspace_cap ${admission.workspace_cap}${cause}) — PR ${identity}, head_sha ${
        headSha === "" ? "unresolved (comment trigger, no sha in payload)" : headSha
      }${heldNote}`,
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `review_failures insert failed (drop trace lost): ${detail}`);
    });
}

// ---------------------------------------------------------------------------
// Check lifecycle seam (spec review-lifecycle §7.7 steps 4/12 +
// §7.10) — §7.10-owned types so M8 ships and works before the
// implementation: an ABSENT `checks` dependency produces NO Checks while M8
// remains fully operational. Declared with §7.7 types only (Scope, Lease) —
// never a §7.9 type. checks.ts supplies the implementation
// (`createCheckLifecycle`) and `createReviewConsumer` injects it; the dependency stays
// optional, and a hooks object that cannot reach a Checks surface still
// produces no row and no remote run. Hook exceptions/timeouts are caught by
// the consumer (the begin hook gets ≤2 requests / 2 seconds of consumer wait;
// the terminalize hook runs after the review reaches a terminal outcome — a
// pre-publication failure included — and may wait ≤10 seconds, with
// its promise handed to the invocation context — no publication path waits for
// hook retries).
// ---------------------------------------------------------------------------

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
  terminalize(input: { handle: CheckHandle; publicationId: string | null;
    outcome: CheckTerminalOutcome;
    /**
     * The reviewed head an EMPTY increment inherits: the Check carries that
     * head's result against the current gate instead of a free-standing
     * `neutral`; an unreadable baseline fails closed. Omitted → nothing to
     * inherit.
     */
    inheritedHeadSha?: string;
    /** The operator-configured bound on the terminal `checks.update` (spec §7.10). */
    updateBudgetMs: number }): Promise<void>;
  /**
   * §7.10 give-up handoff (optional, additive): the consumer stopped waiting
   * on `terminalize` — its budget elapsed, the hook threw, or the checkout
   * contradicted the claim. The lifecycle freezes a terminal intent ONLY when
   * none is frozen (the predicate is in the UPDATE, so a concurrent
   * terminalize's text wins) and releases the lease to recovery WITHOUT a
   * remote request, so the minute reconciler closes the run instead of waiting
   * out the execution deadline. Resolves `true` only when the fenced release
   * changed the row — a lease recovery already claimed, or an expired lease,
   * changed nothing and resolves `false`; a store fault rejects.
   */
  abandonTerminalize?(input: { handle: CheckHandle; reason: string; outcome?: "superseded" }): Promise<boolean>;
};

/**
 * Check execution window (spec §7.9): claim time + 900,000ms — the Cloudflare
 * Queues per-invocation wall-clock cap (15 minutes, the same cap the deep tier
 * is pinned under in `wrangler.jsonc`). It is therefore a PLATFORM INVARIANT,
 * not a tuning knob: a longer deadline can never be used by the consumer and
 * only delays the recovery lane that finally closes the run. The claim now
 * happens near the START of that window (at admission, before the container
 * and the clone) instead of after `rev-parse`, so the window covers the
 * container phase without being widened.
 */
export const CHECK_EXECUTION_WINDOW_MS = 900_000;

/**
 * Begin-hook budget (spec §7.10: "The begin hook has ≤2 requests / 2 seconds
 * of consumer wait"). Exported because it is the containment bound the Check
 * lifecycle must honour, and the two hook-timeout cases pin it by value. It
 * rides the same round window as the runner — the deep worst-case sum is
 * documented on `ROUND_BUDGET_MS`.
 */
export const CHECK_HOOK_TIMEOUT_MS = 2_000;

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
 * §7.7 step 2 journal check: an existing non-terminal publication row for
 * this exact scope/SHA (prepared/sending/unknown/confirmed) hands off to
 * recovery and ACKs — never a second paid review for the same head.
 * Terminal rows (applied/failed/superseded) do not hand off: the D1
 * idempotency check above already covered applied rows, and failed/superseded
 * heads are legitimately re-reviewable on a new trigger.
 */
async function journalHandoffRow(
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
       WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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
 * Bounded read + validation + redaction of the report seat's document: the
 * audited fixed-path read (`readReportCommand`) yields `<content>\n<flag>`;
 * anything other than a flag-0 document that passes `validateReportDoc` and is
 * bound to `expectedHeadSha` is NO report (the sections render `none`) and
 * leaves ONE warn naming which cause rejected it — a document the read PROVED
 * missing (`absent`) and a read that broke (`unreadable`) are separate names,
 * though both render `none`. Each narrative field is redacted before it can
 * reach a public body — the seat's text is model output like any other, and a
 * prompt-injected credential can hide in a PR description it quoted.
 */
async function readReportDoc(
  sandbox: ReviewSandbox,
  secretValues: string[],
  expectedHeadSha: string,
  log: ConsumerLog,
  fields: ConsumerLogFields,
): Promise<ReportDoc | null> {
  const read = await boundedRead(sandbox, readReportCommand(), POST_RUNNER_READ_TIMEOUT_MS, true);
  if (read.failure !== null) {
    // `absent` and `unreadable` are distinct failures of the SAME disclosure:
    // the seat wrote no document vs. the read of it broke. Both render `none`.
    log.warn(
      { ...fields, report_doc: read.failure },
      `report document ${read.failure} — sections render none`,
    );
    return null;
  }
  if (read.text === null || read.text.trim() === "") {
    log.warn({ ...fields, report_doc: "empty" }, "report document empty — sections render none");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    // No parse-error detail: `JSON.parse` quotes the input, and the input is
    // seat-authored text that may carry a credential-shaped value.
    log.warn({ ...fields, report_doc: "invalid-json" }, "report document is not JSON — sections render none");
    return null;
  }
  const redact = (text: string) => redactExactSecrets(redactSecrets(text), secretValues);
  const gate = validateReportDoc(parsed);
  if (!gate.ok) {
    // The shared gate names only the accepted shape, never the seat's own
    // key/value text; the same shape + exact-value redaction every other log
    // field gets is applied here too.
    const error = redact(gate.error);
    log.warn(
      { ...fields, report_doc: "invalid-document", report_doc_error: error },
      `report document failed its gate — sections render none: ${error}`,
    );
    return null;
  }
  // The fixed path is shared with every earlier run in this container: a
  // document bound to another head is that run's narrative, not this one's. A
  // missing/invalid head never reaches here — the gate rejects it first.
  if (gate.doc.headSha !== expectedHeadSha) {
    log.warn(
      {
        ...fields,
        report_doc: "stale-head",
        report_doc_head_sha: gate.doc.headSha,
      },
      `report document is bound to head ${gate.doc.headSha}, not the reviewed head ${expectedHeadSha} — sections render none`,
    );
    return null;
  }
  return {
    schema: "mstar.report/v1",
    headSha: gate.doc.headSha,
    overview: redact(gate.doc.overview),
    linkedIssueAc: redact(gate.doc.linkedIssueAc),
    verified: redact(gate.doc.verified),
    rejected: redact(gate.doc.rejected),
    planToFix: redact(gate.doc.planToFix),
  };
}

/**
 * The most recent REVIEWED head of this PR, BY THIS APP, whose review was not
 * an `incomplete` (stopped) run and whose own capture did not fail — the base
 * an incremental round diffs against. Both exclusions are on purpose: a stopped
 * round never scanned its scope, and a round whose diff capture failed
 * published a verdict without evidence. Diffing against either would silently
 * inherit that gap.
 *
 * `app_id` is part of the identity: two Apps can review one installation's PRs,
 * and `reviews` is keyed per (installation, owner, repo, pr) without it, so an
 * unfiltered read could hand App B the head App A reviewed and skip exactly the
 * commits B never saw. Legacy rows (`app_id` NULL) predate per-App attribution
 * and belong to the retired global App, so no current App can match them.
 *
 * One row per reviewed sha, and `reviewed_at` is second-resolution, so `rowid`
 * breaks same-second ties in insertion order.
 */
async function findIncrementBase(db: PipelineEnv["DB"], scope: Scope): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT head_sha FROM reviews
       WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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
 * `EXEC_TIMEOUT_GIT_MS` because the capture is best-effort narrative: its
 * worst case must fit inside the round NEXT TO the level's runner budget.
 *
 * Round arithmetic (`ROUND_BUDGET_MS` = 900_000ms):
 *   capture worst case (1 + PR_CONTEXT_MAX_ISSUES) × 30_000 = 120_000ms
 *   quick/default runner                                     = 600_000ms
 *   post-runner bounded reads (3 × POST_RUNNER_READ_TIMEOUT_MS) =  90_000ms
 *   gate needs 810_000ms → funded at round start with 90_000ms to spare.
 * A deep round needs 840_000 + 120_000 + 90_000 = 1_050_000ms, more than the
 * 900_000ms window, so deep rounds always skip the capture — narrative never
 * trades away a deep run's window. Changing any term re-derives the gate.
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
 * Bounded by the ROUND's clock: the capture runs before the paid run and each
 * gh read can consume its whole `PR_CONTEXT_EXEC_TIMEOUT_MS`, so a slow
 * sandbox could spend the round's window on a narrative. The gate therefore
 * requires the remainder to cover the worst-case capture, the level's runner
 * budget AND the post-runner bounded reads that share this round's clock —
 * the reads must still fit after the capture and the run — and only then
 * does the remaining time bound how many issue reads start, so the review
 * itself never carries the cost.
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
  level: ReviewLevel,
  roundDeadlineMs: number,
): Promise<PrContext | undefined> {
  const exec = { env: { GH_TOKEN: token }, timeout: PR_CONTEXT_EXEC_TIMEOUT_MS };
  const warn = (cause: ReportContextFailure, issue?: number): void => {
    log.warn(
      { ...fields, report_context: cause, ...(issue === undefined ? {} : { report_context_issue: issue }) },
      `report context ${cause}${issue === undefined ? "" : ` (issue #${issue})`} — report sections degrade to none`,
    );
  };
  const remainingMs = roundDeadlineMs - Date.now();
  // The capture is spent BEFORE the paid run, so its bound must leave the
  // level's own exec budget intact: a capture that fits but eats the runner's
  // window turns a review into a timeout. The post-runner bounded reads share
  // that same clock, so their worst case is reserved too — a capture that
  // consumed the whole remainder would starve them.
  const captureBudgetMs =
    PR_CONTEXT_WORST_CASE_MS + runnerTimeoutMs(level) + POST_RUNNER_READ_BUDGET_MS;
  if (remainingMs < captureBudgetMs) {
    log.warn(
      { ...fields, report_context: "budget" },
      `report context budget — ${remainingMs}ms left of the round, the capture costs up to ${PR_CONTEXT_WORST_CASE_MS}ms, the run still needs its ${runnerTimeoutMs(level)}ms and the post-runner reads ${POST_RUNNER_READ_BUDGET_MS}ms — skipped, report sections degrade to none`,
    );
    return undefined;
  }
  const prRead = await sandbox
    .runCommand(prBodyCommand(payload.owner, payload.repo, payload.pr_number), exec)
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
  // how many issue reads start: never more than the round can still fund.
  // The runner's own window is already reserved by the gate above.
  const maxIssueReads = Math.min(
    PR_CONTEXT_MAX_ISSUES,
    Math.floor((roundDeadlineMs - Date.now()) / PR_CONTEXT_EXEC_TIMEOUT_MS),
  );
  for (const issueNumber of extractIssueRefs(prBody).slice(0, Math.max(0, maxIssueReads))) {
    const issueRead = await sandbox
      .runCommand(issueViewCommand(payload.owner, payload.repo, issueNumber), exec)
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
 * Payload text of one bounded read, plus WHY it yielded nothing. A missing
 * flag line or overflow beyond the byte bound are both "no payload" to the
 * caller, but they are different D1 causes, so the failure is named rather
 * than collapsed into a bare null. Shared by the recheck document and status
 * reads and the diff capture — the transport is identical, only the producer
 * differs.
 */
type BoundedRead = { text: string | null; failure: "overflow" | "unreadable" | null };

/**
 * The report read's own result: the same transport, plus `absent` — the
 * command itself proved the path is not there. ONLY a read whose command
 * probes for the file may report it (see `readReportCommand`); every other
 * producer never emits that flag, so their reads cannot report it and keep
 * their meanings.
 */
type ReportBoundedRead = { text: string | null; failure: "overflow" | "unreadable" | "absent" | null };

function parseBoundedRead(stdout: string): BoundedRead;
function parseBoundedRead(stdout: string, provesAbsence: true): ReportBoundedRead;
function parseBoundedRead(stdout: string, provesAbsence = false): ReportBoundedRead {
  const out = stdout.trimEnd();
  const split = out.lastIndexOf("\n");
  if (split < 0) return { text: null, failure: "unreadable" };
  const flag = out.slice(split + 1).trim();
  // Absence is claimed only where the command PROVED it; for every other read
  // a stray `2` keeps its old meaning (over the byte bound).
  if (provesAbsence && flag === BOUNDED_READ_ABSENT_FLAG) return { text: null, failure: "absent" };
  if (flag !== "0") return { text: null, failure: "overflow" }; // beyond the byte bound
  return { text: out.slice(0, split), failure: null };
}

async function boundedRead(
  sandbox: ReviewSandbox,
  command: ShellCommand,
  timeoutMs: number,
): Promise<BoundedRead>;
async function boundedRead(
  sandbox: ReviewSandbox,
  command: ShellCommand,
  timeoutMs: number,
  provesAbsence: true,
): Promise<ReportBoundedRead>;
async function boundedRead(
  sandbox: ReviewSandbox,
  command: ShellCommand,
  timeoutMs: number,
  provesAbsence = false,
): Promise<ReportBoundedRead> {
  let read;
  try {
    read = await sandbox.runCommand(command, { timeout: timeoutMs });
  } catch {
    return { text: null, failure: "unreadable" };
  }
  if (read.exitCode !== 0) return { text: null, failure: "unreadable" };
  return provesAbsence ? parseBoundedRead(read.stdout, true) : parseBoundedRead(read.stdout);
}

/**
 * A seat-authored `reason`/`error` bounded for the D1 failure text and the log
 * field. Redaction runs FIRST: slicing first would cut a secret that straddles
 * the cap and persist its surviving fragment. `null` for a non-string field.
 */
function boundedStatusText(value: unknown): string | null {
  return typeof value === "string"
    ? redactSecrets(value).slice(0, RECHECK_STATUS_ERROR_MAX_CHARS)
    : null;
}

/**
 * The seat's recheck status document (`RecheckStatus`), or null when the file
 * is absent/unreadable or carries a foreign schema or HEAD. Anything but this
 * round's own status for this HEAD is no attribution at all — never a
 * fabricated outcome.
 */
function parseRecheckStatus(text: string | null, headSha: string): RecheckStatus | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    if (value["schema"] !== "mstar.recheck-status/v1" || value["headSha"] !== headSha) return null;
    const outcome = value["outcome"];
    if (outcome !== "ok" && outcome !== "skipped" && outcome !== "failed") return null;
    // `rejected` is DERIVED from the row-id list, never read from the document:
    // one source survives, so the two faces of the count cannot disagree in a
    // foreign or hand-rolled status. `rejected_unnamed` has no list to derive
    // from — it is the count of drops the gate could not name, and it is the
    // only record of them once the seat has filtered its own document.
    const rejectedRowIds = Array.isArray(value["rejected_row_ids"])
      ? value["rejected_row_ids"].filter((id): id is string => typeof id === "string")
      : [];
    const rejectedUnnamed = value["rejected_unnamed"];
    return {
      schema: "mstar.recheck-status/v1",
      headSha,
      outcome,
      rejected: rejectedRowIds.length,
      rejected_row_ids: rejectedRowIds,
      rejected_unnamed:
        typeof rejectedUnnamed === "number" && Number.isInteger(rejectedUnnamed) && rejectedUnnamed >= 0
          ? rejectedUnnamed
          : 0,
      // `reason` is a CLOSED vocabulary: the per-row accounting below branches
      // on these exact literals, so an off-vocabulary value would fall through
      // to the wrong verdict instead of being ignored. Unrecognized → null
      // (same as absent), never a guessed reason.
      reason: isRecheckStatusReason(value["reason"]) ? value["reason"] : null,
      error: boundedStatusText(value["error"]),
    };
  } catch {
    return null;
  }
}

/**
 * Bounded read + validation of the runner's recheck output:
 * the audited fixed-path command (`src/pipeline/gitops.ts`
 * `readRecheckCommand`) emits `<content>\n<overflow-flag>` where the flag is
 * `wc -c`'s own output, i.e. NEWLINE-TERMINATED (`…\n0\n` / `…\n1\n`). The
 * flag is therefore read off the last non-empty line after the trailing
 * newline(s) are dropped — a transport that preserves or trims that final
 * newline parses identically. Flag `0` = within the byte bound. Anything else
 * (non-zero exit, overflow, malformed JSON, failed validation) is NO recheck:
 * the round proceeds with every selected row conservatively omitted, never a
 * fabricated document.
 *
 * The SAME transport reads the seat's status document, which is what makes a
 * round that produced no usable document attributable in D1 without container
 * stderr. Rows `validateRecheckDoc` dropped come back as `rejected` so the
 * reconciliation can name them `invalid-output` instead of `omitted` — but the
 * written document is ALREADY filtered by the seat, so a second validation
 * pass sees no drops; the status's `rejected_row_ids` is the only surviving
 * record of them and is therefore the primary source. It is trusted only for
 * the row IDs this round actually sent. A drop that carried no usable rowId
 * cannot be named: the status's `rejected_unnamed` count is the record of it,
 * and the reconciliation attributes those drops by position among the
 * sent-but-unanswered rows (see `reconcileRecheckRound`). The two sources are
 * unioned by taking the larger count, since the seat filters its document
 * before writing it.
 */
async function readRecheckDoc(
  sandbox: ReviewSandbox,
  recheckInput: RecheckInput,
): Promise<{
  doc: RecheckDoc | null;
  /** Why `doc` is null (absent read / overflow / validation), null when it survived. */
  docFailure: string | null;
  rejected: ReadonlySet<string>;
  anonymousRejectedRows: number;
  status: RecheckStatus | null;
}> {
  const [docRead, statusRead] = await Promise.all([
    boundedRead(sandbox, readRecheckCommand(RECHECK_OUTPUT_PATH), POST_RUNNER_READ_TIMEOUT_MS),
    boundedRead(sandbox, readRecheckStatusCommand(), POST_RUNNER_READ_TIMEOUT_MS),
  ]);
  let doc: RecheckDoc | null = null;
  // A zero-byte payload is the seat writing nothing: absent, not malformed.
  // Parsing it would throw and report the round as a JSON fault instead.
  const docText = docRead.text !== null && docRead.text.trim() !== "" ? docRead.text : null;
  let docFailure: string | null =
    docRead.failure ?? (docRead.text !== null && docText === null ? "absent" : null);
  const droppedRowIds = new Set<string>();
  let anonymousRejectedRows = 0;
  if (docText !== null) {
    try {
      const gate = validateRecheckDoc(JSON.parse(docText), recheckInput);
      if (gate.ok) {
        doc = gate.doc;
        docFailure = null;
        for (const row of gate.rejected) {
          if (row.rowId === null) anonymousRejectedRows += 1;
          else droppedRowIds.add(row.rowId);
        }
      } else {
        docFailure = `invalid-document: ${gate.error}`;
      }
    } catch {
      docFailure = "invalid-document: not JSON";
    }
  }
  const status = parseRecheckStatus(statusRead.text, recheckInput.headSha);
  const sent = new Set(recheckInput.targets.map((target) => target.rowId));
  const rejected = new Set(droppedRowIds);
  // A row the surviving document CARRIES has a real answer, so a status that
  // also names it (the seat drops, then re-emits it) must not cost it that
  // answer: `rejected` outranks the answered row in the reconciliation, and a
  // row listed in both would report `invalid-output` instead of its actual
  // assessment. Local gate drops need no such filter — a dropped row is by
  // construction absent from `doc.results`.
  const answeredRowIds = new Set((doc?.results ?? []).map((row) => row.rowId));
  for (const rowId of status?.rejected_row_ids ?? []) {
    if (sent.has(rowId) && !answeredRowIds.has(rowId)) rejected.add(rowId);
  }
  // The seat writes an ALREADY-FILTERED document, so the local pass above
  // normally sees no drops at all; the status is the surviving record. Taking
  // the larger of the two unions them without double-counting a round whose
  // unfiltered document also reached this pass.
  const unnamedRejectedRows = Math.max(anonymousRejectedRows, status?.rejected_unnamed ?? 0);
  return { doc, docFailure, rejected, anonymousRejectedRows: unnamedRejectedRows, status };
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
 * Publish the parse-degrade notice through the §7.7 journal (plan: stage →
 * claim → send the EXACT prepared body → proof → applied mark). The
 * degraded payload has `artifact: null`, `lifecycle: null`, empty line
 * intents and the bounded final degraded body — no normal review or
 * lifecycle rows are ever created from it. NEVER throws: every failure is a
 * typed outcome (the caller acks regardless — a parse fail is a
 * deterministic model-output failure where retry is waste).
 */
async function publishDegradedPublication(input: {
  db: PipelineEnv["DB"];
  commenter: ReviewCommenter;
  scope: Scope;
  headSha: string;
  redactedError: string;
  redactedStdout: string;
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
      });
    } catch (err) {
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
    return { phase: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

type ProcessDeps = {
  env: PipelineEnv;
  store: D1ArtifactStore;
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
   * The PR head watermark read (migration 0044) — `createAppsStore(env.DB)
   * .selectPrHead` in production, built ONCE per consumer (and injectable in
   * tests), never per message. The supersede decision needs one point read per
   * stamped delivery, so rebuilding the store for it would be pure overhead.
   */
  selectPrHead: (input: {
    appId: string;
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
   * The round's wall-clock budget (ms), measured from the top of
   * `processMessage`. Production is `ROUND_BUDGET_MS` (the queue consumer cap);
   * the seam exists so a test can shrink the round to a budget where a step
   * must be skipped instead of waiting for real time to pass.
   */
  roundBudgetMs: number;
};

/**
 * The job's PR identity, derivable WITHOUT appRef — the AL-24-4 in-flight
 * legacy message (absent appRef) throws in toBaseFields, but the structured
 * failure channel still carries these (only app_id needed the deref, and
 * ConsumerLogFields requires the base identity).
 */
function payloadIdentityFields(payload: ReviewJobPayload): ConsumerLogFields {
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
function toBaseFields(payload: ReviewJobPayload): ConsumerLogFields {
  return {
    ...payloadIdentityFields(payload),
    // Every job carries the appId reference in every structured log line
    // (an id, never a credential — lock L4; appRef is required).
    app_id: payload.appRef.appId,
  };
}

/**
 * Outcome of the per-message commenter resolution (architect lock
 * L4): `ok` carries the commenter the review runs with PLUS the row's
 * numeric `github_app_id` (the §7.10 Check seam's App identity — the row is
 * already read here, no second query); `paused` is the
 * DISTINCT typed outcome for a paused App (review_enabled=0) — returned
 * AFTER the status/deleted gates (disabled is judged first and keeps its
 * byte-identical throw→retry→DLQ semantics) and consumed by processMessage
 * as an immediate ack-skip. NOT a throw: a throw would enter the
 * retry→DLQ path — the wrong semantics for an intentional pause.
 */
type CommenterResolution =
  | {
      kind: "ok";
      commenter: ReviewCommenter;
      githubAppId: number;
      workspaceId: string;
      /**
       * The App row's RAW `review_level` (migration 0047) — `null` = follow the
       * operator default. Read through `parseAppReviewLevel`; carrying it here
       * keeps the depth on the same per-message row read (never a second query).
       */
      reviewLevel: string | null;
    }
  | { kind: "paused" };

/**
 * Resolve the commenter for one message (architect lock L4
 * — consumer-side credential resolution; single path —
 * `appRef.appId` is required, the env-App legacy branch is retired):
 *
 * The `github_apps` row via D1 (re-read per message),
 * gated in order: missing row / soft-deleted / disabled THROWS
 * (unchanged retry→DLQ semantics; the failed gate EVICTS the cached
 * instance) → PAUSED (`review_enabled = 0`, lock L4) returns the
 * DISTINCT `paused` outcome AFTER those gates, leaving any cached
 * instance in place (resume reuses the warm instance — the credential
 * fingerprint ignores review_enabled) → the row's PEM decrypted in memory
 * (secretbox, AAD `github_apps.private_key_enc:<id>`) →
 * `createAppCommenter({ APP_ID: String(github_app_id), PRIVATE_KEY })`,
 * cached per appId in `deps.appCommenters` with the row's credential
 * fingerprint (architect lock L1: `github_app_id` + `private_key_enc` envelope
 * exact-string match — reuse on match, rebuild + replace on rotation).
 *
 * Any unresolvable state — missing row, disabled, soft-deleted, missing
 * DASHBOARD_ENCRYPTION_KEY (SecretboxKeyError), tampered envelope — THROWS:
 * the structured error log + rethrow keep the existing retry/DLQ semantics
 * and no GitHub write ever happens. The decrypted PEM lives only in this
 * call's memory and the commenter instance; it is never logged.
 */
async function resolveCommenter(payload: ReviewJobPayload, deps: ProcessDeps): Promise<CommenterResolution> {
  const appRef = payload.appRef;
  const row = await createAppsStore(deps.env.DB).getAppById(appRef.appId);
  if (row === null) {
    deps.appCommenters.delete(appRef.appId);
    // Two resolutions are indistinguishable from a missing one (the INNER
    // JOINs yield null for all three): no `app_workspaces` mapping and a
    // soft-deleted workspace — the message names every cause.
    throw new Error(
      `per-App credential resolution failed: app ${appRef.appId} not found, has no workspace mapping, or its workspace is deleted`,
    );
  }
  if (row.deleted_at !== null) {
    deps.appCommenters.delete(appRef.appId);
    throw new Error(`per-App credential resolution failed: app ${appRef.appId} is soft-deleted`);
  }
  if (row.status !== "active") {
    deps.appCommenters.delete(appRef.appId);
    throw new Error(`per-App credential resolution failed: app ${appRef.appId} is ${row.status}`);
  }
  // Architect lock L4: the PAUSED gate sits AFTER the status/
  // deleted gates (disabled is judged first — its throw→retry→DLQ semantics
  // stay byte-identical) and returns the DISTINCT typed outcome instead of
  // throwing. The cached instance (if any) is deliberately LEFT in place —
  // resuming the App must reuse the warm instance, and the credential
  // fingerprint (`github_app_id` + `private_key_enc`) is immune to
  // review_enabled writes.
  if (row.review_enabled === 0) {
    return { kind: "paused" };
  }
  // The credential-fingerprint hardening (architect lock L1): the fingerprint is the
  // exact string pair read from the row THIS call already fetched — zero
  // extra reads, no hashing, never `updated_at` (the per-webhook
  // touchLastWebhook would churn it). A re-saved identical PEM yields a NEW
  // AES-GCM envelope → one harmless rebuild; a real rotation rebuilds with
  // the new credential on the very next message.
  const fingerprint = JSON.stringify([row.github_app_id, row.private_key_enc]);
  const cached = deps.appCommenters.get(appRef.appId);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return {
      kind: "ok",
      commenter: cached.commenter,
      githubAppId: cached.githubAppId,
      workspaceId: row.workspace_id,
      reviewLevel: row.review_level,
    };
  }
  // Cache miss (first message for this App) or fingerprint mismatch
  // (rotation): decrypt + build + REPLACE the entry. A decrypt failure here
  // leaves any pre-rotation entry in place but UNREACHABLE — it can only
  // ever be returned by an exact fingerprint match, i.e. the envelope
  // reverting to that entry's own bytes.
  const pem = await createSecretbox(deps.env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
    row.private_key_enc,
    `github_apps.private_key_enc:${row.id}`,
  );
  const commenter = deps.createAppCommenter({ APP_ID: String(row.github_app_id), PRIVATE_KEY: pem });
  deps.appCommenters.set(appRef.appId, { commenter, fingerprint, githubAppId: row.github_app_id });
  return {
    kind: "ok",
    commenter,
    githubAppId: row.github_app_id,
    workspaceId: row.workspace_id,
    reviewLevel: row.review_level,
  };
}

/**
 * Read the PR's head watermark from the App ledger (migration 0044) — ONE
 * select-only point read on `pull_requests`' UNIQUE key, used to tell a
 * delivery the queue has already overtaken from the newest one.
 *
 * Fail-open by construction: an absent row, a column the row never had, or a
 * storage fault all return `null`, and the caller then reviews normally. A
 * skip is only ever the product of two readable, strictly ordered stamps —
 * never of a missing input.
 */
async function readPrHead(
  deps: ProcessDeps,
  payload: ReviewJobPayload,
): Promise<{ headSha: string | null; headAt: string | null } | null> {
  try {
    return await deps.selectPrHead({
      appId: payload.appRef.appId,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { ...payloadIdentityFields(payload), app_id: payload.appRef.appId },
      `PR head watermark read failed (fail-open: reviewing normally): ${detail}`,
    );
    return null;
  }
}

/**
 * Base64-encode UTF-8 text for the in-image JSON write step (workerd-safe).
 * Byte→char conversion is CHUNKED (qc3 F-303): a plain per-byte `+=` loop
 * is O(n²) and this sits in the worker hot path; 0x8000 chars per
 * `String.fromCharCode` call stays far below the engine arg-count cliff.
 */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Per-App AI configuration for the runner exec env. `keys` maps provider id
 * to decrypted key pools in store order; modelChain is the verbatim stored
 * selector chain. Missing chains or keyless chain providers fail closed.
 */
export type RunnerAppConfig = {
  keys: Record<string, string[]>;
  modelChain: string | null;
};

/**
 * Resolve the per-App AI config for one message (single path —
 * `appRef.appId` is required).
 * ONE `getAppConfig` read per message (all
 * provider keys + the model chain in a single store call — never per key),
 * decrypted in memory. Per spec §4.4, the model chain is the
 * App's DEFAULT chain row (app_model_chains name = 'default'); an App with
 * no default row resolves modelChain = null (fail-closed, unchanged). The
 * read hangs off the same appRef resolution as
 * `resolveCommenter` (the App row is already proven present, active and
 * non-deleted there) and runs BEFORE the in-flight guard so an unresolvable
 * config fails with zero side effects. Keys are re-read every message (no
 * cache) so a dashboard key update applies to the very next review.
 * Failure = fail closed: an undecryptable envelope (tampered row, AAD
 * mismatch) or a missing/malformed DASHBOARD_ENCRYPTION_KEY throws — the
 * structured error log + rethrow keep the existing retry/DLQ semantics.
 * AL-24-5: there are no global keys to fall back to — the App's own keys are
 * the ONLY source, and assertAppConfigComplete (run right after this call)
 * fail-closes any chain provider without a configured key. Decrypted keys
 * live only in this call's memory and the assembled exec env — never
 * logged, never in queue payloads or errors.
 */
async function resolveAppConfig(payload: ReviewJobPayload, deps: ProcessDeps): Promise<RunnerAppConfig> {
  const appRef = payload.appRef;
  try {
    const cfg = await createAppConfigStore(
      deps.env.DB,
      deps.env.DASHBOARD_ENCRYPTION_KEY,
    ).getAppConfig(appRef.appId);
    return { keys: cfg.keys, modelChain: cfg.modelChain };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App config resolution failed: app ${appRef.appId}: ${detail}`);
  }
}

/**
 * Resolve the App's per-role model overrides for one message (the
 * model-chain rework, spec §4.4): role → verbatim chain value via
 * the decrypt-free `getModelOverridesForConsumer` read (a model selector is
 * configuration, not a secret — no secretbox). The seat → chain mapping
 * resolves each referenced seat to its chain's value; seats with NO
 * reference row (absent = default) and seats referencing the default chain
 * are OMITTED, so the map only carries seats whose chain differs from the
 * App default — byte-identical to the pre-chains app_model_roles semantics
 * for migrated Apps. An App with NO overrides → `undefined` — the runner
 * input JSON omits the field, byte-identical to a no-map run (the global
 * constraint: empty map = unchanged runner behavior). Hangs off the same
 * appRef resolution as `resolveAppConfig` (the App row is already proven
 * present, active and non-deleted there) and runs BEFORE the in-flight
 * guard so a resolution failure has zero side effects. The map is re-read
 * every message (no cache) so a dashboard seat update applies to the very
 * next review. A resolution failure rethrows with the same app-id-prefixed
 * context wrapper as `resolveAppConfig` (greppable retry/DLQ triage).
 */
async function resolveModelOverrides(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
): Promise<Record<string, string> | undefined> {
  const appRef = payload.appRef;
  try {
    const overrides = await createAppConfigStore(
      deps.env.DB,
      deps.env.DASHBOARD_ENCRYPTION_KEY,
    ).getModelOverridesForConsumer(appRef.appId);
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App model-role resolution failed: app ${appRef.appId}: ${detail}`);
  }
}
/**
 * Resolve the App's custom-provider declarations for one message (AL-23-1):
 * the DECRYPTING `getCustomProvidersForConsumer` read
 * (every declaration plus its key, provider_id-ascending) via
 * createAppConfigStore — the getAppConfig analogue for app_custom_providers.
 * An App with NO declarations → `undefined` — the runner input JSON
 * serializes byte-identically to a no-declaration run (the global
 * constraint: empty = unchanged runner behavior). Hangs off the same
 * appRef resolution as `resolveAppConfig` (the App row is already proven
 * present, active and non-deleted there) and runs BEFORE the in-flight
 * guard so a resolution failure has zero side effects. The set is re-read
 * every message (no cache) so a dashboard declaration update applies to
 * the very next review.
 * The per-attempt cost — one extra SELECT plus N AES-GCM decryptions, paid
 * even on guard-held/deduped attempts — is accepted by design (QC wave-1
 * S-001): small next to clone/diff, and it is what makes declaration updates
 * apply to the very next review instead of a freshness window.
 * A read/decrypt failure rethrows with the app-id-prefixed context wrapper
 * — an undecryptable envelope (tampered row, AAD mismatch) fails CLOSED,
 * never a silent skip (the getAppConfig convention). Decrypted keys live
 * only in this call's memory and the assembled exec env — never logged,
 * never in the runner input JSON, never in queue payloads or errors.
 */
async function resolveCustomProviders(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
): Promise<CustomProviderConsumerConfig[] | undefined> {
  const appRef = payload.appRef;
  try {
    const providers = await createAppConfigStore(
      deps.env.DB,
      deps.env.DASHBOARD_ENCRYPTION_KEY,
    ).getCustomProvidersForConsumer(appRef.appId);
    return providers.length > 0 ? providers : undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App custom-provider resolution failed: app ${appRef.appId}: ${detail}`);
  }
}

/**
 * Resolve the App's sandbox image for one message: the
 * `github_apps.sandbox_image_id` stored selection through the CLOSED
 * source-controlled registry (`getSandboxImage`) — the ONE deliberate
 * resolution interface between App storage and execution. Fails CLOSED with a
 * structured, non-secret error (an id + app id, never secrets) when the saved
 * id is unknown or not an enabled registry entry — an unknown id can only
 * appear via a direct DB write or a registry contraction, and it must never
 * start a sandbox. Runs BEFORE the in-flight guard / sandbox (zero side
 * effects on failure, F-001 structured channel via the caller's catch) and
 * BEFORE `assertAppConfigComplete`, which resolves host ids to catalog
 * provider ids; the definition's hosts also ride the runner input as the
 * synthesis base (`capabilityHosts`). Re-read per message (no cache)
 * so a dashboard image update applies to the very next review.
 */
async function resolveSandboxImage(payload: ReviewJobPayload, deps: ProcessDeps): Promise<SandboxImageDefinition> {
  const appRef = payload.appRef;
  try {
    const row = await createAppsStore(deps.env.DB).getAppById(appRef.appId);
    if (row === null) {
      throw new Error("app not found");
    }
    const image = getSandboxImage(row.sandbox_image_id);
    if (image === undefined) {
      throw new Error(`unknown sandbox image id ${JSON.stringify(row.sandbox_image_id)}`);
    }
    if (!image.enabled) {
      throw new Error(`sandbox image id ${JSON.stringify(row.sandbox_image_id)} is disabled`);
    }
    return image;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App sandbox image resolution failed: app ${appRef.appId}: ${detail}`);
  }
}

/**
 * The runner-input projection of one consumer config: the declaration with
 * the API keys stripped. Provider keys ride only the runner's stdin credential
 * payload (under the declaration's own provider id).
 */
function toRunnerCustomProvider(provider: CustomProviderConsumerConfig): CustomProviderDeclaration {
  return {
    provider_id: provider.provider_id,
    base_url: provider.base_url,
    api: provider.api,
    model_ids: [...provider.model_ids],
  };
}

/**
 * The effective model selector chain for one message (architect AL-2)
 * plus WHERE it came from. AL-24-5 zero global fallback: the
 * App's verbatim non-blank chain is the ONLY source — the global
 * `env.OMP_REVIEW_MODEL` branch was retired with the PipelineEnv field.
 * A falsy/whitespace-only chain = unset (input bounds) →
 * `chain: undefined` (unreachable on the production path: the fail-closed
 * assertAppConfigComplete gate rejects a chain-less App before the
 * runner/put steps; the undefined shape survives only for direct unit calls
 * to this single-point parser). `fromApp` is always true — an App chain is
 * the only contributor left. This is THE chain single source — used by BOTH
 * `buildRunnerEnv` (step 3) and the version-record put below, so the
 * recorded model can never drift from the chain the runner actually saw
 * (the chain rides the exec env — a non-secret — never the runner input JSON).
 */
export function effectiveModelChain(
  appCfg: RunnerAppConfig | undefined,
): { chain: string | undefined; fromApp: boolean } {
  const appChain =
    typeof appCfg?.modelChain === "string" && appCfg.modelChain.trim() !== ""
      ? appCfg.modelChain
      : undefined;
  if (appChain !== undefined) return { chain: appChain, fromApp: true };
  return { chain: undefined, fromApp: true };
}

/**
 * The head (primary) selector of an effective chain — the version record
 * written to `reviews.model`. Comma-separated, trimmed,
 * empty segments dropped (the same grammar as the runner-side selector
 * parse). No chain → NULL — reachable only from direct unit calls: on the
 * production path assertAppConfigComplete fail-closes any App whose chain
 * is missing or parses to zero selectors (AL-24-5), so a successful put
 * never records NULL (the in-image DEFAULT_MODEL_PATTERN scaffold is
 * unreachable from the consumer).
 */
function chainHeadSelector(chain: string | undefined): string | null {
  if (chain === undefined) return null;
  for (const segment of chain.split(",")) {
    const selector = segment.trim();
    if (selector !== "") return selector;
  }
  return null;
}

/**
 * Fail-closed per-App configuration gate (AL-24-5 — zero
 * global fallback): the App's modelChain is the ONLY chain source and every
 * provider on the chain must have a key source in the App's OWN config — a
 * BYOK allowlist pool (app_provider_keys, provider id) or a custom
 * declaration with a non-blank key pool. The SAME requirement applies to
 * selector of every per-role override chain (Bugbot 7aaf18f4): a role
 * override referencing a provider with no configured key must fail closed
 * here, never after the runner clones/starts (the F-001 channel is the
 * fail boundary either way). Missing/blank chain or a chain provider with
 * no key source throws; the error flows through the F-001 structured channel
 * (review failed log + review_failures stage="pipeline" row + rethrow →
 * retry×3 → DLQ) — NO webhook-face reject, NO pause state, NO runtime guard
 * beyond this channel (AL-24-5 verdict 3). The check runs AFTER App
 * resolution and BEFORE the in-flight guard/sandbox, so a misconfigured App
 * fails with zero side effects.
 *
 * `sandboxImage` is the App's resolved registry entry
 * (resolveSandboxImage): a chain provider id that is one of its capability
 * hosts (e.g. omp's `ark-plan`) maps to that host's catalog provider id.
 * Capability hosts are runtime capabilities of the selected image, not App
 */
function assertAppConfigComplete(
  appCfg: RunnerAppConfig,
  customProviders: readonly CustomProviderConsumerConfig[] | undefined,
  modelOverrides: Record<string, string> | undefined,
  appId: string,
  sandboxImage: SandboxImageDefinition,
): void {
  const chain = appCfg.modelChain === null ? "" : appCfg.modelChain.trim();
  // AL-24-5 fail-closed: a chain must contain at least one non-empty
  // comma-separated selector. `","` / `" , "` / `",,,"` are all "missing" —
  // the runner's parseModelSelectors would yield [] and fall back to the
  // in-image DEFAULT_MODEL_PATTERN scaffold (which must stay unreachable
  // from the consumer), and chainHeadSelector would record NULL on a
  // successful put (Interfaces: success never NULL).
  const hasSelector = chain.split(",").some((segment) => segment.trim() !== "");
  if (!hasSelector) {
    throw new Error(`per-App config incomplete: app ${appId}: missing model chain`);
  }
  // The env names the App's OWN config can supply: allowlisted BYOK keys
  // (provider id → envName — non-blank values only) + custom declarations.
  const availableProviders = new Set<string>();
  for (const [provider, keys] of Object.entries(appCfg.keys)) {
    if (providerEnvName(provider) !== undefined && keys.some((key) => key.trim() !== "")) {
      availableProviders.add(provider);
    }
  }
  for (const decl of customProviders ?? []) {
    if (decl.api_keys.some((key) => key.trim() !== "")) availableProviders.add(decl.provider_id);
  }
  const hostProviders = new Map(sandboxImage.hosts.map((host) => [host.id, host.catalogProviderId]));
  const neededProvider = (provider: string): string => hostProviders.get(provider) ?? provider;
  // Every chain that must resolve to configured keys: the App's modelChain
  // plus each per-role override's selector chain (Bugbot 7aaf18f4 — the
  // app_model_roles selectors reach the runner as the `modelOverrides`
  // input field, so they carry the same fail-closed requirement). Both use
  // the runner's parseModelSelectors grammar (comma-separated, trimmed,
  // empty segments dropped; provider = the segment before the first `/`;
  // a selector whose shape yields no provider is left to the runner exactly
  // as the chain path does today — no new fail is invented here).
  // Each override chain must ALSO pass the same zero-selector check as the
  // base chain below (PR #11 review BUG-01): a role chain that trims to a
  // raw `,` / `,,,` / whitespace would otherwise slip past the gate, reach
  // the runner as present-but-empty (runner-side `trim() !== ""` counts it
  // as present), and either run the in-image DEFAULT_MODEL_PATTERN scaffold
  // (with the ark key) or fail at stage=runner AFTER side effects.
  const chains: Array<{ role: string | null; chain: string }> = [
    { role: null, chain },
    ...(modelOverrides === undefined
      ? []
      : Object.entries(modelOverrides).map(([role, overrideChain]) => ({
          role,
          chain: overrideChain.trim(),
        }))),
  ];
  for (const { role, chain: candidateChain } of chains) {
    if (role !== null) {
      const overrideHasSelector = candidateChain
        .split(",")
        .some((segment) => segment.trim() !== "");
      if (!overrideHasSelector) {
        throw new Error(
          `per-App config incomplete: app ${appId}: role override \`${role}\`: missing model chain`,
        );
      }
    }
    for (const segment of candidateChain.split(",")) {
      const selector = segment.trim();
      if (selector === "") continue; // the runner drops empty segments too
      const provider = selector.split("/")[0]!.trim();
      if (!availableProviders.has(neededProvider(provider))) {
        const where = role === null ? "" : `role override \`${role}\` `;
        throw new Error(
          `per-App config incomplete: app ${appId}: ${where}provider ${provider} has no configured key`,
        );
      }
    }
  }
}

/**
 * Build the runner exec env: harness paths + the App's verbatim model chain.
 * It carries NO credential — provider keys ride the stdin payload
 * (`buildRunnerCredentials`), never the process environment.
 */
export function buildRunnerEnv(appCfg: RunnerAppConfig): Record<string, string> {
  const runnerEnv: Record<string, string> = {
    HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
    PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
  };
  // The App's verbatim chain forwards VERBATIM (the guard only decides
  // unset-vs-set; it never mutates the value; the runner-side selector parse
  // trims segments). A blank chain cannot reach production — the
  // assertAppConfigComplete gate fails the message before the guard. The
  // precedence lives in effectiveModelChain (ONE resolution shared with the
  // version-record put — no re-resolution split-brain).
  const { chain } = effectiveModelChain(appCfg);
  if (chain !== undefined) {
    runnerEnv.OMP_REVIEW_MODEL = chain;
  }
  return runnerEnv;
}

/**
 * Build the runner's credential transport: the versioned stdin payload
 * (packages/shared/src/credential-payload) plus the exact key VALUES it carries — the
 * SEC-01 exact-redaction list. ONE resolution serves both, so the recorded
 * secret list can never drift from the keys the session actually saw.
 *
 * Provider id (the App-config key space) → ordered pool, in store order: the
 * allowlisted BYOK ids first, then the App's custom declarations. Blank values
 * never ride, and a pool with none left is not transported at all. `payload`
 * is `undefined` when nothing was transported (the keyless run shape). Key
 * values live only in this payload and are never logged.
 */
export function buildRunnerCredentials(
  appCfg: RunnerAppConfig,
  log?: ConsumerLog,
  fields?: ConsumerLogFields,
  customProviders?: readonly CustomProviderConsumerConfig[],
): { payload: string | undefined; keyValues: string[] } {
  // Log only when the caller supplied BOTH the sink and the identity fields
  // (the consumer flow does; direct unit calls may omit them).
  const emit = log !== undefined && fields !== undefined;
  const pools: CredentialPools = {};
  const keyValues: string[] = [];
  let appKeys = 0;
  const addPool = (provider: string, rawKeys: readonly string[], source: "app" | "custom"): number => {
    const keys = rawKeys.filter((key) => key.trim() !== "");
    if (keys.length === 0) return 0;
    pools[provider] = keys;
    keyValues.push(...keys);
    if (emit) {
      log.info(
        { ...fields, provider, key_source: source },
        `provider key pool from App config: ${provider} (${keys.length} key(s))`,
      );
    }
    return keys.length;
  };
  for (const [provider, keys] of Object.entries(appCfg.keys)) {
    if (providerEnvName(provider) === undefined) {
      if (emit) {
        log.warn(
          { ...fields, provider },
          "stored provider key id is not on the PROVIDERS allowlist — row skipped",
        );
      }
      continue;
    }
    appKeys += addPool(provider, keys, "app");
  }
  for (const decl of customProviders ?? []) {
    if (addPool(decl.provider_id, decl.api_keys, "custom") === 0 && emit) {
      log.warn(
        { ...fields, provider: decl.provider_id, key_source: "custom" },
        "custom provider key pool is empty — no keys transported",
      );
    }
  }
  if (emit) {
    const customCount = customProviders?.length ?? 0;
    log.info(
      { ...fields, config_source: "app" },
      `per-App credential payload: ${appKeys} provider key(s) from App config, ${customCount} custom` +
        `${effectiveModelChain(appCfg).chain !== undefined ? ", model chain from App config" : ""}`,
    );
  }
  return {
    payload: Object.keys(pools).length === 0 ? undefined : encodeCredentialPayload(pools),
    keyValues,
  };
}

/**
 * Exec-env names that are configuration/paths, not credentials — the only
 * values the runner exec env carries now that keys ride the stdin payload.
 */
const RUNNER_EXEC_ENV_PASSTHROUGH_NAMES: readonly string[] = [
  "OMP_REVIEW_MODEL",
  "HARNESS_PLUGIN_ROOT",
  "PI_CODING_AGENT_DIR",
];

/**
 * The ACTUAL secret values one review session carried (SEC-01 exact-value
 * defense): every provider key the credential payload transported — the values
 * a prompt-injected model could echo verbatim — plus the installation token
 * minted for the session. `redactExactSecrets` removes them even when they
 * evade every shape pattern. The key list is the SAME resolution the runner
 * exec used (no re-resolution split-brain).
 */
function sessionSecretValues(runnerEnv: Record<string, string>, keyValues: readonly string[], token: string): string[] {
  const values: string[] = [token, ...keyValues];
  for (const [name, value] of Object.entries(runnerEnv)) {
    if (RUNNER_EXEC_ENV_PASSTHROUGH_NAMES.includes(name)) continue;
    if (value !== "") values.push(value);
  }
  return values;
}

/** Characters of an exec's stderr tail carried by its failure message. */
const STDERR_TAIL_MAX = 600;

/**
 * The runner stage's failure detail. stderr is the ONLY diagnosis a non-zero
 * exit carries (exit 124 = the exec bound fired, and the run leaves 0B of
 * stdout), so a redacted tail rides the message that reaches the durable
 * review_failures row and the log line. Redaction runs BEFORE the tail cut:
 * a secret sliced in half would survive the exact-value pass.
 */
function runnerFailureDetail(
  run: { stdout: string; stderr: string; exitCode: number },
  secretValues: readonly string[],
): string {
  // review_failures.error is unbounded TEXT (migration 0010), so the bounded
  // tail below cannot overflow the column.
  const base = `runner failed: exit ${run.exitCode}, stdout ${run.stdout.length}B`;
  const tail = redactExactSecrets(redactSecrets(run.stderr), secretValues).trim().slice(-STDERR_TAIL_MAX);
  return tail === "" ? `${base}, stderr empty` : `${base}, stderr tail: ${tail}`;
}

/**
 * A git stage's failure detail (diff / increment diff / numstat). stderr is the
 * ONLY diagnosis a non-zero exit carries — an oversized diff fails `gh pr diff`
 * with HTTP 406 on stderr and 0B of stdout — so a redacted tail rides the
 * message that reaches the durable review_failures row. Redaction runs BEFORE
 * the tail cut, so a secret straddling the cap cannot survive as a fragment.
 */
function gitStageFailureDetail(
  stage: string,
  run: { stdout: string; stderr: string; exitCode: number },
): string {
  const base = `${stage} failed: exit ${run.exitCode}, stdout ${run.stdout.length}B`;
  const tail = redactSecrets(run.stderr).trim().slice(-STDERR_TAIL_MAX);
  return tail === "" ? `${base}, stderr empty` : `${base}, stderr tail: ${tail}`;
}

/**
 * KV done-state read (B3): `done` means a review was already POSTED for this
 * sha (the consumer writes it right after posting, before the D1 insert).
 * The worker's enqueue marker uses the SAME key format with value "1", so
 * only the literal "done" counts as completed — "1" means "enqueued, not yet
 * processed" and falls through to the D1 check. KV failure → warn + fall
 * through (D1 is the durable backstop).
 */
async function kvDoneHit(
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
 * Does the ledger's newer commit own a job that may still run? The worker
 * claims the idempotency key only AFTER a successful `REVIEW_QUEUE.send`, so
 * the key proves that commit was enqueued. The ledger alone proves nothing:
 * every verified non-reject delivery advances it, including ones that enqueue
 * nothing (a `synchronize` in `open` mode, a paused App, a failed send), so a
 * skip backed by the ledger alone would ack a delivery whose PR head has no
 * review.
 *
 * `"1"` (queued) and `"done"` (reviewed by this consumer) are that proof;
 * `"dropped"` (the guard's terminal ack in handleGuardHeld), `"failed"` (the
 * final delivery is heading to the DLQ), `"paused"` (the App is paused),
 * `"degraded"` (the run ended in a degraded notice) and `"superseded"` (this
 * sha was itself replaced) are NO proof — every one names a commit that was
 * never reviewed, so this delivery must review rather than skip.
 *
 * This is a POINT-IN-TIME read, not a reservation: it proves the newer job was
 * enqueued and not yet terminally dropped when the ack was written. That job
 * can still be dropped afterwards (see handleGuardHeld); the `review_failures`
 * row it leaves is the only trace, and nothing re-enqueues this delivery.
 *
 * Fail-open: an absent ledger sha, an absent key or a KV fault all mean "no
 * proof" → review normally (a fault logs one warn line).
 */
async function newerCommitHasJob(
  deps: ProcessDeps,
  payload: ReviewJobPayload,
  headSha: string | null,
  fields: ConsumerLogFields,
): Promise<boolean> {
  if (!headSha) return false;
  try {
    // Inside the try: an empty ledger sha makes `idemKey` throw, and that is
    // "no proof" too — never a failed delivery.
    const key = idemKey({
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: headSha,
    });
    const claim = await deps.env.IDEMPOTENCY_KV.get(key);
    return isReviewClaim(claim);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `supersede KV read failed — reviewing normally: ${detail}`);
    return false;
  }
}
/**
 * Test seam for createReviewConsumer: additive overrides for the process
 * dependencies (store / failureStore / per-App commenter factory /
 * getSandbox). The contract `createReviewConsumer(env)` is unchanged
 * — every field defaults to the production implementation when omitted.
 */
type ConsumerOverrides = Partial<
  Pick<
    ProcessDeps,
    | "store"
    | "failureStore"
    | "createAppCommenter"
    | "getSandbox"
    | "checks"
    | "selectPrHead"
    | "findIncrementBase"
    | "roundBudgetMs"
  >
>;

/**
 * Create the queue consumer. The store and commenters are created once per
 * consumer instance (per-App commenter instances live in the appCommenters
 * Map — one per appId, lock L4). Each message
 * gets its own sandbox, destroyed in finally; failures rethrow so the queue
 * retries and eventually DLQs.
 *
 * `log` is injectable for tests (default: structured JSON lines). `overrides`
 * lets tests substitute the store / failureStore / per-App commenter
 * factory / sandbox factory without process-wide mock.module (bun's
 * relative-path mock.module leaks across test files sharing a worker — CI
 * run 32946710695).
 */
export function createReviewConsumer(
  env: PipelineEnv,
  log: ConsumerLog = defaultConsumerLog,
  overrides: ConsumerOverrides = {},
  background?: CheckBackgroundSink,
): (batch: MessageBatch<ReviewJobPayload>) => Promise<void> {
  // The per-App commenter cache (lock L4) is also the Check lane's
  // credential route: the lifecycle resolves THIS message's App adapter from
  // it, so a Check never mints a token, client or permission set of its own.
  const appCommenters = new Map<string, { commenter: ReviewCommenter; fingerprint: string; githubAppId: number }>();
  // One App-ledger store per consumer: `selectPrHead` is the supersede
  // decision's point read and must not rebuild the store per message.
  const appsStore = createAppsStore(env.DB);
  const deps: ProcessDeps = {
    env,
    store: overrides.store ?? createArtifactStore(env.DB),
    failureStore: overrides.failureStore ?? createFailureStore(env.DB),
    appCommenters,
    // Production factory (§7.5/§7.7 step 11): the commenter is bound
    // to the thread store (`createReviewCommenter(env, { db })`) so
    // `discoverThread` / `resolveFindingThread` are live for the resolution
    // step — the single construction point stays src/pipeline/comment.ts.
    createAppCommenter: overrides.createAppCommenter ?? ((cred) => createReviewCommenter(cred, { db: env.DB })),
    getSandbox: overrides.getSandbox ?? ((binding, id) => getSandbox(binding, id)),
    selectPrHead: overrides.selectPrHead ?? appsStore.selectPrHead,
    findIncrementBase: overrides.findIncrementBase ?? findIncrementBase,
    roundBudgetMs: overrides.roundBudgetMs ?? ROUND_BUDGET_MS,
    log,
    background,
  };
  // §7.10 Check seam: production always supplies the
  // lifecycle; an override replaces it wholesale. An App whose commenter
  // carries no Checks surface yields `null` from `getAdapter`, and the
  // lifecycle then registers no attempt at all. The lifecycle needs NO
  // consumer-wide cancellation state: each `begin` receives its own latch.
  deps.checks =
    overrides.checks ??
    createCheckLifecycle({
      db: env.DB,
      nowMs: () => Date.now(),
      getAdapter: (scope) => appCommenters.get(scope.appId)?.commenter.checks ?? null,
      // The App gate is a stored configuration value, read through the same
      // per-consumer store as the ledger reads (spec §7.9).
      getCheckGate: (scope) => appsStore.getCheckGate(scope.appId),
    });
  return async (batch) => {
    for (const message of batch.messages) {
      const outcome = await processMessage(message.body, deps, message.attempts);
      // BB-3: guard-held is a typed outcome — schedule the per-message
      // delayed retry (or the final ack-with-warning) instead of throwing
      // into the queue's immediate ×3 retry → DLQ path.
      if (outcome.kind === "guard-held") {
        await handleGuardHeld(message, deps, outcome.admission, outcome.heldHeadSha, outcome.level);
      } else if (outcome.kind === "paused") {
        // Architect lock L4: a paused App's in-flight message is
        // acked DIRECTLY — an intentional skip (its claim was already stamped
        // `paused` inside processMessage), never a retry and never a DLQ
        // entry.
        message.ack();
      } else if (outcome.kind === "degraded") {
        // Architect AL-1: parse-fail degrade — the
        // best-effort failure row and degraded comment already ran inside
        // processMessage; the message is acked DIRECTLY (deterministic
        // model-output failure — retry re-runs the same pure function on the
        // same stdout), never a retry and never a DLQ entry.
        message.ack();
      } else if (outcome.kind === "superseded") {
        // The ledger already holds a newer commit for this PR: this delivery
        // is a leftover, acked directly before any container. No retry (the
        // newer delivery is the one that reviews) and no DLQ.
        message.ack();
      }
    }
  };
}

/**
 * @param attempts the delivery number of this message (1 = first delivery);
 *   only the value past the queue's retry budget matters — it stamps the
 *   idempotency key `failed` so a DLQ-bound commit stops counting as reviewed-
 *   or-pending proof.
 */
async function processMessage(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
  attempts = 1,
): Promise<ProcessOutcome> {
  // The round's wall clock starts HERE: every best-effort step that can spend a
  // sandbox window (the PR-context capture) is measured against this instant and
  // `deps.roundBudgetMs`, so it can never eat the window the paid run and its
  // publication need.
  const roundStartedAt = Date.now();
  // Unique per attempt: a destroyed sandbox's id is never
  // reused — attach-after-destroy behavior is unknown, uniqueness wins.
  const sandboxId = `review-${crypto.randomUUID()}`;
  let sandbox: ReviewSandbox | null = null;
  // Set once the sha is resolved from the checkout; the failure log carries
  // the idempotency key + sandbox id whenever they exist (Clarify #11 / Done
  // criteria: 失败路径错误日志含幂等键).
  let fields: ConsumerLogFields | undefined;
  // Review admission (WF-002 + review-concurrency §1.2): the live
  // `review_inflight` row this attempt wrote, released in the finally. The
  // key is the PR identity WITHOUT head_sha, so comment-mention jobs
  // (head_sha=null) are serialized per PR too; the row also reserves the
  // workspace and system capacity slots.
  let inflight: { key: InflightKey; attemptId: string; ttlSeconds: number } | null = null;
  // Set once the App row resolves inside the try (the paused gate returns
  // before it); the admission row's TTL needs the same level. inflight ≠ null
  // ⇒ level is set (resolution precedes admission). The failure path tolerates
  // `undefined` — a pre-resolution failure has no App to attribute a level to.
  let level: ReviewLevel | undefined;
  // Runner wall-clock start (d5-budget AC-S10-logs): set just before the
  // runner exec so the failure log can carry elapsed_ms. VISIBILITY ONLY —
  // elapsed never aborts; the sandbox exec timeout is the only wall-clock
  // failure (spec 不 abort).
  let runnerStartedAt: number | undefined;
  // Failure-stage tracking (AL-6): the catch site's
  // best-effort review_failures row classifies `stage` from the coarse phase
  // in flight — "pipeline" (default) = worker-side orchestration (level /
  // credential / config resolution, token mint, comment post); "sandbox" =
  // container acquisition + the in-sandbox git/diff/numstat/input steps
  // (exec exception OR non-zero exit); "runner" = the in-image review run
  // itself. "parse" never goes through this variable — the degrade branch
  // records stage="parse" directly and acks without reaching the catch.
  let failureStage: FailureStage = "pipeline";
  // SEC-01 exact-value defense: the session's ACTUAL secret values (runner
  // env provider keys + the minted installation token). Seeded with the
  // minted token right after mint (a pre-runner catch still exact-redacts
  // it), then replaced with the full session values once the runner env is
  // assembled. Hoisted so the catch site's best-effort failure row can
  // exact-redact the error detail too (SEC-03).
  let secretValues: string[] = [];
  // F-001 (QC wave-1): toBaseFields derefs payload.appRef.appId, so
  // an in-flight pre-deploy message (absent appRef — AL-24-4 accepts the
  // TypeError) must throw INSIDE the try: it then flows through the
  // established structured channel (review failed: log + AL-6
  // review_failures row + rethrow). Pure relocation — no runtime guard
  // (AL-24-4 forbids one).
  let baseFields: ConsumerLogFields | undefined;
  // §7.10 Check seam state: the handle from the step-4 begin hook
  // (null = no Checks / hook failed) and the ONCE-guarded terminalize —
  // every terminal path reports exactly one outcome, hook exceptions are
  // isolated warns, and a hook timeout resolves without blocking the path.
  let checkHandle: CheckHandle | null = null;
  let checkTerminalized = false;
  // Whether the ADMISSION-time claim ran. The post-`rev-parse` block is the
  // fallback for a message whose SHA was not knowable then, so it must not
  // claim a second time (a failed early claim included: the claim INSERT is the
  // one race-decided gate, and the old code tried exactly once).
  let checkClaimAttempted = false;
  // §7.10 Check budgets, filled by the ONE per-message runtime read (after the
  // level resolves, before the begin hook). Every terminal path runs after that
  // read; a path that somehow reached one without it is still bounded by the
  // store's documented defaults rather than waiting forever.
  let checkBudgets: CheckBudgets | null = null;
  // Set the moment the prepared publication send is ATTEMPTED: a throw after
  // this point is post-send uncertainty (publication-unknown), never a
  // clean pre-publication failure.
  let sendAttempt: { publicationId: string } | null = null;
  /**
   * §7.10 give-up handoff: the consumer stopped waiting on the terminalize
   * hook. The lifecycle freezes a terminal intent (only where none is frozen)
   * and releases the lease to the Check recovery lane with NO remote request,
   * so the minute reconciler closes the run instead of waiting out the
   * execution deadline (spec §7.11). The promise is handed to the invocation
   * context when one exists, so a Check write never adds a wait to the
   * review's own return.
   *
   * Resolves `true` only when the handoff COMPLETED under this lease (intent +
   * release, two fenced writes) and the release actually changed the row.
   * `false` means the attempt may still hold this consumer's lease (or the
   * no-op proved it was not ours to release), so a caller taking a second
   * Check ownership must not do so — a Check fault never blocks the review,
   * but it must not double-claim either.
   */
  const abandonCheck = (handle: CheckHandle, reason: string, outcome?: "superseded"): Promise<boolean> => {
    const abandon = deps.checks?.abandonTerminalize;
    // No give-up seam (test doubles only; production always supplies it):
    // nothing can prove this attempt released, so report the handoff as failed.
    if (abandon === undefined) return Promise.resolve(false);
    const line = {
      ...(baseFields ?? payloadIdentityFields(payload)),
      sandbox_id: sandboxId,
      attempt_id: handle.attemptId,
      check_reason: reason,
    };
    const release = abandon({ handle, reason, ...(outcome === undefined ? {} : { outcome }) }).then(
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
  ): Promise<void> => {
    // The per-message read always precedes every terminal path; the fallback
    // keeps a future caller bounded by the store's documented defaults.
    const budgets = checkBudgets ?? {
      terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
      updateMs: CHECK_UPDATE_DEFAULT,
      degraded: false,
    };
    // Set when the consumer stops waiting on the hook: only past that point is
    // a later rejection detached, so only then does the sink report it.
    let abandoned = false;
    // The give-up handoff the overrun callback starts: awaited below when no
    // invocation context can own it (spec §7.10's no-context fallback).
    let giveUpRelease: Promise<boolean> | undefined;
    try {
      const terminalize = deps.checks!.terminalize({
        handle,
        publicationId,
        outcome,
        ...(inheritedHeadSha === undefined ? {} : { inheritedHeadSha }),
        updateBudgetMs: budgets.updateMs,
      });
      // The invocation owns the promise: if the budget below expires, the hook
      // still finishes after this consumer returns. A rejection landing after
      // that point has no inline waiter left to report it.
      deps.background?.waitUntil(
        terminalize.catch((err: unknown) => {
          if (!abandoned) return; // the inline await below already reports it
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            {
              ...(baseFields ?? payloadIdentityFields(payload)),
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
              ...(baseFields ?? payloadIdentityFields(payload)),
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
          giveUpRelease = abandonCheck(handle, `terminalize budget exceeded (${budgets.terminalizeMs}ms)`);
        },
      );
      // The overrun path has the same no-context fallback as the throw path:
      // one fenced D1 write, never a remote send, so the lease is released
      // before this consumer returns even without `waitUntil`.
      if (giveUpRelease !== undefined && deps.background === undefined) await giveUpRelease;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        {
          ...(baseFields ?? payloadIdentityFields(payload)),
          sandbox_id: sandboxId,
          attempt_id: handle.attemptId,
          event: "check_terminalize_failed",
        },
        `check terminalize hook failed (isolated): ${detail}`,
      );
      // Awaited only when no invocation context can own it (one fenced write).
      const release = abandonCheck(handle, `terminalize hook threw: ${detail}`);
      if (deps.background === undefined) await release;
    }
  };

  const terminalizeCheck = async (
    publicationId: string | null,
    outcome: CheckTerminalOutcome,
    inheritedHeadSha?: string,
  ): Promise<void> => {
    if (deps.checks === undefined || checkHandle === null || checkTerminalized) return;
    checkTerminalized = true;
    await runTerminalize(checkHandle, publicationId, outcome, inheritedHeadSha);
  };

  /**
   * The §7.10 begin hook over one SHA, isolated exactly as before: its own
   * latch (never shared or reset), the 2 s consumer bound, and a throw that
   * only warns — a Check never prevents the review.
   */
  const beginCheck = async (scope: Scope, githubAppId: number, headSha: string): Promise<CheckHandle | null> => {
    if (deps.checks === undefined) return null;
    // One latch per `begin` call, created HERE and never stored anywhere: a
    // later message cannot clear or reuse it, so a detached begin from this
    // message stays abandoned for its whole lifetime (QC1-001 replacement
    // race).
    const beginLatch = createCheckBeginLatch();
    try {
      return await withHookTimeout(
        deps.checks.begin({
          scope,
          githubAppId,
          headSha,
          triggeredBy: payload.triggered_by,
          action: payload.action,
          executionDeadlineMs: Date.now() + CHECK_EXECUTION_WINDOW_MS,
          latch: beginLatch,
        }),
        null,
        // The begin hook keeps §7.10's 2 s: it runs before model work.
        CHECK_HOOK_TIMEOUT_MS,
        // The consumer gave up waiting: a lifecycle that reads this call's
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
        fields ?? baseFields ?? payloadIdentityFields(payload),
        `check begin hook failed (isolated, no Check): ${detail}`,
      );
      return null;
    }
  };

  try {
    baseFields = toBaseFields(payload);
    // Durable per-comment claim (migration 0048) — the atomic step that turns
    // at-least-once queue delivery into at-most-once execution. The worker
    // already inserted the row `queued` before it enqueued, so the conditional
    // UPDATE below decides which delivery runs: a queue redelivery, an outbox
    // re-send, or a delivery arriving after the 24h KV claim lapsed all find
    // `state` no longer `queued` and ack without running.
    //
    // Deliberately BEFORE the level/credential resolution: the claim must be
    // recorded even when the run itself fails, because a comment-triggered
    // review is re-run by posting a new comment (a new id), never by replaying
    // this one (the documented accepted limit).
    //
    // The payload is cleared in the same statement: it is only needed while
    // `queued` (the outbox re-send), and the row itself lives on as the
    // tombstone that refuses every later delivery of this comment.
    if (payload.comment_id !== undefined) {
      const claimed = await deps.env.DB.prepare(
        `UPDATE comment_trigger_claims SET state = 'consumed', consumed_ms = ?, payload_json = NULL
          WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?
            AND state = 'queued'`,
      )
        .bind(
          Date.now(),
          payload.installation_id,
          payload.owner,
          payload.repo,
          payload.pr_number,
          payload.comment_id,
        )
        .run();
      if (claimed.meta.changes === 0) {
        deps.log.info(baseFields, "comment trigger already claimed — ack without running");
        return { kind: "ok" };
      }
    }
    // Credential resolution FIRST (lock L4 — consumer-side),
    // before the guard/sandbox: app → D1 row gated
    // missing/deleted/disabled (throw → retry/DLQ, byte-identical) then
    // PAUSED (lock L4: DISTINCT typed outcome, below) → decrypted
    // PEM → per-App commenter instance (cached per appId). An unresolvable
    // App (missing / disabled / soft-deleted / undecryptable) fails
    // structurally here with zero side effects — the rethrow keeps the
    // existing retry/DLQ semantics and no GitHub write ever happens. Token
    // mint and postReview below both use THIS resolved instance (same App
    // identity, lock L4).
    const resolution = await resolveCommenter(payload, deps);
    // Ack-skip (architect lock L4): a paused App's in-flight message
    // is the DISTINCT `paused` outcome — the queue handler acks it directly.
    // EVERYTHING below is skipped: no in-flight guard acquisition (no guard
    // TTL consumed), no sandbox creation, no token mint, no app-config read,
    // no GitHub API call, no retry, no DLQ. The structured log rides the
    // existing ConsumerLogFields channel with `event: "review_paused"`
    // (union widened additively) + app_id + the baseFields PR identity.
    if (resolution.kind === "paused") {
      deps.log.info(
        { ...baseFields, event: "review_paused" },
        "review paused — app review_enabled=0; acking without a review (no retry, no DLQ)",
      );
      // A pause is an answer about the REVIEW, not about the commit: the
      // worker's "1" claim must stop proving a review is coming, or both
      // readers (the supersede skip and the worker's pre-check) would accept
      // it forever. `putAbandonClaim` never downgrades a completed review.
      // Best-effort — a KV fault only leaves the stale "1".
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
            IDEM_PAUSED,
            IDEMPOTENCY_SECONDS,
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            { ...baseFields, event: "review_paused" },
            `paused-claim KV write failed (the skip may still treat this commit as queued): ${detail}`,
          );
        }
      }
      return { kind: "paused" };
    }
    const { commenter, githubAppId, workspaceId } = resolution;
    // Supersede skip (migration 0044): a queued delivery whose PR head has
    // already advanced must cost nothing that can fail it, hold the guard, or
    // start work — no admission row, no sandbox, no Check, no publication.
    // The per-App credential resolution above has already run (the paused gate
    // needs it); this read is select-only and sits AFTER that gate (a paused
    // App keeps today's ack-and-stop) and BEFORE assertAppConfigComplete /
    // admission, so a storage fault can only add this one read, never a side
    // effect.
    //
    // The ledger advances on EVERY verified non-reject delivery, including the
    // ones that enqueue nothing (a `synchronize` in `open` mode, a paused App,
    // a failed enqueue), so the ledger alone cannot stand as the skip's proof:
    // the newer commit must also own a job — its idempotency key is claimed
    // only after a successful send and is stamped "dropped" when the guard
    // gives that job up for good.
    //
    // That proof is read ONCE, at ack time, and never reserved: it says the
    // newer job was enqueued and not yet terminally dropped when this delivery
    // is acked. If that job is dropped afterwards, nothing re-enqueues this
    // one — the `review_failures` row from the drop is the trace, and the PR's
    // head then has no review until a later delivery. This is the accepted
    // cost of keeping the skip free of retries, not a guarantee that no PR can
    // lose its only review.
    //
    // `issue_comment` jobs and pre-migration messages carry no stamp and take
    // today's path untouched — not even these reads.
    //
    // The ledger stamp is a DELIVERY watermark, so a later delivery naming the
    // SAME sha moves it too (migration 0044): expected and harmless here, since
    // the skip also requires the ledger's sha to differ from this payload's.
    const payloadHeadSha = payload.head_sha;
    const payloadHeadAt = payload.head_at;
    if (payloadHeadSha && payloadHeadAt) {
      const ledgerHead = await readPrHead(deps, payload);
      // Two readable stamps on both sides, the ledger strictly newer, a
      // different commit, and a queued job for that commit: only then is this
      // delivery a leftover. Missing or unreadable input never skips.
      if (
        ledgerHead?.headAt &&
        ledgerHead.headAt > payloadHeadAt &&
        ledgerHead.headSha !== payloadHeadSha &&
        (await newerCommitHasJob(deps, payload, ledgerHead.headSha, baseFields))
      ) {
        deps.log.info(
          { ...baseFields, event: "review_superseded", reason: "superseded", superseded_by_head_at: ledgerHead.headAt },
          `delivery superseded — the PR head has advanced to ${ledgerHead.headAt} (head_sha ${ledgerHead.headSha ?? "unknown"}), acking with no review side effects (no retry, no DLQ, no container)`,
        );
        // A superseded sha is not reviewed by THIS delivery, so its claim must
        // stop proving a review of it is coming. Deliberately not a tombstone:
        // a force-push can make this sha the head again (A → B → A), and the
        // worker's pre-check re-enqueues any `superseded` claim for exactly
        // that reason — this delivery's ledger comparison is what decides it
        // was a leftover, not the claim. `putAbandonClaim` never downgrades a
        // completed review. Best-effort — a KV fault only leaves the stale "1"
        // and never changes this outcome.
        try {
          await putAbandonClaim(
            deps.env.IDEMPOTENCY_KV,
            idemKey({
              installation_id: payload.installation_id,
              owner: payload.owner,
              repo: payload.repo,
              pr_number: payload.pr_number,
              head_sha: payloadHeadSha,
            }),
            IDEM_SUPERSEDED,
            IDEMPOTENCY_SECONDS,
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            { ...baseFields, event: "review_superseded" },
            `superseded-claim KV write failed (a redelivery may review this obsolete commit): ${detail}`,
          );
        }
        return { kind: "superseded" };
      }
    }
    // The App's review depth (migration 0047), resolved from the SAME row read
    // that resolved its credentials — the admission TTL, the runner budget and
    // the guard backoff all use it. A NULL (or off-vocabulary) column follows
    // the operator default: one bounded settings read, issued only then. A
    // degraded read answers the documented default and owes the operator one
    // structured warn (the concurrency reader's contract) — never a silent
    // fallback.
    //
    // AFTER the supersede skip on purpose: a superseded delivery is not the
    // live review, so it must not pay — or degrade on — this read.
    const appLevel = parseAppReviewLevel(resolution.reviewLevel);
    if (appLevel !== null) {
      level = appLevel;
    } else {
      const fallback = await readDefaultReviewLevel(deps.env.DB);
      level = fallback.value;
      if (fallback.degraded) {
        deps.log.warn(
          { ...baseFields, event: "review_level_degraded", level: fallback.value },
          "operator default review level read degraded — using the documented default",
        );
      }
    }
    // Per-App AI config: hangs off the SAME appRef resolution as
    // the commenter — one getAppConfig read per message, before the
    // guard/sandbox so an unresolvable config (undecryptable key envelope,
    // missing DASHBOARD_ENCRYPTION_KEY) fails closed with zero side effects.
    const appCfg = await resolveAppConfig(payload, deps);
    // Per-role model overrides: rides the SAME appRef gate,
    // before the guard like the config above. undefined (empty map)
    // → the runner input JSON below stays byte-identical.
    const modelOverrides = await resolveModelOverrides(payload, deps);
    // Custom-provider declarations: hangs off the SAME
    // appRef gate, before the guard like the config/overrides above —
    // undefined (no declarations) → the runner input JSON stays
    // byte-identical and no custom-provider pool env is injected. The
    // decrypt face is fail-loud (tamper never swallowed): a broken envelope
    // throws here with zero side effects, never a silently-skipped provider.
    const customProviders = await resolveCustomProviders(payload, deps);
    // The App's sandbox image: resolves the stored
    // github_apps.sandbox_image_id through the CLOSED registry and fails
    // closed (structured, non-secret error) on unknown/disabled ids —
    // BEFORE the in-flight guard and sandbox creation, so an invalid id
    // never starts a container. The resolved definition feeds the
    // config gate below (capability-host env-name mapping) and the runner
    // input (the synthesis base's capability hosts).
    const sandboxImage = await resolveSandboxImage(payload, deps);
    // AL-24-5 fail-closed gate: after App resolution,
    // BEFORE the in-flight guard / sandbox. The App's modelChain is the ONLY
    // chain source and every chain provider must have a key in the App's OWN
    // config (BYOK allowlist key — incl. `ark` for the ark-plan base
    // provider — or a custom declaration); the SAME requirement now covers
    // every per-role override selector chain (Bugbot 7aaf18f4). A
    // misconfigured App throws here
    // and flows through the F-001 structured channel (error log +
    // review_failures stage="pipeline" row + rethrow → retry×3 → DLQ) with
    // ZERO side effects — no webhook-face reject, no pause state, no runtime
    // guard beyond this channel (AL-24-5 verdict 3).
    assertAppConfigComplete(appCfg, customProviders, modelOverrides, payload.appRef.appId, sandboxImage);
    // 0. Review admission (WF-002 / bugbot BB-3 + review-concurrency §1.2):
    // ONE conditional D1 insert is both the per-PR lock and the capacity
    // reservation, so a duplicate for this PR or a reached cap returns the
    // DISTINCT guard-held outcome — NOT a throw. The consumer schedules a
    // per-message delayed retry (per level: 60/300/2040s quick/default,
    // 90/480/2040s deep); after the final delayed attempt the job is acked
    // with a warning — guard-held is not an error state and never goes to the
    // DLQ. Admission precedes EVERY sandbox step, so a refused message costs
    // no container.
    // Captured as a const: a `let` widens to `| undefined` inside the callback.
    const admissionFields = baseFields;
    const concurrency = await readReviewConcurrency(deps.env.DB, workspaceId, {
      // ConsumerLog is contravariant against the reader's log: adapt on this
      // side instead of widening the reader — its fields ride this channel.
      warn: (readerFields, msg) => deps.log.warn({ ...admissionFields, ...readerFields }, msg),
    });
    // The Check lane's scope (§7.10) — the same App/PR identity the
    // publication journal and the attempt key use, derivable from the payload
    // alone. Declared HERE because the admission-time Check claim needs it
    // before the container and the checkout.
    const lifecycleScope: Scope = {
      appId: payload.appRef.appId,
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
    };
    const inflightKey: InflightKey = {
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      workspace_id: workspaceId,
    };
    const attemptId = crypto.randomUUID();
    const ttlSeconds = reviewGuardTtlSeconds(level);
    const admission = await acquireInflight(deps.env.DB, inflightKey, {
      // Each cap binds to its own predicate: `system` bounds the global live
      // count, `workspace` the tenant's — never the effective min here.
      systemCap: concurrency.system,
      workspaceCap: concurrency.workspace,
      attemptId,
      ttlSeconds,
      // The commit this attempt reviews (`null` for a comment trigger): the
      // row carries it so a later conflicting delivery can tell whether the
      // live review covers its own sha.
      headSha: payload.head_sha ?? null,
      now: new Date().toISOString(),
    });
    if (!admission.ok) {
      // §1.3 observability: one admission decision, one refusal record — the
      // caps are the ones this decision was measured against. An `error` also
      // carries its cause: the store answers the same code for a dead D1
      // binding and for a capacity released between its two statements.
      const errorCause = admission.reason === "error" ? describeInflightError(admission.cause) : undefined;
      const refusal: AdmissionRefusalFields = {
        reason: admission.reason,
        system_cap: concurrency.system,
        workspace_cap: concurrency.workspace,
        error_cause: errorCause,
      };
      if (errorCause !== undefined) {
        // Fail closed (spec §1.3): a storage failure never admits, and the
        // store has no log channel — the operator line is this one.
        deps.log.warn(
          { ...baseFields, ...refusal },
          `review admission failed (storage error: ${errorCause}) — treating as held; no review admitted`,
        );
      }
      // A cap/error refusal that never recovers is recorded when the job is
      // finally dropped (handleGuardHeld's terminal ack): recording every
      // refused attempt would write "failure" rows for reviews that a later
      // delayed attempt goes on to complete. `pr-held` carries the live row's
      // sha so that ack can tell a duplicate from a commit it never covers.
      return {
        kind: "guard-held",
        admission: refusal,
        heldHeadSha: admission.reason === "pr-held" ? admission.heldHeadSha : null,
        level,
      };
    }
    inflight = { key: inflightKey, attemptId, ttlSeconds };
    // §7.7 step 4 / §7.9: the Check attempt is claimed at ADMISSION — before
    // the container, the token mint and the clone — so the run appears when the
    // review starts working instead of minutes later. The SHA is the payload's
    // (`pull_request`) or the PR head watermark (`issue_comment`); when neither
    // is readable the post-`rev-parse` block below owns the claim exactly as
    // before. The begin hook is isolated: a Check fault never costs a review.
    if (deps.checks !== undefined) {
      // §7.10 Check budgets: ONE read per message, taken only once this
      // message can actually produce a Check; every terminal path shares it.
      checkBudgets = await readCheckBudgets(deps.env.DB, {
        warn: (readerFields, msg) =>
          deps.log.warn({ ...(baseFields ?? payloadIdentityFields(payload)), ...readerFields }, msg),
      });
      const earlyHeadSha = payload.head_sha || (await readPrHead(deps, payload))?.headSha || null;
      if (earlyHeadSha !== null) {
        checkClaimAttempted = true;
        checkHandle = await beginCheck(lifecycleScope, githubAppId, earlyHeadSha);
      }
    }
    // 1. Sandbox + installation token (created lazily; destroyed in finally).
    // AL-6 stage window: container acquisition + every in-sandbox step below
    // (clone/rev-parse/diff/numstat/input-write) classify "sandbox" until the
    // runner step takes over. The installation-token mint is a GITHUB AUTH
    // call, not a sandbox step — it stays OUTSIDE the sandbox window so a
    // mint failure (bad App credentials, GitHub auth outage) records
    // stage "pipeline" and is never mis-tagged as a sandbox/infra failure.
    if (sandbox === null) {
      failureStage = "sandbox";
      sandbox = await deps.getSandbox(deps.env.SANDBOX, sandboxId);
    }
    failureStage = "pipeline";
    // Purpose-scoped sandbox read grant (§7.6 / RL-6): the mint is
    // repository-scoped read-only BY REQUEST, and the sandbox path only
    // proceeds on the RETURNED capabilities — assertSandboxGrant fails
    // closed on any broader grant (RL-6: the request is never presented as
    // proof of the response).
    const grant = await commenter.getInstallationToken({
      scope: {
        appId: payload.appRef.appId,
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
      },
      purpose: "sandbox-read",
    });
    assertSandboxGrant(grant, payload.repo);
    const token = grant.token;
    // SEC-01: seed the exact-value list with the minted token immediately —
    // a failure before the runner env is assembled (clone/diff/input steps)
    // still exact-redacts the token in the catch path.
    secretValues = [token];
    failureStage = "sandbox";
    const cmds = buildGitOpsCommands({
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      cloneDir: CLONE_DIR,
      diffPath: DIFF_PATH,
    });

    // 2. Clone the PR head branch. Git transport auth via scoped extraheader
    // env (bugbot A1 — git ignores GH_TOKEN, so private-repo clones failed
    // without this; same pattern as the smoke-entry git fallback). The header
    // is the GitHub-app token form `AUTHORIZATION: basic base64(x-access-token:<token>)`
    // (basic auth with username `x-access-token`) — NOT `Bearer <token>`,
    // which GitHub's git server rejects even on public repos (post-remediation
    // deploy finding; verified live). GH_TOKEN stays for the gh steps below.
    // Credentials are exec env only — never in the command string, never in
    // the image, never in logs.
    const clone = await sandbox.runCommand(cmds.clone, {
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`,
      },
      timeout: EXEC_TIMEOUT_GIT_MS,
    });
    if (clone.exitCode !== 0) {
      throw new Error(`clone failed: exit ${clone.exitCode}, stdout ${clone.stdout.length}B`);
    }

    // 3. AUTHORITATIVE sha: read the checked-out HEAD (bugbot A2). Everything
    // downstream — idempotency key, D1 row, posted commit_id, KV state — is
    // keyed off this sha, so diff/files/commit_id always describe the same
    // commit and a force-push mid-flight is captured here, not drifted.
    const rev = await sandbox.runCommand(cmds.checkedOutSha, { timeout: EXEC_TIMEOUT_GIT_MS });
    if (rev.exitCode !== 0 || rev.stdout.trim() === "") {
      throw new Error(`cannot resolve head sha: git exit ${rev.exitCode}, stdout ${rev.stdout.length}B`);
    }
    const headSha = rev.stdout.trim();

    // §7.7 step 4 / §7.9: resolve a CONTRADICTED claim against the
    // authoritative checkout HERE — before any dedup/journal early exit, so a
    // delivery whose claimed SHA was disproved can never close the wrong head's
    // run as `skipped`. (A message that had no knowable SHA at admission is a
    // different case: its claim stays at the post-capture fallback below, so a
    // duplicate or journal hand-off of a comment trigger never creates a run.)
    if (checkHandle !== null && checkHandle.headSha !== headSha) {
      const supersededHandle = checkHandle;
      checkHandle = null;
      deps.log.warn(
        fields ?? baseFields ?? payloadIdentityFields(payload),
        `check attempt superseded: claimed ${supersededHandle.headSha.slice(0, 7)}, checked out ${headSha.slice(0, 7)}`,
      );
      // Freeze the contradicted attempt's `superseded` intent and release it —
      // TWO fenced D1 writes (intent + release), no remote request. Its remote
      // send belongs to the minute recovery cron, so the new head's review
      // never waits on the Check hook.
      const handedOff = await abandonCheck(
        supersededHandle,
        "the checkout proved a newer commit than the claim",
        "superseded",
      );
      if (handedOff) {
        checkHandle = await beginCheck(lifecycleScope, githubAppId, headSha);
      } else {
        // The handoff failed, so the old attempt may still hold this
        // consumer's lease: claiming the new head anyway would put two live
        // consumer-owned claims on one invocation. A Check fault never blocks
        // the review — this message reviews the checked-out commit with NO
        // Check, and the old attempt's own deadline hands it to recovery.
        deps.log.warn(
          fields ?? baseFields ?? payloadIdentityFields(payload),
          `check supersede handoff failed — continuing the review for ${headSha.slice(0, 7)} with no Check`,
        );
      }
    }

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

    // 4. Dedup (§7.7 step 2, first half): already completed for this
    // checked-out sha → ack (no post, no insert). KV done-state first (B3),
    // then D1. Keyed off the checkout, so a force-push between delivery and
    // processing is never mis-deduped against the stale payload sha.
    const done = await kvDoneHit(deps.env.IDEMPOTENCY_KV, idemKey(key), fields, deps.log);
    if (done) {
      deps.log.info(fields, "KV idempotency hit — ack");
      // The claim now precedes this read, so the run it created must be closed
      // — and it must carry THIS head's existing result (inherited like an
      // empty increment), never a `neutral` that would mask a failing gate.
      await terminalizeCheck(null, "skipped", headSha);
      return { kind: "ok" };
    }
    const existing = await deps.store.findByIdempotencyKey(key);
    if (existing) {
      deps.log.info(fields, "idempotency hit — ack");
      await terminalizeCheck(null, "skipped", headSha);
      return { kind: "ok" };
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
      if (checkHandle !== null) {
        const nowMs = Date.now();
        const handoffFields = {
          ...fields,
          sandbox_id: sandboxId,
          attempt_id: checkHandle.attemptId,
          check_reason: "publication journal handoff",
        };
        try {
          if (
            !(await linkCheckPublication(
              deps.env.DB,
              checkHandle.attemptId,
              checkHandle.lease,
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
              checkHandle.attemptId,
              checkHandle.lease,
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
      }
      return { kind: "ok" };
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
    const usageEvent = {
      reviewId,
      // The durable identity of THIS attempt: a review may already hold earlier
      // rows, so the failure read-back below must ask by token, not by review.
      executionToken: crypto.randomUUID(),
      workspaceId,
      occurredAt: new Date().toISOString(),
    };
    try {
      // No retry: a replay of the SAME token is already idempotent (the unique
      // index rejects it), and a retry that minted a NEW token would be a
      // different execution by definition — a second count for one attempt. A
      // dropped row stays reconcilable through the `usage` failure row below.
      await recordUsageEvent(deps.env.DB, usageEvent);
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
      const applied: true | false | "unknown" = await hasUsageEventForExecutionToken(
        deps.env.DB,
        usageEvent.executionToken,
      ).catch(() => "unknown" as const);
      deps.log.warn(
        { ...fields, review_id: reviewId, workspace_id: workspaceId, usage_applied: applied },
        `usage_events insert failed (review continues): ${detail}`,
      );
      // The failure row is best-effort too — its own guard keeps a recording
      // failure from reaching the pipeline.
      try {
        await deps.failureStore.record({
          installation_id: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          pr_number: payload.pr_number,
          head_sha: headSha,
          stage: "usage",
          error: `usage_events insert failed: ${detail} ${JSON.stringify({
            reviewId,
            workspaceId,
            executionToken: usageEvent.executionToken,
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
    // ask GitHub whether it is an ancestor of this one. Only `ahead` is an
    // honest increment (base...head is then exactly the work since the last
    // review); `behind`/`diverged`/`identical`/a 404 after a force-push or any
    // non-zero exit keep the FULL diff. A failed base read degrades the same
    // way, but it is warned: a silent fallback would disable incremental
    // rounds forever with no trace.
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
          compareStatusCommand(payload.owner, payload.repo, incrementBase, headSha),
          { env: { GH_TOKEN: token }, timeout: EXEC_TIMEOUT_GIT_MS },
        );
        const status = compare.stdout.trim();
        if (compare.exitCode === 0 && status === "ahead") {
          sinceSha = incrementBase;
        } else {
          deps.log.info(
            { ...fields, increment_status: compare.exitCode === 0 ? status : `exit ${compare.exitCode}` },
            "incremental base not an ancestor of this head — reviewing the full diff",
          );
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
    const diff = await sandbox.runCommand(cmds.diff, { env: { GH_TOKEN: token }, timeout: EXEC_TIMEOUT_GIT_MS });
    if (diff.exitCode !== 0) {
      throw new Error(gitStageFailureDetail("diff", diff));
    }
    const diffRead = parseBoundedRead(diff.stdout);
    const diffText = diffRead.text ?? "";

    // Increment capture (numstat partition only): base...head replaces the
    // file AFTER the full diff text is already in memory, so the evidence
    // catalog above keeps proving prior findings against the whole PR.
    // Failure discipline is the diff text's own — a non-zero exit throws, an
    // unreadable/empty capture marks the round context-incomplete. Never a
    // silent fall back to the full diff: the `since` fact would then be a lie.
    // An empty bounded read is NOT decided here: as with the full diff, only
    // the same round's numstat tells a genuinely unchanged increment (empty
    // file) from a capture that delivered nothing. Until that read, an empty
    // capture counts as a failure — the conservative side, which also keeps the
    // recheck input unbuilt exactly as before.
    let incrementEmpty = false;
    if (sinceSha !== null) {
      const increment = await sandbox.runCommand(
        incrementDiffCommand(payload.owner, payload.repo, sinceSha, headSha, DIFF_PATH),
        { env: { GH_TOKEN: token }, timeout: EXEC_TIMEOUT_GIT_MS },
      );
      if (increment.exitCode !== 0) {
        throw new Error(gitStageFailureDetail("increment diff", increment));
      }
      const incrementRead = parseBoundedRead(increment.stdout);
      if (incrementRead.failure === "unreadable") {
        captureFailed = true;
        deps.log.warn(
          { ...fields, increment_capture: "unreadable", increment_since: sinceSha },
          `increment diff capture unreadable — context-unavailable (no evidence catalog; rows stay context-incomplete)`,
        );
      } else if (incrementRead.failure === null && incrementRead.text === "") {
        incrementEmpty = true;
        captureFailed = true;
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
    if (targets.length > 0 && !captureFailed) {
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
        // §7.3 cap measured on the SERIALIZED input — schema, headSha,
        // evidence, discussion, array brackets and separators included — so
        // the accepted document is exactly what the cap counts.
        const candidate = {
          schema: RECHECK_INPUT_SCHEMA,
          headSha,
          targets: [...included, target],
          evidence: nextEvidence,
          discussion,
        };
        // §7.3: an oversized whole target is accounted, never truncated.
        if (jsonByteLength(candidate) > RECHECK_INPUT_MAX_BYTES) continue;
        included.push(target);
        evidence = nextEvidence;
        for (const id of withRow) referenced.add(id);
      }
      const sentIds = new Set(included.map((target) => target.rowId));
      for (const target of candidates) if (!sentIds.has(target.rowId)) budgetExcluded.add(target.rowId);
      if (included.length > 0) {
        recheckInput = {
          schema: RECHECK_INPUT_SCHEMA,
          headSha,
          targets: included,
          evidence,
          discussion,
        };
      }
    }

    // §7.8: the seat's ask budget is an operator setting, read ONCE per message
    // and only when a recheck round will actually be asked, so a delivery with
    // no open rows pays nothing. It rides the runner input as its own top-level
    // field — the `mstar.recheck-input/v1` document stays frozen.
    let recheckAssignmentMaxBytes: number | undefined;
    if (recheckInput !== undefined) {
      const budget = await getRecheckAssignmentMaxBytes(deps.env.DB);
      recheckAssignmentMaxBytes = budget.maxBytes;
      // A degraded read answers the documented default and owes the operator
      // one structured warn (the level/concurrency readers' contract).
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
    }

    // 6. §7.7 step 4 — the Check claim was made at ADMISSION. What remains is
    // the FALLBACK (no SHA was knowable there) and the SUPERSEDE check: the
    // authoritative checkout is the only SHA the review itself will use.

    // 6. §7.7 step 4 — the fallback claim for a message whose SHA was not
    // knowable at admission (a comment trigger with no readable head
    // watermark): it lands here, after dedup/journal handed their duplicates
    // off, BEFORE model work. Absent `checks` dep = no Checks; hook failure is
    // isolated and cannot prevent the review (step 5).
    if (deps.checks !== undefined && !checkClaimAttempted) {
      checkClaimAttempted = true;
      checkHandle = await beginCheck(lifecycleScope, githubAppId, headSha);
    }

    // 6. Numstat of the PR diff — `git apply --numstat` reads the unified
    // diff without applying it. The lines ("<add>\t<del>\t<path>") are the
    // runner's seat-partition universe (reconFacts convention). On an
    // incremental round the file holds base...head, so the seats partition the
    // work done since the last review instead of the whole PR.
    const numstat = await sandbox.runCommand(cmds.numstat, { timeout: EXEC_TIMEOUT_GIT_MS });
    if (numstat.exitCode !== 0) {
      throw new Error(gitStageFailureDetail("numstat", numstat));
    }
    const numstatLines = numstat.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "");

    // An ELIGIBLE base plus two empty reads of the SAME increment file means
    // `base...head` has no changes: the prior round already covers this head's
    // content, so there is nothing to review. A verdict over an empty file
    // universe would be an assertion about nothing — and a `context-incomplete`
    // flag would wrongly exclude this head as a future increment base — so the
    // round acks instead: no publication, no review row. The Check carries the
    // REVIEWED head's result against the current gate (an empty commit must
    // never launder a failing baseline into a neutral required check). Empty
    // stdout with a NON-empty numstat is the capture failure right below, which
    // keeps its context-incomplete accounting.
    if (sinceSha !== null && incrementEmpty && numstatLines.length === 0) {
      deps.log.info(
        { ...fields, event: "review_no_increment", increment_since: sinceSha },
        `no increment to review — ${sinceSha.slice(0, 7)}..${headSha.slice(0, 7)} is empty and the last reviewed head already covers this content; acking without a new review`,
      );
      await terminalizeCheck(null, "skipped", sinceSha);
      return { kind: "ok" };
    }
    if (sinceSha !== null && incrementEmpty) {
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
    // `no-evidence`. Both empty is a genuinely empty PR: a normal round.
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
    // The resolved image's capability hosts ride ALWAYS (keyless
    // registry data) — the in-image synthesizer's base (it cannot import the
    // contract: the runner module graph stays inside packages/runner/src +
    // packages/shared/src, tests/review/runtime-boundary).
    // PR context for the report seat (best-effort): the description plus the
    // issues it closes/references, read through gh with the same exec env the
    // diff uses. Bounded by the round's own clock (each read can burn its whole
    // PR_CONTEXT_EXEC_TIMEOUT_MS window) and gated so the level's runner budget
    // AND the post-runner bounded reads survive the capture; any failure or a
    // budget skip resolves undefined (with one named warn) so the published
    // report sections degrade to `none` — a narrative gap never fails a review.
    const prContext = await capturePrContext(
      sandbox,
      payload,
      token,
      deps.log,
      fields,
      level,
      roundStartedAt + deps.roundBudgetMs,
    );

    const runnerInput = {
      worktreePath: CLONE_DIR,
      reconFacts,
      capabilityHosts: sandboxImage.hosts,
      ...(modelOverrides !== undefined ? { modelOverrides } : {}),
      ...(customProviders !== undefined
        ? { customProviders: customProviders.map(toRunnerCustomProvider) }
        : {}),
      // §7.8: the typed recheck input rides ONLY when open rows
      // exist — a first round with an empty lifecycle serializes
      // byte-identically to the pre-recheck payload.
      ...(recheckInput !== undefined ? { recheck: recheckInput } : {}),
      // The seat's ask budget: a top-level runner field, never part of the
      // frozen recheck document.
      ...(recheckAssignmentMaxBytes !== undefined ? { recheckAssignmentMaxBytes } : {}),
      // The report seat's untrusted input. Absent when gh could not answer,
      // so no report is attempted and the sections render `none`.
      ...(prContext !== undefined ? { prContext } : {}),
    };
    // The document rides the exec stdin pipe: as an argv string it became one
    // argument, and a recheck round above ~98 KiB breaches Linux's 128 KiB cap.
    const writeInput = await sandbox.runCommand(writeJsonCommand(RUNNER_INPUT_PATH), {
      stdin: toBase64Utf8(JSON.stringify(runnerInput)),
      timeout: EXEC_TIMEOUT_GIT_MS,
    });
    if (writeInput.exitCode !== 0) {
      throw new Error(`runner input write failed: exit ${writeInput.exitCode}`);
    }

    // 8. In-image runner: cwd = clone dir; harness paths + the App's model
    // chain via exec env, and the App's own provider keys via the exec STDIN
    // credential payload (compass D, AL-24-5: per-App BYOK only, zero global
    // fallback; key_source app|custom logging; secrets never baked into the
    // image, never in logs, never in the process environment). The runtime
    // runner has NO summary-degrade path: exit 0 ⇒ stdout is the
    // engine-validated mstar.review/v1 envelope.
    // AL-6 stage window: the review run itself — a non-zero exit or an exec
    // exception (timeout / container error) here classifies "runner".
    failureStage = "runner";
    runnerStartedAt = Date.now();
    // SEC-01 exact-value defense: the SAME credential resolution the runner
    // exec used is captured here (single source — no re-resolution
    // split-brain) so the session's actual secret values can be
    // exact-redacted from any model-echoed output below.
    const runnerEnv = buildRunnerEnv(appCfg);
    const credentials = buildRunnerCredentials(appCfg, deps.log, fields, customProviders);
    // SEC-01 exact-value defense: the session's ACTUAL secret values (the
    // transported provider keys + the minted installation token) — needed by
    // the failure message below and shared by the degrade and success paths.
    secretValues = sessionSecretValues(runnerEnv, credentials.keyValues, token);
    // §7.8: with a recheck input the runner gains `--recheck-out` — the seat
    // writes its validated document to the audited fixed path before the
    // envelope reaches stdout. `--report-out` rides whenever the report seat
    // has context to work with.
    const runnerCmd = runnerCommand(
      RUNNER_PATH,
      level,
      RUNNER_INPUT_PATH,
      recheckInput !== undefined ? RECHECK_OUTPUT_PATH : undefined,
      prContext !== undefined ? REPORT_OUTPUT_PATH : undefined,
    );
    const run = await sandbox.runCommand(runnerCmd, {
      cwd: CLONE_DIR,
      env: runnerEnv,
      // The credential payload rides the exec STDIN pipe — present only when
      // the App actually transported a key (keyless run shape = no stdin).
      ...(credentials.payload === undefined ? {} : { stdin: credentials.payload }),
      timeout: runnerTimeoutMs(level),
    });
    const runnerElapsedMs = Date.now() - runnerStartedAt;
    if (run.exitCode !== 0) {
      throw new Error(runnerFailureDetail(run, secretValues));
    }
    // d5-budget AC-S10-logs: one runner attempt → at least one budget line
    // (level + runner_timeout_ms + elapsed_ms + orchestration). elapsed_ms is
    // VISIBILITY ONLY — it never throws; the sandbox exec timeout above is
    // the only wall-clock failure (spec 不 abort).
    deps.log.info(
      { ...fields, elapsed_ms: runnerElapsedMs },
      `runner finished in ${runnerElapsedMs}ms (budget ${runnerTimeoutMs(level)}ms)`,
    );

    // AL-6 stage window: post-runner steps (parse has its own branch; the
    // post/KV/put orchestration is worker-side) are "pipeline" again.
    failureStage = "pipeline";

    // §7.7 step 5 (cont): read the concurrent recheck seat's document AND its
    // status through the audited fixed-path bounded reads (§7.3: Worker
    // validates against ITS OWN trusted input — never a model echo). Anything
    // other than a valid document is NO recheck; the round proceeds with every
    // selected row conservatively accounted (§7.4), and the seat's status makes
    // that loss attributable in D1. Rows the gate dropped are carried as
    // rejected — by rowId when it had one, by position among the unanswered
    // sent rows when it did not — so they are never mistaken for rows the seat
    // never reached.
    const recheck = recheckInput !== undefined ? await readRecheckDoc(sandbox, recheckInput) : null;
    const recheckDoc = recheck?.doc ?? null;
    const rejectedRowIds = recheck?.rejected ?? new Set<string>();
    const anonymousRejectedRows = recheck?.anonymousRejectedRows ?? 0;

    // The report document (mstar.report/v1) rides the SAME audited bounded read
    // and the SAME fail-closed rule: the Worker validates it against its own
    // gate and falls back to `none` headings, or null when the seat wrote
    // nothing. Read only when the runner was actually given `--report-out`.
    const report: ReportDoc | null =
      prContext !== undefined ? await readReportDoc(sandbox, secretValues, headSha, deps.log, fields) : null;

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
      const redactedError = redactExactSecrets(redactSecrets(parsed.error), secretValues);
      const redactedStdout = redactExactSecrets(redactSecrets(run.stdout), secretValues);
      try {
        await deps.failureStore.record({
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
      const degradedOutcome = await publishDegradedPublication({
        db: deps.env.DB,
        commenter,
        scope: lifecycleScope,
        headSha,
        redactedError,
        redactedStdout,
      });
      if (degradedOutcome.phase === "failed") {
        await terminalizeCheck(null, "degraded-not-posted");
      } else {
        await terminalizeCheck(degradedOutcome.publicationId, "publication-unknown");
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
      return { kind: "degraded" };
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
      clampFindingSizes(redactReviewOutputExact(redactReviewOutput(parsed.output), secretValues)),
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
      discussion,
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
        secretValues,
      ).slice(0, RECHECK_STATUS_ERROR_MAX_CHARS);
      deps.log[recheckDoc === null && !roundCancelled ? "warn" : "info"](
        {
          ...fields,
          recheck_outcome: recheckOutcome,
          // Same wrapper as `error`: a seat-authored `reason` can echo a
          // credential exactly like `error` can.
          recheck_reason: status?.reason === null || status?.reason === undefined
            ? null
            : redactExactSecrets(redactSecrets(status.reason), secretValues),
          recheck_error: status?.error === null || status?.error === undefined
            ? null
            : redactExactSecrets(redactSecrets(status.error), secretValues),
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
           WHERE app_id = ? AND installation_id = ? AND owner = ? AND repo = ? AND pr_number = ?
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
    for (const finding of qualifying) {
      const rowId = seenRowIdByFindingId.get(computeFindingFingerprint(finding));
      if (rowId === undefined) continue; // unreachable — seen covers every finding
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
          body: renderLineCommentText(finding),
        }),
      );
    }

    const lifecycleRound: LifecycleRound = {
      selectedRowIds: targets.map((t) => t.rowId),
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
        appId: payload.appRef.appId,
        model: chainHeadSelector(effectiveModelChain(appCfg).chain),
        provider: null,
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
      await terminalizeCheck(null, "pre-publication-failure");
      return { kind: "ok" };
    }
    const stagedId = staged.id;

    // 13. §7.7 step 8 — epoch-fenced claim, phase sending, publish the EXACT
    // prepared upsert, validate the response id, persist proof BEFORE KV
    // done. A response/proof loss retains the staged payload for read-only
    // discovery — never a second paid review, never a blind re-send.
    const lease = await claimPublication(deps.env.DB, stagedId, `consumer:${sandboxId}`, Date.now());
    if (lease === null) {
      throw new Error("publication journal claim failed — refusing to send without the epoch-fenced lease");
    }
    sendAttempt = { publicationId: stagedId };
    let sent: { commentId: number };
    try {
      sent = await commenter.postPreparedReview({
        installationId: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        prNumber: payload.pr_number,
        headSha,
        round,
        targetCommentId: plan.action === "update" ? plan.commentId : null,
        body: preparedBody,
        publicationId: stagedId,
      });
    } catch (err) {
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
        await terminalizeCheck(null, "pre-publication-failure");
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
      await terminalizeCheck(stagedId, "publication-unknown");
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
      await terminalizeCheck(stagedId, "publication-unknown");
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
    if (reconciled.resolutions.length > 0) {
      const assocPlaceholders = reconciled.resolutions.map(() => "?").join(",");
      const assocRows = await deps.env.DB
        .prepare(`SELECT id, intent_json FROM review_threads WHERE id IN (${assocPlaceholders})`)
        .bind(...reconciled.resolutions.map((r) => r.associationId))
        .all<{ id: string; intent_json: string }>();
      const intentById = new Map(assocRows.results.map((row) => [row.id, row.intent_json]));
      let inlineResolveBudgetMs = INLINE_RESOLVE_BUDGET_MS;
      let inlineResolveAttempts = 0;
      for (const resolution of reconciled.resolutions) {
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
    await terminalizeCheck(stagedId, "publication-unknown");
    return { kind: "ok" };
  } catch (err) {
    // §7.7 step 12 on the failure path: a Check begun at step 4 must
    // terminalize even when the pipeline throws. After a send ATTEMPT the
    // publication status is unknown (the request may have landed); before
    // any send the honest outcome is pre-publication-failure. Isolated —
    // never masks the throw.
    if (sendAttempt !== null) {
      await terminalizeCheck(sendAttempt.publicationId, "publication-unknown");
    } else {
      await terminalizeCheck(null, "pre-publication-failure");
    }
    // Structured failure log carrying the idempotency key + sandbox id
    // (the failure log must carry the idempotency key: 失败路径错误日志含幂等键), then
    // rethrow so the worker retries and eventually DLQs.
    const detail = err instanceof Error ? err.message : String(err);
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
        ...(runnerStartedAt === undefined ? {} : { elapsed_ms: Date.now() - runnerStartedAt }),
      },
      `review failed: ${detail}`,
    );

    // AL-6: best-effort review_failures row BEFORE the
    // rethrow — DLQ-bound infra failures otherwise leave zero D1 trace (the
    // audit blind spot). `stage` = the coarse phase in flight
    // (failureStage); rows are per-attempt events (a DLQ'd message leaves
    // up to 4: 1 initial delivery + max_retries = 3 retries). The insert
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
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        // The authoritative sha once the checkout resolved it; before that
        // the payload sha, else "" (= never resolved).
        head_sha: fields?.head_sha ?? payload.head_sha ?? "",
        stage: failureStage,
        error: redactExactSecrets(redactSecrets(persistedDetail), secretValues),
      });
    } catch (recordErr) {
      const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      deps.log.warn(
        fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
        `review_failures insert failed (rethrow unchanged): ${recordDetail}`,
      );
    }

    // This delivery is the last one the queue will make (the next stop is the
    // DLQ), so the commit will never be reviewed: overwrite its idempotency
    // key with "failed" (the worker's claim TTL) so neither the worker's
    // pre-check nor the supersede skip keeps treating the stale "1" as proof.
    // Keyed off the PAYLOAD sha — the same sha the worker claimed.
    // `putAbandonClaim` never downgrades a completed review. Best-effort: a KV
    // fault only leaves "1" behind, which the failure row above traces, and it
    // never masks the rethrow.
    if (attempts >= QUEUE_MAX_ATTEMPTS && payload.head_sha) {
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
      } catch (kvErr) {
        const kvDetail = kvErr instanceof Error ? kvErr.message : String(kvErr);
        deps.log.warn(
          fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
          `failed-claim KV write failed (the skip may still treat this commit as queued): ${kvDetail}`,
        );
      }
    }
    throw err;
  } finally {
    // Destroy FIRST, then release the admission row. Releasing first would let
    // the next attempt for this PR acquire the slot and start its container
    // while this one is still alive, so live containers could exceed
    // min(system, workspace) by the destroy latency. Both blocks warn only.
    if (sandbox !== null) {
      try {
        await sandbox.destroy();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...(fields ?? baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
          `sandbox destroy failed: ${detail}`,
        );
      }
    }
    // Release the admission row once the review settled (posted, KV done,
    // put attempted) OR failed — either way the next attempt may proceed.
    // Scoped to THIS attempt's id, so an older attempt can never delete a row
    // a newer one reclaimed after expiry; a release failure only warns (the
    // row expires by TTL), never masks the review's own outcome.
    if (inflight !== null) {
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
  }
}
