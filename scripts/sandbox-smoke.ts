/**
 * T1 sandbox smoke orchestrator (plan 06 Task 1, STOP gate).
 *
 * Drives the real falsification sequence locally:
 *   1. Mint an installation token (JWT → POST /app/installations/{id}/access_tokens
 *      via @octokit/auth-app — the same auth surface the Worker uses).
 *   2. Start `wrangler dev` with the smoke entry (src/pipeline/smoke-entry.ts)
 *      and the sandbox containers binding (wrangler.smoke.jsonc).
 *   3. GET /smoke → the entry runs getSandbox → exec gh pr diff → destroy.
 *   4. Print the JSON evidence (no secrets) and exit with the verdict.
 *
 * Usage: bun run scripts/sandbox-smoke.ts
 * Env:  APP_ID, PRIVATE_KEY (inline PEM or path — same forms as the Worker),
 *       INSTALLATION_ID (default 156621513), GH_REPO (default btspoony/todo-bots),
 *       GH_PR (default 1).
 *
 * The token is held only in this process's memory and passed to the Worker
 * via the `--var GH_TOKEN=...` dev flag (wrangler dev local only — never
 * committed, never logged, never in the image).
 */

import { createAppAuth } from "@octokit/auth-app";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_ID = Bun.env.APP_ID;
const PRIVATE_KEY = Bun.env.PRIVATE_KEY;
if (!APP_ID || !PRIVATE_KEY) {
  console.error("sandbox-smoke: APP_ID and PRIVATE_KEY env vars are required");
  process.exit(2);
}

const INSTALLATION_ID = Number(Bun.env.INSTALLATION_ID ?? "156621513");
const GH_REPO = Bun.env.GH_REPO ?? "btspoony/todo-bots";
const GH_PR = Bun.env.GH_PR ?? "1";

/** Resolve PRIVATE_KEY the same way the Worker does (inline PEM or path). */
function resolvePrivateKey(value: string): string {
  if (value.includes("-----BEGIN")) return value;
  const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return readFileSync(path, "utf8");
}

/** Mint an installation token via the GitHub App auth flow. */
async function mintInstallationToken(): Promise<string> {
  const auth = createAppAuth({ appId: APP_ID, privateKey: resolvePrivateKey(PRIVATE_KEY) });
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
    "--var",
    `GH_TOKEN:${token}`,
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
  const res = await fetch(`http://127.0.0.1:${port}/smoke`);
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
