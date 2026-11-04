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
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SECRET = "test-webhook-secret";

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
    user: { login: "btspoony" },
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
    const db = createMigratedTestD1();
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
    const db = createMigratedTestD1();
    // `manual` mode never auto-triggers a pull_request → classifier ignores.
    const appId = await seedApp(db, "manual");
    const res = await deliver(appId, PR_PAYLOAD, makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(ledger(db, appId).length).toBe(1);
  });

  test("merged: true is promoted to state 'merged'", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db, "every_push");
    await deliver(
      appId,
      { ...PR_PAYLOAD, action: "closed", pull_request: { ...PR_PAYLOAD.pull_request, state: "closed", merged: true } },
      makeEnv(db),
    );
    expect(ledger(db, appId)[0]!.state).toBe("merged");
  });

  test("a later `opened` delivery leaves a merged PR merged", async () => {
    const db = createMigratedTestD1();
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

  test("an unparsable updated_at is dropped by the caller, not swallowed by datetime()", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db, "every_push");
    // `datetime('not-a-timestamp')` yields NULL, which used to be hidden by a
    // COALESCE inside the SQL. The caller now filters it, so the store takes
    // its OWN explicit "no usable stamp" branch and `last_seen_at` is never
    // NULL.
    const sent: Array<Record<string, unknown>> = [];
    const env = makeEnv(db);
    env.REVIEW_QUEUE = { send: mock(async (body: Record<string, unknown>) => { sent.push(body); }) } as never;
    await deliver(
      appId,
      { ...PR_PAYLOAD, pull_request: { ...PR_PAYLOAD.pull_request, updated_at: "not-a-timestamp" } },
      env,
    );
    const row = ledger(db, appId)[0]!;
    expect(row.last_seen_at).not.toBeNull();
    // The leg the consumer's fail-open rule rides on: a junk stamp must NOT
    // become a readable watermark, or the skip could accept it and ack the
    // PR's only review. `head_sha` is present on this delivery, so a non-NULL
    // `head_at` could only come from a fallback that invented a clock.
    expect(row.head_sha).toBe("abc123");
    expect(row.head_at).toBeNull();
    // Same field on the queued job: omitted, never degraded to a clock.
    expect(sent).toHaveLength(1);
    expect("head_at" in sent[0]!).toBe(false);
  });

  test("last_seen_at comes from the payload's updated_at", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db, "every_push");
    await deliver(
      appId,
      { ...PR_PAYLOAD, pull_request: { ...PR_PAYLOAD.pull_request, updated_at: "2026-03-04T05:06:07Z" } },
      makeEnv(db),
    );
    expect(ledger(db, appId)[0]!.last_seen_at).toBe("2026-03-04 05:06:07");
  });

  test("a pull_request-shaped ignore records nothing on a non-pull_request event", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db, "every_push");
    await deliver(appId, { ...PR_PAYLOAD, action: "assigned" }, makeEnv(db), "check_run");
    expect(ledger(db, appId).length).toBe(0);
  });

  test("a rejected payload records nothing", async () => {
    const db = createMigratedTestD1();
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

  test("a payload with no owner/repo/number is skipped VISIBLY, not silently", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db, "every_push");
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (line: unknown) => {
      warns.push(typeof line === "string" ? line : JSON.stringify(line));
    };
    try {
      // A non-whitelisted action with NO repository: the classifier ignores it
      // (so the route reaches the ledger branch) while `pullRequestRecord`
      // cannot form the tuple, which is exactly the skipped case.
      const res = await deliver(
        appId,
        { action: "assigned", installation: { id: 123 }, pull_request: { number: 131, state: "open" } },
        makeEnv(db),
      );
      expect(res.status).toBe(200);
    } finally {
      console.warn = originalWarn;
    }
    expect(ledger(db, appId).length).toBe(0);
    expect(warns.some((line) => line.includes("pull_request_record_skipped"))).toBe(true);
  });

  test("a store failure logs a warn and leaves the HTTP status untouched", async () => {
    const db = createMigratedTestD1();
    const appId = await seedApp(db, "every_push");
    // Drop the ledger table under the route: the upsert throws, the response
    // must not change — and the failure must still be visible in the log,
    // because "the ledger recorded nothing" and "the ledger could not record"
    // are different diagnoses and the caller only sees the response.
    db.raw.exec("DROP TABLE pull_requests");
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (line: unknown) => {
      warns.push(typeof line === "string" ? line : JSON.stringify(line));
    };
    let body: string;
    let status: number;
    try {
      const res = await deliver(appId, PR_PAYLOAD, makeEnv(db));
      status = res.status;
      body = await res.text();
    } finally {
      console.warn = originalWarn;
    }
    expect(status).toBe(200);
    expect(body).toBe("accepted");
    expect(warns.some((line) => line.includes("pull_request_record_failed"))).toBe(true);
  });
});
