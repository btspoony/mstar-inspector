/**
 * note: Sandbox smoke entry (STOP-gate + runner falsification)
 * — a dedicated Worker entry that exercises the real sandbox path locally via
 * `wrangler dev`. Not the production worker entry: the production consumer
 * wiring lives in `src/worker/index.ts`. The `SandboxV1` Durable Object
 * class is re-exported here (and only here) so the containers binding
 * resolves; the SDK import point stays `src/pipeline/sandbox.ts`.
 *
 * Routes:
 *   GET /healthz         → 200 {"ok":true,"version":"vX.Y.Z"} (readiness
 *                          probe for the orchestrator; same shape as the
 *                          worker face — generated src/version.ts)
 *   GET /smoke           → falsification: getSandbox → exec gh pr diff →
 *                          destroy. Path 2 falls back to a git clone + diff
 *                          (token injected via git env config, never in the
 *                          command string). Returns JSON evidence, no secrets.
 *   GET /smoke-review    → clone the configured smoke repository's fixed
 *                          `mstar-inspector-seed` branch, write the runner
 *                          --input JSON (reconFacts: PR fact
 *                          + checked-out head sha + numstat universe — the
 *                          same shape src/pipeline/consumer.ts writes:
 *                          an empty capabilityHosts base), exec
 *                          the in-image runner
 *                          (packages/runner/src/runner.ts) on its
 *                          current `--level quick --input <file>` CLI with
 *                          the ark credential payload on its stdin pipe, parse the
 *                          stdout with parseReviewOutput, then destroy. The
 *                          model key is never baked into the image and never
 *                          echoed in the response (only a pass/fail + review
 *                          shape).
 */

import { runnerCommand, writeJsonCommand } from "./gitops";
import { getSandbox, Sandbox, SandboxV1, shellCommand, type ReviewSandbox, type SandboxBinding } from "./sandbox";
import { DEFAULT_SANDBOX_IMAGE_ID, getSandboxImage } from "../contracts/sandbox-images";
import { APP_VERSION } from "../version";
import { parseReviewOutput } from "../review/schema";
import { encodeCredentialPayload } from "../../packages/shared/src/credential-payload";

export { Sandbox, SandboxV1 };

type SmokeEnv = {
  SANDBOX: SandboxBinding;
  /** safety: Installation token minted by the orchestrator (scripts/sandbox-smoke.ts). */
  GH_TOKEN: string;
  ARK_API_KEY?: string;
  GH_REPO: string;
};

/**
 * Fixed smoke PR: the seed branch carries exactly this one diffable PR, so a
 * configured repository must ship `mstar-inspector-seed` + PR #1 (docs/deploy.md
 * § Sandbox smoke).
 */
const GH_PR = "1";
const SEED_BRANCH = "mstar-inspector-seed";

const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;

function smokeRepo(env: SmokeEnv): string | null {
  const repo = env.GH_REPO ?? "";
  const [owner, name, ...rest] = repo.split("/");
  if (rest.length > 0 || !owner || !name || !GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(name)) {
    return null;
  }
  return repo;
}

const CLONE_DIR = "/workspace/repo";
const INPUT_PATH = "/workspace/review-input.json";
/** why: In-image runner path (Dockerfile: WORKDIR /opt/runner, COPY packages/runner/src). */
const RUNNER_PATH = "/opt/runner/packages/runner/src/runner.ts";
const HARNESS_ROOT = "/opt/mstar-harness";
const OMP_AGENT_DIR = "/opt/omp-agent";

export default {
  async fetch(request: Request, env: SmokeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, version: `v${APP_VERSION}` });
    }
    if (url.pathname !== "/smoke" && url.pathname !== "/smoke-review") {
      return new Response("not found", { status: 404 });
    }

    const repo = smokeRepo(env);
    if (!repo) {
      return Response.json(
        { ok: false, error: "GH_REPO must be owner/repo (passed via --var by scripts/sandbox-smoke.ts)" },
        { status: 400 },
      );
    }
    if (url.pathname === "/smoke-review") {
      return runReviewSmoke(env, repo);
    }

    const sandbox = await getSandbox(env.SANDBOX, `smoke-${crypto.randomUUID()}`);
    const startedAt = Date.now();
    let result: Record<string, unknown>;
    try {
      const gh = await sandbox.runCommand(shellCommand(`gh pr diff ${GH_PR} --repo ${repo}`), {
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
        const git = await sandbox.runCommand(
          shellCommand(
            [
              `git clone --depth 1 --branch ${SEED_BRANCH} https://github.com/${repo}.git ${CLONE_DIR}`,
              `cd ${CLONE_DIR}`,
              "git fetch --depth 1 origin main",
              "git diff FETCH_HEAD HEAD",
            ].join(" && "),
          ),
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

async function runReviewSmoke(env: SmokeEnv, repo: string): Promise<Response> {
  const sandbox = await getSandbox(env.SANDBOX, `smoke-review-${crypto.randomUUID()}`);
  const startedAt = Date.now();
  let result: Record<string, unknown>;
  try {
    if (!env.ARK_API_KEY) {
      throw new Error("the ARK_API_KEY var is required for /smoke-review");
    }

    const clone = await sandbox.runCommand(
      shellCommand(
        [
          `rm -rf ${CLONE_DIR}`,
          `git clone --depth 1 --branch ${SEED_BRANCH} https://github.com/${repo}.git ${CLONE_DIR}`,
          `cd ${CLONE_DIR}`,
          "git fetch --depth 1 origin main",
        ].join(" && "),
      ),
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
      result = await execInImageReview(sandbox, env.ARK_API_KEY, startedAt, repo);
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

async function execInImageReview(
  sandbox: ReviewSandbox,
  arkKey: string,
  startedAt: number,
  repo: string,
): Promise<Record<string, unknown>> {
  const sandboxImage = getSandboxImage(DEFAULT_SANDBOX_IMAGE_ID);
  if (!sandboxImage) {
    throw new Error(`sandbox image ${DEFAULT_SANDBOX_IMAGE_ID} is missing from the registry`);
  }
  const recon = await sandbox.runCommand(
    shellCommand(`cd ${CLONE_DIR} && git rev-parse HEAD && git diff --numstat FETCH_HEAD HEAD`),
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
      reconFacts: [`${repo}#${GH_PR}`, `head ${headSha}`, ...numstat],
      capabilityHosts: [],
    }),
    "utf8",
  ).toString("base64");
  const writeInput = await sandbox.runCommand(writeJsonCommand(INPUT_PATH), { stdin: inputB64 });
  if (writeInput.exitCode !== 0) {
    return {
      ok: false,
      step: "input-write",
      exitCode: writeInput.exitCode,
      latencyMs: Date.now() - startedAt,
    };
  }

  const run = await sandbox.runCommand(runnerCommand(RUNNER_PATH, "quick", INPUT_PATH), {
    cwd: CLONE_DIR,
    env: {
      HARNESS_PLUGIN_ROOT: HARNESS_ROOT,
      PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
    },
    stdin: encodeCredentialPayload({ ark: [arkKey] }),
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
    summaryBytes: parsed.ok ? (parsed.output.summary_md?.length ?? 0) : undefined,
    latencyMs: Date.now() - startedAt,
  };
}
