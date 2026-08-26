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
 * insert, structured log, rethrow.
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

import type { D1Database, KVNamespace, MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import { idemKey, IDEMPOTENCY_SECONDS, type IdempotencyKey } from "../contracts/idem";
import { parseReviewOutput, capFindings } from "../review/schema";
import { redactReviewOutput, redactSecrets } from "./redact";
import { createReviewStore, type ReviewStore } from "../store/reviews";
import { getSandbox, type ReviewSandbox } from "./sandbox";
import { buildGitOpsCommands } from "./gitops";
import { createReviewCommenter, type ReviewCommenter } from "./comment";

export type PipelineEnv = {
  APP_ID: string;
  PRIVATE_KEY: string;
  OMP_MODEL_KEY: string; // omp model key; injected into the container as ARK_API_KEY
  DB: D1Database;
  IDEMPOTENCY_KV: KVNamespace;
  SANDBOX: unknown; // binding shape = DurableObjectNamespace<Sandbox> (T1-pinned)
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

type ProcessDeps = {
  env: PipelineEnv;
  store: ReviewStore;
  commenter: ReviewCommenter;
  log: ConsumerLog;
  getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
};

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
      await processMessage(message.body, deps);
    }
  };
}

async function processMessage(payload: ReviewJobPayload, deps: ProcessDeps): Promise<void> {
  const baseFields: ConsumerLogFields = {
    event: payload.triggered_by === "pull_request" ? "pull_request" : "review_command",
    action: payload.action,
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: payload.head_sha,
  };
  // Unique per attempt (plan Clarify #11): a destroyed sandbox's id is never
  // reused — attach-after-destroy behavior is unknown, uniqueness wins.
  const sandboxId = `review-${crypto.randomUUID()}`;
  let sandbox: ReviewSandbox | null = null;
  // Set once the sha is resolved from the checkout; the failure log carries
  // the idempotency key + sandbox id whenever they exist (Clarify #11 / Done
  // criteria: 失败路径错误日志含幂等键).
  let fields: ConsumerLogFields | undefined;

  try {
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
      return;
    }
    const existing = await deps.store.findByIdempotencyKey(key);
    if (existing) {
      deps.log.info(fields, "idempotency hit — ack");
      return;
    }

    // 5. Diff (GH_TOKEN via exec env only — never in the command).
    const diff = await sandbox.exec(cmds.diff, { env: { GH_TOKEN: token }, timeout: EXEC_TIMEOUT_GIT_MS });
    if (diff.exitCode !== 0) {
      throw new Error(`diff failed: exit ${diff.exitCode}, stdout ${diff.stdout.length}B`);
    }

    // 6. In-image runner: cwd = clone dir; model key + harness paths via exec
    // env (compass D — secrets never baked into the image).
    const run = await sandbox.exec(cmds.runner, {
      cwd: CLONE_DIR,
      env: {
        ARK_API_KEY: deps.env.OMP_MODEL_KEY,
        HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
        PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
      },
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
