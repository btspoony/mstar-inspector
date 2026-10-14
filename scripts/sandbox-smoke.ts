/**
 * Sandbox smoke orchestrator (STOP gate + runner smoke).
 *
 * Drives the real falsification sequences locally:
 *   1. Mint a PURPOSE-SCOPED sandbox-read installation grant (§7.6)
 *      through the same helper the Worker uses (createReviewCommenter →
 *      getInstallationToken) and verify the RETURNED capabilities with
 *      assertSandboxGrant — read-only, repository-scoped, no write
 *      capabilities; the smoke fails closed on any broader grant.
 *   2. Start `wrangler dev` with the smoke entry (src/pipeline/smoke-entry.ts)
 *      and the sandbox containers binding (wrangler.smoke.jsonc).
 *   3. GET the selected route:
 *        /smoke         → T1: getSandbox → exec gh pr diff → destroy.
 *        /smoke-review  → T2: seed-branch clone → in-image review runner with
 *                         the ark key on its STDIN credential payload (one
 *                         key → one pool) → parseReviewOutput →
 *                         destroy.
 *   4. Print the JSON evidence (no secrets) and exit with the verdict.
 *
 * Usage: bun run scripts/sandbox-smoke.ts
 * Env:  SMOKE_APP_ID, SMOKE_PRIVATE_KEY (inline PEM or path),
 *       INSTALLATION_ID (required — the App installation to mint a token for),
 *       GH_REPO (required — the owner/repo whose PR is diffed; it must carry
 *       the `mstar-inspector-seed` branch and a diffable PR #1),
 *       SMOKE_ROUTE (default /smoke), ARK_API_KEY (the operator's local key;
 *       required when SMOKE_ROUTE=/smoke-review, forwarded to the smoke Worker
 *       as its own var and streamed to the runner on stdin).
 *
 * The token and model key are held only in this process's memory and passed to
 * the Worker via `--var` (wrangler dev local only — never committed, never
 * logged, never in the image).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertSandboxGrant, createReviewCommenter } from "../src/pipeline/comment";

const SMOKE_APP_ID = Bun.env.SMOKE_APP_ID;
const SMOKE_PRIVATE_KEY = Bun.env.SMOKE_PRIVATE_KEY;
if (!SMOKE_APP_ID || !SMOKE_PRIVATE_KEY) {
  console.error("sandbox-smoke: SMOKE_APP_ID and SMOKE_PRIVATE_KEY env vars are required");
  process.exit(2);
}

// No personal defaults: the installation id and the target repository are the
// caller's own fixture, so both must be supplied explicitly.
const INSTALLATION_ID = Number(Bun.env.INSTALLATION_ID ?? "");
const GH_REPO = Bun.env.GH_REPO ?? "";
if (GH_REPO.split("/").length !== 2 || GH_REPO.split("/").some((part) => part.length === 0)) {
  console.error(`sandbox-smoke: GH_REPO env var is required and must be owner/repo, got ${JSON.stringify(GH_REPO)}`);
  process.exit(2);
}
if (!Number.isInteger(INSTALLATION_ID) || INSTALLATION_ID <= 0) {
  console.error("sandbox-smoke: INSTALLATION_ID env var is required and must be a positive integer");
  process.exit(2);
}
// The smoke entry pins the target PR at #1 (its seed branch carries exactly
// that diffable PR); mirror the same constant when scoping the grant.
const GH_PR = "1";
const SMOKE_ROUTE = Bun.env.SMOKE_ROUTE ?? "/smoke";
const ARK_API_KEY = Bun.env.ARK_API_KEY;

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

/**
 * Mint the sandbox-read grant via the SAME purpose-scoped helper the Worker
 * uses (§7.6: the smoke path is migrated off the raw createAppAuth
 * mint), then assert the RETURNED capabilities — repository-scoped,
 * read-only, exactly the requested repository. `appId` is the smoke's local
 * numeric App-id stand-in (the mint itself binds installationId + repo).
 */
async function mintInstallationToken(): Promise<string> {
  const commenter = createReviewCommenter({ APP_ID: SMOKE_APP_ID, PRIVATE_KEY: resolvePrivateKey(SMOKE_PRIVATE_KEY) });
  // GH_REPO was validated as owner/repo at startup — `repo` is always present.
  const [owner, repo] = GH_REPO.split("/") as [string, string];
  const grant = await commenter.getInstallationToken({
    scope: { appId: SMOKE_APP_ID, installationId: INSTALLATION_ID, owner, repo, prNumber: Number(GH_PR) },
    purpose: "sandbox-read",
  });
  assertSandboxGrant(grant, repo);
  return grant.token;
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
const varFlags = [`GH_TOKEN:${token}`, `GH_REPO:${GH_REPO}`];
if (ARK_API_KEY) {
  // The smoke transports the operator's single key through the SAME stdin
  // credential payload contract the production consumer builds (one key → the
  // ark pool); it reaches the Worker as its own var and is never placed in the
  // container's process environment.
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
