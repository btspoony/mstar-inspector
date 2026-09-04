/**
 * Sandbox smoke entry (plan 06 Task 1 STOP gate + Task 2 runner falsification)
 * — a dedicated Worker entry that exercises the real sandbox path locally via
 * `wrangler dev`. Not the production worker entry: the production consumer
 * wiring lands in `src/worker/index.ts` at T3. The `Sandbox` Durable Object
 * class is re-exported here (and only here) so the containers binding
 * resolves; the SDK import point stays `src/pipeline/sandbox.ts`.
 *
 * Routes:
 *   GET /healthz         → 200 {"ok":true} (readiness probe for the orchestrator)
 *   GET /smoke           → T1 falsification: getSandbox → exec gh pr diff →
 *                          destroy. Path 2 falls back to a git clone + diff
 *                          (token injected via git env config, never in the
 *                          command string). Returns JSON evidence, no secrets.
 *   GET /smoke-review    → T2: clone the real PR head (btspoony/todo-bots#1),
 *                          write the runner --input JSON (reconFacts: PR fact
 *                          + checked-out head sha + numstat universe — the
 *                          same shape src/pipeline/consumer.ts writes), exec
 *                          the in-image runner (src/review/runner.ts) on its
 *                          current `--level quick --input <file>` CLI with
 *                          ARK_API_KEY via exec env, parse the stdout with
 *                          parseReviewOutput, then destroy. The model key is
 *                          never baked into the image and never echoed in the
 *                          response (only a pass/fail + review shape).
 */

import { runnerCommand, writeJsonCommand } from "./gitops";
import { getSandbox, Sandbox, type ReviewSandbox, type SandboxBinding } from "./sandbox";
import { parseReviewOutput } from "../review/schema";

export { Sandbox };

type SmokeEnv = {
  SANDBOX: SandboxBinding;
  /** Installation token minted by the orchestrator (scripts/sandbox-smoke.ts). */
  GH_TOKEN: string;
  /** omp model key for the ark-plan provider (T2 runner smoke; injected per exec). */
  ARK_API_KEY?: string;
};

const GH_REPO = "btspoony/todo-bots";
const GH_PR = "1";
const CLONE_DIR = "/workspace/repo";
/** Runner --input JSON path (same constant as the production consumer). */
const INPUT_PATH = "/workspace/review-input.json";
/** In-image runner path (Dockerfile v2: WORKDIR /opt/runner, COPY src/review). */
const RUNNER_PATH = "/opt/runner/src/review/runner.ts";
const HARNESS_ROOT = "/opt/mstar-harness";
/** Image omp agent dir (PI_CODING_AGENT_DIR, empty — the runner synthesizes every models.yml; plan 37). */
const OMP_AGENT_DIR = "/opt/omp-agent";

export default {
  async fetch(request: Request, env: SmokeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/smoke-review") {
      return runReviewSmoke(env);
    }
    if (url.pathname !== "/smoke") {
      return new Response("not found", { status: 404 });
    }

    const sandbox = await getSandbox(env.SANDBOX, `smoke-${crypto.randomUUID()}`);
    const startedAt = Date.now();
    let result: Record<string, unknown>;
    try {
      // Path 1 (primary hypothesis): gh CLI with GH_TOKEN env injection.
      const gh = await sandbox.exec(`gh pr diff ${GH_PR} --repo ${GH_REPO}`, {
        env: { GH_TOKEN: env.GH_TOKEN },
      });
      if (gh.exitCode === 0 && gh.stdout.trim().length > 0) {
        result = {
          ok: true,
          path: "gh",
          exitCode: gh.exitCode,
          stdoutBytes: gh.stdout.length,
          prefix: gh.stdout.slice(0, 40),
          latencyMs: Date.now() - startedAt,
        };
      } else {
        // Path 2 (fallback): git equivalent — clone the PR head, diff against
        // base. Token injected via git env config (never in the command string).
        const git = await sandbox.exec(
          [
            `git clone --depth 1 --branch mstar-inspector-seed https://github.com/${GH_REPO}.git ${CLONE_DIR}`,
            `cd ${CLONE_DIR}`,
            "git fetch --depth 1 origin main",
            "git diff FETCH_HEAD HEAD",
          ].join(" && "),
          {
            env: {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.extraheader",
              GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${env.GH_TOKEN}`)}`,
            },
          },
        );
        if (git.exitCode === 0 && git.stdout.trim().length > 0) {
          result = {
            ok: true,
            path: "git",
            exitCode: git.exitCode,
            stdoutBytes: git.stdout.length,
            prefix: git.stdout.slice(0, 40),
            latencyMs: Date.now() - startedAt,
            ghFallbackReason: `gh exit ${gh.exitCode}, stdout ${gh.stdout.length}B`,
          };
        } else {
          result = {
            ok: false,
            path: "none",
            gh: { exitCode: gh.exitCode, stdoutBytes: gh.stdout.length },
            git: { exitCode: git.exitCode, stdoutBytes: git.stdout.length },
            latencyMs: Date.now() - startedAt,
          };
        }
      }
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      };
    }

    // Destroy is part of the falsification evidence: run it before returning
    // so the response carries the destroy outcome (plan Verdict key).
    try {
      await sandbox.destroy();
      result.destroyEvidence = { ok: true };
    } catch (error) {
      result.destroyEvidence = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return Response.json(result, { status: result.ok ? 200 : 500 });
  },
};

/**
 * T2 runner falsification: real SDK, real model key (ARK_API_KEY via exec env),
 * real PR clone (btspoony/todo-bots#1). The runner inside the image reads the
 * diff file, runs the omp review session, and prints ONLY the ReviewOutput JSON
 * to stdout. We parse that stdout with parseReviewOutput and return the verdict
 * shape — never the key, never the raw model text.
 */
async function runReviewSmoke(env: SmokeEnv): Promise<Response> {
  const sandbox = await getSandbox(env.SANDBOX, `smoke-review-${crypto.randomUUID()}`);
  const startedAt = Date.now();
  let result: Record<string, unknown>;
  try {
    if (!env.ARK_API_KEY) {
      throw new Error("ARK_API_KEY env is required for /smoke-review");
    }

    // 1. Clone the real PR head + base into the container.
    const clone = await sandbox.exec(
      [
        `rm -rf ${CLONE_DIR}`,
        `git clone --depth 1 --branch mstar-inspector-seed https://github.com/${GH_REPO}.git ${CLONE_DIR}`,
        `cd ${CLONE_DIR}`,
        "git fetch --depth 1 origin main",
      ].join(" && "),
    );
    if (clone.exitCode !== 0) {
      result = {
        ok: false,
        step: "clone",
        exitCode: clone.exitCode,
        stdoutBytes: clone.stdout.length,
        latencyMs: Date.now() - startedAt,
      };
    } else {
      result = await execInImageReview(sandbox, env.ARK_API_KEY, startedAt);
    }
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  }

  try {
    await sandbox.destroy();
    result.destroyEvidence = { ok: true };
  } catch (error) {
    result.destroyEvidence = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return Response.json(result, { status: result.ok ? 200 : 500 });
}

/**
 * Steps 2–4 of the review smoke: recon facts → runner input JSON → exec the
 * in-image review runner. The runner input is the same shape the production
 * consumer writes (src/pipeline/consumer.ts): PR fact + checked-out head sha
 * + the numstat universe, base64-transported so the JSON never touches shell
 * interpolation. The model key is injected via exec env only (never baked
 * into the image).
 */
async function execInImageReview(
  sandbox: ReviewSandbox,
  arkApiKey: string,
  startedAt: number,
): Promise<Record<string, unknown>> {
  const recon = await sandbox.exec(
    `cd ${CLONE_DIR} && git rev-parse HEAD && git diff --numstat FETCH_HEAD HEAD`,
  );
  if (recon.exitCode !== 0) {
    return {
      ok: false,
      step: "recon",
      exitCode: recon.exitCode,
      stdoutBytes: recon.stdout.length,
      latencyMs: Date.now() - startedAt,
    };
  }
  const [headSha, ...numstat] = recon.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const inputB64 = Buffer.from(
    JSON.stringify({
      worktreePath: CLONE_DIR,
      reconFacts: [`${GH_REPO}#${GH_PR}`, `head ${headSha}`, ...numstat],
    }),
    "utf8",
  ).toString("base64");
  const writeInput = await sandbox.exec(writeJsonCommand(INPUT_PATH, inputB64));
  if (writeInput.exitCode !== 0) {
    return {
      ok: false,
      step: "input-write",
      exitCode: writeInput.exitCode,
      latencyMs: Date.now() - startedAt,
    };
  }

  const run = await sandbox.exec(runnerCommand(RUNNER_PATH, "quick", INPUT_PATH), {
    cwd: CLONE_DIR,
    env: {
      HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
      PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
      ARK_API_KEY: arkApiKey,
    },
  });
  const parsed = parseReviewOutput(run.stdout);
  return {
    ok: run.exitCode === 0 && parsed.ok,
    step: "runner",
    level: "quick",
    runnerExitCode: run.exitCode,
    stdoutBytes: run.stdout.length,
    parseOk: parsed.ok,
    mode: parsed.ok ? "structured" : undefined,
    verdict: parsed.ok ? parsed.output.verdict : undefined,
    findingsCount: parsed.ok ? parsed.output.findings.length : undefined,
    summaryBytes: parsed.ok ? parsed.output.summary_md.length : undefined,
    latencyMs: Date.now() - startedAt,
  };
}
