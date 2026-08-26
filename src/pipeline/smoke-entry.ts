/**
 * T1 sandbox smoke entry (plan 06 Task 1, STOP gate) — a dedicated Worker
 * entry that exercises the real sandbox path locally via `wrangler dev`:
 *   getSandbox → exec `gh pr diff` (GH_TOKEN env injection) → destroy.
 *
 * This is NOT the production worker entry: it exists only to falsify the
 * Sandbox ASSUMPTIONS (SDK API shape, binding config, gh auth, exec latency,
 * destroy). The production consumer wiring lands in `src/worker/index.ts`
 * at T3. The `Sandbox` Durable Object class is re-exported here (and only
 * here) so the containers binding resolves; the SDK import point stays
 * `src/pipeline/sandbox.ts` (compass contracts A).
 *
 * Routes:
 *   GET /healthz → 200 {"ok":true} (readiness probe for the orchestrator)
 *   GET /smoke   → runs the falsification sequence and returns JSON evidence
 *                  (no secrets in the response)
 */

import { getSandbox, Sandbox, type SandboxBinding } from "./sandbox";

export { Sandbox };

type SmokeEnv = {
  SANDBOX: SandboxBinding;
  /** Installation token minted by the orchestrator (scripts/sandbox-smoke.ts). */
  GH_TOKEN: string;
};

const GH_REPO = "btspoony/todo-bots";
const GH_PR = "1";
const CLONE_DIR = "/workspace/repo";

export default {
  async fetch(request: Request, env: SmokeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
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
              GIT_CONFIG_VALUE_0: `Authorization: Bearer ${env.GH_TOKEN}`,
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
