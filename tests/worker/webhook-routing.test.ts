/**
 * Per-App webhook routing tests (plan 13 Task 2, spec § Multi-App 契约).
 *
 * `POST /webhook/:appSlug` — the ONLY HTTP review entry (plan 24 Task 1:
 * the legacy bare `/webhook` face is retired):
 * body-size cap (413) → REVIEW_ENABLED emergency brake (exact "false" →
 * 2xx ignore; plan 31 AC4a — per-App `review_enabled` is the primary
 * control) → slug lookup (active, not deleted) → signature verify with THAT
 * App's decrypted webhook secret. The route attaches `appRef: { appId }`
 * after classification (lock L3).
 *
 * Isolation (AC-B5-isolation): App X's route verifies ONLY X's secret — a
 * sibling App's signature is a 401 with zero enqueue. Unknown slug /
 * disabled / soft-deleted → 404, zero enqueue. Any webhook-secret decrypt
 * failure (missing DASHBOARD_ENCRYPTION_KEY, tampered envelope) → 500
 * fail-closed (lock L1), zero enqueue.
 *
 * The D1 double is the real bun:sqlite helper over migrations 0001/0002 +
 * 0004/0005 (production-shaped; the store CRUD itself is pinned by
 * tests/worker/apps-store.test.ts — here the rows are seeded raw with
 * secretbox envelopes so the route exercises the real lookup + decrypt).
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createTestD1 } from "../store/helpers";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function createMigratedD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  // 0008 (plan 16): the github_apps ops columns (review_enabled /
  // last_webhook_at) the pause gate + touch read and write on every delivery
  // — the fixture must stay production-shaped.
  for (const name of ["0004_github_apps.sql", "0005_reviews_app_id.sql", "0008_github_apps_ops.sql"]) {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

type SeedOptions = {
  slug: string;
  /** Plaintext webhook secret encrypted into the row (with the row-id AAD). */
  secret: string;
  githubAppId?: number;
  /** Tamper anchor: encrypt the webhook secret under a WRONG row AAD. */
  wrongAad?: boolean;
};

/** Raw-insert an active, non-deleted github_apps row with real envelopes. */
async function seedApp(
  db: ReturnType<typeof createTestD1>,
  opts: SeedOptions,
): Promise<{ id: string; slug: string }> {
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  const aad = opts.wrongAad ? `github_apps.webhook_secret_enc:not-this-row` : `github_apps.webhook_secret_enc:${id}`;
  const webhookSecretEnc = await box.encryptSecret(opts.secret, aad);
  const privateKeyEnc = await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`);
  const appCount = (db.raw.query("SELECT COUNT(*) AS n FROM github_apps").get() as { n: number }).n;
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, opts.slug, opts.githubAppId ?? 1000 + appCount, opts.slug, privateKeyEnc, webhookSecretEnc);
  return { id, slug: opts.slug };
}

/** Queue stub capturing every enqueued payload. */
function makeQueue() {
  const sent: ReviewJobPayload[] = [];
  const queue = {
    send: mock(async (message: ReviewJobPayload) => {
      sent.push(message);
    }),
  };
  return { queue, sent };
}

/** In-memory KV stub (idempotency pre-check + claim). */
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

// Plan 13 T4: `Env` itself declares `DB` (optional, fail-closed when
// unbound) — the T2 local `Env & Pick<PipelineEnv, "DB">` intersection is
// retired on both the route and here.
type RouteEnv = Env;

function makeEnv(db: ReturnType<typeof createTestD1>, overrides: Partial<RouteEnv> = {}): RouteEnv {
  const { kv } = makeKv();
  const { queue } = makeQueue();
  return {
    REVIEW_ENABLED: "true",
    IDEMPOTENCY_KV: kv as never,
    REVIEW_QUEUE: queue as never,
    DB: db as never,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    ...overrides,
  };
}

async function postWebhook(path: string, body: string, headers: Record<string, string>, env: RouteEnv): Promise<Response> {
  return worker.fetch(new Request(`https://worker.local${path}`, { method: "POST", headers, body }), env);
}

/** Sign a body the way GitHub does (the sha256=… header value). */
async function signatureFor(secret: string, body: string): Promise<string> {
  return new Webhooks({ secret }).sign(body);
}

/** Full GitHub webhook headers for a signed delivery. */
async function sigHeaders(secret: string, body: string, event = "pull_request"): Promise<Record<string, string>> {
  return { "x-hub-signature-256": await signatureFor(secret, body), "x-github-event": event };
}

const PR_PAYLOAD = {
  action: "opened",
  number: 42,
  installation: { id: 123 },
  pull_request: { number: 42, head: { sha: "abc123" } },
  repository: { name: "test-repo", owner: { login: "test-owner" } },
};

describe("POST /webhook/:appSlug (per-App routing)", () => {
  test("valid signature with the App's own secret → 200 accepted, enqueued with appRef {appId}", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      installation_id: 123,
      owner: "test-owner",
      repo: "test-repo",
      pr_number: 42,
      head_sha: "abc123",
      action: "opened",
      triggered_by: "pull_request",
      appRef: { appId: appRow.id },
    });
  });

  test("wrong-App secret signature → 401, zero enqueue (sibling-App isolation, AC-B5-isolation)", async () => {
    const db = createMigratedD1();
    const appX = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const appY = await seedApp(db, { slug: "app-y", secret: "secret-y" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    // Y's secret against X's slug, and X's secret against Y's slug — both
    // fail verification (each route decrypts only ITS OWN App's secret).
    const resXY = await postWebhook(
      `/webhook/${appX.slug}`,
      body,
      { "x-hub-signature-256": await signatureFor("secret-y", body), "x-github-event": "pull_request" },
      env,
    );
    const resYX = await postWebhook(
      `/webhook/${appY.slug}`,
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(resXY.status).toBe(401);
    expect(resYX.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("unknown slug → 404, zero enqueue", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/no-such-app",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("disabled app → 404, zero enqueue", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createAppsStore(db).setAppStatus(appRow.id, "disabled")).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("soft-deleted app → 404, zero enqueue", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createAppsStore(db).softDeleteApp(appRow.id);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("REVIEW_ENABLED emergency brake (exact 'false') precedes the slug lookup → 200 ignored, zero enqueue (spec ordering)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "false" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
  });

  test("body-size cap precedes the slug lookup → 413, zero enqueue (spec ordering)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    // Header-only oversized request: rejected before the body is buffered.
    const res = await postWebhook(
      "/webhook/app-x",
      "",
      { "content-length": String(1_000_001), "x-github-event": "ping" },
      env,
    );

    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  test("missing signature header → 401, zero enqueue", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/app-x", body, { "x-github-event": "pull_request" }, env);

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("DASHBOARD_ENCRYPTION_KEY missing → 500 fail-closed, zero enqueue (AC-SEC)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DASHBOARD_ENCRYPTION_KEY: undefined });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  test("tampered webhook-secret envelope (wrong AAD) → 500 fail-closed, zero enqueue", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x", wrongAad: true });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  test("DB binding unbound → 500 fail-closed, zero enqueue (T4 Env fold)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DB: undefined });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  test("/review command via the per-App route enqueues the review_command payload with the appRef", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "/review" },
      issue: { number: 7, pull_request: {}, user: { login: "alice" } },
      repository: { name: "test-repo", owner: { login: "alice" } },
      sender: { type: "User", login: "alice" },
    });

    const res = await postWebhook(
      "/webhook/app-x",
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
      action: "created",
      triggered_by: "review_command",
      appRef: { appId: appRow.id },
    });
  });

  test("idempotency: a second identical delivery is KV-skipped", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { kv, store } = makeKv();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });
    const body = JSON.stringify(PR_PAYLOAD);
    const headers = { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" };

    const first = await postWebhook("/webhook/app-x", body, headers, env);
    const second = await postWebhook("/webhook/app-x", body, headers, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sent).toHaveLength(1); // the retry hit the claimed idempotency key
    const key = `idem:123:test-owner/test-repo:42:abc123`;
    expect(store.get(key)).toBe("1");
  });
});

describe("REVIEW_ENABLED semantic matrix (plan 31 AC4a — per-App governs; env is an emergency brake)", () => {
  function appOps(
    db: ReturnType<typeof createTestD1>,
    id: string,
  ): { review_enabled: number; last_webhook_at: string | null } {
    return db.raw
      .query("SELECT review_enabled, last_webhook_at FROM github_apps WHERE id = ?")
      .get(id) as { review_enabled: number; last_webhook_at: string | null };
  }

  /** POST a signed PR webhook, capturing the structured warn/info lines. */
  async function deliver(
    db: ReturnType<typeof createTestD1>,
    env: RouteEnv,
  ): Promise<{ res: Response; warns: string[]; infos: string[] }> {
    const body = JSON.stringify(PR_PAYLOAD);
    const warn = mock((_msg: unknown) => {});
    const info = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = warn;
    console.log = info;
    let res: Response;
    try {
      res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
    return {
      res,
      warns: warn.mock.calls.map((call) => String(call[0])),
      infos: info.mock.calls.map((call) => String(call[0])),
    };
  }

  test("unset env + review_enabled=1 → enqueued (accepted)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: undefined });
    const { res } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
  });

  test("unset env + review_enabled=0 → 2xx ignored, review_paused, last_webhook_at touched", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createAppsStore(db).setReviewEnabled(appRow.id, false);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: undefined });
    const { res, infos } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
    const line = infos.find((s) => s.includes("review_paused"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string; reason: string };
    expect(fields).toMatchObject({ event: "review_paused", reason: "review_paused" });
  });

  test('env "" + review_enabled=1 → enqueued (empty string is not the brake)', async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "" });
    const { res } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  test('env "true" + review_enabled=1 → enqueued', async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "true" });
    const { res } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  test('env "TRUE" + review_enabled=1 → enqueued (case-sensitive: not the brake)', async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "TRUE" });
    const { res } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  test('env exactly "false" + review_enabled=1 → 2xx ignored, review_disabled_kill_switch, no enqueue, no touch', async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "false" });
    const { res, warns } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).toBeNull();
    const line = warns.find((s) => s.includes("review_disabled_kill_switch"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string; reason: string };
    expect(fields).toMatchObject({ event: "review_disabled_kill_switch", reason: "review_disabled_kill_switch" });
  });

  test('env exactly "false" + review_enabled=0 → same as above (the brake wins over per-App pause)', async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createAppsStore(db).setReviewEnabled(appRow.id, false);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "false" });
    const { res, warns, infos } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).toBeNull();
    const line = warns.find((s) => s.includes("review_disabled_kill_switch"));
    expect(line).toBeDefined();
    // The per-App pause line must NOT ride the info channel — the brake
    // returned before the slug lookup, so review_paused never fires.
    expect(infos.some((s) => s.includes("review_paused"))).toBe(false);
  });

  test('env "false " + review_enabled=1 → enqueued (no trim)', async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "false " });
    const { res } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  test('env "False" + review_enabled=1 → enqueued (case-sensitive: not the brake)', async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "False" });
    const { res } = await deliver(db, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
  });
});

describe("installations upsert wiring (plan 13 Task 4)", () => {
  test("per-App webhook with installation_id → app_installations row INSERTED (seen_at set, bare login)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const rows = db.raw
      .query("SELECT app_id, installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{ app_id: string; installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.app_id).toBe(appRow.id);
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBeNull(); // the classified payload carries no login
    expect(typeof rows[0]!.seen_at).toBe("string");
  });

  test("second delivery touches the SAME row — seen_at refreshed, stored login preserved (COALESCE bare touch)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    const body1 = JSON.stringify(PR_PAYLOAD);
    await postWebhook(
      "/webhook/app-x",
      body1,
      { "x-hub-signature-256": await signatureFor("secret-x", body1), "x-github-event": "pull_request" },
      env,
    );
    // Backdate + stamp a login: the second delivery must UPDATE this row
    // (seen_at refresh) without wiping the stored login (bare touch).
    db.raw
      .prepare("UPDATE app_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
      .run();

    // Different PR/sha → a different idempotency key, so delivery 2 enqueues
    // (and therefore reaches the touch) instead of being KV-skipped.
    const body2 = JSON.stringify({ ...PR_PAYLOAD, number: 43, pull_request: { number: 43, head: { sha: "def456" } } });
    const res2 = await postWebhook(
      "/webhook/app-x",
      body2,
      { "x-hub-signature-256": await signatureFor("secret-x", body2), "x-github-event": "pull_request" },
      env,
    );

    expect(res2.status).toBe(200);
    expect(sent).toHaveLength(2);
    const rows = db.raw
      .query("SELECT installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1); // upsert — no duplicate row
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBe("alice"); // preserved by the COALESCE bare touch
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00"); // refreshed by the touch
  });

  test("KV-skipped duplicate delivery (identical body) still refreshes seen_at (QC F-006: upsert on ANY webhook)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { kv, store } = makeKv();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });

    const body = JSON.stringify(PR_PAYLOAD);
    const headers = { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" };
    const first = await postWebhook("/webhook/app-x", body, headers, env);
    expect(first.status).toBe(200);
    // Backdate + stamp a login: the duplicate delivery must refresh seen_at
    // WITHOUT wiping the stored login (bare touch).
    db.raw
      .prepare("UPDATE app_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
      .run();

    // GitHub redelivers the IDENTICAL signed body → the idempotency key is
    // already claimed, handleReviewJob skips the enqueue — but the touch
    // runs after handleReviewJob regardless of the skip outcome, so seen_at
    // is still refreshed (spec: upsert on ANY webhook carrying
    // installation_id; a duplicate delivery is still evidence the install
    // is alive).
    const second = await postWebhook("/webhook/app-x", body, headers, env);

    expect(second.status).toBe(200);
    expect(sent).toHaveLength(1); // the duplicate was KV-skipped, NOT re-enqueued
    expect(store.get(`idem:123:test-owner/test-repo:42:abc123`)).toBe("1");
    const rows = db.raw
      .query("SELECT installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1); // upsert — no duplicate row
    expect(rows[0]!.account_login).toBe("alice"); // preserved by the COALESCE bare touch
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00"); // refreshed despite the KV skip
  });

  test("upsert failure → structured warn, enqueue still succeeds (fire-and-forget bookkeeping)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    // D1 double that fails ONLY the app_installations upsert statement —
    // slug lookup / decrypt path stay healthy.
    const brokenDb = {
      raw: db.raw,
      batch: db.batch.bind(db),
      prepare(query: string) {
        if (query.includes("INSERT INTO app_installations")) {
          throw new Error("d1 unavailable (test injection)");
        }
        return db.prepare(query);
      },
    } as unknown as ReturnType<typeof createTestD1>;
    const { queue, sent } = makeQueue();
    const env = makeEnv(brokenDb, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    let res: Response;
    try {
      res = await postWebhook(
        "/webhook/app-x",
        body,
        { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
        env,
      );
    } finally {
      console.warn = origWarn;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1); // the review job was enqueued anyway
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("installation_upsert_failed");
    // The failed bookkeeping write left no row.
    expect((db.raw.query("SELECT COUNT(*) AS n FROM app_installations").get() as { n: number }).n).toBe(0);
  });
});

describe("per-App pause gate + last_webhook_at (plan 16, spec 语义锁 B3 / L5)", () => {
  /** Read the App row's ops columns back raw. */
  function appOps(
    db: ReturnType<typeof createTestD1>,
    id: string,
  ): { review_enabled: number; last_webhook_at: string | null; updated_at: string } {
    return db.raw
      .query("SELECT review_enabled, last_webhook_at, updated_at FROM github_apps WHERE id = ?")
      .get(id) as { review_enabled: number; last_webhook_at: string | null; updated_at: string };
  }

  test("enabled App → job enqueued AND last_webhook_at touched (2xx job outcome)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(appOps(db, appRow.id).review_enabled).toBe(1); // the 0008 resume default
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
  });

  test("paused App (review_enabled=0) → 2xx ignored, ZERO enqueue, last_webhook_at STILL touched", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createAppsStore(db).setReviewEnabled(appRow.id, false)).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const info = mock((_msg: unknown) => {});
    const origLog = console.log;
    console.log = info;
    let res: Response;
    try {
      res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), env);
    } finally {
      console.log = origLog;
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0); // zero enqueue — paused ≠ disabled
    // The touch is decoupled from the review switch (L5: paused still counts
    // as a verified 2xx delivery).
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
    // AL-23-2: the pause rides the structured INFO channel (warn→info —
    // paused is a legitimate ops state answering 2xx), filterable by event.
    const line = info.mock.calls.map((call) => String(call[0])).find((s) => s.includes("review_paused"));
    expect(line).toBeDefined();
    const fields = JSON.parse(line!) as { event: string };
    expect(fields.event).toBe("review_paused");
  });

  test("paused App, non-whitelisted event → 2xx ignored + touched (ignore outcome also counts)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createAppsStore(db).setReviewEnabled(appRow.id, false);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body, "ping"), env);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
  });

  test("reject path (bad signature → 401) never touches last_webhook_at", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("wrong-secret", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).toBeNull();
  });

  test("pre-verify emergency-brake return never touches last_webhook_at", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: "false" });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).toBeNull();
  });

  test("disabled / soft-deleted Apps → 404 never touch last_webhook_at (gate matrix)", async () => {
    const db = createMigratedD1();
    const disabledRow = await seedApp(db, { slug: "app-disabled", secret: "secret-d" });
    const deletedRow = await seedApp(db, { slug: "app-deleted", secret: "secret-r" });
    await createAppsStore(db).setAppStatus(disabledRow.id, "disabled");
    await createAppsStore(db).softDeleteApp(deletedRow.id);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const resDisabled = await postWebhook(
      "/webhook/app-disabled",
      body,
      await sigHeaders("secret-d", body),
      env,
    );
    const resDeleted = await postWebhook("/webhook/app-deleted", body, await sigHeaders("secret-r", body), env);

    expect(resDisabled.status).toBe(404);
    expect(resDeleted.status).toBe(404);
    expect(sent).toHaveLength(0);
    expect(appOps(db, disabledRow.id).last_webhook_at).toBeNull();
    expect(appOps(db, deletedRow.id).last_webhook_at).toBeNull();
  });

  test("touchLastWebhook writes ONLY last_webhook_at — updated_at stays the operator timestamp (L5)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    // Backdate BOTH columns: only last_webhook_at may move.
    db.raw
      .prepare("UPDATE github_apps SET updated_at = '2000-01-01 00:00:00', last_webhook_at = '2000-01-01 00:00:00' WHERE id = ?")
      .run(appRow.id);

    await createAppsStore(db).touchLastWebhook(appRow.id);

    const ops = appOps(db, appRow.id);
    expect(ops.last_webhook_at).not.toBe("2000-01-01 00:00:00"); // touched
    expect(ops.updated_at).toBe("2000-01-01 00:00:00"); // untouched
  });

  test("setReviewEnabled toggles review_enabled, writes updated_at, and refuses soft-deleted rows (setAppStatus precedent)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const store = createAppsStore(db);
    db.raw.prepare("UPDATE github_apps SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(appRow.id);

    // Pause: returns changed, writes both columns (an operator mutation).
    expect(await store.setReviewEnabled(appRow.id, false)).toBe(true);
    let ops = appOps(db, appRow.id);
    expect(ops.review_enabled).toBe(0);
    expect(ops.updated_at).not.toBe("2000-01-01 00:00:00");

    // Resume.
    expect(await store.setReviewEnabled(appRow.id, true)).toBe(true);
    expect(appOps(db, appRow.id).review_enabled).toBe(1);

    // Soft-deleted rows are refused: no write, false (a deleted app can
    // never be re-activated — or paused).
    await store.softDeleteApp(appRow.id);
    expect(await store.setReviewEnabled(appRow.id, false)).toBe(false);
    expect(appOps(db, appRow.id).review_enabled).toBe(1);

    // Unknown id → false, no write.
    expect(await store.setReviewEnabled("no-such-app", false)).toBe(false);
  });

  test("listInstallations returns THIS App's installations, most recently seen first (panel read face)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const sibling = await seedApp(db, { slug: "app-y", secret: "secret-y" });
    const store = createAppsStore(db);
    await store.upsertInstallation({ appId: appRow.id, installationId: 1, accountLogin: "old" });
    await store.upsertInstallation({ appId: appRow.id, installationId: 2, accountLogin: "recent" });
    await store.upsertInstallation({ appId: sibling.id, installationId: 3, accountLogin: "other-app" });
    // Backdate installation 1 so the order is observable.
    db.raw.prepare("UPDATE app_installations SET seen_at = '2000-01-01 00:00:00' WHERE installation_id = 1").run();

    const rows = await store.listInstallations(appRow.id);

    expect(rows).toHaveLength(2); // the sibling App's row is never included
    expect(rows[0]).toMatchObject({ installation_id: 2, account_login: "recent" }); // newest seen first
    expect(rows[1]).toMatchObject({ installation_id: 1, account_login: "old" });
    expect(typeof rows[0]!.seen_at).toBe("string");
    expect(await store.listInstallations("no-such-app")).toEqual([]);
  });
});

describe("verifier cache — rotation + cacheKey isolation (plan 15 L1)", () => {
  test("rotated webhook secret verifies with the NEW secret only (secret mismatch → rebuild + replace)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-v1" });
    const body = JSON.stringify(PR_PAYLOAD);

    // 1. First delivery memoizes the verifier under the row id (secret-v1).
    const firstQueue = makeQueue();
    const firstEnv = makeEnv(db, { REVIEW_QUEUE: firstQueue.queue as never });
    const first = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-v1", body), firstEnv);
    expect(first.status).toBe(200);
    expect(firstQueue.sent).toHaveLength(1);

    // 2. Rotate: a NEW envelope for a NEW secret on the SAME row (the
    //    dashboard re-save path; AES-GCM random IV → a fresh envelope).
    const box = createSecretbox(TEST_KEY);
    db.raw
      .prepare("UPDATE github_apps SET webhook_secret_enc = ? WHERE id = ?")
      .run(await box.encryptSecret("secret-v2", `github_apps.webhook_secret_enc:${appRow.id}`), appRow.id);

    // The NEW secret verifies — the cached entry's secret mismatched, so the
    // verifier was rebuilt + replaced under the same row-id cacheKey.
    const secondQueue = makeQueue();
    const secondEnv = makeEnv(db, { REVIEW_QUEUE: secondQueue.queue as never });
    const second = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-v2", body), secondEnv);
    expect(second.status).toBe(200);
    expect(secondQueue.sent).toHaveLength(1);

    // 3. The OLD secret no longer verifies — the replaced entry is gone
    //    exactly (rotation evicts the old secret's verifier).
    const staleQueue = makeQueue();
    const staleEnv = makeEnv(db, { REVIEW_QUEUE: staleQueue.queue as never });
    const stale = await postWebhook("/webhook/app-x", body, await sigHeaders("secret-v1", body), staleEnv);
    expect(stale.status).toBe(401);
    expect(staleQueue.sent).toHaveLength(0);
  });

});
