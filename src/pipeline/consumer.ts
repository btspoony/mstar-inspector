/**
 * Queue consumer — the review pipeline main flow (plan 06 Task 3).
 *
 * Flow (plan Tasks / compass S6): message → resolve sha (null → gh pr view
 * in the sandbox) → findByIdempotencyKey (hit → ack) → getSandbox (unique id
 * per attempt) → clone + diff → exec the in-image runner (env-injected
 * GH_TOKEN/ARK_API_KEY/PI_CODING_AGENT_DIR/M0_HARNESS_PLUGIN_ROOT) →
 * parseReviewOutput → post the overall Review comment FIRST → insertReview
 * (duplicate → ack) → KV completion state → finally destroy. Any step
 * throwing → structured log + rethrow (queue retry → DLQ). A runner result
 * that is not the structured main path (summary degrade, Clarify #9.5) is
 * treated as a failure: no post, no insert, structured log, rethrow.
 *
 * Module boundary (compass contracts A): this is the ONLY legal edge from
 * worker → pipeline (worker/index.ts queue wiring). It imports contracts/
 * (payload + idempotency key), review/schema (pure zod), store/reviews (05),
 * and the pipeline modules — never src/worker/**.
 */

import type { D1Database, KVNamespace, MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import { idemKey, IDEMPOTENCY_SECONDS, type IdempotencyKey } from "../contracts/idem";
import { parseReviewOutput } from "../review/schema";
import { createReviewStore, type ReviewStore } from "../store/reviews";
import { getSandbox, type ReviewSandbox } from "./sandbox";
import { buildGitOpsCommands, resolveHeadShaCommand } from "./gitops";
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
};

/**
 * Create the queue consumer. The store and commenter are created once per
 * consumer instance (the commenter memoizes the app-auth installation-token
 * cache across messages). Each message gets its own sandbox, destroyed in
 * finally; failures rethrow so the queue retries and eventually DLQs.
 *
 * `log` is injectable for tests (default: structured JSON lines).
 */
export function createReviewConsumer(
  env: PipelineEnv,
  log: ConsumerLog = defaultConsumerLog,
): (batch: MessageBatch<ReviewJobPayload>) => Promise<void> {
  const deps: ProcessDeps = {
    env,
    store: createReviewStore(env.DB),
    commenter: createReviewCommenter(env),
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
  // Set once the sha is resolved; the failure log carries the idempotency
  // key + sandbox id whenever they exist (plan Clarify #11 / Done criteria).
  let fields: ConsumerLogFields | undefined;

  try {
    // 1. Resolve the head sha: payload sha wins; null (e.g. /review command)
    // → gh pr view inside the sandbox.
    let headSha = payload.head_sha;
    if (!headSha) {
      sandbox = await getSandbox(deps.env.SANDBOX, sandboxId);
      const token = await deps.commenter.getInstallationToken(payload.installation_id);
      const resolved = await sandbox.exec(
        resolveHeadShaCommand(payload.owner, payload.repo, payload.pr_number),
        { env: { GH_TOKEN: token } },
      );
      if (resolved.exitCode !== 0 || resolved.stdout.trim() === "") {
        throw new Error(
          `cannot resolve head sha: gh exit ${resolved.exitCode}, stdout ${resolved.stdout.length}B`,
        );
      }
      headSha = resolved.stdout.trim();
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
      head_sha: headSha,
      idempotency_key: idemKey(key),
      sandbox_id: sandboxId,
    };

    // 2. Dedup: a stored review for this sha → ack (no post, no insert).
    const existing = await deps.store.findByIdempotencyKey(key);
    if (existing) {
      deps.log.info(fields, "idempotency hit — ack");
      return;
    }

    // 3. Sandbox (created lazily; destroyed in finally).
    if (sandbox === null) {
      sandbox = await getSandbox(deps.env.SANDBOX, sandboxId);
    }
    const token = await deps.commenter.getInstallationToken(payload.installation_id);
    const cmds = buildGitOpsCommands({
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      headSha,
      cloneDir: CLONE_DIR,
      diffPath: DIFF_PATH,
      runnerPath: RUNNER_PATH,
    });

    // 4. Clone + diff (GH_TOKEN via exec env only — never in the command).
    const clone = await sandbox.exec(cmds.clone, { env: { GH_TOKEN: token } });
    if (clone.exitCode !== 0) {
      throw new Error(`clone failed: exit ${clone.exitCode}, stdout ${clone.stdout.length}B`);
    }
    const diff = await sandbox.exec(cmds.diff, { env: { GH_TOKEN: token } });
    if (diff.exitCode !== 0) {
      throw new Error(`diff failed: exit ${diff.exitCode}, stdout ${diff.stdout.length}B`);
    }

    // 5. In-image runner: cwd = clone dir; model key + harness paths via exec
    // env (compass D — secrets never baked into the image).
    const run = await sandbox.exec(cmds.runner, {
      cwd: CLONE_DIR,
      env: {
        ARK_API_KEY: deps.env.OMP_MODEL_KEY,
        M0_HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
        PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
      },
    });
    if (run.exitCode !== 0) {
      throw new Error(`runner failed: exit ${run.exitCode}, stdout ${run.stdout.length}B`);
    }

    // 6. Structured-mode gate (Clarify #9.5): the runner exits 0 for BOTH
    // structured and summary modes (M0 CLI contract), so the mode lives on
    // stderr (`review mode: ${mode}`). A summary degrade — or a missing
    // marker — is NOT a successful e2e: no review, no insert, rethrow into
    // retry/DLQ (M2 decides the GitHub-side posting policy for degrades).
    if (!run.stderr.includes(STRUCTURED_MODE_MARKER)) {
      throw new Error(
        `runner did not emit the structured mode marker (${JSON.stringify(STRUCTURED_MODE_MARKER)}); stderr ${run.stderr.length}B`,
      );
    }

    // 7. Parse: failure → no review, no insert (plan Notes for findings-schema).
    const parsed = parseReviewOutput(run.stdout);
    if (!parsed.ok) {
      throw new Error(`parse failed: ${parsed.error}`);
    }

    // 8. Post the overall review FIRST (the user-facing deliverable must not
    // be lost to a later store failure), then insert.
    await deps.commenter.postReview({
      installationId: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      prNumber: payload.pr_number,
      headSha,
      output: parsed.output,
    });

    // 9. Insert: duplicate (race lost) → ack; the review row already exists.
    const result = await deps.store.insertReview({
      key,
      output: parsed.output,
      raw: run.stdout,
    });
    if (result.outcome === "duplicate") {
      deps.log.info(fields, "duplicate insert — ack");
    }

    // 10. KV completion state (observability; the D1 row is the durable record).
    try {
      await deps.env.IDEMPOTENCY_KV.put(idemKey(key), "done", {
        expirationTtl: IDEMPOTENCY_SECONDS,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log.warn(fields, `KV completion write failed: ${detail}`);
    }
  } catch (err) {
    // Structured failure log carrying the idempotency key + sandbox id
    // (plan Clarify #11 / Done criteria: 失败路径错误日志含幂等键), then
    // rethrow so the queue retries and eventually DLQs.
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
