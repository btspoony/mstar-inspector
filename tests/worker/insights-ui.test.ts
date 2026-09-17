/**
 * The global insights page is retired — /dashboard/insights is no longer a
 * SPA page and no longer dispatches to the SPA shell (neither an HTML
 * navigation GET nor any other GET reaches the SPA boot document on this
 * path). The data contract lives on the per-App JSON face
 * (GET /dashboard/api/apps/:slug/insights/summary); this file also pins
 * that face: membership + creator-or-admin gate with app-scoped data, and
 * the cross-App global endpoint removed with no compat shim.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createSessionValue, SESSION_COOKIE } from "../../src/dashboard/session";
import { SPA_BOOT_MARKER, withSpaAssets } from "../helpers/spa";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { createUser } from "../../src/dashboard/users";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");

/** Users-store D1 double: any session login resolves to a member row. */
function memberDbStub(): Env["DB"] {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          id: "u-test",
          github_login: "octocat",
          role: "admin",
          created_at: new Date().toISOString(),
          invited_by: null,
        }),
      }),
    }),
  } as unknown as Env["DB"];
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return withSpaAssets({
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
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
    // The route is gone from SPA_PAGES, so SPA dispatch never serves the
    // boot-injected index on this path — the legacy app answers instead.
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("window.__BOOT__=");
    expect(body).not.toContain(SPA_BOOT_MARKER);
  });

  test("a non-HTML GET falls through to the legacy app (guard 302, never the old HTML)", async () => {
    const res = await worker.fetch(new Request("https://worker.local/dashboard/insights"), makeEnv());
    // The mount-level membership guard answers before any route — the old
    // SSR handler would have rendered 200 HTML for a session-less request
    // only after the guard, so a 302 proves the handler is gone.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

// --- Per-App insights summary API -------------------------------
// GET /dashboard/api/apps/:slug/insights/summary — the JSON read face for
// the insights aggregation, scoped to one App via the store's `appId`
// filter. Gate: mount-level membership → app lookup by slug (unknown and
// soft-deleted are equally invisible, 404) → creator-or-admin (403). All
// deny bodies are `{ error }` JSON. The former cross-App global endpoint
// (GET /dashboard/api/insights/summary) is removed — no compat shim.
const SESSION_SECRET_API = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const API_TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Fixture world (per-App scoping): mallory owns "widgets-app"; octocat is
 * admin; hubot is a plain member. Reviews: three attributed to widgets-app
 * (25d / 15d ago sharing fingerprint fp-x → recurrence count 2, plus a
 * 10d approve in the app's second repo acme/portal), one attributed to a
 * DIFFERENT app (5d ago) that must never leak into widgets-app's numbers.
 */
async function insightsWorld(): Promise<{ db: TestD1; env: Env; appId: string }> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "octocat", role: "admin" });
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "hubot", role: "member" });
  const appId = crypto.randomUUID();
  const otherAppId = crypto.randomUUID();
  const box = createSecretbox(API_TEST_KEY);
  await createAppsStore(db).createApp({
    id: appId,
    slug: "widgets-app",
    githubAppId: 1001,
    name: "widgets-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${appId}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${appId}`),
    createdBy: "mallory",
  });
  await createAppsStore(db).createApp({
    id: otherAppId,
    slug: "other-app",
    githubAppId: 1002,
    name: "other-app",
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${otherAppId}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook-secret", `github_apps.webhook_secret_enc:${otherAppId}`),
    createdBy: "mallory",
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const insertReview = db.raw.query(
    `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope, app_id)
     VALUES (?, 123, ?, ?, ?, 'sha', ?, ?, 's', '{}', ?)`,
  );
  const insertFinding = db.raw.query(
    `INSERT INTO findings (id, review_id, severity, category, title, body, fingerprint)
     VALUES (?, ?, ?, ?, ?, 'b', ?)`,
  );
  insertReview.run("r-a", "acme", "widgets", 1, daysAgo(25), "comment", appId);
  insertFinding.run("f-a1", "r-a", "must-fix", "logic", "Null deref risk", "fp-x");
  insertFinding.run("f-a2", "r-a", "nit", null, "Trailing space", "fp-y");
  insertReview.run("r-b", "acme", "widgets", 2, daysAgo(15), "approve", appId);
  insertFinding.run("f-b1", "r-b", "must-fix", "logic", "Null deref risk", "fp-x");
  // Second repo of the SAME app — lets the repo= filter case prove the
  // filter is applied (not merely echoed) within one App's data.
  insertReview.run("r-d", "acme", "portal", 4, daysAgo(10), "approve", appId);
  // The other App's review — must stay out of widgets-app's numbers.
  insertReview.run("r-c", "globex", "gadgets", 3, daysAgo(5), "request changes", otherAppId);
  insertFinding.run("f-c1", "r-c", "should-fix", "security", "Injection", "fp-z");

  const env = {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DASHBOARD_SESSION_SECRET: SESSION_SECRET_API,
    DB: db,
  } as unknown as Env;
  return { db, env, appId };
}

function apiCookie(sessionSecret: string, login: string): Promise<string> {
  return createSessionValue(login, null, sessionSecret);
}

function appsInsightsGet(env: Env, slug: string, cookie: string, query = "") {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/api/apps/${slug}/insights/summary${query === "" ? "" : `?${query}`}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    }),
    env,
  );
}

describe("GET /dashboard/api/apps/:slug/insights/summary", () => {
  test("manager sees the app-scoped summary: full JSON shape, own-App reviews only", async () => {
    const { env } = await insightsWorld();
    const res = await appsInsightsGet(env, "widgets-app", await apiCookie(SESSION_SECRET_API, "mallory"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      reviews_total: number;
      findings_by_severity: Array<{ severity: string; count: number }>;
      findings_by_category: Array<{ category: string | null; count: number }>;
      verdict_distribution: Array<{ verdict: string; count: number }>;
      weekly_trend: unknown[];
      findings_distribution: unknown[];
      recurring_top: Array<{ fingerprint: string; title_sample: string; count: number; repos: string[] }>;
      repos: string[];
    };
    // Exact key set: store return + the echoed window (snake_case API).
    expect(Object.keys(body).sort()).toEqual(
      [
        "window_days",
        "reviews_total",
        "findings_by_severity",
        "findings_by_category",
        "verdict_distribution",
        "weekly_trend",
        "findings_distribution",
        "recurring_top",
        "repos",
      ].sort(),
    );
    expect(body.window_days).toBe(30);
    // r-a + r-b + r-d are the app's in-window reviews; r-c belongs to
    // another App.
    expect(body.reviews_total).toBe(3);
    expect(body.findings_by_severity).toEqual([
      { severity: "must-fix", count: 2 },
      { severity: "nit", count: 1 },
    ]);
    expect(body.findings_by_category).toEqual([
      { category: "logic", count: 2 },
      { category: null, count: 1 },
    ]);
    expect(body.verdict_distribution).toEqual([
      { verdict: "approve", count: 2 },
      { verdict: "comment", count: 1 },
    ]);
    expect(body.recurring_top).toEqual([
      { fingerprint: "fp-x", title_sample: "Null deref risk", count: 2, repos: ["acme/widgets"] },
    ]);
    // repos is opt-in: without include=repos the field is empty.
    expect(body.repos).toEqual([]);
  });

  test("include=repos is app-scoped: another App's repo never appears", async () => {
    const { env } = await insightsWorld();
    const res = await appsInsightsGet(env, "widgets-app", await apiCookie(SESSION_SECRET_API, "mallory"), "include=repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: string[] };
    // Both of the app's own repos, ascending — never the other App's.
    expect(body.repos).toEqual(["acme/portal", "acme/widgets"]);
  });

  test("repo= filter: valid owner/repo echoed AND applied — the app's other-repo review drops out", async () => {
    const { env } = await insightsWorld();
    const res = await appsInsightsGet(
      env,
      "widgets-app",
      await apiCookie(SESSION_SECRET_API, "mallory"),
      "repo=acme/widgets&include=repos",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: string; reviews_total: number };
    expect(body.repo).toBe("acme/widgets");
    // Applied, not just echoed: the app has 3 in-window reviews, but r-d
    // (acme/portal) is outside the owner/repo filter.
    expect(body.reviews_total).toBe(2);
  });

  test("malformed repo= → 400 (parseInsightsParams owner/repo semantics)", async () => {
    const { env } = await insightsWorld();
    const cookie = await apiCookie(SESSION_SECRET_API, "mallory");
    for (const repo of ["oops", "owner/repo/extra", "/repo", "owner/"]) {
      const res = await appsInsightsGet(env, "widgets-app", cookie, `repo=${encodeURIComponent(repo)}`);
      expect(res.status, `repo=${repo}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `repo=${repo}`).toContain("repo");
    }
  });

  test("malformed include= → 400 (only `repos` is a valid extra)", async () => {
    const { env } = await insightsWorld();
    const cookie = await apiCookie(SESSION_SECRET_API, "mallory");
    for (const include of ["foo", "repos,foo", "repos,"]) {
      const res = await appsInsightsGet(env, "widgets-app", cookie, `include=${include}`);
      expect(res.status, `include=${include}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `include=${include}`).toContain("include");
    }
  });

  test("non-manager member → 403 JSON; admin (non-creator) → 200", async () => {
    const { env } = await insightsWorld();
    const hubot = await appsInsightsGet(env, "widgets-app", await apiCookie(SESSION_SECRET_API, "hubot"));
    expect(hubot.status).toBe(403);
    expect(((await hubot.json()) as { error?: string }).error).toBeDefined();

    const admin = await appsInsightsGet(env, "widgets-app", await apiCookie(SESSION_SECRET_API, "octocat"));
    expect(admin.status).toBe(200);
  });

  test("unknown slug and soft-deleted slug → 404 JSON", async () => {
    const { db, env } = await insightsWorld();
    const unknown = await appsInsightsGet(env, "no-such-app", await apiCookie(SESSION_SECRET_API, "mallory"));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error?: string }).error).toBeDefined();

    db.raw.query("UPDATE github_apps SET deleted_at = datetime('now') WHERE slug = 'widgets-app'").run();
    const deleted = await appsInsightsGet(env, "widgets-app", await apiCookie(SESSION_SECRET_API, "mallory"));
    expect(deleted.status).toBe(404);
  });

  test("window parse: malformed → 400; window=400 clamps to 90 with the effective window echoed", async () => {
    const { env } = await insightsWorld();
    const cookie = await apiCookie(SESSION_SECRET_API, "mallory");
    for (const window of ["abc", "30.5", "-5", ""]) {
      const res = await appsInsightsGet(env, "widgets-app", cookie, `window=${window}`);
      expect(res.status, `window=${window}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error, `window=${window}`).toContain("window");
    }
    const clamped = await appsInsightsGet(env, "widgets-app", cookie, "window=400");
    expect(clamped.status).toBe(200);
    expect(((await clamped.json()) as { window_days: number }).window_days).toBe(90);
  });

  test("the cross-App global endpoint is removed: member GET → 404, never a summary", async () => {
    const { env } = await insightsWorld();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/api/insights/summary", {
        headers: { Cookie: `${SESSION_COOKIE}=${await apiCookie(SESSION_SECRET_API, "mallory")}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});
