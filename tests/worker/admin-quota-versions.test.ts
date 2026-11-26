import { describe, expect, mock, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { quotaMonth, quotaStartsOn } from "../../src/store/quota-store";
import { listQuotaVersions } from "../../src/admin/quota-versions";
import type { DashboardD1, DashboardD1Statement } from "../../src/dashboard/users";
import { QUOTA_SKIP_REASON, QUOTA_STAGE } from "../../src/contracts/failure-stages";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { syncSplitPair, createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "quota", "faces", "session", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const OPERATOR = "Support-Bot";

function envFor(db: TestD1, sent: ReviewJobPayload[] = []): Env {
  return {
    REVIEW_QUEUE: { send: mock(async (message: ReviewJobPayload) => void sent.push(message)) },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DEPLOYMENT_MODE: "saas",
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  } as unknown as Env;
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    crypto.randomUUID(),
    OPERATOR,
    "2026-10-01T00:00:00.000Z",
  );
  seed(
    db,
    `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
     VALUES ('review.route.workflow', 'on', datetime('now'))`,
  );
  return db;
}

function seedWorkspace(db: TestD1, id: string): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    id,
    id,
    id,
    "2026-10-01T00:00:00.000Z",
  );
}

function seedSubscription(db: TestD1, workspaceId: string, planId: string): void {
  seed(
    db,
    "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    workspaceId,
    planId,
    "2026-10-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
  );
}

function seedUsage(db: TestD1, workspaceId: string, rp: number, source: "byok" | "shared" = "byok"): void {
  const reviewId = `prior-${workspaceId}-${rp}-${source}`;
  seed(
    db,
    `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
    reviewId,
    `token-${reviewId}`,
    workspaceId,
    new Date().toISOString(),
    rp,
    source,
  );
}

function seedJudgingProfile(db: TestD1, ceilings: Record<string, number | null>): void {
  const month = quotaMonth(new Date());
  seed(
    db,
    `INSERT INTO quota_profiles
       (id, version, effective_from, base_quick, base_standard, base_deep,
        source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
     VALUES ('quota-candidate', 2, ?, 1, 2, 6, 1, 10, 20, NULL, ?, 'fixture')`,
    month.startIso,
    month.startIso,
  );
  for (const [planId, monthlyRp] of Object.entries(ceilings)) {
    seed(
      db,
      "INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('quota-candidate', ?, ?)",
      planId,
      monthlyRp,
    );
  }
}

async function adminFetch(
  db: TestD1,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Cookie: `${SESSION_COOKIE}=${await createSessionValue(OPERATOR, null, SESSION_SECRET)}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    envFor(db),
  );
}

function nextFirst(): string {
  return quotaMonth(new Date()).endIso.slice(0, 10);
}

function candidate(effectiveFrom = nextFirst()): Record<string, unknown> {
  return {
    effectiveFrom,
    base: { quick: 1, default: 2, deep: 6 },
    source: { byok: 1, shared: 10 },
    rpPerCredit: 20,
    monthlyRp: { free: 2000, pro: 20000, unlimited: null },
    notes: "fixture",
  };
}

describe("GET /_internal_admin/api/quota-versions", () => {
  test("lists every version with its derived interval and marks the judging one", async () => {
    const db = fixture();
    const month = quotaMonth(new Date());
    seed(
      db,
      `INSERT INTO quota_profiles
         (id, version, effective_from, base_quick, base_standard, base_deep,
          source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
       VALUES ('quota-v2', 2, ?, 1, 2, 6, 1, 10, 20, 'next', ?, 'fixture')`,
      month.endIso,
      month.endIso,
    );
    for (const planId of ["free", "pro", "unlimited"]) {
      seed(
        db,
        "INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('quota-v2', ?, NULL)",
        planId,
      );
    }

    const res = await adminFetch(db, "GET", "/api/quota-versions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      judgingVersion: number;
      nextVersion: number;
      plans: Array<{ id: string; name: string }>;
      versions: Array<Record<string, unknown>>;
      uncoveredPlanIds: string[];
    };
    expect(body).not.toHaveProperty("month");
    expect(body.judgingVersion).toBe(1);
    expect(body.nextVersion).toBe(3);
    expect(body.plans.map((plan) => plan.id)).toEqual(["free", "pro", "unlimited"]);
    expect(body.uncoveredPlanIds).toEqual([]);
    expect(body.versions).toEqual([
      {
        id: "quota-v1",
        version: 1,
        effectiveFrom: "2026-10-24T00:00:00.000Z",
        effectiveTo: month.endIso,
        state: "current",
        base: { quick: 1, default: 2, deep: 6 },
        source: { byok: 1, shared: 10 },
        rpPerCredit: 20,
        notes: "v1 baseline: free 2000 RP, pro 20000 RP, unlimited uncapped.",
        monthlyRp: { free: 2000, pro: 20000, unlimited: null },
      },
      {
        id: "quota-v2",
        version: 2,
        effectiveFrom: month.endIso,
        effectiveTo: null,
        state: "scheduled",
        base: { quick: 1, default: 2, deep: 6 },
        source: { byok: 1, shared: 10 },
        rpPerCredit: 20,
        notes: "next",
        monthlyRp: { free: null, pro: null, unlimited: null },
      },
    ]);
  });

  test("a version published mid-month shows as scheduled, never as current", async () => {
    const db = fixture();
    const month = quotaMonth(new Date());
    const midMonth = `${month.startIso.slice(0, 8)}15T00:00:00.000Z`;
    seed(
      db,
      `INSERT INTO quota_profiles
         (id, version, effective_from, base_quick, base_standard, base_deep,
          source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
       VALUES ('quota-mid', 2, ?, 1, 2, 6, 1, 10, 20, NULL, ?, 'fixture')`,
      midMonth,
      midMonth,
    );
    const res = await adminFetch(db, "GET", "/api/quota-versions");
    const body = (await res.json()) as {
      judgingVersion: number;
      versions: Array<{ version: number; state: string }>;
    };
    expect(body.judgingVersion).toBe(1);
    expect(body.versions.find((row) => row.version === 2)?.state).toBe("scheduled");
  });
});

describe("POST /_internal_admin/api/quota-versions/preview", () => {
  test("counts the workspaces already at or over the candidate ceiling at today's usage", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-over");
    seedSubscription(db, "ws-over", "free");
    seedUsage(db, "ws-over", 2001);
    seedWorkspace(db, "ws-exactly");
    seedSubscription(db, "ws-exactly", "free");
    seedUsage(db, "ws-exactly", 2000);
    seedWorkspace(db, "ws-under");
    seedSubscription(db, "ws-under", "free");
    seedUsage(db, "ws-under", 1999);

    const res = await adminFetch(db, "POST", "/api/quota-versions/preview", candidate());
    expect(res.status).toBe(200);
    const impact = (await res.json()) as { count: number; total: number; startsOn: string };
    const live = db.raw.query("SELECT COUNT(*) AS n FROM workspaces WHERE deleted_at IS NULL").get() as {
      n: number;
    };
    expect(impact).toEqual({ count: 2, total: live.n, startsOn: nextFirst() });
  });

  test("a NULL candidate ceiling is unlimited: that plan is never counted", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-unlimited");
    seedSubscription(db, "ws-unlimited", "unlimited");
    seedUsage(db, "ws-unlimited", 1_000_000);

    const res = await adminFetch(db, "POST", "/api/quota-versions/preview", candidate());
    const impact = (await res.json()) as { count: number };
    expect(impact.count).toBe(0);
  });

  test("a mid-month instant states the next 1st it judges; a 1st judges itself", async () => {
    const db = fixture();
    const first = nextFirst();
    const midMonth = `${first.slice(0, 8)}15`;
    const afterThat = new Date(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 1));

    const asFirst = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", candidate(first))).json()) as {
      startsOn: string;
    };
    expect(asFirst.startsOn).toBe(first);
    expect(quotaStartsOn(`${midMonth}T00:00:00.000Z`)).toBe(afterThat.toISOString().slice(0, 10));
    const asMid = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", candidate(midMonth))).json()) as {
      startsOn: string;
    };
    expect(asMid.startsOn).toBe(afterThat.toISOString().slice(0, 10));
  });

  test("every plan of the catalogue must be covered — a partial map is a 400", async () => {
    const db = fixture();
    const body = candidate();
    body.monthlyRp = { free: 2000, pro: 20000 };
    const res = await adminFetch(db, "POST", "/api/quota-versions/preview", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unlimited");
  });

  test("previews a blank-ceiling form and a pre-filled one alike, and writes nothing", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-over");
    seedSubscription(db, "ws-over", "free");
    seedUsage(db, "ws-over", 5000);
    const before = db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get();
    const live = (db.raw.query("SELECT COUNT(*) AS n FROM workspaces WHERE deleted_at IS NULL").get() as { n: number }).n;

    const blank = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", {
      ...candidate(),
      monthlyRp: { free: null, pro: null, unlimited: null },
    })).json()) as { count: number; total: number; startsOn: string };
    expect(blank).toEqual({ count: 0, total: live, startsOn: nextFirst() });

    const filled = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", candidate())).json()) as {
      count: number;
      total: number;
      startsOn: string;
    };
    expect(filled).toEqual({ count: 1, total: live, startsOn: nextFirst() });

    expect(db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get()).toEqual(before);
  });

  test("a regression: the ISO-instant effectiveFrom the console used to send is a named 400", async () => {
    const db = fixture();
    const res = await adminFetch(db, "POST", "/api/quota-versions/preview", {
      ...candidate(),
      effectiveFrom: `${nextFirst()}T00:00:00.000Z`,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("is not a calendar date (YYYY-MM-DD)");
    expect(db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get()).toEqual({ n: 1 });
  });
});

describe("POST /_internal_admin/api/quota-versions", () => {
  test("refuses without a preview", async () => {
    const db = fixture();
    const res = await adminFetch(db, "POST", "/api/quota-versions", candidate());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("/preview");
    expect(db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get()).toEqual({ n: 1 });
  });

  test("refuses a preview whose count no longer matches", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-over");
    seedSubscription(db, "ws-over", "free");
    seedUsage(db, "ws-over", 5000);
    const stale = { ...candidate(), impact: { count: 0, total: 1, startsOn: nextFirst() } };
    const res = await adminFetch(db, "POST", "/api/quota-versions", stale);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("preview");
    expect(db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get()).toEqual({ n: 1 });
  });

  test("publishes one profile with its plan rows and one audit row, mutating nothing else", async () => {
    const db = fixture();
    const before = db.raw.query("SELECT * FROM quota_profiles WHERE id = 'quota-v1'").get();
    const body = candidate();
    const impact = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", body)).json()) as {
      count: number;
      total: number;
      startsOn: string;
    };

    const res = await adminFetch(db, "POST", "/api/quota-versions", { ...body, impact });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ version: 2, startsOn: nextFirst() });

    const versions = db.raw.query("SELECT id, version FROM quota_profiles ORDER BY version").all();
    expect(versions).toEqual([
      { id: "quota-v1", version: 1 },
      { id: expect.any(String), version: 2 },
    ]);
    const created = db.raw.query("SELECT id FROM quota_profiles WHERE version = 2").get() as { id: string };
    expect(
      db.raw
        .query("SELECT plan_id, monthly_rp FROM quota_profile_plans WHERE profile_id = ? ORDER BY plan_id")
        .all(created.id),
    ).toEqual([
      { plan_id: "free", monthly_rp: 2000 },
      { plan_id: "pro", monthly_rp: 20000 },
      { plan_id: "unlimited", monthly_rp: null },
    ]);
    const audit = db.raw
      .query("SELECT actor_login, action, target_type, target_id FROM platform_audit_events")
      .all();
    expect(audit).toEqual([
      {
        actor_login: OPERATOR,
        action: "quota.profile.create",
        target_type: "quota_profile",
        target_id: created.id,
      },
    ]);
    expect(db.raw.query("SELECT * FROM quota_profiles WHERE id = 'quota-v1'").get()).toEqual(before);
  });

  test("refuses an effective time that would judge the month in progress", async () => {
    const db = fixture();
    const month = quotaMonth(new Date());
    const body = candidate(month.startIso.slice(0, 10));
    const impact = { count: 0, total: 1, startsOn: nextFirst() };
    const res = await adminFetch(db, "POST", "/api/quota-versions", { ...body, impact });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("month in progress");
    expect(db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get()).toEqual({ n: 1 });
  });

  test("accepts a mid-month instant and says which 1st it judges", async () => {
    const db = fixture();
    const first = nextFirst();
    const midMonth = `${first.slice(0, 8)}15`;
    const body = candidate(midMonth);
    const impact = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", body)).json()) as {
      count: number;
      total: number;
      startsOn: string;
    };
    const res = await adminFetch(db, "POST", "/api/quota-versions", { ...body, impact });
    expect(res.status).toBe(201);
    const following = new Date(
      Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 1),
    );
    expect(await res.json()).toEqual({ version: 2, startsOn: following.toISOString().slice(0, 10) });
  });

  test("refuses a second version at an instant another already holds", async () => {
    const db = fixture();
    const body = candidate();
    const impact = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", body)).json()) as {
      count: number;
      total: number;
      startsOn: string;
    };
    expect((await adminFetch(db, "POST", "/api/quota-versions", { ...body, impact })).status).toBe(201);
    const again = await adminFetch(db, "POST", "/api/quota-versions", { ...body, impact });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("already starts at");
    expect(db.raw.query("SELECT COUNT(*) AS n FROM quota_profiles").get()).toEqual({ n: 2 });
  });

  test("publishes version 1 end to end when no profile exists yet", async () => {
    const db = fixture();
    seed(db, "DELETE FROM quota_profile_plans");
    seed(db, "DELETE FROM quota_profiles");

    const impact = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", candidate())).json()) as {
      count: number;
      total: number;
      startsOn: string;
    };
    const res = await adminFetch(db, "POST", "/api/quota-versions", { ...candidate(), impact });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ version: 1, startsOn: nextFirst() });

    const listed = (await (await adminFetch(db, "GET", "/api/quota-versions")).json()) as {
      judgingVersion: number | null;
      uncoveredPlanIds: string[];
      versions: Array<{ version: number; effectiveFrom: string; monthlyRp: Record<string, number | null> }>;
    };
    expect(listed.judgingVersion).toBe(1);
    expect(listed.uncoveredPlanIds).toEqual([]);
    expect(
      listed.versions.map((row) => ({ version: row.version, effectiveFrom: row.effectiveFrom, monthlyRp: row.monthlyRp })),
    ).toEqual([
      {
        version: 1,
        effectiveFrom: `${nextFirst()}T00:00:00.000Z`,
        monthlyRp: { free: 2000, pro: 20000, unlimited: null },
      },
    ]);
  });
});

describe("the console gate", () => {
  test("a login outside the allowlist reads no quota versions", async () => {
    const db = fixture();
    const res = await worker.fetch(
      new Request("https://worker.local/_internal_admin/api/quota-versions", {
        headers: {
          Accept: "application/json",
          Cookie: `${SESSION_COOKIE}=${await createSessionValue("not-an-operator", null, SESSION_SECRET)}`,
        },
      }),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });

  test("a stored version has no edit path at all", async () => {
    const db = fixture();
    const before = db.raw.query("SELECT * FROM quota_profiles WHERE id = 'quota-v1'").get();
    for (const path of ["/api/quota-versions/quota-v1", "/api/quota-versions"]) {
      const res = await adminFetch(db, "PATCH", path, { notes: "rewritten" });
      expect(res.status).toBe(404);
    }
    expect(db.raw.query("SELECT * FROM quota_profiles WHERE id = 'quota-v1'").get()).toEqual(before);
  });
});

describe("the impact preview agrees with the enqueue", () => {
  test("preview count === refusals for the same seed data and the same numbers", async () => {
    const db = fixture();
    seedJudgingProfile(db, { free: 2000, pro: 20, unlimited: null });
    seedWorkspace(db, "ws-over");
    seedSubscription(db, "ws-over", "pro");
    seedUsage(db, "ws-over", 21, "shared");
    seedWorkspace(db, "ws-under");
    seedSubscription(db, "ws-under", "pro");
    seedUsage(db, "ws-under", 18, "byok");
    const over = await seedDelivery(db, "ws-over", "app-over", "secret-over", 7001);
    const under = await seedDelivery(db, "ws-under", "app-under", "secret-under", 7002);

    const numbers = {
      effectiveFrom: nextFirst(),
      base: { quick: 1, default: 2, deep: 6 },
      source: { byok: 1, shared: 10 },
      rpPerCredit: 20,
      monthlyRp: { free: 2000, pro: 20, unlimited: null },
    };
    const impact = (await (await adminFetch(db, "POST", "/api/quota-versions/preview", numbers)).json()) as {
      count: number;
      total: number;
    };
    expect(impact.count).toBe(1);
    expect(impact.total).toBe(
      (db.raw.query("SELECT COUNT(*) AS n FROM workspaces WHERE deleted_at IS NULL").get() as { n: number }).n,
    );

    const sent: ReviewJobPayload[] = [];
    const env = envFor(db, sent);
    const body = JSON.stringify(PR_PAYLOAD);
    const refused = await postWebhook("/webhook/ws-over/app-over", body, "secret-over", env);
    expect(refused.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(db.raw.query("SELECT stage FROM review_failures ORDER BY rowid").all()).toEqual([
      { stage: QUOTA_STAGE },
    ]);
    const failure = db.raw.query("SELECT error FROM review_failures").get() as { error: string };
    expect(failure.error).toContain(QUOTA_SKIP_REASON);

    const admitted = await postWebhook("/webhook/ws-under/app-under", body, "secret-under", env);
    expect(admitted.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.targetId).toBe(under.targetId);
    expect(sent.some((message) => message.targetId === over.targetId)).toBe(false);
  });
});

const PR_PAYLOAD = {
  action: "opened",
  number: 42,
  installation: { id: 123 },
  pull_request: { number: 42, state: "open", head: { sha: "abc123" }, user: { login: "alice" } },
  repository: { id: 7001, name: "test-repo", owner: { login: "test-owner" } },
};

async function seedDelivery(
  db: TestD1,
  workspaceId: string,
  appId: string,
  secret: string,
  githubAppId: number,
): Promise<{ targetId: string }> {
  const box = createSecretbox(TEST_KEY);
  const webhookSecretEnc = await box.encryptSecret(secret, `github_apps.webhook_secret_enc:${appId}`);
  const privateKeyEnc = await box.encryptSecret("test-pem", `github_apps.private_key_enc:${appId}`);
  seed(
    db,
    `INSERT INTO github_apps
       (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, scope, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'tester', 'active', 'owned', NULL, datetime('now'), datetime('now'))`,
    appId,
    appId,
    githubAppId,
    appId,
    privateKeyEnc,
    webhookSecretEnc,
  );
  seed(db, "INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)", appId, workspaceId);
  const targetId = `target-${appId}`;
  seed(
    db,
    `INSERT INTO review_targets
       (id, workspace_id, app_id, name, repo_id, repo_owner, repo_name,
        review_enabled, review_trigger_mode, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'every_push', 'tester', datetime('now'), datetime('now'))`,
    targetId,
    workspaceId,
    appId,
    appId,
    PR_PAYLOAD.repository.id,
    PR_PAYLOAD.repository.owner.login,
    PR_PAYLOAD.repository.name,
  );
  return { targetId };
}

async function postWebhook(path: string, body: string, secret: string, env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": await new Webhooks({ secret }).sign(body),
        "x-github-event": "pull_request",
      },
      body,
    }),
    env,
  );
}

describe("GET /_internal_admin/api/quota-versions — plan coverage", () => {
  function fixtureMissing(missing: string[]): TestD1 {
    const db = fixture();
    const month = quotaMonth(new Date());
    seed(
      db,
      `INSERT INTO quota_profiles (
         id, version, effective_from, base_quick, base_standard, base_deep,
         source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
       VALUES ('quota-gap', 2, ?, 1, 2, 6, 1, 10, 20, NULL, ?, 'test')`,
      month.startIso,
      month.startIso,
    );
    for (const planId of ["free", "pro", "unlimited"].filter((id) => !missing.includes(id))) {
      seed(
        db,
        "INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('quota-gap', ?, 1000)",
        planId,
      );
    }
    return db;
  }

  test("the JUDGING version's gap is reported, ordered, and nothing else is", async () => {
    const db = fixtureMissing(["pro"]);
    const res = await adminFetch(db, "GET", "/api/quota-versions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { judgingVersion: number; uncoveredPlanIds: string[] };
    expect(body.judgingVersion).toBe(2);
    expect(body.uncoveredPlanIds).toEqual(["pro"]);
  });

  test("a gap in a version that does NOT judge this month refuses nothing and is not reported", async () => {
    const db = fixture();
    const month = quotaMonth(new Date());
    seed(
      db,
      `INSERT INTO quota_profiles (
         id, version, effective_from, base_quick, base_standard, base_deep,
         source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
       VALUES ('quota-later', 2, ?, 1, 2, 6, 1, 10, 20, NULL, ?, 'test')`,
      month.endIso,
      month.endIso,
    );
    seed(db, "INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('quota-later', 'free', 1000)");
    const res = await adminFetch(db, "GET", "/api/quota-versions");
    const body = (await res.json()) as { judgingVersion: number; uncoveredPlanIds: string[] };
    expect(body.judgingVersion).toBe(1);
    expect(body.uncoveredPlanIds).toEqual([]);
  });

  test("the judging profile and the plan list come from one batch, with no independent read", async () => {
    const db = fixtureMissing(["pro"]);
    const reads = { batches: [] as number[], readsOutsideBatch: 0 };
    const wrapped = new Map<DashboardD1Statement, ReturnType<TestD1["prepare"]>>();
    const probe: DashboardD1 = {
      prepare(sql) {
        const inner = db.prepare(sql);
        const face: DashboardD1Statement = {
          bind(...values) {
            inner.bind(...values);
            return face;
          },
          async first() {
            reads.readsOutsideBatch += 1;
            return inner.first();
          },
          async all() {
            reads.readsOutsideBatch += 1;
            return inner.all();
          },
          async run() {
            reads.readsOutsideBatch += 1;
            return inner.run();
  syncSplitPair(db);
          },
        };
        wrapped.set(face, inner);
        return face;
      },
      async batch(statements) {
        reads.batches.push(statements.length);
        return db.batch(statements.map((statement) => wrapped.get(statement)!));
      },
    };

    const payload = await listQuotaVersions(probe, new Date());

    expect(reads.batches).toEqual([2]);
    expect(reads.readsOutsideBatch).toBe(0);
    expect(payload.judgingVersion).toBe(2);
    expect(payload.uncoveredPlanIds).toEqual(["pro"]);
  });

  test("a covered plan with a null ceiling is covered, not missing", async () => {
    const db = fixtureMissing([]);
    seed(db, "UPDATE quota_profile_plans SET monthly_rp = NULL WHERE profile_id = 'quota-gap' AND plan_id = 'unlimited'");
    const res = await adminFetch(db, "GET", "/api/quota-versions");
    const body = (await res.json()) as { judgingVersion: number; uncoveredPlanIds: string[] };
    expect(body.judgingVersion).toBe(2);
    expect(body.uncoveredPlanIds).toEqual([]);
  });

  test("a month preceding every version is judged by the earliest profile, and its gap is reported", async () => {
    const db = fixture();
    const month = quotaMonth(new Date());
    const start = new Date(month.startIso);
    const nearIso = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
    const farIso = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 1)).toISOString();
    seed(db, "DELETE FROM quota_profile_plans");
    seed(db, "DELETE FROM quota_profiles");
    seed(
      db,
      `INSERT INTO quota_profiles (
         id, version, effective_from, base_quick, base_standard, base_deep,
         source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
       VALUES ('quota-near', 9, ?, 1, 2, 6, 1, 10, 20, NULL, ?, 'test')`,
      nearIso,
      nearIso,
    );
    seed(
      db,
      `INSERT INTO quota_profiles (
         id, version, effective_from, base_quick, base_standard, base_deep,
         source_byok, source_shared, rp_per_credit, notes, created_at, created_by)
       VALUES ('quota-far', 10, ?, 1, 2, 6, 1, 10, 20, NULL, ?, 'test')`,
      farIso,
      farIso,
    );
    seed(
      db,
      "INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('quota-near', 'free', 1000)",
    );
    seed(
      db,
      "INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('quota-near', 'pro', 2000)",
    );
    seed(db, "INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp) VALUES ('quota-far', 'free', 3000)");
    const res = await adminFetch(db, "GET", "/api/quota-versions");
    const body = (await res.json()) as { judgingVersion: number; uncoveredPlanIds: string[] };
    expect(body.judgingVersion).toBe(9);
    expect(body.uncoveredPlanIds).toEqual(["unlimited"]);
  });

  test("an empty profile table renders the form instead of throwing, so version 1 can be published", async () => {
    const db = fixture();
    seed(db, "DELETE FROM quota_profile_plans");
    seed(db, "DELETE FROM quota_profiles");
    const res = await adminFetch(db, "GET", "/api/quota-versions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      judgingVersion: null,
      nextVersion: 1,
      plans: [
        { id: "free", name: "Free" },
        { id: "pro", name: "Pro" },
        { id: "unlimited", name: "Unlimited" },
      ],
      versions: [],
      uncoveredPlanIds: ["free", "pro", "unlimited"],
    });
  });
});
