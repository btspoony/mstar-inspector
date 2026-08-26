/**
 * Consumer tests (plan 06 Task 3) — full-mock flow. The sandbox adapter and
 * the commenter are injected via createReviewConsumer's overrides (DI — no
 * process-wide mock.module on relative module paths, which leaks across test
 * files sharing a worker on CI, run 32946710695); the review store is the REAL
 * store over the bun:sqlite D1 double (tests/store/helpers.ts) so the
 * consumer's store wiring is exercised for real. gitops command construction
 * and parseReviewOutput stay real.
 *
 * Acceptance points (plan Task 3 / brief):
 *   - findByIdempotencyKey hit → ack (no sandbox, no post, no insert)
 *   - full flow: clone → diff → runner (env-injected secrets) → parse →
 *     post FIRST → insert → KV completion → destroy
 *   - null payload sha → gh pr view resolves it before dedup
 *   - parse failure → no post, no insert, rethrow, destroy
 *   - comment failure → no insert, rethrow, destroy
 *   - finally destroy on every path
 */

import { describe, expect, mock, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ReviewOutput } from "../../src/review/schema";
import { createReviewStore } from "../../src/store/reviews";
import { createTestD1 } from "../store/helpers";
import type { ReviewCommenter } from "../../src/pipeline/comment";

const VALID_OUTPUT: ReviewOutput = {
  verdict: "request_changes",
  summary_md: "Two issues found in the diff.",
  findings: [
    {
      severity: "warning",
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
let sandboxError: Error | undefined;
let destroyCalls = 0;
let destroyError: Error | undefined;

let runnerStderr = "review mode: structured\n";
let runnerExitCode = 0;
let cloneExitCode = 0;
let diffExitCode = 0;

const fakeSandbox = {
  exec: mock(async (cmd: string, opts?: unknown) => {
    sandboxCalls.push({ cmd, opts });
    if (sandboxError) throw sandboxError;
    if (cmd.includes("gh pr view")) return { stdout: `${resolvedSha}\n`, stderr: "", exitCode: 0 };
    if (cmd.includes("git init")) return { stdout: "", stderr: "", exitCode: cloneExitCode };
    if (cmd.includes("gh pr diff")) return { stdout: "", stderr: "", exitCode: diffExitCode };
    if (cmd.includes("--diff")) {
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

// --- consumer under test (dynamic import: mocks must be registered first) ---
const { createReviewConsumer } = await import("../../src/pipeline/consumer");
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
let kvPutError: Error | undefined;
const kv = {
  put: mock(async (key: string, value: string, options?: unknown) => {
    kvPuts.push({ key, value, options });
    if (kvPutError) throw kvPutError;
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
        attempts: 1,
        body: payload,
        retry() {},
        ack() {},
      },
    ],
  } as unknown as MessageBatch<ReviewJobPayload>;
}

function reset(): void {
  sandboxCalls.length = 0;
  commenterCalls.length = 0;
  kvPuts.length = 0;
  logLines.length = 0;
  runnerStdout = "";
  runnerStderr = "review mode: structured\n";
  runnerExitCode = 0;
  cloneExitCode = 0;
  diffExitCode = 0;
  resolvedSha = SHA;
  sandboxError = undefined;
  destroyCalls = 0;
  destroyError = undefined;
  tokenResult = "ghs_installation_token";
  commentError = undefined;
  kvPutError = undefined;
}

/** Count review rows in the real D1 double. */
function reviewCount(db: ReturnType<typeof createTestD1>): number {
  const row = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
  return row.n;
}

describe("createReviewConsumer", () => {
  test("findByIdempotencyKey hit → ack: no sandbox, no post, no insert", async () => {
    reset();
    const db = createTestD1();
    const store = createReviewStore(db);
    await store.insertReview({
      key: { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: SHA },
      output: VALID_OUTPUT,
      raw: JSON.stringify(VALID_OUTPUT),
    });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(sandboxCalls).toHaveLength(0);
    expect(commenterCalls).toHaveLength(0);
    expect(kvPuts).toHaveLength(0);
    expect(destroyCalls).toBe(0);
    expect(reviewCount(db)).toBe(1); // untouched
  });

  test("full flow: clone → diff → runner → parse → post → insert → KV done → destroy", async () => {
    reset();
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload()));

    expect(sandboxCalls.map((c) => c.cmd)).toEqual([
      expect.stringContaining("git init '/workspace/repo'"),
      expect.stringContaining("gh pr diff '42' --repo 'acme/widgets'"),
      expect.stringContaining("bun run '/opt/runner/src/review/runner.ts' --diff '/workspace/pr.diff'"),
    ]);
    expect(sandboxCalls[0]!.opts).toEqual({ env: { GH_TOKEN: "ghs_installation_token" }, timeout: 120_000 });
    expect(sandboxCalls[1]!.opts).toEqual({ env: { GH_TOKEN: "ghs_installation_token" }, timeout: 120_000 });
    // Runner: cwd = clone dir; model key + harness paths via exec env only.
    expect(sandboxCalls[2]!.opts).toEqual({
      cwd: "/workspace/repo",
      env: {
        ARK_API_KEY: "ark-key",
        M0_HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
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
    expect(row.verdict).toBe("request_changes");
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

  test("null payload sha → gh pr view resolves it before dedup", async () => {
    reset();
    resolvedSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), undefined, testOverrides);

    await consumer(makeBatch(makePayload({ head_sha: null, triggered_by: "review_command" })));

    expect(sandboxCalls[0]!.cmd).toBe(
      "gh pr view '42' --repo 'acme/widgets' --json headRefOid --jq .headRefOid",
    );
    expect(sandboxCalls[0]!.opts).toEqual({ env: { GH_TOKEN: "ghs_installation_token" }, timeout: 120_000 });
    const row = db.raw.query("SELECT * FROM reviews").get() as { head_sha: string };
    expect(row.head_sha).toBe("abcdefabcdefabcdefabcdefabcdefabcdefabcd");
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

  test("summary degrade (non-structured) → no post, no insert, rethrow, destroy", async () => {
    reset();
    runnerStdout = JSON.stringify({
      verdict: "comment",
      summary_md: "raw model text that could not be parsed",
      findings: [],
    });
    runnerStderr = "review mode: summary\n";
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload()))).rejects.toThrow(/structured mode marker/);

    expect(commenterCalls.filter((c) => c.op === "post")).toHaveLength(0);
    expect(reviewCount(db)).toBe(0);
    expect(destroyCalls).toBe(1);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine?.fields.idempotency_key).toBe(`idem:123:acme/widgets:42:${SHA}`);
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

  test("empty sha after gh pr view → no post/insert, rethrow, destroy", async () => {
    reset();
    resolvedSha = "";
    runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = createTestD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ head_sha: null, triggered_by: "review_command" }))),
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
    const warnLine = logLines.find((l) => l.level === "warn" && l.msg.includes("KV"));
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
});
