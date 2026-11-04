/**
 * Per-App webhook routing tests (spec § Multi-App 契约).
 *
 * `POST /webhook/:workspaceId/:appId` — the ONLY HTTP review entry
 * (the legacy bare `/webhook` face is retired):
 * body-size cap (413) → webhook-path lookup (active, not deleted) → signature verify →
 * per-App `review_enabled` pause gate. The route attaches `appRef: { appId }`
 * after classification (lock L3).
 *
 * Isolation (AC-B5-isolation): App X's route verifies ONLY X's secret — a
 * sibling App's signature is a 401 with zero enqueue. Unknown path /
 * disabled / soft-deleted → 404, zero enqueue. Any webhook-secret decrypt
 * failure (missing DASHBOARD_ENCRYPTION_KEY, tampered envelope) → 500
 * fail-closed (lock L1), zero enqueue.
 *
 * The D1 double is the real bun:sqlite helper over migrations 0001/0002 (the
 * base schema `createTestD1()` applies) plus 0003…0039 applied by
 * `createMigratedD1` below; production-shaped, the store CRUD itself is pinned
 * by tests/worker/apps-store.test.ts — here the rows are seeded raw with
 * secretbox envelopes so the route exercises the real lookup + decrypt).
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { WEBHOOK_BODY_LIMIT } from "../../src/worker/webhooks";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createTestD1, migrationsAfter, type TestD1 } from "../store/helpers";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function createMigratedD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  // 0004: github_apps + app_installations — the two tables the install
  // bookkeeping writes: every delivery upserts `account_login` into
  // app_installations (and the installation outcome path does too).
  // 0008: the github_apps ops columns (review_enabled /
  // last_webhook_at) the pause gate + touch read and write on every delivery.
  // 0005: reviews.app_id — applied after the 0004 parent table exists.
  // 0011: webhook_deliveries — the route's post-classify
  // recordDelivery is best-effort in production; with the table present the
  // fixture can pin WHAT it records (an invalid signature lands
  // a `rejected` row, never `ok`). Both append-only / additive — the fixture
  // must stay production-shaped.
  // 0022: github_apps.review_trigger_mode — the trigger context the route
  // threads into classifyWebhook (spec review-trigger-policy §2).
  // 0003/0026: the workspace data plane the strict read face joins
  // (`app_workspaces`, seeded with the single `default` workspace). Seeded
  // Apps here have NO mapping, so they are exactly the strict-mode orphan.
  // 0033: platform_admin — `server_flags`, the table the global
  // `review_global` enqueue gate reads.
  // 0036/0037/0018/0019/0038: the app-identity + ops columns, and the
  // parent-table rebuild that must carry every one of them.
  // 0039: pull_requests — the route writes one ledger row on EVERY verified,
  // non-reject `pull_request` delivery, so a fixture without it would send
  // every PR delivery down the `pull_request_record_failed` warn branch. Every
  // later migration (0040–…) is derived from the directory, so a new one joins
  // automatically — including 0043, which adds the delivery row's source
  // repository column `recordDelivery` names.
  for (const name of [
    "0003_dashboard_users.sql",
    "0004_github_apps.sql",
    // 0036: webhook_path (renamed from slug) + the cached github_slug.
    "0036_app_identity.sql",
    "0005_reviews_app_id.sql",
    "0008_github_apps_ops.sql",
    "0011_webhook_deliveries.sql",
    "0022_app_trigger_mode.sql",
    "0026_workspaces.sql",
    // 0033: the enqueue decision reads the `review_global` server flag.
    "0033_platform_admin.sql",
    // 0038 rebuilds github_apps, so the fixture must carry every column the
    // rebuild copies.
    "0018_app_sandbox_images.sql",
    "0019_github_apps_metadata.sql",
    "0037_github_metadata_attempt.sql",
    "0038_webhook_path_drop.sql",
    // 0039 references github_apps, so it runs after the 0038 rebuild.
    "0039_pull_requests.sql",
    ...migrationsAfter("0039_pull_requests.sql"),
  ]) {
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
  /**
   * Cached GitHub slug overrides the local path (which doubles as the slug
   * here); `null` seeds a row that predates its first metadata sync.
   */
  githubSlug?: string | null;
  /**
   * Per-App auto-trigger mode (migration 0022). OMITTED → the column is not
   * written, so the row exercises the DDL DEFAULT 'every_push'.
   */
  reviewTriggerMode?: "open" | "every_push" | "manual";
};

/** Raw-insert an active, non-deleted github_apps row with real envelopes. */
async function seedApp(
  db: ReturnType<typeof createTestD1>,
  opts: SeedOptions,
): Promise<{ id: string; slug: string }> {
  // The row id is the webhook URL's app segment, so this fixture uses the
  // slug as the id (one value, two roles — the production shape's identity).
  const id = opts.slug;
  const box = createSecretbox(TEST_KEY);
  const aad = opts.wrongAad ? `github_apps.webhook_secret_enc:not-this-row` : `github_apps.webhook_secret_enc:${id}`;
  const webhookSecretEnc = await box.encryptSecret(opts.secret, aad);
  const privateKeyEnc = await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`);
  const appCount = (db.raw.query("SELECT COUNT(*) AS n FROM github_apps").get() as { n: number }).n;
  const mode = opts.reviewTriggerMode;
  // `slug` is GitHub's own slug here (the bot mention target); the webhook
  // route keys on the row id + workspace instead.
  const baseArgs = [
    id,
    opts.githubSlug === undefined ? opts.slug : opts.githubSlug,
    opts.githubAppId ?? 1000 + appCount,
    opts.slug,
    privateKeyEnc,
    webhookSecretEnc,
  ] as const;
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at${mode !== undefined ? ", review_trigger_mode" : ""})
       VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now')${mode !== undefined ? ", ?" : ""})`,
    )
    .run(...(mode !== undefined ? [...baseArgs, mode] : [...baseArgs]));
  // Production shape: createApp writes the App and its workspace mapping in
  // one batch, so every execution-facing read (which joins app_workspaces)
  // resolves it.
  db.raw
    .prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')")
    .run(id);
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

// `Env` itself declares `DB` (optional, fail-closed when
// unbound) — the T2 local `Env & Pick<PipelineEnv, "DB">` intersection is
// retired on both the route and here.
type RouteEnv = Env;

function makeEnv(db: ReturnType<typeof createTestD1>, overrides: Partial<RouteEnv> = {}): RouteEnv {
  const { kv } = makeKv();
  const { queue } = makeQueue();
  return {
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

/** Close the global enqueue face: `review_global = 0` (migration 0033). */
function setReviewGlobalOff(db: ReturnType<typeof createTestD1>): void {
  db.raw
    .prepare("INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES ('review_global', 0, datetime('now'), 'fixture')")
    .run();
}

/** Statement predicates for `failingDb` (the two injected failure faces). */
const installUpsert = (query: string): boolean => query.includes("INSERT INTO app_installations");
const flagRead = (query: string): boolean => query.includes("FROM server_flags");

/**
 * D1 double that fails the statements matching `match`. Every other statement
 * (webhook-path lookup, delivery record, ledger, touch) stays healthy.
 *
 * `match` is a substring test: `INSERT INTO app_installations` exercises the
 * installation-bookkeeping failure, `FROM server_flags` the flag-read failure.
 */
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

/** Swap `console.warn` for a mock until `stop()` restores it. */
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
  // `state` is what the PR ledger (0039) requires of the payload: a
  // production `pull_request` delivery always carries it.
  pull_request: { number: 42, state: "open", head: { sha: "abc123" }, user: { login: "alice" } },
  repository: { name: "test-repo", owner: { login: "test-owner" } },
};

describe("POST /webhook/:workspaceId/:appId (per-App routing)", () => {
  test("valid signature with the App's own secret → 200 accepted, enqueued with appRef {appId}", async () => {
    const db = createMigratedD1();
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
    // The same delivery lands its PR-ledger row (migration 0039): the fixture
    // carries the table, so a missing/failed write here is a real regression
    // rather than the "no such table" warn branch this suite used to take.
    const ledger = db.raw
      .query("SELECT owner, repo, pr_number, state, head_sha FROM pull_requests WHERE app_id = ?")
      .all(appRow.id) as Array<{ owner: string; repo: string; pr_number: number; state: string; head_sha: string | null }>;
    expect(ledger).toEqual([
      { owner: "test-owner", repo: "test-repo", pr_number: 42, state: "open", head_sha: "abc123" },
    ]);
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

  // (F9/F10 strength pin): an invalid signature is the REJECTED
  // classification end to end — 401 on the wire, zero enqueue, and the
  // post-classify delivery row is `rejected` with the classifier's status,
  // never `ok` (AL-20-1: rejected rows are the fail-closed evidence the
  // diagnostics face exists to show).
  test("invalid signature → 401, zero enqueue, delivery row rejected — never ok", async () => {
    const db = createMigratedD1();
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
      .query("SELECT outcome, status_code FROM webhook_deliveries WHERE app_id = ?")
      .all(appRow.id) as Array<{ outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ outcome: "rejected", status_code: 401 }]);
  });

  test("unknown webhook path → 404, zero enqueue", async () => {
    const db = createMigratedD1();
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
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createAppsStore(db).setAppStatus(appRow.id, "disabled")).toBe(true);
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
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createAppsStore(db).softDeleteApp(appRow.id);
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
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    // Header-only oversized request: rejected before the body is buffered.
    const res = await postWebhook(
      "/webhook/default/app-x",
      "",
      { "content-length": String(1_000_001), "x-github-event": "ping" },
      env,
    );

    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  // 61-R1: the cap is byte-authoritative on the streamed body. The
  // truthful-header fast path above stays; these pin the streamed read — a
  // missing or lying header can never buffer past WEBHOOK_BODY_LIMIT, and an
  // at-limit body still passes (the streamed-decoded rawBody is
  // decode-identical, so the HMAC signature verifies exactly as before).
  test("truthful content-length header over the limit → 413 fast path, zero enqueue", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const oversized = "a".repeat(WEBHOOK_BODY_LIMIT + 1);

    // Gate attribution: the detail pins the HEADER fast path (not the
    // streamed read below) — without it a 413 alone cannot tell the two
    // gates apart.
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
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const oversized = "a".repeat(WEBHOOK_BODY_LIMIT + 1);

    // Gate attribution: the header (10) is under the limit, so the fast path
    // cannot fire — the `read_bytes>` detail pins the STREAMED gate as the
    // one that rejected (byte count, not the header).
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
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    // A stream body carries no content-length (the runtime cannot know it).
    // Two limit/2 chunks + 1 byte: the byte count crosses the cap only on
    // the third chunk — multi-chunk accumulation, a single byte over.
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
    // Gate attribution: no content-length header → the STREAMED gate fired;
    // the detail distinguishes it from the header fast path.
    const fields = JSON.parse(line!) as { event: string; reason: string; detail: string };
    expect(fields).toMatchObject({
      event: "webhook_body_too_large",
      reason: "webhook_body_too_large",
      detail: `read_bytes>${WEBHOOK_BODY_LIMIT}`,
    });
  });

  test("at-limit body (exactly WEBHOOK_BODY_LIMIT bytes) → 200 accepted, enqueued (HMAC verifies the streamed rawBody)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    // Pad the valid PR payload to EXACTLY the cap: the streamed read accepts
    // limit bytes, and the signature only verifies if the decode was
    // byte-identical to the buffered read (UTF-8 decode invariant).
    const base = JSON.stringify({ ...PR_PAYLOAD, pad: "" });
    const body = JSON.stringify({ ...PR_PAYLOAD, pad: "x".repeat(WEBHOOK_BODY_LIMIT - base.length) });
    expect(body.length).toBe(WEBHOOK_BODY_LIMIT);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pr_number: 42, appRef: { appId: appRow.id } });
  });

  // At-limit pin with MULTI-BYTE content: `body.length` counts UTF-16
  // units, so an all-ASCII at-limit body proves nothing about byte
  // accounting — this body pads with 3-byte chars and computes the byte
  // length explicitly (Buffer.byteLength), landing EXACTLY on
  // WEBHOOK_BODY_LIMIT bytes while its UTF-16 length sits well under the
  // cap. Acceptance + HMAC verify = the streamed gate counted bytes and the
  // decode stayed byte-identical.
  test("at-limit multi-byte UTF-8 body (exactly WEBHOOK_BODY_LIMIT bytes) → 200 accepted, enqueued (HMAC verifies)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const emptyPad = JSON.stringify({ ...PR_PAYLOAD, pad: "" });
    const padBytes = WEBHOOK_BODY_LIMIT - Buffer.byteLength(emptyPad);
    const pad = "漢".repeat(Math.floor(padBytes / 3)) + "x".repeat(padBytes % 3);
    const body = JSON.stringify({ ...PR_PAYLOAD, pad });
    expect(Buffer.byteLength(body)).toBe(WEBHOOK_BODY_LIMIT);
    expect(body.length).toBeLessThan(WEBHOOK_BODY_LIMIT); // the UTF-16 trap is real

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pr_number: 42, appRef: { appId: appRow.id } });
  });

  test("small valid webhook unchanged by the streamed cap → 200 accepted, enqueued", async () => {
    const db = createMigratedD1();
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
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, { "x-github-event": "pull_request" }, env);

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
      "/webhook/default/app-x",
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
      "/webhook/default/app-x",
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
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  test("bot mention via the per-App route enqueues the issue_comment payload with the appRef", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
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
      action: "created",
      triggered_by: "issue_comment",
      appRef: { appId: appRow.id },
    });
  });

  test("mode threading: a manual-mode App ignores pull_request.opened but a bot mention still enqueues", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x", reviewTriggerMode: "manual" });
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
    expect(sent).toHaveLength(0); // manual mode: the auto face never fires

    const mentionBody = JSON.stringify({
      action: "created",
      installation: { id: 123 },
      comment: { body: "@app-x" },
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
    expect(sent).toHaveLength(1); // the mention face works in every mode
    expect(sent[0]).toMatchObject({
      pr_number: 7,
      head_sha: null,
      triggered_by: "issue_comment",
      appRef: { appId: appRow.id },
    });
  });

  test("an unsynced App (github_slug NULL) logs mention_unresolved for a mention, still enqueues nothing", async () => {
    // Upgrade surface: migration 0036 adds github_slug with no backfill, so
    // every pre-existing row answers to no mention until its first metadata
    // sync. A `manual`-mode App has the mention as its ONLY trigger, which is
    // exactly the silent regression this warn makes observable. The delivery
    // outcome vocabulary stays unchanged — this is still an `ignored`.
    const db = createMigratedD1();
    await seedApp(db, {
      slug: "app-x",
      secret: "secret-x",
      githubSlug: null,
      reviewTriggerMode: "manual",
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
    // The delivery row still records the unchanged vocabulary.
    const deliveries = db.raw
      .query("SELECT outcome FROM webhook_deliveries")
      .all() as Array<{ outcome: string }>;
    expect(deliveries).toEqual([{ outcome: "ignored" }]);
  });

  test("a comment with no bot mention on an unsynced App stays a silent ignore (no mention_unresolved)", async () => {
    // The warn is reserved for a mention that WOULD have matched: an ordinary
    // comment on a never-synced App is the pre-existing, correct ignore.
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x", githubSlug: null });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    const warn = mock((_msg: unknown) => {});
    const origWarn = console.warn;
    console.warn = warn;
    try {
      for (const [label, payload] of [
        ["no mention at all", { comment: { body: "looks good to me" } }],
        // A mention on an event the classifier never reaches the mention check
        // for (`edited` is not whitelisted) must not warn either.
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
    // The author guard runs before the mention grammar, so the classifier
    // reports the author reason and the route's warn gate cannot fire.
    const db = createMigratedD1();
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
    // The not-a-PR gate precedes the mention grammar: an unsynced App's slug
    // is never consulted, so the warn cannot fire on a non-PR thread.
    const db = createMigratedD1();
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
    // Negative control for the `mention_unresolved` warn: THIS App IS synced, so
    // a mention aimed at `@app-y` is an ordinary ignore — and must stay silent.
    // Fails if the `appSlug === ""` conjunct is dropped from that gate.
    const db = createMigratedD1();
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
    const db = createMigratedD1();
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
    expect(sent).toHaveLength(1); // the retry hit the claimed idempotency key
    const key = `idem:123:test-owner/test-repo:42:abc123`;
    expect(store.get(key)).toBe("1");
  });
});

describe("tenant attribution on the webhook read face", () => {
  /** Drop the seed's mapping: what a pre-0026 row looks like before backfill. */
  function dropWorkspaceMapping(db: ReturnType<typeof createTestD1>, appId: string): void {
    db.raw.prepare("DELETE FROM app_workspaces WHERE app_id = ?").run(appId);
  }

  test("an unmapped (orphan) App answers 404 with zero decrypt, zero delivery row, zero enqueue", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    dropWorkspaceMapping(db, appRow.id);
    const { queue, sent } = makeQueue();
    // No DASHBOARD_ENCRYPTION_KEY: a decrypt attempt would 500, so a 404 also
    // proves the route never reached decryptSecret.
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, DASHBOARD_ENCRYPTION_KEY: undefined });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("unknown webhook path");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE app_id = ?")
      .get(appRow.id) as { n: number };
    expect(rows.n).toBe(0);
  });

  test("a workspace-mapped App serves and enqueues", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.appRef).toEqual({ appId: appRow.id });
  });
});

describe("installations upsert wiring", () => {
  test("per-App webhook with installation_id → app_installations row INSERTED (seen_at set, login from the delivery)", async () => {
    const db = createMigratedD1();
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
      .query("SELECT app_id, installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{ app_id: string; installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.app_id).toBe(appRow.id);
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBe("test-owner"); // the delivery's repository owner = installing account
    expect(typeof rows[0]!.seen_at).toBe("string");
  });

  test("second delivery touches the SAME row — seen_at refreshed, stored login left alone (inferred never overwrites)", async () => {
    const db = createMigratedD1();
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
    // Backdate + stamp a login no install event ever wrote: the second
    // delivery must UPDATE this row (seen_at refresh) but NOT replace the
    // login — its repository owner is an inference, and an inference only
    // fills an empty column.
    db.raw
      .prepare("UPDATE app_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
      .run();

    // Different PR/sha → a different idempotency key, so delivery 2 enqueues
    // (and therefore reaches the touch) instead of being KV-skipped.
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
      .query("SELECT installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1); // upsert — no duplicate row
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBe("alice"); // survives the review delivery
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00"); // refreshed by the touch
  });

  test("a review delivery carrying installation.account still only fills an empty login", async () => {
    // The route-level half of the authority rule: a `pull_request` payload's
    // own `installation.account` is still classified INFERRED
    // (`accountAuthoritative: false`), so it never replaces a stored login —
    // only an `installation.*` event may. Store-level directions are pinned in
    // tests/worker/apps-store.test.ts.
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const seedBody = JSON.stringify(PR_PAYLOAD);
    await postWebhook("/webhook/default/app-x", seedBody, await sigHeaders("secret-x", seedBody), env);
    db.raw
      .prepare("UPDATE app_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
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
      .query("SELECT account_login, seen_at FROM app_installations")
      .all() as Array<{ account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_login).toBe("alice"); // authoritative value never inferred
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00"); // still touched
  });

  test("KV-skipped duplicate delivery (identical body) still refreshes seen_at (QC F-006: upsert on ANY webhook)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { kv, store } = makeKv();
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never, IDEMPOTENCY_KV: kv as never });

    const body = JSON.stringify(PR_PAYLOAD);
    const headers = { "x-hub-signature-256": await signatureFor("secret-x", body), "x-github-event": "pull_request" };
    const first = await postWebhook("/webhook/default/app-x", body, headers, env);
    expect(first.status).toBe(200);
    // Backdate + stamp a stored login: the duplicate delivery must refresh
    // seen_at without replacing it — a review delivery only infers the login.
    db.raw
      .prepare("UPDATE app_installations SET seen_at = '2000-01-01 00:00:00', account_login = 'alice'")
      .run();

    // GitHub redelivers the IDENTICAL signed body → the idempotency key is
    // already claimed and handleReviewJob skips the enqueue — but the install
    // upsert runs before the enqueue, so seen_at is still refreshed (spec:
    // upsert on ANY webhook carrying installation_id; a duplicate delivery is
    // still evidence the install is alive).
    const second = await postWebhook("/webhook/default/app-x", body, headers, env);

    expect(second.status).toBe(200);
    expect(sent).toHaveLength(1); // the duplicate was KV-skipped, NOT re-enqueued
    expect(store.get(`idem:123:test-owner/test-repo:42:abc123`)).toBe("1");
    const rows = db.raw
      .query("SELECT installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1); // upsert — no duplicate row
    expect(rows[0]!.account_login).toBe("alice"); // survives — the inference never overwrites
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00"); // refreshed despite the KV skip
  });

  test("a later delivery that omits the login preserves the stored one (COALESCE bare touch)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });

    // Delivery 1 carries the login (repository owner alice) — the row stores it.
    const prBody = JSON.stringify({
      ...PR_PAYLOAD,
      repository: { name: "test-repo", owner: { login: "alice" } },
    });
    await postWebhook("/webhook/default/app-x", prBody, await sigHeaders("secret-x", prBody), env);
    // Backdate so the next write is provable; the login is what must survive.
    db.raw.prepare("UPDATE app_installations SET seen_at = '2000-01-01 00:00:00'").run();

    // Delivery 2 is a bare touch: an install event with no `account`, so the
    // classifier hands the route a null login and the store must keep alice.
    const bareBody = JSON.stringify({ action: "created", installation: { id: 123 } });
    const bare = await postWebhook("/webhook/default/app-x", bareBody, await sigHeaders("secret-x", bareBody, "installation"), env);

    expect(bare.status).toBe(200);
    expect(sent).toHaveLength(1); // the install delivery never enqueues
    const rows = db.raw
      .query("SELECT installation_id, account_login, seen_at FROM app_installations")
      .all() as Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.installation_id).toBe(123);
    expect(rows[0]!.account_login).toBe("alice"); // preserved — the bare touch carries no login
    expect(rows[0]!.seen_at).not.toBe("2000-01-01 00:00:00"); // still refreshed
  });

  test("the installation's own account is persisted, not the inferred repository owner", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    // The delivery states BOTH identities and they disagree: installation
    // account `octo-org`, repository owner `test-owner`.
    const body = JSON.stringify({ ...PR_PAYLOAD, installation: { id: 123, account: { login: "octo-org" } } });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const rows = db.raw
      .query("SELECT app_id, account_login FROM app_installations")
      .all() as Array<{ app_id: string; account_login: string | null }>;
    expect(rows).toEqual([{ app_id: appRow.id, account_login: "octo-org" }]);
    // The queue message keeps the repository owner: the account never enters
    // the payload, it is bookkeeping only.
    expect(sent[0]!.owner).toBe("test-owner");
  });

  test("paused App still records the login from a review-type delivery (bookkeeping is gate-independent)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createAppsStore(db).setReviewEnabled(appRow.id, false)).toBe(true);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...PR_PAYLOAD, installation: { id: 123, account: { login: "octo-org" } } });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0); // paused → zero enqueue
    const rows = db.raw
      .query("SELECT app_id, account_login FROM app_installations")
      .all() as Array<{ app_id: string; account_login: string | null }>;
    expect(rows).toEqual([{ app_id: appRow.id, account_login: "octo-org" }]);
  });

  test("review_global OFF still records the login from a review-type delivery (the flag gates enqueue only)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    setReviewGlobalOff(db);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify({ ...PR_PAYLOAD, installation: { id: 123, account: { login: "octo-org" } } });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0); // flag off → zero enqueue
    const rows = db.raw
      .query("SELECT app_id, account_login FROM app_installations")
      .all() as Array<{ app_id: string; account_login: string | null }>;
    expect(rows).toEqual([{ app_id: appRow.id, account_login: "octo-org" }]);
  });

  test("upsert failure → structured warn, enqueue still succeeds (fire-and-forget bookkeeping)", async () => {
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    // Only the installation upsert fails: the slug lookup / decrypt / delivery
    // record stay healthy, so the delivery exercises exactly that path.
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
    expect(sent).toHaveLength(1); // the review job was enqueued anyway
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("installation_upsert_failed");
    // The failed bookkeeping write left no row.
    expect((db.raw.query("SELECT COUNT(*) AS n FROM app_installations").get() as { n: number }).n).toBe(0);
  });
});

/**
 * `installation.*` deliveries: the only path that observes a fresh install
 * before any review traffic, so it is what fills `account_login` in the
 * settings table. Not review work — no enqueue, no pause/flag gate.
 */
describe("installation event path", () => {
  function installationRows(
    db: ReturnType<typeof createTestD1>,
  ): Array<{ app_id: string; installation_id: number; account_login: string | null }> {
    return db.raw
      .query("SELECT app_id, installation_id, account_login FROM app_installations")
      .all() as Array<{ app_id: string; installation_id: number; account_login: string | null }>;
  }

  function deliveryRows(
    db: ReturnType<typeof createTestD1>,
    appId: string,
  ): Array<{ event_name: string | null; outcome: string; status_code: number | null }> {
    return db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE app_id = ?")
      .all(appId) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
  }

  const INSTALL_PAYLOAD = {
    action: "created",
    installation: { id: 555, account: { login: "octo-org" } },
  };

  test.each(["created", "new_permissions_accepted"])(
    "installation.%s with account.login → row written with that login, zero enqueue, delivery ignored",
    async (action) => {
      const db = createMigratedD1();
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
      expect(sent).toHaveLength(0); // an install is never review work
      expect(installationRows(db)).toEqual([
        { app_id: appRow.id, installation_id: 555, account_login: "octo-org" },
      ]);
      expect(deliveryRows(db, appRow.id)).toEqual([
        { event_name: "installation", outcome: "ignored", status_code: null },
      ]);
      // A verified install delivery is a verified delivery: the same L5 touch
      // every non-reject outcome gets (lock L5 — "last verified delivery").
      const ops = db.raw
        .query("SELECT last_webhook_at FROM github_apps WHERE id = ?")
        .get(appRow.id) as { last_webhook_at: string | null };
      expect(ops.last_webhook_at).not.toBeNull();
    },
  );

  test("an install event OVERWRITES a stored login — the route passes the authoritative source", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    // A login the review path inferred earlier: an install event states the
    // installation's own account, so it must replace this value. The two
    // upsert statements differ ONLY by which side wins (apps-store
    // UPSERT_INSTALLATION_SQL), so this case fails when the route drops
    // `authoritative` or passes false on the installation branch — the
    // delivery would leave `alice` in place.
    db.raw
      .prepare(
        "INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('seed-1', ?, 555, 'alice', datetime('now'))",
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
      { app_id: appRow.id, installation_id: 555, account_login: "octo-org" },
    ]);
  });

  test("paused App (review_enabled=0) still records the installation — the pause gate does not apply", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    expect(await createAppsStore(db).setReviewEnabled(appRow.id, false)).toBe(true);
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
    // Recorded as an install, never as a paused review delivery.
    expect(deliveryRows(db, appRow.id)[0]!.outcome).toBe("ignored");
  });

  test("global review_global flag OFF still records the installation — the flag gates enqueue only", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    // Same D1 table `tests/worker/admin-flags.test.ts` uses: an ABSENT row
    // reads as enabled, so this row is what closes the global enqueue face.
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
      { app_id: appRow.id, installation_id: 555, account_login: "octo-org" },
    ]);
    expect(deliveryRows(db, appRow.id)[0]!.outcome).toBe("ignored");
  });

  test("installation.deleted → 200 ignored, no installation row", async () => {
    const db = createMigratedD1();
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
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(installationRows(db)).toHaveLength(0);
    expect(deliveryRows(db, appRow.id)[0]).toEqual({
      event_name: "installation",
      outcome: "ignored",
      status_code: null,
    });
  });

  test("malformed installation body (no installation.id) → 400, delivery rejected", async () => {
    const db = createMigratedD1();
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
    const db = createMigratedD1();
    await seedApp(db, { slug: "app-x", secret: "secret-x" });
    const { queue, sent } = makeQueue();
    // Only the installation upsert fails: the slug lookup / decrypt / delivery
    // record stay healthy, so the delivery exercises exactly that path.
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
    expect(sent).toHaveLength(0); // an install is never review work
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("installation_upsert_failed");
    // The failed bookkeeping write left no row.
    expect((db.raw.query("SELECT COUNT(*) AS n FROM app_installations").get() as { n: number }).n).toBe(0);
  });
});

describe("per-App pause gate + last_webhook_at (spec 语义锁 B3 / L5)", () => {
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

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

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
      res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);
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

  test("review_global OFF → 2xx ignored, ZERO enqueue, delivery recorded `paused` (never `ok`)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    setReviewGlobalOff(db);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0); // zero enqueue — the global kill switch
    // The App's own switch is ON, so only the global flag can explain the
    // outcome: `ok` means "job enqueued", and nothing was.
    expect(appOps(db, appRow.id).review_enabled).toBe(1);
    const rows = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE app_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "pull_request", outcome: "paused", status_code: null }]);
  });

  test("ignore delivery never depends on the review_global flag → 2xx ignored + delivery row recorded", async () => {
    // Job-scoped flag read: only a `job` can enqueue, so an `ignore` never
    // consults `review_global`. A route that started reading it here would
    // turn this 2xx into a 500, so make the table genuinely unreadable for
    // this request: the response, the delivery row and the ledger row then
    // pin the contract without inspecting SQL text.
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    db.raw.exec("DROP TABLE server_flags");
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    // `closed` is not a whitelisted pull_request action → classify → ignore.
    const body = JSON.stringify({ ...PR_PAYLOAD, action: "closed" });

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
    const rows = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE app_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "pull_request", outcome: "ignored", status_code: null }]);
    // The PR ledger is written BEFORE the ignore return, so an ignored
    // delivery still lands its row.
    const ledger = db.raw
      .query("SELECT pr_number, state FROM pull_requests WHERE app_id = ?")
      .all(appRow.id) as Array<{ pr_number: number; state: string }>;
    expect(ledger).toEqual([{ pr_number: 42, state: "open" }]);
  });

  test("bot-authored PR → 2xx ignored, ZERO enqueue, delivery row recorded `ignored`", async () => {
    const db = createMigratedD1();
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
    expect(sent).toHaveLength(0); // the classifier skip reaches the queue
    const rows = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE app_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "pull_request", outcome: "ignored", status_code: null }]);
    // The PR ledger is written before the ignore return: a bot-authored PR
    // must still reach it, or the per-App PR surface goes blind for them.
    const ledger = db.raw
      .query("SELECT pr_number, state FROM pull_requests WHERE app_id = ?")
      .all(appRow.id) as Array<{ pr_number: number; state: string }>;
    expect(ledger).toEqual([{ pr_number: 42, state: "open" }]);
  });

  test("malformed issue_comment (no installation.id) → 400, delivery row rejected", async () => {
    const db = createMigratedD1();
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
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE app_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(rows).toEqual([{ event_name: "issue_comment", outcome: "rejected", status_code: 400 }]);
  });

  test("flag read failure on a `job` delivery → 2xx ignored, ZERO enqueue, `paused`, all diagnostics kept", async () => {
    // The read sits before the delivery row, the PR ledger and the
    // last_webhook_at touch, so an unguarded failure would 500 an
    // already-verified job and drop all three. The read is best-effort and
    // fails CLOSED: a broken read counts as "reviews disabled", so nothing
    // enqueues and the row reads `paused` — a broken flag read must never
    // silently defeat the kill switch. Response and diagnostics stay healthy.
    const db = createMigratedD1();
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
    // Delivery row: `paused` (the fail-closed flag blocked the enqueue), never
    // `ok` — `ok` would claim a job ran while the kill switch was closed.
    const deliveries = db.raw
      .query("SELECT event_name, outcome, status_code FROM webhook_deliveries WHERE app_id = ?")
      .all(appRow.id) as Array<{ event_name: string | null; outcome: string; status_code: number | null }>;
    expect(deliveries).toEqual([{ event_name: "pull_request", outcome: "paused", status_code: null }]);
    // The three diagnostics of an already-verified delivery all still land.
    const ledger = db.raw
      .query("SELECT pr_number, state FROM pull_requests WHERE app_id = ?")
      .all(appRow.id) as Array<{ pr_number: number; state: string }>;
    expect(ledger).toEqual([{ pr_number: 42, state: "open" }]);
    expect(appOps(db, appRow.id).last_webhook_at).not.toBeNull();
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("review_global_read_failed");
  });

  test("paused App, non-whitelisted event → 2xx ignored + touched (ignore outcome also counts)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-x" });
    await createAppsStore(db).setReviewEnabled(appRow.id, false);
    const { queue, sent } = makeQueue();
    const env = makeEnv(db, { REVIEW_QUEUE: queue as never });
    const body = JSON.stringify(PR_PAYLOAD);

    const res = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-x", body, "ping"), env);

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
      "/webhook/default/app-x",
      body,
      { "x-hub-signature-256": await signatureFor("wrong-secret", body), "x-github-event": "pull_request" },
      env,
    );

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
    expect(appOps(db, appRow.id).last_webhook_at).toBeNull();
    // A rejected delivery validates nothing past the signature, so it writes
    // no PR ledger row either.
    expect(db.raw.query("SELECT pr_number FROM pull_requests WHERE app_id = ?").all(appRow.id)).toEqual([]);
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

describe("verifier cache — rotation + cacheKey isolation (L1)", () => {
  test("rotated webhook secret verifies with the NEW secret only (secret mismatch → rebuild + replace)", async () => {
    const db = createMigratedD1();
    const appRow = await seedApp(db, { slug: "app-x", secret: "secret-v1" });
    const body = JSON.stringify(PR_PAYLOAD);

    // 1. First delivery memoizes the verifier under the row id (secret-v1).
    const firstQueue = makeQueue();
    const firstEnv = makeEnv(db, { REVIEW_QUEUE: firstQueue.queue as never });
    const first = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-v1", body), firstEnv);
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
    const second = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-v2", body), secondEnv);
    expect(second.status).toBe(200);
    expect(secondQueue.sent).toHaveLength(1);

    // 3. The OLD secret no longer verifies — the replaced entry is gone
    //    exactly (rotation evicts the old secret's verifier).
    const staleQueue = makeQueue();
    const staleEnv = makeEnv(db, { REVIEW_QUEUE: staleQueue.queue as never });
    const stale = await postWebhook("/webhook/default/app-x", body, await sigHeaders("secret-v1", body), staleEnv);
    expect(stale.status).toBe(401);
    expect(staleQueue.sent).toHaveLength(0);
  });

});
