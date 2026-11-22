import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSessionValue, SESSION_COOKIE } from "../../src/dashboard/session";
import { SPA_BOOT_MARKER, withSpaAssets } from "../helpers/spa";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createUser } from "../../src/dashboard/users";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");

function memberDbStub(): Env["DB"] {
  return {
    prepare: (sql: string) =>
      sql.includes("review_runtime_settings WHERE key IN")
        ? { bind: () => ({ all: async () => ({ results: [] }) }) }
        : {
            bind: () => ({
              first: async () => ({
                id: "u-test",
                github_login: "octocat",
                role: "admin",
                created_at: new Date().toISOString(),
                invited_by: null,
              }),
            }),
          },
  } as unknown as Env["DB"];
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return withSpaAssets({
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    ...overrides,
  } as Env);
}

describe("GET /dashboard/insights (retired)", () => {
  test("an authenticated HTML navigation GET no longer serves the SPA shell", async () => {
    const session = await createSessionValue("octocat", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/insights", {
        headers: { Accept: "text/html", Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      makeEnv({ DB: memberDbStub() }),
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("a non-HTML GET falls through to the legacy app (guard 302, never the old HTML)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/insights"), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

const SESSION_SECRET_API = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const API_TEST_KEY = Buffer.alloc(32, 7).toString("base64");

async function insightsWorld(): Promise<{
  db: TestD1;
  env: Env;
  targetId: string;
  daysAgo: (n: number) => string;
}> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  seedDefaultMemberships(db, { octocat: "owner", mallory: "owner", hubot: "member" });
  const appId = crypto.randomUUID();
  const otherAppId = crypto.randomUUID();
  const box = createSecretbox(API_TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id: appId,
    githubSlug: "widgets-app",
    githubAppId: WIDGETS_APP_ID,
    name: "widgets-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${appId}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${appId}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  const targetId = seedTarget(db, appId, { name: "widgets-app", repoName: "widgets" });
  await createReviewBotsStore(db).createApp({
    id: otherAppId,
    githubSlug: "other-app",
    githubAppId: OTHER_APP_ID,
    name: "other-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${otherAppId}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${otherAppId}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  seedTarget(db, otherAppId, { name: "other-app", repoName: "other" });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const insertReview = db.raw.query(
    `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope, bot_id, target_id)
     VALUES (?, 123, ?, ?, ?, 'sha', ?, ?, 's', '{}', ?, (SELECT id FROM review_targets WHERE bot_id = ?))`,
  );
  const insertFinding = db.raw.query(
    `INSERT INTO findings (id, review_id, severity, category, title, body, fingerprint)
     VALUES (?, ?, ?, ?, ?, 'b', ?)`,
  );
  insertReview.run("r-a", "acme", "widgets", 1, daysAgo(25), "comment", appId, appId);
  insertFinding.run("f-a1", "r-a", "must-fix", "logic", "Null deref risk", "fp-x");
  insertFinding.run("f-a2", "r-a", "nit", null, "Trailing space", "fp-y");
  insertReview.run("r-b", "acme", "widgets", 2, daysAgo(15), "approve", appId, appId);
  insertFinding.run("f-b1", "r-b", "must-fix", "logic", "Null deref risk", "fp-x");
  insertReview.run("r-d", "acme", "portal", 4, daysAgo(10), "approve", appId, appId);
  insertReview.run("r-c", "globex", "gadgets", 3, daysAgo(5), "request changes", otherAppId, otherAppId);
  insertFinding.run("f-c1", "r-c", "should-fix", "security", "Injection", "fp-z");

  const env = {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DASHBOARD_SESSION_SECRET: SESSION_SECRET_API,
    DB: db,
  } as unknown as Env;
  return { db, env, targetId, daysAgo };
}

function apiCookie(sessionSecret: string, login: string): Promise<string> {
  return createSessionValue(login, null, sessionSecret);
}

const WIDGETS_APP_ID = 1001;
const OTHER_APP_ID = 1002;

function targetInsightsGet(env: Env, targetId: string, cookie: string, query = "") {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/default/api/targets/${targetId}/insights/summary${query === "" ? "" : `?${query}`}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    }),
    env,
  );
}

describe("GET /dashboard/api/targets/:targetId/insights/summary", () => {
  test("manager sees the target-scoped summary: full JSON shape, own-target reviews only", async () => {
    const { env, targetId, daysAgo } = await insightsWorld();
    const res = await targetInsightsGet(env, targetId, await apiCookie(SESSION_SECRET_API, "mallory"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      reviews_total: number;
      findings_by_severity: Array<{ severity: string; count: number }>;
      verdict_distribution: Array<{ verdict: string; count: number }>;
      weekly_trend: unknown[];
      daily_trend: Array<{ day_start: string; reviews: number; findings: number }>;
      findings_distribution: unknown[];
      repos: string[];
    };
    expect(Object.keys(body).sort()).toEqual(
      [
        "window_days",
        "reviews_total",
        "findings_by_severity",
        "verdict_distribution",
        "weekly_trend",
        "daily_trend",
        "findings_distribution",
        "repos",
      ].sort(),
    );
    expect(body.window_days).toBe(30);
    expect(body.reviews_total).toBe(3);
    expect(body.findings_by_severity).toEqual([
      { severity: "must-fix", count: 2 },
      { severity: "nit", count: 1 },
    ]);
    expect(body.verdict_distribution).toEqual([
      { verdict: "approve", count: 2 },
      { verdict: "comment", count: 1 },
    ]);
    expect(body.repos).toEqual([]);
    expect(body.daily_trend).toHaveLength(31);
    expect(body.daily_trend.reduce((acc, row) => acc + row.reviews, 0)).toBe(3);
    expect(body.daily_trend.reduce((acc, row) => acc + row.findings, 0)).toBe(3);
    const dayAt = (days: number) => body.daily_trend.find((row) => row.day_start === daysAgo(days).slice(0, 10))!;
    expect(dayAt(10)).toEqual({ day_start: daysAgo(10).slice(0, 10), reviews: 1, findings: 0 });
    expect(dayAt(25)).toEqual({ day_start: daysAgo(25).slice(0, 10), reviews: 1, findings: 2 });
  });

  test("the distribution carries the shared four-class series map, zero-filled in class order", async () => {
    const { env, targetId } = await insightsWorld();
    const res = await targetInsightsGet(env, targetId, await apiCookie(SESSION_SECRET_API, "mallory"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      findings_distribution: Array<{ by_severity: Record<string, number> }>;
    };
    expect(body.findings_distribution.length).toBeGreaterThan(0);
    for (const bucket of body.findings_distribution) {
      expect(Object.keys(bucket.by_severity)).toEqual(["must-fix", "should-fix", "may-fix", "nit"]);
    }
  });

  test("include=repos is target-scoped: another target's repo never appears", async () => {
    const { env, targetId } = await insightsWorld();
    const res = await targetInsightsGet(env, targetId, await apiCookie(SESSION_SECRET_API, "mallory"), "include=repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: string[] };
    expect(body.repos).toEqual(["acme/portal", "acme/widgets"]);
  });

  test("repo= filter: valid owner/repo echoed AND applied — the other-repo review drops out", async () => {
    const { env, targetId } = await insightsWorld();
    const res = await targetInsightsGet(
      env,
      targetId,
      await apiCookie(SESSION_SECRET_API, "mallory"),
      "repo=acme/widgets&include=repos",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: string; reviews_total: number };
    expect(body.repo).toBe("acme/widgets");
    expect(body.reviews_total).toBe(2);
  });

  test("malformed repo= → 400 (parseInsightsParams owner/repo semantics)", async () => {
    const { env, targetId } = await insightsWorld();
    const cookie = await apiCookie(SESSION_SECRET_API, "mallory");
    for (const repo of ["oops", "owner/repo/extra", "/repo", "owner/"]) {
      const res = await targetInsightsGet(env, targetId, cookie, `repo=${encodeURIComponent(repo)}`);
      expect(res.status, `repo=${repo}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `repo=${repo}`).toContain("repo");
    }
  });

  test("malformed include= → 400 (only `repos` is a valid extra)", async () => {
    const { env, targetId } = await insightsWorld();
    const cookie = await apiCookie(SESSION_SECRET_API, "mallory");
    for (const include of ["foo", "repos,foo", "repos,"]) {
      const res = await targetInsightsGet(env, targetId, cookie, `include=${include}`);
      expect(res.status, `include=${include}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `include=${include}`).toContain("include");
    }
  });

  test("non-manager member → 403 JSON; admin (non-creator) → 200", async () => {
    const { env, targetId } = await insightsWorld();
    const hubot = await targetInsightsGet(env, targetId, await apiCookie(SESSION_SECRET_API, "hubot"));
    expect(hubot.status).toBe(403);
    expect(((await hubot.json()) as { error?: string }).error).toBeDefined();

    const admin = await targetInsightsGet(env, targetId, await apiCookie(SESSION_SECRET_API, "octocat"));
    expect(admin.status).toBe(200);
  });

  test("unknown and soft-deleted targets → 404 JSON", async () => {
    const { db, env, targetId } = await insightsWorld();
    const unknown = await targetInsightsGet(env, "no-such-target", await apiCookie(SESSION_SECRET_API, "mallory"));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown target" });

    db.raw.query("UPDATE review_targets SET deleted_at = datetime('now') WHERE id = ?").run(targetId);
    const deleted = await targetInsightsGet(env, targetId, await apiCookie(SESSION_SECRET_API, "mallory"));
    expect(deleted.status).toBe(404);
  });

  test("window parse: malformed → 400; window=400 clamps to 90 with the effective window echoed", async () => {
    const { env, targetId } = await insightsWorld();
    const cookie = await apiCookie(SESSION_SECRET_API, "mallory");
    for (const window of ["abc", "30.5", "-5", ""]) {
      const res = await targetInsightsGet(env, targetId, cookie, `window=${window}`);
      expect(res.status, `window=${window}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `window=${window}`).toContain("window");
    }
    const clamped = await targetInsightsGet(env, targetId, cookie, "window=400");
    expect(clamped.status).toBe(200);
    expect(((await clamped.json()) as { window_days: number }).window_days).toBe(90);
  });

  test("daily_trend is [] on a week window while weekly_trend keeps its raw buckets", async () => {
    const { env, targetId } = await insightsWorld();
    const res = await targetInsightsGet(env, targetId, await apiCookie(SESSION_SECRET_API, "mallory"), "window=90");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      daily_trend: unknown[];
      weekly_trend: Array<{ week_start: string; reviews: number; findings: number }>;
    };
    expect(body.window_days).toBe(90);
    expect(body.daily_trend).toEqual([]);
    expect(body.weekly_trend.length).toBeGreaterThan(0);
  });

  test("the removed family answers 404, never a summary", async () => {
    const { env } = await insightsWorld();
    const cookie = await apiCookie(SESSION_SECRET_API, "mallory");
    for (const path of [
      `/dashboard/default/api/apps/${WIDGETS_APP_ID}/insights/summary`,
      "/dashboard/api/insights/summary",
    ]) {
      const res = await worker.fetch(
        new Request(`https://worker.local${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }),
        env,
      );
      expect(res.status, path).toBe(404);
    }
  });

});
