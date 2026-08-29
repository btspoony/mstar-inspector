/**
 * Per-App runner-env assembly tests (plan 14 Task 3, spec § Per-App BYOK).
 *
 * The consumer resolves the App's AI config (`getAppConfig` decrypt face, ONE
 * read per message) off the SAME appRef resolution as the commenter and feeds
 * it into `buildRunnerEnv(env, appCfg, log, fields)` at the runner exec step:
 *   - the App's own key wins per provider, injected under the PROVIDERS-mapped
 *     env name (empty/whitespace keys and unknown provider ids never inject);
 *   - every provider the App did NOT configure falls back to the global env
 *     key (spec fallback chain — zero-config Apps keep working);
 *   - an App model chain overrides OMP_REVIEW_MODEL; null/""/whitespace-only =
 *     unset → global chain unchanged (plan 15 input bounds: any falsy or
 *     blank chain — including a direct-DB write the store never saw — is
 *     unset; a padded chain with content forwards VERBATIM);
 *   - every injected key logs `key_source: app|global` (the source, never the
 *     key) and the assembly logs `config_source: app|fallback`;
 *   - legacy (appRef absent / `{ kind: "legacy" }`) → `appCfg` undefined →
 *     byte-identical pre-plan-14 env, no assembly logs;
 *   - the assembly builds a FRESH env object per review (no shared mutable
 *     env) — cross-App leakage is structurally impossible (full-object pins);
 *   - an UNREADABLE App key (tampered envelope / missing master key) fails
 *     closed BEFORE guard/sandbox — never a silent fallback to global keys.
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

const VALID_OUTPUT: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "One issue found in the diff.",
  findings: [],
};

// --- seeding helpers ---------------------------------------------------------

/** Distinct github_app_id per seeded App (github_apps.github_app_id is UNIQUE). */
let githubAppIdSeq = 100000;

/** Raw-insert an active, non-deleted github_apps row (the commenter face). */
async function seedApp(db: ReturnType<typeof createMigratedTestD1>, slug: string): Promise<{ id: string }> {
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
  return { id };
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

const legacyCalls: string[] = [];
const appCalls: string[] = [];

const legacyCommenter: ReviewCommenter = {
  getInstallationToken: mock(async () => {
    legacyCalls.push("token");
    return "legacy-token";
  }),
  postReview: mock(async () => {
    legacyCalls.push("post");
  }),
};

const appCommenterFactory = mock((_cred: CommenterEnv): ReviewCommenter => ({
  getInstallationToken: mock(async () => {
    appCalls.push("token");
    return "app-token";
  }),
  postReview: mock(async () => {
    appCalls.push("post");
  }),
}));

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
    APP_ID: "999",
    PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nlegacy\n-----END PRIVATE KEY-----\n",
    OMP_MODEL_KEY: "ark-key",
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
  kvGuardPuts.length = 0;
  logLines.length = 0;
}

/** The runner exec call's env, in message order (one entry per runner step). */
function runnerEnvs(): Array<Record<string, string>> {
  return sandboxCalls
    .filter((c) => c.cmd.includes("bun run"))
    .map((c) => (c.opts as { env?: Record<string, string> }).env ?? {});
}

/** The assembly log lines (key_source per injected key + config_source summary). */
function keySourceLines(): Array<{ fields: ConsumerLogFields; msg: string }> {
  return logLines.filter((l) => l.fields.key_source !== undefined);
}

describe("per-App runner env assembly (plan 14 Task 3, spec § Per-App BYOK)", () => {
  test("app-key: the App's own key overrides the global env key under the PROVIDERS env name", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await createAppConfigStore(db, TEST_KEY).setProviderKey(appX.id, "anthropic", "sk-app-x-SECRET");
    const consumer = createReviewConsumer(
      makeEnv({
        DB: db as never,
        ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET",
        OPENAI_API_KEY: "sk-global-openai-SECRET",
      }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    const env = runnerEnvs()[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-app-x-SECRET"); // the App's key wins
    expect(env.OPENAI_API_KEY).toBe("sk-global-openai-SECRET"); // untouched provider stays global
    expect(env.ARK_API_KEY).toBe("ark-key");
    // key_source: app for the overridden provider; config_source: app.
    const line = keySourceLines().find((l) => l.fields.provider === "anthropic");
    expect(line?.fields.key_source).toBe("app");
    const cfgLine = logLines.find((l) => l.fields.config_source !== undefined);
    expect(cfgLine?.fields.config_source).toBe("app");
    expect(appCalls).toEqual(["token", "post"]);
  });

  test("global-fallback: a provider the App did not configure falls back to the global env key", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    // The App configures ONLY gemini; anthropic + openai stay global.
    await createAppConfigStore(db, TEST_KEY).setProviderKey(appX.id, "gemini", "sk-app-x-gemini");
    const consumer = createReviewConsumer(
      makeEnv({
        DB: db as never,
        ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET",
        OPENAI_API_KEY: "sk-global-openai-SECRET",
      }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    const env = runnerEnvs()[0]!;
    expect(env.GEMINI_API_KEY).toBe("sk-app-x-gemini");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-global-anthropic-SECRET");
    expect(env.OPENAI_API_KEY).toBe("sk-global-openai-SECRET");
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ gemini: "app", anthropic: "global", openai: "global" });
  });

  test("mixed: app keys and global fallback coexist per provider", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setProviderKey(appX.id, "anthropic", "sk-app-x-SECRET");
    await store.setProviderKey(appX.id, "openai", "sk-app-x-openai-SECRET");
    const consumer = createReviewConsumer(
      makeEnv({
        DB: db as never,
        ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET", // shadowed by the App key
        GROQ_API_KEY: "sk-global-groq-SECRET", // falls back (App has no groq)
      }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    const env = runnerEnvs()[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-app-x-SECRET");
    expect(env.OPENAI_API_KEY).toBe("sk-app-x-openai-SECRET");
    expect(env.GROQ_API_KEY).toBe("sk-global-groq-SECRET");
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ anthropic: "app", openai: "app", groq: "global" });
    const cfgLine = logLines.find((l) => l.fields.config_source !== undefined);
    expect(cfgLine?.fields.config_source).toBe("app");
  });

  test("none: zero App keys + no chain → env identical to the global path (config_source: fallback)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x"); // github_apps row, NO config rows
    const envOverrides = {
      DB: db as never,
      ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET",
      OPENAI_API_KEY: "sk-global-openai-SECRET",
      OMP_REVIEW_MODEL: "ark-plan/global-chain",
    };
    const consumer = createReviewConsumer(makeEnv(envOverrides), testLog, testOverrides);

    // Same consumer, same env: one per-App message, then one legacy message.
    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, appRef: { kind: "app", appId: appX.id } }),
        makePayload({ pr_number: 43 }), // legacy
      ),
    );

    const [appEnv, legacyEnv] = runnerEnvs();
    expect(appEnv).toEqual(legacyEnv);
    const cfgLine = logLines.find((l) => l.fields.config_source !== undefined);
    expect(cfgLine?.fields.config_source).toBe("fallback");
    // The fallback keys are still logged with their (global) source.
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ anthropic: "global", openai: "global" });
  });

  test("legacy: appRef absent → byte-identical pre-plan-14 env, NO assembly logs", async () => {
    reset();
    const db = createMigratedTestD1();
    const consumer = createReviewConsumer(
      makeEnv({
        DB: db as never,
        ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET",
        MISTRAL_API_KEY: "", // empty → never forwarded
        OMP_REVIEW_MODEL: "ark-plan/global-chain",
      }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload())); // no appRef field

    expect(runnerEnvs()[0]).toEqual({
      ARK_API_KEY: "ark-key",
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      OMP_REVIEW_MODEL: "ark-plan/global-chain",
      ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET",
    });
    expect(keySourceLines()).toHaveLength(0);
    expect(logLines.some((l) => l.fields.config_source !== undefined)).toBe(false);
    expect(legacyCalls).toEqual(["token", "post"]);
    expect(appCalls).toHaveLength(0);
  });

  test("legacy: appRef {kind:'legacy'} → identical to absent (explicit legacy marker)", async () => {
    reset();
    const db = createMigratedTestD1();
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET" }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload({ appRef: { kind: "legacy" } })));

    expect(runnerEnvs()[0]).toEqual({
      ARK_API_KEY: "ark-key",
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET",
    });
    expect(keySourceLines()).toHaveLength(0);
    expect(legacyCalls).toEqual(["token", "post"]);
  });

  test("model chain: the App's chain overrides OMP_REVIEW_MODEL; unset falls back to the global chain", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const appY = await seedApp(db, "app-y");
    const appZ = await seedApp(db, "app-z");
    await createAppConfigStore(db, TEST_KEY).setModelChain(appX.id, "openai/gpt-app,anthropic/claude-app");
    // Y's chain is EMPTY — the store itself clears it (plan 15: "" = same path
    // as null), so Y reads back a null chain → the global chain stays.
    await createAppConfigStore(db, TEST_KEY).setModelChain(appY.id, "");
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, OMP_REVIEW_MODEL: "ark-plan/global-chain" }),
      testLog,
      testOverrides,
    );

    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, appRef: { kind: "app", appId: appX.id } }),
        makePayload({ pr_number: 43, appRef: { kind: "app", appId: appY.id } }),
        makePayload({ pr_number: 44, appRef: { kind: "app", appId: appZ.id } }), // no row → null chain
      ),
    );

    const [xEnv, yEnv, zEnv] = runnerEnvs() as [Record<string, string>, Record<string, string>, Record<string, string>];
    expect(xEnv.OMP_REVIEW_MODEL).toBe("openai/gpt-app,anthropic/claude-app");
    expect(yEnv.OMP_REVIEW_MODEL).toBe("ark-plan/global-chain"); // "" treated as unset
    expect(zEnv.OMP_REVIEW_MODEL).toBe("ark-plan/global-chain"); // null → global
    // An App chain alone counts as App contribution (config_source: app).
    const cfgLines = logLines.filter((l) => l.fields.config_source !== undefined);
    expect(cfgLines[0]?.fields.config_source).toBe("app");
    expect(cfgLines[1]?.fields.config_source).toBe("fallback");
    expect(cfgLines[2]?.fields.config_source).toBe("fallback");
  });

  test("blank chain via direct-DB write is unset; a padded real chain forwards VERBATIM (plan 15 trim guard)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const appY = await seedApp(db, "app-y");
    // Bypass the store (the plan-15 threat model: a direct DB write can hold a
    // blank chain the routes would have normalized away) — the raw rows pin
    // the buildRunnerEnv trim guard itself, independent of store semantics.
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
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, OMP_REVIEW_MODEL: "ark-plan/global-chain" }),
      testLog,
      testOverrides,
    );

    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, appRef: { kind: "app", appId: appX.id } }),
        makePayload({ pr_number: 43, appRef: { kind: "app", appId: appY.id } }),
      ),
    );

    const [xEnv, yEnv] = runnerEnvs() as [Record<string, string>, Record<string, string>];
    // Whitespace-only chain = unset → the global chain reaches the runner.
    expect(xEnv.OMP_REVIEW_MODEL).toBe("ark-plan/global-chain");
    // A padded chain WITH content is configuration — forwarded exactly as
    // stored (the guard only decides unset-vs-set; it never mutates the value;
    // the runner-side selector parse trims segments).
    expect(yEnv.OMP_REVIEW_MODEL).toBe(padded);
    const cfgLines = logLines.filter((l) => l.fields.config_source !== undefined);
    expect(cfgLines[0]?.fields.config_source).toBe("fallback");
    expect(cfgLines[1]?.fields.config_source).toBe("app");
  });

  test("cross-App isolation: App X's env never contains App Y's key names or values (full env object)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const appY = await seedApp(db, "app-y");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setProviderKey(appX.id, "anthropic", "sk-x-anthropic-SECRET");
    await store.setProviderKey(appY.id, "openai", "sk-y-openai-SECRET");
    // NO global provider keys: any key in the env must come from the App row.
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    // X → Y → X: identical X envs prove the assembly is a fresh object per
    // review with no shared mutable state between messages.
    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, appRef: { kind: "app", appId: appX.id } }),
        makePayload({ pr_number: 43, appRef: { kind: "app", appId: appY.id } }),
        makePayload({ pr_number: 44, appRef: { kind: "app", appId: appX.id } }),
      ),
    );

    const [xEnv, yEnv, xEnvAgain] = runnerEnvs() as [Record<string, string>, Record<string, string>, Record<string, string>];
    expect(xEnv).toEqual({
      ARK_API_KEY: "ark-key",
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      ANTHROPIC_API_KEY: "sk-x-anthropic-SECRET",
    });
    expect(yEnv).toEqual({
      ARK_API_KEY: "ark-key",
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      OPENAI_API_KEY: "sk-y-openai-SECRET",
    });
    expect(xEnvAgain).toEqual(xEnv);
    // Belt and braces: neither env's values contain the other App's key.
    expect(Object.values(xEnv)).not.toContain("sk-y-openai-SECRET");
    expect(Object.values(yEnv)).not.toContain("sk-x-anthropic-SECRET");
  });

  test("secrets never logged: key_source/config_source lines carry ids only, never key material", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.setProviderKey(appX.id, "anthropic", "sk-app-x-SECRET");
    await store.setModelChain(appX.id, "openai/gpt-app");
    const secrets = [
      "sk-app-x-SECRET",
      "sk-global-anthropic-SECRET",
      "sk-global-groq-SECRET",
      "ark-key",
      "sk-tampered-SECRET",
    ];
    const consumer = createReviewConsumer(
      makeEnv({
        DB: db as never,
        ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET",
        GROQ_API_KEY: "sk-global-groq-SECRET",
      }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    // The assembly lines EXIST (the assertion is not vacuous)…
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ anthropic: "app", groq: "global" });
    expect(logLines.some((l) => l.fields.config_source !== undefined)).toBe(true);
    // …and NO log line — assembly, runner, post, anything — carries key material.
    for (const line of logLines) {
      const serialized = JSON.stringify(line);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  test("undecryptable App key → fail closed BEFORE guard/sandbox; never a silent global fallback", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await seedTamperedKey(db, appX.id, "anthropic");
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET" }),
      testLog,
      testOverrides,
    );

    // The global key EXISTS — the review must still fail, not fall back to it.
    await expect(
      consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } }))),
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

  test("DASHBOARD_ENCRYPTION_KEY missing → App messages fail closed; never a silent global fallback", async () => {
    reset();
    const db = createMigratedTestD1();
    const appY = await seedApp(db, "app-y");
    await createAppConfigStore(db, TEST_KEY).setProviderKey(appY.id, "openai", "sk-y-openai-SECRET");
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, DASHBOARD_ENCRYPTION_KEY: undefined, OPENAI_API_KEY: "sk-global-openai-SECRET" }),
      testLog,
      testOverrides,
    );

    // The ONE master key gates BOTH decrypt faces of an app-path message —
    // the App's PEM (resolveCommenter, which runs first) and its provider
    // keys (resolveAppConfig). Either way the review fails closed with zero
    // side effects: the App's own key is never silently replaced by the
    // global one. (The config-face decrypt failure alone is pinned by the
    // tamper test above.)
    await expect(
      consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appY.id } }))),
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

    await consumer(makeBatch(makePayload({ pr_number: 42, appRef: { kind: "app", appId: appX.id } })));
    expect(runnerEnvs()[0]?.ANTHROPIC_API_KEY).toBe("sk-v1-SECRET");

    // Rotate the key in the dashboard (upsert) — no redeploy, no cache.
    await store.setProviderKey(appX.id, "anthropic", "sk-v2-SECRET");
    await consumer(makeBatch(makePayload({ pr_number: 43, appRef: { kind: "app", appId: appX.id } })));
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

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    expect(runnerEnvs()[0]).toEqual({
      ARK_API_KEY: "ark-key",
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
    });
    expect(JSON.stringify(runnerEnvs()[0])).not.toContain("sk-rogue-SECRET");
    // Plan 15 log hygiene (硬化项 3): the rogue row's skip is a structured
    // warn carrying the provider id + app_id — never key material.
    const warn = logLines.find((l) => l.level === "warn" && l.fields.provider === "not-a-provider");
    expect(warn).toBeDefined();
    expect(warn!.fields.app_id).toBe(appX.id);
    expect(JSON.stringify(warn)).not.toContain("sk-rogue-SECRET");
  });

  test("whitespace-only App key is not configured → global fallback (same rule as pickProviderKeys)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await createAppConfigStore(db, TEST_KEY).setProviderKey(appX.id, "anthropic", "   ");
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, ANTHROPIC_API_KEY: "sk-global-anthropic-SECRET" }),
      testLog,
      testOverrides,
    );

    await consumer(makeBatch(makePayload({ appRef: { kind: "app", appId: appX.id } })));

    const env = runnerEnvs()[0]!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-global-anthropic-SECRET");
    const line = keySourceLines().find((l) => l.fields.provider === "anthropic");
    expect(line?.fields.key_source).toBe("global");
  });
});
