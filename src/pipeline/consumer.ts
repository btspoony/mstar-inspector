/**
 * Queue consumer — the review pipeline main flow (plan 06 Task 3).
 *
 * Flow (plan 07 Task 5 / compass S7): message → getSandbox (unique id per
 * attempt) → clone the PR head branch (git transport auth via scoped
 * extraheader env) → `git rev-parse HEAD` for the AUTHORITATIVE sha →
 * dedup by that sha (hit → ack) → diff → numstat (the seat-partition
 * universe) → write the runner `--input` JSON (reconFacts, plus the per-App
 * `modelOverrides` role map for app-path messages — plan 17 B6; legacy /
 * unmapped App = byte-identical payload) → exec the
 * in-image runner `--level <quick|default|deep>` (exec env =
 * ARK_API_KEY/PI_CODING_AGENT_DIR/HARNESS_PLUGIN_ROOT + OMP_REVIEW_MODEL and
 * configured provider keys — per-App messages assemble BYOK keys/model chain
 * with global-env fallback, plan 14 B2; GH_TOKEN rides ONLY the git/gh step
 * envs) → parse
 * the mstar.review/v1 envelope → post the overall review comment FIRST →
 * store.put (idempotent — the UNIQUE first-written row wins) → KV
 * completion state → finally destroy. Any step throwing → structured log
 * + a best-effort review_failures row (stage classified from the phase in
 * flight; plan 18 Task 2 / AL-6 — DLQ-bound infra failures otherwise leave
 * zero D1 trace) + rethrow (queue retry → DLQ). The runtime runner has NO
 * summary-degrade path: exit 0 means stdout is the engine-validated
 * envelope; a non-zero exit keeps the no-post/no-insert rethrow. A
 * parse/validate failure takes the DEGRADE path instead (plan 18 Task 2 /
 * AL-1): review_failures row (stage=parse) + degraded comment (both
 * best-effort) + ack — parseReviewOutput is a pure function of
 * run.stdout, so retry is deterministic waste. No reviews row and NO KV
 * done-state on degrade: a later webhook for the same sha legitimately
 * re-runs the review. Three typed outcomes never throw: the in-flight
 * guard (bugbot BB-3) — guard-held schedules a per-message delayed retry
 * (60s/120s/240s) and finally acks with a warning instead of DLQing — a
 * PAUSED App's message (plan 16, review_enabled=0), which acks
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
 * (payload + idempotency key), review/schema (pure zod) + review/runtime
 * (pure port types/constants — dual-face, zero omp SDK),
 * store/artifact-store (07 D1 ArtifactStore) + store/failure-store (plan 18
 * Task 2 review_failures leaf), and the pipeline modules —
 * never src/worker/**.
 */

import type { D1Database, KVNamespace, Message, MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import { idemKey, IDEMPOTENCY_SECONDS, type IdempotencyKey } from "../contracts/idem";
import { parseReviewOutput, capFindings, clampFindingSizes } from "../review/schema";
import { isReviewLevel, REVIEW_LEVELS, type ReviewLevel } from "../review/runtime";
import { redactExactSecrets, redactReviewOutput, redactReviewOutputExact, redactSecrets } from "./redact";
import { createArtifactStore, type D1ArtifactStore } from "../store/artifact-store";
import { createFailureStore, type FailureStage, type FailureStore } from "../store/failure-store";
import { getSandbox, type ReviewSandbox } from "./sandbox";
import { buildGitOpsCommands, writeJsonCommand } from "./gitops";
import {
  createReviewCommenter,
  filterLineCommentFindings,
  type CommenterEnv,
  type ReviewCommenter,
} from "./comment";
import { PROVIDERS, pickProviderKeys, providerEnvName } from "./providers";
// Per-App credential resolution (plan 13 Task 2, lock L4): the consumer is a
// sanctioned reader of the dashboard store leaves (apps-store reads the
// github_apps row, secretbox decrypts the PEM) — the dashboard ↛
// pipeline/worker isolation is one-directional and unaffected.
import { createAppsStore } from "../dashboard/apps-store";
import { createSecretbox } from "../dashboard/secretbox";
// Per-App AI-config resolution (plan 14 Task 3): the same sanctioned reader
// edge — app-config-store reads app_provider_keys / app_model_config and
// decrypts keys via secretbox (itself a zero-dependency leaf, lock L1).
import { createAppConfigStore } from "../dashboard/app-config-store";

export type PipelineEnv = {
  APP_ID: string;
  PRIVATE_KEY: string;
  OMP_MODEL_KEY: string; // omp model key; injected into the container as ARK_API_KEY
  DB: D1Database;
  IDEMPOTENCY_KV: KVNamespace;
  SANDBOX: unknown; // binding shape = DurableObjectNamespace<Sandbox> (T1-pinned)
  /**
   * omp review model chain (postdeploy feedback T2 / bugbot BB-1): the
   * comma-separated selector list is forwarded into the runner exec env as
   * OMP_REVIEW_MODEL so the container's session uses the configured primary
   * model + fallback chain. Unset/empty → in-image default
   * (ark-plan/deepseek-v4-flash, no fallback chain).
   */
  OMP_REVIEW_MODEL?: string;
  /**
   * Envelope master key for the per-App credential resolution (plan 13 Task
   * 2, lock L4): base64 of exactly 32 bytes (the same DASHBOARD_ENCRYPTION_KEY
   * Worker secret the dashboard write face uses, src/dashboard/secretbox.ts).
   * Missing / malformed → SecretboxKeyError → per-App resolution fails
   * closed (structured error + the existing retry/DLQ semantics, zero GitHub
   * writes); the legacy env-App path is unaffected. This face reads the key
   * only — the consumer never encrypts.
   */
  DASHBOARD_ENCRYPTION_KEY?: string;
  /**
   * Review tier for the in-image runner (plan 09 T1): "quick" (1 seat),
   * "default" (2 seats, the harness no-flag landing tier), or "deep" (the
   * three-stage parent-session path). Unset/empty → "default". Any other
   * value fails the review fail-loud — the port never silently downgrades;
   * the valid-value list lives in REVIEW_LEVELS (the SSOT the error message
   * quotes), so this doc cannot drift when the universe widens again.
   */
  REVIEW_LEVEL?: string;
  /**
   * omp built-in provider API keys (bugbot BB-2): set on the deployed Worker
   * with `bun run keys` → `wrangler secret put` (scripts/provider-keys.ts,
   * mapping SSOT = src/pipeline/providers.ts). The consumer forwards every
   * present-and-non-empty key into the runner exec env (allowlist = the
   * PROVIDERS mapping only — arbitrary Worker env is never forwarded).
   */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  COPILOT_GITHUB_TOKEN?: string;
  AZURE_OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  KILO_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  ZAI_API_KEY?: string;
  UMANS_AI_CODING_PLAN_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  CURSOR_ACCESS_TOKEN?: string;
  AI_GATEWAY_API_KEY?: string;
  WAFER_SERVERLESS_API_KEY?: string;
};

/** In-image paths (Dockerfile v2 / T2 smoke — single source of truth). */
const CLONE_DIR = "/workspace/repo";
const DIFF_PATH = "/workspace/pr.diff";
const RUNNER_INPUT_PATH = "/workspace/review-input.json";
const RUNNER_PATH = "/opt/runner/src/review/runner.ts";
const HARNESS_ROOT = "/opt/mstar-harness";
const OMP_AGENT_DIR = "/opt/omp-agent";

// Per-call exec bounds (ms) — every sandbox exec carries an explicit timeout
// so a hung gh/git/model call fails deterministically instead of silently
// eating a container (plan QC 06 fix round 1 / qc3 F-001).
/** gh/git steps (clone, rev-parse, diff, numstat, runner-input write) — measured ~2.6s total, 2min each is generous. */
const EXEC_TIMEOUT_GIT_MS = 120_000;
/**
 * In-image runner budget per review level (ms). One Worker deployment = one
 * REVIEW_LEVEL = one timeout table (spec d5-budget § Trigger): quick/default
 * keep the frozen 10min ceiling (measured ~52s on a real model call); deep
 * gets 14min: Cloudflare Queue consumers cap at 15min wall-clock, so the
 * grill-me 30min budget could never finish in-consumer (force-kill skips
 * finally, retries DLQ — 10-review-d5-budget qc2/qc3 Critical); 14min still
 * covers the three-phase parent-session run without false-timeout into the
 * DLQ. Record<ReviewLevel, …> makes a future level widen fail at compile
 * time, never silently fall back.
 */
const RUNNER_TIMEOUT_MS: Record<ReviewLevel, number> = {
  quick: 600_000,
  default: 600_000,
  deep: 840_000,
};

/**
 * Cap on the prefetched PR diff considered for the line-comments hunk
 * prefilter (plan 18 QC fix r1 / qc3 F-101): 2 MiB of diff text. Beyond it,
 * parseDiffHunkRanges would materialize a full line array per qualifying
 * round on multi-MB PRs; overflow degrades to the prefetch-failure path
 * (base-filter attempt; a residual 422 still falls back per AL-3).
 */
export const DIFF_PREFETCH_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Runner exec timeout for the job's review level (spec d5-budget L4 — the
 * helper trio runnerTimeoutMs / reviewGuardTtlSeconds /
 * guardRetryDelaysSeconds is the naming SSOT; no bare re-exported constants).
 */
export function runnerTimeoutMs(level: ReviewLevel): number {
  return RUNNER_TIMEOUT_MS[level];
}

/** Structured log fields: seven event fields + sandbox id + idempotency key
 * + the d5-budget visibility quartet (level / runner_timeout_ms /
 * elapsed_ms / orchestration — spec d5-budget L5: they ride THIS channel;
 * no new APM, no webhook sink). */
export type ConsumerLogFields = {
  /**
   * `pull_request` / `review_command` — the trigger that produced the job.
   * `review_paused` (plan 16, architect lock L4 — union widened ADDITIVELY):
   * the ack-skip line for a paused App's in-flight message; it overrides the
   * trigger fields' event on that one log line.
   */
  event: "pull_request" | "review_command" | "review_paused";
  action: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  sandbox_id?: string;
  /** github_apps.id the job resolves to (per-App jobs only, plan 13 T2). */
  app_id?: string;
  idempotency_key?: string;
  /** Review tier resolved from REVIEW_LEVEL. */
  level?: ReviewLevel;
  /** Runner wall-clock budget for `level` (ms) — runnerTimeoutMs(level). */
  runner_timeout_ms?: number;
  /** Runner exec elapsed wall-clock (ms) — set on runner-attempt log lines. */
  elapsed_ms?: number;
  /** Runner orchestration: deep = parent session; quick/default = Bun fan-out. */
  orchestration?: "bun-fanout" | "parent";
  /**
   * Per-App key assembly (plan 14 B2, per-App messages only): the provider id
   * (a PROVIDERS key) the key_source field refers to. An id, never a
   * credential — key material is NEVER logged.
   */
  provider?: string;
  /**
   * Which source supplied `provider`'s key for the runner env: the App's own
   * config ("app") or the global Worker env ("global" — the spec fallback).
   */
  key_source?: "app" | "global";
  /**
   * Whether a per-App message's runner env drew on the App's own config
   * ("app": ≥1 App key or an App model chain) or fell back to the global env
   * wholesale ("fallback": zero App keys + no App model chain).
   */
  config_source?: "app" | "fallback";
  /**
   * Plan 18 Task 3 (AL-3): the line-comments createReview FAILED after the
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
// In-flight review guard (WF-002): one review per PR at a time.
// ---------------------------------------------------------------------------

/**
 * Guard TTL (seconds): must exceed the max review wall-clock — ALL FIVE
 * git-timed steps (clone / rev-parse / diff / numstat / runner-input write,
 * 120s each — numstat + the input write were added by plan 07 without
 * recomputing this, qc3 F-301) plus the LEVEL's runner step
 * (runnerTimeoutMs(level) — 600s quick/default, 840s deep) plus slack for
 * the untimed steps (token mint, sandbox create, comment post, KV/D1
 * puts) — so the guard can never expire mid-review and unblock a
 * concurrent duplicate. KV expirationTtl is in seconds. Pinned exactly by
 * consumer.test.ts ("reviewGuardTtlSeconds covers the full step-budget
 * arithmetic per level") so a future step addition re-breaks loudly.
 */
export function reviewGuardTtlSeconds(level: ReviewLevel): number {
  return Math.ceil((runnerTimeoutMs(level) + 5 * EXEC_TIMEOUT_GIT_MS + 120_000) / 1000);
}

/**
 * In-flight guard key: `inflight:{installation_id}:{owner}/{repo}:{pr_number}`.
 * Keyed WITHOUT head_sha on purpose — `/review` commands carry head_sha=null
 * and must still be serialized per PR.
 */
export function reviewGuardKey(key: {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
}): string {
  return `inflight:${key.installation_id}:${key.owner}/${key.repo}:${key.pr_number}`;
}

/**
 * Try to acquire the in-flight guard. Held → false (the caller returns the
 * guard-held outcome; the consumer schedules a per-message delayed retry, so
 * the later attempt lands on the update path once the first attempt's marker
 * exists).
 *
 * KV caveat: Cloudflare KV is eventually consistent (reads may lag writes by
 * up to ~60s) and has no compare-and-set, so this is a BEST-EFFORT mutex —
 * two attempts racing the GET can both pass before either PUT is visible.
 * It narrows the duplicate window from the full review wall-clock to a
 * sub-second KV race; the marker-based upsert (T5) remains the durable
 * backstop. KV failure → warn + proceed WITHOUT the guard (the same
 * conservative-pass policy as the idempotency keys), logging that the
 * duplicate-comment race window is open until KV recovers.
 */
async function acquireReviewGuard(
  kv: KVNamespace,
  key: string,
  level: ReviewLevel,
  fields: ConsumerLogFields,
  log: ConsumerLog,
): Promise<boolean> {
  try {
    if ((await kv.get(key)) !== null) return false;
    await kv.put(key, "inflight", { expirationTtl: reviewGuardTtlSeconds(level) });
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `in-flight guard KV error — proceeding without guard (race window open): ${detail}`);
    return true;
  }
}

/** Release the in-flight guard. Failure → warn; the TTL still expires it. */
async function releaseReviewGuard(
  kv: KVNamespace,
  key: string,
  level: ReviewLevel,
  fields: ConsumerLogFields,
  log: ConsumerLog,
): Promise<void> {
  try {
    await kv.delete(key);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `in-flight guard release failed — guard expires by TTL (${reviewGuardTtlSeconds(level)}s): ${detail}`);
  }
}

/**
 * Guard-held backoff schedule (seconds), indexed by message.attempts (1-based
 * — the first delivery is attempt 1). quick/default: 60s → 120s → 240s; deep: 180s → 360s → 720s
 * — every entry below the LEVEL's guard TTL (1320s / 1560s) so the held guard
 * can never expire mid-backoff into a duplicate race. Attempts past the
 * schedule's end have consumed the queue's max_retries and must be acked, not
 * retried (a further retry() would land the job on the DLQ).
 */
const GUARD_RETRY_DELAYS_SECONDS: Record<ReviewLevel, readonly [number, number, number]> = {
  quick: [60, 120, 240],
  default: [60, 120, 240],
  deep: [180, 360, 720],
};

/** Guard-held backoff schedule for the job's review level (spec d5-budget L4). */
export function guardRetryDelaysSeconds(level: ReviewLevel): readonly number[] {
  return GUARD_RETRY_DELAYS_SECONDS[level];
}

/**
 * Outcome of one message pass (bugbot BB-3 + plan 16 lock L4 + plan 18 Task
 * 2 AL-1). THREE DISTINCT typed outcomes never throw: a guard-held message
 * is scheduled for a per-message delayed retry and finally acked with a
 * warning — it is never rethrown into the immediate-retry ×3 → DLQ path; a
 * PAUSED message (the App's review_enabled=0) is acked directly — an
 * intentional skip with zero side effects, never a retry or a DLQ entry (a
 * throw would be the wrong semantics for an operator pause); a DEGRADED
 * message (parse-fail) is acked directly after its best-effort
 * review_failures row + degraded comment — a deterministic model-output
 * failure where retry is deterministic waste. Infra failures keep the
 * existing throw → retry → DLQ behavior (plus the AL-6 best-effort failure
 * row before the rethrow).
 */
export type ProcessOutcome =
  | { kind: "ok" }
  | { kind: "guard-held" }
  | { kind: "paused" }
  | { kind: "degraded" };

/**
 * Handle a guard-held message (bugbot BB-3). The guard is not an error
 * state: instead of throwing (which burns the queue's three immediate
 * retries and DLQs the job — including later synchronize events for the same
 * PR — while the first review is still running), schedule a per-message
 * DELAYED retry via `message.retry({ delaySeconds })`. After the final
 * delayed attempt, ack with a warning: the job is dropped cleanly and the
 * next event for the PR (e.g. a later synchronize) re-reviews. Structured
 * log fields carry the PR identity + attempt count; the idempotency key is
 * not yet derivable at guard time (it comes from the checked-out sha).
 */
function handleGuardHeld(message: Message<ReviewJobPayload>, deps: ProcessDeps): void {
  const fields = toBaseFields(message.body);
  // REVIEW_LEVEL is a Worker-level setting (one deployment = one level), and
  // processMessage already resolved it before touching the guard — re-resolving
  // here cannot throw on the guard-held path.
  const level = resolveReviewLevel(deps.env.REVIEW_LEVEL);
  const delays = guardRetryDelaysSeconds(level);
  const delaySeconds = delays[message.attempts - 1];
  if (delaySeconds !== undefined) {
    deps.log.info(
      fields,
      `review already in flight — scheduling delayed retry in ${delaySeconds}s (attempt ${message.attempts})`,
    );
    message.retry({ delaySeconds });
  } else {
    deps.log.warn(
      fields,
      `review still in flight after ${delays.length} delayed retries (attempt ${message.attempts}) — acking, no DLQ (guard-held is not an error; the next event for the PR re-reviews)`,
    );
    message.ack();
  }
}

type ProcessDeps = {
  env: PipelineEnv;
  store: D1ArtifactStore;
  /**
   * review_failures leaf (plan 18 Task 2 / AL-1 + AL-6): the parse-fail
   * degrade branch and the infra-failure catch record through it. Both call
   * sites are best-effort (try/catch at the call site — an insert failure
   * never masks the ack or the rethrow).
   */
  failureStore: FailureStore;
  commenter: ReviewCommenter;
  /**
   * Per-App commenter instance cache keyed by appId (plan 13 Task 2, lock
   * L4; plan 15 hardening item 1 / architect lock L1), beside the legacy
   * env singleton above. Entry = `{ commenter, fingerprint }` where the
   * fingerprint is the EXACT string pair `github_app_id` +
   * `private_key_enc` (the envelope as stored) from the per-message row the
   * resolver already re-reads: a fingerprint match reuses the instance
   * (auth-app token caches stay warm), a mismatch (rotation — a new AES-GCM
   * envelope, even for a re-saved identical PEM) decrypts + rebuilds +
   * REPLACES, and the not-found/disabled/deleted gates evict before their
   * unchanged throw. Deliberately NOT keyed or fingerprinted on
   * `updated_at` (plan 16's per-webhook `touchLastWebhook` would make it
   * high-frequency) and not on a decrypted-PEM digest (that would spend the
   * decrypt the cache exists to spare). The row status is still re-checked
   * per message — the cache only spares the decrypt + construction, never
   * the active/not-deleted gate. auth-app's installation-token cache is
   * per-instance, so one instance per App keeps token caches isolated AND
   * prevents credentials from crossing instances.
   */
  appCommenters: Map<string, { commenter: ReviewCommenter; fingerprint: string }>;
  /**
   * Per-App commenter factory — `createReviewCommenter` in production (the
   * ONLY createAppAuth construction point stays src/pipeline/comment.ts,
   * lock L4); tests inject a spy to assert the exact credentials each App
   * instance is built from.
   */
  createAppCommenter: (cred: CommenterEnv) => ReviewCommenter;
  log: ConsumerLog;
  getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
};

/** Structured base fields derived from the job payload (no sandbox/sha yet). */
function toBaseFields(payload: ReviewJobPayload): ConsumerLogFields {
  return {
    event: payload.triggered_by === "pull_request" ? "pull_request" : "review_command",
    action: payload.action,
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: payload.head_sha,
    // Per-App jobs carry the appId reference in every structured log line
    // (an id, never a credential — lock L4).
    ...(payload.appRef?.kind === "app" ? { app_id: payload.appRef.appId } : {}),
  };
}

/**
 * Outcome of the per-message commenter resolution (plan 16, architect lock
 * L4): `ok` carries the commenter the review runs with; `paused` is the
 * DISTINCT typed outcome for a paused App (review_enabled=0) — returned
 * AFTER the status/deleted gates (disabled is judged first and keeps its
 * byte-identical throw→retry→DLQ semantics) and consumed by processMessage
 * as an immediate ack-skip. NOT a throw: a throw would enter the
 * retry→DLQ path — the wrong semantics for an intentional pause.
 */
type CommenterResolution = { kind: "ok"; commenter: ReviewCommenter } | { kind: "paused" };

/**
 * Resolve the commenter for one message (plan 13 Task 2, architect lock L4
 * — consumer-side credential resolution):
 *
 * - legacy (appRef absent — old in-flight messages — or `{ kind: "legacy" }`)
 *   → the env-App singleton commenter, byte-identical to the pre-multi-App
 *   behavior.
 * - `{ kind: "app", appId }` → the `github_apps` row via D1 (re-read per
 *   message) gated in order: missing row / soft-deleted / disabled THROWS
 *   (unchanged retry→DLQ semantics; the failed gate EVICTS the cached
 *   instance) → PAUSED (`review_enabled = 0`, plan 16 lock L4) returns the
 *   DISTINCT `paused` outcome AFTER those gates, leaving any cached
 *   instance in place (resume reuses the warm instance — the plan-15
 *   fingerprint ignores review_enabled) → the row's PEM decrypted in memory
 *   (secretbox, AAD `github_apps.private_key_enc:<id>`) →
 *   `createAppCommenter({ APP_ID: String(github_app_id), PRIVATE_KEY })`,
 *   cached per appId in `deps.appCommenters` with the row's credential
 *   fingerprint (plan 15 L1: `github_app_id` + `private_key_enc` envelope
 *   exact-string match — reuse on match, rebuild + replace on rotation).
 *
 * Any unresolvable state — missing row, disabled, soft-deleted, missing
 * DASHBOARD_ENCRYPTION_KEY (SecretboxKeyError), tampered envelope — THROWS:
 * the structured error log + rethrow keep the existing retry/DLQ semantics
 * and no GitHub write ever happens. The decrypted PEM lives only in this
 * call's memory and the commenter instance; it is never logged.
 */
async function resolveCommenter(payload: ReviewJobPayload, deps: ProcessDeps): Promise<CommenterResolution> {
  const appRef = payload.appRef;
  if (appRef === undefined || appRef.kind === "legacy") {
    return { kind: "ok", commenter: deps.commenter };
  }
  const row = await createAppsStore(deps.env.DB).getAppById(appRef.appId);
  if (row === null) {
    deps.appCommenters.delete(appRef.appId);
    throw new Error(`per-App credential resolution failed: app ${appRef.appId} not found`);
  }
  if (row.deleted_at !== null) {
    deps.appCommenters.delete(appRef.appId);
    throw new Error(`per-App credential resolution failed: app ${appRef.appId} is soft-deleted`);
  }
  if (row.status !== "active") {
    deps.appCommenters.delete(appRef.appId);
    throw new Error(`per-App credential resolution failed: app ${appRef.appId} is ${row.status}`);
  }
  // Plan 16 (architect lock L4): the PAUSED gate sits AFTER the status/
  // deleted gates (disabled is judged first — its throw→retry→DLQ semantics
  // stay byte-identical) and returns the DISTINCT typed outcome instead of
  // throwing. The cached instance (if any) is deliberately LEFT in place —
  // resuming the App must reuse the warm instance, and the plan-15
  // fingerprint (`github_app_id` + `private_key_enc`) is immune to
  // review_enabled writes.
  if (row.review_enabled === 0) {
    return { kind: "paused" };
  }
  // Plan 15 hardening item 1 (architect lock L1): the fingerprint is the
  // exact string pair read from the row THIS call already fetched — zero
  // extra reads, no hashing, never `updated_at` (plan 16's per-webhook
  // touchLastWebhook would churn it). A re-saved identical PEM yields a NEW
  // AES-GCM envelope → one harmless rebuild; a real rotation rebuilds with
  // the new credential on the very next message.
  const fingerprint = JSON.stringify([row.github_app_id, row.private_key_enc]);
  const cached = deps.appCommenters.get(appRef.appId);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return { kind: "ok", commenter: cached.commenter };
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
  deps.appCommenters.set(appRef.appId, { commenter, fingerprint });
  return { kind: "ok", commenter };
}

/**
 * Resolve the review tier from PipelineEnv.REVIEW_LEVEL (plan 07
 * AC-S7-level). Unset/empty → "default" (the harness no-flag landing tier).
 * Anything else throws — the port rejects unknown levels fail-loud and never
 * silently downgrades (spec § 档位). "deep" is a legal tier (plan 09 T1);
 * the message lists every tier from REVIEW_LEVELS so it cannot drift when
 * the level universe widens again (architect lock L3).
 */
export function resolveReviewLevel(value: string | undefined): ReviewLevel {
  if (value === undefined || value === "") return "default";
  if (isReviewLevel(value)) return value;
  throw new Error(
    `invalid REVIEW_LEVEL ${JSON.stringify(value)} — expected one of: ${REVIEW_LEVELS.join(", ")}`,
  );
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
 * Per-App AI configuration for the runner exec env (plan 14 Task 3) — the
 * `getAppConfig` decrypt face of src/dashboard/app-config-store.ts narrowed
 * to what assembly consumes. `keys` maps provider id → DECRYPTED plaintext
 * key (only providers with a stored row appear); `modelChain` is the verbatim
 * stored selector chain, null / "" / whitespace-only = unset (global
 * OMP_REVIEW_MODEL wins — any falsy or blank chain is treated as unset,
 * plan 15 input bounds).
 */
export type RunnerAppConfig = {
  keys: Record<string, string>;
  modelChain: string | null;
};

/**
 * Resolve the per-App AI config for one message (plan 14 Task 3). Legacy
 * (appRef absent — old in-flight messages — or `{ kind: "legacy" }`) →
 * `undefined`: the caller assembles the runner env exactly as before. 
 * `{ kind: "app", appId }` → ONE `getAppConfig` read per message (all
 * provider keys + the model chain in a single store call — never per key),
 * decrypted in memory. The read hangs off the same appRef resolution as
 * `resolveCommenter` (the App row is already proven present, active and
 * non-deleted there) and runs BEFORE the in-flight guard so an unresolvable
 * config fails with zero side effects. Keys are re-read every message (no
 * cache) so a dashboard key update applies to the very next review.
 *
 * Failure = fail closed: an undecryptable envelope (tampered row, AAD
 * mismatch) or a missing/malformed DASHBOARD_ENCRYPTION_KEY throws — the
 * structured error log + rethrow keep the existing retry/DLQ semantics. The
 * review never silently proceeds on global keys: with the App's own key
 * unreadable, falling back would spend the WRONG account's quota. Decrypted
 * keys live only in this call's memory and the assembled exec env — never
 * logged, never in queue payloads or errors.
 */
async function resolveAppConfig(payload: ReviewJobPayload, deps: ProcessDeps): Promise<RunnerAppConfig | undefined> {
  const appRef = payload.appRef;
  if (appRef === undefined || appRef.kind === "legacy") {
    return undefined;
  }
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
 * Resolve the App's per-role model overrides for one message (plan 17 B6
 * Task 1): role → verbatim selector chain via the decrypt-free
 * `getAppModelRoles` read (a model selector is configuration, not a secret —
 * no secretbox). Only `{ kind: "app" }` messages carry the map: legacy
 * (appRef absent — old in-flight messages — or `{ kind: "legacy" }`) →
 * `undefined`, and an App with NO (or an all-cleared) role map → `undefined`
 * — in both cases the runner input JSON serializes byte-identically to
 * today's (plan Global Constraints: absent/empty map = unchanged runner
 * behavior). Hangs off the same appRef resolution as `resolveAppConfig` (the
 * App row is already proven present, active and non-deleted there) and runs
 * BEFORE the in-flight guard so a resolution failure has zero side effects.
 * The map is re-read every message (no cache) so a dashboard role update
 * applies to the very next review. A roles-read failure rethrows with the
 * same app-id-prefixed context wrapper as `resolveAppConfig` (greppable
 * retry/DLQ triage).
 */
async function resolveModelOverrides(
  payload: ReviewJobPayload,
  deps: ProcessDeps,
): Promise<Record<string, string> | undefined> {
  const appRef = payload.appRef;
  if (appRef === undefined || appRef.kind === "legacy") {
    return undefined;
  }
  try {
    const roles = await createAppConfigStore(
      deps.env.DB,
      deps.env.DASHBOARD_ENCRYPTION_KEY,
    ).getAppModelRoles(appRef.appId);
    return Object.keys(roles).length > 0 ? roles : undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`per-App model-role resolution failed: app ${appRef.appId}: ${detail}`);
  }
}

/**
 * The effective model selector chain for one message (plan 18 Task 1,
 * architect AL-2) plus WHERE it came from. Precedence: the App's verbatim
 * non-blank chain wins (any falsy or whitespace-only chain = unset, plan 15
 * input bounds); otherwise the global `env.OMP_REVIEW_MODEL`; both unset →
 * `chain: undefined` (the in-image default runs). `fromApp` is the
 * config_source predicate — a chain that comes from the global env is NOT
 * an App contribution, only the App's own stored chain is. This is THE
 * chain-precedence single source — used by BOTH `buildRunnerEnv` (step 3)
 * and the version-record put below, so the recorded model can never drift
 * from the chain the runner actually saw (the chain rides the exec env,
 * never the runner input JSON).
 */
export function effectiveModelChain(
  appCfg: RunnerAppConfig | undefined,
  env: PipelineEnv,
): { chain: string | undefined; fromApp: boolean } {
  const appChain =
    typeof appCfg?.modelChain === "string" && appCfg.modelChain.trim() !== ""
      ? appCfg.modelChain
      : undefined;
  if (appChain !== undefined) return { chain: appChain, fromApp: true };
  if (env.OMP_REVIEW_MODEL !== undefined && env.OMP_REVIEW_MODEL !== "") {
    return { chain: env.OMP_REVIEW_MODEL, fromApp: false };
  }
  return { chain: undefined, fromApp: false };
}

/**
 * The head (primary) selector of an effective chain — the version record
 * written to `reviews.model` (plan 18 Task 1). Comma-separated, trimmed,
 * empty segments dropped (the same grammar as the runner-side selector
 * parse). No chain → NULL: the in-image default ran, and the default
 * selector is NEVER hardcoded worker-side (plan 19's runbook records it
 * next to the image digest).
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
 * Build the in-image runner exec env (step 8): the provider key + harness
 * paths (compass D — secrets never baked into the image), the OMP_REVIEW_MODEL
 * chain when set (bugbot BB-1), and every known provider key that is
 * present-and-non-empty on the Worker env (bugbot BB-2). Forwarding is an
 * ALLOWLIST — only the src/pipeline/providers.ts PROVIDERS keys are read;
 * arbitrary Worker env never reaches the container.
 *
 * Per-App assembly (plan 14 B2, `appCfg` present — per-App messages only):
 * the App's own key wins per provider, injected under the PROVIDERS-mapped
 * env name (skipped when empty/whitespace; a provider id outside the
 * allowlist is skipped with a structured warn — plan 15 log hygiene — that
 * carries the id + app_id, never key material); every provider the App did
 * NOT configure falls back to the global env key (spec fallback chain — a
 * zero-config App keeps working); an App model chain overrides
 * OMP_REVIEW_MODEL. Every injected key is logged
 * with `key_source: app|global` (the source, never the key), and the assembly
 * logs `config_source: app|fallback`. The function builds a FRESH object per
 * call and never mutates its inputs or any module-level record, so key
 * material cannot leak across Apps structurally.
 *
 * Legacy (`appCfg` undefined) is byte-identical to the pre-plan-14 assembly
 * and logs nothing (pinned by tests/pipeline/consumer.test.ts).
 */
export function buildRunnerEnv(
  env: PipelineEnv,
  appCfg?: RunnerAppConfig,
  log?: ConsumerLog,
  fields?: ConsumerLogFields,
): Record<string, string> {
  const runnerEnv: Record<string, string> = {
    ARK_API_KEY: env.OMP_MODEL_KEY,
    HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
    PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
  };
  if (env.OMP_REVIEW_MODEL !== undefined && env.OMP_REVIEW_MODEL !== "") {
    runnerEnv.OMP_REVIEW_MODEL = env.OMP_REVIEW_MODEL;
  }
  if (appCfg === undefined) {
    Object.assign(runnerEnv, pickProviderKeys(env as Record<string, unknown>));
    return runnerEnv;
  }
  // Log only when the caller supplied BOTH the sink and the identity fields
  // (the consumer flow does; direct unit calls may omit them).
  const emit = log !== undefined && fields !== undefined;
  // 1. The App's own keys, mapped through the PROVIDERS allowlist. A provider
  //    id without a mapping has no env name — it is never injected, and the
  //    skip is no longer silent (plan 15 log hygiene 硬化项 3): the rogue id
  //    rides a structured warn (an id + app_id, NEVER key material) so the
  //    operator can see a stored credential going unused.
  let appKeys = 0;
  for (const [provider, plainKey] of Object.entries(appCfg.keys)) {
    const envName = providerEnvName(provider);
    if (envName === undefined) {
      if (emit) {
        log.warn(
          { ...fields, provider },
          "stored provider key id is not on the PROVIDERS allowlist — row skipped",
        );
      }
      continue;
    }
    if (plainKey.trim() === "") continue;
    runnerEnv[envName] = plainKey;
    appKeys += 1;
    if (emit) {
      log.info({ ...fields, provider, key_source: "app" }, `provider key from App config: ${envName}`);
    }
  }
  // 2. Global fallback per provider (spec Per-App BYOK): every allowlisted
  //    provider the App did not configure falls back to the global env key.
  const globalKeys = pickProviderKeys(env as Record<string, unknown>);
  let globalCount = 0;
  for (const [provider, info] of Object.entries(PROVIDERS)) {
    if (runnerEnv[info.envName] !== undefined) continue; // the App's own key won
    const value = globalKeys[info.envName];
    if (value === undefined) continue; // no global key either
    runnerEnv[info.envName] = value;
    globalCount += 1;
    if (emit) {
      log.info(
        { ...fields, provider, key_source: "global" },
        `provider key from global env (not configured on the App): ${info.envName}`,
      );
    }
  }
  // 3. Model chain: the App's verbatim chain overrides OMP_REVIEW_MODEL; any
  //    falsy or BLANK chain (null / "" / whitespace-only — plan 15 input
  //    bounds: a direct-DB write can store a blank chain the routes would
  //    have normalized) is unset → the global chain stays untouched. A chain
  //    with content forwards verbatim — the guard only decides unset-vs-set.
  //    The precedence lives in effectiveModelChain (plan 18 Task 1: ONE
  //    resolution shared with the version-record put; re-resolving the env
  //    chain here to the same value is a harmless no-op overwrite).
  //    config_source stays keyed to the App's OWN chain (fromApp) — a
  //    global-env chain is not an App contribution (plan 14 pin).
  const { chain, fromApp: appChainSet } = effectiveModelChain(appCfg, env);
  if (chain !== undefined) {
    runnerEnv.OMP_REVIEW_MODEL = chain;
  }
  if (emit) {
    log.info(
      { ...fields, config_source: appKeys > 0 || appChainSet ? "app" : "fallback" },
      `per-App env assembly: ${appKeys} provider key(s) from App config, ${globalCount} global fallback` +
        `${appChainSet ? ", model chain from App config" : ""}`,
    );
  }
  return runnerEnv;
}

/**
 * The ACTUAL secret values one review session used (SEC-01 exact-value
 * defense): every credential-shaped value the runner env carried — the
 * provider-key entries (the allowlist-picked global keys + the App's own
 * BYOK keys, both forwarded via buildRunnerEnv) and the ARK_API_KEY source
 * value — plus the installation token minted for the session. These are the
 * values a prompt-injected model could echo verbatim; redactExactSecrets
 * removes them even when they evade every shape pattern. The list is
 * derived from the SAME buildRunnerEnv result the runner exec used (no
 * re-resolution split-brain) and the token minted above.
 */
function sessionSecretValues(runnerEnv: Record<string, string>, token: string): string[] {
  const values: string[] = [token];
  for (const [name, value] of Object.entries(runnerEnv)) {
    if (name === "OMP_REVIEW_MODEL" || name === "HARNESS_PLUGIN_ROOT" || name === "PI_CODING_AGENT_DIR") {
      continue; // configuration/paths, not credentials
    }
    if (value !== "") values.push(value);
  }
  return values;
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
    return (await kv.get(key)) === "done";
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `idempotency KV read failed — falling back to D1: ${detail}`);
    return false;
  }
}
/**
 * Test seam for createReviewConsumer: additive overrides for the process
 * dependencies (store / commenter / per-App commenter factory / getSandbox).
 * The plan contract `createReviewConsumer(env)` is unchanged — every field
 * defaults to the production implementation when omitted.
 */
type ConsumerOverrides = Partial<
  Pick<ProcessDeps, "store" | "failureStore" | "commenter" | "createAppCommenter" | "getSandbox">
>;

/**
 * Create the queue consumer. The store and commenters are created once per
 * consumer instance (the legacy env-App commenter memoizes the app-auth
 * installation-token cache across messages; per-App instances live in the
 * appCommenters Map — one per appId, plan 13 Task 2 lock L4). Each message
 * gets its own sandbox, destroyed in finally; failures rethrow so the queue
 * retries and eventually DLQs.
 *
 * `log` is injectable for tests (default: structured JSON lines). `overrides`
 * lets tests substitute the store / commenter / per-App commenter factory /
 * sandbox factory without process-wide mock.module (bun's relative-path
 * mock.module leaks across test files sharing a worker — CI run
 * 32946710695).
 */
export function createReviewConsumer(
  env: PipelineEnv,
  log: ConsumerLog = defaultConsumerLog,
  overrides: ConsumerOverrides = {},
): (batch: MessageBatch<ReviewJobPayload>) => Promise<void> {
  const deps: ProcessDeps = {
    env,
    store: overrides.store ?? createArtifactStore(env.DB),
    failureStore: overrides.failureStore ?? createFailureStore(env.DB),
    commenter: overrides.commenter ?? createReviewCommenter(env),
    appCommenters: new Map(),
    createAppCommenter: overrides.createAppCommenter ?? createReviewCommenter,
    getSandbox: overrides.getSandbox ?? ((binding, id) => getSandbox(binding, id)),
    log,
  };
  return async (batch) => {
    for (const message of batch.messages) {
      const outcome = await processMessage(message.body, deps);
      // BB-3: guard-held is a typed outcome — schedule the per-message
      // delayed retry (or the final ack-with-warning) instead of throwing
      // into the queue's immediate ×3 retry → DLQ path.
      if (outcome.kind === "guard-held") {
        handleGuardHeld(message, deps);
      } else if (outcome.kind === "paused") {
        // Plan 16 (architect lock L4): a paused App's in-flight message is
        // acked DIRECTLY — an intentional skip with zero side effects, never
        // a retry and never a DLQ entry.
        message.ack();
      } else if (outcome.kind === "degraded") {
        // Plan 18 Task 2 (architect AL-1): parse-fail degrade — the
        // best-effort failure row and degraded comment already ran inside
        // processMessage; the message is acked DIRECTLY (deterministic
        // model-output failure — retry re-runs the same pure function on the
        // same stdout), never a retry and never a DLQ entry.
        message.ack();
      }
    }
  };
}

async function processMessage(payload: ReviewJobPayload, deps: ProcessDeps): Promise<ProcessOutcome> {
  const baseFields = toBaseFields(payload);
  // Unique per attempt (plan Clarify #11): a destroyed sandbox's id is never
  // reused — attach-after-destroy behavior is unknown, uniqueness wins.
  const sandboxId = `review-${crypto.randomUUID()}`;
  let sandbox: ReviewSandbox | null = null;
  // Set once the sha is resolved from the checkout; the failure log carries
  // the idempotency key + sandbox id whenever they exist (Clarify #11 / Done
  // criteria: 失败路径错误日志含幂等键).
  let fields: ConsumerLogFields | undefined;
  // In-flight guard (WF-002): serializes concurrent reviews per PR — keyed
  // without head_sha so `/review` commands (head_sha=null) are covered too.
  const guardKey = reviewGuardKey({
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
  });
  let guardHeld = false;
  // Set once REVIEW_LEVEL resolves inside the try (resolution must stay in
  // the try so an invalid value gets the structured error log); the finally
  // guard release needs the same level's TTL. guardHeld ⇒ level is set
  // (resolution precedes acquisition).
  let level: ReviewLevel | undefined;
  // Runner wall-clock start (d5-budget AC-S10-logs): set just before the
  // runner exec so the failure log can carry elapsed_ms. VISIBILITY ONLY —
  // elapsed never aborts; the sandbox exec timeout is the only wall-clock
  // failure (spec 不 abort).
  let runnerStartedAt: number | undefined;
  // Failure-stage tracking (plan 18 Task 2 / AL-6): the catch site's
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

  try {
    // Review tier (AC-S7-level): resolved BEFORE any sandbox/KV step so a
    // misconfigured REVIEW_LEVEL fails loud (structured log + rethrow)
    // without touching the in-flight guard.
    level = resolveReviewLevel(deps.env.REVIEW_LEVEL);
    // Credential resolution FIRST (plan 13 Task 2, lock L4 — consumer-side),
    // before the guard/sandbox: legacy → env singleton; app → D1 row gated
    // missing/deleted/disabled (throw → retry/DLQ, byte-identical) then
    // PAUSED (plan 16 lock L4: DISTINCT typed outcome, below) → decrypted
    // PEM → per-App commenter instance (cached per appId). An unresolvable
    // App (missing / disabled / soft-deleted / undecryptable) fails
    // structurally here with zero side effects — the rethrow keeps the
    // existing retry/DLQ semantics and no GitHub write ever happens. Token
    // mint and postReview below both use THIS resolved instance (same App
    // identity, lock L4).
    const resolution = await resolveCommenter(payload, deps);
    // Plan 16 ack-skip (architect lock L4): a paused App's in-flight message
    // is the DISTINCT `paused` outcome — the queue handler acks it directly.
    // EVERYTHING below is skipped: no in-flight guard acquisition (no guard
    // TTL consumed), no sandbox creation, no token mint, no app-config read,
    // no GitHub API call, no retry, no DLQ. The structured log rides the
    // existing ConsumerLogFields channel with `event: "review_paused"`
    // (union widened additively) + app_id + the baseFields PR identity.
    if (resolution.kind === "paused") {
      deps.log.info(
        { ...baseFields, event: "review_paused" },
        "review paused — app review_enabled=0; acking with zero side effects (no retry, no DLQ)",
      );
      return { kind: "paused" };
    }
    const commenter = resolution.commenter;
    // Per-App AI config (plan 14 B2): hangs off the SAME appRef resolution as
    // the commenter — one getAppConfig read per message, before the
    // guard/sandbox so an unresolvable config (undecryptable key envelope,
    // missing DASHBOARD_ENCRYPTION_KEY) fails closed with zero side effects.
    // Legacy → undefined → the byte-identical pre-plan-14 env assembly.
    const appCfg = await resolveAppConfig(payload, deps);
    // Per-role model overrides (plan 17 B6): rides the SAME appRef gate,
    // before the guard like the config above. undefined (legacy / empty map)
    // → the runner input JSON below stays byte-identical.
    const modelOverrides = await resolveModelOverrides(payload, deps);
    // 0. In-flight guard (WF-002 / bugbot BB-3): when another review is
    // already running for this PR, return the DISTINCT guard-held outcome —
    // NOT a throw. The consumer schedules a per-message delayed retry
    // (per level: 60/120/240s quick/default, 180/360/720s deep), so the later attempt lands on the update path
    // (round=N+1) once the earlier attempt has posted its marker; after the
    // final delayed attempt the job is acked with a warning — guard-held is
    // not an error state and never goes to the DLQ.
    if (!(await acquireReviewGuard(deps.env.IDEMPOTENCY_KV, guardKey, level, baseFields, deps.log))) {
      return { kind: "guard-held" };
    }
    guardHeld = true;
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
    const token = await commenter.getInstallationToken(payload.installation_id);
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
      runnerPath: RUNNER_PATH,
      level,
      inputPath: RUNNER_INPUT_PATH,
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
    const clone = await sandbox.exec(cmds.clone, {
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
    const rev = await sandbox.exec(cmds.checkedOutSha, { timeout: EXEC_TIMEOUT_GIT_MS });
    if (rev.exitCode !== 0 || rev.stdout.trim() === "") {
      throw new Error(`cannot resolve head sha: git exit ${rev.exitCode}, stdout ${rev.stdout.length}B`);
    }
    const headSha = rev.stdout.trim();

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

    // 4. Dedup: already completed for this checked-out sha → ack (no post,
    // no insert). KV done-state first (B3), then D1. Keyed off the checkout,
    // so a force-push between delivery and processing is never mis-deduped
    // against the stale payload sha.
    const done = await kvDoneHit(deps.env.IDEMPOTENCY_KV, idemKey(key), fields, deps.log);
    if (done) {
      deps.log.info(fields, "KV idempotency hit — ack");
      return { kind: "ok" };
    }
    const existing = await deps.store.findByIdempotencyKey(key);
    if (existing) {
      deps.log.info(fields, "idempotency hit — ack");
      return { kind: "ok" };
    }

    // 5. Diff (GH_TOKEN via exec env only — never in the command).
    const diff = await sandbox.exec(cmds.diff, { env: { GH_TOKEN: token }, timeout: EXEC_TIMEOUT_GIT_MS });
    if (diff.exitCode !== 0) {
      throw new Error(`diff failed: exit ${diff.exitCode}, stdout ${diff.stdout.length}B`);
    }

    // 6. Numstat of the PR diff — `git apply --numstat` reads the unified
    // diff without applying it. The lines ("<add>\t<del>\t<path>") are the
    // runner's seat-partition universe (reconFacts convention, Task 2 port).
    const numstat = await sandbox.exec(cmds.numstat, { timeout: EXEC_TIMEOUT_GIT_MS });
    if (numstat.exitCode !== 0) {
      throw new Error(`numstat failed: exit ${numstat.exitCode}, stdout ${numstat.stdout.length}B`);
    }
    const numstatLines = numstat.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "");

    // 7. Runner input JSON (reconFacts): `<owner>/<repo>#<pr>` and
    // `head <sha>` fold into the envelope target INSIDE the runtime — the
    // AUTHORITATIVE checkout sha is used so the ArtifactStore.put target
    // cross-check agrees with the idempotency key — plus the numstat
    // universe. base64-transported so the JSON never touches shell quoting;
    // worktreePath = the clone (the seats' read cwd).
    const reconFacts = [
      `${payload.owner}/${payload.repo}#${payload.pr_number}`,
      `head ${headSha}`,
      ...numstatLines,
    ];
    // Plan 17 B6: the App's per-role model overrides ride as an OPTIONAL
    // input field, included ONLY when a role map resolved above — legacy /
    // unmapped messages serialize byte-identically to the pre-plan-17 payload
    // (the runner-side guard + type extension are plan 17 Task 2's).
    const runnerInput = {
      worktreePath: CLONE_DIR,
      reconFacts,
      ...(modelOverrides !== undefined ? { modelOverrides } : {}),
    };
    const writeInput = await sandbox.exec(
      writeJsonCommand(RUNNER_INPUT_PATH, toBase64Utf8(JSON.stringify(runnerInput))),
      { timeout: EXEC_TIMEOUT_GIT_MS },
    );
    if (writeInput.exitCode !== 0) {
      throw new Error(`runner input write failed: exit ${writeInput.exitCode}`);
    }

    // 8. In-image runner: cwd = clone dir; provider key + harness paths +
    // OMP_REVIEW_MODEL chain + configured provider keys via exec env
    // (buildRunnerEnv — compass D, BB-1, BB-2; per-App messages assemble the
    // App's BYOK keys/model chain with global-env fallback and key_source
    // logging, plan 14 B2; secrets never baked into the image, never in
    // logs). The runtime runner has NO summary-degrade path: exit 0 ⇒ stdout
    // is the engine-validated mstar.review/v1 envelope.
    // AL-6 stage window: the review run itself — a non-zero exit or an exec
    // exception (timeout / container error) here classifies "runner".
    failureStage = "runner";
    runnerStartedAt = Date.now();
    // SEC-01 exact-value defense: the SAME env object the runner exec used
    // is captured here (single source — no re-resolution split-brain) so
    // the session's actual secret values can be exact-redacted from any
    // model-echoed output below.
    const runnerEnv = buildRunnerEnv(deps.env, appCfg, deps.log, fields);
    const run = await sandbox.exec(cmds.runner, {
      cwd: CLONE_DIR,
      env: runnerEnv,
      timeout: runnerTimeoutMs(level),
    });
    const runnerElapsedMs = Date.now() - runnerStartedAt;
    if (run.exitCode !== 0) {
      throw new Error(`runner failed: exit ${run.exitCode}, stdout ${run.stdout.length}B`);
    }
    // d5-budget AC-S10-logs: one runner attempt → at least one budget line
    // (level + runner_timeout_ms + elapsed_ms + orchestration). elapsed_ms is
    // VISIBILITY ONLY — it never throws; the sandbox exec timeout above is
    // the only wall-clock failure (spec 不 abort).
    deps.log.info(
      { ...fields, elapsed_ms: runnerElapsedMs },
      `runner finished in ${runnerElapsedMs}ms (budget ${runnerTimeoutMs(level)}ms)`,
    );
    // SEC-01 exact-value defense: the session's ACTUAL secret values
    // (runner env provider keys + the minted installation token) — shared
    // by the degrade path and the success path below.
    secretValues = sessionSecretValues(runnerEnv, token);

    // AL-6 stage window: post-runner steps (parse has its own branch; the
    // post/KV/put orchestration is worker-side) are "pipeline" again.
    failureStage = "pipeline";

    // 9. Parse + validate the envelope (engine gate inside parseReviewOutput;
    // mapping spec §4.2). Parse-fail is the DEGRADE path (plan 18 Task 2 /
    // architect AL-1): parseReviewOutput is a pure function of run.stdout —
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
      try {
        // The same resolved commenter instance as the token mint above
        // (lock L4) — the degraded chain rides the PR's own App identity.
        // SEC-01: the error + raw stdout arrive PRE-REDACTED (shape +
        // exact-value passes) — buildDegradedBody's own redaction remains
        // the in-module choke point for anything it adds.
        await commenter.postDegraded({
          installationId: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          prNumber: payload.pr_number,
          error: redactedError,
          rawOutput: redactedStdout,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(fields, `degraded comment post failed (acking anyway): ${detail}`);
      }
      deps.log.warn(
        fields,
        `review degraded: output failed schema validation (${redactedError}) — acked, no retry/DLQ`,
      );
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

    // 11. Upsert the overall review comment FIRST (the user-facing
    // deliverable must not be lost to a later store failure), then persist.
    // T5: the commenter creates the app's marker comment (round=1) on a miss
    // and PATCHes it (round=N+1) on a hit — one comment per PR, never a new
    // review per round. The verdict is rendered as text only (SEC-01).
    // Same resolved commenter instance as the token mint above (lock L4).
    // Returns the round just posted — the line-comments marker pins to it.
    const round = await commenter.postReview({
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      headSha,
      output,
      omittedFindings: capped.omitted,
    });

    // 11a. KV done-state fence (BUG-01): written immediately after the
    // overall-comment upsert succeeds, BEFORE the line-comments step — a
    // crash in the line-comments window redelivers and sees the done key →
    // acks (outcome = overall-only, same as the 422 fallback). Line
    // comments become best-effort after the fence. The D1 insert below
    // still runs after; a put failure keeps the B3 semantics (KV done
    // marks completion, never re-post).
    try {
      await deps.env.IDEMPOTENCY_KV.put(idemKey(key), "done", {
        expirationTtl: IDEMPOTENCY_SECONDS,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `KV completion write failed: ${detail}`);
    }

    // 11a2. Degraded-comment lifecycle (Bugbot finding): the successful
    // review supersedes any earlier degradation — scan for bot-authored
    // `review-degraded:v1` comments on the PR and DELETE them (Issues
    // comments API, app-authored only). Best-effort: the delete step NEVER
    // throws — it returns an outcome (deleted/skipped/errors) that is
    // logged as a structured warn; a stale comment left behind is a warn,
    // never a review blocker. The catch is a defensive guard only — the
    // real implementation never rejects.
    try {
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
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `stale degraded comment delete failed (review stands): ${detail}`);
    }

    // 11b. Line comments (plan 18 Task 3, architect AL-3 layered delivery) —
    // AFTER the overall-comment upsert + KV fence succeeded and NEVER
    // throwing: any Octokit error → structured log + continue (the overall
    // comment, KV done and D1 row below are unaffected). Ordering per
    // brief: upsert → done → diff prefetch → createReview; no retry (next
    // round re-anchors).
    //
    // Layered filter: base = file_path non-empty AND line_end ≥ 1; with the
    // prefetched diff, additionally b-side path exact-match + line_end inside
    // a right-side hunk range (createReview is ATOMIC — one invalid line →
    // the whole request 422s and every line comment is lost, so prefilter).
    // Prefetch failure → base-filter attempt (draft semantics; GitHub
    // validates). Residual 422 (race: fetched diff vs pinned commit_id) or
    // any other createReview error → line_comments_fallback=true log and
    // overall-comment-only for this round. Zero qualifying findings → zero
    // API calls (byte-compat; the diff is not even prefetched).
    const lineCommentable = filterLineCommentFindings(output.findings);
    if (lineCommentable.length > 0) {
      let qualifying = lineCommentable;
      try {
        const diff = await commenter.fetchPrDiff({
          installationId: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          prNumber: payload.pr_number,
        });
        // qc3 F-101: bound the considered diff payload — a multi-MB PR diff
        // would otherwise be materialized into a full line array by
        // parseDiffHunkRanges on EVERY qualifying round. Overflow is treated
        // exactly like a prefetch failure (the catch below): base-filter
        // attempt, residual 422 still falls back per AL-3.
        if (diff.length > DIFF_PREFETCH_MAX_BYTES) {
          throw new Error(
            `diff payload ${diff.length} bytes exceeds DIFF_PREFETCH_MAX_BYTES (${DIFF_PREFETCH_MAX_BYTES}) — skipping the hunk prefilter`,
          );
        }
        qualifying = filterLineCommentFindings(lineCommentable, diff);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          fields,
          `line-comments diff prefetch failed — attempting the base-filtered set unfiltered: ${detail}`,
        );
      }
      if (qualifying.length > 0) {
        try {
          await commenter.postLineComments({
            installationId: payload.installation_id,
            owner: payload.owner,
            repo: payload.repo,
            prNumber: payload.pr_number,
            headSha,
            round,
            findings: qualifying,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            { ...fields, line_comments_fallback: true },
            `line comments failed — overall comment already posted, continuing overall-only: ${detail}`,
          );
        }
      }
    }

    // 13. Persist via the D1 ArtifactStore (plan 07 Task 4): the parsed
    // envelope is the write authority (put re-validates it as defense in
    // depth; a UNIQUE race loss resolves idempotently — the first-written
    // row wins and is never overwritten, so no raw_output twin exists). A
    // put failure AFTER a successful post is a warn + ack, never a rethrow
    // (B3): the comment is out, retrying would re-post it. The missing D1
    // row is acceptable (KV done marks completion) and alerted. Per-App
    // attribution (plan 13 Done criterion, QC F-001): the resolved appRef's
    // appId rides the put into `reviews.app_id`; legacy messages (appRef
    // absent or `{ kind: "legacy" }`) omit it → the row keeps app_id NULL.
    try {
      await deps.store.put({
        kind: "review",
        key: idemKey(key),
        schema: "mstar.review/v1",
        payload: output,
        ...(payload.appRef?.kind === "app" ? { appId: payload.appRef.appId } : {}),
        // Version records (plan 18 Task 1, architect AL-2): `model` = the
        // head selector of the SAME effective chain the runner exec env
        // carried (single-sourced via effectiveModelChain — no re-resolution
        // split-brain; both unset → NULL = the in-image default ran).
        // `provider` is NULL on BOTH paths: RunnerAppConfig carries a
        // multi-provider key set, not one provider — never invent a mapping.
        // Plan-17 modelOverrides are NOT reflected in the columns.
        model: chainHeadSelector(effectiveModelChain(appCfg, deps.env).chain),
        provider: null,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        fields,
        `review posted but insert failed — D1 row missing, acking to avoid a duplicate comment: ${detail}`,
      );
    }
    return { kind: "ok" };
  } catch (err) {
    // Structured failure log carrying the idempotency key + sandbox id
    // (plan Clarify #11 / Done criteria: 失败路径错误日志含幂等键), then
    // rethrow so the worker retries and eventually DLQs.
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.error(
      {
        ...(fields ?? { ...baseFields, sandbox_id: sandboxId }),
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

    // AL-6 (plan 18 Task 2): best-effort review_failures row BEFORE the
    // rethrow — DLQ-bound infra failures otherwise leave zero D1 trace (the
    // plan-19 sweep blind spot). `stage` = the coarse phase in flight
    // (failureStage); rows are per-attempt events (a DLQ'd message leaves
    // up to 4: 1 initial delivery + max_retries = 3 retries). The insert
    // must never mask the rethrow: its own failure is a warn line only.
    // SEC-03: the error detail is redacted (shape + exact-value passes)
    // before the durable row — an infra error can interpolate a
    // secret-shaped value (defense-in-depth; clean strings pass through).
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
        error: redactExactSecrets(redactSecrets(detail), secretValues),
      });
    } catch (recordErr) {
      const recordDetail = recordErr instanceof Error ? recordErr.message : String(recordErr);
      deps.log.warn(
        fields ?? { ...baseFields, sandbox_id: sandboxId },
        `review_failures insert failed (rethrow unchanged): ${recordDetail}`,
      );
    }
    throw err;
  } finally {
    // Release the in-flight guard once the review settled (posted, KV done,
    // put attempted) OR failed — either way the next attempt may proceed.
    // releaseReviewGuard never throws (KV failure → warn; TTL expires it).
    if (guardHeld && level !== undefined) {
      await releaseReviewGuard(deps.env.IDEMPOTENCY_KV, guardKey, level, fields ?? baseFields, deps.log);
    }
    if (sandbox !== null) {
      try {
        await sandbox.destroy();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { ...(fields ?? baseFields), sandbox_id: sandboxId },
          `sandbox destroy failed: ${detail}`,
        );
      }
    }
  }
}
