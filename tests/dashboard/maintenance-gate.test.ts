/**
 * The maintenance window's gate (D20), driven through the real worker
 * mount. The window closes the dashboard surface and NOTHING else:
 *
 *   - a page load answers 503 with the J7 HTML (reason + start time);
 *   - an `/api/` path answers 503 with `{ maintenance: true, reason, since }`,
 *     so the SPA parses a state instead of rendering a page;
 *   - `/healthz` and the operator console stay 200 — the operator must be able
 *     to open the platform again;
 *   - with no window set (the absent-row default) every surface is unchanged.
 *
 * The page case is the reason the gate also mounts in `src/worker/index.ts`:
 * `spaDispatch` answers page loads before `dashboardApp` is reached, so the
 * assertions below would pass on an API-only gate and the shell would stay open.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { htmlGetRequest, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "maintenance", "gate", "session", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const MEMBER = "dana";
const REASON = "repository backfill";
const SINCE = "2026-11-17T09:00:00.000Z";

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {}, metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }) },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  } as unknown as Env;
}

/** `dana` owns `ws-acme`; the operator login exists for the console surface. */
async function fixture(): Promise<{ db: TestD1 }> {
  const db = createMigratedTestD1();
  const dana = await createUser(db, { login: MEMBER, role: "member" });
  await createUser(db, { login: OPERATOR, role: "member" });
  db.raw
    .prepare(
      "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    )
    .run("ws-acme", "acme", "acme", "2026-10-01T00:00:00.000Z");
  db.raw
    .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run("ws-acme", dana.id, "2026-10-01T00:00:00.000Z");
  return { db };
}

/** Close the window through the shipped writer, the way the Operator does. */
async function close(db: TestD1, reason: string | null = REASON): Promise<void> {
  await setMaintenanceMode(db, { enabled: true, reason, actor: OPERATOR }, SINCE);
}

async function get(db: TestD1, path: string, login: string | null, html = false): Promise<Response> {
  const headers: Record<string, string> = html ? { Accept: "text/html" } : { Accept: "application/json" };
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    html
      ? htmlGetRequest(path, headers.Cookie ? { Cookie: headers.Cookie } : {})
      : new Request(`https://worker.local${path}`, { headers }),
    withSpaAssets(envFor(db)),
  );
}

describe("the maintenance gate", () => {
  test("a page load answers 503 and the J7 page with the reason and start time", async () => {
    const { db } = await fixture();
    await close(db);
    for (const path of ["/dashboard", "/dashboard/acme/apps"]) {
      const res = await get(db, path, MEMBER, true);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("Under maintenance");
      expect(html).toContain(REASON);
      expect(html).toContain(SINCE);
    }
  });

  test("an /api/ path answers 503 JSON, so a fetch parses a state", async () => {
    const { db } = await fixture();
    await close(db);
    const res = await get(db, "/dashboard/acme/api/settings/concurrency", MEMBER);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ maintenance: true, reason: REASON, since: SINCE });
  });

  test("a window without a reason states only the start time", async () => {
    const { db } = await fixture();
    await close(db, null);
    const res = await get(db, "/dashboard/acme/apps", MEMBER, true);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain(SINCE);
    expect(html).not.toContain("Reason:");
  });

  test("healthz, the operator console and the login page stay open", async () => {
    const { db } = await fixture();
    await close(db);
    expect((await get(db, "/healthz", null)).status).toBe(200);
    expect((await get(db, "/_internal_admin/api/runtime", OPERATOR)).status).toBe(200);
    // The console that ends the window needs a session, so signing in must stay
    // possible while it runs.
    expect((await get(db, "/dashboard/login", null, true)).status).toBe(200);
  });

  test("the login page's locale toggle and logout still answer during the window", async () => {
    const { db } = await fixture();
    await close(db);
    // The page this gate still serves carries the EN/中文 toggle: its POST must
    // set the cookie rather than answer the maintenance page.
    const locale = await worker.fetch(
      new Request("https://worker.local/dashboard/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ locale: "zh_CN" }),
      }),
      withSpaAssets(envFor(db)),
    );
    expect(locale.status).toBe(302);
    expect(locale.headers.get("Set-Cookie")).toContain("mstar_locale");
    // Logout burns the cookies and never reads workspace data — a closed
    // platform must not trap a session on the browser.
    const logout = await get(db, "/dashboard/logout", MEMBER);
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/dashboard/login");
  });

  test("the absent-row default leaves every surface unchanged", async () => {
    const { db } = await fixture();
    // The page is the SPA shell, not the maintenance page.
    const page = await get(db, "/dashboard/acme/apps", MEMBER, true);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("Under maintenance");
    // The API answers its own route's payload, which a closed platform never
    // reaches — the gate sits ahead of dispatch.
    expect((await get(db, "/dashboard/acme/api/settings/concurrency", MEMBER)).status).toBe(200);
  });

  test("the window is read once per request despite the two mounts", async () => {
    const { db } = await fixture();
    await close(db);
    // The worker mount covers page loads; an API path passes both mounts, and
    // the second must reuse the context's verdict rather than read D1 again.
    const statements: string[] = [];
    const observed = {
      ...db,
      prepare(query: string) {
        statements.push(query);
        return db.prepare(query);
      },
    } as TestD1;
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/acme/api/settings/concurrency", {
        headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(MEMBER, null, SESSION_SECRET)}` },
      }),
      withSpaAssets(envFor(observed)),
    );
    expect(res.status).toBe(503);
    expect(statements.filter((sql) => sql.includes("review_runtime_settings WHERE key IN"))).toHaveLength(1);
  });

  test("a read fault closes the platform instead of unlocking it", async () => {
    const { db } = await fixture();
    // The window is the only fence around the destructive backfill: a settings
    // read that throws answers the THIRD state, and every gate treats it as
    // closed. Failing open here would let a settings outage unlock traffic.
    const broken = {
      ...db,
      prepare(query: string) {
        if (query.includes("review_runtime_settings WHERE key IN")) throw new Error("settings unavailable");
        return db.prepare(query);
      },
    } as TestD1;
    const cookie = { Cookie: `${SESSION_COOKIE}=${await createSessionValue(MEMBER, null, SESSION_SECRET)}` };
    const page = await worker.fetch(htmlGetRequest("/dashboard/acme/apps", cookie), withSpaAssets(envFor(broken)));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Under maintenance");
    // An API path answers the machine-readable state, never its own payload.
    const api = await worker.fetch(
      new Request("https://worker.local/dashboard/acme/api/settings/concurrency", { headers: cookie }),
      withSpaAssets(envFor(broken)),
    );
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ maintenance: true, reason: null, since: null });
  });
});
