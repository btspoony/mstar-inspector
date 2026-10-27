/**
 * The workspace-identifier work (2026-10) — the owner-facing slug rename is
 * gone. A workspace's URL is emitted from its immutable `id`, so no owner-side
 * route may rewrite the path segment any more: `PUT …/api/settings/slug` is
 * absent from the route table, every role gets the catch-all 404, and no row
 * changes. The owner's remaining edit is the label (`…/api/settings/name`),
 * which changes no path — covered in `workspace-name.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "slug", "write", "session", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
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
  const now = new Date().toISOString();
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    id,
    slug,
    slug,
    now,
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

/**
 * `acme` (slug `acme`, owned by `dana`), `beta` (slug `beta-x`, owned by
 * `dana` too), and an outsider with no membership anywhere.
 */
function fixture() {
  const db = createMigratedTestD1();
  const dana = seedUser(db, "dana");
  const erin = seedUser(db, "erin");
  seedUser(db, "mallory");
  seedWorkspace(db, "ws-acme", "acme");
  seedWorkspace(db, "beta", "beta-x");
  seedMembership(db, "ws-acme", dana, "owner");
  seedMembership(db, "beta", dana, "member");
  seedMembership(db, "ws-acme", erin, "admin");
  return { db };
}

const slugOf = (db: TestD1, id: string): string => {
  const row: unknown = db.raw.query("SELECT slug FROM workspaces WHERE id = ?").get(id);
  if (typeof row !== "object" || row === null || !("slug" in row)) return "";
  return typeof row.slug === "string" ? row.slug : "";
};

async function putSlug(db: TestD1, ref: string, login: string, slug: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${ref}/api/settings/slug`, {
      method: "PUT",
      headers: {
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ slug }),
    }),
    withSpaAssets(envFor(db)),
  );
}

describe("the owner slug route is retired", () => {
  test("no role can rewrite the path segment: owner, admin, member and outsider all 404", async () => {
    const { db } = fixture();
    for (const [ref, login] of [
      ["acme", "dana"], // owner of ws-acme
      ["acme", "erin"], // admin of ws-acme
      ["beta-x", "dana"], // plain member of `beta`
      ["acme", "mallory"], // no membership at all
    ] as const) {
      const res = await putSlug(db, ref, login, "acme-labs");
      expect(res.status, `${ref} ${login}`).toBe(404);
    }
    expect(slugOf(db, "ws-acme")).toBe("acme");
    expect(slugOf(db, "beta")).toBe("beta-x");
  });

  test("the deployment-level path is gone too", async () => {
    const { db } = fixture();
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/api/settings/slug", {
        method: "PUT",
        headers: {
          Cookie: `${SESSION_COOKIE}=${await createSessionValue("dana", null, SESSION_SECRET)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "acme-labs" }),
      }),
      envFor(db),
    );
    expect(res.status).toBe(404);
  });
});
