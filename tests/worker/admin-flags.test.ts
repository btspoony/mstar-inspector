/**
 * `server_flags` and its consumers (spec operator-admin-surface §3.1).
 *
 * Pinned at the CONSUMER, not at the accessor alone: an absent row means
 * ENABLED (the behaviour the platform shipped with), and a stored `0` changes
 * what the named consumer does — signup refused, review not enqueued, creation
 * refused. The console's write path is pinned too: one PATCH = one flag row +
 * exactly one platform audit row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { isFlagEnabled, type ServerFlagKey } from "../../src/admin/flags";
import { createSecretbox } from "../../src/dashboard/secretbox";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createSessionValue,
  createStateValue,
} from "../../src/dashboard/session";
import type { SpaBoot } from "../../src/spa/boot";
import { SPA_POST_FORM_HEADER, SPA_POST_FORM_VALUE } from "../../src/spa/post-form-headers";
import { htmlGetRequest, withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "flag", "accessor", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const MEMBER = "regular-member";

/** Raw fixture writes (the accessor and every consumer read real SQL). */
function insertUser(db: TestD1, login: string): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), login, new Date().toISOString());
}

function setFlagRow(db: TestD1, key: ServerFlagKey, enabled: 0 | 1): void {
  db.raw
    .prepare("INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, 'fixture')")
    .run(key, enabled, new Date().toISOString());
}

function envFor(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: db,
    ...overrides,
  } as unknown as Env;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** GitHub identity stub: token exchange then `/user` for the given login. */
function stubGitHubIdentity(login: string): void {
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url);
    if (target === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: "gho_test-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (target === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login, name: null }), { status: 200 });
    }
    throw new Error(`unexpected fetch target: ${target}`);
  }) as unknown as typeof fetch;
}

/** Run the real OAuth callback for `login`. */
async function oauthCallback(login: string, env: Env): Promise<Response> {
  stubGitHubIdentity(login);
  const state = await createStateValue(SESSION_SECRET);
  return worker.fetch(
    new Request(`https://worker.local/dashboard/oauth/callback?code=x&state=${state}`, {
      headers: { Cookie: `${OAUTH_STATE_COOKIE}=${state}` },
    }),
    env,
  );
}

function userCount(db: TestD1, login: string): number {
  // bun:sqlite returns an untyped row; the SELECT above fixes its shape.
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM users WHERE github_login = ? COLLATE NOCASE")
    .get(login) as { n: number } | null;
  return row?.n ?? 0;
}

/** Does the response mint a live session cookie? */
function mintedSession(res: Response): boolean {
  return res.headers
    .getSetCookie()
    .some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0"));
}

describe("isFlagEnabled", () => {
  test("an absent row reads as enabled — fail-open to current behaviour", async () => {
    const db = createMigratedTestD1();
    for (const key of ["review_global", "signup_open", "workspace_creation_open"] as const) {
      expect(await isFlagEnabled(db, key)).toBe(true);
    }
  });

  test("a stored row is the effective value", async () => {
    const db = createMigratedTestD1();
    setFlagRow(db, "signup_open", 0);
    setFlagRow(db, "review_global", 1);
    expect(await isFlagEnabled(db, "signup_open")).toBe(false);
    expect(await isFlagEnabled(db, "review_global")).toBe(true);
  });
});

describe("signup_open at the OAuth first-sign-in branch", () => {
  test("an absent row still creates a `users` row for an unknown login", async () => {
    const db = createMigratedTestD1();
    const res = await oauthCallback("newcomer", envFor(db));
    expect(res.status).toBe(302);
    expect(mintedSession(res)).toBe(true);
    expect(userCount(db, "newcomer")).toBe(1);
  });

  test("closed refuses an unknown login with zero writes and no session", async () => {
    const db = createMigratedTestD1();
    setFlagRow(db, "signup_open", 0);
    const res = await oauthCallback("newcomer", envFor(db));
    expect(res.status).toBe(403);
    expect(mintedSession(res)).toBe(false);
    expect(userCount(db, "newcomer")).toBe(0);
  });

  test("closed leaves an existing login untouched", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    setFlagRow(db, "signup_open", 0);
    const res = await oauthCallback(MEMBER, envFor(db));
    expect(res.status).toBe(302);
    expect(mintedSession(res)).toBe(true);
  });
});

// --- workspace_creation_open at POST /dashboard/api/workspaces --------------

/** The route's 409 body when the flag is off (spec §3.1). */
const WORKSPACE_CLOSED_REFUSAL =
  "This workspace was not created. Workspace creation is closed on this platform right now.";

async function createWorkspaceRequest(db: TestD1, login: string): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request("https://worker.local/dashboard/api/workspaces", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${session}`,
        "Content-Type": "application/x-www-form-urlencoded",
        [SPA_POST_FORM_HEADER]: SPA_POST_FORM_VALUE,
      },
      body: new URLSearchParams({ name: "Acme" }),
    }),
    envFor(db),
  );
}

function workspaceCount(db: TestD1): number {
  const row = db.raw.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number } | null;
  return row?.n ?? 0;
}

describe("workspace_creation_open at POST /dashboard/api/workspaces", () => {
  test("an absent row creates the workspace", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    const before = workspaceCount(db);
    const res = await createWorkspaceRequest(db, MEMBER);
    expect(res.status).toBe(201);
    expect(workspaceCount(db)).toBe(before + 1);
  });

  test("closed refuses with the flag's 409 and writes nothing", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    setFlagRow(db, "workspace_creation_open", 0);
    const before = workspaceCount(db);
    const res = await createWorkspaceRequest(db, MEMBER);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(WORKSPACE_CLOSED_REFUSAL);
    expect(workspaceCount(db)).toBe(before);
  });
});

// --- workspace_creation_open in the boot payload ----------------------------

function bootOf(html: string): SpaBoot {
  const json = /window\.__BOOT__=(\{.*?\});<\/script>/s.exec(html)?.[1];
  if (json === undefined) throw new Error("no boot in shell");
  return JSON.parse(json) as SpaBoot;
}

async function bootFor(db: TestD1, mode: "saas" | "self-hosted"): Promise<SpaBoot> {
  const session = await createSessionValue(MEMBER, null, SESSION_SECRET);
  const res = await worker.fetch(
    htmlGetRequest("/dashboard/default/apps", { Cookie: `${SESSION_COOKIE}=${session}` }),
    withSpaAssets(envFor(db, { DEPLOYMENT_MODE: mode })),
  );
  expect(res.status).toBe(200);
  return bootOf(await res.text());
}

describe("workspace_creation_open in the boot payload", () => {
  test("an absent row keeps the pre-flag capability", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    const boot = await bootFor(db, "saas");
    expect(boot.canCreateWorkspace).toBe(true);
    expect(boot.createWorkspaceBlockedReason).toBeNull();
  });

  test("closed disables creation with the flag reason, for everyone", async () => {
    for (const mode of ["saas", "self-hosted"] as const) {
      const db = createMigratedTestD1();
      insertUser(db, MEMBER);
      setFlagRow(db, "workspace_creation_open", 0);
      const boot = await bootFor(db, mode);
      expect(boot.canCreateWorkspace).toBe(false);
      expect(boot.createWorkspaceBlockedReason).toBe("flag");
    }
  });
});

// --- review_global at the webhook enqueue decision --------------------------

/** base64 of exactly 32 bytes (the secretbox master-key requirement). */
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const WEBHOOK_SECRET = "app-x-secret";
const PR_PAYLOAD = {
  action: "opened",
  number: 42,
  installation: { id: 123 },
  pull_request: { number: 42, head: { sha: "abc123" } },
  repository: { name: "test-repo", owner: { login: "test-owner" } },
};

/** An active App row with real secretbox envelopes plus its workspace mapping. */
async function seedApp(db: TestD1): Promise<void> {
  const id = crypto.randomUUID();
  const box = createSecretbox(ENCRYPTION_KEY);
  const webhookSecretEnc = await box.encryptSecret(
    WEBHOOK_SECRET,
    `github_apps.webhook_secret_enc:${id}`,
  );
  const privateKeyEnc = await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`);
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 'app-x', 4242, 'app-x', ?, ?, 'fixture', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, privateKeyEnc, webhookSecretEnc);
  db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')").run(id);
}

function queueCapture(): { queue: Env["REVIEW_QUEUE"]; sent: ReviewJobPayload[] } {
  const sent: ReviewJobPayload[] = [];
  return {
    queue: {
      send: async (message: ReviewJobPayload) => {
        sent.push(message);
      },
    } as unknown as Env["REVIEW_QUEUE"],
    sent,
  };
}

async function postWebhook(env: Env): Promise<Response> {
  const body = JSON.stringify(PR_PAYLOAD);
  const signature = await new Webhooks({ secret: WEBHOOK_SECRET }).sign(body);
  return worker.fetch(
    new Request("https://worker.local/webhook/app-x", {
      method: "POST",
      headers: { "x-hub-signature-256": signature, "x-github-event": "pull_request" },
      body,
    }),
    env,
  );
}

describe("review_global at the webhook enqueue decision", () => {
  test("an absent row enqueues", async () => {
    const db = createMigratedTestD1();
    await seedApp(db);
    const { queue, sent } = queueCapture();
    const res = await postWebhook(
      envFor(db, { REVIEW_QUEUE: queue, DASHBOARD_ENCRYPTION_KEY: ENCRYPTION_KEY }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  test("closed answers 2xx with zero enqueue", async () => {
    const db = createMigratedTestD1();
    await seedApp(db);
    setFlagRow(db, "review_global", 0);
    const { queue, sent } = queueCapture();
    const res = await postWebhook(
      envFor(db, { REVIEW_QUEUE: queue, DASHBOARD_ENCRYPTION_KEY: ENCRYPTION_KEY }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
  });
});

// --- the console's flags API ------------------------------------------------

type AuditRow = {
  action: string;
  actor_login: string;
  target_type: string;
  target_id: string;
  detail_json: string | null;
};

function auditRows(db: TestD1): AuditRow[] {
  return db.raw
    .prepare(
      `SELECT action, actor_login, target_type, target_id, detail_json
         FROM platform_audit_events ORDER BY rowid`,
    )
    .all() as AuditRow[];
}

function flagRowCount(db: TestD1): number {
  const row = db.raw.prepare("SELECT COUNT(*) AS n FROM server_flags").get() as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * A competing writer that commits the moment the handler submits its batch —
 * i.e. after any pre-batch read the handler performed, and before the batch's
 * own statements run. The flag row is written raw (never through the wrapped
 * face), so the interleave cannot re-enter the handler.
 */
function withCompetingToggle(
  db: TestD1,
  key: ServerFlagKey,
  enabled: 0 | 1,
): { db: TestD1; fired: () => boolean } {
  let fired = false;
  const wrapped: TestD1 = {
    raw: db.raw,
    prepare: (query: string) => db.prepare(query),
    batch: async (statements) => {
      if (!fired) {
        fired = true;
        db.raw
          .prepare(
            `INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, 'competitor')
             ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled`,
          )
          .run(key, enabled, new Date().toISOString());
      }
      return db.batch(statements);
    },
  };
  return { db: wrapped, fired: () => fired };
}

async function flagsApi(
  db: TestD1,
  init: {
    method: "GET" | "PATCH";
    body?: string;
    login?: string | null;
    mode?: "saas" | "self-hosted";
  },
): Promise<Response> {
  const login = init.login === undefined ? OPERATOR : init.login;
  const headers: Record<string, string> = {};
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request("https://worker.local/_internal_admin/api/flags", {
      method: init.method,
      headers,
      body: init.body,
    }),
    envFor(db, { DEPLOYMENT_MODE: init.mode ?? "saas" }),
  );
}

describe("GET/PATCH /_internal_admin/api/flags", () => {
  test("GET reports every known flag, absent rows enabled", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const res = await flagsApi(db, { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      flags: [
        { key: "review_global", enabled: true },
        { key: "signup_open", enabled: true },
        { key: "workspace_creation_open", enabled: true },
      ],
    });
  });

  test("one PATCH writes the row plus exactly one audit row with before/after", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);

    const res = await flagsApi(db, {
      method: "PATCH",
      body: JSON.stringify({ key: "signup_open", enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "signup_open", enabled: false });

    const row = db.raw
      .prepare("SELECT enabled, updated_by FROM server_flags WHERE key = 'signup_open'")
      .get() as { enabled: number; updated_by: string } | null;
    expect(row).toEqual({ enabled: 0, updated_by: OPERATOR });

    const first = auditRows(db);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      action: "flag.set",
      actor_login: OPERATOR,
      target_type: "flag",
      target_id: "signup_open",
    });
    expect(JSON.parse(first[0]!.detail_json ?? "null")).toEqual({ before: true, after: false });

    // A second toggle appends its own single row carrying the new before value.
    const again = await flagsApi(db, {
      method: "PATCH",
      body: JSON.stringify({ key: "signup_open", enabled: true }),
    });
    expect(again.status).toBe(200);
    const second = auditRows(db);
    expect(second).toHaveLength(2);
    expect(JSON.parse(second[1]!.detail_json ?? "null")).toEqual({ before: false, after: true });

    // The read face follows the stored row.
    const read = await flagsApi(db, { method: "GET" });
    const body = (await read.json()) as { flags: Array<{ key: string; enabled: boolean }> };
    expect(body.flags.find((flag) => flag.key === "signup_open")).toEqual({
      key: "signup_open",
      enabled: true,
    });
  });

  test("an unknown key is a 400 with zero writes", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const res = await flagsApi(db, {
      method: "PATCH",
      body: JSON.stringify({ key: "not_a_flag", enabled: false }),
    });
    expect(res.status).toBe(400);
    expect(flagRowCount(db)).toBe(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  test("an unusable body is a 400, never a 500", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    for (const body of [
      "not json",
      JSON.stringify({ key: "signup_open" }),
      JSON.stringify({ key: "signup_open", enabled: "no" }),
    ]) {
      const res = await flagsApi(db, { method: "PATCH", body });
      expect(res.status).toBe(400);
    }
    expect(flagRowCount(db)).toBe(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  /**
   * The audit's `before` must be the state the upsert actually overwrote, not
   * what a separate pre-read saw. A competing writer commits between the two
   * (`withCompetingToggle`), so an implementation that reads `before` OUTSIDE
   * the batch records the pre-competition value and this assertion fails.
   */
  test("the audit before-value is read inside the batch: a competing toggle in between cannot make it stale", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    setFlagRow(db, "signup_open", 0); // stored state entering the request

    const competing = withCompetingToggle(db, "signup_open", 1); // the value at write time
    const res = await flagsApi(competing.db, {
      method: "PATCH",
      body: JSON.stringify({ key: "signup_open", enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(competing.fired()).toBe(true);

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    // The batch overwrote `1` — so `before` is true, not the pre-competition 0.
    expect(JSON.parse(rows[0]!.detail_json ?? "null")).toEqual({ before: true, after: false });
  });

  /**
   * One transaction: a failing flag upsert rolls the audit row back. A split
   * write leaves the audit row behind and this assertion fails.
   */
  test("a failed flag upsert appends no audit row", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    db.raw.exec(
      `CREATE TRIGGER fail_flag_upsert BEFORE INSERT ON server_flags
       BEGIN SELECT RAISE(ABORT, 'flag upsert refused'); END;`,
    );

    const res = await flagsApi(db, {
      method: "PATCH",
      body: JSON.stringify({ key: "signup_open", enabled: false }),
    });
    expect(res.status).toBe(500);
    expect(flagRowCount(db)).toBe(0);
    expect(auditRows(db)).toEqual([]);
  });

  test("a non-operator, an anonymous caller and self-hosted get the 404 with zero writes", async () => {
    const callers: Array<{ login?: string | null; mode?: "saas" | "self-hosted" }> = [
      { login: MEMBER },
      { login: null },
      { mode: "self-hosted" },
    ];
    for (const caller of callers) {
      const db = createMigratedTestD1();
      insertUser(db, OPERATOR);
      insertUser(db, MEMBER);
      const res = await flagsApi(db, {
        method: "PATCH",
        body: JSON.stringify({ key: "signup_open", enabled: false }),
        ...caller,
      });
      expect(res.status).toBe(404);
      expect(flagRowCount(db)).toBe(0);
      expect(auditRows(db)).toHaveLength(0);
    }
  });
});
