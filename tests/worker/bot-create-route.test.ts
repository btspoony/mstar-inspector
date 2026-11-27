/**
 * Task 9 — the create-bot route. A workspace can own a bot without a GitHub
 * App, so this is the only writer that inserts a `review_bots` row alone: the
 * owner gate stands, a nameless body is refused, and a happy path writes
 * exactly one owned row at multiplier 1 on the `omp` runtime.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "bot", "create", "route", "secret", "32-bytes!"].join("-");

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    DEPLOYMENT_MODE: "self-hosted",
    DB: db,
  } as unknown as Env;
}

function seedMember(db: TestD1, login: string, role: "owner" | "admin" | "member"): void {
  db.raw
    .prepare(
      "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES ('acme', 'acme', 'Acme', NULL, ?, NULL)",
    )
    .run("2026-01-01T00:00:00.000Z");
  db.raw
    .prepare(
      "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    )
    .run(crypto.randomUUID(), login, "2026-01-01T00:00:00.000Z");
  db.raw
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT 'acme', id, ?, ? FROM users WHERE github_login = ?",
    )
    .run(role, "2026-01-01T00:00:00.000Z", login);
}

async function post(db: TestD1, login: string, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request("https://worker.local/dashboard/acme/api/review-bots", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    envFor(db),
  );
}

const countBots = (db: TestD1): number =>
  (db.raw.query("SELECT COUNT(*) AS n FROM review_bots").get() as { n: number }).n;

describe("POST /api/review-bots", () => {
  test("a plain member is refused and writes nothing", async () => {
    const db = createMigratedTestD1();
    seedMember(db, "mallory", "member");
    const res = await post(db, "mallory", { name: "Nightly Bot" });
    expect(res.status).toBe(403);
    expect(countBots(db)).toBe(0);
  });

  test("a missing or blank name is a 400", async () => {
    const db = createMigratedTestD1();
    seedMember(db, "dana", "owner");
    expect((await post(db, "dana", {})).status).toBe(400);
    expect((await post(db, "dana", { name: "   " })).status).toBe(400);
    expect(countBots(db)).toBe(0);
  });

  test("a manager creates exactly one owned bot on the omp runtime", async () => {
    const db = createMigratedTestD1();
    seedMember(db, "dana", "admin");
    const res = await post(db, "dana", { name: "  Nightly Bot  ", description: "Runs at night" });
    expect(res.status).toBe(201);
    const created: unknown = await res.json();
    const id =
      typeof created === "object" && created !== null && "id" in created && typeof created.id === "string"
        ? created.id
        : "";
    expect(id.length).toBeGreaterThan(0);
    expect(countBots(db)).toBe(1);
    const row = db.raw
      .prepare(
        `SELECT id, workspace_id, name, description, scope, sandbox_image_id, multiplier, deleted_at
           FROM review_bots`,
      )
      .get() as {
      id: string;
      workspace_id: string;
      name: string;
      description: string | null;
      scope: string;
      sandbox_image_id: string;
      multiplier: number;
      deleted_at: string | null;
    };
    expect(row).toEqual({
      id,
      workspace_id: "acme",
      name: "Nightly Bot",
      description: "Runs at night",
      scope: "owned",
      sandbox_image_id: "omp",
      multiplier: 1,
      deleted_at: null,
    });
  });
});
