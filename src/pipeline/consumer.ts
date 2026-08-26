/**
 * Queue consumer — the review pipeline main flow (plan 06 Task 3).
 *
 * Flow (plan Tasks / compass S6): message → getSandbox (unique id per
 * attempt) → clone the PR head branch (git transport auth via scoped
 * extraheader env) → `git rev-parse HEAD` for the AUTHORITATIVE sha →
 * dedup by that sha (hit → ack) → diff → exec the in-image runner
 * (env-injected GH_TOKEN/ARK_API_KEY/PI_CODING_AGENT_DIR/
 * HARNESS_PLUGIN_ROOT) → parseReviewOutput → post the overall Review
 * comment FIRST → insertReview (duplicate → ack) → KV completion state →
 * finally destroy. Any step throwing → structured log + rethrow (queue
 * retry → DLQ). A runner result that is not the structured main path
 * (summary degrade, Clarify #9.5) is treated as a failure: no post, no
 * insert, structured log, rethrow. The in-flight guard is the ONE typed
 * exception (bugbot BB-3): guard-held returns a distinct outcome, not a
 * throw — the consumer schedules a per-message delayed retry
 * (60s/120s/240s) and finally acks with a warning instead of DLQing.
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
 * (payload + idempotency key), review/schema (pure zod), store/reviews (05),
 * and the pipeline modules — never src/worker/**.
 */

import type { D1Database, KVNamespace, Message, MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import { idemKey, IDEMPOTENCY_SECONDS, type IdempotencyKey } from "../contracts/idem";
import { parseReviewOutput, capFindings } from "../review/schema";
import { redactReviewOutput, redactSecrets } from "./redact";
import { createReviewStore, type ReviewStore } from "../store/reviews";
import { getSandbox, type ReviewSandbox } from "./sandbox";
import { buildGitOpsCommands } from "./gitops";
import { createReviewCommenter, type ReviewCommenter } from "./comment";
import { pickProviderKeys } from "./providers";

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
const RUNNER_PATH = "/opt/runner/src/review/runner.ts";
const HARNESS_ROOT = "/opt/mstar-harness";
const OMP_AGENT_DIR = "/opt/omp-agent";

// Per-call exec bounds (ms) — every sandbox exec carries an explicit timeout
// so a hung gh/git/model call fails deterministically instead of silently
// eating a container (plan QC 06 fix round 1 / qc3 F-001).
/** gh/git steps (clone, rev-parse, diff) — measured ~2.6s, 2min is generous. */
const EXEC_TIMEOUT_GIT_MS = 120_000;
/** In-image runner (real model call, measured ~52s) — 10min ceiling. */
const EXEC_TIMEOUT_RUNNER_MS = 600_000;

/**
 * Runner stderr marker for the structured main path (src/review/run.ts prints
 * `review mode: ${mode}` to stderr; stdout carries only the ReviewOutput JSON
 * in BOTH modes). Clarify #9.5: a summary degrade must not count as a
 * successful e2e — the consumer refuses post/insert unless this marker is
 * present, and rethrows into retry/DLQ.
 */
const STRUCTURED_MODE_MARKER = "review mode: structured";

/** Structured log fields: seven event fields + sandbox id + idempotency key. */
export type ConsumerLogFields = {
  event: "pull_request" | "review_command";
  action: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  sandbox_id?: string;
  idempotency_key?: string;
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
 * Guard TTL (seconds): must exceed the max review wall-clock — the runner
 * step (600s) plus the three git steps (clone / rev-parse / diff, 120s each)
 * plus slack — so the guard can never expire mid-review and unblock a
 * concurrent duplicate. KV expirationTtl is in seconds.
 */
export const REVIEW_GUARD_TTL_SECONDS = Math.ceil(
  (EXEC_TIMEOUT_RUNNER_MS + 3 * EXEC_TIMEOUT_GIT_MS + 60_000) / 1000,
);

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
  fields: ConsumerLogFields,
  log: ConsumerLog,
): Promise<boolean> {
  try {
    if ((await kv.get(key)) !== null) return false;
    await kv.put(key, "inflight", { expirationTtl: REVIEW_GUARD_TTL_SECONDS });
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
  fields: ConsumerLogFields,
  log: ConsumerLog,
): Promise<void> {
  try {
    await kv.delete(key);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `in-flight guard release failed — guard expires by TTL (${REVIEW_GUARD_TTL_SECONDS}s): ${detail}`);
  }
}

/**
 * Guard-held backoff schedule (seconds), indexed by message.attempts (1-based
 * — the first delivery is attempt 1). 60s → 120s → 240s, all below
 * REVIEW_GUARD_TTL_SECONDS (the constant above, ~17min) so the held guard
 * can never expire mid-backoff into a duplicate race. Attempts past the
 * schedule's end have consumed the queue's max_retries and must be acked, not
 * retried (a further retry() would land the job on the DLQ).
 */
export const GUARD_RETRY_DELAYS_SECONDS = [60, 120, 240] as const;

/**
 * Outcome of one message pass (bugbot BB-3). The in-flight guard is a
 * DISTINCT typed outcome, not a failure: a guard-held message is scheduled
 * for a per-message delayed retry and finally acked with a warning — it is
 * never rethrown into the immediate-retry ×3 → DLQ path. Real failures keep
 * the existing throw → retry → DLQ behavior.
 */
export type ProcessOutcome = { kind: "ok" } | { kind: "guard-held" };

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
  const delaySeconds = GUARD_RETRY_DELAYS_SECONDS[message.attempts - 1];
  if (delaySeconds !== undefined) {
    deps.log.info(
      fields,
      `review already in flight — scheduling delayed retry in ${delaySeconds}s (attempt ${message.attempts})`,
    );
    message.retry({ delaySeconds });
  } else {
    deps.log.warn(
      fields,
      `review still in flight after ${GUARD_RETRY_DELAYS_SECONDS.length} delayed retries (attempt ${message.attempts}) — acking, no DLQ (guard-held is not an error; the next event for the PR re-reviews)`,
    );
    message.ack();
  }
}

type ProcessDeps = {
  env: PipelineEnv;
  store: ReviewStore;
  commenter: ReviewCommenter;
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
  };
}

/**
 * Build the in-image runner exec env (step 6): the provider key + harness
 * paths (compass D — secrets never baked into the image), the OMP_REVIEW_MODEL
 * chain when set (bugbot BB-1), and every known provider key that is
 * present-and-non-empty on the Worker env (bugbot BB-2). Forwarding is an
 * ALLOWLIST — only the src/pipeline/providers.ts PROVIDERS keys are read;
 * arbitrary Worker env never reaches the container.
 */
function buildRunnerEnv(env: PipelineEnv): Record<string, string> {
  const runnerEnv: Record<string, string> = {
    ARK_API_KEY: env.OMP_MODEL_KEY,
    HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
    PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
  };
  if (env.OMP_REVIEW_MODEL !== undefined && env.OMP_REVIEW_MODEL !== "") {
    runnerEnv.OMP_REVIEW_MODEL = env.OMP_REVIEW_MODEL;
  }
  Object.assign(runnerEnv, pickProviderKeys(env as Record<string, unknown>));
  return runnerEnv;
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
 * dependencies (store / commenter / getSandbox). The plan contract
 * `createReviewConsumer(env)` is unchanged — every field defaults to the
 * production implementation when omitted.
 */
type ConsumerOverrides = Partial<Pick<ProcessDeps, "store" | "commenter" | "getSandbox">>;

/**
 * Create the queue consumer. The store and commenter are created once per
 * consumer instance (the commenter memoizes the app-auth installation-token
 * cache across messages). Each message gets its own sandbox, destroyed in
 * finally; failures rethrow so the queue retries and eventually DLQs.
 *
 * `log` is injectable for tests (default: structured JSON lines). `overrides`
 * lets tests substitute the store / commenter / sandbox factory without
 * process-wide mock.module (bun's relative-path mock.module leaks across test
 * files sharing a worker — CI run 32946710695).
 */
export function createReviewConsumer(
  env: PipelineEnv,
  log: ConsumerLog = defaultConsumerLog,
  overrides: ConsumerOverrides = {},
): (batch: MessageBatch<ReviewJobPayload>) => Promise<void> {
  const deps: ProcessDeps = {
    env,
    store: overrides.store ?? createReviewStore(env.DB),
    commenter: overrides.commenter ?? createReviewCommenter(env),
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

  try {
    // 0. In-flight guard (WF-002 / bugbot BB-3): when another review is
    // already running for this PR, return the DISTINCT guard-held outcome —
    // NOT a throw. The consumer schedules a per-message delayed retry
    // (60s/120s/240s), so the later attempt lands on the update path
    // (round=N+1) once the earlier attempt has posted its marker; after the
    // final delayed attempt the job is acked with a warning — guard-held is
    // not an error state and never goes to the DLQ.
    if (!(await acquireReviewGuard(deps.env.IDEMPOTENCY_KV, guardKey, baseFields, deps.log))) {
      return { kind: "guard-held" };
    }
    guardHeld = true;
    // 1. Sandbox + installation token (created lazily; destroyed in finally).
    if (sandbox === null) {
      sandbox = await deps.getSandbox(deps.env.SANDBOX, sandboxId);
    }
    const token = await deps.commenter.getInstallationToken(payload.installation_id);
    const cmds = buildGitOpsCommands({
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      cloneDir: CLONE_DIR,
      diffPath: DIFF_PATH,
      runnerPath: RUNNER_PATH,
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

    // 6. In-image runner: cwd = clone dir; provider key + harness paths +
    // OMP_REVIEW_MODEL chain + configured provider keys via exec env
    // (buildRunnerEnv — compass D, BB-1, BB-2; secrets never baked into the
    // image, never in logs).
    const run = await sandbox.exec(cmds.runner, {
      cwd: CLONE_DIR,
      env: buildRunnerEnv(deps.env),
      timeout: EXEC_TIMEOUT_RUNNER_MS,
    });
    if (run.exitCode !== 0) {
      throw new Error(`runner failed: exit ${run.exitCode}, stdout ${run.stdout.length}B`);
    }

    // 7. Structured-mode gate (Clarify #9.5): the runner exits 0 for BOTH
    // structured and summary modes (M0 CLI contract), so the mode lives on
    // stderr (`review mode: ${mode}`). A summary degrade — or a missing
    // marker — is NOT a successful e2e: no review, no insert, rethrow into
    // retry/DLQ (M2 decides the GitHub-side posting policy for degrades).
    if (!run.stderr.includes(STRUCTURED_MODE_MARKER)) {
      throw new Error(
        `runner did not emit the structured mode marker (${JSON.stringify(STRUCTURED_MODE_MARKER)}); stderr ${run.stderr.length}B`,
      );
    }

    // 8. Parse: failure → no review, no insert (plan Notes for findings-schema).
    const parsed = parseReviewOutput(run.stdout);
    if (!parsed.ok) {
      throw new Error(`parse failed: ${parsed.error}`);
    }

    // 9. SEC-02 + B4 choke point: redact secret-shaped spans (PEM, tokens,
    // keys, long hex) and cap findings to the Top-50 by severity BEFORE
    // anything can reach the public review body or D1 raw_output. The SAME
    // capped array feeds both the post and the insert (B4: 渲染与落库同一
    // 裁剪数组).
    const capped = capFindings(redactReviewOutput(parsed.output));
    const output = capped.output;

    // 10. Upsert the overall review comment FIRST (the user-facing
    // deliverable must not be lost to a later store failure), then persist.
    // T5: the commenter creates the app's marker comment (round=1) on a miss
    // and PATCHes it (round=N+1) on a hit — one comment per PR, never a new
    // review per round. The verdict is rendered as text only (SEC-01).
    await deps.commenter.postReview({
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      headSha,
      output,
      omittedFindings: capped.omitted,
    });

    // 11. KV done-state immediately after the comment lands, BEFORE the D1
    // insert (B3): if the insert then fails, a retry hits the KV done key and
    // acks — the comment is already out and must never be re-posted.
    try {
      await deps.env.IDEMPOTENCY_KV.put(idemKey(key), "done", {
        expirationTtl: IDEMPOTENCY_SECONDS,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `KV completion write failed: ${detail}`);
    }

    // 12. Insert: duplicate (race lost) → ack; the review row already exists.
    // An insert failure AFTER a successful post is a warn + ack, never a
    // rethrow (B3): the comment is out, retrying would re-post it. The
    // missing D1 row is acceptable (KV done marks completion) and alerted.
    try {
      const result = await deps.store.insertReview({
        key,
        output,
        raw: redactSecrets(run.stdout),
      });
      if (result.outcome === "duplicate") {
        deps.log.info(fields, "duplicate insert — ack");
      }
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
      fields ?? { ...baseFields, sandbox_id: sandboxId },
      `review failed: ${detail}`,
    );
    throw err;
  } finally {
    // Release the in-flight guard once the review settled (posted, KV done,
    // insert attempted) OR failed — either way the next attempt may proceed.
    // releaseReviewGuard never throws (KV failure → warn; TTL expires it).
    if (guardHeld) {
      await releaseReviewGuard(deps.env.IDEMPOTENCY_KV, guardKey, fields ?? baseFields, deps.log);
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
