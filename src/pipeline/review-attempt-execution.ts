
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
import { dropAllSuggestionFences, dropRedactedSuggestions, parseReviewOutput, capFindings, clampFindingSizes } from "../review/schema";
import type { BudgetExhaustedOutcome, ReviewFinding, ReviewOutput } from "../review/schema";
import type { ReviewLevel } from "../../packages/shared/src/runtime";
import { carriesSecretForm, redactExactSecrets, redactReviewOutput, redactReviewOutputExact, redactSecrets } from "./redact";
import { type D1ArtifactStore } from "../store/artifact-store";
import { type FailureStage, type FailureStore } from "../store/failure-store";
import {
  hasUsageEventForExecutionToken,
  recordUsageEvent,
  type UsageSource,
} from "../store/usage-store";
import { quotaMonth, resolveQuotaProfile, rpFor } from "../store/quota-store";
import { computeFindingFingerprint } from "../store/fingerprint";
import {
  CHECK_BACKOFF_MS,
  CHECK_LEASE_MS,
  attemptKey,
  claimCheckRecovery,
  deferCheckRecovery,
  getCheckAttempt,
  readCheckIdentity,
  readOpenCheckIdentityForKey,
  linkCheckPublication,
  recordTerminalizeOutcome,
  releaseCheckClaim,
  setCheckDesired,
} from "../store/review-checks";
import {
  beginAttemptSettlement,
  deliveryKeyOf,
  readAttemptCheckKey,
  readAttemptHandoff,
  recordSuccessorIntent,
  settleAttemptIfDischarged,
  settlementStatementIfDischarged,
  successorIntentOf,
  type SettlementEffect,
} from "../store/review-route-store";
import {
  applyPublishedLifecycle,
  captureLineComments,
  claimDegradedTarget,
  claimPublication,
  countRecheckableFindings,
  findPublicationJournal,
  hasUnprovenDegradedPublication,
  PUBLICATION_HANDOFF_PHASES,
  markPublicationFailed,
  readLineBatchState,
  recordPublicationProof,
  recordLineDispatchIntent,
  releaseDegradedTarget,
  releaseLineDispatch,
  releaseUnspentPublicationClaim,
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
  readAttemptActivation,
  reviewAttemptSandbox,
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
  PublicationAuthorityUnavailable,
  PublicationDeadlineSpent,
  renderLineCommentText,
  type ClosureRow,
  type CommenterEnv,
  type PostPreparedLineCommentsInput,
  type ReviewCommenter,
  type UpsertPlan,
} from "./comment";
import { createTargetsStore } from "../dashboard/targets-store";
import { getRecheckAssignmentMaxBytes } from "../dashboard/runtime-config-store";
import { type CustomProviderConsumerConfig } from "../dashboard/app-config-store";
import {
  CHECK_SUMMARIES,
  createCheckBeginLatch,
  decideConclusion,
  type CheckBeginLatch,
  type CheckPromotion,
  type CheckTerminalOutcome,
} from "./checks";
import { releaseInflight, type InflightKey, type InflightRefusal } from "../store/inflight-store";
import { type DegradedReason } from "./concurrency-reader";
import {
  CHECK_TERMINALIZE_DEFAULT,
  CHECK_UPDATE_DEFAULT,
  type CheckBudgets,
} from "./check-budgets-reader";
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
  SANDBOX: unknown;
  DASHBOARD_ENCRYPTION_KEY?: string;
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

type DiffCaptureDecline = {
  reason: DiffCaptureDeclineReason;
  step: string;
  run?: { stdout: string; stderr: string; exitCode: number };
};

/** Structured log fields: seven event fields + sandbox id + idempotency key
 * + the d5-budget visibility quartet (level / runner_timeout_ms /
 * elapsed_ms / orchestration — spec d5-budget L5: they ride THIS channel;
 * no new APM, no webhook sink). */
export type ConsumerLogFields = {
  event: "pull_request" | "issue_comment" | "review_paused" | "review_superseded" | "review_concurrency_degraded" | "review_check_budgets_degraded" | "review_attempt_cap_degraded" | "review_level_degraded" | "review_recheck_assignment_degraded" | "review_recheck_no_fit" | "review_no_increment" | "review_no_diff" | "review_unresolved" | "sandbox_teardown_unproven" | "review_succession_refused" | "check_terminalize_budget_exceeded" | "check_terminalize_failed" | "check_abandon_released" | "check_abandon_not_owned" | "check_abandon_failed" | "check_settlement_not_adopted" | "check_settlement_owed" | "review_moved_head" | "check_skip_settle_failed" | "check_queued_relabel_failed" | "check_in_progress_failed" | "maintenance_defer" | "review_workflow_create_ambiguous" | "review_moved_head_successor" | "review_moved_head_no_successor" | "review_successor_enqueue_failed";
  action: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  sandbox_id?: string;
  app_id?: string;
  target_id?: string;
  queue?: string;
  batch_size?: number;
  idempotency_key?: string;
  attempt_id?: string;
  prior_attempt_id?: string;
  succession?: "no-container" | "revoked" | "running" | "unavailable";
  check_reason?: string;
  check_recovery_owed?: boolean;
  review_id?: string;
  workspace_id?: string;
  effective?: number;
  max_bytes?: number;
  assignment_max_bytes?: number;
  required_bytes?: number;
  selected?: number;
  degraded_reason?: DegradedReason;
  reason?: InflightRefusal | "superseded";
  superseded_by_head_at?: string;
  system_cap?: number;
  workspace_cap?: number;
  error_cause?: string;
  usage_applied?: boolean | "unknown";
  level?: ReviewLevel;
  runner_timeout_ms?: number;
  runner_requested_ms?: number;
  runner_effective_ms?: number;
  runner_cutoff_ms?: number;
  runner_deadline_ms?: number;
  runner_work_units?: number | null;
  elapsed_ms?: number;
  orchestration?: "bun-fanout" | "parent";
  provider?: string;
  key_source?: "app" | "custom";
  config_source?: "app";
  line_comments_fallback?: boolean;
  degraded_delete_deleted?: number;
  degraded_delete_skipped?: number;
  dedup?: "degraded";
  recheck_outcome?: RecheckStatus["outcome"] | "absent";
  recheck_reason?: string | null;
  recheck_error?: string | null;
  rejected?: number;
  rejected_unnamed_ignored?: number;
  assessed?: number;
  diff_capture?: "empty" | "overflow" | "unreadable";
  diff_source?: "oversized-local";
  diff_fallback?: DiffCaptureDeclineReason;
  diff_fallback_step?: string;
  increment_status?: string;
  increment_since?: string;
  increment_base?: "lookup-failed";
  increment_capture?: "empty" | "unreadable" | "too_large";
  report_context?: ReportContextFailure;
  report_context_issue?: number;
  applied_model?: "absent" | "unreadable" | "overflow" | "empty" | "invalid-json" | "invalid-document";
  report_doc?: "absent" | "unreadable" | "overflow" | "empty" | "invalid-json" | "invalid-document" | "stale-head";
  report_doc_error?: string;
  report_doc_head_sha?: string;
  budget_outcome?: BudgetExhaustedOutcome;
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
  | { kind: "routed" }
  | {
      kind: "guard-held";
      admission: AdmissionRefusalFields;
      heldHeadSha: string | null;
      commentClaimConsumed: boolean;
      level: ReviewLevel;
    }
  | { kind: "paused" }
  | { kind: "degraded" }
  | { kind: "superseded" }
  | { kind: "budget-exhausted"; outcome: BudgetExhaustedOutcome }
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
  opts: { announceNoOp?: boolean; paused?: boolean } = {},
): Promise<void> {
  if (
    deps.checks?.settleSkipped === undefined ||
    attachedHeadSha === null ||
    attachedHeadSha === undefined ||
    payload.attachDeliveryId === undefined
  ) {
    if (opts.announceNoOp) {
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
      attachDeliveryId: payload.attachDeliveryId,
      reason,
      ...(opts.paused === true ? { paused: true } : {}),
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

async function settleAttemptPublication(
  deps: ProcessDeps,
  attemptId: string,
  fields: ConsumerLogFields,
  landed: readonly SettlementEffect[],
): Promise<void> {
  try {
    await settleAttemptIfDischarged(deps.env.DB, { attemptId, landed }, Date.now());
  } catch (err) {
    deps.log.warn(
      fields,
      `attempt settlement mark failed — the attempt stays unsettled in the duration report: ${err instanceof Error ? err.message : String(err)}`,
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
    latch?: CheckBeginLatch;
  }): Promise<CheckHandle | null>;
  markInProgress?(input: {
    handle: CheckHandle;
    summary: string;
    updateBudgetMs: number;
    warn: (detail: string) => void;
  }): Promise<CheckPromotion>;
  terminalize(input: { handle: CheckHandle; publicationId: string | null;
    outcome: CheckTerminalOutcome;
    inheritedHeadSha?: string;
    budgetExhaustion?: BudgetExhaustedOutcome;
    updateBudgetMs: number }): Promise<void>;
  abandonTerminalize?(input: {
    handle: CheckHandle;
    reason: string;
    outcome?: CheckTerminalOutcome;
    budgetExhaustion?: BudgetExhaustedOutcome;
    inheritedHeadSha?: string;
    firstRecoveryDelayMs?: number;
  }): Promise<boolean>;
  settleSkipped?(input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    attachDeliveryId?: string;
    reason: string;
    warn?: (detail: string) => void;
    updateBudgetMs?: number;
  }): Promise<boolean>;
  markQueuedBehindInflight?(input: {
    scope: Scope;
    headSha: string;
    triggeredBy: string;
    action: string;
    attachDeliveryId?: string;
    summary: string;
    updateBudgetMs: number;
    warn: (detail: string) => void;
  }): Promise<boolean>;
};

const RECHECK_CATALOG_MAX_BYTES = 262_144;
const RECHECK_SLICE_MAX_LINES = 80;
const RECHECK_SLICE_MAX_BYTES = 8 * 1024;
const RECHECK_SLICES_PER_TARGET = 4;
const RECHECK_INPUT_MAX_BYTES = 512 * 1024;
const RECHECK_INPUT_SCHEMA = "mstar.recheck-input/v1";

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
  promise.catch(() => {});
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function truncatedBody(body: string, length: number): string {
  const cut = Math.max(0, Math.min(length, body.length));
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
  return findPublicationJournal(db, { scope, headSha, phases: PUBLICATION_HANDOFF_PHASES });
}

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
    const lease = await claimPublication(db, id, `consumer-journal-apply:${id}`, nowMs, "confirmed");
    if (lease === null) return false;
    let applied = false;
    try {
      const at = Date.now();
      const publication = await readPublication(db, id);
      if (publication === null) return false;
      const attemptId = publication.payload.attemptId;
      const settlement =
        attemptId === undefined
          ? null
          : await settlementStatementIfDischarged(
              db,
              {
                attemptId,
                publicationId: id,
                landed: ["publication"],
              },
              at,
            );
      applied = await applyPublishedLifecycle(db, id, lease, at, undefined, () =>
        settlement === null ? [] : [settlement],
      );
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
  const readBudget = (): number | null => {
    const left = Math.min(PR_CONTEXT_EXEC_TIMEOUT_MS, runnerDeadlineMs - Date.now());
    return left > 0 ? left : null;
  };
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

type HunkLine = { old: number | null; new: number | null; oldBefore: number; newBefore: number; text: string };

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
  deleted: boolean;
  oldBlobOid: string | null;
  headBlobOid: string | null;
  hunks: ParsedDiffHunk[];
};

function parseUnifiedDiffFiles(diffText: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let hunk: ParsedDiffHunk | null = null;
  let remainingOld = 0;
  let remainingNew = 0;
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
    if (file.deleted) return [];
    const drafts: Draft[] = [];
    for (let from = 0; from < hunk.lines.length; from += RECHECK_SLICE_MAX_LINES) {
      drafts.push(windowDraft(file, hunk, from, Math.min(from + RECHECK_SLICE_MAX_LINES, hunk.lines.length)));
    }
    return drafts;
  };

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
      excludedTargets.add(target.rowId);
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
        included += 1;
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
      if (catalogDenied) catalogBudgetExcluded.add(target.rowId);
      else excludedTargets.add(target.rowId);
    } else sliceIdsByRowId.set(target.rowId, referenced);
  }
  return { slices, excludedTargets, catalogBudgetExcluded, sliceIdsByRowId };
}

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

type OriginalFindingProjection = RecheckTarget["original"];

function reconcileRecheckRound(input: {
  targets: RecheckTarget[];
  doc: RecheckDoc | null;
  status: RecheckStatus | null;
  discussion: Discussion;
  output: ReviewOutput;
  staleContext: boolean;
  catalogExcluded: ReadonlySet<string>;
  catalogBudgetExcluded: ReadonlySet<string>;
  budgetExcluded: ReadonlySet<string>;
  rejectedRowIds: ReadonlySet<string>;
  anonymousRejectedRows: number;
}): {
  assessments: Assessment[];
  outcomeByRowId: Map<string, Assessment>;
  resolutions: { associationId: string; verified: VerifiedResolution }[];
  assessedCount: number;
  invalidOutputCount: number;
  unansweredCount: number;
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

  const emptyResultRound = status?.reason === "empty-result";

  for (const target of targets) {
    const docResult = doc?.results.find((r) => r.rowId === target.rowId) ?? undefined;
    const neverSent =
      catalogExcluded.has(target.rowId) ||
      catalogBudgetExcluded.has(target.rowId) ||
      budgetExcluded.has(target.rowId);
    const rejected =
      rejectedRowIds.has(target.rowId) ||
      anonymouslyRejected.has(target.rowId) ||
      (emptyResultRound && docResult === undefined && !neverSent);
    let assessment: Assessment;
    if (staleContext) {
      assessment = forceUnverifiable(target.rowId, "context-incomplete");
    } else if (catalogExcluded.has(target.rowId)) {
      assessment = forceUnverifiable(target.rowId, "no-evidence");
    } else if (catalogBudgetExcluded.has(target.rowId)) {
      assessment = forceUnverifiable(target.rowId, "budget");
    } else if (rejected) {
      assessment = forceUnverifiable(target.rowId, "invalid-output");
    } else if (docResult === undefined) {
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
        assessment = forceUnverifiable(target.rowId, "conflict");
      } else {
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
    if (docResult !== undefined || rejected) assessments.push(assessment);
  }

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
    unansweredCount: targets.length - assessedCount - invalidOutputCount,
    anonymousRejectedCount,
  };
}

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

type DegradedPublicationOutcome =
  | { phase: "confirmed"; publicationId: string }
  | { phase: "unknown"; publicationId: string }
  | { phase: "failed"; reason: string; publicationClosed: boolean };

function refusePublicationPastDeadline(deadlineMs: number): void {
  const lateMs = Date.now() - deadlineMs;
  if (lateMs < 0) return;
  throw new RoundBudgetSpent(
    `round budget spent: no first publication ${lateMs}ms past the attempt's frozen deadline`,
    "runner",
  );
}

async function publishDegradedPublication(input: {
  db: PipelineEnv["DB"];
  commenter: ReviewCommenter;
  scope: Scope;
  headSha: string;
  admittedAttemptId: string;
  attemptId: string;
  checkAttemptId?: string;
  redactedError: string;
  redactedStdout: string;
  notAfterMs: number;
}): Promise<DegradedPublicationOutcome> {
  const { commenter } = input;
  const target = {
    installationId: input.scope.installationId,
    owner: input.scope.owner,
    repo: input.scope.repo,
    prNumber: input.scope.prNumber,
  };
  let targetRef: { commentId: number } | null = null;
  let targetLease: Lease | null = null;
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
      attemptId: input.attemptId,
      admittedAttemptId: input.admittedAttemptId,
    };
    targetRef = plan.action === "update" ? { commentId: plan.commentId } : null;
    if (targetRef !== null) {
      targetLease = await claimDegradedTarget(input.db, {
        scope: input.scope,
        commentId: targetRef.commentId,
        holder: `degraded-stage:${publicationId}`,
        nowMs: Date.now(),
      });
      if (targetLease === null) {
        return {
          phase: "failed",
          reason: `the degraded target ${targetRef.commentId} is held by its cleanup (or its delete is unresolved) — the notice was not staged`,
          publicationClosed: true,
        };
      }
    }
    const staged = await stagePublication(input.db, { id: publicationId, payload, nowMs: Date.now() });
    if (staged.id !== publicationId) {
      return {
        phase: "failed",
        reason: `publication journal conflict (existing row ${staged.id}, phase ${staged.phase}) — the immutable payload wins; not sending a second degraded notice`,
        publicationClosed: true,
      };
    }
    const lease = await claimPublication(input.db, staged.id, `consumer-degraded:${staged.id}`, Date.now(), "prepared");
    if (lease === null) {
      return { phase: "failed", reason: "publication journal claim failed — degraded notice not sent", publicationClosed: false };
    }
    let sent: { posted: boolean; commentId: number | null };
    try {
      sent = await commenter.postPreparedDegraded({
        ...target,
        appId: input.scope.appId,
        headSha: input.headSha,
        round: plan.round,
        targetCommentId: plan.action === "update" ? plan.commentId : null,
        body,
        publicationId: staged.id,
        notAfterMs: input.notAfterMs,
        journalClaim: lease,
        ...(input.checkAttemptId === undefined ? {} : { attemptId: input.checkAttemptId }),
      });
    } catch (err) {
      if (err instanceof PublicationDeadlineSpent) {
        throw new RoundBudgetSpent(`round budget spent: ${err.message}`, "runner");
      }
      if (err instanceof PublicationAuthorityUnavailable) {
        try {
          await releaseUnspentPublicationClaim(input.db, staged.id, lease, Date.now());
        } catch {
        }
        return { phase: "unknown", publicationId: staged.id };
      }
      if (err instanceof PreparedSendRejected) {
        let publicationClosed = false;
        try {
          publicationClosed = await markPublicationFailed(input.db, staged.id, lease, err.message, Date.now());
        } catch {
          publicationClosed = false;
        }
        return { phase: "failed", reason: err.message, publicationClosed };
      }
      return { phase: "unknown", publicationId: staged.id };
    }
    const proof = {
      publicationId: staged.id,
      scope: input.scope,
      headSha: input.headSha,
      kind: "degraded" as const,
      round: plan.round,
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
      const at = Date.now();
      const settlement = await settlementStatementIfDischarged(
        input.db,
        { attemptId: input.attemptId, publicationId: staged.id, landed: ["publication"] },
        at,
      );
      applied = await applyPublishedLifecycle(input.db, staged.id, lease, at, undefined, () =>
        settlement === null ? [] : [settlement],
      );
    } catch {
      applied = false;
    }
    if (!applied) {
      return { phase: "unknown", publicationId: staged.id };
    }
    return { phase: "confirmed", publicationId: staged.id };
  } catch (err) {
    if (err instanceof RoundBudgetSpent) throw err;
    return { phase: "failed", reason: err instanceof Error ? err.message : String(err), publicationClosed: false };
  } finally {
    if (targetRef !== null && targetLease !== null) {
      await releaseDegradedTarget(input.db, {
        scope: input.scope,
        commentId: targetRef.commentId,
        lease: targetLease,
        nowMs: Date.now(),
        keep: false,
      });
    }
  }
}

export type ProcessDeps = {
  env: PipelineEnv;
  store: D1ArtifactStore;
  targets: ReturnType<typeof createTargetsStore>;
  failureStore: FailureStore;
  appCommenters: Map<string, { commenter: ReviewCommenter; fingerprint: string; githubAppId: number }>;
  createAppCommenter: (cred: CommenterEnv) => ReviewCommenter;
  log: ConsumerLog;
  getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
  checks?: CheckLifecycleHooks;
  background?: CheckBackgroundSink;
  selectPrHead: (input: {
    targetId: string;
    owner: string;
    repo: string;
    prNumber: number;
  }) => Promise<{ headSha: string | null; headAt: string | null } | null>;
  findIncrementBase: (db: PipelineEnv["DB"], scope: Scope) => Promise<string | null>;
  attemptCapMs?: number;
  runnerConfigs: Map<string, RunnerConfig>;
  checkSettlements: Map<string, CheckSettlement>;
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
    app_id: payload.botRef.appId,
    target_id: payload.targetId,
  };
}

function gitStageFailureDetail(
  stage: string,
  run: { stdout: string; stderr: string; exitCode: number },
  secretValues: readonly string[],
): string {
  const base = `${stage} failed: exit ${run.exitCode}, stdout ${new TextEncoder().encode(run.stdout).length}B`;
  const tail = redactExactSecrets(redactSecrets(run.stderr), secretValues).trim().slice(-STDERR_TAIL_MAX);
  return tail === "" ? `${base}, stderr empty` : `${base}, stderr tail: ${tail}`;
}

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
  const stepTimeout = (): number | null => {
    const left = Math.min(PR_CONTEXT_EXEC_TIMEOUT_MS, diffCaptureDeadlineMs - Date.now());
    return left > 0 ? left : null;
  };
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
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(deps.fields, `unbound thread read failed — binding left to a later round: ${detail}`);
    return result;
  }
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
  attemptId: string;
  payload: ReviewJobPayload;
  level: ReviewLevel;
  roundStartedAt: number;
  deadlineMs: number;
  githubAppId: number;
  usageWorkspaceId: string;
  usageSource: UsageSource;
  checkBudgets: CheckBudgets | null;
  checkClaimSha: string | null;
  inflight: { key: InflightKey; attemptId: string; ttlSeconds: number };
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
  runnerEffectiveBudgetMs: number | undefined;
  changedLines: number | null;
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
  fields?: ConsumerLogFields;
  promotionAbandoned: string | null;
  terminalized: boolean;
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
  payload: ReviewJobPayload;
  attemptId: string;
  checkBudgets: CheckBudgets | null;
  deadlineMs: number;
};

/** A phase's early settlement: the attempt owes nothing more. */
export type SettledAttempt = { kind: "settled"; outcome: ProcessOutcome };

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
  runnerDeadlineMs: number;
  runnerRequestedMs: number;
  runnerEffectiveMs: number;
  budget: {
    requested_ms: number;
    effective_ms: number;
    cutoff_ms: number;
    deadline_ms: number;
    work_units: number | null;
  };
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
  const baseLog = (): ConsumerLogFields => toBaseFields(payload);
  const roundLog = (): ConsumerLogFields => settlement.fields ?? baseLog();
  const abandonCheck = (
    handle: CheckHandle,
    reason: string,
    options?: { outcome?: CheckTerminalOutcome; inheritedHeadSha?: string; budgetExhaustion?: BudgetExhaustedOutcome },
  ): Promise<boolean> => {
    const abandon = deps.checks?.abandonTerminalize;
    if (abandon === undefined) return Promise.resolve(false);
    const line = {
      ...baseLog(),
      sandbox_id: sandboxId,
      attempt_id: handle.attemptId,
      check_reason: reason,
    };
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
    const budgets = checkBudgets ?? {
      terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
      updateMs: CHECK_UPDATE_DEFAULT,
      degraded: false,
    };
    let abandoned = false;
    let giveUpRelease: Promise<boolean> | undefined;
    const startedMs = Date.now();
    const record = (outcome: "completed" | "budget-exceeded" | "hook-failed"): Promise<void> =>
      recordTerminalizeOutcome(deps.env.DB, handle.attemptId, outcome, Date.now() - startedMs).catch(
        () => {},
      );
    const recordDetached = (outcome: "budget-exceeded"): void => {
      void record(outcome);
    };
    if (settlement.promotionAbandoned === handle.attemptId) {
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
      deps.background?.waitUntil(
        terminalize.catch((err: unknown) => {
          if (!abandoned) return;
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
          giveUpRelease = abandonCheck(handle, `terminalize budget exceeded (${budgets.terminalizeMs}ms)`, {
            ...(outcome === "budget-exhausted" ? { outcome, budgetExhaustion } : {}),
          });
          recordDetached("budget-exceeded");
        },
      );
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
      await record("hook-failed");
      const release = abandonCheck(handle, `terminalize hook threw: ${detail}`, {
        ...(outcome === "budget-exhausted" ? { outcome, budgetExhaustion } : {}),
      });
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
            warn(`check in-progress promotion failed (the review is unaffected): ${err instanceof Error ? err.message : String(err)}`);
            return { kind: "settled", promoted: false };
          }),
        budgetMs,
      );
      if (waited === null) return "abandoned";
      return waited.value.kind;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warn(`check in-progress promotion failed (the review is unaffected): ${detail}`);
      return "settled";
    }
  };

  const beginCheck = async (
    scope: Scope,
    githubAppId: number,
    headSha: string,
    expect?: AttemptIdentity,
  ): Promise<CheckHandle | null> => {
    if (deps.checks === undefined) return null;
    settlement.promotionAbandoned = null;
    const beginLatch = createCheckBeginLatch();
    let handle: CheckHandle | null;
    try {
      const claimNowMs = Date.now();
      const claimDeadlineMs =
        expect === undefined && deadlineMs <= claimNowMs ? claimNowMs + CHECK_LEASE_MS : deadlineMs;
      handle = await withHookTimeout(
        deps.checks.begin({
          scope,
          githubAppId,
          headSha,
          triggeredBy: payload.triggered_by,
          action: payload.action,
          executionDeadlineMs: claimDeadlineMs,
          latch: beginLatch,
          ...(expect === undefined ? {} : { expect }),
        }),
        null,
        CHECK_HOOK_TIMEOUT_MS,
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

function beginProgress(): ReviewAttemptProgress {
  return {
    failureStage: "pipeline",
    secretValues: [],
    runnerStartedAt: undefined,
    runnerReturned: false,
  };
}

function requireCommenter(deps: ProcessDeps, payload: ReviewJobPayload): ReviewCommenter {
  const entry = deps.appCommenters.get(payload.botRef.appId);
  if (entry === undefined) {
    throw new Error(
      `review attempt: no credential adapter is registered for app ${payload.botRef.appId} — the host resolves the App before it runs an attempt step`,
    );
  }
  return entry.commenter;
}

function requireRunnerConfig(deps: ProcessDeps, payload: ReviewJobPayload): RunnerConfig {
  const config = deps.runnerConfigs.get(payload.botRef.appId);
  if (config === undefined) {
    throw new Error(
      `review attempt: no runner config is registered for app ${payload.botRef.appId} — the host resolves the App's AI config before it runs an attempt step`,
    );
  }
  return config;
}

function maybeSettlement(deps: ProcessDeps, attemptId: string): CheckSettlement | undefined {
  return deps.checkSettlements.get(attemptId);
}

async function freezeKnownStop(
  deps: ProcessDeps,
  payload: ReviewJobPayload,
  attemptId: string,
  budgetExhaustion: BudgetExhaustedOutcome,
): Promise<void> {
  const now = Date.now();
  const line = { ...payloadIdentityFields(payload), attempt_id: attemptId };
  try {
    const attempt = await getCheckAttempt(deps.env.DB, attemptId);
    if (attempt === null || attempt.desired !== "in_progress") return;
    const lease = await claimCheckRecovery(deps.env.DB, attemptId, `stop:${crypto.randomUUID()}`, now);
    if (lease === null) return;
    const frozen = await setCheckDesired(
      deps.env.DB,
      attemptId,
      lease,
      decideConclusion({ proof: null, outcome: "budget-exhausted", gate: null, review: null, budgetExhaustion }),
      null,
      now,
    );
    await releaseCheckClaim(deps.env.DB, attemptId, lease, Date.now());
    deps.log.info(
      { ...line, budget_outcome: budgetExhaustion },
      frozen
        ? "check attempt frozen with the stop's own category — the reconciler delivers it"
        : "check attempt not frozen under the recovery lease — the reconciler concludes it",
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      line,
      `check stop category not recorded (the stop's durable record stands): ${detail}`,
    );
  }
}

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
  settlement.claimAttempted = true;
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
    deps.log.warn(
      { ...settlement.fields, event: "check_settlement_not_adopted" },
      "check settlement not adopted on a resumed step — the obligation is recorded once its publication is durable",
    );
    return undefined;
  }
  deps.checkSettlements.set(ref.attemptId, settlement);
  return settlement;
}

async function ownedCheckAttemptId(deps: ProcessDeps, attemptId: string): Promise<string | undefined> {
   let identity: AttemptIdentity | null;
   try {
     identity = await readAttemptIdentity(deps.env.DB, attemptId);
   } catch (err) {
     const detail = err instanceof Error ? err.message : String(err);
     throw new AttemptUnknownError(
       `attempt ${attemptId}: its frozen Check identity could not be read (${detail}) — no send authority can be established`,
     );
   }
   if (identity === null) return undefined;
   try {
     const row = await deps.env.DB.prepare(`SELECT id FROM review_checks WHERE attempt_key = ? AND generation = ?`)
       .bind(identity.key, identity.generation)
       .first<{ id: string }>();
     return row?.id;
   } catch (err) {
     const detail = err instanceof Error ? err.message : String(err);
     throw new AttemptUnknownError(
       `attempt ${attemptId}: its Check row could not be read (${detail}) — no send authority can be established`,
     );
   }
 }

function assertFrozenIdentity(identity: AttemptIdentity | null, attemptId: string, headSha: string): void {
  if (identity !== null) return;
  throw new Error(
    `attempt ${attemptId}: the launch row carries no frozen attempt identity (head ${headSha}) — refusing to associate a derived one`,
  );
}

async function settleMovedHead(
  deps: ProcessDeps,
  ref: AttemptRef,
  check: CheckSettlement,
  headSha: string,
  frozenKey: string,
  observedKey: string,
): Promise<never> {
  const intent = successorIntentOf(ref.payload, headSha);
  if (intent !== null) {
    await recordSuccessorIntent(deps.env.DB, {
      dedupeKey: intent.dedupeKey,
      payload: intent.payload,
      nowMs: Date.now(),
    });
  }
  await check.terminalize(null, "skipped", headSha);
  await settleSkippedRow(deps, ref.payload, headSha, "the head moved between admission and the checkout", { announceNoOp: true }).catch(
    () => {},
  );
  deps.log.warn(
    { ...attemptFields(ref.payload, ref.level, ref.attemptId, headSha), event: "review_moved_head" },
    `observed head ${observedKey} is not the frozen ${frozenKey} — settled as skipped; the delivery retries under a new attempt`,
  );
  throw new MovedHeadError(ref.attemptId, frozenKey, observedKey);
}

async function noteOwedCheck(
  deps: ProcessDeps,
  ref: AttemptRef,
  headSha: string,
  checkAttemptId?: string,
): Promise<void> {
  const scope = scopeOf(ref.payload);
  if (scope === undefined || deps.checks === undefined) return;
  const identity = await readAttemptIdentity(deps.env.DB, ref.attemptId);
  if (identity === null) {
    if (checkAttemptId !== undefined && (await readCheckIdentity(deps.env.DB, checkAttemptId)) !== null) {
      assertFrozenIdentity(identity, ref.attemptId, headSha);
    }
    return;
  }
  const owed = await noteCheckOwed(deps.env.DB, {
    attemptId: ref.attemptId,
    checkKey: identity.key,
    checkGeneration: identity.generation,
    dueMs: Date.now() + CHECK_BACKOFF_MS[0]!,
  });
  if (!owed) return;
  deps.log.warn(
    { ...attemptFields(ref.payload, ref.level, ref.attemptId, headSha), event: "check_settlement_owed" },
    "check settlement owed — the attempt row carries the obligation for the recovery lane",
  );
}

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

function phaseFailure(
  phase: FailureFacts["phase"],
  err: unknown,
  facts: Omit<FailureFacts, "phase">,
): AttemptPhaseError {
  return new AttemptPhaseError({ phase, ...facts }, err);
}

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
  baseFields = toBaseFields(payload);
  lifecycleScope = {
    appId: payload.botRef.appId,
    installationId: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.pr_number,
  };
  if (ref.checkClaimSha !== null) {
    check.claimAttempted = true;
    await check.begin(lifecycleScope, githubAppId, ref.checkClaimSha);
  }
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
    level,
    runner_timeout_ms: runnerTimeoutMs(level),
    orchestration: level === "deep" ? "parent" : "bun-fanout",
    head_sha: headSha,
    idempotency_key: idemKey(key),
    sandbox_id: sandboxId,
  };
  check.fields = fields;

  let supersededClaimReleased = false;
  if (check.handle !== null && check.handle.headSha !== headSha) {
    const supersededHandle = check.handle;
    check.handle = null;
    deps.log.warn(
      fields,
      `check attempt superseded: claimed ${supersededHandle.headSha.slice(0, 7)}, checked out ${headSha.slice(0, 7)}`,
    );
    supersededClaimReleased = await check.abandon(
      supersededHandle,
      "the checkout proved a newer commit than the claim",
      { outcome: "superseded" },
    );
    if (!supersededClaimReleased) {
      deps.log.warn(
        fields,
        `check supersede handoff failed — continuing the review for ${headSha.slice(0, 7)} with no Check`,
      );
    }
  }

  const done = await kvDoneHit(deps.env.IDEMPOTENCY_KV, idemKey(key), fields, deps.log);
  if (done) {
    deps.log.info(fields, "KV idempotency hit — ack");
    await check?.terminalize(null, "skipped", headSha);
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
  const journalRow = await journalHandoffRow(deps.env.DB, lifecycleScope, headSha);
  if (journalRow !== null) {
    deps.log.info(
      fields,
      `publication journal hit (phase ${journalRow.phase}, id ${journalRow.id}) — handing off to recovery, ack without a second paid review`,
    );
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
      await settleSkippedRow(deps, payload, payload.head_sha, "a publication for this head already exists");
    }
    return { kind: "settled", outcome: { kind: "ok" } };
  }
  if (supersededClaimReleased) {
    await check.begin(lifecycleScope, githubAppId, headSha);
  }

  const reviewId = idemKey({
    ...key,
    head_sha: payload.head_sha || "no-sha",
  });
  const usageNow = new Date();
  const executionToken = crypto.randomUUID();
  const usageOccurredAt = usageNow.toISOString();
  try {
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
    const applied: true | false | "unknown" = await hasUsageEventForExecutionToken(
      deps.env.DB,
      executionToken,
    ).catch(() => "unknown" as const);
    deps.log.warn(
      { ...fields, review_id: reviewId, workspace_id: usageWorkspaceId, usage_applied: applied },
      `usage_events row not written (review continues): ${detail}`,
    );
    try {
      await deps.failureStore.record({
        target_id: payload.targetId,
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        head_sha: headSha,
        stage: "usage",
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

  const terminalizeBudgetMs = ref.checkBudgets?.terminalizeMs ?? CHECK_TERMINALIZE_DEFAULT;
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
  let diffFileState: "empty" | "captured" | "overflow" | "unreadable" =
    diffRead.failure ?? (diffRead.text === "" ? "empty" : "captured");

  if (sinceSha !== null) {
    const increment = await sandbox.runCommand(
      incrementDiffCommand(payload.owner, payload.repo, sinceSha, headSha, DIFF_PATH),
      {
        env: { GH_TOKEN: token },
        timeout: boundedStepTimeout(runnerDeadlineMs, EXEC_TIMEOUT_GIT_MS, "increment diff", "preparation"),
      },
    );
    if (increment.exitCode !== 0) {
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

  const bound = await bindUnboundThreads({ DB: deps.env.DB, commenter, log: deps.log, fields }, lifecycleScope, targets);
  if (bound.skipped > 0) {
    deps.log.warn(fields, `${bound.skipped} association(s) left unbound for a later round`);
  }

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

  let recheckInput: RecheckInput | undefined;
  const budgetExcluded = new Set<string>();
  let askedDiscussion = discussion;
  let recheckAssignmentMaxBytes: number | undefined;
  if (targets.length > 0 && !captureFailed) {
    const budget = await getRecheckAssignmentMaxBytes(deps.env.DB);
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
    const documentMaxBytes = Math.min(
      RECHECK_INPUT_MAX_BYTES,
      budget.maxBytes - RECHECK_ASSIGNMENT_PROSE_BYTES,
    );
    const candidates = targets.filter(
      (target) => !catalogExcluded.has(target.rowId) && !catalogBudgetExcluded.has(target.rowId),
    );
    const included: RecheckTarget[] = [];
    const referenced = new Set<string>();
    let evidence: EvidenceSlice[] = [];
    for (const target of candidates) {
      const withRow = new Set([...referenced, ...(catalog.sliceIdsByRowId.get(target.rowId) ?? [])]);
      const nextEvidence = catalog.slices.filter((slice) => withRow.has(slice.id));
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
    const head = candidates[0];
    if (head !== undefined && !included.some((target) => target.rowId === head.rowId)) {
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
      const headSlices = catalog.slices.filter((slice) => own.has(slice.id));
      const withOwn = catalog.slices.filter((slice) => own.has(slice.id) || referenced.has(slice.id));
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
        included.splice(0, included.length, ...attempt.targets);
        included.unshift(bounded);
        evidence = attempt.slices;
        break;
      }
    }
    const sentIds = new Set(included.map((target) => target.rowId));
    for (const target of candidates) if (!sentIds.has(target.rowId)) budgetExcluded.add(target.rowId);
    if (included.length === 0) {
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


  if (deps.checks !== undefined && !check.claimAttempted) {
    check.claimAttempted = true;
    await check.begin(lifecycleScope, githubAppId, headSha);
  }


  const admittedKey = ref.checkClaimSha === null ? null : checkKeyOf(payload, ref.checkClaimSha);
  const liveIdentity =
    check.handle !== null
      ? await readCheckIdentity(deps.env.DB, check.handle.attemptId)
      :
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
      await settleMovedHead(deps, ref, check, headSha, frozenNow.key, liveIdentity.key);
    }
  }

  const numstat = await sandbox.runCommand(cmds.numstat, {
    timeout: boundedStepTimeout(runnerDeadlineMs, EXEC_TIMEOUT_GIT_MS, "numstat", "preparation"),
  });
  if (numstat.exitCode !== 0 && diffFileState !== "empty") {
    throw new Error(`${gitStageFailureDetail("numstat", numstat, progress.secretValues)}; diff file: ${diffFileState}`);
  }
  const numstatLines = numstat.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

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

  const diffCaptureFailure =
    diffRead.failure ?? (diffRead.text === "" && numstatLines.length > 0 ? "empty" : undefined);
  if (diffCaptureFailure !== undefined) {
    captureFailed = true;
    deps.log.warn(
      { ...fields, diff_capture: diffCaptureFailure },
      `diff capture ${diffCaptureFailure} — context-unavailable (no evidence catalog; rows stay context-incomplete)`,
    );
  }

  const reconFacts = [
    `${payload.owner}/${payload.repo}#${payload.pr_number}`,
    `head ${headSha}`,
    ...(sinceSha !== null ? [`since ${sinceSha}`] : []),
    ...numstatLines,
  ];
  const prContext = await capturePrContext(
    sandbox,
    payload,
    token,
    deps.log,
    fields,
    runnerDeadlineMs,
  );

  const diffSize = parseNumstatSize(numstat.stdout, diffFileState === "empty");
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
  observed.runnerEffectiveBudgetMs = anchor.effectiveBudgetMs;
  fields = {
    ...fields,
    runner_requested_ms: anchor.requestedBudgetMs,
    runner_effective_ms: anchor.effectiveBudgetMs,
    runner_cutoff_ms: roundBudget.runnerCutoffMs,
    runner_deadline_ms: anchor.execDeadlineMs,
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
  const sandbox = await reviewAttemptSandbox(deps, attemptId);
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

function modelTexts(
  output: ReviewOutput,
  report: ReviewAttemptExecution["report"],
  priorTitles: readonly string[],
): string[] {
  const texts: string[] = [];
  texts.push(...priorTitles);
  if (output.summary_md !== undefined) texts.push(output.summary_md);
  if (output.incomplete !== undefined) texts.push(output.incomplete.reason, ...output.incomplete.unscanned);
  if (output.tally !== undefined) {
    texts.push(output.tally.chatHeader);
    if (output.tally.incomplete !== undefined) {
      texts.push(output.tally.incomplete.reason, ...output.tally.incomplete.unscanned);
    }
  }
  for (const finding of output.findings) {
    texts.push(finding.title, finding.body);
    if (finding.category !== undefined) texts.push(finding.category);
    if (finding.file_path != null) texts.push(finding.file_path);
    if (finding.fingerprint_hint !== undefined) texts.push(finding.fingerprint_hint);
  }
  if (report !== null) {
    texts.push(report.overview, report.linkedIssueAc, report.verified, report.rejected, report.planToFix);
  }
  return texts.filter((text) => text !== "");
}

async function refusesCredentialEcho(
  deps: ProcessDeps,
  ref: AttemptRef,
  prepared: PreparedAttempt,
  progress: ReviewAttemptProgress,
  texts: readonly string[],
  fields: ConsumerLogFields,
): Promise<"clear" | "settled" | "unknown"> {
  if (progress.secretValues.length === 0) {
    deps.log.warn(
      fields,
      "review publish gate could not run — this host holds no credentials for the attempt (the stored payload was redacted at write time)",
    );
    return "clear";
  }
  if (!texts.some((text) => carriesSecretForm(text, progress.secretValues))) return "clear";
  const refusal = new Error("publish gate refused the review — the outgoing body carries a credential echo");
  const wrapped = phaseFailure("collect", refusal, {
    stage: "pipeline",
    headSha: prepared.headSha,
    secretValues: progress.secretValues,
    runnerStartedAt: undefined,
    runnerReturned: true,
    runnerEffectiveBudgetMs: prepared.runnerEffectiveMs,
    changedLines: prepared.observedChangedLines,
    sendAttemptPublicationId: null,
  });
  const deliveryKey = deliveryKeyOf(ref.payload);
  if ((await readAttemptHandoff(deps.env.DB, deliveryKey)) !== null) {
    await beginAttemptSettlement(deps.env.DB, deliveryKey, Date.now());
  }
  let settlement: ProcessOutcome | null = null;
  try {
    settlement = await settleAttemptFailure(deps, ref, wrapped, { headSha: prepared.headSha });
  } catch (err) {
    if (err !== refusal) throw err;
  }
  return settlement?.kind === "unknown" ? "unknown" : "settled";
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
  const catalogExcluded: ReadonlySet<string> = new Set(prepared.catalogExcluded);
  const catalogBudgetExcluded: ReadonlySet<string> = new Set(prepared.catalogBudgetExcluded);
  const budgetExcluded = new Set(prepared.budgetExcluded);
  progress.secretValues = deps.credentials.get(attemptId)?.secretValues ?? [];
  const execution = await readPaidExecution(deps, attemptId);
  const { run, recheck, report, appliedProvider } = execution;
  const recheckDoc = recheck?.doc ?? null;
  const rejectedRowIds = recheck?.rejected ?? new Set<string>();
  const anonymousRejectedRows = recheck?.anonymousRejectedRows ?? 0;
  const parsed = parseReviewOutput(run.stdout);
  if (!parsed.ok) {
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
        error: redactedError,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `review_failures insert failed (degrade continues): ${detail}`);
    }
    const degradedGate = await refusesCredentialEcho(
      deps,
      ref,
      prepared,
      progress,
      [redactedStdout, redactedError],
      fields,
    );
    if (degradedGate !== "clear") {
      return { kind: "settled", outcome: { kind: degradedGate === "unknown" ? "unknown" : "ok" } };
    }
    refusePublicationPastDeadline(ref.deadlineMs);
    const degradedCheckAttemptId = check?.handle?.attemptId ?? (await ownedCheckAttemptId(deps, ref.attemptId));
    const degradedOutcome = await publishDegradedPublication({
      db: deps.env.DB,
      commenter,
      scope: lifecycleScope,
      headSha,
      admittedAttemptId: ref.attemptId,
      ...(degradedCheckAttemptId === undefined ? {} : { checkAttemptId: degradedCheckAttemptId }),
      redactedError,
      redactedStdout,
      attemptId,
      notAfterMs: ref.deadlineMs,
    });
    if (degradedOutcome.phase === "failed") {
      await check?.terminalize(null, "degraded-not-posted");
      await settleAttemptPublication(
        deps,
        attemptId,
        fields,
        degradedOutcome.publicationClosed ? ["publication"] : [],
      );
    } else {
      await check?.terminalize(degradedOutcome.publicationId, "publication-unknown");
      if (degradedOutcome.phase === "confirmed") {
        await noteOwedCheck(deps, ref, headSha, check?.handle?.attemptId);
        await settleAttemptPublication(deps, attemptId, fields, ["publication"]);
      }
    }
    deps.log.warn(
      fields,
      `review degraded: output failed schema validation (${redactedError}) — degraded publication ${degradedOutcome.phase}` +
        `${degradedOutcome.phase === "failed" ? ` (${degradedOutcome.reason})` : ""}; acked, no retry/DLQ`,
    );
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

  const redacted = redactReviewOutputExact(redactReviewOutput(parsed.output), progress.secretValues);
  const suggestionsDropped: ReviewOutput = {
    ...redacted,
    findings: redacted.findings.map((finding) => ({
      ...finding,
      body: dropRedactedSuggestions(finding.body),
    })),
  };
  const capped = capFindings(clampFindingSizes(suggestionsDropped));
  const output = capped.output;
  const publishGate = await refusesCredentialEcho(
    deps,
    ref,
    prepared,
    progress,
    modelTexts(
      output,
      report,
      targets.map((target) => target.original.title),
    ),
    fields,
  );
  if (publishGate !== "clear") {
    return { kind: "settled", outcome: { kind: publishGate === "unknown" ? "unknown" : "ok" } };
  }
  const staleContext = pendingApplyFailed || captureFailed;
  const reconciled = reconcileRecheckRound({
    targets,
    doc: recheckDoc,
    status: recheck?.status ?? null,
    discussion: askedDiscussion,
    output,
    staleContext,
    catalogExcluded,
    catalogBudgetExcluded,
    budgetExcluded,
    rejectedRowIds,
    anonymousRejectedRows,
  });
  if (targets.length > 0) {
    const status = recheck?.status ?? null;
    const recheckOutcome = status?.outcome ?? "absent";
    const roundCancelled = recheckOutcome === "skipped" && status?.reason === "aborted";
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
        recheck_reason: status?.reason === null || status?.reason === undefined
          ? null
          : redactExactSecrets(redactSecrets(status.reason), progress.secretValues),
        recheck_error: status?.error === null || status?.error === undefined
          ? null
          : redactExactSecrets(redactSecrets(status.error), progress.secretValues),
        rejected: rejectedRowIds.size + reconciled.anonymousRejectedCount,
        rejected_unnamed_ignored: anonymousRejectedRows - reconciled.anonymousRejectedCount,
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
    if (
      recheckInput !== undefined &&
      !roundCancelled &&
      (recheckDoc === null || recheckOutcome === "failed")
    ) {
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
      thread: target.associationIds.some((id) => queuedAssociations.has(id)) ? "not yet resolved" : "-",
    };
  });
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
    reportParts: { report, revalidated: buildRevalidatedSection(coverage, closureRows) },
  });
  const bodySha256 = await sha256Hex(preparedBody);

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

  const qualifying = filterLineCommentFindings(
    output.findings,
    diffText !== "" ? diffText : undefined,
  );
  const lineIntents: LineIntent[] = [];
  for (const { finding, lineStart } of qualifying) {
    const rowId = seenRowIdByFindingId.get(computeFindingFingerprint(finding));
    if (rowId === undefined) continue;
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
    attemptId,
    artifact: {
      kind: "review",
      key: idemKey(key),
      schema: "mstar.review/v1",
      payload: output,
      appId: payload.botRef.appId,
      targetId: payload.targetId,
      model: chainHeadSelector(prepared.modelChain),
      provider: appliedProvider,
      contextIncomplete: staleContext,
      durationMs: Date.now() - roundStartedAt,
    },
    lifecycle: lifecycleRound,
    lineIntents,
    admittedAttemptId: ref.attemptId,
  };
  const staged = await stagePublication(deps.env.DB, { id: publicationId, payload: payloadDoc, nowMs: Date.now() });
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

async function discoverLineBatch(
  deps: ProcessDeps,
  commenter: ReviewCommenter,
  input: PostPreparedLineCommentsInput,
  fields: ConsumerLogFields,
): Promise<void> {
  try {
    const recovered = await commenter.recoverLineComments(input);
    await captureLineComments(deps.env.DB, input.publicationId, recovered.reviewId, recovered.posted, Date.now());
    if (!recovered.captured) {
      deps.log.info(
        fields,
        "line-comment batch stays discovery-only — its dispatch intent is recorded, so no second send is permitted",
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      { ...fields, line_comments_fallback: true },
      `line-comment discovery failed (dispatch intent retained, no resend): ${detail}`,
    );
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
  const check = await settlementFor(deps, ref, headSha);
  const checkAttemptId = check?.handle?.attemptId ?? (await ownedCheckAttemptId(deps, ref.attemptId));
  const stagedId = publicationId;
  refusePublicationPastDeadline(ref.deadlineMs);
  const lease = await claimPublication(deps.env.DB, stagedId, `consumer:${sandboxId}`, Date.now(), "prepared");
  if (lease === null) {
    deps.log.warn(
      fields,
      `publication is no longer dispatchable from this phase (read ${publication.phase}) — nothing sent, handing it to recovery/discovery`,
    );
    await check?.terminalize(stagedId, "publication-unknown");
    return { kind: "ok" };
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
      journalClaim: lease,
      ...(checkAttemptId === undefined ? {} : { attemptId: checkAttemptId }),
    });
  } catch (err) {
    if (err instanceof PublicationDeadlineSpent) {
      throw new RoundBudgetSpent(`round budget spent: ${err.message}`, "runner");
    }
    if (err instanceof PublicationAuthorityUnavailable) {
      try {
        await releaseUnspentPublicationClaim(deps.env.DB, stagedId, lease, Date.now());
      } catch (releaseErr) {
        const detail = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        deps.log.warn(fields, `unspent publication claim could not be returned: ${detail}`);
      }
      deps.log.warn(fields, `publication handed to the lane holding its action — ${err.message}`);
      await check?.terminalize(stagedId, "publication-unknown");
      return { kind: "ok" };
    }
    if (err instanceof PreparedSendRejected) {
      let publicationClosed = false;
      try {
        publicationClosed = await markPublicationFailed(deps.env.DB, stagedId, lease, err.message, Date.now());
      } catch (markErr) {
        const detail = markErr instanceof Error ? markErr.message : String(markErr);
        deps.log.warn(fields, `failed-phase mark could not be persisted: ${detail}`);
      }
      await check?.terminalize(null, "pre-publication-failure");
      deps.log.warn(fields, `prepared review definitively rejected before send — recorded failed: ${err.message}`);
      await settleAttemptPublication(
        deps,
        attemptId,
        fields,
        publicationClosed ? ["publication"] : [],
      );
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
    deps.log.warn(
      fields,
      "publication proof could not be persisted after the send — retaining staged/sending for read-only discovery; no local completion is claimed",
    );
    await check?.terminalize(stagedId, "publication-unknown");
    return { kind: "ok" };
  }
  try {
    await deps.env.IDEMPOTENCY_KV.put(idemKey(key), IDEM_DONE, {
      expirationTtl: IDEMPOTENCY_SECONDS,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `KV completion write failed: ${detail}`);
  }

  let applied = false;
  try {
    const at = Date.now();
    const settlement = await settlementStatementIfDischarged(
      deps.env.DB,
      { attemptId, publicationId: stagedId, landed: ["publication"] },
      at,
    );
    applied = await applyPublishedLifecycle(deps.env.DB, stagedId, lease, at, undefined, () =>
      settlement === null ? [] : [settlement],
    );
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

  if (lineIntents.length > 0) {
    const lineAttemptId = checkAttemptId;
    const lineInput = {
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      headSha,
      round,
      publicationId: stagedId,
      intents: lineIntents,
    };
    let lineLease: Lease | null = null;
    try {
      lineLease = await recordLineDispatchIntent(deps.env.DB, stagedId, `consumer-lines:${sandboxId}`, Date.now());
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { ...fields, line_comments_fallback: true },
        `line-comment dispatch intent could not be recorded (nothing sent, intents stay discoverable): ${detail}`,
      );
    }
    if (lineLease === null) {
      let pending = false;
      try {
        pending = (await readLineBatchState(deps.env.DB, stagedId)).pending;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...fields, line_comments_fallback: true },
          `line-comment batch state unreadable (nothing sent, discovery owns it): ${detail}`,
        );
      }
      if (pending) {
        deps.log.info(
          fields,
          "line-comment batch already dispatched or owned by another lane — discovery only, never a second send",
        );
        await discoverLineBatch(deps, commenter, lineInput, fields);
      }
    } else {
      let outcome: "sent" | "refused" | "unknown" = "unknown";
      try {
        const postedLine = await commenter.postLineComments({
          ...lineInput,
          journalClaim: lineLease,
          ...(lineAttemptId === undefined ? {} : { attemptId: lineAttemptId }),
        });
        try {
          await captureLineComments(deps.env.DB, stagedId, postedLine.reviewId, postedLine.posted, Date.now());
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(fields, `line-comment id capture failed (intents stay discoverable): ${detail}`);
        }
        outcome = "sent";
        if (!postedLine.captured || postedLine.ambiguous.length > 0) {
          deps.log.warn(
            { ...fields, line_comments_fallback: true },
            `line-comment capture incomplete (ambiguous: ${postedLine.ambiguous.join(", ") || "none"}) — never fabricated, discovery owns the rest`,
          );
        }
      } catch (err) {
        outcome = err instanceof PreparedSendRejected || err instanceof PublicationDeadlineSpent ? "refused" : "unknown";
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...fields, line_comments_fallback: true },
          `line comments failed — overall comment already published, continuing overall-only: ${detail}`,
        );
      } finally {
        if (outcome !== "unknown") {
          try {
            await releaseLineDispatch(deps.env.DB, stagedId, lineLease, Date.now(), outcome === "sent");
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            deps.log.warn(
              { ...fields, line_comments_fallback: true },
              `line-comment dispatch release failed (the recorded intent stays for discovery): ${detail}`,
            );
          }
        }
      }
    }
  }

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
            `UPDATE review_threads
             SET verified_json = ?, resolution_state = 'pending', attempts = 0,
                 next_attempt_ms = NULL, last_error = NULL, updated_ms = ?
             WHERE id = ? AND superseded_by_publication_id IS NULL`,
          )
          .bind(JSON.stringify(resolution.verified), Date.now(), resolution.associationId)
          .run();
        if (enqueued.meta.changes === 0) continue;
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

  try {
    const mustPreserve = await hasUnprovenDegradedPublication(deps.env.DB, lifecycleScope);
    if (mustPreserve) {
      deps.log.warn(
        fields,
        "stale degraded comment cleanup skipped — an unconfirmed degraded publication still depends on its body as recovery evidence",
      );
    } else {
      const deleteOutcome = await commenter.deleteDegradedComment({
        appId: lifecycleScope.appId,
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

  await check?.terminalize(stagedId, "publication-unknown");
  await noteOwedCheck(deps, ref, headSha, check?.handle?.attemptId);
  await settleAttemptPublication(deps, attemptId, fields, ["publication"]);
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
  cleanup: CleanupInput,
): Promise<ProcessOutcome> {
  const { payload, level, attemptId, githubAppId } = ref;
  const failure = thrown instanceof AttemptPhaseError ? thrown : undefined;
  const facts = failure?.facts;
  const err = failure?.cause ?? thrown;
  const detail = err instanceof Error ? err.message : String(err);
  const markSettled = async (landed: readonly SettlementEffect[]): Promise<void> => {
    try {
      await settleAttemptIfDischarged(deps.env.DB, { attemptId, landed }, Date.now());
    } catch (markErr) {
      deps.log.warn(
        { ...payloadIdentityFields(payload), attempt_id: attemptId },
        `settle-once mark write failed — a replay will settle again: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
      );
    }
  };
  if (err instanceof MovedHeadError) {
    await markSettled(["skip"]);
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
  const launch = await readReviewLaunch(deps.env.DB, attemptId);
  const sandboxMayExist = launch !== null;
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
  if (err instanceof BudgetExhaustedError || err instanceof RoundBudgetSpent) {
    const budgetOutcome: BudgetExhaustedOutcome =
      err instanceof BudgetExhaustedError
        ? err.outcome
        : {
            kind: "budget-exhausted",
            cause: "consumer-deadline",
            tier: level!,
            budgetWindow: err.window,
            budgetMs:
              err.window === "runner"
                ? (facts?.runnerEffectiveBudgetMs ?? roundBudget.preparationBudgetMs)
                : roundBudget.preparationBudgetMs,
            seatsDispatched: 0,
            seatsStopped: 0,
            changedLines: observedChangedLines,
          };
    if (
      deps.checks !== undefined &&
      check !== undefined &&
      check.handle === null &&
      !check.claimAttempted &&
      lifecycleScope !== undefined &&
      headSha !== null
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
      durableOutcome = true;
    } catch (recordErr) {
      const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      deps.log.warn(
        fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
        `review_failures insert failed (exhaustion path continues): ${recordDetail}`,
      );
    }
    if (!durableOutcome) {
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
      if (paidStateObserved) await recordReviewFailure(deps.env.DB, attemptId, Date.now());
    await check?.terminalize(null, "budget-exhausted", undefined, budgetOutcome);
    const checkAttemptId = check?.handle?.attemptId;
    if (checkAttemptId !== undefined) await freezeKnownStop(deps, payload, checkAttemptId, budgetOutcome);
    await markSettled(["failure-row"]);
    return { kind: "budget-exhausted", outcome: budgetOutcome };
  }

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
    },
    `review failed: ${detail}`,
  );

  const persistedDetail =
    classifyGithubRateLimit(err) === "secondary" ? `${GITHUB_RATE_LIMIT_PREFIX}${detail}` : detail;
  try {
    await deps.failureStore.record({
      target_id: payload.targetId,
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: fields?.head_sha ?? payload.head_sha ?? "",
      stage: progress.failureStage,
      error: redactExactSecrets(redactSecrets(persistedDetail), progress.secretValues),
    });
    durableOutcome = true;
  } catch (recordErr) {
    const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
    deps.log.warn(
      fields ?? { ...(baseFields ?? payloadIdentityFields(payload)), sandbox_id: sandboxId },
      `review_failures insert failed: ${recordDetail}`,
    );
  }
  if (!durableOutcome && sandboxMayExist) {
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
    if (paidStateObserved && durableOutcome) {
      await recordReviewFailure(deps.env.DB, attemptId, Date.now());
    }
  if (sendAttempt !== null) {
    await check?.terminalize(sendAttempt.publicationId, "publication-unknown");
  } else {
    await check?.terminalize(null, "pre-publication-failure");
  }

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
  const effects: SettlementEffect[] = [];
  if (durableOutcome) effects.push("failure-row");
  if (claimStampLanded) effects.push("claim-stamp");
  await markSettled(effects);
  throw err;
}
/**
 * Phase 5 — cleanup. Destroy only the proven container, once its result or a
 * confirmed no-result outcome is durable, then release the admission row.
 * Neither ordering nor evidence changed: capacity is never released on
 * unknown container state, and cleanup never replaces collection.
 */
export type CleanupInput = {
  unproven?: boolean;
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
  let claimed = false;
  try {
    claimed = await abandonReviewLaunch(deps.env.DB, attemptId, Date.now());
  } catch {
    claimed = false;
  }
  let retention: RetentionProof | undefined;
  let containerMayExist = claimed;
  if (claimed) {
    retention = { kind: "no-paid-work" };
    containerMayExist = (await readAttemptActivation(deps.env.DB, attemptId))?.activated === true;
  } else {
    const verdict = launchVerdict(await readReviewLaunch(deps.env.DB, attemptId));
    switch (verdict.kind) {
      case "never-claimed":
      case "never-paid":
        containerMayExist = false;
        retention = undefined;
        break;
      case "persisted":
      case "paid-failed":
        containerMayExist = true;
        retention = { kind: "retained" };
        break;
      case "owned-by-cleanup":
        containerMayExist = false;
        retention = undefined;
        break;
      case "unrecognised":
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
      const sandbox = await reviewAttemptSandbox(deps, attemptId);
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
