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
 * route-level mapping of every store refusal: a workspace value outside 1..32
 * (or a system value outside 1..256) is a keyed 400. Accepted writes land with
 * their `platform_audit_events` row; refused writes change no row and append no
 * audit row. The tenant read and write never compare against the system value —
 * that quota applies at admission and stays out of this face.
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

/** The documented absent-row check budgets as the operator API reports them. */
const DEFAULT_CHECK_BUDGETS = {
  terminalizeMs: 10_000,
  updateMs: 5_000,
  terminalizeMin: 1_000,
  terminalizeMax: 30_000,
  updateMin: 500,
  updateMax: 15_000,
  degraded: false,
};

/** Both stored budget rows, raw, keyed by PK. */
function storedBudgets(db: TestD1): Record<string, string> {
  const rows = db.raw
    .prepare("SELECT key, value FROM review_runtime_settings ORDER BY key")
    .all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
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

  test("a value above the system quota is still accepted, with no system data exposed", async () => {
    // Refusing on the quota would let a tenant binary-search the platform number
    // through accepted and refused writes. The quota applies at admission.
    const { db } = fixture();
    seedSystemCap(db, 8);
    const res = await putConcurrency(db, "ws-acme", "dana", { concurrency: 20 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ concurrency: 20 });
    expect(storedWorkspace(db)).toBe(20);
  });

  test("a corrupt platform row degrades the admin face but not the tenant's own value", async () => {
    // The tenant face never reads the platform row: a value it cannot see or
    // repair must not blank a workspace whose own column is readable.
    const { db } = fixture();
    seed(db, "INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)",
      "review.concurrency.system", "not-a-number", new Date().toISOString());
    expect(await (await getConcurrency(db, "ws-acme", "dana")).json()).toEqual({
      concurrency: 32,
      min: 1,
      max: 32,
      degraded: false,
    });
    expect(await (await runtimeApi(db, { method: "GET" })).json()).toEqual({
      concurrency: 1,
      min: 1,
      max: 256,
      degraded: true,
      checkBudgets: DEFAULT_CHECK_BUDGETS,
    });
  });

  test("a corrupt workspace column degrades the tenant read, not a normal number", async () => {
    // The face must not present the conservative fallback as this workspace's
    // setting: `degraded` is what lets it render the warning instead.
    const { db } = fixture();
    seed(db, "UPDATE workspaces SET max_concurrent_reviews = 'abc' WHERE id = ?", "ws-acme");
    expect(await (await getConcurrency(db, "ws-acme", "dana")).json()).toEqual({
      concurrency: 1,
      min: 1,
      max: 32,
      degraded: true,
    });
  });

  test("an out-of-range, non-integer or non-numeric value is a keyed 400", async () => {
    const { db } = fixture();
    for (const body of [
      { concurrency: 0 },
      { concurrency: 33 },
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

  test("GET reports only the workspace value and its own range to a manager", async () => {
    const { db } = fixture();
    seedSystemCap(db, 20);
    await putConcurrency(db, "ws-acme", "dana", { concurrency: 8 });
    for (const login of ["dana", "erin"]) {
      const res = await getConcurrency(db, "ws-acme", login);
      expect(res.status, login).toBe(200);
      // No `system` field: the platform cap is not the tenant's data.
      expect(await res.json()).toEqual({
        concurrency: 8,
        min: 1,
        max: 32,
        degraded: false,
      });
    }
  });

  test("GET answers the documented default before any write, and the 404 for a member", async () => {
    const { db } = fixture();
    expect(await (await getConcurrency(db, "ws-acme", "dana")).json()).toEqual({
      concurrency: 32,
      min: 1,
      max: 32,
      degraded: false,
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
      concurrency: 256,
      min: 1,
      max: 256,
      degraded: false,
      checkBudgets: DEFAULT_CHECK_BUDGETS,
    });
    await runtimeApi(db, { method: "PATCH", body: JSON.stringify({ concurrency: 5 }) });
    expect(await (await runtimeApi(db, { method: "GET" })).json()).toEqual({
      concurrency: 5,
      min: 1,
      max: 256,
      degraded: false,
      checkBudgets: DEFAULT_CHECK_BUDGETS,
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
      JSON.stringify({ concurrency: 257 }),
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

describe("PATCH /_internal_admin/api/runtime checkBudgets", () => {
  test("writes both rows with one audit row and reports the stored pair", async () => {
    const { db } = fixture();
    const res = await runtimeApi(db, {
      method: "PATCH",
      body: JSON.stringify({ checkBudgets: { terminalizeMs: 12_000, updateMs: 7_000 } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkBudgets: { terminalizeMs: 12_000, updateMs: 7_000 } });
    expect(storedBudgets(db)).toEqual({
      "review.check.terminalize_timeout_ms": "12000",
      "review.check.update_timeout_ms": "7000",
    });
    expect(auditRows(db)).toEqual([
      {
        action: "runtime.check_budgets.set",
        actor_login: OPERATOR,
        target_type: "runtime",
        target_id: "review.check.budgets",
      },
    ]);
    const read = (await (await runtimeApi(db, { method: "GET" })).json()) as {
      checkBudgets: Record<string, unknown>;
    };
    expect(read.checkBudgets).toEqual({
      ...DEFAULT_CHECK_BUDGETS,
      terminalizeMs: 12_000,
      updateMs: 7_000,
    });
  });

  test("an out-of-range or malformed pair is a 400 that writes nothing", async () => {
    const { db } = fixture();
    for (const body of [
      JSON.stringify({ checkBudgets: { terminalizeMs: 999, updateMs: 5_000 } }),
      JSON.stringify({ checkBudgets: { terminalizeMs: 10_000, updateMs: 15_001 } }),
      JSON.stringify({ checkBudgets: { terminalizeMs: "10000", updateMs: 5_000 } }),
      JSON.stringify({ checkBudgets: { terminalizeMs: 10_000 } }),
      // Relation rule: the inline wait must exceed the bounded send.
      JSON.stringify({ checkBudgets: { terminalizeMs: 1_000, updateMs: 1_000 } }),
      JSON.stringify({ checkBudgets: null }),
    ]) {
      const res = await runtimeApi(db, { method: "PATCH", body });
      expect(res.status, body).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(storedBudgets(db)).toEqual({});
    expect(auditRows(db)).toEqual([]);
  });

  test("a body carrying both parameters is refused so neither half is written", async () => {
    const { db } = fixture();
    const res = await runtimeApi(db, {
      method: "PATCH",
      body: JSON.stringify({ concurrency: 8, checkBudgets: { terminalizeMs: 10_000, updateMs: 5_000 } }),
    });
    expect(res.status).toBe(400);
    expect(storedSystem(db)).toBeNull();
    expect(storedBudgets(db)).toEqual({});
    expect(auditRows(db)).toEqual([]);
  });
});
