/**
 * Per-App runner-env assembly tests (plan 14 Task 3, spec § Per-App BYOK).
 *
 * The consumer resolves the App's AI config (`getAppConfig` decrypt face, ONE
 * read per message) off the SAME appRef resolution as the commenter and feeds
 * it into `buildRunnerEnv(appCfg, log, fields)` at the runner exec step:
 *   - the App's OWN keys are injected under the PROVIDERS-mapped env name
 *     (empty/whitespace keys and unknown provider ids never inject); the
 *     `ark` entry maps the in-image ark-plan base provider's ARK_API_KEY, so
 *     that key rides the same per-App keys map (AL-24-5);
 *   - an App model chain becomes the runner's OMP_REVIEW_MODEL verbatim;
 *     null/""/whitespace-only = unset → the App's reviews FAIL CLOSED
 *     (assertAppConfigComplete — no deployment-level chain exists);
 *   - every injected key logs `key_source: app|custom` (the source, never
 *     the key) and the assembly logs `config_source: "app"` (the only
 *     remaining source — the "global"/"fallback" variants were retired with
 *     plan 24 Task 6 / AL-24-5);
 *   - the assembly builds a FRESH env object per review (no shared mutable
 *     env) — cross-App leakage is structurally impossible (full-object pins);
 *   - an UNREADABLE App key (tampered envelope / missing master key) fails
 *     closed BEFORE guard/sandbox; a MISSING model chain / chain provider
 *     key fails closed right after App resolution through the F-001
 *     structured channel (review failed log + review_failures
 *     stage="pipeline" row + rethrow → retry×3 → DLQ) — zero side effects
 *     (no sandbox, no guard, no GitHub write).
 *
 * Runner-input threading (plan 17 Task 1): the consumer resolves the App's
 * per-role selector map (decrypt-free `getAppModelRoles`) into the runner
 * input JSON's OPTIONAL `modelOverrides` field; empty maps omit the field
 * entirely (byte-identical payload). The runner-side guard/type extension
 * is plan 17 Task 2's.
 *
 * Same technique as tests/pipeline/consumer.test.ts: sandbox + commenters
 * injected via createReviewConsumer overrides (no process-wide relative-path
 * mock.module); the @cloudflare/sandbox mock is a load shim only. Config is
 * seeded through the REAL createAppConfigStore over the fully-migrated bun:sqlite
 * D1 double, so the decrypt path is exercised for real.
 */

import { describe, expect, mock, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ReviewOutput } from "../../src/review/schema";
import { createMigratedTestD1 } from "../store/helpers";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { CommenterEnv, ReviewCommenter } from "../../src/pipeline/comment";
import type { ConsumerLog, ConsumerLogFields, PipelineEnv } from "../../src/pipeline/consumer";

/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");
const PEM_X = "-----BEGIN PRIVATE KEY-----\nFAKE-APP-X-PEM\n-----END PRIVATE KEY-----\n";
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** The seeded `ark` BYOK key — ARK_API_KEY for the in-image ark-plan provider (AL-24-5). */
const ARK_KEY = "ark-key";

const VALID_OUTPUT: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "One issue found in the diff.",
  findings: [],
};

// --- seeding helpers ---------------------------------------------------------

/** Distinct github_app_id per seeded App (github_apps.github_app_id is UNIQUE). */
let githubAppIdSeq = 100000;

/**
 * Raw-insert an active, non-deleted github_apps row (the commenter face).
 * `configured: false` skips the AI-config health baseline (a chain + the ark
 * BYOK key) — the input for the AL-24-5 fail-closed tests.
 */
async function seedApp(
  db: ReturnType<typeof createMigratedTestD1>,
  slug: string,
  opts: { configured?: boolean } = {},
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const githubAppId = ++githubAppIdSeq;
  const box = createSecretbox(TEST_KEY);
  const privateKeyEnc = await box.encryptSecret(PEM_X, `github_apps.private_key_enc:${id}`);
  const webhookSecretEnc = await box.encryptSecret(`whsec-${slug}`, `github_apps.webhook_secret_enc:${id}`);
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, slug, githubAppId, slug, privateKeyEnc, webhookSecretEnc);
  if (opts.configured !== false) {
    await configureApp(db, id);
  }
  return { id };
}

/**
 * Seed the per-App AI-config health baseline (AL-24-5): a model chain
 * (`ark-plan/deepseek-v4-flash` — the in-image base provider) plus the `ark`
 * BYOK key (ARK_API_KEY) its chain needs. `extraKeys` adds more per-App keys
 * (e.g. a chain that also references openai/anthropic). Uses the REAL store
 * so encrypt/decrypt exercise the composite-PK AAD path.
 */
async function configureApp(
  db: ReturnType<typeof createMigratedTestD1>,
  appId: string,
  chain = "ark-plan/deepseek-v4-flash",
  extraKeys: Record<string, string> = {},
): Promise<void> {
  const store = createAppConfigStore(db, TEST_KEY);
  await store.setModelChain(appId, chain);
  await store.setProviderKey(appId, "ark", ARK_KEY);
  for (const [provider, key] of Object.entries(extraKeys)) {
    await store.setProviderKey(appId, provider, key);
  }
}

/**
 * Raw-insert a provider key row whose envelope is bound to the WRONG AAD —
 * the fail-closed tamper anchor (the decrypt must throw, never fall back).
 */
async function seedTamperedKey(
  db: ReturnType<typeof createMigratedTestD1>,
  appId: string,
  provider: string,
): Promise<void> {
  const keyEnc = await createSecretbox(TEST_KEY).encryptSecret(
    "sk-tampered-SECRET",
    "app_provider_keys.key_enc:not-this-row",
  );
  db.raw
    .prepare(
      `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(appId, provider, keyEnc);
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
// whose real dist references the workerd builtin `cloudflare:workers`,
// unresolvable in Bun's test runner. Every test injects the fake via
// createReviewConsumer overrides — this mock is never called.
mock.module("@cloudflare/sandbox", () => ({
  getSandbox: mock(async () => {
    throw new Error("unexpected: assembly tests inject getSandbox via overrides");
  }),
  Sandbox: class Sandbox {},
}));

// --- commenter fakes (app-path messages construct via the factory seam) -----

const appCalls: string[] = [];

const appCommenterFactory = mock((_cred: CommenterEnv): ReviewCommenter => ({
  getInstallationToken: mock(async () => {
    appCalls.push("token");
    return "app-token";
  }),
  postReview: mock(async () => {
    appCalls.push("post");
    return 1;
  }),
  postDegraded: mock(async () => {
    appCalls.push("degrade");
  }),
  // Bugbot degraded-comment lifecycle: the success path runs the delete
  // scan (no stale comment → the real implementation finds nothing); the
  // double is a no-op outcome so the flow exercises the real call.
  deleteDegradedComment: mock(async () => ({ deleted: 0, skipped: 0, errors: [] })),
  // Plan 18 T3 line comments: VALID_OUTPUT has no findings → never called.
  fetchPrDiff: mock(async () => {
    throw new Error("unexpected: no qualifying findings → no diff prefetch");
  }),
  postLineComments: mock(async () => {
    throw new Error("unexpected: no qualifying findings → no line comments");
  }),
}));

const testOverrides = {
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

const kvGuardPuts: string[] = [];
const kv = {
  get: mock(async () => null),
  put: mock(async (key: string, _value: string) => {
    if (key.startsWith("inflight:")) kvGuardPuts.push(key);
  }),
  delete: mock(async () => {}),
};

function makeEnv(overrides: Partial<PipelineEnv> = {}): PipelineEnv {
  return {
    DB: createMigratedTestD1() as never,
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
    // Required single shape (plan 24 Task 1) — every test overrides it with
    // a seeded App id; the default is type-only (never resolved).
    appRef: { appId: "00000000-0000-0000-0000-000000000000" },
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
  appCalls.length = 0;
  kvGuardPuts.length = 0;
  logLines.length = 0;
}

/** The runner exec call's env, in message order (one entry per runner step). */
function runnerEnvs(): Array<Record<string, string>> {
  return sandboxCalls
    .filter((c) => c.cmd.includes("bun run"))
    .map((c) => (c.opts as { env?: Record<string, string> }).env ?? {});
}

/**
 * The DECODED runner input JSON payloads, in write order (one per
 * `printf … | base64 -d > '/workspace/review-input.json'` step — the runner
 * exec command references the same path but carries no base64 payload).
 */
function runnerInputs(): Array<Record<string, unknown>> {
  return sandboxCalls
    .filter((c) => c.cmd.includes("base64 -d > '/workspace/review-input.json'"))
    .map((c) => {
      const payload = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(c.cmd)?.[1];
      if (!payload) throw new Error(`runner-input write command without a base64 payload: ${c.cmd}`);
      return JSON.parse(atob(payload)) as Record<string, unknown>;
    });
}

/** The assembly log lines (key_source per injected key + config_source summary). */
function keySourceLines(): Array<{ fields: ConsumerLogFields; msg: string }> {
  return logLines.filter((l) => l.fields.key_source !== undefined);
}

describe("per-App runner env assembly (plan 14 Task 3, spec § Per-App BYOK)", () => {
  test("app-key: the App's own keys inject under their PROVIDERS env names (per-App BYOK, incl. ark → ARK_API_KEY)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", {
      anthropic: "sk-app-x-SECRET",
      openai: "sk-app-x-openai-SECRET",
    });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    const env = runnerEnvs()[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-app-x-SECRET");
    expect(env.OPENAI_API_KEY).toBe("sk-app-x-openai-SECRET");
    expect(env.ARK_API_KEY).toBe(ARK_KEY); // the ark BYOK key rides the same keys map
    expect(env.OMP_REVIEW_MODEL).toBe("openai/gpt-app,anthropic/claude-app");
    // No global surface: a provider the App never configured stays absent.
    expect(env.MISTRAL_API_KEY).toBeUndefined();
    // key_source: app for every injected key; config_source: the only source left.
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ anthropic: "app", openai: "app", ark: "app" });
    const cfgLine = logLines.find((l) => l.fields.config_source !== undefined);
    expect(cfgLine?.fields.config_source).toBe("app");
    expect(appCalls).toEqual(["token", "post"]);
  });

  test("chain provider without a configured key → fail closed after App resolution, no global fallback (AL-24-5)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // The chain references anthropic, but the App stores ONLY the ark key.
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // The chain's FIRST selector (`openai/gpt-app`) is missing its key in
    // the App's config — the gate throws on the first key-less provider.
    await expect(
      consumer(makeBatch(makePayload({ appRef: { appId: appX.id } }))),
    ).rejects.toThrow(/per-App config incomplete: app .*provider openai has no configured key/);

    expect(sandboxCalls).toHaveLength(0); // no clone, no runner
    expect(kvGuardPuts).toHaveLength(0); // the in-flight guard is never taken
    expect(appCalls).toHaveLength(0); // zero GitHub writes
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App config incomplete");
    expect(errLine!.fields.app_id).toBe(appX.id);
    // F-001 channel: the review_failures row records stage=pipeline.
    const rows = db.raw.query("SELECT stage, error FROM review_failures").all() as Array<{ stage: string; error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("pipeline");
    expect(rows[0]!.error).toContain("provider openai has no configured key");
  });

  test("mixed per-App keys: every configured provider injects; unconfigured providers stay absent", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", {
      anthropic: "sk-app-x-SECRET",
      openai: "sk-app-x-openai-SECRET",
    });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    const env = runnerEnvs()[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-app-x-SECRET");
    expect(env.OPENAI_API_KEY).toBe("sk-app-x-openai-SECRET");
    expect(env.ARK_API_KEY).toBe(ARK_KEY);
    expect(env.GROQ_API_KEY).toBeUndefined(); // not configured → no env key at all
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ anthropic: "app", openai: "app", ark: "app" });
    const cfgLine = logLines.find((l) => l.fields.config_source !== undefined);
    expect(cfgLine?.fields.config_source).toBe("app");
  });

  test("App with no AI config at all → fail closed: missing model chain (zero-config is not a valid review state)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x", { configured: false }); // github_apps row, NO config rows
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ appRef: { appId: appX.id } }))),
    ).rejects.toThrow(/per-App config incomplete: app .*missing model chain/);

    expect(sandboxCalls).toHaveLength(0); // no clone, no runner
    expect(kvGuardPuts).toHaveLength(0); // the in-flight guard is never taken
    expect(appCalls).toHaveLength(0); // zero GitHub writes
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App config incomplete");
    expect(errLine!.fields.app_id).toBe(appX.id);
    // F-001 channel: the review_failures row records stage=pipeline.
    const rows = db.raw.query("SELECT stage, error FROM review_failures").all() as Array<{ stage: string; error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("pipeline");
    expect(rows[0]!.error).toContain("missing model chain");
  });

  test("model chain: the App's chain forwards verbatim; an App with no chain fails closed (no global chain)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", {
      openai: "sk-x-openai",
      anthropic: "sk-x-anthropic",
    });
    const appY = await seedApp(db, "app-y", { configured: false });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // The batch processes messages in order: X's review completes, then Y's
    // missing chain throws and the rethrow stops the batch (F-001 design).
    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 42, appRef: { appId: appX.id } }),
          makePayload({ pr_number: 43, appRef: { appId: appY.id } }),
        ),
      ),
    ).rejects.toThrow(/per-App config incomplete: app .*missing model chain/);

    // X completed with its OWN chain; Y failed closed (no chain row).
    const xEnv = runnerEnvs()[0]!;
    expect(xEnv.OMP_REVIEW_MODEL).toBe("openai/gpt-app,anthropic/claude-app");
    const cfgLines = logLines.filter((l) => l.fields.config_source !== undefined);
    expect(cfgLines[0]?.fields.config_source).toBe("app");
    expect(appCalls).toEqual(["token", "post"]); // only X reviewed
    const rows = db.raw.query("SELECT model FROM reviews").all() as Array<{ model: string | null }>;
    expect(rows).toEqual([{ model: "openai/gpt-app" }]);
    const failRows = db.raw.query("SELECT error FROM review_failures").all() as Array<{ error: string }>;
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.error).toContain("missing model chain");
  });

  test("blank chain via direct-DB write fails closed; a padded real chain forwards VERBATIM (plan 15 trim guard)", async () => {
    reset();
    const db = createMigratedTestD1();
    // Unconfigured seeds: app_model_config is a singleton row per app, so
    // the raw direct-DB chain writes below must be the ONLY config rows.
    const appX = await seedApp(db, "app-x", { configured: false });
    const appY = await seedApp(db, "app-y", { configured: false });
    // Bypass the store (the plan-15 threat model: a direct DB write can hold a
    // blank chain the routes would have normalized away) — the raw rows pin
    // the fail-closed + verbatim guards independent of store semantics.
    db.raw
      .prepare(
        `INSERT INTO app_model_config (app_id, model_chain, updated_at)
         VALUES (?, '   ', datetime('now'))`,
      )
      .run(appX.id);
    const padded = "  openai/gpt-padded , anthropic/claude-padded  ";
    db.raw
      .prepare(
        `INSERT INTO app_model_config (app_id, model_chain, updated_at)
         VALUES (?, ?, datetime('now'))`,
      )
      .run(appY.id, padded);
    // Y's padded chain references openai/anthropic — provide their keys so
    // the fail-closed gate passes; X's whitespace-only chain = missing.
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setProviderKey(appY.id, "ark", ARK_KEY);
    await store.setProviderKey(appY.id, "openai", "sk-y-o");
    await store.setProviderKey(appY.id, "anthropic", "sk-y-a");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // Y (padded real chain) FIRST so its review completes; X's blank chain
    // then throws and the rethrow stops the batch (F-001 design).
    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 43, appRef: { appId: appY.id } }),
          makePayload({ pr_number: 42, appRef: { appId: appX.id } }),
        ),
      ),
    ).rejects.toThrow(/per-App config incomplete: app .*missing model chain/);

    const yEnv = runnerEnvs()[0]!;
    // A padded chain WITH content is configuration — forwarded exactly as
    // stored (the guard only decides unset-vs-set; it never mutates the value;
    // the runner-side selector parse trims segments).
    expect(yEnv.OMP_REVIEW_MODEL).toBe(padded);
    expect(yEnv.OPENAI_API_KEY).toBe("sk-y-o");
    const cfgLines = logLines.filter((l) => l.fields.config_source !== undefined);
    expect(cfgLines[0]?.fields.config_source).toBe("app");
    // X failed closed; Y's success row records Y's chain head.
    const failRows = db.raw.query("SELECT error FROM review_failures").all() as Array<{ error: string }>;
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.error).toContain("missing model chain");
    const rows = db.raw.query("SELECT pr_number, model FROM reviews ORDER BY pr_number").all() as Array<{
      pr_number: number;
      model: string | null;
    }>;
    expect(rows).toEqual([{ pr_number: 43, model: "openai/gpt-padded" }]);
  });

  test("version records (plan 18 Task 1): reviews.model = the App chain's head selector; provider always NULL", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const appY = await seedApp(db, "app-y");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", { openai: "sk-x-o", anthropic: "sk-x-a" });
    await configureApp(db, appY.id, "ark-plan/deepseek-v4-flash,groq/backup", { groq: "sk-y-g" });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, appRef: { appId: appX.id } }),
        makePayload({ pr_number: 43, appRef: { appId: appY.id } }),
      ),
    );

    const rows = db.raw
      .query("SELECT pr_number, model, provider FROM reviews ORDER BY pr_number")
      .all() as Array<{ pr_number: number; model: string | null; provider: string | null }>;
    expect(rows).toEqual([
      // The App's own chain wins — its HEAD selector is recorded (AL-2).
      { pr_number: 42, model: "openai/gpt-app", provider: null },
      { pr_number: 43, model: "ark-plan/deepseek-v4-flash", provider: null },
    ]);
  });

  test("version records: a chain-less App never writes a review — fail closed, no NULL-model row (AL-24-5)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x", { configured: false });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })))).rejects.toThrow(
      /per-App config incomplete: app .*missing model chain/,
    );
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(0);
  });

  test("cross-App isolation: App X's env never contains App Y's key names or values (full env object)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const appY = await seedApp(db, "app-y");
    await configureApp(db, appX.id, "openai/gpt-app", { openai: "sk-x-openai-SECRET" });
    await configureApp(db, appY.id, "anthropic/claude-app", { anthropic: "sk-y-anthropic-SECRET" });
    // NO global provider keys: any key in the env must come from the App row.
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // X → Y → X: identical X envs prove the assembly is a fresh object per
    // review with no shared mutable state between messages.
    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, appRef: { appId: appX.id } }),
        makePayload({ pr_number: 43, appRef: { appId: appY.id } }),
        makePayload({ pr_number: 44, appRef: { appId: appX.id } }),
      ),
    );

    const [xEnv, yEnv, xEnvAgain] = runnerEnvs() as [Record<string, string>, Record<string, string>, Record<string, string>];
    expect(xEnv).toEqual({
      ARK_API_KEY: ARK_KEY,
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      OPENAI_API_KEY: "sk-x-openai-SECRET",
      OMP_REVIEW_MODEL: "openai/gpt-app",
    });
    expect(yEnv).toEqual({
      ARK_API_KEY: ARK_KEY,
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      ANTHROPIC_API_KEY: "sk-y-anthropic-SECRET",
      OMP_REVIEW_MODEL: "anthropic/claude-app",
    });
    expect(xEnvAgain).toEqual(xEnv);
    // Belt and braces: neither env's values contain the other App's key.
    expect(Object.values(xEnv)).not.toContain("sk-y-anthropic-SECRET");
    expect(Object.values(yEnv)).not.toContain("sk-x-openai-SECRET");
  });

  test("secrets never logged: key_source/config_source lines carry ids only, never key material", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app", { openai: "sk-app-x-openai-SECRET" });
    const secrets = ["sk-app-x-openai-SECRET", ARK_KEY, "sk-tampered-SECRET"];
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    // The assembly lines EXIST (the assertion is not vacuous)…
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ openai: "app", ark: "app" });
    expect(logLines.some((l) => l.fields.config_source !== undefined)).toBe(true);
    // …and NO log line — assembly, runner, post, anything — carries key material.
    for (const line of logLines) {
      const serialized = JSON.stringify(line);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  test("undecryptable App key → fail closed BEFORE guard/sandbox (no global fallback exists)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await seedTamperedKey(db, appX.id, "anthropic");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ appRef: { appId: appX.id } }))),
    ).rejects.toThrow(/per-App config resolution failed/);

    expect(sandboxCalls).toHaveLength(0); // no clone, no runner
    expect(kvGuardPuts).toHaveLength(0); // the in-flight guard is never taken
    expect(appCalls).toHaveLength(0); // zero GitHub writes
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App config resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
    expect(JSON.stringify(logLines)).not.toContain("sk-tampered-SECRET");
  });

  test("DASHBOARD_ENCRYPTION_KEY missing → App messages fail closed (SecretboxKeyError)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appY = await seedApp(db, "app-y");
    await configureApp(db, appY.id, "openai/gpt-app", { openai: "sk-y-openai-SECRET" });
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, DASHBOARD_ENCRYPTION_KEY: undefined }),
      testLog,
      testOverrides,
    );

    // The ONE master key gates BOTH decrypt faces of an app-path message —
    // the App's PEM (resolveCommenter, which runs first) and its provider
    // keys (resolveAppConfig). Either way the review fails closed with zero
    // side effects. (The config-face decrypt failure alone is pinned by the
    // tamper test above.)
    await expect(
      consumer(makeBatch(makePayload({ appRef: { appId: appY.id } }))),
    ).rejects.toThrow(/DASHBOARD_ENCRYPTION_KEY is not set/);
    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(appCalls).toHaveLength(0); // zero GitHub writes
  });

  test("config is re-read per message: a dashboard key update applies to the very next review", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setProviderKey(appX.id, "anthropic", "sk-v1-SECRET");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, appRef: { appId: appX.id } })));
    expect(runnerEnvs()[0]?.ANTHROPIC_API_KEY).toBe("sk-v1-SECRET");

    // Rotate the key in the dashboard (upsert) — no redeploy, no cache.
    await store.setProviderKey(appX.id, "anthropic", "sk-v2-SECRET");
    await consumer(makeBatch(makePayload({ pr_number: 43, appRef: { appId: appX.id } })));
    expect(runnerEnvs()[1]?.ANTHROPIC_API_KEY).toBe("sk-v2-SECRET");
    expect(JSON.stringify(runnerEnvs()[1])).not.toContain("sk-v1-SECRET");
  });

  test("a provider id outside the PROVIDERS allowlist is never injected (no env name, no crash)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // The store itself does not validate provider ids (routes do) — seed a
    // rogue row directly to pin the consumer's allowlist discipline.
    await createAppConfigStore(db, TEST_KEY).setProviderKey(appX.id, "not-a-provider", "sk-rogue-SECRET");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    expect(runnerEnvs()[0]).toEqual({
      ARK_API_KEY: ARK_KEY,
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      OMP_REVIEW_MODEL: "ark-plan/deepseek-v4-flash",
    });
    expect(JSON.stringify(runnerEnvs()[0])).not.toContain("sk-rogue-SECRET");
    // Plan 15 log hygiene (硬化项 3): the rogue row's skip is a structured
    // warn carrying the provider id + app_id — never key material.
    const warn = logLines.find((l) => l.level === "warn" && l.fields.provider === "not-a-provider");
    expect(warn).toBeDefined();
    expect(warn!.fields.app_id).toBe(appX.id);
    expect(JSON.stringify(warn)).not.toContain("sk-rogue-SECRET");
  });

  test("whitespace-only App key on a chain provider → fail closed (no global fallback)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", { openai: "sk-x-openai" });
    await createAppConfigStore(db, TEST_KEY).setProviderKey(appX.id, "anthropic", "   ");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // A whitespace-only key = not configured — and there is NO global key to
    // fall back to, so the chain provider's missing key fails the review.
    await expect(
      consumer(makeBatch(makePayload({ appRef: { appId: appX.id } }))),
    ).rejects.toThrow(/per-App config incomplete: app .*provider anthropic has no configured key/);
    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
  });

  test("sibling batch isolation: a healthy App completes with its own key/chain while a misconfigured sibling fails structured — no cross-App key leak (AL-24-5 / F-001)", async () => {
    reset();
    const db = createMigratedTestD1();
    const healthy = await seedApp(db, "healthy");
    await configureApp(db, healthy.id, "openai/gpt-app,anthropic/claude-app", {
      openai: "sk-healthy-openai-SECRET",
      anthropic: "sk-healthy-anthropic-SECRET",
    });
    const missingKey = await seedApp(db, "missing-key");
    await configureApp(db, missingKey.id, "openai/gpt-app,anthropic/claude-app", { openai: "sk-mk-openai" });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // Same consumer, fresh env per message: healthy first, then the
    // misconfigured sibling — the batch resolves the healthy review, then
    // the sibling's failure throws through the structured channel (rethrow
    // stops the batch at the first throwing message — F-001 design).
    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 42, appRef: { appId: healthy.id } }),
          makePayload({ pr_number: 43, appRef: { appId: missingKey.id } }),
        ),
      ),
    ).rejects.toThrow(/per-App config incomplete/);

    // The healthy sibling completed with ITS OWN keys + chain.
    const env = runnerEnvs()[0]!;
    expect(env.OPENAI_API_KEY).toBe("sk-healthy-openai-SECRET");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-healthy-anthropic-SECRET");
    expect(env.ARK_API_KEY).toBe(ARK_KEY);
    expect(env.OMP_REVIEW_MODEL).toBe("openai/gpt-app,anthropic/claude-app");
    expect(appCalls).toEqual(["token", "post"]);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(1);
    // The misconfigured sibling failed structurally: stage=pipeline row +
    // rethrow; zero sandbox/guard/GitHub side effects for it.
    const failRows = db.raw
      .query("SELECT error, head_sha FROM review_failures ORDER BY rowid")
      .all() as Array<{ error: string; head_sha: string }>;
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.error).toContain("provider anthropic has no configured key");
    expect(failRows[0]!.head_sha).toBe(SHA); // payload sha (pre-checkout)
    // No cross-App key material anywhere: the healthy env and every log line
    // carry only each App's own values (fresh env per call, no leakage).
    expect(JSON.stringify(env)).not.toContain("sk-mk-openai");
    expect(JSON.stringify(logLines)).not.toContain("sk-mk-openai");
    expect(JSON.stringify(logLines)).toContain(healthy.id);
  });
});

// --- runner input modelOverrides threading (plan 17 Task 1) ---

describe("runner input modelOverrides threading (plan 17 Task 1)", () => {
  test("app message with a role map: the input JSON carries modelOverrides exactly as mapped (:thinking suffix verbatim)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // The override chains reference openai/anthropic (allowed-list providers)
    // — the Bugbot-7aaf18f4 gate requires a key for every override provider,
    // so configure them alongside the ark baseline.
    await configureApp(db, appX.id, "ark-plan/deepseek-v4-flash", {
      openai: "sk-x-openai",
      anthropic: "sk-x-anthropic",
    });
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setModelRole(appX.id, "mstar-review-seat", "ark-plan/deepseek-v4-flash:high");
    await store.setModelRole(appX.id, "code-reviewer", "openai/gpt-5:thinking, anthropic/claude-x");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    const input = runnerInputs()[0]!;
    expect(input.modelOverrides).toEqual({
      "mstar-review-seat": "ark-plan/deepseek-v4-flash:high",
      "code-reviewer": "openai/gpt-5:thinking, anthropic/claude-x",
    });
    // The field rides AFTER the pre-plan-17 shape (additive optional field).
    expect(Object.keys(input)).toEqual(["worktreePath", "reconFacts", "modelOverrides"]);
  });

  test("app message with NO role map: input JSON omits the field entirely (no-map run)", async () => {
    reset();
    const appDb = createMigratedTestD1();
    const appX = await seedApp(appDb, "app-x"); // github_apps row, NO role rows
    const appConsumer = createReviewConsumer(makeEnv({ DB: appDb as never }), testLog, testOverrides);
    await appConsumer(makeBatch(makePayload({ pr_number: 42, appRef: { appId: appX.id } })));
    const [appInput] = runnerInputs();
    // No role map → the runner input JSON omits the field entirely
    // (byte-identical to a no-map run).
    expect(Object.keys(appInput!)).toEqual(["worktreePath", "reconFacts"]);
  });

  test("an all-cleared role map resolves to NO field (empty map = current behavior)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setModelRole(appX.id, "mstar-review-seat", "first/model");
    await store.setModelRole(appX.id, "mstar-review-seat", ""); // cleared → empty map
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    const input = runnerInputs()[0]!;
    expect(Object.keys(input)).toEqual(["worktreePath", "reconFacts"]);
    expect(input.modelOverrides).toBeUndefined();
  });

  test("role maps are re-read per message: a dashboard role update applies to the very next review", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // The override references the openai provider — its key must exist for
    // the fail-closed gate (Bugbot 7aaf18f4).
    await configureApp(db, appX.id, "ark-plan/deepseek-v4-flash", { openai: "sk-x-openai" });
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setModelRole(appX.id, "code-reviewer", "openai/v1");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, appRef: { appId: appX.id } })));
    await store.setModelRole(appX.id, "code-reviewer", "openai/v2");
    await consumer(makeBatch(makePayload({ pr_number: 43, appRef: { appId: appX.id } })));

    const [first, second] = runnerInputs();
    expect(first!.modelOverrides).toEqual({ "code-reviewer": "openai/v1" });
    expect(second!.modelOverrides).toEqual({ "code-reviewer": "openai/v2" });
  });

  test("a roles-read failure rethrows with the per-App context wrapper (mirror of resolveAppConfig), zero side effects", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // Fail ONLY the model-roles read (the resolveModelOverrides face) — the
    // PEM/config reads stay healthy, so the wrapper's prefix is observable.
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            if (query.includes("FROM app_model_roles")) throw new Error("roles read boom");
            return (target as typeof db).prepare(query);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const consumer = createReviewConsumer(makeEnv({ DB: failingDb as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ appRef: { appId: appX.id } }))),
    ).rejects.toThrow(`per-App model-role resolution failed: app ${appX.id}: roles read boom`);

    // Zero side effects: no sandbox, no input write, no guard acquisition
    // (the read hangs off the appRef gate, before the in-flight guard).
    expect(sandboxCalls).toHaveLength(0);
    expect(runnerInputs()).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    // The structured failure log carries the same greppable prefix + app id.
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App model-role resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
  });
});
// --- per-role override provider key gate (Bugbot 7aaf18f4) ---

describe("per-role override provider key gate (Bugbot 7aaf18f4)", () => {
  test("role override referencing a provider with no key → fail closed via the gate, healthy sibling completes (stage=pipeline row)", async () => {
    reset();
    const db = createMigratedTestD1();
    // Healthy sibling: valid base chain + its own keys.
    const healthy = await seedApp(db, "healthy");
    await configureApp(db, healthy.id, "openai/gpt-app", { openai: "sk-healthy-openai" });
    // The misconfigured App: a VALID base chain (openai key present), but its
    // per-role override chain references anthropic — a provider with NO key
    // in THIS App's config. Only the override gate catches this: pre-fix the
    // message passed assertAppConfigComplete, cloned, and failed at the
    // runner (stage=runner) instead of failing closed here with zero side
    // effects.
    const badOverride = await seedApp(db, "bad-override");
    await configureApp(db, badOverride.id, "openai/gpt-app", { openai: "sk-bo-openai" });
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setModelRole(badOverride.id, "code-reviewer", "anthropic/claude-x");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 42, appRef: { appId: healthy.id } }),
          makePayload({ pr_number: 43, appRef: { appId: badOverride.id } }),
        ),
      ),
    ).rejects.toThrow(
      /per-App config incomplete: app .*role override `code-reviewer` provider anthropic has no configured key/,
    );

    // The healthy sibling completed with ITS OWN keys + chain.
    const env = runnerEnvs()[0]!;
    expect(env.OPENAI_API_KEY).toBe("sk-healthy-openai");
    expect(appCalls).toEqual(["token", "post"]); // only the healthy sibling reviewed
    // The misconfigured sibling failed structurally through the F-001
    // channel: one review_failures row at stage=pipeline (payload sha) plus
    // the structured error log — zero sandbox/guard/GitHub side effects.
    const rows = db.raw
      .query("SELECT stage, error, head_sha FROM review_failures ORDER BY rowid")
      .all() as Array<{ stage: string; error: string; head_sha: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("pipeline");
    expect(rows[0]!.error).toContain("role override `code-reviewer` provider anthropic has no configured key");
    expect(rows[0]!.head_sha).toBe(SHA);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.fields.app_id).toBe(badOverride.id);
    expect(errLine!.msg).toContain("role override `code-reviewer` provider anthropic has no configured key");
  });

  test("role override whose provider HAS an allowlisted key → gate passes, override reaches the runner input", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app", { openai: "sk-x-openai" });
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setModelRole(appX.id, "code-reviewer", "openai/gpt-5:thinking, openai/gpt-5-mini");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    // The override passed the gate and reaches the runner input verbatim;
    // the app key rides the exec env under the mapped env name.
    const input = runnerInputs()[0]!;
    expect(input.modelOverrides).toEqual({ "code-reviewer": "openai/gpt-5:thinking, openai/gpt-5-mini" });
    expect(runnerEnvs()[0]!.OPENAI_API_KEY).toBe("sk-x-openai");
    expect(appCalls).toEqual(["token", "post"]);
  });

  test("role override referencing a CUSTOM provider declaration (with key) → gate passes, override reaches the runner input", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app", { openai: "sk-x-openai" });
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["m1"],
      },
      "sk-custom-fixture-AAA",
    );
    await store.setModelRole(appX.id, "frontend-dev", "my-provider/m1");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    const input = runnerInputs()[0]!;
    expect(input.modelOverrides).toEqual({ "frontend-dev": "my-provider/m1" });
    expect(appCalls).toEqual(["token", "post"]);
  });
});

describe("custom provider env injection + runner input threading (plan 23 Task 3, AL-23-1)", () => {
  test("app with custom providers: env carries CUSTOM_<ID>_API_KEY values, input JSON carries keyless declarations", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["my-model-1", "my-model-2"],
      },
      "sk-custom-fixture-AAA",
    );
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "second-one",
        base_url: "https://second.example.com/v1",
        api: "anthropic-messages",
        model_ids: ["b-model"],
      },
      "sk-custom-fixture-BBB",
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    // Env injection: decrypted keys under the mapped env names.
    const env = runnerEnvs()[0]!;
    expect(env.CUSTOM_MY_PROVIDER_API_KEY).toBe("sk-custom-fixture-AAA");
    expect(env.CUSTOM_SECOND_ONE_API_KEY).toBe("sk-custom-fixture-BBB");
    // The App key assembly is untouched (custom injection is additive).
    expect(env.ARK_API_KEY).toBe(ARK_KEY);
    expect(env.PI_CODING_AGENT_DIR).toBe("/opt/omp-agent");
    // Runner input JSON: keyless declarations only (zero key material).
    const input = runnerInputs()[0]!;
    expect(input.customProviders).toEqual([
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["my-model-1", "my-model-2"],
      },
      {
        provider_id: "second-one",
        base_url: "https://second.example.com/v1",
        api: "anthropic-messages",
        model_ids: ["b-model"],
      },
    ]);
    // Additive optional field after the pre-plan-23 shape.
    expect(Object.keys(input)).toEqual(["worktreePath", "reconFacts", "customProviders"]);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("sk-custom-fixture");
  });

  test("chain referencing a custom provider id passes the fail-closed gate and injects CUSTOM_<ID>_API_KEY (qc3 F-001 — neededEnvName custom branch)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // The chain references the custom provider id directly — the gate's
    // neededEnvName third branch (neither a PROVIDERS allowlisted id nor an
    // IN_IMAGE_BASE_PROVIDER_IDS member) resolves it to
    // CUSTOM_MY_PROVIDER_API_KEY, the same env name buildRunnerEnv injects.
    await configureApp(db, appX.id, "my-provider/model-1");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["model-1"],
      },
      "sk-custom-fixture-AAA",
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // The gate passes (the custom declaration supplies the key) and the review
    // completes — the key reaches the runner env under the SAME env name the
    // synthesized models.yml references (AL-23-1 loop).
    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    const env = runnerEnvs()[0]!;
    expect(env.CUSTOM_MY_PROVIDER_API_KEY).toBe("sk-custom-fixture-AAA");
    expect(env.OMP_REVIEW_MODEL).toBe("my-provider/model-1");
    expect(appCalls).toEqual(["token", "post"]); // the review completed
    // key_source: custom for the declaration (id + env name, never the key).
    const customLines = keySourceLines().filter((l) => l.fields.key_source === "custom");
    expect(customLines).toHaveLength(1);
    expect(customLines[0]!.fields.provider).toBe("my-provider");
    expect(customLines[0]!.msg).toContain("CUSTOM_MY_PROVIDER_API_KEY");
  });

  test("custom providers: keys never reach logs — key_source: custom lines carry ids and env names only", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["m1"],
      },
      "sk-custom-fixture-AAA",
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ appRef: { appId: appX.id } })));

    const customLines = keySourceLines().filter((l) => l.fields.key_source === "custom");
    expect(customLines).toHaveLength(1);
    expect(customLines[0]!.fields.provider).toBe("my-provider");
    expect(customLines[0]!.msg).toContain("CUSTOM_MY_PROVIDER_API_KEY");
    // Zero key material in ANY log line (the key_source discipline).
    for (const line of logLines) {
      expect(JSON.stringify(line.fields)).not.toContain("sk-custom-fixture");
      expect(line.msg).not.toContain("sk-custom-fixture");
    }
  });

  test("app with NO custom providers: input JSON + env carry no custom-provider surface (byte-identical to a no-declaration run)", async () => {
    reset();
    const appDb = createMigratedTestD1();
    const appX = await seedApp(appDb, "app-x"); // github_apps row, NO custom rows
    const appConsumer = createReviewConsumer(makeEnv({ DB: appDb as never }), testLog, testOverrides);
    await appConsumer(makeBatch(makePayload({ pr_number: 42, appRef: { appId: appX.id } })));
    const [appInput] = runnerInputs();
    const [appEnv] = runnerEnvs();
    // No declarations → the runner input JSON omits the field entirely and
    // no CUSTOM_* env name is injected (plan 23 byte-compat pin).
    expect(Object.keys(appInput!)).toEqual(["worktreePath", "reconFacts"]);
    expect(JSON.stringify(appEnv)).not.toContain("CUSTOM_");
  });

  test("custom providers are re-read per message: a dashboard declaration update applies to the very next review", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      appX.id,
      { provider_id: "my-provider", base_url: "https://one.example.com/v1", api: "openai-completions", model_ids: ["m1"] },
      "sk-custom-fixture-AAA",
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, appRef: { appId: appX.id } })));
    await store.upsertCustomProvider(
      appX.id,
      { provider_id: "my-provider", base_url: "https://two.example.com/v1", api: "openai-completions", model_ids: ["m2"] },
      "sk-custom-fixture-BBB",
    );
    await consumer(makeBatch(makePayload({ pr_number: 43, appRef: { appId: appX.id } })));

    const [first, second] = runnerInputs();
    expect((first!.customProviders as Array<{ base_url: string; model_ids: string[] }>)[0]!.base_url).toBe(
      "https://one.example.com/v1",
    );
    expect((second!.customProviders as Array<{ base_url: string; model_ids: string[] }>)[0]!.base_url).toBe(
      "https://two.example.com/v1",
    );
    expect((runnerEnvs()[0] as Record<string, string>).CUSTOM_MY_PROVIDER_API_KEY).toBe("sk-custom-fixture-AAA");
    expect((runnerEnvs()[1] as Record<string, string>).CUSTOM_MY_PROVIDER_API_KEY).toBe("sk-custom-fixture-BBB");
  });

  test("an undecryptable custom-provider row fails closed with the per-App wrapper, zero side effects", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // Tamper the stored envelope so the decrypt face must throw.
    const enc = await createSecretbox(TEST_KEY).encryptSecret("sk-custom-fixture-AAA", "app_custom_providers.api_key_enc:wrong-aad");
    db.raw
      .prepare(
        `INSERT INTO app_custom_providers (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(appX.id, "my-provider", "https://my-provider.example.com/v1", "openai-completions", JSON.stringify(["m1"]), enc);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ appRef: { appId: appX.id } }))),
    ).rejects.toThrow(`per-App custom-provider resolution failed: app ${appX.id}`);

    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App custom-provider resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
  });
});
