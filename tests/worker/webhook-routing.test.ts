/**
 * Per-App webhook routing tests (plan 13 Task 2, spec § Multi-App 契约).
 *
 * `POST /webhook/:appSlug` — shared pre-order with the legacy face:
 * body-size cap (413) → REVIEW_ENABLED kill-switch (2xx ignore) → slug
 * lookup (active, not deleted) → signature verify with THAT App's decrypted
 * webhook secret. The route attaches `appRef { kind: "app", appId }` after
 * classification (lock L3); the legacy `POST /webhook` attaches an explicit
 * `{ kind: "legacy" }`.
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
import type { PipelineEnv } from "../../src/pipeline/consumer";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const LEGACY_SECRET = "legacy-webhook-secret";

function createMigratedD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  for (const name of ["0004_github_apps.sql", "0005_reviews_app_id.sql"]) {
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

type RouteEnv = Env & Pick<PipelineEnv, "DB">;

function makeEnv(db: ReturnType<typeof createTestD1>, overrides: Partial<RouteEnv> = {}): RouteEnv {
  const { kv } = makeKv();
  const { queue } = makeQueue();
  return {
    APP_ID: "999",
    PRIVATE_KEY: "legacy-pem",
    WEBHOOK_SECRET: LEGACY_SECRET,
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

const PR_PAYLOAD = {
  action: "opened",
  number: 42,
  installation: { id: 123 },
  pull_request: { number: 42, head: { sha: "abc123" } },
  repository: { name: "test-repo", owner: { login: "test-owner" } },
};

describe("POST /webhook/:appSlug (per-App routing)", () => {
  test("valid signature with the App's own secret → 200 accepted, enqueued with appRef {kind:'app', appId}", async () => {
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
      appRef: { kind: "app", appId: appRow.id },
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
    // And the global env secret must not verify on a per-App route either.
    const resEnv = await postWebhook(
      `/webhook/${appX.slug}`,
      body,
      { "x-hub-signature-256": await signatureFor(LEGACY_SECRET, body), "x-github-event": "pull_request" },
      env,
    );
    expect(resEnv.status).toBe(401);
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

  test("REVIEW_ENABLED kill-switch precedes the slug lookup → 200 ignored, zero enqueue (spec ordering)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, REVIEW_ENABLED: undefined });
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
      appRef: { kind: "app", appId: appRow.id },
    });
  });

  test("idempotency identical to legacy: a second identical delivery is KV-skipped", async () => {
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

describe("POST /webhook (legacy face, lock L3 regression)", () => {
  test("still verifies with WEBHOOK_SECRET and attaches an EXPLICIT appRef {kind:'legacy'}", async () => {
    const db = createMigratedD1(); // unused by the legacy face — present for env shape parity
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook",
      body,
      { "x-hub-signature-256": await signatureFor(LEGACY_SECRET, body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      installation_id: 123,
      owner: "test-owner",
      repo: "test-repo",
      pr_number: 42,
      head_sha: "abc123",
      triggered_by: "pull_request",
      appRef: { kind: "legacy" },
    });
    // Never an App identity on the legacy face.
    expect((sent[0]!.appRef as { kind: string }).kind).toBe("legacy");
  });

  test("legacy signature verification unchanged: bad signature → 401", async () => {
    const db = createMigratedD1();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook(
      "/webhook",
      body,
      { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});
