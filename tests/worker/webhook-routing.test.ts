
import { describe, expect, mock, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import worker, { refusalSkipSettlement, settleRefusedAfterAttach } from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { WEBHOOK_BODY_LIMIT } from "../../src/worker/webhooks";
import {
  ENTITLEMENT_UNREADABLE_SKIP_REASON,
  QUOTA_SKIP_REASON,
  QUOTA_STAGE,
  SHARED_BOT_ENTITLEMENT_SKIP_REASON,
  SHARED_BOT_ENTITLEMENT_STAGE,
} from "../../src/contracts/failure-stages";
import { quotaMonth } from "../../src/store/quota-store";
import {
  CHECK_SUMMARIES,
  attachCheckAtAcceptance,
  createChecksAdapter,
  type ChecksCreateParams,
  type ChecksOctokit,
} from "../../src/pipeline/checks";
import type { ReviewTargetRow } from "../../src/dashboard/targets-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

type TargetSeed = {
  repoId?: number | null;
  repoOwner?: string;
  repoName?: string;
  mode?: "open" | "every_push" | "manual";
  reviewEnabled?: 0 | 1;
  reviewDrafts?: 0 | 1;
};

const FIXTURE_REPO = { owner: "test-owner", name: "test-repo" };

type SeedOptions = {
  slug: string;
  secret: string;
  githubAppId?: number;
  wrongAad?: boolean;
  githubSlug?: string | null;
  scope?: "owned" | "shared";
  targets?: TargetSeed[];
};

async function seedApp(
  db: TestD1,
  opts: SeedOptions,
): Promise<{ id: string; slug: string; targetId: string; targetIds: string[] }> {
  const id = opts.slug;
  const box = createSecretbox(TEST_KEY);
  const aad = opts.wrongAad ? `github_apps.webhook_secret_enc:not-this-row` : `github_apps.webhook_secret_enc:${id}`;
  const webhookSecretEnc = await box.encryptSecret(opts.secret, aad);
  const privateKeyEnc = await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`);
  const appCount = (db.raw.query("SELECT COUNT(*) AS n FROM review_bots").get() as { n: number }).n;
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, scope, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', ?, NULL, datetime('now'), datetime('now'))`,
    )
    .run(
      id,
      opts.githubSlug === undefined ? opts.slug : opts.githubSlug,
      opts.githubAppId ?? 1000 + appCount,
      opts.slug,
      privateKeyEnc,
      webhookSecretEnc,
      opts.scope ?? "owned",
    );
  db.raw
    .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'default')")
    .run(id);
  const targetIds = (opts.targets ?? [{}]).map((target, index) => {
    const targetId = `target-${id}-${index}`;
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
            review_enabled, review_drafts, review_trigger_mode, created_by, created_at, updated_at)
         VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, 'tester', datetime('now'), datetime('now'))`,
      )
      .run(
        targetId,
        id,
        target.repoName ?? FIXTURE_REPO.name,
        target.repoId ?? null,
        target.repoOwner ?? FIXTURE_REPO.owner,
        target.repoName ?? FIXTURE_REPO.name,
        target.reviewEnabled ?? 1,
        target.reviewDrafts ?? 1,
        target.mode ?? "every_push",
      );
    return targetId;
  });
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
       VALUES ('review.route.workflow', 'on', datetime('now'))`,
    )
    .run();
  return { id, slug: opts.slug, targetId: targetIds[0]!, targetIds };
}

function makeQueue() {
  const sent: ReviewJobPayload[] = [];
  const queue = {
    send: mock(async (message: ReviewJobPayload) => {
      sent.push(message);
    }),
  };
  return { queue, sent };
}

function makeKv() {
  const store = new Map<string, string>();
  return {
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
    store,
  };
}

type RouteEnv = Env;

function makeEnv(db: TestD1, overrides: Partial<RouteEnv> = {}): RouteEnv {
  const { kv } = makeKv();
  const { queue } = makeQueue();
  return {
    IDEMPOTENCY_KV: kv as never,
    REVIEW_QUEUE: queue as never,
    DB: db as never,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DEPLOYMENT_MODE: "self-hosted",
    ...overrides,
  };
}

async function postWebhook(path: string, body: string, headers: Record<string, string>, env: RouteEnv): Promise<Response> {
  return worker.fetch(new Request(`https://worker.local${path}`, { method: "POST", headers, body }), env);
}

async function signatureFor(secret: string, body: string): Promise<string> {
  return new Webhooks({ secret }).sign(body);
}

async function sigHeaders(secret: string, body: string, event = "pull_request"): Promise<Record<string, string>> {
  return { "x-hub-signature-256": await signatureFor(secret, body), "x-github-event": event };
}

function setReviewGlobalOff(db: TestD1): void {
  db.raw
    .prepare("INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES ('review_global', 0, datetime('now'), 'fixture')")
    .run();
}

const installUpsert = (query: string): boolean => query.includes("INSERT INTO bot_installations");
const flagRead = (query: string): boolean => query.includes("FROM server_flags");

function failingDb(db: TestD1, match: (query: string) => boolean): TestD1 {
  return {
    raw: db.raw,
    batch: db.batch.bind(db),
    prepare(query: string) {
      if (match(query)) {
        throw new Error("d1 unavailable (test injection)");
      }
      return db.prepare(query);
    },
  } as unknown as TestD1;
}

function captureWarn(): { warn: ReturnType<typeof mock<(msg: unknown) => void>>; stop: () => void } {
  const warn = mock((_msg: unknown) => {});
  const origWarn = console.warn;
  console.warn = warn;
  return {
    warn,
    stop: () => {
      console.warn = origWarn;
    },
  };
}

const PR_PAYLOAD = {
  action: "opened",
  number: 42,
  installation: { id: 123 },
  pull_request: { number: 42, state: "open", head: { sha: "abc123" }, user: { login: "alice" } },
  repository: { name: "test-repo", owner: { login: "test-owner" } },
};

describe("POST /webhook/:workspaceId/:appId (per-App routing)", () => {
  test("valid signature with the App's own secret → 200 accepted, enqueued with botRef + targetId", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    const { attachDeliveryId, ...queued } = sent[0]!;
    expect(queued).toEqual({
      installation_id: 123,
      owner: "test-owner",
      repo: "test-repo",
      pr_number: 42,
      head_sha: "abc123",
      action: "opened",
      triggered_by: "pull_request",
      botRef: { appId: appRow.id },
      targetId: appRow.targetId,
    });
    expect(attachDeliveryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const ledger = db.raw
      .query("SELECT owner, repo, pr_number, state, head_sha FROM pull_requests WHERE bot_id = ?")
      .all(appRow.id) as Array<{ owner: string; repo: string; pr_number: number; state: string; head_sha: string | null }>;
    expect(ledger).toEqual([
      { owner: "test-owner", repo: "test-repo", pr_number: 42, state: "open", head_sha: "abc123" },
    ]);
  });

  test("saas: a plan without the shared bot skips the delivery — 200, outcome skipped, no send, one entitlement failure", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x", scope: "shared" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);

    const delivery = db.raw
      .query("SELECT outcome FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(appRow.id) as { outcome: string };
    expect(delivery.outcome).toBe("skipped");

    const failures = db.raw
      .query("SELECT stage, target_id, error FROM review_failures ORDER BY rowid")
      .all() as Array<{ stage: string; target_id: string; error: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.stage).toBe(SHARED_BOT_ENTITLEMENT_STAGE);
    expect(failures[0]!.target_id).toBe(appRow.targetId);
    expect(failures[0]!.error).toBe(CHECK_SUMMARIES.skippedByDelivery(SHARED_BOT_ENTITLEMENT_SKIP_REASON));
  });

  test("saas: an UNREADABLE gate is a recorded skip, not a 500 — the failure names the cause", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw.prepare(`DELETE FROM quota_profile_plans WHERE plan_id = 'free'`).run();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    const failures = db.raw
      .query("SELECT stage, target_id, error FROM review_failures ORDER BY rowid")
      .all() as Array<{ stage: string; target_id: string; error: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.stage).toBe(SHARED_BOT_ENTITLEMENT_STAGE);
    expect(failures[0]!.target_id).toBe(appRow.targetId);
    expect(failures[0]!.error).toBe(CHECK_SUMMARIES.skippedByDelivery(ENTITLEMENT_UNREADABLE_SKIP_REASON));
    expect(failures[0]!.error).not.toContain("does not include the shared bot");
    const delivery = db.raw
      .query("SELECT outcome FROM webhook_deliveries WHERE bot_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(appRow.id) as { outcome: string };
    expect(delivery.outcome).toBe("skipped");
  });

  test("saas: an empty quota profile table is the same recorded skip, not a 500", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw.prepare("DELETE FROM quota_profile_plans").run();
    db.raw.prepare("DELETE FROM quota_profiles").run();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    const failures = db.raw.query("SELECT stage FROM review_failures").all() as Array<{ stage: string }>;
    expect(failures).toEqual([{ stage: SHARED_BOT_ENTITLEMENT_STAGE }]);
    const delivery = db.raw
      .query("SELECT outcome FROM webhook_deliveries WHERE bot_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(appRow.id) as { outcome: string };
    expect(delivery.outcome).toBe("skipped");
  });

  test("saas: a Free workspace's OWN bot is not the shared bot — the delivery enqueues normally", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.targetId).toBe(appRow.targetId);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 0 });
    const delivery = db.raw
      .query("SELECT outcome FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(appRow.id) as { outcome: string };
    expect(delivery.outcome).toBe("ok");
  });

  test("the queued head_at is byte-identical to the ledger's head_at (offset normalized)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      ...PR_PAYLOAD,
      action: "synchronize",
      pull_request: { ...PR_PAYLOAD.pull_request, updated_at: "2026-03-01T12:00:00+02:00" },
    });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const { head_at } = sent[0] as ReviewJobPayload;
    const row = db.raw
      .query("SELECT head_at FROM pull_requests WHERE bot_id = ?")
      .get(appRow.id) as { head_at: string | null };
    expect({ queued: head_at, ledger: row.head_at }).toEqual({
      queued: "2026-03-01T10:00:00.000Z",
      ledger: "2026-03-01T10:00:00.000Z",
    });
  });

  test("the Check attaches BEFORE the enqueue, and a refused attach still answers accepted with one warn", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const sent: ReviewJobPayload[] = [];
    let rowsAtSend = -1;
    const queue = {
      send: mock(async (message: ReviewJobPayload) => {
        rowsAtSend = (db.raw.query("SELECT COUNT(*) AS n FROM review_checks").get() as { n: number }).n;
        sent.push(message);
      }),
    };
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
        env,
      );
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(rowsAtSend).toBe(1);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("check_attach_failed");

    const rows = db.raw
      .query("SELECT head_sha, holder, lease_until_ms, check_run_id FROM review_checks")
      .all() as Array<{ head_sha: string; holder: string | null; lease_until_ms: number | null; check_run_id: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.head_sha).toBe("abc123");
    expect(rows[0]!.holder).toBeNull();
    expect(rows[0]!.lease_until_ms).toBeNull();
    expect(rows[0]!.check_run_id).toBeNull();
  });

  test("a closed route gate refuses at acceptance — no Check, no enqueue, one line with the PR identity", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw.prepare(`DELETE FROM review_runtime_settings WHERE key = 'review.route.workflow'`).run();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      lines.push(String(msg));
    };
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
        env,
      );
    } finally {
      console.log = origLog;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const checks = db.raw.query("SELECT COUNT(*) AS n FROM review_checks").get() as { n: number };
    expect(checks.n).toBe(0);
    const failures = db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get() as { n: number };
    expect(failures.n).toBe(0);

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line.event).toBe("review_route_gate_closed");
    expect(line.review_route_workflow).toBe("off");
    expect(line.pr_number).toBe(42);
    expect(line.owner).toBe("test-owner");
    expect(line.repo).toBe("test-repo");
    expect(line.installation_id).toBe(123);
  });

  test("wrong-App secret signature → 401, zero enqueue (sibling-App isolation, AC-B5-isolation)", async () => {
    const db = createMigratedTestD1();
    const appX = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const appY = await seedApp(db, { slug: "app-y", secret: "secret-y" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const resXY = await postWebhook(
      `/webhook/default/${appX.slug}`,
      body,
      { "x-hub-signature-256": await signatureFor("secret-y", body), "x-github-event": "pull_request" },
      env,
    );
    const resYX = await postWebhook(
      `/webhook/default/${appY.slug}`,
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(resXY.status).toBe(401);
    expect(resYX.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("invalid signature → 401, zero enqueue, delivery row rejected — never ok", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      `/webhook/default/${appRow.slug}`,
      body,
      { "x-hub-signature-256": await signatureFor("not-the-secret", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT outcome, status_code FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ outcome: "rejected", status_code: 401 }]);
  });

  test("unknown webhook path → 404, zero enqueue", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/no-such-app",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("disabled app → 404, zero enqueue", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createReviewBotsStore(db).setAppStatus(appRow.id, "disabled")).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("soft-deleted app → 404, zero enqueue", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createReviewBotsStore(db).softDeleteApp(appRow.id);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("body-size cap precedes the webhook-path lookup → 413, zero enqueue (spec ordering)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    const res = await postWebhook(
      "/webhook/default/app-x",
      "",
      { "content-length": String(1_000_001), "x-github-event": "ping" },
      env,
    );

    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  test("truthful content-length header over the limit → 413 fast path, zero enqueue", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const oversized = "a".repeat(WEBHOOK_BODY_LIMIT + 1);

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        oversized,
        { "content-length": String(oversized.length), "x-github-event": "ping" },
        env,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("webhook_body_too_large"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string; reason: string; detail: string };
    expect(fields).toMatchObject({
      event: "webhook_body_too_large",
      reason: "webhook_body_too_large",
      detail: `content_length=${WEBHOOK_BODY_LIMIT + 1}`,
    });
  });

  test("lying short content-length + oversized body → 413 (byte count, not the header), zero enqueue", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const oversized = "a".repeat(WEBHOOK_BODY_LIMIT + 1);

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        oversized,
        { "content-length": "10", "x-github-event": "ping" },
        env,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("webhook_body_too_large"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string; reason: string; detail: string };
    expect(fields).toMatchObject({
      event: "webhook_body_too_large",
      reason: "webhook_body_too_large",
      detail: `read_bytes>${WEBHOOK_BODY_LIMIT}`,
    });
  });

  test("headerless chunked oversized body → 413 + webhook_body_too_large warn, zero enqueue", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const half = new Uint8Array(WEBHOOK_BODY_LIMIT / 2).fill(97);
    const request = new Request("https://worker.local/webhook/default/app-x", {
      method: "POST",
      headers: { "x-github-event": "ping" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(half);
          controller.enqueue(half);
          controller.enqueue(new Uint8Array([97]));
          controller.close();
        },
      }),
      duplex: "half",
    });

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await worker.fetch(request, env);
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("webhook_body_too_large"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string; reason: string; detail: string };
    expect(fields).toMatchObject({
      event: "webhook_body_too_large",
      reason: "webhook_body_too_large",
      detail: `read_bytes>${WEBHOOK_BODY_LIMIT}`,
    });
  });

  test("at-limit body (exactly WEBHOOK_BODY_LIMIT bytes) → 200 accepted, enqueued (HMAC verifies the streamed rawBody)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const base = JSON.stringify({ ...PR_PAYLOAD, pad: "" });
    const body = JSON.stringify({ ...PR_PAYLOAD, pad: "x".repeat(WEBHOOK_BODY_LIMIT - base.length) });
    expect(body.length).toBe(WEBHOOK_BODY_LIMIT);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pr_number: 42, botRef: { appId: appRow.id }, targetId: appRow.targetId });
  });

  test("at-limit multi-byte UTF-8 body (exactly WEBHOOK_BODY_LIMIT bytes) → 200 accepted, enqueued (HMAC verifies)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const emptyPad = JSON.stringify({ ...PR_PAYLOAD, pad: "" });
    const padBytes = WEBHOOK_BODY_LIMIT - Buffer.byteLength(emptyPad);
    const pad = "漢".repeat(Math.floor(padBytes / 3)) + "x".repeat(padBytes % 3);
    const body = JSON.stringify({ ...PR_PAYLOAD, pad });
    expect(Buffer.byteLength(body)).toBe(WEBHOOK_BODY_LIMIT);
    expect(body.length).toBeLessThan(WEBHOOK_BODY_LIMIT);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pr_number: 42, botRef: { appId: appRow.id }, targetId: appRow.targetId });
  });

  test("small valid webhook unchanged by the streamed cap → 200 accepted, enqueued", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  test("missing signature header → 401, zero enqueue", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, { "x-github-event": "pull_request" }, env);

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("DASHBOARD_ENCRYPTION_KEY missing → 500 fail-closed, zero enqueue (AC-SEC)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DASHBOARD_ENCRYPTION_KEY: undefined });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  test("tampered webhook-secret envelope (wrong AAD) → 500 fail-closed, zero enqueue", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x", wrongAad: true });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  test("DB binding unbound → 500 fail-closed, zero enqueue (T4 Env fold)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DB: undefined });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  test("bot mention via the per-App route enqueues the issue_comment payload with both ids", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ repoOwner: "alice" }] });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "@app-x please take another look", id: 900000001 },
      issue: { number: 7, pull_request: {}, user: { login: "alice" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "issue_comment" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      installation_id: 123,
      owner: "alice",
      repo: "test-repo",
      pr_number: 7,
      head_sha: null,
      comment_id: 900000001,
      action: "created",
      triggered_by: "issue_comment",
      botRef: { appId: appRow.id },
      targetId: appRow.targetId,
    });
  });

  test("mode threading: a manual-mode App ignores pull_request.opened but a bot mention still enqueues", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      targets: [{ mode: "manual", repoOwner: "alice" }],
    });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const prBody = JSON.stringify(PR_PAYLOAD);

    const prRes = await postWebhook(
      "/webhook/default/app-x",
      prBody,
      { "x-hub-signature-256": await signatureFor("secret-x", prBody), "x-github-event": "pull_request" },
      env,
    );

    expect(prRes.status).toBe(200);
    expect(sent).toHaveLength(0);

    const mentionBody = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "@app-x", id: 900000002 },
      issue: { number: 7, pull_request: {}, user: { login: "alice" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });
    const mentionRes = await postWebhook(
      "/webhook/default/app-x",
      mentionBody,
      { "x-hub-signature-256": await signatureFor("secret-x", mentionBody), "x-github-event": "issue_comment" },
      env,
    );

    expect(mentionRes.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      pr_number: 7,
      head_sha: null,
      comment_id: 900000002,
      triggered_by: "issue_comment",
      botRef: { appId: appRow.id },
      targetId: appRow.targetId,
    });
  });

  describe("draft review gate (migration 0070) on the delivery path", () => {
    const DRAFT_SHA = "abc123";
    const idemOf = (sha: string) => `idem:123:test-owner/test-repo:42:${sha}`;

    const delivery = (action: string, opts: { sha?: string } = {}) => ({
      ...PR_PAYLOAD,
      action,
      pull_request: { ...PR_PAYLOAD.pull_request, draft: true, head: { sha: opts.sha ?? DRAFT_SHA } },
    });

    async function post(env: RouteEnv, payload: unknown): Promise<Response> {
      const body = JSON.stringify(payload);
      return postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
        env,
      );
    }

    test("switch off: a draft synchronize writes no job, no Check, no failure row and no KV claim", async () => {
      const db = createMigratedTestD1();
      const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ reviewDrafts: 0 }] });
      const { kv, store } = makeKv();
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });

      const res = await post(env, delivery("synchronize"));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ignored");
      expect(sent).toHaveLength(0);
      expect(store.size).toBe(0);
      expect(db.raw.query("SELECT COUNT(*) AS n FROM review_checks").get()).toEqual({ n: 0 });
      expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 0 });
      const recorded = db.raw
        .query("SELECT outcome FROM webhook_deliveries WHERE bot_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(appRow.id) as { outcome: string };
      expect(recorded.outcome).toBe("ignored");
    });

    test("switch off: ready_for_review on the same head enqueues once, and a live claim keeps the redelivery out", async () => {
      const db = createMigratedTestD1();
      await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ reviewDrafts: 0 }] });
      const { kv, store } = makeKv();
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });

      expect(await (await post(env, delivery("synchronize"))).text()).toBe("ignored");
      const ready = await post(env, delivery("ready_for_review"));
      expect(ready.status).toBe(200);
      expect(await ready.text()).toBe("accepted");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ action: "ready_for_review", pr_number: 42, head_sha: DRAFT_SHA });
      expect(store.get(idemOf(DRAFT_SHA))).toBe("1");
      expect(db.raw.query("SELECT COUNT(*) AS n FROM review_checks").get()).toEqual({ n: 1 });

      expect(await (await post(env, delivery("ready_for_review"))).text()).toBe("accepted");
      expect(sent).toHaveLength(1);

      expect(await (await post(env, delivery("ready_for_review", { sha: "def456" }))).text()).toBe("accepted");
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({ head_sha: "def456" });
    });

    test("switch off: a 'done' claim for the same head suppresses the ready delivery", async () => {
      const db = createMigratedTestD1();
      await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ reviewDrafts: 0 }] });
      const { kv, store } = makeKv();
      store.set(idemOf(DRAFT_SHA), "done");
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });

      const res = await post(env, delivery("ready_for_review"));

      expect(res.status).toBe(200);
      expect(sent).toHaveLength(0);
      expect(store.get(idemOf(DRAFT_SHA))).toBe("done");
    });

    test("switch off: a faulting KV admits the ready delivery — the D1/consumer guard is the backstop", async () => {
      const db = createMigratedTestD1();
      await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ reviewDrafts: 0 }] });
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, {
        REVIEW_QUEUE: queue as never,
        IDEMPOTENCY_KV: {
          get: async () => {
            throw new Error("kv unavailable (test injection)");
          },
          put: async () => {},
        } as never,
      });

      expect(await (await post(env, delivery("ready_for_review"))).text()).toBe("accepted");
      expect(await (await post(env, delivery("ready_for_review"))).text()).toBe("accepted");
      expect(sent).toHaveLength(2);
    });

    test("switch on: the same draft synchronize enqueues — the switch decides, not the action", async () => {
      const db = createMigratedTestD1();
      await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ reviewDrafts: 1 }] });
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

      const res = await post(env, delivery("synchronize"));

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("accepted");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ action: "synchronize", pr_number: 42, head_sha: DRAFT_SHA });
    });
  });

  test("an unsynced App (github_slug NULL) logs mention_unresolved for a mention, still enqueues nothing", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      githubSlug: null,
      targets: [{ mode: "manual", repoOwner: "alice" }],
    });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "@app-x please take another look" },
      issue: { number: 7, pull_request: {}, user: { login: "alice" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "issue_comment" },
        env,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const line = warn.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes("mention_unresolved"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string; reason: string; detail: string };
    expect(fields).toMatchObject({
      event: "mention_unresolved",
      reason: "mention_unresolved",
    });
    expect(fields.detail).toContain("workspace_id=default");
    expect(fields.detail).toContain("app_id=app-x");
    const deliveries = db.raw
      .query("SELECT outcome FROM webhook_deliveries")
      .all() as Array<{ outcome: string }>;
    expect(deliveries).toEqual([{ outcome: "ignored" }]);
  });

  test("a comment with no bot mention on an unsynced App stays a silent ignore (no mention_unresolved)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x", githubSlug: null });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    try {
      for (const [label, payload] of [
        ["no mention at all", { comment: { body: "looks good to me" } }],
        ["mention on an edited comment", { action: "edited", comment: { body: "@app-x look again" } }],
      ] as const) {
        const body = JSON.stringify({
          action: "created",
          installation: { id: 123 },
          issue: { number: 7, pull_request: {}, user: { login: "alice" } },
          repository: { name: "test-repo", owner: { login: "alice" } },
          sender: { type: "User", login: "alice" },
          ...payload,
        });
        const res = await postWebhook(
          "/webhook/default/app-x",
          body,
          { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "issue_comment" },
          env,
        );
        expect(res.status, label).toBe(200);
      }
    } finally {
      console.warn = origWarn;
    }

    expect(sent).toHaveLength(0);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((entry) => entry.includes("mention_unresolved"))).toBe(false);
  });

  test("a mention on a [bot]-authored PR on an unsynced App stays silent (no mention_unresolved)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x", githubSlug: null });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "@app-x please review" },
      issue: { number: 7, pull_request: {}, user: { login: "dependabot[bot]" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "issue_comment" },
        env,
      );
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((entry) => entry.includes("mention_unresolved"))).toBe(false);
  });

  test("a mention on a plain issue (no PR thread) stays silent (no mention_unresolved)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x", githubSlug: null });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "@app-x please review" },
      issue: { number: 7, user: { login: "alice" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "issue_comment" },
        env,
      );
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((entry) => entry.includes("mention_unresolved"))).toBe(false);
  });

  test("a sibling App's mention does not trigger this App (GitHub-slug-keyed matching)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "@app-y look here" },
      issue: { number: 7, pull_request: {}, user: { login: "alice" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "issue_comment" },
        env,
      );
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((entry) => entry.includes("mention_unresolved"))).toBe(false);
  });

  test("idempotency: a second identical delivery is KV-skipped", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { kv, store } = makeKv();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });
    const body = JSON.stringify(PR_PAYLOAD);
    const headers = { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" };

    const first = await postWebhook("/webhook/default/app-x", body, headers, env);
    const second = await postWebhook("/webhook/default/app-x", body, headers, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sent).toHaveLength(1);
    const key = `idem:123:test-owner/test-repo:42:abc123`;
    expect(store.get(key)).toBe("1");
  });
});

describe("tenant attribution on the webhook read face", () => {
  function dropWorkspaceMapping(db: TestD1, appId: string): void {
    db.raw.prepare("DELETE FROM bot_workspaces WHERE bot_id = ?").run(appId);
  }

  test("an unmapped (orphan) App answers 404 with zero decrypt, zero delivery row, zero enqueue", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    dropWorkspaceMapping(db, appRow.id);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DASHBOARD_ENCRYPTION_KEY: undefined });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("unknown webhook path");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE bot_id = ?")
      .get(appRow.id) as { n: number };
    expect(rows.n).toBe(0);
  });

  test("a workspace-mapped App serves and enqueues", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.botRef).toEqual({ appId: appRow.id });
    expect(sent[0]!.targetId).toBe(appRow.targetId);
  });
});

describe("installations upsert wiring", () => {
  test("per-App webhook with installation_id → bot_installations row INSERTED (seen_at set, login from the delivery)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const rows = db.raw
      .query("SELECT bot_id, installation_id, account_login, seen_at FROM bot_installations")
      .all() as Array<{ bot_id: string; installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bot_id).toBe(appRow.id);
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBe("test-owner");
    expect(typeof rows[0]!.seen_at).toBe("string");
  });

  test("second delivery touches the SAME row — seen_at refreshed, stored login left alone (inferred never overwrites)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    const body1 = JSON.stringify(PR_PAYLOAD);
    await postWebhook(
      "/webhook/default/app-x",
      body1,
      { "x-hub-signature-256": await signatureFor("secret-x", body1), "x-github-event": "pull_request" },
      env,
    );
    db.raw
      .prepare("UPDATE bot_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
      .run();

    const body2 = JSON.stringify({ ...PR_PAYLOAD, number: 43, pull_request: { number: 43, head: { sha: "def456" }, user: { login: "alice" } } });
    const res2 = await postWebhook(
      "/webhook/default/app-x",
      body2,
      { "x-hub-signature-256": await signatureFor("secret-x", body2), "x-github-event": "pull_request" },
      env,
    );

    expect(res2.status).toBe(200);
    expect(sent).toHaveLength(2);
    const rows = db.raw
      .query("SELECT installation_id, account_login, seen_at FROM bot_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBe("alice");
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00");
  });

  test("a review delivery carrying installation.account still only fills an empty login", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const seedBody = JSON.stringify(PR_PAYLOAD);
    await postWebhook("/webhook/default/app-x", seedBody, await sigHeaders("secret-x", seedBody), env);
    db.raw
      .prepare("UPDATE bot_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
      .run();

    const body = JSON.stringify({
      ...PR_PAYLOAD,
      number: 43,
      pull_request: { number: 43, state: "open", head: { sha: "def456" }, user: { login: "alice" } },
      installation: { id: 123, account: { login: "octo-org" } },
    });
    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    const rows = db.raw
      .query("SELECT account_login, seen_at FROM bot_installations")
      .all() as Array<{ account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("alice");
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00");
  });

  test("KV-skipped duplicate delivery (identical body) still refreshes seen_at (QC F-006: upsert on ANY webhook)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { kv, store } = makeKv();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });

    const body = JSON.stringify(PR_PAYLOAD);
    const headers = { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" };
    const first = await postWebhook("/webhook/default/app-x", body, headers, env);
    expect(first.status).toBe(200);
    db.raw
      .prepare("UPDATE bot_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
      .run();

    const second = await postWebhook("/webhook/default/app-x", body, headers, env);

    expect(second.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(store.get(`idem:123:test-owner/test-repo:42:abc123`)).toBe("1");
    const rows = db.raw
      .query("SELECT installation_id, account_login, seen_at FROM bot_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("alice");
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00");
  });

  test("a later delivery that omits the login preserves the stored one (COALESCE bare touch)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ repoOwner: "alice" }] });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    const prBody = JSON.stringify({
      ...PR_PAYLOAD,
      repository: { name: "test-repo", owner: { login: "alice" } },
    });
    await postWebhook("/webhook/default/app-x", prBody, await sigHeaders("secret-x", prBody), env);
    db.raw.prepare("UPDATE bot_installations SET seen_at = '2000-01-01 00:00:00'").run();

    const bareBody = JSON.stringify({ action: "created", installation: { id: 123 } });
    const bare = await postWebhook("/webhook/default/app-x", bareBody, await sigHeaders("secret-x", bareBody, "installation"), env);

    expect(bare.status).toBe(200);
    expect(sent).toHaveLength(1);
    const rows = db.raw
      .query("SELECT installation_id, account_login, seen_at FROM bot_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBe("alice");
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00");
  });

  test("the installation's own account is persisted, not the inferred repository owner", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...PR_PAYLOAD, installation: { id: 123, account: { login: "octo-org" } } });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const rows = db.raw
      .query("SELECT bot_id, account_login FROM bot_installations")
      .all() as Array<{ bot_id: string; account_login: string | null }>;
    expect(rows).toEqual([{ bot_id: appRow.id, account_login: "octo-org" }]);
    expect(sent[0]!.owner).toBe("test-owner");
  });

  test("paused App still records the login from a review-type delivery (bookkeeping is gate-independent)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createReviewBotsStore(db).setReviewEnabled(appRow.id, false)).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...PR_PAYLOAD, installation: { id: 123, account: { login: "octo-org" } } });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT bot_id, account_login FROM bot_installations")
      .all() as Array<{ bot_id: string; account_login: string | null }>;
    expect(rows).toEqual([{ bot_id: appRow.id, account_login: "octo-org" }]);
  });

  test("review_global OFF still records the login from a review-type delivery (the flag gates enqueue only)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    setReviewGlobalOff(db);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...PR_PAYLOAD, installation: { id: 123, account: { login: "octo-org" } } });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT bot_id, account_login FROM bot_installations")
      .all() as Array<{ bot_id: string; account_login: string | null }>;
    expect(rows).toEqual([{ bot_id: appRow.id, account_login: "octo-org" }]);
  });

  test("upsert failure → structured warn, enqueue still succeeds (fire-and-forget bookkeeping)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const failing = failingDb(db, installUpsert);
    const env = makeEnv(failing, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
        env,
      );
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("installation_upsert_failed");
    expect((db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get() as { n: number }).n).toBe(0);
  });
});

describe("installation event path", () => {
  function installationRows(
    db: TestD1,
  ): Array<{ bot_id: string; installation_id: number; account_login: string | null }> {
    return db.raw
      .query("SELECT bot_id, installation_id, account_login FROM bot_installations")
      .all() as Array<{ bot_id: string; installation_id: number; account_login: string | null }>;
  }

  function deliveryRows(
    db: TestD1,
    appId: string,
  ): Array<{ event_name: string | null; outcome: string; status_code: number | null }> {
    return db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE bot_id = ?")
      .all(appId) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
  }

  const INSTALL_PAYLOAD = {
    action: "created",
    installation: { id: 555, account: { login: "octo-org" } },
  };

  test.each(["created", "new_permissions_accepted"])(
    "installation.%s with account.login → row written with that login, zero enqueue, delivery ignored",
    async (action) => {
      const db = createMigratedTestD1();
      const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
      const body = JSON.stringify({ ...INSTALL_PAYLOAD, action });

      const res = await postWebhook(
        "/webhook/default/app-x",
        body,
        await sigHeaders("secret-x", body, "installation"),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("accepted");
      expect(sent).toHaveLength(0);
      expect(installationRows(db)).toEqual([
        { bot_id: appRow.id, installation_id: 555, account_login: "octo-org" },
      ]);
      expect(deliveryRows(db, appRow.id)).toEqual([
        { event_name: "installation", outcome: "ignored", status_code: null },
      ]);
      const ops = db.raw
        .query("SELECT last_webhook_at FROM review_bots WHERE id = ?")
        .get(appRow.id) as { last_webhook_at: string | null };
      expect(ops.last_webhook_at).not.toBeNull();
    },
  );

  test("an install event OVERWRITES a stored login — the route passes the authoritative source", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('seed-1', ?, 555, 'alice', datetime('now'))",
      )
      .run(appRow.id);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(INSTALL_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toEqual([
      { bot_id: appRow.id, installation_id: 555, account_login: "octo-org" },
    ]);
  });

  test("paused App (review_enabled=0) still records the installation — the pause gate does not apply", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createReviewBotsStore(db).setReviewEnabled(appRow.id, false)).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(INSTALL_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toHaveLength(1);
    expect(deliveryRows(db, appRow.id)[0]!.outcome).toBe("ignored");
  });

  test("global review_global flag OFF still records the installation — the flag gates enqueue only", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    setReviewGlobalOff(db);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(INSTALL_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toEqual([
      { bot_id: appRow.id, installation_id: 555, account_login: "octo-org" },
    ]);
    expect(deliveryRows(db, appRow.id)[0]!.outcome).toBe("ignored");
  });

  test("installation.deleted → 200 accepted, the (app, installation) row is stamped removed, zero enqueue", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw
      .prepare(
        "INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at) VALUES ('seed-1', ?, 555, 'octo-org', datetime('now'))",
      )
      .run(appRow.id);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...INSTALL_PAYLOAD, action: "deleted" });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT installation_id, account_login, removed_at FROM bot_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; removed_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.installation_id).toBe(555);
    expect(rows[0]!.account_login).toBe("octo-org");
    expect(rows[0]!.removed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/);
    expect(await createReviewBotsStore(db).listInstallations(appRow.id)).toHaveLength(0);
    expect(deliveryRows(db, appRow.id)).toEqual([
      { event_name: "installation", outcome: "ignored", status_code: null },
    ]);
  });

  test("installation.deleted for an installation we never stored → 200 accepted, no row invented", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...INSTALL_PAYLOAD, action: "deleted" });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toHaveLength(0);
  });

  test.each(["suspended", "unsuspended", "added", "removed"])(
    "installation.%s stays ignored — only created / new_permissions_accepted / deleted are classified",
    async (action) => {
      const db = createMigratedTestD1();
      const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
      const body = JSON.stringify({ ...INSTALL_PAYLOAD, action });

      const res = await postWebhook(
        "/webhook/default/app-x",
        body,
        await sigHeaders("secret-x", body, "installation"),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ignored");
      expect(sent).toHaveLength(0);
      expect(installationRows(db)).toHaveLength(0);
      expect(deliveryRows(db, appRow.id)[0]).toEqual({
        event_name: "installation",
        outcome: "ignored",
        status_code: null,
      });
    },
  );

  test("installation.deleted without installation.id → 400 reject (the sibling malformed rule)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ action: "deleted", installation: { account: { login: "octo-org" } } });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("installation payload missing required fields");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toHaveLength(0);
    expect(deliveryRows(db, appRow.id)).toEqual([
      { event_name: "installation", outcome: "rejected", status_code: 400 },
    ]);
  });

  test("malformed installation body (no installation.id) → 400, delivery rejected", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ action: "created", installation: { account: { login: "octo-org" } } });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("installation payload missing required fields");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toHaveLength(0);
    expect(deliveryRows(db, appRow.id)).toEqual([
      { event_name: "installation", outcome: "rejected", status_code: 400 },
    ]);
  });

  test("upsert failure → structured warn, still 200 accepted, zero enqueue (fire-and-forget bookkeeping)", async () => {
    const db = createMigratedTestD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const failing = failingDb(db, installUpsert);
    const env = makeEnv(failing, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(INSTALL_PAYLOAD);

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body, "installation"), env);
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("installation_upsert_failed");
    expect((db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get() as { n: number }).n).toBe(0);
  });
});

describe("per-App pause gate + last_webhook_at (spec 语义锁 B3 / L5)", () => {
  function appOps(
    db: TestD1,
    id: string,
  ): { review_enabled: number; last_webhook_at: string | null; updated_at: string } {
    return db.raw
      .query("SELECT review_enabled, last_webhook_at, updated_at FROM review_bots WHERE id = ?")
      .get(id) as { review_enabled: number; last_webhook_at: string | null; updated_at: string };
  }

  test("enabled App → job enqueued AND last_webhook_at touched (2xx job outcome)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(appOps(db, appRow.id).review_enabled).toBe(1);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
  });

  test("paused App (review_enabled=0) → 2xx ignored, ZERO enqueue, last_webhook_at STILL touched", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createReviewBotsStore(db).setReviewEnabled(appRow.id, false)).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const info = mock((_msg: unknown) => {});
    const origLog = console.log;
    console.log = info;
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      console.log = origLog;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
    const line = info.mock.calls.map((call) => String(call[0])).find((s) => s.includes("review_paused"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string };
    expect(fields.event).toBe("review_paused");
  });

  test("review_global OFF → 2xx ignored, ZERO enqueue, delivery recorded `paused` (never `ok`)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    setReviewGlobalOff(db);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).review_enabled).toBe(1);
    const rows = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "pull_request", outcome: "paused", status_code: null }]);
  });

  test("ignore delivery never depends on the review_global flag → 2xx ignored + delivery row recorded", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw.run("DROP TABLE server_flags");
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...PR_PAYLOAD, action: "closed" });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "pull_request", outcome: "ignored", status_code: null }]);
    const ledger = db.raw
      .query("SELECT pr_number, state FROM pull_requests WHERE bot_id = ?")
      .all(appRow.id) as Array<{ pr_number: number; state: string }>;
    expect(ledger).toEqual([{ pr_number: 42, state: "open" }]);
  });

  test("bot-authored PR → 2xx ignored, ZERO enqueue, delivery row recorded `ignored`", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      ...PR_PAYLOAD,
      pull_request: { ...PR_PAYLOAD.pull_request, user: { login: "dependabot[bot]" } },
    });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "pull_request", outcome: "ignored", status_code: null }]);
    const ledger = db.raw
      .query("SELECT pr_number, state FROM pull_requests WHERE bot_id = ?")
      .all(appRow.id) as Array<{ pr_number: number; state: string }>;
    expect(ledger).toEqual([{ pr_number: 42, state: "open" }]);
  });

  test("malformed issue_comment (no installation.id) → 400, delivery row rejected", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      action: "created",
      installation: null,
      comment: { body: "@app-x please review" },
      issue: { number: 7, user: { login: "alice" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body, "issue_comment"), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("issue_comment payload missing required fields");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "issue_comment", outcome: "rejected", status_code: 400 }]);
  });

  test("flag read failure on a `job` delivery → 2xx ignored, ZERO enqueue, `paused`, all diagnostics kept", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const broken = failingDb(db, flagRead);
    const env = makeEnv(broken, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const deliveries = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE bot_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(deliveries).toEqual([{ event_name: "pull_request", outcome: "paused", status_code: null }]);
    const ledger = db.raw
      .query("SELECT pr_number, state FROM pull_requests WHERE bot_id = ?")
      .all(appRow.id) as Array<{ pr_number: number; state: string }>;
    expect(ledger).toEqual([{ pr_number: 42, state: "open" }]);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("review_global_read_failed");
  });

  test("paused App, non-whitelisted event → 2xx ignored + touched (ignore outcome also counts)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createReviewBotsStore(db).setReviewEnabled(appRow.id, false);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body, "ping"), env);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
  });

  test("reject path (bad signature → 401) never touches last_webhook_at", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("wrong-secret", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).toBeNull();
    expect(db.raw.query("SELECT pr_number FROM pull_requests WHERE bot_id = ?").all(appRow.id)).toEqual([]);
  });

  test("disabled / soft-deleted Apps → 404 never touch last_webhook_at (gate matrix)", async () => {
    const db = createMigratedTestD1();
    const disabledRow = await seedApp(db, { slug: "app-disabled", secret: "secret-d" });
    const deletedRow = await seedApp(db, { slug: "app-deleted", secret: "secret-r" });
    await createReviewBotsStore(db).setAppStatus(disabledRow.id, "disabled");
    await createReviewBotsStore(db).softDeleteApp(deletedRow.id);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const resDisabled = await postWebhook(
      "/webhook/default/app-disabled",
      body,
      await sigHeaders("secret-d", body),
      env,
    );
    const resDeleted = await postWebhook("/webhook/default/app-deleted", body, await sigHeaders("secret-r", body), env);

    expect(resDisabled.status).toBe(404);
    expect(resDeleted.status).toBe(404);
    expect(sent).toHaveLength(0);
    expect(appOps(db, disabledRow.id).last_webhook_at).toBeNull();
    expect(appOps(db, deletedRow.id).last_webhook_at).toBeNull();
  });

  test("touchLastWebhook writes ONLY last_webhook_at — updated_at stays the operator timestamp (L5)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw
      .prepare("UPDATE review_bots SET updated_at = '2000-01-01 00:00:00', last_webhook_at = '2000-01-01 00:00:00' WHERE id = ?")
      .run(appRow.id);

    await createReviewBotsStore(db).touchLastWebhook(appRow.id);

    const ops = appOps(db, appRow.id);
    expect(ops.last_webhook_at).not.toBe("2000-01-01 00:00:00");
    expect(ops.updated_at).toBe("2000-01-01 00:00:00");
  });

  test("setReviewEnabled toggles review_enabled, writes updated_at, and refuses soft-deleted rows (setAppStatus precedent)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const store = createReviewBotsStore(db);
    db.raw.prepare("UPDATE review_bots SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(appRow.id);

    expect(await store.setReviewEnabled(appRow.id, false)).toBe(true);
    let ops = appOps(db, appRow.id);
    expect(ops.review_enabled).toBe(0);
    expect(ops.updated_at).not.toBe("2000-01-01 00:00:00");

    expect(await store.setReviewEnabled(appRow.id, true)).toBe(true);
    expect(appOps(db, appRow.id).review_enabled).toBe(1);

    await store.softDeleteApp(appRow.id);
    expect(await store.setReviewEnabled(appRow.id, false)).toBe(false);
    expect(appOps(db, appRow.id).review_enabled).toBe(1);

    expect(await store.setReviewEnabled("no-such-app", false)).toBe(false);
  });

  test("listInstallations returns THIS App's installations, most recently seen first (panel read face)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const sibling = await seedApp(db, { slug: "app-y", secret: "secret-y" });
    const store = createReviewBotsStore(db);
    await store.upsertInstallation({ appId: appRow.id, installationId: 1, accountLogin: "old" });
    await store.upsertInstallation({ appId: appRow.id, installationId: 2, accountLogin: "recent" });
    await store.upsertInstallation({ appId: sibling.id, installationId: 3, accountLogin: "other-app" });
    db.raw.prepare("UPDATE bot_installations SET seen_at = '2000-01-01 00:00:00' WHERE installation_id = 1").run();

    const rows = await store.listInstallations(appRow.id);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ installation_id: 2, account_login: "recent" });
    expect(rows[1]).toMatchObject({ installation_id: 1, account_login: "old" });
    expect(typeof rows[0]!.seen_at).toBe("string");
    expect(await store.listInstallations("no-such-app")).toEqual([]);
  });
});

describe("verifier cache — rotation + cacheKey isolation (L1)", () => {
  test("rotated webhook secret verifies with the NEW secret only (secret mismatch → rebuild + replace)", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-v1" });
    const body = JSON.stringify(PR_PAYLOAD);

    const firstQueue = makeQueue();
    const firstEnv = makeEnv(db, { REVIEW_QUEUE: firstQueue.queue as never });
    const first = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-v1", body), firstEnv);
    expect(first.status).toBe(200);
    expect(firstQueue.sent).toHaveLength(1);

    const box = createSecretbox(TEST_KEY);
    db.raw
      .prepare("UPDATE review_bots SET webhook_secret_enc = ? WHERE id = ?")
      .run(await box.encryptSecret("secret-v2", `github_apps.webhook_secret_enc:${appRow.id}`), appRow.id);

    const secondQueue = makeQueue();
    const secondEnv = makeEnv(db, { REVIEW_QUEUE: secondQueue.queue as never });
    const second = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-v2", body), secondEnv);
    expect(second.status).toBe(200);
    expect(secondQueue.sent).toHaveLength(1);

    const staleQueue = makeQueue();
    const staleEnv = makeEnv(db, { REVIEW_QUEUE: staleQueue.queue as never });
    const stale = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-v1", body), staleEnv);
    expect(stale.status).toBe(401);
    expect(staleQueue.sent).toHaveLength(0);
  });

});

describe("target resolution (webhook → review_targets by repository)", () => {
  function deliveries(db: TestD1, botId: string): Array<{ event_name: string | null; outcome: string }> {
    return db.raw
      .query("SELECT event_name, outcome FROM webhook_deliveries WHERE bot_id = ?")
      .all(botId) as Array<{ event_name: string | null; outcome: string }>;
  }

  function ledgerCount(db: TestD1, botId: string): number {
    return (db.raw.query("SELECT COUNT(*) AS n FROM pull_requests WHERE bot_id = ?").get(botId) as { n: number }).n;
  }

  function lastWebhookAt(db: TestD1, botId: string): string | null {
    return (db.raw.query("SELECT last_webhook_at FROM review_bots WHERE id = ?").get(botId) as {
      last_webhook_at: string | null;
    }).last_webhook_at;
  }

  function bodyFor(repository: { id: number; owner: string; name: string }, action = "opened"): string {
    return JSON.stringify({
      ...PR_PAYLOAD,
      action,
      repository: { id: repository.id, name: repository.name, owner: { login: repository.owner } },
    });
  }

  test("a delivery resolves the target of its own repository, not another one of the bot", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      targets: [
        { repoId: 111, repoOwner: "acme", repoName: "open-repo", mode: "open" },
        { repoId: 222, repoOwner: "acme", repoName: "push-repo", mode: "every_push" },
      ],
    });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    const openBody = bodyFor({ id: 111, owner: "acme", name: "open-repo" }, "synchronize");
    const ignored = await postWebhook("/webhook/default/app-x", openBody, await sigHeaders("secret-x", openBody), env);
    expect(ignored.status).toBe(200);
    expect(await ignored.text()).toBe("ignored");
    expect(sent).toHaveLength(0);

    const pushBody = bodyFor({ id: 222, owner: "acme", name: "push-repo" }, "synchronize");
    const accepted = await postWebhook("/webhook/default/app-x", pushBody, await sigHeaders("secret-x", pushBody), env);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.targetId).toBe(appRow.targetIds[1]!);
  });

  test("two repositories under one installation both review", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      targets: [
        { repoId: 111, repoOwner: "acme", repoName: "first" },
        { repoId: 222, repoOwner: "acme", repoName: "second" },
      ],
    });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    for (const repo of [
      { id: 111, owner: "acme", name: "first" },
      { id: 222, owner: "acme", name: "second" },
    ]) {
      const body = bodyFor(repo);
      const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
      expect(await res.text()).toBe("accepted");
    }

    expect(sent.map((message) => message.targetId)).toEqual(appRow.targetIds);
  });

  test("a renamed repository keeps its ONE target and refreshes the display caches", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      targets: [{ repoId: 111, repoOwner: "acme", repoName: "old-name" }],
    });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = bodyFor({ id: 111, owner: "acme-org", name: "new-name" });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(await res.text()).toBe("accepted");
    expect(sent[0]!.targetId).toBe(appRow.targetId);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_targets WHERE bot_id = ?").get(appRow.id)).toEqual({ n: 1 });
    expect(
      db.raw.query("SELECT repo_owner, repo_name FROM review_targets WHERE id = ?").get(appRow.targetId),
    ).toEqual({ repo_owner: "acme-org", repo_name: "new-name" });
  });

  test("a repository with no target is ignored with 200 — zero enqueue, no ledger row", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = bodyFor({ id: 9999, owner: "other", name: "unknown-repo" });

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveries(db, appRow.id)).toEqual([{ event_name: "pull_request", outcome: "ignored" }]);
    expect(ledgerCount(db, appRow.id)).toBe(0);
    expect(lastWebhookAt(db, appRow.id)).not.toBeNull();
    const line = warn.mock.calls.map((call) => String(call[0])).find((s) => s.includes("no_target_for_repo"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!).detail).toContain("installation_id=123");
  });

  test("a bot with NO target ignores the delivery the same way", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [] });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveries(db, appRow.id)).toEqual([{ event_name: "pull_request", outcome: "ignored" }]);
    expect(ledgerCount(db, appRow.id)).toBe(0);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("no_target_for_repo");
  });

  test("a first delivery onto a historical (NULL repo_id) row CLAIMS the id", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      targets: [{ repoId: null, repoOwner: "acme", repoName: "widgets" }],
    });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = bodyFor({ id: 777, owner: "acme", name: "widgets" });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(await res.text()).toBe("accepted");
    expect(sent[0]!.targetId).toBe(appRow.targetId);
    expect(
      db.raw.query("SELECT repo_id, repo_owner, repo_name FROM review_targets WHERE id = ?").get(appRow.targetId),
    ).toEqual({ repo_id: 777, repo_owner: "acme", repo_name: "widgets" });
  });

  test("a payload without repository.id resolves by owner/name and claims nothing", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      targets: [{ repoId: null, repoOwner: "acme", repoName: "widgets" }],
    });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      ...PR_PAYLOAD,
      repository: { name: "widgets", owner: { login: "acme" } },
    });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(await res.text()).toBe("accepted");
    expect(sent[0]!.targetId).toBe(appRow.targetId);
    expect(db.raw.query("SELECT repo_id FROM review_targets WHERE id = ?").get(appRow.targetId)).toEqual({
      repo_id: null,
    });
  });

  test("the target's business pause suppresses the enqueue without reading the global flag", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{ reviewEnabled: 0 }] });
    db.raw.run("DROP TABLE server_flags");
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const { warn, stop } = captureWarn();
    let res: Response;
    try {
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      stop();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(deliveries(db, appRow.id)).toEqual([{ event_name: "pull_request", outcome: "paused" }]);
    expect(lastWebhookAt(db, appRow.id)).not.toBeNull();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("review_global_read_failed");
    const bot = db.raw.query("SELECT review_enabled FROM review_bots WHERE id = ?").get(appRow.id) as {
      review_enabled: number;
    };
    expect(bot.review_enabled).toBe(1);
  });
});

describe("webhook install bookkeeping", () => {
  async function seedSharedBot(db: TestD1, slug: string): Promise<{ id: string; targetId: string }> {
    const row = await seedApp(db, { slug, secret: "secret-x" });
    db.raw.prepare("UPDATE review_bots SET scope = 'shared' WHERE id = ?").run(row.id);
    return { id: row.id, targetId: row.targetId };
  }

  function installationRows(
    db: TestD1,
  ): Array<{ bot_id: string; installation_id: number; account_login: string | null; removed_at: string | null }> {
    return db.raw
      .query("SELECT bot_id, installation_id, account_login, removed_at FROM bot_installations")
      .all() as Array<{
      bot_id: string;
      installation_id: number;
      account_login: string | null;
      removed_at: string | null;
    }>;
  }

  test("installation.created records the install for the bot and touches no target", async () => {
    const db = createMigratedTestD1();
    const app = await seedSharedBot(db, "app-x");
    const { queue, sent } = makeQueue();
    const body = JSON.stringify({ action: "created", installation: { id: 4242, account: { login: "acme" } } });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body, "installation"),
      makeEnv(db, { REVIEW_QUEUE: queue as never }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toEqual([
      { bot_id: app.id, installation_id: 4242, account_login: "acme", removed_at: null },
    ]);
  });

  test("a delivery under an installation with no matching repository is ignored", async () => {
    const db = createMigratedTestD1();
    await seedSharedBot(db, "app-x");
    const { queue, sent } = makeQueue();
    const body = JSON.stringify({
      ...PR_PAYLOAD,
      installation: { id: 9999 },
      repository: { id: 9999, name: "elsewhere", owner: { login: "stranger" } },
    });

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      await sigHeaders("secret-x", body),
      makeEnv(db, { REVIEW_QUEUE: queue as never }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
  });
});

describe("settleRefusedAfterAttach — the settlement follows the attach", () => {
  test("settles nothing while the attach is still in flight, then settles once", async () => {
    let finishAttach!: () => void;
    const attach = new Promise<void>((resolve) => {
      finishAttach = resolve;
    });
    const settle = mock(async () => true);
    const warn = mock((_detail: string) => {});

    const settled = settleRefusedAfterAttach({ attach, settle, warn });

    expect(settle).toHaveBeenCalledTimes(0);
    expect(warn).toHaveBeenCalledTimes(0);

    finishAttach();
    await settled;

    expect(settle).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("an already-finished attach settles immediately, and a settlement fault is one warn", async () => {
    const settle = mock(async () => {
      throw new Error("store down");
    });
    const warn = mock((_detail: string) => {});

    await settleRefusedAfterAttach({ attach: Promise.resolve(), settle, warn });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("store down");
  });

  test("a refusal settles from the head's confirmed proof against the App's real gate, with no adapter call", async () => {
    const db = createMigratedTestD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x", targets: [{}] });
    const target = db.raw
      .query("SELECT * FROM review_targets WHERE id = ?")
      .get(appRow.targetId) as ReviewTargetRow;
    const bot = db.raw.query("SELECT github_app_id FROM review_bots WHERE id = ?").get(appRow.id) as {
      github_app_id: number;
    };
    const scope = {
      appId: appRow.id,
      installationId: 123,
      owner: FIXTURE_REPO.owner,
      repo: FIXTURE_REPO.name,
      prNumber: 42,
    };
    const HEAD = "0123456789abcdef0123456789abcdef01234567";
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms, confirmed_ms)
         VALUES ('refused-proof', ?, 123, ?, ?, 42, ?, 'review', 'confirmed', ?, ?, 1, 'done', 1000, 1000, 1000)`,
      )
      .run(
        appRow.id,
        scope.owner,
        scope.repo,
        HEAD,
        JSON.stringify({ version: 1, artifact: { payload: { verdict: "ship it", tally: { scorePct: 85 } } } }),
        JSON.stringify({
          publicationId: "refused-proof",
          scope,
          headSha: HEAD,
          kind: "review",
          round: 1,
          commentId: 7,
          bodySha256: "b".repeat(64),
          confirmedMs: 1000,
        }),
      );
    let updateCalls = 0;
    const octokit: ChecksOctokit = {
      rest: {
        checks: {
          create: async (params: ChecksCreateParams) => ({
            data: {
              id: 4242,
              name: params.name,
              head_sha: params.head_sha,
              external_id: params.external_id,
              status: "queued",
              conclusion: null,
              app: { id: bot.github_app_id },
            },
          }),
          update: async () => {
            updateCalls += 1;
            throw new Error("the refusal lane must never call GitHub");
          },
          get: async () => {
            throw new Error("the refusal lane must never call GitHub");
          },
          listForRef: async () => {
            throw new Error("the refusal lane must never call GitHub");
          },
        },
      },
    };
    const adapter = createChecksAdapter({
      db: db as never,
      nowMs: () => Date.now(),
      getOctokit: async () => octokit,
    });
    const attached = await attachCheckAtAcceptance(
      { db: db as never, adapter, nowMs: () => Date.now() },
      {
        scope,
        githubAppId: bot.github_app_id,
        headSha: HEAD,
        triggeredBy: "pull_request",
        action: "opened",
        deliveryId: "refused-delivery",
      },
    );
    expect(attached.kind).toBe("attached");

    const settled = await refusalSkipSettlement({ db: db as never, target }).settleSkipped({
      scope,
      headSha: HEAD,
      triggeredBy: "pull_request",
      action: "opened",
      attachDeliveryId: "refused-delivery",
      reason: "review admission refused: pr-held",
    });

    expect(settled).toBe(true);
    const row = db.raw.query("SELECT * FROM review_checks WHERE head_sha = ?").get(HEAD) as {
      desired: string;
      observed: string;
      terminal_ms: number | null;
      holder: string | null;
    };
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("unknown");
    expect(row.terminal_ms).toBeNull();
    expect(row.holder).toBeNull();
    expect(updateCalls).toBe(0);
  });
});

describe("POST /webhook/:workspaceId/:appId — the monthly RP ceiling", () => {
  const month = quotaMonth(new Date());

  function seedPro(db: TestD1): void {
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'pro', 'active', datetime('now'), datetime('now'))`,
      )
      .run();
  }

  function seedUsage(db: TestD1, reviewId: string, rp: number, occurredAt = new Date().toISOString()): void {
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp)
         VALUES (?, 1, ?, 'default', ?, ?)`,
      )
      .run(reviewId, `token-${reviewId}`, occurredAt, rp);
  }

  function setCeiling(db: TestD1, monthlyRp: number | null): void {
    db.raw.prepare("UPDATE quota_profile_plans SET monthly_rp = ? WHERE profile_id = 'quota-v1' AND plan_id = 'pro'").run(monthlyRp);
  }

  test("a review that exactly fills the month's remaining headroom is admitted; one RP over refuses it", async () => {
    for (const [usedRp, expected] of [
      [14, "enqueued"],
      [15, "refused"],
    ] as const) {
      const db = createMigratedTestD1();
      seedPro(db);
      setCeiling(db, 20);
      const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
      db.raw.prepare("UPDATE review_targets SET review_level = 'deep' WHERE id = ?").run(appRow.targetId);
      seedUsage(db, "prior", usedRp);
      const { queue, sent } = makeQueue();
      const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
      const body = JSON.stringify(PR_PAYLOAD);

      const res = await postWebhook(
        "/webhook/default/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
        env,
      );

      expect(res.status).toBe(200);
      if (expected === "enqueued") {
        expect(sent).toHaveLength(1);
        expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 0 });
      } else {
        expect(sent).toHaveLength(0);
        expect(db.raw.query("SELECT COUNT(*) AS n FROM comment_trigger_claims").get()).toEqual({ n: 0 });
        expect(db.raw.query("SELECT COUNT(*) AS n FROM usage_events WHERE review_id <> 'prior'").get()).toEqual({ n: 0 });
        const failures = db.raw
          .query("SELECT stage, error, target_id FROM review_failures ORDER BY rowid")
          .all() as Array<{ stage: string; error: string; target_id: string }>;
        expect(failures).toHaveLength(1);
        expect(failures[0]!.stage).toBe(QUOTA_STAGE);
        expect(failures[0]!.target_id).toBe(appRow.targetId);
        expect(failures[0]!.error).toBe(CHECK_SUMMARIES.skippedByDelivery(QUOTA_SKIP_REASON));
        const delivery = db.raw
          .query("SELECT outcome FROM webhook_deliveries WHERE bot_id = ? ORDER BY rowid DESC LIMIT 1")
          .get(appRow.id) as { outcome: string };
        expect(delivery.outcome).toBe("skipped");
      }
    }
  });

  test("a NULL ceiling is unlimited: no sum is read and nothing refuses", async () => {
    const db = createMigratedTestD1();
    seedPro(db);
    setCeiling(db, null);
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    seedUsage(db, "prior", 1_000_000);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 0 });
  });

  test("a pre-metering row (rp 0) contributes nothing to the ceiling", async () => {
    const db = createMigratedTestD1();
    seedPro(db);
    setCeiling(db, 6);
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw.prepare("UPDATE review_targets SET review_level = 'deep' WHERE id = ?").run(appRow.targetId);
    db.raw
      .prepare(
        `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at)
         VALUES ('pre-metering', 1, 'token-pre', 'default', ?)`,
      )
      .run(new Date().toISOString());
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test("a previous month's spend never counts against this one", async () => {
    const db = createMigratedTestD1();
    seedPro(db);
    setCeiling(db, 6);
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw.prepare("UPDATE review_targets SET review_level = 'deep' WHERE id = ?").run(appRow.targetId);
    const before = new Date(Date.parse(month.startIso) - 1).toISOString();
    seedUsage(db, "last-month", 1000, before);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test("a delivery that would fail both gates records exactly one failure, of the entitlement stage", async () => {
    const db = createMigratedTestD1();
    setCeiling(db, null);
    db.raw.prepare("UPDATE quota_profile_plans SET monthly_rp = 1 WHERE profile_id = 'quota-v1' AND plan_id = 'free'").run();
    seedUsage(db, "prior", 1000);
    await seedApp(db, { slug: "app-x", secret: "secret-x", scope: "shared" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DEPLOYMENT_MODE: "saas" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    const failures = db.raw
      .query("SELECT stage FROM review_failures ORDER BY rowid")
      .all() as Array<{ stage: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.stage).toBe(SHARED_BOT_ENTITLEMENT_STAGE);
  });

  test("self-hosted never meters and never refuses, even with a spent month", async () => {
    const db = createMigratedTestD1();
    setCeiling(db, 1);
    seedUsage(db, "prior", 1_000_000);
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 0 });
  });
});
