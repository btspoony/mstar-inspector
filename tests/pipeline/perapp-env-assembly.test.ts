
import { describe, expect, mock, test } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ReviewOutput } from "../../src/review/schema";
import { createMigratedTestD1, mapAppToDefaultWorkspace } from "../store/helpers";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { getSandboxImage } from "../../src/contracts/sandbox-images";
import { MODEL_LIMITS } from "../../src/contracts/provider-model-limits.generated";
import { PROVIDER_CATALOG } from "../../src/contracts/provider-catalog.generated";
import { sk, fakePem } from "../helpers/fake-secrets";
import { withFrozenClock } from "../helpers/clock";
import { inlineWorkflowStarter } from "../helpers/workflow-route";
import type { CommenterEnv, InstallationTokenGrant, ReviewCommenter, TokenInput } from "../../src/pipeline/comment";
import type { ConsumerLog, ConsumerLogFields, PipelineEnv } from "../../src/pipeline/consumer";
import { runnerTimeoutMs } from "../../src/review-budget";

const TEST_KEY = Buffer.alloc(32, 11).toString("base64");
const PEM_X = fakePem("FAKE-APP-X-PEM");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ARK_KEY = "ark-key";

const VALID_OUTPUT: ReviewOutput = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "One issue found in the diff.",
  findings: [],
};


let githubAppIdSeq = 100000;

async function seedApp(
  db: ReturnType<typeof createMigratedTestD1>,
  slug: string,
  opts: { configured?: boolean } = {},
): Promise<{ id: string; targetId: string }> {
  const id = crypto.randomUUID();
  const githubAppId = ++githubAppIdSeq;
  const box = createSecretbox(TEST_KEY);
  const privateKeyEnc = await box.encryptSecret(PEM_X, `github_apps.private_key_enc:${id}`);
  const webhookSecretEnc = await box.encryptSecret(`whsec-${slug}`, `github_apps.webhook_secret_enc:${id}`);
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, githubAppId, slug, privateKeyEnc, webhookSecretEnc);
  await mapAppToDefaultWorkspace(db, id);
  const targetId = `target-${id}`;
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
       VALUES (?, 'default', ?, ?, 'tester', datetime('now'), datetime('now'))`,
    )
    .run(targetId, id, slug);
  if (opts.configured !== false) {
    await configureApp(db, id);
  }
  return { id, targetId };
}

async function configureApp(
  db: ReturnType<typeof createMigratedTestD1>,
  appId: string,
  chain = "ark/deepseek-v4-flash",
  extraKeys: Record<string, string> = {},
): Promise<void> {
  const store = createAppConfigStore(db, TEST_KEY);
  await store.setModelChain(appId, chain);
  await store.addProviderKey(appId, "ark", ARK_KEY);
  for (const [provider, key] of Object.entries(extraKeys)) {
    await store.addProviderKey(appId, provider, key);
  }
}

async function mapRole(
  db: ReturnType<typeof createMigratedTestD1>,
  appId: string,
  role: string,
  selector: string,
): Promise<void> {
  const store = createAppConfigStore(db, TEST_KEY);
  const chainName = `seat-${role}`;
  await store.upsertModelChain(appId, chainName, selector);
  await store.setModelChainSeat(appId, role, chainName);
}

async function seedTamperedKey(
  db: ReturnType<typeof createMigratedTestD1>,
  appId: string,
  provider: string,
): Promise<void> {
  const keyEnc = await createSecretbox(TEST_KEY).encryptSecret(
    sk("tampered-SECRET"),
    "app_provider_keys.key_enc:not-this-row",
  );
  db.raw
    .prepare(
      `INSERT INTO bot_provider_keys (bot_id, provider, key_id, key_enc, created_at)
       VALUES (?, ?, 'deadbeefdeadbeef', ?, datetime('now'))`,
    )
    .run(appId, provider, keyEnc);
}


const sandboxCalls: Array<{ cmd: string; opts?: unknown; startedAt: number }> = [];
let numstatStdout = "";

let appliedModelDoc: string | undefined;

const fakeSandbox = {
  runCommand: mock(async (cmd: string, opts?: unknown) => {
    sandboxCalls.push({ cmd, opts, startedAt: Date.now() });
    if (cmd.includes("review-applied-model.json")) {
      return appliedModelDoc === undefined
        ? { stdout: "\n2\n", stderr: "", exitCode: 0 }
        : { stdout: `${appliedModelDoc}\n0\n`, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("rev-parse")) {
      return { stdout: `${SHA}\n`, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("--numstat")) {
      return { stdout: numstatStdout, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("--input")) {
      return { stdout: JSON.stringify(VALID_OUTPUT), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }),
  claimMarker: mock(async () => "written" as const),
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


const appCalls: string[] = [];

const appCommenterFactory = mock((_cred: CommenterEnv): ReviewCommenter => ({
  getInstallationToken: mock(async (input: TokenInput) => {
    appCalls.push("token");
    return {
      token: "app-token",
      permissions: { contents: "read", metadata: "read", pull_requests: "read" },
      repositoryNames: [input.scope.repo],
      repositorySelection: "selected",
    } satisfies InstallationTokenGrant;
  }),
  planReviewUpsert: mock(async () => {
    appCalls.push("plan");
    return { action: "create", round: 1 } as const;
  }),
  planDegradedUpsert: mock(async () => {
    appCalls.push("plan-degraded");
    return { action: "create", round: 1 } as const;
  }),
  postPreparedReview: mock(async () => {
    appCalls.push("post");
    return { commentId: 101 };
  }),
  postPreparedDegraded: mock(async () => {
    appCalls.push("degrade");
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
}));

const testOverrides = {
  createAppCommenter: appCommenterFactory,
  getSandbox: async () => fakeSandbox,
  startAttempt: inlineWorkflowStarter([]),
};


const { createReviewConsumer } = await import(
  "../../src/pipeline/consumer"
);


const logLines: Array<{ level: "info" | "warn" | "error"; fields: ConsumerLogFields; msg: string }> = [];
const testLog: ConsumerLog = {
  info: (fields, msg) => logLines.push({ level: "info", fields, msg: msg ?? "" }),
  warn: (fields, msg) => logLines.push({ level: "warn", fields, msg: msg ?? "" }),
  error: (fields, msg) => logLines.push({ level: "error", fields, msg: msg ?? "" }),
};


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
      retry: () => {},
      ack: () => {},
    })),
  } as unknown as MessageBatch<ReviewJobPayload>;
}

function reset(): void {
  appliedModelDoc = undefined;
  sandboxCalls.length = 0;
  appCalls.length = 0;
  kvGuardPuts.length = 0;
  logLines.length = 0;
  numstatStdout = "";
}

function expectOuterDeadline(input: Record<string, unknown>): void {
  const runner = sandboxCalls.find((c) => c.cmd.includes("--input"));
  if (runner === undefined) throw new Error("no runner exec was issued");
  const opts = runner.opts;
  const execDeadline =
    opts !== null && typeof opts === "object" && "deadlineEpochMs" in opts ? opts.deadlineEpochMs : undefined;
  if (typeof execDeadline !== "number") throw new Error("runner exec carried no numeric deadlineEpochMs");
  expect(input.outerDeadlineEpochMs).toBe(execDeadline);
}

const RUNNER_INPUT_BASE_FIELDS = ["capabilityHosts", "outerDeadlineEpochMs", "reconFacts", "worktreePath"];

function expectRunnerInputFields(input: Record<string, unknown>, extra: string[] = []): void {
  expect(Object.keys(input).sort()).toEqual([...RUNNER_INPUT_BASE_FIELDS, ...extra].sort());
}

function runnerEnvs(): Array<Record<string, string>> {
  return sandboxCalls
    .filter((c) => c.cmd.includes("bun run"))
    .map((c) => (c.opts as { env?: Record<string, string> }).env ?? {});
}

function runnerPools(): Array<Record<string, string[]> | undefined> {
  return sandboxCalls
    .filter((c) => c.cmd.includes("bun run"))
    .map((c) => {
      const stdin = (c.opts as { stdin?: string }).stdin;
      return stdin === undefined
        ? undefined
        : (JSON.parse(stdin) as { version: number; pools: Record<string, string[]> }).pools;
    });
}

function runnerInputs(): Array<Record<string, unknown>> {
  return sandboxCalls
    .filter((c) => c.cmd.includes("base64 -d > '/workspace/review-input.json'"))
    .map((c) => {
      const stdin = (c.opts as { stdin?: string } | undefined)?.stdin;
      if (stdin === undefined) throw new Error("runner-input write arrived without a stdin payload");
      return JSON.parse(Buffer.from(stdin, "base64").toString("utf8")) as Record<string, unknown>;
    });
}

function keySourceLines(): Array<{ fields: ConsumerLogFields; msg: string }> {
  return logLines.filter((l) => l.fields.key_source !== undefined);
}

describe("per-App runner env assembly (spec § Per-App BYOK)", () => {
  test("app-key: the App's own keys ride the credential payload (per-App BYOK, incl. ark → the ark pool)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", {
      anthropic: sk("app-x-SECRET"),
      openai: sk("app-x-openai-SECRET"),
    });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const env = runnerEnvs()[0]!;
    const pools = runnerPools()[0]!;
    expect(pools.anthropic).toEqual([sk("app-x-SECRET")]);
    expect(pools.openai).toEqual([sk("app-x-openai-SECRET")]);
    expect(pools.ark).toEqual([ARK_KEY]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ARK_API_KEY).toBeUndefined();
    expect(env.OMP_REVIEW_MODEL).toBe("openai/gpt-app,anthropic/claude-app");
    expect(env.MSTAR_POOL_ARK_01).toBeUndefined();
    expect(env.MSTAR_POOL_ANTHROPIC_COUNT).toBeUndefined();
    expect(pools.mistral).toBeUndefined();
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ anthropic: "app", openai: "app", ark: "app" });
    const cfgLine = logLines.find((l) => l.fields.config_source !== undefined);
    expect(cfgLine?.fields.config_source).toBe("app");
    expect(appCalls).toEqual(["token", "plan", "post"]);
  });

  test("chain provider without a configured key → fail closed after App resolution, no global fallback (AL-24-5)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/per-App config incomplete: app .*provider openai has no configured key/);

    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App config incomplete");
    expect(errLine!.fields.app_id).toBe(appX.id);
    const rows = db.raw.query("SELECT stage, error FROM review_failures").all() as Array<{ stage: string; error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("pipeline");
    expect(rows[0]!.error).toContain("provider openai has no configured key");
  });

  test("two keys for one provider ride the payload as an ordered pair, with no scalar env name", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "pool-app");
    await configureApp(db, appX.id, "openai/gpt-app");
    const store = createAppConfigStore(db, TEST_KEY);
    const keys = [sk("pool-one"), sk("pool-two")];
    for (const key of keys) await store.addProviderKey(appX.id, "openai", key);
    const expected = (await store.getAppConfig(appX.id)).keys.openai!;
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const env = runnerEnvs()[0]!;
    expect(runnerPools()[0]!.openai).toEqual(expected);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("mixed per-App keys: every configured provider injects; unconfigured providers stay absent", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", {
      anthropic: sk("app-x-SECRET"),
      openai: sk("app-x-openai-SECRET"),
    });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const pools = runnerPools()[0]!;
    expect(pools.anthropic).toEqual([sk("app-x-SECRET")]);
    expect(pools.openai).toEqual([sk("app-x-openai-SECRET")]);
    expect(pools.ark).toEqual([ARK_KEY]);
    expect(pools.groq).toBeUndefined();
    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ anthropic: "app", openai: "app", ark: "app" });
    const cfgLine = logLines.find((l) => l.fields.config_source !== undefined);
    expect(cfgLine?.fields.config_source).toBe("app");
  });

  test("App with no AI config at all → fail closed: missing model chain (zero-config is not a valid review state)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x", { configured: false });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/per-App config incomplete: app .*missing model chain/);

    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App config incomplete");
    expect(errLine!.fields.app_id).toBe(appX.id);
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
      openai: sk("x-openai"),
      anthropic: sk("x-anthropic"),
    });
    const appY = await seedApp(db, "app-y", { configured: false });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }),
          makePayload({ pr_number: 43, botRef: { appId: appY.id }, targetId: appY.targetId }),
        ),
      ),
    ).rejects.toThrow(/per-App config incomplete: app .*missing model chain/);

    const xEnv = runnerEnvs()[0]!;
    expect(xEnv.OMP_REVIEW_MODEL).toBe("openai/gpt-app,anthropic/claude-app");
    const cfgLines = logLines.filter((l) => l.fields.config_source !== undefined);
    expect(cfgLines[0]?.fields.config_source).toBe("app");
    expect(appCalls).toEqual(["token", "plan", "post"]);
    const rows = db.raw.query("SELECT model FROM reviews").all() as Array<{ model: string | null }>;
    expect(rows).toEqual([{ model: "openai/gpt-app" }]);
    const failRows = db.raw.query("SELECT error FROM review_failures").all() as Array<{ error: string }>;
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.error).toContain("missing model chain");
  });

  test("blank chain via direct-DB write fails closed; a padded real chain forwards VERBATIM (trim guard)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x", { configured: false });
    const appY = await seedApp(db, "app-y", { configured: false });
    db.raw
      .prepare(
        `INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at)
         VALUES (?, 'default', '   ', 1, datetime('now'), datetime('now'))`,
      )
      .run(appX.id);
    const padded = "  openai/gpt-padded , anthropic/claude-padded  ";
    db.raw
      .prepare(
        `INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at)
         VALUES (?, 'default', ?, 1, datetime('now'), datetime('now'))`,
      )
      .run(appY.id, padded);
    const store = createAppConfigStore(db, TEST_KEY);
    await store.addProviderKey(appY.id, "openai", sk("y-o"));
    await store.addProviderKey(appY.id, "anthropic", sk("y-a"));
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 43, botRef: { appId: appY.id }, targetId: appY.targetId }),
          makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }),
        ),
      ),
    ).rejects.toThrow(/per-App config incomplete: app .*missing model chain/);

    const yEnv = runnerEnvs()[0]!;
    expect(yEnv.OMP_REVIEW_MODEL).toBe(padded);
    expect(runnerPools()[0]!.openai).toEqual([sk("y-o")]);
    const cfgLines = logLines.filter((l) => l.fields.config_source !== undefined);
    expect(cfgLines[0]?.fields.config_source).toBe("app");
    const failRows = db.raw.query("SELECT error FROM review_failures").all() as Array<{ error: string }>;
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.error).toContain("missing model chain");
    const rows = db.raw.query("SELECT pr_number, model FROM reviews ORDER BY pr_number").all() as Array<{
      pr_number: number;
      model: string | null;
    }>;
    expect(rows).toEqual([{ pr_number: 43, model: "openai/gpt-padded" }]);
  });

  test("version records: reviews.model = the App chain's head selector; provider always NULL", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const appY = await seedApp(db, "app-y");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", { openai: sk("x-o"), anthropic: sk("x-a") });
    await configureApp(db, appY.id, "ark/deepseek-v4-flash,groq/backup", { groq: sk("y-g") });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }),
        makePayload({ pr_number: 43, botRef: { appId: appY.id }, targetId: appY.targetId }),
      ),
    );

    const rows = db.raw
      .query("SELECT pr_number, model, provider FROM reviews ORDER BY pr_number")
      .all() as Array<{ pr_number: number; model: string | null; provider: string | null }>;
    expect(rows).toEqual([
      { pr_number: 42, model: "openai/gpt-app", provider: null },
      { pr_number: 43, model: "ark/deepseek-v4-flash", provider: null },
    ]);
  });

  test("version records: a chain-less App never writes a review — fail closed, no NULL-model row (AL-24-5)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x", { configured: false });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })))).rejects.toThrow(
      /per-App config incomplete: app .*missing model chain/,
    );
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(0);
  });

  test("cross-App isolation: App X's env never contains App Y's key names or values (full env object)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const appY = await seedApp(db, "app-y");
    await configureApp(db, appX.id, "openai/gpt-app", { openai: sk("x-openai-SECRET") });
    await configureApp(db, appY.id, "anthropic/claude-app", { anthropic: sk("y-anthropic-SECRET") });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(
      makeBatch(
        makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }),
        makePayload({ pr_number: 43, botRef: { appId: appY.id }, targetId: appY.targetId }),
        makePayload({ pr_number: 44, botRef: { appId: appX.id }, targetId: appX.targetId }),
      ),
    );

    const [xEnv, yEnv, xEnvAgain] = runnerEnvs() as [Record<string, string>, Record<string, string>, Record<string, string>];
    const [xPools, yPools, xPoolsAgain] = runnerPools();
    expect(xEnv).toEqual({
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      OMP_REVIEW_MODEL: "openai/gpt-app",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
    });
    expect(xPools).toEqual({ ark: [ARK_KEY], openai: [sk("x-openai-SECRET")] });
    expect(yEnv).toEqual({
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      OMP_REVIEW_MODEL: "anthropic/claude-app",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
    });
    expect(yPools).toEqual({ ark: [ARK_KEY], anthropic: [sk("y-anthropic-SECRET")] });
    expect(xPoolsAgain).toEqual(xPools);
    expect(Object.values(xEnv)).not.toContain(sk("y-anthropic-SECRET"));
    expect(Object.values(yEnv)).not.toContain(sk("x-openai-SECRET"));
    expect(JSON.stringify(xPools)).not.toContain(sk("y-anthropic-SECRET"));
    expect(JSON.stringify(yPools)).not.toContain(sk("x-openai-SECRET"));
  });

  test("secrets never logged: key_source/config_source lines carry ids only, never key material", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app", { openai: sk("app-x-openai-SECRET") });
    const secrets = [sk("app-x-openai-SECRET"), ARK_KEY, sk("tampered-SECRET")];
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const sources = Object.fromEntries(keySourceLines().map((l) => [l.fields.provider, l.fields.key_source]));
    expect(sources).toEqual({ openai: "app", ark: "app" });
    expect(logLines.some((l) => l.fields.config_source !== undefined)).toBe(true);
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
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/per-App config resolution failed/);

    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App config resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
    expect(JSON.stringify(logLines)).not.toContain(sk("tampered-SECRET"));
  });

  test("DASHBOARD_ENCRYPTION_KEY missing → App messages fail closed (SecretboxKeyError)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appY = await seedApp(db, "app-y");
    await configureApp(db, appY.id, "openai/gpt-app", { openai: sk("y-openai-SECRET") });
    const consumer = createReviewConsumer(
      makeEnv({ DB: db as never, DASHBOARD_ENCRYPTION_KEY: undefined }),
      testLog,
      testOverrides,
    );

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appY.id }, targetId: appY.targetId }))),
    ).rejects.toThrow(/DASHBOARD_ENCRYPTION_KEY is not set/);
    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
  });

  test("config is re-read per message: a dashboard key update applies to the very next review", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.addProviderKey(appX.id, "anthropic", sk("v1-SECRET"));
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(runnerPools()[0]!.anthropic).toEqual([sk("v1-SECRET")]);

    await store.addProviderKey(appX.id, "anthropic", sk("v2-SECRET"));
    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));
    const second = runnerPools()[1]!.anthropic!;
    expect(second).toHaveLength(2);
    expect(second).toContain(sk("v1-SECRET"));
    expect(second).toContain(sk("v2-SECRET"));
  });

  test("a provider id outside the PROVIDERS allowlist is never injected (no env name, no crash)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await createAppConfigStore(db, TEST_KEY).addProviderKey(appX.id, "not-a-provider", sk("rogue-SECRET"));
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(runnerEnvs()[0]).toEqual({
      HARNESS_PLUGIN_ROOT: "/opt/mstar-harness",
      PI_CODING_AGENT_DIR: "/opt/omp-agent",
      OMP_REVIEW_MODEL: "ark/deepseek-v4-flash",
    });
    expect(runnerPools()[0]).toEqual({ ark: [ARK_KEY] });
    const warn = logLines.find((l) => l.level === "warn" && l.fields.provider === "not-a-provider");
    expect(warn).toBeDefined();
    expect(warn!.fields.app_id).toBe(appX.id);
    expect(JSON.stringify(warn)).not.toContain(sk("rogue-SECRET"));
  });

  test("whitespace-only App key on a chain provider → fail closed (no global fallback)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", { openai: sk("x-openai") });
    await createAppConfigStore(db, TEST_KEY).addProviderKey(appX.id, "anthropic", "   ");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
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
      openai: sk("healthy-openai-SECRET"),
      anthropic: sk("healthy-anthropic-SECRET"),
    });
    const missingKey = await seedApp(db, "missing-key");
    await configureApp(db, missingKey.id, "openai/gpt-app,anthropic/claude-app", { openai: sk("mk-openai") });
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 42, botRef: { appId: healthy.id }, targetId: healthy.targetId }),
          makePayload({ pr_number: 43, botRef: { appId: missingKey.id }, targetId: missingKey.targetId }),
        ),
      ),
    ).rejects.toThrow(/per-App config incomplete/);

    const env = runnerEnvs()[0]!;
    const pools = runnerPools()[0]!;
    expect(pools.openai).toEqual([sk("healthy-openai-SECRET")]);
    expect(pools.anthropic).toEqual([sk("healthy-anthropic-SECRET")]);
    expect(pools.ark).toEqual([ARK_KEY]);
    expect(env.OMP_REVIEW_MODEL).toBe("openai/gpt-app,anthropic/claude-app");
    expect(appCalls).toEqual(["token", "plan", "post"]);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(1);
    const failRows = db.raw
      .query("SELECT error, head_sha FROM review_failures ORDER BY rowid")
      .all() as Array<{ error: string; head_sha: string }>;
    expect(failRows).toHaveLength(1);
    expect(failRows[0]!.error).toContain("provider anthropic has no configured key");
    expect(failRows[0]!.head_sha).toBe(SHA);
    expect(JSON.stringify(env)).not.toContain(sk("mk-openai"));
    expect(JSON.stringify(logLines)).not.toContain(sk("mk-openai"));
    expect(JSON.stringify(logLines)).toContain(healthy.id);
  });
});


describe("runner input modelOverrides threading", () => {
  test("app message with a role map: the input JSON carries modelOverrides exactly as mapped (:thinking suffix verbatim)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "ark/deepseek-v4-flash", {
      openai: sk("x-openai"),
      anthropic: sk("x-anthropic"),
    });
    const store = createAppConfigStore(db, TEST_KEY);
    await mapRole(db, appX.id, "mstar-review-seat", "ark/deepseek-v4-flash:high");
    await mapRole(db, appX.id, "code-reviewer", "openai/gpt-5:thinking, anthropic/claude-x");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    const startedAt = await withFrozenClock(async (clock) => {
      await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));
      return clock.now;
    });

    const input = runnerInputs()[0]!;
    expect(input.modelOverrides).toEqual({
      "mstar-review-seat": "ark/deepseek-v4-flash:high",
      "code-reviewer": "openai/gpt-5:thinking, anthropic/claude-x",
    });
    expectOuterDeadline(input);
    expect(input.outerDeadlineEpochMs as number).toBeLessThanOrEqual(startedAt + runnerTimeoutMs("default"));
    expectRunnerInputFields(input, ["modelOverrides"]);
  });

  test("app message with NO role map: input JSON omits the field entirely (no-map run)", async () => {
    reset();
    numstatStdout = "1\t1\tdocs/中文.md\n";
    const appDb = createMigratedTestD1();
    const appX = await seedApp(appDb, "app-x");
    const appConsumer = createReviewConsumer(makeEnv({ DB: appDb as never }), testLog, testOverrides);
    await withFrozenClock(() =>
      appConsumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }))),
    );
    const [appInput] = runnerInputs();
    expectOuterDeadline(appInput!);
    expect(appInput!.modelOverrides).toBeUndefined();
    expectRunnerInputFields(appInput!);
    expect(appInput!.reconFacts).toContain("1\t1\tdocs/中文.md");
  });

  test("an all-cleared role map resolves to NO field (empty map = current behavior)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await mapRole(db, appX.id, "mstar-review-seat", "first/model");
    await store.clearModelChainSeat(appX.id, "mstar-review-seat");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await withFrozenClock(() => consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))));

    const input = runnerInputs()[0]!;
    expectOuterDeadline(input);
    expectRunnerInputFields(input);
    expect(input.modelOverrides).toBeUndefined();
  });

  test("role maps are re-read per message: a dashboard role update applies to the very next review", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "ark/deepseek-v4-flash", { openai: sk("x-openai") });
    const store = createAppConfigStore(db, TEST_KEY);
    await mapRole(db, appX.id, "code-reviewer", "openai/v1");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    await mapRole(db, appX.id, "code-reviewer", "openai/v2");
    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));

    const [first, second] = runnerInputs();
    expect(first!.modelOverrides).toEqual({ "code-reviewer": "openai/v1" });
    expect(second!.modelOverrides).toEqual({ "code-reviewer": "openai/v2" });
  });

  test("a roles-read failure rethrows with the per-App context wrapper (mirror of resolveAppConfig), zero side effects", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            if (query.includes("FROM bot_model_chain_seats")) throw new Error("roles read boom");
            return (target as typeof db).prepare(query);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const consumer = createReviewConsumer(makeEnv({ DB: failingDb as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(`per-App model-role resolution failed: app ${appX.id}: roles read boom`);

    expect(sandboxCalls).toHaveLength(0);
    expect(runnerInputs()).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App model-role resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
  });
});

describe("per-role override provider key gate (Bugbot 7aaf18f4)", () => {
  test("role override referencing a provider with no key → fail closed via the gate, healthy sibling completes (stage=pipeline row)", async () => {
    reset();
    const db = createMigratedTestD1();
    const healthy = await seedApp(db, "healthy");
    await configureApp(db, healthy.id, "openai/gpt-app", { openai: sk("healthy-openai") });
    const badOverride = await seedApp(db, "bad-override");
    await configureApp(db, badOverride.id, "openai/gpt-app", { openai: sk("bo-openai") });
    const store = createAppConfigStore(db, TEST_KEY);
    await mapRole(db, badOverride.id, "code-reviewer", "anthropic/claude-x");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(
        makeBatch(
          makePayload({ pr_number: 42, botRef: { appId: healthy.id }, targetId: healthy.targetId }),
          makePayload({ pr_number: 43, botRef: { appId: badOverride.id }, targetId: badOverride.targetId }),
        ),
      ),
    ).rejects.toThrow(
      /per-App config incomplete: app .*role override `code-reviewer` provider anthropic has no configured key/,
    );

    expect(runnerPools()[0]!.openai).toEqual([sk("healthy-openai")]);
    expect(appCalls).toEqual(["token", "plan", "post"]);
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
    await configureApp(db, appX.id, "openai/gpt-app", { openai: sk("x-openai") });
    const store = createAppConfigStore(db, TEST_KEY);
    await mapRole(db, appX.id, "code-reviewer", "openai/gpt-5:thinking, openai/gpt-5-mini");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const input = runnerInputs()[0]!;
    expect(input.modelOverrides).toEqual({ "code-reviewer": "openai/gpt-5:thinking, openai/gpt-5-mini" });
    expect(runnerPools()[0]!.openai).toEqual([sk("x-openai")]);
    expect(appCalls).toEqual(["token", "plan", "post"]);
  });

  test("role override referencing a CUSTOM provider declaration (with key) → gate passes, override reaches the runner input", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app", { openai: sk("x-openai") });
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["m1"],
      },
      sk("custom-fixture-AAA"),
    );
    await mapRole(db, appX.id, "frontend-dev", "my-provider/m1");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const input = runnerInputs()[0]!;
    expect(input.modelOverrides).toEqual({ "frontend-dev": "my-provider/m1" });
    expect(appCalls).toEqual(["token", "plan", "post"]);
  });
});

describe("applied-provider attribution (runner observation → reviews.provider)", () => {
  const storedProvider = async (db: ReturnType<typeof createMigratedTestD1>): Promise<string | null> => {
    const row = db.raw.query("SELECT provider FROM reviews WHERE pr_number = 42").get() as {
      provider: string | null;
    } | null;
    return row?.provider ?? null;
  };

  test("a round whose seat applied the SECOND selector stores that provider, not the chain head", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", {
      anthropic: sk("app-x-SECRET"),
      openai: sk("app-x-openai-SECRET"),
    });
    appliedModelDoc = JSON.stringify({ appliedModel: "anthropic/claude-app" });

    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);
    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(await storedProvider(db)).toBe("anthropic/claude-app");
    const model = db.raw.query("SELECT model FROM reviews WHERE pr_number = 42").get() as {
      model: string | null;
    };
    expect(model.model).toBe("openai/gpt-app");
  });

  test("a malformed or oversized applied-model document is refused, not persisted", async () => {
    for (const doc of [
      JSON.stringify({ appliedModel: "anthropic" }),
      JSON.stringify({ appliedModel: "/claude-app" }),
      JSON.stringify({ appliedModel: "anthropic/claude app" }),
      JSON.stringify({ appliedModel: `a/${"b".repeat(300)}` }),
      JSON.stringify({ appliedModel: 42 }),
      JSON.stringify({ appliedModel: "" }),
    ]) {
      reset();
      const db = createMigratedTestD1();
      const appX = await seedApp(db, "app-x");
      await configureApp(db, appX.id, "openai/gpt-app", { openai: sk("app-x-openai-SECRET") });
      appliedModelDoc = doc;

      const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);
      await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

      const row = db.raw.query("SELECT provider FROM reviews WHERE pr_number = 42").get() as {
        provider: string | null;
      };
      expect(row.provider, doc).toBeNull();
      expect(logLines.some((line) => line.fields.applied_model === "invalid-document"), doc).toBe(true);
    }
  });

  test("a round that applied NO model leaves provider null — never the chain head", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "openai/gpt-app,anthropic/claude-app", {
      anthropic: sk("app-x-SECRET"),
      openai: sk("app-x-openai-SECRET"),
    });
    appliedModelDoc = undefined;

    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);
    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    expect(await storedProvider(db)).toBeNull();
    expect(logLines.some((line) => line.fields.applied_model === "absent")).toBe(false);
  });
});

describe("custom provider credential transport + runner input threading (AL-23-1)", () => {
  test("app with custom providers: the payload carries their pools, the input JSON carries keyless declarations", async () => {
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
      sk("custom-fixture-AAA"),
    );
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "second-one",
        base_url: "https://second.example.com/v1",
        api: "anthropic-messages",
        model_ids: ["b-model"],
      },
      sk("custom-fixture-BBB"),
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await withFrozenClock(() => consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))));

    const env = runnerEnvs()[0]!;
    const pools = runnerPools()[0]!;
    expect(pools["my-provider"]).toEqual([sk("custom-fixture-AAA")]);
    expect(pools["second-one"]).toEqual([sk("custom-fixture-BBB")]);
    expect(pools.ark).toEqual([ARK_KEY]);
    expect(env.PI_CODING_AGENT_DIR).toBe("/opt/omp-agent");
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
    expectOuterDeadline(input);
    expectRunnerInputFields(input, ["customProviders"]);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain(sk("custom-fixture"));
  });

  test("model metadata rides the input verbatim, and an absent overlay stays absent (never {})", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    const meta = {
      "my-model-1": {
        contextWindow: 128_000,
        maxTokens: 8_192,
        name: "My Model 1",
        reasoning: true,
        input: ["text"],
      },
      "my-model-2": { contextWindow: 32_000, maxTokens: 4_096 },
    };
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["my-model-1", "my-model-2"],
        models_meta: meta,
      },
      sk("custom-fixture-AAA"),
    );
    await store.upsertCustomProvider(
      appX.id,
      {
        provider_id: "id-only",
        base_url: "https://id-only.example.com/v1",
        api: "anthropic-messages",
        model_ids: ["b-model"],
      },
      sk("custom-fixture-BBB"),
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await withFrozenClock(() => consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))));

    const input = runnerInputs()[0]!;
    expect(input.customProviders).toEqual([
      {
        provider_id: "id-only",
        base_url: "https://id-only.example.com/v1",
        api: "anthropic-messages",
        model_ids: ["b-model"],
      },
      {
        provider_id: "my-provider",
        base_url: "https://my-provider.example.com/v1",
        api: "openai-completions",
        model_ids: ["my-model-1", "my-model-2"],
        models_meta: meta,
      },
    ]);
    expect("models_meta" in (input.customProviders as Array<Record<string, unknown>>)[0]!).toBe(false);
    expect(JSON.stringify(input)).not.toContain(sk("custom-fixture"));
  });

  test("chain referencing a custom provider id passes the fail-closed gate and transports its pool (qc3 F-001 — custom branch)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
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
      sk("custom-fixture-AAA"),
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const env = runnerEnvs()[0]!;
    expect(runnerPools()[0]!["my-provider"]).toEqual([sk("custom-fixture-AAA")]);
    expect(env.OMP_REVIEW_MODEL).toBe("my-provider/model-1");
    expect(appCalls).toEqual(["token", "plan", "post"]);
    const customLines = keySourceLines().filter((l) => l.fields.key_source === "custom");
    expect(customLines).toHaveLength(1);
    expect(customLines[0]!.fields.provider).toBe("my-provider");
    expect(customLines[0]!.msg).toContain("my-provider");
  });

  test("custom providers: keys never reach logs — key_source: custom lines carry ids and counts only", async () => {
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
      sk("custom-fixture-AAA"),
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const customLines = keySourceLines().filter((l) => l.fields.key_source === "custom");
    expect(customLines).toHaveLength(1);
    expect(customLines[0]!.fields.provider).toBe("my-provider");
    expect(customLines[0]!.msg).toContain("my-provider");
    for (const line of logLines) {
      expect(JSON.stringify(line.fields)).not.toContain(sk("custom-fixture"));
      expect(line.msg).not.toContain(sk("custom-fixture"));
    }
  });

  test("a chain naming the retired ark-plan provider fails with the migration step", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    await configureApp(db, appX.id, "ark-plan/deepseek-v4-flash");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/the ark-plan provider was removed — point the chain at a provider the runtime serves/);
  });

  test("app with NO custom providers: input JSON + payload carry no custom-provider surface (byte-identical to a no-declaration run)", async () => {
    reset();
    const appDb = createMigratedTestD1();
    const appX = await seedApp(appDb, "app-x");
    const appConsumer = createReviewConsumer(makeEnv({ DB: appDb as never }), testLog, testOverrides);
    await withFrozenClock(() =>
      appConsumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }))),
    );
    const [appInput] = runnerInputs();
    const [appEnv] = runnerEnvs();
    expectOuterDeadline(appInput!);
    expect(appInput!.customProviders).toBeUndefined();
    expectRunnerInputFields(appInput!);
    expect(runnerPools()[0]).toEqual({ ark: [ARK_KEY] });
    expect(Object.keys(appEnv!).filter((name) => name.startsWith("MSTAR_POOL_"))).toEqual([]);
  });

  test("custom providers are re-read per message: a dashboard declaration update applies to the very next review", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const store = createAppConfigStore(db, TEST_KEY);
    await store.upsertCustomProvider(
      appX.id,
      { provider_id: "my-provider", base_url: "https://one.example.com/v1", api: "openai-completions", model_ids: ["m1"] },
      sk("custom-fixture-AAA"),
    );
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId })));
    await store.removeCustomProvider(appX.id, "my-provider");
    await store.upsertCustomProvider(
      appX.id,
      { provider_id: "my-provider", base_url: "https://two.example.com/v1", api: "openai-completions", model_ids: ["m2"] },
      sk("custom-fixture-BBB"),
    );
    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));

    const [first, second] = runnerInputs();
    expect((first!.customProviders as Array<{ base_url: string; model_ids: string[] }>)[0]!.base_url).toBe(
      "https://one.example.com/v1",
    );
    expect((second!.customProviders as Array<{ base_url: string; model_ids: string[] }>)[0]!.base_url).toBe(
      "https://two.example.com/v1",
    );
    expect(runnerPools()[0]!["my-provider"]).toEqual([sk("custom-fixture-AAA")]);
    expect(runnerPools()[1]!["my-provider"]).toEqual([sk("custom-fixture-BBB")]);
  });

  test("an undecryptable custom-provider row fails closed with the per-App wrapper, zero side effects", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    db.raw
      .prepare(
        `INSERT INTO bot_custom_providers (bot_id, provider_id, base_url, api, model_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(appX.id, "my-provider", "https://my-provider.example.com/v1", "openai-completions", JSON.stringify(["m1"]));
    const enc = await createSecretbox(TEST_KEY).encryptSecret(
      sk("custom-fixture-AAA"),
      `app_custom_provider_keys.key_enc:${appX.id}:my-provider:deadbeefdeadbeef:wrong`,
    );
    db.raw
      .prepare(
        `INSERT INTO bot_custom_provider_keys (bot_id, provider, key_id, key_enc, created_at)
         VALUES (?, ?, 'deadbeefdeadbeef', ?, datetime('now'))`,
      )
      .run(appX.id, "my-provider", enc);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(`per-App custom-provider resolution failed: app ${appX.id}`);

    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App custom-provider resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
  });
});

describe("sandbox image resolution at review execution", () => {
  test("defaulted omp App (zero-custom): the runner input carries an EMPTY capability-host base", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId })));

    const input = runnerInputs()[0]!;
    expect(input.capabilityHosts).toEqual([]);
    expect(appCalls).toEqual(["token", "plan", "post"]);
    expect(JSON.stringify(input)).not.toContain(ARK_KEY);
  });

  test("an unknown sandbox image id fails closed BEFORE guard/sandbox (structured, non-secret, stage=pipeline)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    db.raw
      .prepare(`UPDATE review_bots SET sandbox_image_id = 'retired-image' WHERE id = ?`)
      .run(appX.id);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(
      `per-App sandbox image resolution failed: app ${appX.id}: unknown sandbox image id "retired-image"`,
    );

    expect(sandboxCalls).toHaveLength(0);
    expect(kvGuardPuts).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    const errLine = logLines.find((l) => l.level === "error");
    expect(errLine).toBeDefined();
    expect(errLine!.msg).toContain("per-App sandbox image resolution failed");
    expect(errLine!.fields.app_id).toBe(appX.id);
    const rows = db.raw.query("SELECT stage, error FROM review_failures").all() as Array<{ stage: string; error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe("pipeline");
    expect(rows[0]!.error).toContain('unknown sandbox image id "retired-image"');
    expect(rows[0]!.error).not.toContain(ARK_KEY);
  });

  test("the image id is re-read per message: a fixed id lets the next review run (unknown ids never start a sandbox)", async () => {
    reset();
    const db = createMigratedTestD1();
    const appX = await seedApp(db, "app-x");
    db.raw
      .prepare(`UPDATE review_bots SET sandbox_image_id = 'no-such-image' WHERE id = ?`)
      .run(appX.id);
    const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

    await expect(
      consumer(makeBatch(makePayload({ pr_number: 42, botRef: { appId: appX.id }, targetId: appX.targetId }))),
    ).rejects.toThrow(/unknown sandbox image id/);
    expect(sandboxCalls).toHaveLength(0);

    db.raw
      .prepare(`UPDATE review_bots SET sandbox_image_id = 'omp' WHERE id = ?`)
      .run(appX.id);
    await consumer(makeBatch(makePayload({ pr_number: 43, botRef: { appId: appX.id }, targetId: appX.targetId })));
    expect(sandboxCalls.length).toBeGreaterThan(0);
    expect(runnerInputs()).toHaveLength(1);
    expect(appCalls).toEqual(["token", "plan", "post"]);
  });
});

describe("custom provider sizes resolve from the catalog at the runner boundary", () => {
  const covered = (() => {
    for (const [providerId, table] of Object.entries(MODEL_LIMITS)) {
      const entry = PROVIDER_CATALOG[providerId];
      if (entry?.tier !== "template") continue;
      const modelId = Object.keys(table).find((id) => id !== "" && !id.includes("/"));
      if (modelId !== undefined) return { providerId, modelId, limit: table[modelId]! };
    }
    return null;
  })();

  test.skipIf(covered === null)(
    "a declaration on an endpoint the catalog does not list still reaches the runner with the model's sizes",
    async () => {
      if (covered === null) return;
      reset();
      const db = createMigratedTestD1();
      const appX = await seedApp(db, "app-x");
      const store = createAppConfigStore(db, TEST_KEY);
      await store.upsertCustomProvider(
        appX.id,
        {
          provider_id: covered.providerId,
          base_url: "https://private.example.com/v1",
          api: "openai-completions",
          model_ids: [covered.modelId],
        },
        sk("custom-fixture-CCC"),
      );
      await configureApp(db, appX.id, `${covered.providerId}/${covered.modelId}`);
      const consumer = createReviewConsumer(makeEnv({ DB: db as never }), testLog, testOverrides);

      await withFrozenClock(() => consumer(makeBatch(makePayload({ botRef: { appId: appX.id }, targetId: appX.targetId }))));

      const input = runnerInputs()[0]!;
      const decl = (input.customProviders as Array<{
        provider_id: string;
        models_meta?: Record<string, { contextWindow?: number; maxTokens?: number } | undefined>;
      }>).find((entry) => entry.provider_id === covered.providerId);
      expect(decl?.models_meta?.[covered.modelId]).toEqual({
        contextWindow: covered.limit.contextWindow,
        maxTokens: covered.limit.maxTokens,
      });
    },
  );
});
