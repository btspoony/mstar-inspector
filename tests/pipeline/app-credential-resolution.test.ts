/**
 * Per-App credential resolution tests (plan 13 Task 2, architect lock L4).
 *
 * The consumer resolves the commenter from `payload.appRef` BEFORE the
 * in-flight guard / sandbox (fail fast, zero side effects on failure):
 *   - absent (old in-flight messages) or `{ kind: "legacy" }` → the env-App
 *     singleton, byte-identical legacy behavior;
 *   - `{ kind: "app", appId }` → D1 `github_apps` row (re-read per message:
 *     active, not soft-deleted) → PEM decrypted in memory (secretbox, AAD
 *     `github_apps.private_key_enc:<id>`) → `createAppCommenter(...)`
 *     cached per appId in a Map — token mint AND postReview come from the
 *     SAME per-App instance (Octokit construction stays in comment.ts).
 *
 * missing / disabled / soft-deleted / undecryptable / missing
 * DASHBOARD_ENCRYPTION_KEY → structured error log + rethrow (the existing
 * retry→DLQ semantics), ZERO GitHub writes. The per-App factory is a test
 * seam (ConsumerOverrides.createAppCommenter) asserting the EXACT
 * credentials each instance is built from — the real factory is
 * createReviewCommenter (the only createAppAuth construction point).
 *
 * Same technique as tests/pipeline/consumer.test.ts: sandbox + commenters
 * injected via createReviewConsumer overrides (no process-wide relative-path
 * mock.module); the @cloudflare/sandbox mock is a load shim only (the real
 * dist references the workerd builtin `cloudflare:workers`, unresolvable in
 * Bun's test runner).
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ReviewOutput } from "../../src/review/schema";
import { createTestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { CommenterEnv, ReviewCommenter } from "../../src/pipeline/comment";
import type { ConsumerLog, ConsumerLogFields, PipelineEnv } from "../../src/pipeline/consumer";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** Distinct fake App PEMs — isolation asserts the factory receives the right one. */
const PEM_X = "-----BEGIN PRIVATE KEY-----\nFAKE-APP-X-PEM\n-----END PRIVATE KEY-----\n";
const PEM_Y = "-----BEGIN PRIVATE KEY-----\nFAKE-APP-Y-PEM\n-----END PRIVATE KEY-----\n";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const VALID_OUTPUT: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "One issue found in the diff.",
  findings: [],
};

function createMigratedD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  for (const name of ["0004_github_apps.sql", "0005_reviews_app_id.sql"]) {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

type SeedOptions = {
  slug: string;
  githubAppId: number;
  /** Plaintext PEM to encrypt into the row (with the row-id AAD). */
  pem: string;
  /** Tamper anchor: encrypt the PEM under a WRONG row AAD. */
  wrongAad?: boolean;
};

/** Raw-insert an active, non-deleted github_apps row with a real PEM envelope. */
async function seedApp(db: ReturnType<typeof createTestD1>, opts: SeedOptions): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  const aad = opts.wrongAad ? `github_apps.private_key_enc:not-this-row` : `github_apps.private_key_enc:${id}`;
  const privateKeyEnc = await box.encryptSecret(opts.pem, aad);
  const webhookSecretEnc = await box.encryptSecret(`whsec-${opts.slug}`, `github_apps.webhook_secret_enc:${id}`);
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, opts.slug, opts.githubAppId, opts.slug, privateKeyEnc, webhookSecretEnc);
  return { id };
}

// --- sandbox fake (injected via createReviewConsumer overrides) -------------

const sandboxCalls: Array<{ cmd: string; opts?: unknown }> = [];

const fakeSandbox = {
  exec: mock(async (cmd: string, opts?: unknown) => {
    sandboxCalls.push({ cmd, opts });
    if (cmd.includes("rev-parse")) {
      return { stdout: `${SHA}\n`, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("--input")) {
      return { stdout: JSON.stringify(VALID_OUTPUT), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }),
  destroy: mock(async () => {}),
};

// Load-shim only: consumer.ts statically imports ./sandbox → @cloudflare/sandbox,
// whose real dist references the workerd builtin `cloudflare:workers`
// (unresolvable in Bun's test runner). Every test injects the fake via
// createReviewConsumer overrides — this mock is never called.
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: mock(async () => {
    throw new Error("unexpected: resolution tests inject getSandbox via overrides");
  }),
  Sandbox: class Sandbox {},
}));

// --- commenter fakes --------------------------------------------------------

type CommenterCall = { op: "token" | "post"; installationId?: number };
/** Calls grouped by instance — same-instance assertions key off this. */
const legacyCalls: CommenterCall[] = [];
const appCalls: Array<{ instance: number; call: CommenterCall }> = [];
/** Credential each factory invocation built an instance from. */
const factoryCreds: Array<{ instance: number; cred: CommenterEnv }> = [];
let factoryInstanceSeq = 0;

const legacyCommenter: ReviewCommenter = {
  getInstallationToken: mock(async (installationId: number) => {
    legacyCalls.push({ op: "token", installationId });
    return "legacy-token";
  }),
  postReview: mock(async () => {
    legacyCalls.push({ op: "post" });
  }),
};

/** The test seam: records the EXACT credentials each App instance gets. */
const appCommenterFactory = mock((cred: CommenterEnv): ReviewCommenter => {
  const instance = ++factoryInstanceSeq;
  factoryCreds.push({ instance, cred });
  return {
    getInstallationToken: mock(async (installationId: number) => {
      appCalls.push({ instance, call: { op: "token", installationId } });
      return `app-${instance}-token`;
    }),
    postReview: mock(async () => {
      appCalls.push({ instance, call: { op: "post" } });
    }),
  };
});

const testOverrides = {
  commenter: legacyCommenter,
  createAppCommenter: appCommenterFactory,
  getSandbox: async () => fakeSandbox,
};

// --- consumer under test (dynamic import: mocks must be registered first) ---

const { createReviewConsumer } = await import("../../src/pipeline/consumer");

// --- test log sink ----------------------------------------------------------

const logLines: Array<{ level: "info" | "warn" | "error"; fields: ConsumerLogFields; msg: string }> = [];
const testLog: ConsumerLog = {
  info: (fields, msg) => logLines.push({ level: "info", fields, msg: msg ?? "" }),
  warn: (fields, msg) => logLines.push({ level: "warn", fields, msg: msg ?? "" }),
  error: (fields, msg) => logLines.push({ level: "error", fields, msg: msg ?? "" }),
};

// --- helpers ----------------------------------------------------------------

const kvPuts: Array<{ key: string; value: string }> = [];
const kvGuardPuts: string[] = [];
const kv = {
  get: mock(async () => null),
  put: mock(async (key: string, value: string) => {
    if (key.startsWith("inflight:")) kvGuardPuts.push(key);
    else kvPuts.push({ key, value });
  }),
  delete: mock(async () => {}),
};

function makeEnv(overrides: Partial<PipelineEnv> = {}): PipelineEnv {
  return {
    APP_ID: "999",
    PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nlegacy\n-----END PRIVATE KEY-----\n",
    OMP_MODEL_KEY: "ark-key",
    DB: createTestD1() as never,
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
    ...overrides,
  };
}

function makeBatch(...bodies: ReviewJobPayload[]): MessageBatch<ReviewJobPayload> {
  return {
    queue: "review-queue",
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts: 1,
      body,
      retry: () => {},
      ack: () => {},
    })),
  } as unknown as MessageBatch<ReviewJobPayload>;
}

function reset(): void {
  sandboxCalls.length = 0;
  legacyCalls.length = 0;
  appCalls.length = 0;
  factoryCreds.length = 0;
  factoryInstanceSeq = 0;
  kvPuts.length = 0;
  kvGuardPuts.length = 0;
  logLines.length = 0;
}

describe("consumer appRef resolution (plan 13 Task 2, lock L4)", () => {
  test("appRef absent (old in-flight message) → legacy env commenter, no App resolution", async () => {
    reset();
    const db = createMigratedD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload())); // no appRef field at all

    expect(legacyCalls.map((c) => c.op)).toEqual(["token", "post"]);
    expect(factoryCreds).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(kvPuts).toEqual([{ key: `idem:123:acme/widgets:42:${SHA}`, value: "done" }]);
  });

  test("appRef {kind:'legacy'} → legacy env commenter", async () => {
    reset();
    const db = createMigratedD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { kind: "legacy" } })));

    expect(legacyCalls.map((c) => c.op)).toEqual(["token", "post"]);
    expect(factoryCreds).toHaveLength(0);
  });

  test("appRef {kind:'app'} → authenticates with THAT App's decrypted PEM (sibling isolation)", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await seedApp(db, { slug: "app-y", githubAppId: 333444, pem: PEM_Y }); // sibling, never used
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    // Exactly one App instance, built from X's DECRYPTED PEM + X's github_app_id.
    expect(factoryCreds).toHaveLength(1);
    expect(factoryCreds[0]!.cred).toEqual({ APP_ID: "111222", PRIVATE_KEY: PEM_X });
    // Token mint + postReview both on that same instance; legacy untouched.
    expect(appCalls.map((c) => c.call.op)).toEqual(["token", "post"]);
    expect(appCalls[0]!.instance).toBe(factoryCreds[0]!.instance);
    expect(appCalls[1]!.instance).toBe(factoryCreds[0]!.instance);
    expect(appCalls[0]!.call.installationId).toBe(123);
    expect(legacyCalls).toHaveLength(0);
    expect(kvPuts).toEqual([{ key: `idem:123:acme/widgets:42:${SHA}`, value: "done" }]);
    // Every structured log line carries the appId reference (never a credential).
    const errOrInfo = logLines.filter((l) => l.fields.app_id !== undefined);
    expect(errOrInfo.length).toBeGreaterThan(0);
    expect(errOrInfo.every((l) => l.fields.app_id === appX.id)).toBe(true);
  });

  test("two messages for the same App in one batch → ONE instance (per-appId cache), both served by it", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, appRef: { kind: "app", appId: appX.id } }),
        makePayload({ pr_number: 43, appRef: { kind: "app", appId: appX.id } }),
      ),
    );

    expect(factoryCreds).toHaveLength(1); // cache hit on the second message
    expect(appCalls).toHaveLength(4); // token+post × 2 messages, same instance
    expect(new Set(appCalls.map((c) => c.instance))).toEqual(new Set([factoryCreds[0]!.instance]));
    expect(legacyCalls).toHaveLength(0);
  });

  test("disabled-app mid-flight → structured failure, rethrow (retry/DLQ), ZERO GitHub writes, guard untouched", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await createAppsStore(db).setAppStatus(appX.id, "disabled");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })))).rejects.toThrow(
      /per-App credential resolution failed: app .* is disabled/,
    );

    expect(legacyCalls).toHaveLength(0);
    expect(factoryCreds).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0); // fails before any sandbox step
    expect(kvGuardPuts).toHaveLength(0); // the in-flight guard is never taken
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App credential resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
  });

  test("soft-deleted app → structured failure, zero GitHub writes", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await createAppsStore(db).softDeleteApp(appX.id);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })))).rejects.toThrow(
      /per-App credential resolution failed: app .* is soft-deleted/,
    );

    expect(factoryCreds).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("unknown appId → structured failure, zero GitHub writes", async () => {
    reset();
    const db = createMigratedD1();
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: "no-such-app" } }))),
    ).rejects.toThrow(/per-App credential resolution failed: app no-such-app not found/);

    expect(factoryCreds).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("tampered PEM envelope (wrong AAD) → decrypt failure, zero GitHub writes", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X, wrongAad: true });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })))).rejects.toThrow(
      /secretbox: decrypt failed/,
    );

    expect(factoryCreds).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("DASHBOARD_ENCRYPTION_KEY missing → per-App fails closed (SecretboxKeyError); legacy path unaffected", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, DASHBOARD_ENCRYPTION_KEY: undefined }),
      testLog,
      testOverrides,
    );

    await expect(consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })))).rejects.toThrow(
      /DASHBOARD_ENCRYPTION_KEY is not set/,
    );

    expect(factoryCreds).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);

    // The legacy path on the SAME consumer env is unaffected (regression).
    reset();
    await consumer(makeBatch(makePayload()));
    expect(legacyCalls.map((c) => c.op)).toEqual(["token", "post"]);
    expect(factoryCreds).toHaveLength(0);
  });

  test("L4 same-instance pin: token mint and postReview come from the ONE per-App instance per message", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    // One factory invocation per message (cache hit would skip it), and the
    // message's token + post both hit the instance the factory returned.
    expect(factoryCreds).toHaveLength(1);
    const instance = factoryCreds[0]!.instance;
    expect(appCalls.map((c) => c.instance)).toEqual([instance, instance]);
    expect(appCalls.map((c) => c.call.op)).toEqual(["token", "post"]);
  });
});
