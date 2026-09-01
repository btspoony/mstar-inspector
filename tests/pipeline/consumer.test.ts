/**
 * Consumer tests (plan 06 Task 3 + Phase 5 Wave A) — full-mock flow. The
 * sandbox adapter and the commenter are injected via createReviewConsumer's
 * overrides (DI — no process-wide mock.module on relative module paths, which
 * leaks across test files sharing a worker on CI, run 32946710695); the review
 * store is the REAL store over the bun:sqlite D1 double
 * (tests/store/helpers.ts) so the consumer's store wiring is exercised for
 * real. gitops command construction and parseReviewOutput stay real.
 *
 * Wave A (bugbot) changes:
 *   - clone uses the LIVE PR head (`pull/<n>/head`), git transport auth via
 *     scoped extraheader env (GIT_CONFIG_*), GH_TOKEN only for gh steps
 *   - the AUTHORITATIVE sha comes from `git rev-parse HEAD` AFTER the clone;
 *     idem key / D1 row / commit_id / KV all key off it (payload.head_sha is
 *     no longer used for dedup — a force-push mid-flight is self-consistent)
 *   - dedup runs AFTER clone against the checked-out sha
 *
 * Acceptance points (plan Task 3 / brief; plan 07 Task 5 rewire):
 *   - findByIdempotencyKey hit after clone → ack (no post, no insert)
 *   - full flow: clone → rev-parse → diff → numstat → write runner input
 *     (reconFacts) → runner `--level/--input` (env-injected secrets) →
 *     parse the mstar.review/v1 envelope → post FIRST → put → KV
 *     completion → destroy
 *   - REVIEW_LEVEL configurable (quick/default/deep); invalid value fails loud
 *     BEFORE any sandbox step (never a silent downgrade)
 *   - null payload sha → sha resolved from the checkout (no gh pr view)
 *   - parse failure (plan 18 T2 / AL-1) → failure row (stage=parse) +
 *     degraded comment + ack — no post, no reviews row, no KV done, zero DLQ
 *   - infra failure (AL-6) → best-effort failure row with the phase stage
 *     (runner | sandbox | pipeline) + unchanged rethrow → retry/DLQ
 *   - comment failure → failure row (stage=pipeline) + rethrow, destroy
 *   - finally destroy on every path
 *   - line comments (plan 18 T3 / AL-3): upsert → diff prefetch →
 *     createReview ordering; hunk prefilter; prefetch failure → base-filter
 *     attempt; residual 422/any error → line_comments_fallback log +
 *     continue (never throws after the overall comment landed); zero
 *     qualifying findings → zero API calls
 */

import { describe, expect, mock, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ReviewOutput } from "../../src/review/schema";
import { FINDING_BODY_MAX, FINDING_TITLE_MAX } from "../../src/review/schema";
import { createArtifactStore } from "../../src/store/artifact-store";
import { computeFindingFingerprint } from "../../src/store/fingerprint";
import { idemKey } from "../../src/contracts/idem";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { REDACTED } from "../../src/pipeline/redact";
import type { ReviewCommenter } from "../../src/pipeline/comment";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";

const VALID_OUTPUT: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "Two issues found in the diff.",
  findings: [
    {
      mergeClass: "should-fix",
      category: "logic",
      file_path: "src/auth.ts",
      line_start: 21,
      line_end: 21,
      title: "Fractional expiry comparison",
      body: "`claims.exp < Date.now() / 1000` compares against a fractional value.",
    },
  ],
};

const SHA = "0123456789abcdef0123456789abcdef01234567";

// --- default App row (plan 24 Task 1: every message is per-App) -------------
/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** Fixed App id every consumer-test payload is attributed to. */
const TEST_APP_ID = "11111111-2222-3333-4444-555555555555";
const TEST_APP_PEM = "-----BEGIN PRIVATE KEY-----\nFAKE-CONSUMER-TEST-PEM\n-----END PRIVATE KEY-----\n";
// Pre-computed secretbox envelopes for the default App row (top-level await —
// the file already awaits the consumer import below).
const TEST_APP_PRIVATE_KEY_ENC = await createSecretbox(TEST_KEY).encryptSecret(
  TEST_APP_PEM,
  `github_apps.private_key_enc:${TEST_APP_ID}`,
);
const TEST_APP_WEBHOOK_SECRET_ENC = await createSecretbox(TEST_KEY).encryptSecret(
  "whsec-consumer-test",
  `github_apps.webhook_secret_enc:${TEST_APP_ID}`,
);

/**
 * Fully-migrated D1 with the default App row seeded — the consumer's
 * per-App credential resolution needs a real active row on every message
 * (plan 24 Task 1: appRef is required, the env-App branch is retired).
 * AL-24-5 (plan 24 Task 6): the App is also given its AI-config health
 * baseline — a model chain (`ark-plan/deepseek-v4-flash`, the in-image
 * base provider) + the `ark` BYOK key (ARK_API_KEY) whose env the chain's
 * provider reads — so a zero-extra-env message passes the fail-closed gate
 * and every success-path test sees ARK_API_KEY + OMP_REVIEW_MODEL from the
 * App config (no Worker-env OMP_MODEL_KEY / OMP_REVIEW_MODEL exists).
 */
async function createSeededTestD1(): Promise<TestD1> {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 'consumer-test-app', 424242, 'consumer-test-app', ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(TEST_APP_ID, TEST_APP_PRIVATE_KEY_ENC, TEST_APP_WEBHOOK_SECRET_ENC);
  // The default App's per-App AI config (AL-24-5 health baseline). AWAITED
  // so the seed completes before any caller re-seeds the same app_id with a
  // different chain (Rev24T6 Important-2: the fire-and-forget seed raced
  // later awaited re-seeds — last-writer-wins could flake success paths).
  await seedAppConfig(db, TEST_APP_ID);
  return db;
}

/**
 * Seed one App's per-App AI config through the REAL store (composite-PK AAD
 * path): model chain + provider keys. Default = the ark-plan base chain with
 * the `ark` BYOK key; `extraKeys` adds per-App keys for chains that need
 * more providers.
 */
async function seedAppConfig(
  db: TestD1,
  appId: string,
  modelChain = "ark-plan/deepseek-v4-flash",
  extraKeys: Record<string, string> = {},
): Promise<void> {
  const store = createAppConfigStore(db, TEST_KEY);
  await store.setModelChain(appId, modelChain);
  await store.setProviderKey(appId, "ark", "ark-key");
  for (const [provider, key] of Object.entries(extraKeys)) {
    await store.setProviderKey(appId, provider, key);
  }
}

// --- sandbox fake (injected via createReviewConsumer overrides) -------------
const sandboxCalls: Array<{ cmd: string; opts?: unknown }> = [];
let runnerStdout = "";
let resolvedSha = SHA;
let revParseExitCode = 0;
let sandboxError: Error | undefined;
let destroyCalls = 0;
let destroyError: Error | undefined;

// Plan 07 Task 5: the runtime runner contract — exit 0 ⇒ stdout is the
// engine-validated envelope; stderr is diagnostics-only (no mode marker).
let runnerStderr = "";
let runnerExitCode = 0;
let cloneExitCode = 0;
let diffExitCode = 0;
let numstatStdout = "10\t2\tsrc/auth.ts\n5\t0\tdocs/readme.md\n";
let numstatExitCode = 0;
let writeInputExitCode = 0;
/** Decoded runner --input JSON written via the base64 write step. */
let writtenInputJson: string | undefined;

const fakeSandbox = {
  exec: mock(async (cmd: string, opts?: unknown) => {
    sandboxCalls.push({ cmd, opts });
    if (sandboxError) throw sandboxError;
    if (cmd.includes("rev-parse")) {
      return { stdout: `${resolvedSha}\n`, stderr: "", exitCode: revParseExitCode };
    }
    if (cmd.includes("git init")) return { stdout: "", stderr: "", exitCode: cloneExitCode };
    if (cmd.includes("gh pr diff")) return { stdout: "", stderr: "", exitCode: diffExitCode };
    if (cmd.includes("git apply --numstat")) {
      return { stdout: numstatStdout, stderr: "", exitCode: numstatExitCode };
    }
    if (cmd.includes("base64 -d")) {
      const match = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(cmd);
      writtenInputJson = match ? Buffer.from(match[1]!, "base64").toString("utf8") : undefined;
      return { stdout: "", stderr: "", exitCode: writeInputExitCode };
    }
    if (cmd.includes("--input")) {
      return { stdout: runnerStdout, stderr: runnerStderr, exitCode: runnerExitCode };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }),
  destroy: mock(async () => {
    destroyCalls += 1;
    if (destroyError) throw destroyError;
  }),
};

// Load-shim only: consumer.ts statically imports ./sandbox → @cloudflare/sandbox,
// whose real dist references the workerd builtin `cloudflare:workers`
// (unresolvable in Bun's test runner). The consumer never calls this
// getSandbox — every test injects the fake via createReviewConsumer overrides.
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: mock(async () => {
    throw new Error("unexpected: consumer tests inject getSandbox via overrides");
  }),
  Sandbox: class Sandbox {},
}));

// --- commenter fake (injected via createReviewConsumer overrides) -----------
const commenterCalls: Array<{ op: string; args: unknown[] }> = [];
let tokenResult = "ghs_installation_token";
let tokenError: Error | undefined;
let commentError: Error | undefined;
let degradeError: Error | undefined;
let deleteDegradedError: Error | undefined;
let deleteDegradedOutcome: { deleted: number; skipped: number; errors: string[] } = { deleted: 0, skipped: 0, errors: [] };
// Plan 18 T3 line comments: the round postReview returns (pinned into the
// line-comments marker body), the prefetched diff, and per-method errors.
let postRound = 1;
let diffError: Error | undefined;
let lineCommentsError: Error | undefined;
/** Default prefetched diff: a src/auth.ts hunk whose right range covers line 21. */
const VALID_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -18,4 +18,6 @@ export function verify() {",
  " const header = req.headers;",
  " const claims = decode(token);",
  "-if (claims.exp < Date.now() / 1000) throw 401;",
  "+if (!Number.isInteger(claims.exp)) throw 401;",
  "+if (claims.exp < Math.floor(Date.now() / 1000)) throw 401;",
  "+audit(claims.sub);",
  " return claims;",
  "",
].join("\n");
let diffResult: string = VALID_DIFF;

const fakeCommenter: ReviewCommenter = {
  getInstallationToken: mock(async (installationId: number) => {
    commenterCalls.push({ op: "token", args: [installationId] });
    if (tokenError) throw tokenError;
    return tokenResult;
  }),
  postReview: mock(async (input: unknown) => {
    commenterCalls.push({ op: "post", args: [input] });
    if (commentError) throw commentError;
    return postRound;
  }),
  postDegraded: mock(async (input: unknown) => {
    commenterCalls.push({ op: "degrade", args: [input] });
    if (degradeError) throw degradeError;
  }),
  deleteDegradedComment: mock(async (input: unknown) => {
    commenterCalls.push({ op: "delete-degraded", args: [input] });
    if (deleteDegradedError) throw deleteDegradedError;
    return deleteDegradedOutcome;
  }),
  fetchPrDiff: mock(async (input: unknown) => {
    commenterCalls.push({ op: "fetch-diff", args: [input] });
    if (diffError) throw diffError;
    return diffResult;
  }),
  postLineComments: mock(async (input: unknown) => {
    commenterCalls.push({ op: "line-comments", args: [input] });
    if (lineCommentsError) throw lineCommentsError;
  }),
};

// Injected into every consumer under test (DI replaces the old mock.module).
const testOverrides = {
  createAppCommenter: () => fakeCommenter,
  getSandbox: async () => fakeSandbox,
};

/** Runner exec call's env (the sandbox fake stores opts as unknown). */
function runnerExecEnv(): Record<string, string> {
  const call = sandboxCalls.find((c) => c.cmd.includes("bun run"))!;
  return (call.opts as { env?: Record<string, string> }).env ?? {};
}
/** Runner exec call's timeout (the sandbox fake stores opts as unknown). */
function runnerExecTimeout(): number | undefined {
  const call = sandboxCalls.find((c) => c.cmd.includes("bun run"))!;
  return (call.opts as { timeout?: number }).timeout;
}

// --- consumer under test (dynamic import: mocks must be registered first) ---
const {
  createReviewConsumer,
  runnerTimeoutMs,
  reviewGuardTtlSeconds,
  guardRetryDelaysSeconds,
  DIFF_PREFETCH_MAX_BYTES,
} = await import("../../src/pipeline/consumer");
import type { PipelineEnv } from "../../src/pipeline/consumer";
import type { ConsumerLog, ConsumerLogFields } from "../../src/pipeline/consumer";

// --- test log sink (injected via the consumer's optional log param) --------
const logLines: Array<{
  level: "info" | "warn" | "error";
  fields: ConsumerLogFields;
  msg: string;
}> = [];
const testLog: ConsumerLog = {
  info: (fields, msg) => logLines.push({ level: "info", fields, msg: msg ?? "" }),
  warn: (fields, msg) => logLines.push({ level: "warn", fields, msg: msg ?? "" }),
  error: (fields, msg) => logLines.push({ level: "error", fields, msg: msg ?? "" }),
};
// --- helpers ----------------------------------------------------------------
const kvPuts: Array<{ key: string; value: string; options?: unknown }> = [];
const kvGuardPuts: Array<{ key: string; value: string; options?: unknown }> = [];
const kvGuardDeletes: string[] = [];
const messageRetryCalls: Array<{ attempts: number; delaySeconds?: number }> = [];
const messageAckCalls: Array<{ attempts: number }> = [];
let messageAttempts = 1;
let kvPutError: Error | undefined;
let kvGetValue: string | null = null;
let kvGuardValue: string | null = null;
const kv = {
  // The in-flight guard (WF-002) uses the `inflight:` key family on the SAME
  // KV binding — route by prefix so the idem-done assertions on kvPuts stay
  // unambiguous.
  get: mock(async (key: string) => {
    if (key.startsWith("inflight:")) return kvGuardValue;
    return kvGetValue;
  }),
  put: mock(async (key: string, value: string, options?: unknown) => {
    if (key.startsWith("inflight:")) {
      kvGuardPuts.push({ key, value, options });
    } else {
      kvPuts.push({ key, value, options });
    }
    if (kvPutError) throw kvPutError;
  }),
  delete: mock(async (key: string) => {
    kvGuardDeletes.push(key);
  }),
};

async function makeEnv(overrides: Partial<PipelineEnv> = {}): Promise<PipelineEnv> {
  return {
    DB: await createSeededTestD1() as never,
    IDEMPOTENCY_KV: kv as never,
    SANDBOX: {} as never,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    ...overrides,
  };
}

function makePayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: 123,
    owner: "acme",
    repo: "widgets",
    pr_number: 42,
    head_sha: SHA,
    action: "opened",
    triggered_by: "pull_request",
    // Guard note (plan 24 Task 1 Step 4): a payload WITHOUT appRef is
    // impossible at the type level (required field). At runtime the
    // classifier never attaches App identity — the per-App route is the
    // only producer that adds appRef, so every enqueued job carries it.
    // No runtime guard is added (AL-24-4: no defensive checks).
    appRef: { appId: TEST_APP_ID },
    ...overrides,
  };
}

function makeBatch(payload: ReviewJobPayload): MessageBatch<ReviewJobPayload> {
  return {
    queue: "review-queue",
    messages: [
      {
        id: "m1",
        timestamp: new Date(),
        attempts: messageAttempts,
        body: payload,
        retry: (options?: { delaySeconds?: number }) => {
          messageRetryCalls.push({ attempts: messageAttempts, delaySeconds: options?.delaySeconds });
        },
        ack: () => {
          messageAckCalls.push({ attempts: messageAttempts });
        },
      },
    ],
  } as unknown as MessageBatch<ReviewJobPayload>;
}

function reset(): void {
  sandboxCalls.length = 0;
  commenterCalls.length = 0;
  kvPuts.length = 0;
  kvGuardPuts.length = 0;
  kvGuardDeletes.length = 0;
  messageRetryCalls.length = 0;
  messageAckCalls.length = 0;
  messageAttempts = 1;
  logLines.length = 0;
  runnerStdout = "";
  runnerStderr = "";
  runnerExitCode = 0;
  cloneExitCode = 0;
  diffExitCode = 0;
  numstatStdout = "10\t2\tsrc/auth.ts\n5\t0\tdocs/readme.md\n";
  numstatExitCode = 0;
  writeInputExitCode = 0;
  writtenInputJson = undefined;
  resolvedSha = SHA;
  revParseExitCode = 0;
  sandboxError = undefined;
  destroyCalls = 0;
  destroyError = undefined;
  tokenResult = "ghs_installation_token";
  tokenError = undefined;
  commentError = undefined;
  degradeError = undefined;
  deleteDegradedError = undefined;
  deleteDegradedOutcome = { deleted: 0, skipped: 0, errors: [] };
  postRound = 1;
  diffError = undefined;
  lineCommentsError = undefined;
  diffResult = VALID_DIFF;
  kvPutError = undefined;
  kvGetValue = null;
  kvGuardValue = null;
}

/** Count review rows in the real D1 double. */
function reviewCount(db: ReturnType<typeof createMigratedTestD1>): number {
  const row = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
  return row.n;
}

/** All rows of the review_failures table in the real D1 double. */
function failureRows(db: ReturnType<typeof createMigratedTestD1>): Array<Record<string, unknown>> {
  return db.raw.query("SELECT * FROM review_failures ORDER BY rowid").all() as Array<Record<string, unknown>>;
}

describe("createReviewConsumer", () => {
  test("findByIdempotencyKey hit after clone → ack: no post, no insert, destroy", async () => {
    reset();
    const db = await createSeededTestD1();
    const store = createArtifactStore(db);
    await store.put({
      kind: "review",
      key: idemKey({ installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: SHA }),
      schema: "mstar.review/v1",
      payload: VALID_OUTPUT,
      appId: TEST_APP_ID,
    });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The authoritative sha comes from the checkout, so the dedup runs after
    // clone + rev-parse; the D1 hit acks before any post/insert.
    expect(sandboxCalls.map((c) => c.cmd)).toEqual([
      expect.stringContaining("git init '/workspace/repo'"),
      expect.stringContaining("git -C '/workspace/repo' rev-parse HEAD"),
    ]);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(kvPuts).toHaveLength(0);
    expect(destroyCalls).toBe(1);
    expect(reviewCount(db)).toBe(1); // untouched
  });

  test("full flow: clone → rev-parse → diff → numstat → input → runner → parse → post → insert → KV done → destroy", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(sandboxCalls.map((c) => c.cmd)).toEqual([
      expect.stringContaining("git init '/workspace/repo'"),
      expect.stringContaining("git -C '/workspace/repo' rev-parse HEAD"),
      expect.stringContaining("gh pr diff '42' --repo 'acme/widgets'"),
      expect.stringContaining("git apply --numstat '/workspace/pr.diff'"),
      expect.stringContaining("base64 -d > '/workspace/review-input.json'"),
      expect.stringContaining(
        "bun run '/opt/runner/src/review/runner.ts' --level 'default' --input '/workspace/review-input.json'",
      ),
    ]);
    // The runner input JSON carries the reconFacts the runtime folds into
    // the envelope target (owner/repo#pr + the AUTHORITATIVE checkout sha)
    // plus the numstat seat-partition universe.
    expect(JSON.parse(writtenInputJson!)).toEqual({
      worktreePath: "/workspace/repo",
      reconFacts: ["acme/widgets#42", `head ${SHA}`, "10\t2\tsrc/auth.ts", "5\t0\tdocs/readme.md"],
    });
    // Clone: git transport auth via scoped extraheader env (bugbot A1) — the
    // token lives in GIT_CONFIG_VALUE_0, never in the command string. Form is
    // basic auth with username `x-access-token` (GitHub app-token git auth);
    // a `Bearer` header would be rejected by GitHub even on public repos.
    expect(sandboxCalls[0]!.opts).toEqual({
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX2luc3RhbGxhdGlvbl90b2tlbg==",
      },
      timeout: 120_000,
    });
    // rev-parse: no credentials needed.
    expect(sandboxCalls[1]!.opts).toEqual({ timeout: 120_000 });
    // Diff: gh step, GH_TOKEN via exec env only.
    expect(sandboxCalls[2]!.opts).toEqual({ env: { GH_TOKEN: "ghs_installation_token" }, timeout: 120_000 });
    // Numstat + input write: plain git/shell steps, git timeout.
    expect(sandboxCalls[3]!.opts).toEqual({ timeout: 120_000 });
    expect(sandboxCalls[4]!.opts).toEqual({ timeout: 120_000 });
    // Runner: cwd = clone dir; model key + harness paths via exec env only.
    expect(sandboxCalls[5]!.opts).toEqual({
      cwd: "/workspace/repo",
      env: {
        ARK_API_KEY: "ark-key",
        HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
        PI_CODING_AGENT_DIR: "/opt/omp-agent",
        OMP_REVIEW_MODEL: "ark-plan/deepseek-v4-flash",
      },
      timeout: 600_000,
    });
    // inside VALID_DIFF's right hunk [18,23]). BUG-01: the KV done fence
    // and the degraded-comment delete (Bugbot) sit between the upsert and
    // the line-comments step.
    expect(commenterCalls.filter((c) => c.op === "token")).toHaveLength(1);
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff", "line-comments"]);
    expect(commenterCalls[1]!.args[0]).toMatchObject({
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: SHA,
      output: VALID_OUTPUT,
    });
    // The line-comments input: same coordinates, the round the upsert
    // returned, and the capped findings array (B4 — same array as post/put).
    expect(commenterCalls[4]!.args[0]).toMatchObject({
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: SHA,
      round: 1,
      findings: VALID_OUTPUT.findings,
    });

    // The review row + findings landed in the real D1 double.
    expect(reviewCount(db)).toBe(1);
    const row = db.raw.query("SELECT * FROM reviews").get() as {
      head_sha: string;
      verdict: string;
      app_id: string | null;
      model: string | null;
      provider: string | null;
    };
    expect(row.head_sha).toBe(SHA);
    expect(row.verdict).toBe("needs fixes");
    // The review row carries the App attribution (plan 24 Task 1: appRef is
    // required — every new row is attributed; app_id NULL survives only on
    // pre-plan-24 historical rows).
    expect(row.app_id).toBe(TEST_APP_ID);
    // Version records (plan 18 Task 1, AL-24-5): the seed App's own chain is
    // the only chain source — `model` records its head selector (never NULL
    // on a new row); `provider` is NULL on BOTH paths (architect AL-2).
    expect(row.model).toBe("ark-plan/deepseek-v4-flash");
    expect(row.provider).toBeNull();
    const findings = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(findings.n).toBe(1);
    // KV completion state written with the idem key + TTL.
    expect(kvPuts).toEqual([
      {
        key: `idem:123:acme/widgets:42:${SHA}`,
        value: "done",
        options: { expirationTtl: 86400 },
      },
    ]);
    expect(destroyCalls).toBe(1);
  });

  test("null payload sha → actual sha read from the checkout (no gh pr view)", async () => {
    reset();
    resolvedSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload({ head_sha: null, triggered_by: "review_command" })));

    // No gh pr view anywhere: the authoritative sha comes from the clone.
    expect(sandboxCalls.some((c) => c.cmd.includes("gh pr view"))).toBe(false);
    expect(sandboxCalls[0]!.cmd).toContain("git init '/workspace/repo'");
    expect(sandboxCalls[1]!.cmd).toContain("git -C '/workspace/repo' rev-parse HEAD");
    const row = db.raw.query("SELECT * FROM reviews").get() as { head_sha: string };
    expect(row.head_sha).toBe("abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(kvPuts).toEqual([
      {
        key: "idem:123:acme/widgets:42:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        value: "done",
        options: { expirationTtl: 86400 },
      },
    ]);
    expect(destroyCalls).toBe(1);
  });

  test("rev-parse sha differs from payload sha → D1 row, commit_id, KV all use the checkout sha", async () => {
    reset();
    const actualSha = "feedfacefeedfacefeedfacefeedfacefeedface";
    resolvedSha = actualSha;
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload())); // payload head_sha = SHA (stale)

    // The posted commit_id, the D1 row and the KV key all key off the
    // checkout sha — the diff/files/commit_id triple stays consistent even
    // when the webhook payload sha is stale (force-push mid-flight).
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    expect(commenterCalls[1]!.args[0]).toMatchObject({ headSha: actualSha });
    const row = db.raw.query("SELECT * FROM reviews").get() as { head_sha: string };
    expect(row.head_sha).toBe(actualSha);
    expect(kvPuts).toEqual([
      {
        key: `idem:123:acme/widgets:42:${actualSha}`,
        value: "done",
        options: { expirationTtl: 86400 },
      },
    ]);
    expect(destroyCalls).toBe(1);
  });

  test("parse failure → failure row (stage=parse) + degraded comment + ack, zero DLQ (plan 18 T2 / AL-1)", async () => {
    reset();
    runnerStdout = "not json at all";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — acked, never DLQed

    // No real-review side effects: no overall post, no reviews row, NO KV
    // done-state (a later webhook for the same sha legitimately re-runs).
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(kvPuts).toHaveLength(0);
    // Degraded comment posted with the parse error + the RAW stdout (the
    // commenter side is the redaction/truncation choke point).
    const degrades = commenterCalls.filter((c) => c.op === "degrade");
    expect(degrades).toHaveLength(1);
    const degradeInput = degrades[0]!.args[0] as { error: string; rawOutput: string };
    expect(degradeInput.error).toBe("not valid ReviewOutput JSON");
    expect(degradeInput.rawOutput).toBe("not json at all");
    // Failure row: stage=parse, keyed off the AUTHORITATIVE checkout sha.
    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      installation_id: 123,
      owner: "acme",
      repo: "widgets",
      pr_number: 42,
      head_sha: SHA,
      stage: "parse",
      error: "not valid ReviewOutput JSON",
    });
    // Queue redelivery stops via the ack — no throw, no retry call.
    expect(messageAckCalls).toHaveLength(1);
    expect(messageRetryCalls).toHaveLength(0);
    expect(destroyCalls).toBe(1);
  });

  test("parse error echoing a model-emitted token is REDACTED in the failure row and the warn log (qc3 F-001 / qc2 F-001)", async () => {
    reset();
    // The engine gate echoes the received verdict verbatim — a
    // prompt-injected token as the verdict lands in parsed.error, and the
    // durable review_failures row + operator warn log must carry only the
    // [REDACTED] form (the public degraded comment was already redacted by
    // buildDegradedBody; this pins the D1/log channel).
    const token = "ghp_modelEmittedSecretToken123";
    runnerStdout = JSON.stringify({
      schema: "mstar.review/v1",
      verdict: token,
      summary_md: "x",
      findings: [],
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — acked

    const rows = failureRows(db);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.error)).toContain(REDACTED);
    expect(String(rows[0]!.error)).not.toContain(token);
    // SEC-01: the degraded-comment input now arrives PRE-REDACTED (shape +
    // exact-value passes applied before postDegraded) — the token never
    // reaches the commenter, and buildDegradedBody's own redaction remains
    // the in-module choke point for anything it adds.
    const degradeInput = commenterCalls.filter((c) => c.op === "degrade")[0]!.args[0] as { error: string };
    expect(degradeInput.error).toContain(REDACTED);
    expect(degradeInput.error).not.toContain(token);
    expect(messageAckCalls).toHaveLength(1);
  });

  test("parse failure with a failing failure-store → degrade still posts + acks (best-effort record)", async () => {
    reset();
    runnerStdout = "not json at all";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, {
      ...testOverrides,
      failureStore: {
        record: async () => {
          throw new Error("d1 down");
        },
        listRecent: async () => [],
      },
    });

    await consumer(makeBatch(makePayload())); // resolves — the insert must not mask the degrade

    expect(commenterCalls.filter((c) => c.op === "degrade")).toHaveLength(1);
    expect(failureRows(db)).toHaveLength(0);
    expect(messageAckCalls).toHaveLength(1);
    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("review_failures insert failed"));
    expect(warn).toBeDefined();
  });

  test("parse failure with a failing degraded post → failure row + ack anyway (best-effort comment)", async () => {
    reset();
    runnerStdout = "not json at all";
    degradeError = new Error("github down");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — a post failure is a log line only

    expect(failureRows(db)).toHaveLength(1);
    expect(messageAckCalls).toHaveLength(1);
    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("degraded comment post failed"));
    expect(warn).toBeDefined();
  });

  test("comment failure → failure row (stage=pipeline) + rethrow, destroy (AL-6)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    commentError = new Error("post failed");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow("post failed");

    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "pipeline", head_sha: SHA });
    expect(destroyCalls).toBe(1);
  });

  test("sandbox exec failure → failure row (stage=sandbox) + rethrow, destroy (AL-6)", async () => {
    reset();
    sandboxError = new Error("container unavailable");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow("container unavailable");
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "sandbox", error: "container unavailable" });
    expect(destroyCalls).toBe(1);
  });

  test("token mint failure → failure row (stage=pipeline, GitHub auth not sandbox) + rethrow, destroy", async () => {
    reset();
    tokenError = new Error("installation token mint failed");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow("installation token mint failed");
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    // The mint rides the payload sha (head not yet resolved) and the
    // "pipeline" stage — it sits between the sandbox window's edges.
    expect(failureRows(db)[0]).toMatchObject({ stage: "pipeline", head_sha: SHA });
    expect(destroyCalls).toBe(1);
  });

  test("clone exitCode !== 0 → failure row (stage=sandbox) + rethrow, destroy, no post/insert", async () => {
    reset();
    cloneExitCode = 128;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/clone failed/);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "sandbox" });
    expect(destroyCalls).toBe(1);
  });

  test("runtime runner: exit 0 with a valid envelope succeeds regardless of stderr diagnostics (no mode marker gate)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    runnerStderr = "seat full-diff/combined done in 41s\nsynthesizeReview ok\n";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — stderr is never a gate

    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    expect(reviewCount(db)).toBe(1);
    expect(destroyCalls).toBe(1);
  });

  test("runner exitCode !== 0 → failure row (stage=runner) + rethrow, destroy, no post/insert (AL-6)", async () => {
    reset();
    runnerExitCode = 1;
    runnerStderr = "review: session failed: boom";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner failed/);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "runner", head_sha: SHA });
    expect(failureRows(db)[0]!.error).toContain("runner failed");
    expect(destroyCalls).toBe(1);
  });

  test("infra failure with a failing failure-store → rethrow not masked (AL-6 best-effort)", async () => {
    reset();
    runnerExitCode = 1;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, {
      ...testOverrides,
      failureStore: {
        record: async () => {
          throw new Error("d1 down");
        },
        listRecent: async () => [],
      },
    });

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner failed/);

    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("review_failures insert failed"));
    expect(warn).toBeDefined();
  });

  test("in-flight legacy-shape payload (absent appRef) → structured channel + healthy batch sibling completes (plan 24 F-001)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    // The in-flight legacy shape: a pre-deploy queue message whose payload
    // carries NO appRef (impossible at the type layer post-24 — cast to
    // simulate the stranded message AL-24-4 accepts). It sits AFTER a
    // healthy sibling in the same batch: the sibling's review completes,
    // then the legacy message throws INSIDE the try and flows through the
    // structured channel (review failed: log + AL-6 row + rethrow) instead
    // of leaving the batch with zero D1/log trace.
    const legacyPayload = makePayload() as unknown as { appRef?: unknown };
    delete legacyPayload.appRef;
    const batch = {
      queue: "review-queue",
      messages: [
        {
          id: "m-healthy",
          timestamp: new Date(),
          attempts: 1,
          body: makePayload(),
          retry: () => {},
          ack: () => {},
        },
        {
          id: "m-legacy",
          timestamp: new Date(),
          attempts: 1,
          body: legacyPayload as ReviewJobPayload,
          retry: () => {},
          ack: () => {},
        },
      ],
    } as unknown as MessageBatch<ReviewJobPayload>;

    await expect(consumer(batch)).rejects.toThrow(TypeError);

    // The healthy sibling completed before the legacy message threw.
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    expect(reviewCount(db)).toBe(1);
    expect(destroyCalls).toBe(1);
    // The structured channel caught the legacy message: error log + AL-6 row.
    const errLine = logLines.find((l) => l.level === "error" && l.msg.startsWith("review failed:"));
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("appId");
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "pipeline" });
    expect(String(failureRows(db)[0]!.error)).toContain("appId");
  });

  test("numstat failure → failure row (stage=sandbox) + no runner/post/insert, rethrow, destroy", async () => {
    reset();
    numstatExitCode = 1;
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/numstat failed/);

    expect(sandboxCalls.some((c) => c.cmd.includes("--input"))).toBe(false);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "sandbox", head_sha: SHA });
    expect(String(failureRows(db)[0]!.error)).toContain("numstat failed");
    expect(destroyCalls).toBe(1);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine?.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
  });

  test("runner input write failure → no runner, no post, no insert, rethrow, destroy", async () => {
    reset();
    writeInputExitCode = 1;
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner input write failed/);

    expect(sandboxCalls.some((c) => c.cmd.includes("--input"))).toBe(false);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  test("REVIEW_LEVEL unset → runner runs the harness landing tier 'default' (AC-S7-level)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerCall = sandboxCalls.find((c) => c.cmd.includes("--input"))!;
    expect(runnerCall.cmd).toContain("--level 'default'");
  });

  test("REVIEW_LEVEL=quick → runner runs `--level 'quick'` (AC-S7-level configurable)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(
      await makeEnv({ DB: db as never, REVIEW_LEVEL: "quick" }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    const runnerCall = sandboxCalls.find((c) => c.cmd.includes("--input"))!;
    expect(runnerCall.cmd).toContain("--level 'quick'");
    expect(reviewCount(db)).toBe(1);
  });

  test("REVIEW_LEVEL=deep → runner runs `--level 'deep'` forwarded unchanged (plan 09 T3 / AC-S9-trigger)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(
      await makeEnv({ DB: db as never, REVIEW_LEVEL: "deep" }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    const runnerCall = sandboxCalls.find((c) => c.cmd.includes("--input"))!;
    expect(runnerCall.cmd).toContain("--level 'deep'");
    expect(reviewCount(db)).toBe(1);
  });
  test("REVIEW_LEVEL=deep → runner exec timeout 840_000 + guard TTL 1560; quick/default stay 600_000 (AC-S10-clock)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(
      await makeEnv({ DB: db as never, REVIEW_LEVEL: "deep" }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    // Deep runner budget: 14 min — CF Queue consumers cap at 15 min
    // wall-clock, so grill-me's 30 min could never finish in-consumer
    // (10-review-d5-budget qc2/qc3 Critical); the old 10 min ceiling would
    // false-timeout a deep three-phase run into the DLQ (spec d5-budget
    // Problem Statement).
    expect(runnerExecTimeout()).toBe(840_000);
    // The in-flight guard TTL follows the same level table (AC-S10-guard).
    expect(kvGuardPuts).toEqual([
      {
        key: "inflight:123:acme/widgets:42",
        value: "inflight",
        options: { expirationTtl: 1560 },
      },
    ]);
    // The quick/default 10-minute table is frozen (spec: 禁止把 quick 全局改成 deep 档预算).
    expect(runnerTimeoutMs("quick")).toBe(600_000);
    expect(runnerTimeoutMs("default")).toBe(600_000);
    expect(runnerTimeoutMs("deep")).toBe(840_000);
  });

  test("success path logs one runner-attempt line with level + runner_timeout_ms + elapsed_ms; default → bun-fanout (AC-S10-logs)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // One runner attempt → at least one budget line on the existing
    // structured-log channel (spec d5-budget L5).
    const line = logLines.find((l) => l.level === "info" && l.msg.includes("runner finished"));
    expect(line).toBeDefined();
    expect(line!.fields.level).toBe("default");
    expect(line!.fields.runner_timeout_ms).toBe(600_000);
    expect(typeof line!.fields.elapsed_ms).toBe("number");
    expect(line!.fields.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(line!.fields.orchestration).toBe("bun-fanout");
  });

  test("REVIEW_LEVEL=deep → runner log: level=deep, budget 840_000, orchestration=parent, NO fake seat_count (AC-S10-logs)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(
      await makeEnv({ DB: db as never, REVIEW_LEVEL: "deep" }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    const line = logLines.find((l) => l.level === "info" && l.msg.includes("runner finished"));
    expect(line).toBeDefined();
    expect(line!.fields.level).toBe("deep");
    expect(line!.fields.runner_timeout_ms).toBe(840_000);
    expect(typeof line!.fields.elapsed_ms).toBe("number");
    // Deep runs the three-stage parent session — never a fabricated Bun
    // seat count (spec § Queue visibility: 禁止写假 seat_count: 7).
    expect(line!.fields.orchestration).toBe("parent");
    expect("seat_count" in line!.fields).toBe(false);
  });

  test("runner failure → error log carries level + runner_timeout_ms + elapsed_ms (AC-S10-logs timeout path)", async () => {
    reset();
    runnerExitCode = 1;
    runnerStderr = "review: session failed: boom";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner failed/);

    // The failure line is the runner attempt's budget line on this path —
    // elapsed_ms is recorded, never used to abort (spec 不 abort: only the
    // sandbox exec timeout itself fails the wall-clock).
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.fields.level).toBe("default");
    expect(errLine!.fields.runner_timeout_ms).toBe(600_000);
    expect(typeof errLine!.fields.elapsed_ms).toBe("number");
    expect(errLine!.fields.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(errLine!.msg).toContain("runner failed");
  });

  test("invalid REVIEW_LEVEL (Object.prototype keys) → fail-loud BEFORE any sandbox step (never a silent downgrade)", async () => {
    // qc3 F-302: "toString"/"__proto__" would pass an `in`-style guard — only
    // REVIEW_LEVELS membership (isReviewLevel) rejects them at this first,
    // pre-sandbox guard. "deep" is NOT here: it is a legal tier since plan 09
    // T1 and is covered by the success test above.
    for (const level of ["toString", "constructor", "__proto__"]) {
      reset();
      const db = await createSeededTestD1();
      const consumer = createReviewConsumer(
        await makeEnv({ DB: db as never, REVIEW_LEVEL: level }),
        testLog,
        testOverrides,
      );

      await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/invalid REVIEW_LEVEL/);

      expect(sandboxCalls).toHaveLength(0);
      expect(commenterCalls).toHaveLength(0);
      expect(reviewCount(db)).toBe(0);
      expect(kvGuardPuts).toHaveLength(0); // the in-flight guard is never touched
      const errLine = logLines.find((l) => l.level === "error");
      expect(errLine).toBeDefined();
      expect(errLine!.msg).toContain("invalid REVIEW_LEVEL");
      expect(errLine!.msg).toContain(JSON.stringify(level));
    }
  });

  test("envelope target folded from reconFacts agrees with the idem key → put cross-check passes (T4 store gate)", async () => {
    reset();
    runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      target: { owner: "acme", repo: "widgets", pr: 42, head_sha: SHA },
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(reviewCount(db)).toBe(1);
    const row = db.raw.query("SELECT envelope FROM reviews").get() as { envelope: string };
    expect(JSON.parse(row.envelope).target).toEqual({ owner: "acme", repo: "widgets", pr: 42, head_sha: SHA });
  });

  test("infra failure logs a structured error with idempotency key + sandbox id before rethrow", async () => {
    reset();
    // A parse failure no longer rethrows (it degrades + acks) — the
    // structured error-log-before-rethrow contract is pinned on a genuine
    // infra failure (runner non-zero exit).
    runnerExitCode = 1;
    runnerStderr = "review: session failed: boom";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner failed/);

    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
    expect(errLine!.fields.sandbox_id).toMatch(/^review-/);
    expect(errLine!.fields.head_sha).toBe(SHA);
    expect(errLine!.msg).toContain("runner failed");
  });

  test("empty actual sha from rev-parse → failure row (stage=sandbox) + no post/insert, rethrow, destroy", async () => {
    reset();
    resolvedSha = "";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload())),
    ).rejects.toThrow(/cannot resolve head sha/);

    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "sandbox", head_sha: SHA });
    expect(destroyCalls).toBe(1);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine?.fields.sandbox_id).toMatch(/^review-/);
  });

  test("pre-checkout failure (invalid REVIEW_LEVEL) → failure row stage=pipeline with the payload sha", async () => {
    reset();
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(
      await makeEnv({ DB: db as never, REVIEW_LEVEL: "bogus" }),
      testLog,
      testOverrides,
    );

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/invalid REVIEW_LEVEL/);

    // The checkout never ran: no authoritative sha — the row carries the
    // payload sha as the best attribution available ("pipeline" phase).
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "pipeline", head_sha: SHA });
    expect(sandboxCalls).toHaveLength(0);
    expect(destroyCalls).toBe(0);
  });

  test("KV completion write failure → warn, still ack (D1 row is durable)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    kvPutError = new Error("kv down");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — KV failure is warn-only

    expect(reviewCount(db)).toBe(1);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    // The completion-write warn (the guard KV warn fires earlier with only
    // baseFields — no idempotency key yet).
    const warnLine = logLines.find((l) => l.level === "warn" && l.msg.includes("KV completion write failed"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
  });

  test("destroy failure after success → warn with idempotency key, result not masked", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    destroyError = new Error("destroy boom");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — destroy failure is warn-only

    expect(reviewCount(db)).toBe(1);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    const warnLine = logLines.find((l) => l.level === "warn" && l.msg.includes("destroy"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
    expect(warnLine!.fields.sandbox_id).toMatch(/^review-/);
  });

  test("model output containing secrets is redacted before post and insert (B2/SEC-02)", async () => {
    reset();
    const leaked: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "blocked",
      summary_md: `Provider key AKIAIOSFODNN7EXAMPLE and ${"a".repeat(40)} leaked`,
      findings: [
        {
          mergeClass: "must-fix",
          category: "security",
          file_path: "src/auth.ts",
          line_start: 1,
          line_end: 1,
          title: "Leak ghp_abcdef1234567890",
          body: "token ghp_abcdef1234567890 and Bearer ghs_abcdef1234567890",
        },
        {
          mergeClass: "should-fix",
          category: "AKIAIOSFODNN7EXAMPLE leak",
          file_path: "evil/AKIAIOSFODNN7EXAMPLE/x.ts",
          title: "Exfil",
          body: "clean body",
        },
      ],
    };
    runnerStdout = JSON.stringify(leaked);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The POSTED review carries no secret-shaped text.
    const posted = commenterCalls.find((c) => c.op === "post")!.args[0] as {
      output: ReviewOutput;
      omittedFindings: number;
    };
    expect(posted.output.findings[0]!.body).not.toContain("ghs_abcdef1234567890");
    // qc2 F-001: title / category / file_path are model-controlled public
    // channels too — redacted through the same consumer choke point.
    expect(posted.output.findings[0]!.title).not.toContain("ghp_abcdef1234567890");
    expect(posted.output.findings[1]!.category).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(posted.output.findings[1]!.file_path).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(posted.omittedFindings).toBe(0);

    // The stored row (summary_md + envelope) carries no secret-shaped text;
    // raw_output is never written on the v1 path (envelope is authoritative).
    const row = db.raw.query("SELECT summary_md, envelope, raw_output FROM reviews").get() as {
      summary_md: string;
      envelope: string;
      raw_output: string | null;
    };
    expect(row.summary_md).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(row.raw_output).toBeNull();
    expect(row.envelope).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(row.envelope).not.toContain("ghp_abcdef1234567890");
  });


  test("oversized finding title/body are clamped before post and insert (qc2 F-003 wiring)", async () => {
    reset();
    const big: ReviewOutput = {
      schema: "mstar.review/v1",
      verdict: "blocked",
      summary_md: "s",
      findings: [
        {
          mergeClass: "nit",
          // Non-hex filler: a long [0-9a-fA-F] run would be redacted
          // (long-hex pattern) before the clamp under test ever runs.
          title: "T".repeat(FINDING_TITLE_MAX + 10),
          body: "Z".repeat(FINDING_BODY_MAX + 10),
        },
      ],
    };
    runnerStdout = JSON.stringify(big);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const posted = commenterCalls.find((c) => c.op === "post")!.args[0] as { output: ReviewOutput };
    expect(posted.output.findings[0]!.title).toHaveLength(FINDING_TITLE_MAX);
    expect(posted.output.findings[0]!.body).toHaveLength(FINDING_BODY_MAX);
    // The D1 envelope carries the same clamped array (B4: one capped array).
    const row = db.raw.query("SELECT envelope FROM reviews").get() as { envelope: string };
    expect(row.envelope).not.toContain("T".repeat(FINDING_TITLE_MAX + 10));
  });

  test("findings over the cap are trimmed to Top-50 by merge class on post AND insert (B4)", async () => {
    reset();
    const findings: Array<{
      mergeClass: "must-fix" | "should-fix" | "nit";
      file_path: string;
      line_start: number;
      line_end: number;
      title: string;
      body: string;
    }> = Array.from({ length: 60 }, (_, i) => ({
      mergeClass: "nit" as const,
      file_path: "f.ts",
      line_start: i,
      line_end: i,
      title: `F${i}`,
      body: `body ${i}`,
    }));
    findings[0]!.mergeClass = "must-fix"; // earliest must-fix keeps its slot
    findings[59]!.mergeClass = "must-fix"; // later must-fix sorts after F0
    findings[58]!.mergeClass = "should-fix";
    runnerStdout = JSON.stringify({
      schema: "mstar.review/v1",
      verdict: "blocked",
      summary_md: "many findings",
      findings,
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const posted = commenterCalls.find((c) => c.op === "post")!.args[0] as {
      output: ReviewOutput;
      omittedFindings: number;
    };
    expect(posted.output.findings).toHaveLength(50);
    expect(posted.omittedFindings).toBe(10);
    // Merge-class priority: the two must-fix first (stable — F0 before F59),
    // then the should-fix, then the nits.
    expect(posted.output.findings[0]!.title).toBe("F0");
    expect(posted.output.findings[1]!.title).toBe("F59");
    expect(posted.output.findings[2]!.title).toBe("F58");
    expect(posted.output.findings[2]!.mergeClass).toBe("should-fix");

    // The same capped array landed in D1 (渲染与落库同一裁剪数组).
    const stored = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(stored.n).toBe(50);
  });

  test("KV done-state hit → ack without post/insert (B3)", async () => {
    reset();
    kvGetValue = "done";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // Clone + rev-parse run (the authoritative sha is only known post-clone),
    // then the KV done hit acks before any post/insert.
    expect(sandboxCalls.map((c) => c.cmd)).toEqual([
      expect.stringContaining("git init '/workspace/repo'"),
      expect.stringContaining("git -C '/workspace/repo' rev-parse HEAD"),
    ]);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(kvPuts).toHaveLength(0);
    expect(destroyCalls).toBe(1);
    const infoLine = logLines.find((l) => l.level === "info" && l.msg.includes("KV idempotency hit"));
    expect(infoLine).toBeDefined();
  });

  test("put failure after a successful post → one comment, KV done, warn + ack, no rethrow (B3)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const failingStore = {
      put: mock(async () => {
        throw new Error("d1 down");
      }),
      get: mock(async () => undefined),
      findByIdempotencyKey: mock(async () => null),
    };
    const consumer = createReviewConsumer(
      await makeEnv({ DB: db as never }),
      testLog,
      { ...testOverrides, store: failingStore },
    );

    await consumer(makeBatch(makePayload())); // resolves (ack) — no rethrow

    // Exactly one comment was posted; the KV done-state was written BEFORE
    // the insert attempt, so a retry acks instead of re-posting.
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    expect(kvPuts).toEqual([
      {
        key: `idem:123:acme/widgets:42:${SHA}`,
        value: "done",
        options: { expirationTtl: 86400 },
      },
    ]);

    const warnLine = logLines.find((l) => l.level === "warn" && l.msg.includes("insert failed"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
    expect(destroyCalls).toBe(1);
  });

  test("BB-1: the App's modelChain is forwarded verbatim into the runner exec env (per-App only, AL-24-5)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    // The chain's openrouter provider needs its per-App key (fail-closed gate).
    await seedAppConfig(db, TEST_APP_ID, "ark-plan/deepseek-v4-flash,openrouter/anthropic/claude-sonnet-4", {
      openrouter: "sk-or-app",
    });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerCall = sandboxCalls.find((c) => c.cmd.includes("bun run"))!;
    expect(runnerCall.opts).toEqual({
      cwd: "/workspace/repo",
      env: {
        ARK_API_KEY: "ark-key",
        HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
        PI_CODING_AGENT_DIR: "/opt/omp-agent",
        OMP_REVIEW_MODEL: "ark-plan/deepseek-v4-flash,openrouter/anthropic/claude-sonnet-4",
        OPENROUTER_API_KEY: "sk-or-app",
      },
      timeout: 600_000,
    });
    // Version record (plan 18 Task 1): the row records the App chain's HEAD
    // selector; provider stays NULL.
    const versionRow = db.raw.query("SELECT model, provider FROM reviews").get() as {
      model: string | null;
      provider: string | null;
    };
    expect(versionRow.model).toBe("ark-plan/deepseek-v4-flash");
    expect(versionRow.provider).toBeNull();
  });

  test("BB-1: an App with NO modelChain fails closed — no in-image default run, structured channel (AL-24-5)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    // Clear the seeded chain (setModelChain("") removes the row — plan 15).
    await createAppConfigStore(db, TEST_KEY).setModelChain(TEST_APP_ID, "");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(
      /per-App config incomplete: app .*missing model chain/,
    );

    // F-001 channel: no runner exec, no review row, stage=pipeline failure
    // row, rethrow (retry → DLQ). The in-image default never runs.
    expect(sandboxCalls.some((c) => c.cmd.includes("bun run"))).toBe(false);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "pipeline" });
    expect(String(failureRows(db)[0]!.error)).toContain("missing model chain");
    expect(destroyCalls).toBe(0);
  });

  test("BB-1: a comma-only modelChain (',' — zero selectors) fails closed — structured channel, sibling completes (AL-24-5)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    // A second App whose stored chain parses to ZERO selectors. The store
    // persists `","` verbatim (setModelChain only deletes null/whitespace),
    // so a direct-DB or store caller can persist it; the fail-closed gate
    // must treat it as "missing model chain" — the runner's
    // parseModelSelectors would yield [] and fall back to the in-image
    // DEFAULT_MODEL_PATTERN scaffold, and chainHeadSelector would record
    // NULL on a successful put (Interfaces: success never NULL).
    const commaAppId = "22222222-3333-4444-5555-666666666666";
    const box = createSecretbox(TEST_KEY);
    db.raw
      .prepare(
        `INSERT INTO github_apps
           (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, 'comma-chain-app', 424243, 'comma-chain-app', ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(
        commaAppId,
        await box.encryptSecret(TEST_APP_PEM, `github_apps.private_key_enc:${commaAppId}`),
        await box.encryptSecret("whsec-comma-app", `github_apps.webhook_secret_enc:${commaAppId}`),
      );
    await seedAppConfig(db, commaAppId, ",");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    // Healthy sibling FIRST (completes), comma-only message second (throws
    // inside the try → structured channel → rethrow).
    const batch = {
      queue: "review-queue",
      messages: [
        {
          id: "m-healthy",
          timestamp: new Date(),
          attempts: 1,
          body: makePayload(),
          retry: () => {},
          ack: () => {},
        },
        {
          id: "m-comma",
          timestamp: new Date(),
          attempts: 1,
          body: makePayload({ appRef: { appId: commaAppId } }),
          retry: () => {},
          ack: () => {},
        },
      ],
    } as unknown as MessageBatch<ReviewJobPayload>;

    await expect(consumer(batch)).rejects.toThrow(/per-App config incomplete: app .*missing model chain/);

    // The healthy sibling completed before the comma-only message threw.
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    expect(reviewCount(db)).toBe(1);
    expect(destroyCalls).toBe(1);
    // Structured channel: error log + stage=pipeline failure row; the
    // failing message never reached the sandbox or wrote a review row.
    const errLine = logLines.find((l) => l.level === "error" && l.msg.startsWith("review failed:"));
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("missing model chain");
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "pipeline" });
    expect(String(failureRows(db)[0]!.error)).toContain("missing model chain");
  });

  test("BB-1: a comma-only ROLE OVERRIDE chain (',' — zero selectors) fails closed — structured channel, sibling completes (PR #11 BUG-01)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    // A second App with a HEALTHY base chain (passes the base gate) but a
    // raw `,` role-override row inserted DIRECTLY into app_model_roles. The
    // dashboard store rejects this shape (assertModelRoleEntry →
    // InvalidModelSelectorError), so only a direct-D1 write can land it; the
    // consumer gate is the backstop and must treat it as "missing model
    // chain" — the runner's parseModelSelectors would yield [] for the
    // override, and the runner-side `trim() !== ""` presence check would
    // otherwise count it as an override and run the in-image
    // DEFAULT_MODEL_PATTERN scaffold (with the ark key) or fail at
    // stage=runner after side effects.
    const overrideAppId = "33333333-4444-5555-6666-777777777777";
    const box = createSecretbox(TEST_KEY);
    db.raw
      .prepare(
        `INSERT INTO github_apps
           (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, 'comma-override-app', 424244, 'comma-override-app', ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
      )
      .run(
        overrideAppId,
        await box.encryptSecret(TEST_APP_PEM, `github_apps.private_key_enc:${overrideAppId}`),
        await box.encryptSecret(
          "whsec-override-app",
          `github_apps.webhook_secret_enc:${overrideAppId}`,
        ),
      );
    await seedAppConfig(db, overrideAppId); // healthy base chain + ark key
    db.raw
      .prepare(`INSERT INTO app_model_roles (app_id, role, selector) VALUES (?, ?, ?)`)
      .run(overrideAppId, "code-reviewer", ",");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    // Healthy sibling FIRST (completes), comma-override message second
    // (throws inside the try → structured channel → rethrow).
    const batch = {
      queue: "review-queue",
      messages: [
        {
          id: "m-healthy",
          timestamp: new Date(),
          attempts: 1,
          body: makePayload(),
          retry: () => {},
          ack: () => {},
        },
        {
          id: "m-override",
          timestamp: new Date(),
          attempts: 1,
          body: makePayload({ appRef: { appId: overrideAppId } }),
          retry: () => {},
          ack: () => {},
        },
      ],
    } as unknown as MessageBatch<ReviewJobPayload>;

    await expect(consumer(batch)).rejects.toThrow(
      /per-App config incomplete: app .*role override `code-reviewer`: missing model chain/,
    );

    // The healthy sibling completed before the comma-override message threw.
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    expect(reviewCount(db)).toBe(1);
    expect(destroyCalls).toBe(1);
    // Structured channel: error log + stage=pipeline failure row; the
    // failing message never reached the sandbox.
    const errLine = logLines.find((l) => l.level === "error" && l.msg.startsWith("review failed:"));
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("role override `code-reviewer`: missing model chain");
    expect(failureRows(db)).toHaveLength(1);
    expect(failureRows(db)[0]).toMatchObject({ stage: "pipeline" });
    expect(String(failureRows(db)[0]!.error)).toContain(
      "role override `code-reviewer`: missing model chain",
    );
  });

  test("BB-2: the App's stored keys are forwarded under their PROVIDERS env names; blank rows never inject (per-App BYOK)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    // A chain needing openai + groq; anthropic/openrouter key rows ride along
    // under their allowlisted env names; an empty mistral row never injects.
    await seedAppConfig(db, TEST_APP_ID, "openai/gpt-app,groq/query", {
      anthropic: "sk-ant-test",
      openrouter: "sk-or-test",
      openai: "sk-openai-x",
      groq: "sk-groq-x",
    });
    await createAppConfigStore(db, TEST_KEY).setProviderKey(TEST_APP_ID, "mistral", " ");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerEnv = runnerExecEnv();
    expect(runnerEnv).toMatchObject({
      ARK_API_KEY: "ark-key",
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENAI_API_KEY: "sk-openai-x",
    });
    expect(runnerEnv.MISTRAL_API_KEY).toBeUndefined();
  });

  test("BB-2: only App-config keys reach the container — arbitrary env is NEVER forwarded (allowlist)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedAppConfig(db, TEST_APP_ID, "openai/gpt-app", { gemini: "gem-test", openai: "sk-openai-x" });
    // Vars that are NOT in the PROVIDERS allowlist sit on the Worker env —
    // they must never leak into the container. GEMINI_API_KEY on the env is
    // a stale duplicate of the App-stored key (AL-24-5: env is never read).
    const env = (await makeEnv({ DB: db as never })) as PipelineEnv & Record<string, string>;
    env.SOME_ARBITRARY_SECRET = "must-not-leak";
    env.GEMINI_API_KEY = "env-gemini-not-app";
    const consumer = createReviewConsumer(env, testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerEnv = runnerExecEnv();
    // The gemini key comes from the APP config, never the env duplicate.
    expect(runnerEnv).toEqual({
      ARK_API_KEY: "ark-key",
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      OMP_REVIEW_MODEL: "openai/gpt-app",
      GEMINI_API_KEY: "gem-test",
      OPENAI_API_KEY: "sk-openai-x",
    });
    expect(Object.values(runnerEnv)).not.toContain("must-not-leak");
    expect(Object.values(runnerEnv)).not.toContain("env-gemini-not-app");
  });

  test("guard held on attempt 1 → per-message delayed retry (60s), no throw, no post/insert (BB-3)", async () => {
    reset();
    kvGuardValue = "inflight";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    // BB-3: the consumer RESOLVES — guard-held is a typed outcome, not a
    // rethrow. Rethrowing would burn the queue's three immediate retries and
    // DLQ the job (plus later synchronize events for the same PR) while the
    // first review is still running.
    await consumer(makeBatch(makePayload()));

    // Fail fast: no sandbox, no token, no post, no insert, no guard mutation.
    expect(sandboxCalls).toHaveLength(0);
    expect(commenterCalls).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(kvGuardDeletes).toHaveLength(0);
    expect(destroyCalls).toBe(0);
    // A DELAYED per-message retry is scheduled — 60s on the first attempt.
    expect(messageRetryCalls).toEqual([{ attempts: 1, delaySeconds: 60 }]);
    expect(messageAckCalls).toHaveLength(0);
    const infoLine = logLines.find((l) => l.level === "info" && l.msg.includes("already in flight"));
    expect(infoLine).toBeDefined();
    expect(infoLine!.msg).toContain("60s");
  });

  test("guard-held backoff escalates 60s → 120s → 240s across attempts (BB-3)", async () => {
    reset();
    kvGuardValue = "inflight";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);
    for (const [attempts, delaySeconds] of [
      [1, 60],
      [2, 120],
      [3, 240],
    ] as const) {
      messageAttempts = attempts;
      await consumer(makeBatch(makePayload()));
    }
    expect(messageRetryCalls).toEqual([
      { attempts: 1, delaySeconds: 60 },
      { attempts: 2, delaySeconds: 120 },
      { attempts: 3, delaySeconds: 240 },
    ]);
    expect(messageAckCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });
  test("REVIEW_LEVEL=deep guard-held → delayed retries use the deep backoff 180s → 360s → 720s (AC-S10-guard)", async () => {
    reset();
    kvGuardValue = "inflight";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(
      await makeEnv({ DB: db as never, REVIEW_LEVEL: "deep" }),
      testLog,
      testOverrides,
    );
    for (const [attempts, delaySeconds] of [
      [1, 180],
      [2, 360],
      [3, 720],
    ] as const) {
      messageAttempts = attempts;
      await consumer(makeBatch(makePayload()));
    }
    expect(messageRetryCalls).toEqual([
      { attempts: 1, delaySeconds: 180 },
      { attempts: 2, delaySeconds: 360 },
      { attempts: 3, delaySeconds: 720 },
    ]);
    expect(messageAckCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("guard still held after the 3 delayed retries → ack with a warning, no DLQ (BB-3)", async () => {
    reset();
    kvGuardValue = "inflight";
    messageAttempts = 4; // final delivery before the queue would DLQ
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — acked, never DLQed

    expect(sandboxCalls).toHaveLength(0);
    expect(messageRetryCalls).toHaveLength(0);
    expect(messageAckCalls).toEqual([{ attempts: 4 }]);
    const warnLine = logLines.find((l) => l.level === "warn" && l.msg.includes("acking"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.msg).toContain("no DLQ");
    expect(warnLine!.fields.pr_number).toBe(42);
    expect(warnLine!.fields.installation_id).toBe(123);
  });

  test("real failures keep the throw → queue retry → DLQ behavior (BB-3 unchanged)", async () => {
    reset();
    // A parse failure now DEGRADES (acks) — the real-failure throw path is
    // pinned on a genuine infra failure instead (runner non-zero exit).
    runnerExitCode = 1;
    runnerStderr = "review: session failed: boom";
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner failed/);

    // Only the guard-held path is handled with message-level retry/ack; a
    // real failure rethrows exactly as before.
    expect(messageRetryCalls).toHaveLength(0);
    expect(messageAckCalls).toHaveLength(0);
    expect(destroyCalls).toBe(1);
  });

  test("in-flight guard acquired before the pipeline and released after the post settles (WF-002)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // Guard keyed per PR (no head_sha), written BEFORE the pipeline runs and
    // deleted in the finally once the post settled.
    expect(kvGuardPuts).toEqual([
      {
        key: "inflight:123:acme/widgets:42",
        value: "inflight",
        options: { expirationTtl: reviewGuardTtlSeconds("default") },
      },
    ]);
    expect(kvGuardDeletes).toEqual(["inflight:123:acme/widgets:42"]);
    expect(reviewCount(db)).toBe(1);
  });
  test("reviewGuardTtlSeconds covers the full step-budget arithmetic per level (qc3 F-301 pin / AC-S10-guard)", () => {
    // Exact pin: FIVE git-timed steps (clone, rev-parse, diff, numstat,
    // runner-input write) × 120s + the LEVEL's runner budget + 120s slack
    // for the untimed steps (token mint, sandbox create, comment post,
    // KV/D1 puts) = 1320s quick/default, 1560s deep (spec d5-budget L4).
    // numstat + the input write were added by plan 07 without recomputing
    // the old 3-step formula (1020s) — any future step or ceiling change
    // must recompute this helper ON PURPOSE.
    expect(reviewGuardTtlSeconds("quick")).toBe(1320);
    expect(reviewGuardTtlSeconds("default")).toBe(1320);
    expect(reviewGuardTtlSeconds("deep")).toBe(1560);
  });

  test("guardRetryDelaysSeconds per level — every delay below that level's guard TTL (AC-S10-guard)", () => {
    // quick/default keep the frozen 60/120/240 table; deep stretches to
    // 180/360/720. Every entry must stay below the level's guard TTL so the
    // held guard can never expire mid-backoff into a duplicate race.
    expect(guardRetryDelaysSeconds("quick")).toEqual([60, 120, 240]);
    expect(guardRetryDelaysSeconds("default")).toEqual([60, 120, 240]);
    expect(guardRetryDelaysSeconds("deep")).toEqual([180, 360, 720]);
    for (const level of ["quick", "default", "deep"] as const) {
      for (const delay of guardRetryDelaysSeconds(level)) {
        expect(delay).toBeLessThan(reviewGuardTtlSeconds(level));
      }
    }
  });
});

describe("line comments (plan 18 Task 3 / AL-3 layered delivery)", () => {
  test("no qualifying findings (no position) → zero line-comment API calls (byte-compat)", async () => {
    reset();
    runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      findings: [
        { mergeClass: "nit", title: "Repo-wide nit", body: "No location." },
        { mergeClass: "nit", file_path: "src/auth.ts", title: "No line", body: "Path only." },
        { mergeClass: "nit", file_path: "src/auth.ts", line_end: 0, title: "Zero line", body: "Line 0." },
      ],
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // Overall comment + persistence all landed; the diff is NOT even
    // prefetched when the base filter is empty (no extra API call). The
    // degraded-comment delete scan still runs (no stale comment → no call).
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded"]);
    expect(reviewCount(db)).toBe(1);
    expect(kvPuts).toHaveLength(1);
    expect(destroyCalls).toBe(1);
  });

  test("hunk-external findings are excluded; all excluded → prefetch ran but no createReview call", async () => {
    reset();
    // VALID_DIFF covers src/auth.ts right range [18,23]: line 100 is
    // outside every hunk; docs/readme.md is not in the diff at all.
    runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      findings: [
        { mergeClass: "must-fix", file_path: "src/auth.ts", line_start: 100, line_end: 100, title: "Outside", body: "B." },
        { mergeClass: "nit", file_path: "docs/readme.md", line_start: 5, line_end: 5, title: "Other file", body: "B." },
        { mergeClass: "should-fix", file_path: "src/auth.ts", line_start: 21, line_end: 21, title: "Inside", body: "B." },
      ],
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff", "line-comments"]);
    const lineInput = commenterCalls[4]!.args[0] as { findings: Array<{ title: string; line_end?: number }> };
    // Only the hunk-internal finding survives the prefilter.
    expect(lineInput.findings.map((f) => f.title)).toEqual(["Inside"]);

    // And when NOTHING survives, the createReview call is skipped entirely.
    reset();
    runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      findings: [
        { mergeClass: "must-fix", file_path: "src/auth.ts", line_start: 100, line_end: 100, title: "Outside", body: "B." },
      ],
    });
    const db2 = await createSeededTestD1();
    const consumer2 = createReviewConsumer(await makeEnv({ DB: db2 as never }), testLog, testOverrides);
    await consumer2(makeBatch(makePayload()));
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff"]);
    expect(reviewCount(db2)).toBe(1);
  });

  test("diff prefetch failure → base-filter attempt (draft semantics), warn without the fallback flag", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    diffError = new Error("diff fetch 500");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The createReview attempt still runs, on the UNFILTERED base set.
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff", "line-comments"]);
    const lineInput = commenterCalls[4]!.args[0] as { findings: unknown[] };
    expect(lineInput.findings).toHaveLength(1);
    // The prefetch failure is a plain warn — NOT a fallback (the attempt
    // proceeded), and the review completed normally.
    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("diff prefetch failed"));
    expect(warn).toBeDefined();
    expect(warn!.fields.line_comments_fallback).toBeUndefined();
    expect(logLines.some((l) => l.fields.line_comments_fallback === true)).toBe(false);
    expect(reviewCount(db)).toBe(1);
    expect(kvPuts).toHaveLength(1);
    expect(destroyCalls).toBe(1);
  });

  test("oversized diff prefetch → the hunk prefilter is skipped exactly like a prefetch failure (qc3 F-101)", async () => {
    reset();
    // A finding OUTSIDE every VALID_DIFF hunk (line 100): with a bounded
    // prefetch the hunk layer would EXCLUDE it — an over-cap diff must
    // degrade to the base-filter attempt, never materialize a multi-MB
    // line array in parseDiffHunkRanges.
    runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      findings: [{ ...VALID_OUTPUT.findings[0]!, line_start: 100, line_end: 100 }],
    });
    diffResult = `${VALID_DIFF}\n${" ".repeat(DIFF_PREFETCH_MAX_BYTES)}`;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The attempt still ran on the base-filtered set — the hunk-external
    // finding SURVIVED because the hunk layer never saw the diff.
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff", "line-comments"]);
    const lineInput = commenterCalls[4]!.args[0] as { findings: unknown[] };
    expect(lineInput.findings).toHaveLength(1);
    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("diff prefetch failed"));
    expect(warn).toBeDefined();
    expect(warn!.msg).toContain("exceeds DIFF_PREFETCH_MAX_BYTES");
    // Not a delivery fallback — the createReview attempt proceeded.
    expect(logLines.some((l) => l.fields.line_comments_fallback === true)).toBe(false);
    expect(reviewCount(db)).toBe(1);
    expect(kvPuts).toHaveLength(1);
    expect(destroyCalls).toBe(1);
  });

  test("residual 422 / network error on createReview → line_comments_fallback log + continue, never throws", async () => {
    for (const failure of [
      Object.assign(new Error("Validation Failed: line is not part of the diff"), { status: 422 }),
      new Error("socket hangup"),
    ]) {
      reset();
      runnerStdout = JSON.stringify(VALID_OUTPUT);
      lineCommentsError = failure;
      const db = await createSeededTestD1();
      const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

      // NEVER throws after the overall comment succeeded: the run resolves,
      // the message acks, KV done + D1 row land exactly as without line
      // comments.
      await consumer(makeBatch(makePayload()));

      expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff", "line-comments"]);
      const fallback = logLines.find((l) => l.fields.line_comments_fallback === true);
      expect(fallback).toBeDefined();
      expect(fallback!.level).toBe("warn");
      expect(fallback!.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
      expect(reviewCount(db)).toBe(1);
      expect(kvPuts).toEqual([
        { key: `idem:123:acme/widgets:42:${SHA}`, value: "done", options: { expirationTtl: 86400 } },
      ]);
      // The ok path resolves silently (queue auto-ack) — the point is that
      // NOTHING retried: the failure never escaped processMessage.
      expect(messageRetryCalls).toHaveLength(0);
      expect(destroyCalls).toBe(1);
    }
  });
});

describe("degraded-comment lifecycle (Bugbot finding)", () => {
  test("success flow with a pre-existing degraded comment → the delete scan runs after the upsert", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    deleteDegradedOutcome = { deleted: 1, skipped: 1, errors: ["rate limited"] };
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The delete scan runs between the overall upsert and the line-comments
    // step (the fake's deleteDegradedComment records the call; the real
    // implementation scans + deletes the stale bot-authored comments).
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff", "line-comments"]);
    const deleteInput = commenterCalls.find((c) => c.op === "delete-degraded")!.args[0] as {
      installationId: number;
      owner: string;
      repo: string;
      prNumber: number;
    };
    expect(deleteInput).toMatchObject({ installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 });
    // The outcome is logged as a structured warn (never throws, never blocks).
    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("stale degraded comment cleanup"));
    expect(warn).toBeDefined();
    expect(warn!.msg).toContain("deleted=1, skipped=1");
    expect(warn!.msg).toContain("rate limited");
    expect(warn!.fields.degraded_delete_deleted).toBe(1);
    expect(warn!.fields.degraded_delete_skipped).toBe(1);
    expect(reviewCount(db)).toBe(1);
    expect(kvPuts).toHaveLength(1);
    // The ok path resolves silently (queue auto-ack) — nothing retried.
    expect(messageRetryCalls).toHaveLength(0);
  });

  test("stale degraded comment delete failure → warn, review stands, never throws", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    deleteDegradedError = new Error("delete 500");
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The delete failure is a structured warn — the review flow continues
    // (line comments + KV done + D1 row all land) and nothing retries.
    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("stale degraded comment delete failed"));
    expect(warn).toBeDefined();
    expect(warn!.msg).toContain("delete 500");
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post", "delete-degraded", "fetch-diff", "line-comments"]);
    expect(reviewCount(db)).toBe(1);
    expect(kvPuts).toHaveLength(1);
    expect(messageRetryCalls).toHaveLength(0);
    expect(destroyCalls).toBe(1);
  });
});

describe("line-comments round pin (plan 18 Task 3 / AL-3)", () => {
  test("the line-comments round pins to the round the overall upsert returned", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    postRound = 4;
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const lineInput = commenterCalls.find((c) => c.op === "line-comments")!.args[0] as { round: number };
    expect(lineInput.round).toBe(4);
  });
});

describe("SEC-01 exact-value redaction through the consumer", () => {
  test("a UUID-shaped provider key in the runner env never reaches the comment body or the D1 envelope", async () => {
    reset();
    // A UUID-shaped key evades every shape pattern — only the exact-value
    // pass (sessionSecretValues from the runner env) can remove it.
    const uuidKey = "3f2a1b4c-9d8e-4f6a-b7c2-1e0d9a8b7c6d";
    runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      summary_md: `leaked ${uuidKey} in the summary`,
      findings: [
        { ...VALID_OUTPUT.findings[0]!, body: `body ${uuidKey}` },
      ],
    });
    const db = await createSeededTestD1();
    // The UUID key rides the App's per-App config (per-App BYOK, AL-24-5) —
    // the exact-redact pass must pull it from the assembled runner env.
    await seedAppConfig(db, TEST_APP_ID, "openai/gpt-app", { gemini: uuidKey, openai: "sk-openai-x" });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The posted comment body never carries the key.
    const postInput = commenterCalls.find((c) => c.op === "post")!.args[0] as { output: ReviewOutput };
    expect(JSON.stringify(postInput.output)).not.toContain(uuidKey);
    // The D1 envelope never carries the key either.
    const row = db.raw.query("SELECT envelope FROM reviews").get() as { envelope: string };
    expect(row.envelope).not.toContain(uuidKey);
    expect(row.envelope).toContain(REDACTED);
  });

  test("the minted installation token is exact-redacted from the degraded comment input", async () => {
    reset();
    tokenResult = "ghs_installation_token";
    // The parse error echoes the installation token verbatim (a
    // prompt-injected echo) — the exact-value pass must remove it before
    // postDegraded and the failure row.
    runnerStdout = JSON.stringify({
      schema: "mstar.review/v1",
      verdict: "ghs_installation_token",
      summary_md: "x",
      findings: [],
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — acked

    const degradeInput = commenterCalls.filter((c) => c.op === "degrade")[0]!.args[0] as {
      error: string;
      rawOutput: string;
    };
    expect(degradeInput.error).not.toContain("ghs_installation_token");
    expect(degradeInput.rawOutput).not.toContain("ghs_installation_token");
    const rows = failureRows(db);
    expect(String(rows[0]!.error)).not.toContain("ghs_installation_token");
  });
});
describe("cross-round repeat dedup (plan 21 Task 3 / AL-21-2)", () => {
  test("previous round fingerprints are queried before the post and passed to comment assembly", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const store = createArtifactStore(db);
    // A previous round for the SAME PR (different sha — the current sha row
    // does not exist yet at assembly time; no head_sha exclusion).
    const prevFinding = {
      mergeClass: "should-fix",
      category: "logic",
      file_path: "src/auth.ts",
      line_start: 21,
      line_end: 21,
      title: "Fractional expiry comparison",
      body: "same finding as this round",
    };
    await store.put({
      kind: "review",
      key: idemKey({ installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: "a".repeat(40) }),
      schema: "mstar.review/v1",
      payload: { ...VALID_OUTPUT, findings: [prevFinding] },
    });
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const post = commenterCalls.find((c) => c.op === "post")!;
    expect(post.args[0]).toMatchObject({
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });
    const input = post.args[0] as { previousFingerprints?: ReadonlySet<string> };
    expect(input.previousFingerprints).toEqual(new Set([computeFindingFingerprint(prevFinding)]));
  });

  test("no previous round → post proceeds with no previousFingerprints (first round)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const post = commenterCalls.find((c) => c.op === "post")!;
    expect((post.args[0] as { previousFingerprints?: unknown }).previousFingerprints).toBeUndefined();
    expect(reviewCount(db)).toBe(1);
  });

  test("query failure → first-round semantics: post proceeds, warn logged, review still lands", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    // Break ONLY the previous-round query (the store's own statements keep
    // working) — the consumer must treat the failure as first round.
    const failingDb = {
      ...db,
      prepare: (query: string) => {
        if (query.includes("envelope IS NOT NULL")) {
          return {
            bind: () => {
              throw new Error("simulated previous-round query failure");
            },
          } as never;
        }
        return db.prepare(query);
      },
    };
    const consumer = createReviewConsumer(await makeEnv({ DB: failingDb as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const post = commenterCalls.find((c) => c.op === "post")!;
    expect((post.args[0] as { previousFingerprints?: unknown }).previousFingerprints).toBeUndefined();
    const warn = logLines.find((l) => l.level === "warn" && l.msg.includes("previous-round fingerprint query failed"));
    expect(warn).toBeDefined();
    // S-3: the dedup-degradation warn carries a structured field, not just text.
    expect(warn!.fields.dedup).toBe("degraded");
    expect(reviewCount(db)).toBe(1);
  });

  test("oversized fingerprint_hint is clamped at the choke point — never lands verbatim in the D1 fingerprint column (S-1)", async () => {
    reset();
    const oversizedHint = "hint-" + "x".repeat(FINDING_TITLE_MAX + 100);
    runnerStdout = JSON.stringify({
      ...VALID_OUTPUT,
      findings: [{ ...VALID_OUTPUT.findings[0]!, fingerprint_hint: oversizedHint }],
    });
    const db = await createSeededTestD1();
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const row = db.raw.query("SELECT fingerprint FROM findings").get() as { fingerprint: string | null };
    // The full hint never reaches the index column…
    expect(row.fingerprint).not.toContain(oversizedHint);
    // …the clamped hint (title budget + ellipsis) is what lands.
    expect(row.fingerprint).toBe(oversizedHint.slice(0, FINDING_TITLE_MAX - 1) + "…");
  });
});
