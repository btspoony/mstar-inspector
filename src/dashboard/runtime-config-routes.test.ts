/**
 * The two runtime-configuration write surfaces, through the real worker mount:
 *
 *   - `PUT /dashboard/<ref>/api/settings/concurrency` — the workspace cap.
 *     Membership is the gate and owner/admin is the role: an outsider, a plain
 *     member and an unknown ref all answer the same tenant 404.
 *   - `PATCH /_internal_admin/api/runtime` — the system cap, operator-gated
 *     exactly like `/api/flags`.
 *
 * Both routes write through the Task-1 store, so these tests also prove the
 * route-level mapping of every store refusal: a value outside 1..250 is a keyed
 * 400, and a workspace value above the current system cap is a keyed 400 —
 * never a silent clamp. Accepted writes land with their `platform_audit_events`
 * row; refused writes change no row and append no audit row.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "./session";
import type { Env } from "../worker/env";
import { createMigratedTestD1, type TestD1 } from "../../tests/store/helpers";
import { withSpaAssets } from "../../tests/helpers/spa";

const SESSION_SECRET = ["test", "runtime", "routes", "session", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();

function envFor(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: db,
    ...overrides,
  } as unknown as Env;
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

function seedUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    id,
    login,
    new Date().toISOString(),
  );
  return id;
}

function seedWorkspace(db: TestD1, id: string, slug: string): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    id,
    slug,
    slug,
    new Date().toISOString(),
  );
}

function seedMembership(
  db: TestD1,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    workspaceId,
    userId,
    role,
    new Date().toISOString(),
  );
}

/** `ws-acme` (owner `dana`, admin `erin`, member `frank`), plus the operator login. */
function fixture() {
  const db = createMigratedTestD1();
  const dana = seedUser(db, "dana");
  const erin = seedUser(db, "erin");
  const frank = seedUser(db, "frank");
  seedUser(db, OPERATOR);
  seedWorkspace(db, "ws-acme", "acme");
  seedMembership(db, "ws-acme", dana, "owner");
  seedMembership(db, "ws-acme", erin, "admin");
  seedMembership(db, "ws-acme", frank, "member");
  return { db };
}

/** The stored workspace column, read raw so a refused write is observable. */
function storedWorkspace(db: TestD1): number | null {
  const row = db.raw
    .prepare("SELECT max_concurrent_reviews AS value FROM workspaces WHERE id = 'ws-acme'")
    .get() as { value: number | null } | null;
  return row?.value ?? null;
}

/** The stored system value, read raw. */
function storedSystem(db: TestD1): string | null {
  const row = db.raw
    .prepare("SELECT value FROM review_runtime_settings WHERE key = 'review.concurrency.system'")
    .get() as { value: string } | null;
  return row?.value ?? null;
}

type AuditRow = { action: string; actor_login: string; target_type: string; target_id: string };

function auditRows(db: TestD1): AuditRow[] {
  return db.raw
    .prepare(
      `SELECT action, actor_login, target_type, target_id
         FROM platform_audit_events ORDER BY rowid`,
    )
    .all() as AuditRow[];
}

/** Seed the system cap straight into the store's table. */
function seedSystemCap(db: TestD1, value: number): void {
  seed(
    db,
    `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
     VALUES ('review.concurrency.system', ?, ?, 'fixture')`,
    String(value),
    new Date().toISOString(),
  );
}

async function putConcurrency(
  db: TestD1,
  ref: string,
  login: string | null,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${ref}/api/settings/concurrency`, {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    withSpaAssets(envFor(db)),
  );
}

async function getConcurrency(db: TestD1, ref: string, login: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${ref}/api/settings/concurrency`, { headers }),
    withSpaAssets(envFor(db)),
  );
}

async function runtimeApi(
  db: TestD1,
  init: { method: "GET" | "PATCH"; body?: string; login?: string | null; mode?: "saas" | "self-hosted" },
): Promise<Response> {
  const login = init.login === undefined ? OPERATOR : init.login;
  const headers: Record<string, string> = {};
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request("https://worker.local/_internal_admin/api/runtime", {
      method: init.method,
      headers,
      body: init.body,
    }),
    envFor(db, { DEPLOYMENT_MODE: init.mode ?? "saas" }),
  );
}

describe("PUT /dashboard/<ref>/api/settings/concurrency", () => {
  test("the owner and an admin both write the value; the row and one audit row land", async () => {
    const { db } = fixture();
    for (const [login, value] of [
      ["dana", 8],
      ["erin", 12],
    ] as const) {
      const res = await putConcurrency(db, "ws-acme", login, { concurrency: value });
      expect(res.status, login).toBe(200);
      expect(await res.json()).toEqual({ concurrency: value });
      expect(storedWorkspace(db)).toBe(value);
    }
    expect(auditRows(db)).toEqual([
      { action: "workspace.concurrency.set", actor_login: "dana", target_type: "workspace", target_id: "ws-acme" },
      { action: "workspace.concurrency.set", actor_login: "erin", target_type: "workspace", target_id: "ws-acme" },
    ]);
  });

  test("a plain member, an outsider and an unknown ref all answer the same 404", async () => {
    const { db } = fixture();
    // `frank` is a member of ws-acme — member, not manager.
    const member = await putConcurrency(db, "ws-acme", "frank", { concurrency: 4 });
    expect(member.status).toBe(404);
    // No cookie at all is the login redirect, never a write.
    const anonymous = await putConcurrency(db, "ws-acme", null, { concurrency: 4 });
    expect(anonymous.status).toBe(302);
    // An admin of one workspace is not an admin of another.
    expect((await putConcurrency(db, "ws-missing", "erin", { concurrency: 4 })).status).toBe(404);
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("a value above the system cap is refused with a keyed 400, never clamped", async () => {
    const { db } = fixture();
    seedSystemCap(db, 8);
    const res = await putConcurrency(db, "ws-acme", "dana", { concurrency: 20 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      key: "settings.error.concurrencyAboveSystem",
      params: { system: 8 },
    });
    // Nothing was stored and nothing was audited — a clamp would show up here.
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("a value equal to the system cap is accepted", async () => {
    const { db } = fixture();
    seedSystemCap(db, 8);
    const res = await putConcurrency(db, "ws-acme", "dana", { concurrency: 8 });
    expect(res.status).toBe(200);
    expect(storedWorkspace(db)).toBe(8);
  });

  test("an out-of-range, non-integer or non-numeric value is a keyed 400", async () => {
    const { db } = fixture();
    for (const body of [
      { concurrency: 0 },
      { concurrency: 251 },
      { concurrency: 2.5 },
      { concurrency: "8" },
      { concurrency: null },
      {},
      "not json",
    ]) {
      const res = await putConcurrency(db, "ws-acme", "dana", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ key: "settings.error.concurrencyInvalid" });
    }
    expect(storedWorkspace(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("GET reports the workspace value, the system ceiling and the range to a manager", async () => {
    const { db } = fixture();
    seedSystemCap(db, 20);
    await putConcurrency(db, "ws-acme", "dana", { concurrency: 8 });
    for (const login of ["dana", "erin"]) {
      const res = await getConcurrency(db, "ws-acme", login);
      expect(res.status, login).toBe(200);
      // NULL column reads as the documented default 16; here it was written.
      expect(await res.json()).toEqual({ concurrency: 8, system: 20, min: 1, max: 250 });
    }
  });

  test("GET answers the documented default before any write, and the 404 for a member", async () => {
    const { db } = fixture();
    expect(await (await getConcurrency(db, "ws-acme", "dana")).json()).toEqual({
      concurrency: 16,
      system: 32,
      min: 1,
      max: 250,
    });
    expect((await getConcurrency(db, "ws-acme", "frank")).status).toBe(404);
  });
});

describe("GET/PATCH /_internal_admin/api/runtime", () => {
  test("PATCH writes the system cap and exactly one audit row", async () => {
    const { db } = fixture();
    const res = await runtimeApi(db, { method: "PATCH", body: JSON.stringify({ concurrency: 24 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ concurrency: 24 });
    expect(storedSystem(db)).toBe("24");
    expect(auditRows(db)).toEqual([
      {
        action: "runtime.concurrency.system.set",
        actor_login: OPERATOR,
        target_type: "runtime",
        target_id: "review.concurrency.system",
      },
    ]);
  });

  test("GET reports the stored cap, and the documented default before any write", async () => {
    const { db } = fixture();
    expect(await (await runtimeApi(db, { method: "GET" })).json()).toEqual({
      concurrency: 32,
      min: 1,
      max: 250,
    });
    await runtimeApi(db, { method: "PATCH", body: JSON.stringify({ concurrency: 5 }) });
    expect(await (await runtimeApi(db, { method: "GET" })).json()).toEqual({
      concurrency: 5,
      min: 1,
      max: 250,
    });
  });

  test("a non-operator login, an anonymous caller and a self-hosted deployment all 404", async () => {
    const { db } = fixture();
    const member = await runtimeApi(db, {
      method: "PATCH",
      body: JSON.stringify({ concurrency: 24 }),
      login: "dana",
    });
    expect(member.status).toBe(404);
    expect((await runtimeApi(db, { method: "PATCH", body: JSON.stringify({ concurrency: 24 }), login: null })).status).toBe(404);
    expect(
      (await runtimeApi(db, { method: "GET", mode: "self-hosted" })).status,
    ).toBe(404);
    expect(storedSystem(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });

  test("an out-of-range or missing value is a 400 and writes nothing", async () => {
    const { db } = fixture();
    for (const body of [
      JSON.stringify({ concurrency: 0 }),
      JSON.stringify({ concurrency: 251 }),
      JSON.stringify({ concurrency: 2.5 }),
      JSON.stringify({ concurrency: "24" }),
      JSON.stringify({}),
      "not json",
    ]) {
      const res = await runtimeApi(db, { method: "PATCH", body });
      expect(res.status, body).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(storedSystem(db)).toBeNull();
    expect(auditRows(db)).toEqual([]);
  });
});
