/**
 * PR ledger on the per-App webhook face (migration 0039).
 *
 * Every VERIFIED, non-reject `pull_request` delivery records its PR — including
 * an `ignore` (an action that does not auto-trigger in the App's mode), which is
 * exactly the "the App received this PR but no review ran" row the dashboard
 * needs. A reject records nothing, and a store failure must not change the HTTP
 * status.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createTestD1, type TestD1 } from "../store/helpers";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SECRET = "test-webhook-secret";

function createMigratedD1(): TestD1 {
  const db = createTestD1();
  // The per-App face's own dependencies (github_apps rebuild chain, workspace
  // plane, the delivery log) plus 0039 itself — the ledger table.
  for (const name of [
    "0003_dashboard_users.sql",
    "0004_github_apps.sql",
    "0036_app_identity.sql",
    "0005_reviews_app_id.sql",
    "0008_github_apps_ops.sql",
    "0011_webhook_deliveries.sql",
    "0010_review_failures.sql",
    "0022_app_trigger_mode.sql",
    "0026_workspaces.sql",
    "0033_platform_admin.sql",
    "0018_app_sandbox_images.sql",
    "0019_github_apps_metadata.sql",
    "0037_github_metadata_attempt.sql",
    "0038_webhook_path_drop.sql",
    "0039_pull_requests.sql",
  ]) {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

async function seedApp(db: TestD1, mode: "open" | "every_push" | "manual"): Promise<string> {
  const id = `app-${mode}`;
  const box = createSecretbox(TEST_KEY);
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at, review_trigger_mode)
       VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', NULL, datetime('now'), datetime('now'), ?)`,
    )
    .run(
      id,
      id,
      5000 + mode.length,
      id,
      await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
      await box.encryptSecret(SECRET, `github_apps.webhook_secret_enc:${id}`),
      mode,
    );
  db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')").run(id);
  return id;
}

function makeEnv(db: unknown): Env {
  return {
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as never,
    REVIEW_QUEUE: { send: mock(async () => {}) } as never,
    DB: db as never,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
  };
}

const PR_PAYLOAD = {
  action: "opened",
  number: 131,
  installation: { id: 123 },
  pull_request: {
    number: 131,
    title: "Add a per-App PR surface",
    state: "open",
    merged: false,
    head: { sha: "abc123" },
  },
  repository: { name: "mstar-inspector", owner: { login: "btspoony" } },
};

async function deliver(appId: string, payload: unknown, env: Env, event = "pull_request"): Promise<Response> {
  const body = JSON.stringify(payload);
  return worker.fetch(
    new Request(`https://worker.local/webhook/default/${appId}`, {
      method: "POST",
      headers: { "x-hub-signature-256": await new Webhooks({ secret: SECRET }).sign(body), "x-github-event": event },
      body,
    }),
    env,
  );
}

function ledger(db: TestD1, appId: string): Array<Record<string, unknown>> {
  return db.raw.prepare("SELECT * FROM pull_requests WHERE app_id = ?").all(appId) as Array<Record<string, unknown>>;
}

describe("pull_request delivery → PR ledger", () => {
  test("a job delivery records the PR row", async () => {
    const db = createMigratedD1();
    const appId = await seedApp(db, "every_push");
    const res = await deliver(appId, PR_PAYLOAD, makeEnv(db));
    expect(res.status).toBe(200);
    const rows = ledger(db, appId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      owner: "btspoony",
      repo: "mstar-inspector",
      pr_number: 131,
      title: "Add a per-App PR surface",
      state: "open",
      head_sha: "abc123",
    });
  });

  test("an `ignore` delivery still records the PR (mode blocks the auto face)", async () => {
    const db = createMigratedD1();
    // `manual` mode never auto-triggers a pull_request → classifier ignores.
    const appId = await seedApp(db, "manual");
    const res = await deliver(appId, PR_PAYLOAD, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(ledger(db, appId).length).toBe(1);
  });

  test("merged: true is promoted to state 'merged'", async () => {
    const db = createMigratedD1();
    const appId = await seedApp(db, "every_push");
    await deliver(
      appId,
      { ...PR_PAYLOAD, action: "closed", pull_request: { ...PR_PAYLOAD.pull_request, state: "closed", merged: true } },
      makeEnv(db),
    );
    expect(ledger(db, appId)[0]!.state).toBe("merged");
  });

  test("a later `opened` delivery leaves a merged PR merged", async () => {
    const db = createMigratedD1();
    const appId = await seedApp(db, "every_push");
    await deliver(
      appId,
      {
        ...PR_PAYLOAD,
        action: "closed",
        pull_request: { ...PR_PAYLOAD.pull_request, state: "closed", merged: true, updated_at: "2026-03-01T00:00:00Z" },
      },
      makeEnv(db),
    );
    // A replayed / out-of-order `opened` for the same PR.
    await deliver(
      appId,
      { ...PR_PAYLOAD, action: "opened", pull_request: { ...PR_PAYLOAD.pull_request, updated_at: "2026-02-01T00:00:00Z" } },
      makeEnv(db),
    );
    expect(ledger(db, appId)[0]!.state).toBe("merged");
  });

  test("last_seen_at comes from the payload's updated_at", async () => {
    const db = createMigratedD1();
    const appId = await seedApp(db, "every_push");
    await deliver(
      appId,
      { ...PR_PAYLOAD, pull_request: { ...PR_PAYLOAD.pull_request, updated_at: "2026-03-04T05:06:07Z" } },
      makeEnv(db),
    );
    expect(ledger(db, appId)[0]!.last_seen_at).toBe("2026-03-04 05:06:07");
  });

  test("a pull_request-shaped ignore records nothing on a non-pull_request event", async () => {
    const db = createMigratedD1();
    const appId = await seedApp(db, "every_push");
    await deliver(appId, { ...PR_PAYLOAD, action: "assigned" }, makeEnv(db), "check_run");
    expect(ledger(db, appId).length).toBe(0);
  });

  test("a rejected payload records nothing", async () => {
    const db = createMigratedD1();
    const appId = await seedApp(db, "every_push");
    // 401 — the signature does not verify, so the classifier rejects before
    // any ledger write.
    const body = JSON.stringify(PR_PAYLOAD);
    const res = await worker.fetch(
      new Request(`https://worker.local/webhook/default/${appId}`, {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=bogus", "x-github-event": "pull_request" },
        body,
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(401);
    expect(ledger(db, appId).length).toBe(0);
  });

  test("a store failure logs a warn and leaves the HTTP status untouched", async () => {
    const db = createMigratedD1();
    const appId = await seedApp(db, "every_push");
    // Drop the ledger table under the route: the upsert throws, the response
    // must not change.
    db.raw.exec("DROP TABLE pull_requests");
    const res = await deliver(appId, PR_PAYLOAD, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
  });
});
