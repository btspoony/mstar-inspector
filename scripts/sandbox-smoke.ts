/**
 * Sandbox smoke orchestrator (plan 06 Task 1 STOP gate + Task 2 runner smoke).
 *
 * Drives the real falsification sequences locally:
 *   1. Mint an installation token (JWT → POST /app/installations/{id}/access_tokens
 *      via @octokit/auth-app — the same auth surface the Worker uses).
 *   2. Start `wrangler dev` with the smoke entry (src/pipeline/smoke-entry.ts)
 *      and the sandbox containers binding (wrangler.smoke.jsonc).
 *   3. GET the selected route:
 *        /smoke         → T1: getSandbox → exec gh pr diff → destroy.
 *        /smoke-review  → T2: real PR clone → in-image review runner with
 *                         ARK_API_KEY (exec env only) → parseReviewOutput →
 *                         destroy.
 *   4. Print the JSON evidence (no secrets) and exit with the verdict.
 *
 * Usage: bun run scripts/sandbox-smoke.ts
 * Env:  SMOKE_APP_ID, SMOKE_PRIVATE_KEY (inline PEM or path),
 *       INSTALLATION_ID, GH_REPO (owner/repo), GH_PR (PR number),
 *       SMOKE_ROUTE (default /smoke), ARK_API_KEY (required
 *       when SMOKE_ROUTE=/smoke-review).
 *
 * The token and model key are held only in this process's memory and passed to
 * the Worker via `--var` (wrangler dev local only — never committed, never
 * logged, never in the image).
 */

import { createAppAuth } from "@octokit/auth-app";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SMOKE_APP_ID = Bun.env.SMOKE_APP_ID;
const SMOKE_PRIVATE_KEY = Bun.env.SMOKE_PRIVATE_KEY;
if (!SMOKE_APP_ID || !SMOKE_PRIVATE_KEY) {
  console.error("sandbox-smoke: SMOKE_APP_ID and SMOKE_PRIVATE_KEY env vars are required");
  process.exit(2);
}

const INSTALLATION_ID = Number(Bun.env.INSTALLATION_ID);
const GH_REPO = Bun.env.GH_REPO;
const GH_PR = Bun.env.GH_PR;
const SMOKE_ROUTE = Bun.env.SMOKE_ROUTE ?? "/smoke";
const ARK_API_KEY = Bun.env.ARK_API_KEY;

if (!INSTALLATION_ID || !GH_REPO || !GH_PR) {
  console.error("sandbox-smoke: INSTALLATION_ID, GH_REPO, and GH_PR env vars are required");
  process.exit(2);
}
if (SMOKE_ROUTE === "/smoke-review" && !ARK_API_KEY) {
  console.error("sandbox-smoke: ARK_API_KEY env var is required for SMOKE_ROUTE=/smoke-review");
  process.exit(2);
}

/** Resolve SMOKE_PRIVATE_KEY (inline PEM or path). */
function resolvePrivateKey(value: string): string {
  if (value.includes("-----BEGIN")) return value;
  const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return readFileSync(path, "utf8");
}

/** Mint an installation token via the GitHub App auth flow. */
async function mintInstallationToken(): Promise<string> {
  const auth = createAppAuth({ appId: SMOKE_APP_ID, privateKey: resolvePrivateKey(SMOKE_PRIVATE_KEY) });
  const { token } = await auth({ type: "installation", installationId: INSTALLATION_ID });
  return token;
}

/** Wait for the dev server to accept connections on the given port. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;
  }
  throw new Error(`wrangler dev did not become ready on port ${port} within ${timeoutMs}ms`);
}

const token = await mintInstallationToken();
console.log("TOKEN_MINTED=yes");

const port = 8791;
const varFlags = [`GH_TOKEN:${token}`, `GH_REPO:${GH_REPO}`, `GH_PR:${GH_PR}`];
if (ARK_API_KEY) {
  varFlags.push(`ARK_API_KEY:${ARK_API_KEY}`);
}

const child = spawn(
  "bunx",
  [
    "wrangler",
    "dev",
    "src/pipeline/smoke-entry.ts",
    "--config",
    "wrangler.smoke.jsonc",
    "--port",
    String(port),
    ...varFlags.flatMap((v) => ["--var", v]),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += String(d);
});

let exitCode = 1;
try {
  await waitForPort(port, 180_000);
  const res = await fetch(`http://127.0.0.1:${port}${SMOKE_ROUTE}`);
  const body = await res.text();
  console.log(`HTTP_STATUS=${res.status}`);
  console.log(body);
  exitCode = res.ok ? 0 : 1;
} catch (error) {
  console.error("SMOKE_FAILED:", error instanceof Error ? error.message : String(error));
  console.error("--- wrangler dev stderr (tail) ---");
  console.error(stderrBuf.slice(-2000));
  exitCode = 1;
} finally {
  child.kill("SIGTERM");
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 1000);
  await promise;
  child.kill("SIGKILL");
}

process.exit(exitCode);
