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
 *   - parse failure → no post, no insert, rethrow, destroy
 *   - comment failure → no insert, rethrow, destroy
 *   - finally destroy on every path
 */

import { describe, expect, mock, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ReviewOutput } from "../../src/review/schema";
import { FINDING_BODY_MAX, FINDING_TITLE_MAX } from "../../src/review/schema";
import { createArtifactStore } from "../../src/store/artifact-store";
import { idemKey } from "../../src/contracts/idem";
import { createTestD1 } from "../store/helpers";
import type { ReviewCommenter } from "../../src/pipeline/comment";

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
let commentError: Error | undefined;

const fakeCommenter: ReviewCommenter = {
  getInstallationToken: mock(async (installationId: number) => {
    commenterCalls.push({ op: "token", args: [installationId] });
    return tokenResult;
  }),
  postReview: mock(async (input: unknown) => {
    commenterCalls.push({ op: "post", args: [input] });
    if (commentError) throw commentError;
  }),
};

// Injected into every consumer under test (DI replaces the old mock.module).
const testOverrides = {
  commenter: fakeCommenter,
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
const { createReviewConsumer, runnerTimeoutMs, reviewGuardTtlSeconds, guardRetryDelaysSeconds } = await import("../../src/pipeline/consumer");
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

function makeEnv(overrides: Partial<PipelineEnv> = {}): PipelineEnv {
  return {
    APP_ID: "123",
    PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
    OMP_MODEL_KEY: "ark-key",
    DB: createTestD1() as never,
    IDEMPOTENCY_KV: kv as never,
    SANDBOX: {} as never,
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
  commentError = undefined;
  kvPutError = undefined;
  kvGetValue = null;
  kvGuardValue = null;
}

/** Count review rows in the real D1 double. */
function reviewCount(db: ReturnType<typeof createTestD1>): number {
  const row = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
  return row.n;
}

describe("createReviewConsumer", () => {
  test("findByIdempotencyKey hit after clone → ack: no post, no insert, destroy", async () => {
    reset();
    const db = createTestD1();
    const store = createArtifactStore(db);
    await store.put({
      kind: "review",
      key: idemKey({ installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: SHA }),
      schema: "mstar.review/v1",
      payload: VALID_OUTPUT,
    });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

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
      },
      timeout: 600_000,
    });
    // Token minted once (shared for clone/diff); post happens BEFORE insert.
    expect(commenterCalls.filter((c) => c.op === "token")).toHaveLength(1);
    expect(commenterCalls.map((c) => c.op)).toEqual(["token", "post"]);
    expect(commenterCalls[1]!.args[0]).toMatchObject({
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: SHA,
      output: VALID_OUTPUT,
    });

    // The review row + findings landed in the real D1 double.
    expect(reviewCount(db)).toBe(1);
    const row = db.raw.query("SELECT * FROM reviews").get() as { head_sha: string; verdict: string };
    expect(row.head_sha).toBe(SHA);
    expect(row.verdict).toBe("needs fixes");
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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

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

  test("parse failure → no post, no insert, rethrow, destroy", async () => {
    reset();
    runnerStdout = "not json at all";
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/parse failed/);

    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  test("comment failure → no insert, rethrow, destroy", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    commentError = new Error("post failed");
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow("post failed");

    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  test("sandbox exec failure → rethrow, destroy", async () => {
    reset();
    sandboxError = new Error("container unavailable");
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow("container unavailable");
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  test("clone exitCode !== 0 → rethrow, destroy, no post/insert", async () => {
    reset();
    cloneExitCode = 128;
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/clone failed/);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  test("runner exitCode !== 0 → rethrow, destroy, no post/insert", async () => {
    reset();
    runnerExitCode = 1;
    runnerStderr = "review: session failed: boom";
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner failed/);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  test("runtime runner: exit 0 with a valid envelope succeeds regardless of stderr diagnostics (no mode marker gate)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    runnerStderr = "seat full-diff/combined done in 41s\nsynthesizeReview ok\n";
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // resolves — stderr is never a gate

    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(1);
    expect(reviewCount(db)).toBe(1);
    expect(destroyCalls).toBe(1);
  });

  test("numstat failure → no runner, no post, no insert, rethrow, destroy", async () => {
    reset();
    numstatExitCode = 1;
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/numstat failed/);

    expect(sandboxCalls.some((c) => c.cmd.includes("--input"))).toBe(false);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine?.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
  });

  test("runner input write failure → no runner, no post, no insert, rethrow, destroy", async () => {
    reset();
    writeInputExitCode = 1;
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/runner input write failed/);

    expect(sandboxCalls.some((c) => c.cmd.includes("--input"))).toBe(false);
    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  test("REVIEW_LEVEL unset → runner runs the harness landing tier 'default' (AC-S7-level)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerCall = sandboxCalls.find((c) => c.cmd.includes("--input"))!;
    expect(runnerCall.cmd).toContain("--level 'default'");
  });

  test("REVIEW_LEVEL=quick → runner runs `--level 'quick'` (AC-S7-level configurable)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, REVIEW_LEVEL: "quick" }),
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
    const db = createTestD1();
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, REVIEW_LEVEL: "deep" }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    const runnerCall = sandboxCalls.find((c) => c.cmd.includes("--input"))!;
    expect(runnerCall.cmd).toContain("--level 'deep'");
    expect(reviewCount(db)).toBe(1);
  });
  test("REVIEW_LEVEL=deep → runner exec timeout 1_800_000 + guard TTL 2520; quick/default stay 600_000 (AC-S10-clock)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, REVIEW_LEVEL: "deep" }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    // Deep runner budget: 30 min (the 10 min ceiling would false-timeout a
    // deep three-phase run into the DLQ — spec d5-budget Problem Statement).
    expect(runnerExecTimeout()).toBe(1_800_000);
    // The in-flight guard TTL follows the same level table (AC-S10-guard).
    expect(kvGuardPuts).toEqual([
      {
        key: "inflight:123:acme/widgets:42",
        value: "inflight",
        options: { expirationTtl: 2520 },
      },
    ]);
    // The quick/default 10-minute table is frozen (spec: 禁止把 quick 全局改成 30 min).
    expect(runnerTimeoutMs("quick")).toBe(600_000);
    expect(runnerTimeoutMs("default")).toBe(600_000);
    expect(runnerTimeoutMs("deep")).toBe(1_800_000);
  });

  test("invalid REVIEW_LEVEL (Object.prototype keys) → fail-loud BEFORE any sandbox step (never a silent downgrade)", async () => {
    // qc3 F-302: "toString"/"__proto__" would pass an `in`-style guard — only
    // REVIEW_LEVELS membership (isReviewLevel) rejects them at this first,
    // pre-sandbox guard. "deep" is NOT here: it is a legal tier since plan 09
    // T1 and is covered by the success test above.
    for (const level of ["toString", "constructor", "__proto__"]) {
      reset();
      const db = createTestD1();
      const consumer = createReviewConsumer(
        makeEnv({ DB: db as never, REVIEW_LEVEL: level }),
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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(reviewCount(db)).toBe(1);
    const row = db.raw.query("SELECT envelope FROM reviews").get() as { envelope: string };
    expect(JSON.parse(row.envelope).target).toEqual({ owner: "acme", repo: "widgets", pr: 42, head_sha: SHA });
  });

  test("failure logs a structured error with idempotency key + sandbox id before rethrow", async () => {
    reset();
    runnerStdout = "not json at all";
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/parse failed/);

    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
    expect(errLine!.fields.sandbox_id).toMatch(/^review-/);
    expect(errLine!.fields.head_sha).toBe(SHA);
    expect(errLine!.msg).toContain("parse failed");
  });

  test("empty actual sha from rev-parse → no post/insert, rethrow, destroy", async () => {
    reset();
    resolvedSha = "";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload())),
    ).rejects.toThrow(/cannot resolve head sha/);

    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine?.fields.sandbox_id).toMatch(/^review-/);
  });

  test("KV completion write failure → warn, still ack (D1 row is durable)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    kvPutError = new Error("kv down");
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

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
    const db = createTestD1();
    const failingStore = {
      put: mock(async () => {
        throw new Error("d1 down");
      }),
      get: mock(async () => undefined),
      findByIdempotencyKey: mock(async () => null),
    };
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never }),
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

  test("BB-1: OMP_REVIEW_MODEL set on PipelineEnv → forwarded into the runner exec env", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(
      makeEnv({
        DB: db as never,
        OMP_REVIEW_MODEL: "ark-plan/deepseek-v4-flash,openrouter/anthropic/claude-sonnet-4",
      }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    const runnerCall = sandboxCalls.find((c) => c.cmd.includes("bun run"))!;
    expect(runnerCall.opts).toEqual({
      cwd: "/workspace/repo",
      env: {
        ARK_API_KEY: "ark-key",
        HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
        PI_CODING_AGENT_DIR: "/opt/omp-agent",
        OMP_REVIEW_MODEL: "ark-plan/deepseek-v4-flash,openrouter/anthropic/claude-sonnet-4",
      },
      timeout: 600_000,
    });
  });

  test("BB-1: OMP_REVIEW_MODEL unset/empty → omitted from the runner exec env (in-image default)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, OMP_REVIEW_MODEL: "" }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    const runnerEnv = runnerExecEnv();
    expect(runnerEnv.OMP_REVIEW_MODEL).toBeUndefined();
    // And an entirely unset chain on makeEnv also stays absent.
    expect(Object.keys(runnerEnv).sort()).toEqual(
      ["ARK_API_KEY", "HARNESS_PLUGIN_ROOT", "PI_CODING_AGENT_DIR"].sort(),
    );
  });

  test("BB-2: known provider keys present-and-non-empty on PipelineEnv → forwarded into the runner exec env", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(
      makeEnv({
        DB: db as never,
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENROUTER_API_KEY: "sk-or-test",
        MISTRAL_API_KEY: "", // empty → not forwarded
      }),
      undefined,
      testOverrides,
    );

    await consumer(makeBatch(makePayload()));

    const runnerEnv = runnerExecEnv();
    expect(runnerEnv).toMatchObject({
      ARK_API_KEY: "ark-key",
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENROUTER_API_KEY: "sk-or-test",
    });
    expect(runnerEnv.MISTRAL_API_KEY).toBeUndefined();
  });

  test("BB-2: absent provider keys omitted; non-provider env is NEVER forwarded (allowlist)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    // A var that is NOT in the PROVIDERS allowlist sits on the Worker env —
    // it must never leak into the container.
    const env = makeEnv({ DB: db as never, GEMINI_API_KEY: "gem-test" }) as PipelineEnv & Record<string, string>;
    env.SOME_ARBITRARY_SECRET = "must-not-leak";
    const consumer = createReviewConsumer(env, testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerEnv = runnerExecEnv();
    expect(runnerEnv).toEqual({
      ARK_API_KEY: "ark-key",
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      GEMINI_API_KEY: "gem-test",
    });
    expect(Object.values(runnerEnv)).not.toContain("must-not-leak");
  });

  test("guard held on attempt 1 → per-message delayed retry (60s), no throw, no post/insert (BB-3)", async () => {
    reset();
    kvGuardValue = "inflight";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);
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
    const db = createTestD1();
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, REVIEW_LEVEL: "deep" }),
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
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

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
    runnerStdout = "not json at all";
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/parse failed/);

    // Only the guard-held path is handled with message-level retry/ack; a
    // real failure rethrows exactly as before.
    expect(messageRetryCalls).toHaveLength(0);
    expect(messageAckCalls).toHaveLength(0);
    expect(destroyCalls).toBe(1);
  });

  test("in-flight guard acquired before the pipeline and released after the post settles (WF-002)", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

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
    // KV/D1 puts) = 1320s quick/default, 2520s deep (spec d5-budget L4).
    // numstat + the input write were added by plan 07 without recomputing
    // the old 3-step formula (1020s) — any future step or ceiling change
    // must recompute this helper ON PURPOSE.
    expect(reviewGuardTtlSeconds("quick")).toBe(1320);
    expect(reviewGuardTtlSeconds("default")).toBe(1320);
    expect(reviewGuardTtlSeconds("deep")).toBe(2520);
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
