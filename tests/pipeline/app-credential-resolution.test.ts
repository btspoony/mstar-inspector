
import { describe, expect, mock, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { idemKey } from "../../src/contracts/idem";
import type { ReviewOutput } from "../../src/review/schema";
import { createTestD1, mapAppToDefaultWorkspace } from "../store/helpers";
import { APP_CREDENTIAL_RESOLUTION_MIGRATIONS, applyMigrations } from "../helpers/migration-shapes";
import { inlineWorkflowStarter } from "../helpers/workflow-route";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { sk, fakePem } from "../helpers/fake-secrets";
import type { CommenterEnv, InstallationTokenGrant, ReviewCommenter, TokenInput } from "../../src/pipeline/comment";
import type { ConsumerLog, ConsumerLogFields, PipelineEnv } from "../../src/pipeline/consumer";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const PEM_X = fakePem("FAKE-APP-X-PEM");
const PEM_Y = fakePem("FAKE-APP-Y-PEM");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const VALID_OUTPUT: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "One issue found in the diff.",
  findings: [],
};

function createMigratedD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  applyMigrations(db, APP_CREDENTIAL_RESOLUTION_MIGRATIONS);
  return db;
}

type SeedOptions = {
  slug: string;
  githubAppId: number;
  pem: string;
  wrongAad?: boolean;
};

async function seedApp(db: ReturnType<typeof createTestD1>, opts: SeedOptions): Promise<{ id: string; targetId: string }> {
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  const aad = opts.wrongAad ? `github_apps.private_key_enc:not-this-row` : `github_apps.private_key_enc:${id}`;
  const privateKeyEnc = await box.encryptSecret(opts.pem, aad);
  const webhookSecretEnc = await box.encryptSecret(`whsec-${opts.slug}`, `github_apps.webhook_secret_enc:${id}`);
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, opts.githubAppId, opts.slug, privateKeyEnc, webhookSecretEnc);
  await mapAppToDefaultWorkspace(db, id);
  const targetId = `target-${id}`;
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
       VALUES (?, 'default', ?, ?, 'tester', datetime('now'), datetime('now'))`,
    )
    .run(targetId, id, opts.slug);
  const configStore = createAppConfigStore(db, TEST_KEY);
  await configStore.setModelChain(id, "ark/deepseek-v4-flash");
  await configStore.addProviderKey(id, "ark", "ark-key");
  return { id, targetId };
}


const sandboxCalls: Array<{ cmd: string; opts?: unknown }> = [];

const fakeSandbox = {
  runCommand: mock(async (cmd: string, opts?: unknown) => {
    sandboxCalls.push({ cmd, opts });
    if (cmd.includes("rev-parse")) {
      return { stdout: `${SHA}\n`, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("--input")) {
      return { stdout: JSON.stringify(VALID_OUTPUT), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }),
  provision: mock(async () => ({ kind: "provisioned" as const })),
  runMarked: mock(async (_marker: string, cmd: string, opts?: unknown) => ({
    kind: "ran" as const,
    ...(await fakeSandbox.runCommand(cmd, opts)),
  })),
  destroyMarked: mock(async () => {
    await fakeSandbox.destroy();
    return "destroyed" as const;
  }),
  destroy: mock(async () => {}),
};

import "../helpers/cloudflare-workers-mock";


type CommenterCall = { op: "token" | "plan" | "post" | "degrade"; installationId?: number };
const appCalls: Array<{ instance: number; call: CommenterCall }> = [];
const factoryCreds: Array<{ instance: number; cred: CommenterEnv }> = [];
let factoryInstanceSeq = 0;

const appCommenterFactory = mock((cred: CommenterEnv): ReviewCommenter => {
  const instance = ++factoryInstanceSeq;
  factoryCreds.push({ instance, cred });
  const sandboxGrant = (token: string, input: TokenInput): InstallationTokenGrant => ({
    token,
    permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    repositoryNames: [input.scope.repo],
    repositorySelection: "selected",
  });
  return {
    getInstallationToken: mock(async (input: TokenInput) => {
      appCalls.push({ instance, call: { op: "token", installationId: input.scope.installationId } });
      return sandboxGrant(`app-${instance}-token`, input);
    }),
    planReviewUpsert: mock(async () => {
      appCalls.push({ instance, call: { op: "plan" } });
      return { action: "create", round: 1 } as const;
    }),
    planDegradedUpsert: mock(async () => {
      appCalls.push({ instance, call: { op: "degrade" } });
      return { action: "create", round: 1 } as const;
    }),
    postPreparedReview: mock(async () => {
      appCalls.push({ instance, call: { op: "post" } });
      return { commentId: 101 };
    }),
    postPreparedDegraded: mock(async () => {
      appCalls.push({ instance, call: { op: "degrade" } });
      return { posted: true, commentId: 202 };
    }),
    deleteDegradedComment: mock(async () => ({ deleted: 0, skipped: 0, errors: [], rateLimited: { primary: 0, secondary: 0 } })),
    postLineComments: mock(async () => {
      throw new Error("unexpected: no qualifying findings → no line comments");
    }),
    recoverLineComments: mock(async () => {
      throw new Error("unexpected: no dispatched line batch → no discovery");
    }),
    listDiscussion: mock(async () => {
      throw new Error("unexpected: listDiscussion requires open lifecycle rows");
    }),
    discoverThread: mock(async () => {
      throw new Error("unexpected: discoverThread requires queued resolutions");
    }),
    resolveFindingThread: mock(async () => {
      throw new Error("unexpected: resolveFindingThread requires queued resolutions");
    }),
  };
});

const testOverrides = {
  createAppCommenter: appCommenterFactory,
  getSandbox: async () => fakeSandbox,
  startAttempt: inlineWorkflowStarter([]),
};


const { createReviewConsumer } = await import("../../src/pipeline/consumer");


const logLines: Array<{ level: "info" | "warn" | "error"; fields: ConsumerLogFields; msg: string }> = [];
const testLog: ConsumerLog = {
  info: (fields, msg) => logLines.push({ level: "info", fields, msg: msg ?? "" }),
  warn: (fields, msg) => logLines.push({ level: "warn", fields, msg: msg ?? "" }),
  error: (fields, msg) => logLines.push({ level: "error", fields, msg: msg ?? "" }),
};


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
    botRef: { appId: "00000000-0000-0000-0000-000000000000" },
    targetId: "00000000-0000-0000-0000-000000000001",
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
      retry: () => {
        retryIds.push(`m${i}`);
      },
      ack: () => {
        ackIds.push(`m${i}`);
      },
    })),
  } as unknown as MessageBatch<ReviewJobPayload>;
}

const ackIds: string[] = [];
const retryIds: string[] = [];

function reset(): void {
  sandboxCalls.length = 0;
  appCalls.length = 0;
  factoryCreds.length = 0;
  factoryInstanceSeq = 0;
  kvPuts.length = 0;
  kvGuardPuts.length = 0;
  logLines.length = 0;
  ackIds.length = 0;
  retryIds.length = 0;
}

describe("consumer bot/target resolution (lock L4)", () => {
  test("botRef {appId} → authenticates with THAT App's decrypted PEM (sibling isolation)", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await seedApp(db, { slug: "app-y", githubAppId: 333444, pem: PEM_Y });
    const configStore = createAppConfigStore(db, TEST_KEY);
    await configStore.addProviderKey(appX.id, "ark", "second-ark-key");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const runnerCall = sandboxCalls.find((call) => call.cmd.includes("--input"));
    expect(runnerCall).toBeDefined();
    const runnerOptions = runnerCall!.opts as { env: Record<string, string>; stdin?: string };
    expect(runnerOptions.env.ARK_API_KEY).toBeUndefined();
    const { pools } = JSON.parse(runnerOptions.stdin!) as { pools: Record<string, string[]> };
    expect(pools.ark).toHaveLength(2);
    expect(Object.keys(runnerOptions.env).filter((name) => name.startsWith("MSTAR_POOL_"))).toEqual([]);
    expect(factoryCreds).toHaveLength(1);
    expect(factoryCreds[0]!.cred).toEqual({ APP_ID: "111222", PRIVATE_KEY: PEM_X });
    expect(appCalls.map((c) => c.call.op)).toEqual(["token", "plan", "post"]);
    expect(appCalls[0]!.instance).toBe(factoryCreds[0]!.instance);
    expect(appCalls[1]!.instance).toBe(factoryCreds[0]!.instance);
    expect(appCalls[0]!.call.installationId).toBe(123);
    expect(kvPuts).toEqual([{ key: `idem:123:acme/widgets:42:${SHA}`, value: "done" }]);
    const errOrInfo = logLines.filter((l) => l.fields.app_id !== undefined);
    expect(errOrInfo.length).toBeGreaterThan(0);
    expect(errOrInfo.every((l) => l.fields.app_id === appX.id)).toBe(true);
    const row = db.raw.query("SELECT bot_id FROM reviews").get() as { bot_id: string | null };
    expect(row.bot_id).toBe(appX.id);
  });

  test("a job carrying both ids resolves both — the bot's credential, the target's depth", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    db.raw.prepare("UPDATE review_targets SET review_level = 'deep' WHERE id = ?").run(appX.targetId);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const runnerCall = sandboxCalls.find((call) => call.cmd.includes("--input"));
    expect(runnerCall).toBeDefined();
    expect(runnerCall!.cmd).toContain("--level 'deep'");
    expect(factoryCreds).toHaveLength(1);
    expect(factoryCreds[0]!.cred).toEqual({ APP_ID: "111222", PRIVATE_KEY: PEM_X });
  });

  test("a target naming another bot → structured failure (retry/DLQ), no credential, no sandbox", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const appY = await seedApp(db, { slug: "app-y", githubAppId: 333444, pem: PEM_Y });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appY.targetId }))),
    ).rejects.toThrow(/per-App credential resolution failed: target .* belongs to bot/);

    expect(factoryCreds).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
  });

  test("two messages for the same App in one batch → ONE instance (per-appId cache), both served by it", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }),
        makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId }),
      ),
    );

    expect(factoryCreds).toHaveLength(1);
    expect(appCalls).toHaveLength(6);
    expect(new Set(appCalls.map((c) => c.instance))).toEqual(new Set([factoryCreds[0]!.instance]));
  });

  test("disabled-app mid-flight → structured failure, rethrow (retry/DLQ), ZERO GitHub writes, guard untouched", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await createReviewBotsStore(db).setAppStatus(appX.id, "disabled");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })))).rejects.toThrow(
      /per-App credential resolution failed: app .* is disabled/,
    );

    expect(factoryCreds).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App credential resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
  });

  test("soft-deleted app → structured failure, zero GitHub writes", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await createReviewBotsStore(db).softDeleteApp(appX.id);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })))).rejects.toThrow(
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
      consumer(makeBatch(makePayload({ botRef: { appId: "no-such-app" }, targetId: "no-such-target" }))),
    ).rejects.toThrow(/per-App credential resolution failed: app no-such-app not found/);

    expect(factoryCreds).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("tampered PEM envelope (wrong AAD) → decrypt failure, zero GitHub writes", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X, wrongAad: true });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })))).rejects.toThrow(
      /secretbox: decrypt failed/,
    );

    expect(factoryCreds).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("DASHBOARD_ENCRYPTION_KEY missing → per-App fails closed (SecretboxKeyError)", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, DASHBOARD_ENCRYPTION_KEY: undefined }),
      testLog,
      testOverrides,
    );

    await expect(consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })))).rejects.toThrow(
      /DASHBOARD_ENCRYPTION_KEY is not set/,
    );

    expect(factoryCreds).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("L4 same-instance pin: token mint and postReview come from the ONE per-App instance per message", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(factoryCreds).toHaveLength(1);
    const instance = factoryCreds[0]!.instance;
    expect(appCalls.map((c) => c.instance)).toEqual([instance, instance, instance]);
    expect(appCalls.map((c) => c.call.op)).toEqual(["token", "plan", "post"]);
  });
});

describe("appCommenters fingerprint cache (hardening item 1, architect lock L1)", () => {
  const keyAad = (id: string) => `github_apps.private_key_enc:${id}`;

  test("unchanged credentials across batches → fingerprint match reuses the SAME instance", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(factoryCreds).toHaveLength(1);
    expect(appCalls.map((c) => c.instance)).toEqual([
      factoryCreds[0]!.instance,
      factoryCreds[0]!.instance,
      factoryCreds[0]!.instance,
      factoryCreds[0]!.instance,
      factoryCreds[0]!.instance,
      factoryCreds[0]!.instance,
    ]);
  });

  test("rotated credentials (new envelope) → fingerprint mismatch rebuilds with the NEW PEM and replaces", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));

    const box = createSecretbox(TEST_KEY);
    db.raw
      .prepare("UPDATE review_bots SET private_key_enc = ? WHERE id = ?")
      .run(await box.encryptSecret(PEM_Y, keyAad(appX.id)), appX.id);

    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(factoryCreds).toHaveLength(2);
    expect(factoryCreds[0]!.cred).toEqual({ APP_ID: "111222", PRIVATE_KEY: PEM_X });
    expect(factoryCreds[1]!.cred).toEqual({ APP_ID: "111222", PRIVATE_KEY: PEM_Y });
    expect(appCalls.map((c) => c.instance)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  test("re-saved identical PEM → NEW envelope (random IV) → ONE harmless rebuild, same credential", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));

    const box = createSecretbox(TEST_KEY);
    db.raw
      .prepare("UPDATE review_bots SET private_key_enc = ? WHERE id = ?")
      .run(await box.encryptSecret(PEM_X, keyAad(appX.id)), appX.id);

    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(2);
    expect(factoryCreds[1]!.cred).toEqual(factoryCreds[0]!.cred);

    await consumer(makeBatch(makePayload({ pr_number: 44, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(2);
  });

  test("disabled gate EVICTS the cached instance — re-enabled App rebuilds instead of reusing the stale one", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);
    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(1);

    const store = createReviewBotsStore(db);
    await store.setAppStatus(appX.id, "disabled");
    await expect(
      consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/per-App credential resolution failed: app .* is disabled/);
    expect(factoryCreds).toHaveLength(1);

    await store.setAppStatus(appX.id, "active");
    await consumer(makeBatch(makePayload({ pr_number: 44, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(2);
    expect(factoryCreds[1]!.cred).toEqual({ APP_ID: "111222", PRIVATE_KEY: PEM_X });
    expect(appCalls.at(-1)!.instance).toBe(factoryCreds[1]!.instance);
  });

  test("soft-deleted gate EVICTS the cached instance (restored row rebuilds, never reuses the stale one)", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);
    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(1);

    await createReviewBotsStore(db).softDeleteApp(appX.id);
    await expect(
      consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/per-App credential resolution failed: app .* is soft-deleted/);

    db.raw.prepare("UPDATE review_bots SET deleted_at = NULL, status = 'active' WHERE id = ?").run(appX.id);
    db.raw.prepare("UPDATE review_targets SET deleted_at = NULL WHERE id = ?").run(appX.targetId);
    await consumer(makeBatch(makePayload({ pr_number: 44, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(2);
    expect(appCalls.at(-1)!.instance).toBe(factoryCreds[1]!.instance);
  });

  test("rogue provider row (id ∉ PROVIDERS) → structured warn {provider, app_id}, skip continues", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await createAppConfigStore(db, TEST_KEY).addProviderKey(appX.id, "not-a-provider", sk("rogue-SECRET"));
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const warn = logLines.find((l) => l.level === "warn" && l.fields.provider === "not-a-provider");
    expect(warn).toBeDefined();
    expect(warn!.fields.app_id).toBe(appX.id);
    expect(JSON.stringify(warn)).not.toContain(sk("rogue-SECRET"));
    expect(appCalls.map((c) => c.call.op)).toEqual(["token", "plan", "post"]);
    expect(kvPuts).toEqual([{ key: `idem:123:acme/widgets:42:${SHA}`, value: "done" }]);
  });
});

describe("per-App pause ack-skip (architect lock L4)", () => {
  test("the target's business pause (review_enabled=0) → the same direct ack, ZERO review work", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    db.raw.prepare("UPDATE review_targets SET review_enabled = 0 WHERE id = ?").run(appX.targetId);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(ackIds).toEqual(["m0"]);
    expect(retryIds).toEqual([]);
    expect(factoryCreds).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
    const bot = db.raw.query("SELECT review_enabled FROM review_bots WHERE id = ?").get(appX.id) as {
      review_enabled: number;
    };
    expect(bot.review_enabled).toBe(1);
  });

  test("paused App (review_enabled=0) → direct ack, ZERO sandbox/guard/token/config/GitHub calls, no retry, no DLQ", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    await createReviewBotsStore(db).setReviewEnabled(appX.id, false);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(ackIds).toEqual(["m0"]);
    expect(retryIds).toEqual([]);
    expect(factoryCreds).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(kvPuts).toEqual([
      {
        key: idemKey({ installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: SHA }),
        value: "paused",
      },
    ]);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(0);
    expect(logLines).toHaveLength(1);
    expect(logLines[0]!.level).toBe("info");
    expect(logLines[0]!.fields.event).toBe("review_paused");
    expect(logLines[0]!.fields.app_id).toBe(appX.id);
    expect(logLines[0]!.fields.installation_id).toBe(123);
    expect(logLines[0]!.fields.owner).toBe("acme");
    expect(logLines[0]!.fields.repo).toBe("widgets");
    expect(logLines[0]!.fields.pr_number).toBe(42);
    expect(logLines[0]!.fields.head_sha).toBe(SHA);
  });

  test("disabled is judged BEFORE paused: a disabled AND paused App keeps the throw→retry/DLQ semantics", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const store = createReviewBotsStore(db);
    await store.setReviewEnabled(appX.id, false);
    await store.setAppStatus(appX.id, "disabled");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })))).rejects.toThrow(
      /per-App credential resolution failed: app .* is disabled/,
    );

    expect(ackIds).toEqual([]);
    expect(retryIds).toEqual([]);
    expect(logLines.some((l) => l.fields.event === "review_paused")).toBe(false);
    expect(sandboxCalls).toHaveLength(0);
  });

  test("paused gate does NOT evict the cached instance — resume reuses the warm instance on the next review", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const store = createReviewBotsStore(db);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(1);

    await store.setReviewEnabled(appX.id, false);
    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(ackIds).toEqual(["m0", "m0"]);
    expect(factoryCreds).toHaveLength(1);

    await store.setReviewEnabled(appX.id, true);
    await consumer(makeBatch(makePayload({ pr_number: 44, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(1);
    expect(appCalls.filter((c) => c.call.op === "post")).toHaveLength(2);
    expect(appCalls.at(-1)!.instance).toBe(factoryCreds[0]!.instance);
  });

  test("not-found gate EVICTS the cached instance (re-created identical row rebuilds, never reuses the stale one)", async () => {
    reset();
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", githubAppId: 111222, pem: PEM_X });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);
    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(1);

    const row = db.raw.query("SELECT * FROM review_bots WHERE id = ?").get(appX.id) as {
      id: string;
      github_app_id: number;
      name: string;
      private_key_enc: string;
      webhook_secret_enc: string;
      created_by: string;
      status: string;
      deleted_at: string | null;
      created_at: string;
      updated_at: string;
    };
    db.raw.prepare("DELETE FROM reviews WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM bot_model_config WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM bot_model_chain_seats WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM bot_model_chains WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM bot_provider_keys WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM review_finding_rounds WHERE finding_row_id IN (SELECT id FROM review_findings WHERE bot_id = ?)").run(appX.id);
    db.raw.prepare("DELETE FROM review_threads WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM review_checks WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM review_findings WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM review_publications WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM bot_workspaces WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM review_failures WHERE target_id = ?").run(appX.targetId);
    db.raw.prepare("DELETE FROM review_targets WHERE bot_id = ?").run(appX.id);
    db.raw.prepare("DELETE FROM review_bots WHERE id = ?").run(appX.id);
    await expect(
      consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/per-App credential resolution failed: app .* not found/);
    expect(factoryCreds).toHaveLength(1);

    db.raw
      .prepare(
        `INSERT INTO review_bots (id, github_app_id, name, private_key_enc, webhook_secret_enc,
           created_by, status, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.github_app_id, row.name, row.private_key_enc, row.webhook_secret_enc, row.created_by, row.status, row.deleted_at, row.created_at, row.updated_at);
    await mapAppToDefaultWorkspace(db, row.id);
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES (?, 'default', ?, ?, 'tester', datetime('now'), datetime('now'))`,
      )
      .run(appX.targetId, row.id, row.name);
    const configStore = createAppConfigStore(db, TEST_KEY);
    await configStore.setModelChain(row.id, "ark/deepseek-v4-flash");
    await configStore.addProviderKey(row.id, "ark", "ark-key");
    await consumer(makeBatch(makePayload({ pr_number: 44, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(factoryCreds).toHaveLength(2);
    expect(factoryCreds[1]!.cred).toEqual({ APP_ID: "111222", PRIVATE_KEY: PEM_X });
    expect(appCalls.at(-1)!.instance).toBe(factoryCreds[1]!.instance);
  });
});
