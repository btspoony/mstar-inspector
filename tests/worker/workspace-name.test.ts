/**
 * The workspace-name rename — the owner's label edit.
 *
 * A workspace's URL is its immutable `id`, so this write changes no path: the
 * route refuses every non-owner, answers the outsider/unknown-ref 404, and
 * writes the trimmed name for the owner.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "name", "write", "session", "32-bytes!"].join("-");
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
 * `ws-acme` (owner `dana`, admin `erin`), `beta` (`dana` is a plain member
 * there), and `mallory`, a login with no membership anywhere.
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

const nameOf = (db: TestD1, id: string): string => {
  const row: unknown = db.raw.query("SELECT name FROM workspaces WHERE id = ?").get(id);
  if (typeof row !== "object" || row === null || !("name" in row)) return "";
  return typeof row.name === "string" ? row.name : "";
};

async function putName(db: TestD1, ref: string, login: string, name: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${ref}/api/settings/name`, {
      method: "PUT",
      headers: {
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ name }),
    }),
    withSpaAssets(envFor(db)),
  );
}

describe("PUT /dashboard/<ref>/api/settings/name", () => {
  test("the owner renames the workspace: 200 echoes the stored name and the row is written", async () => {
    const { db } = fixture();
    const res = await putName(db, "ws-acme", "dana", "  Acme Labs  ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Acme Labs" });
    expect(nameOf(db, "ws-acme")).toBe("Acme Labs");
    // A workspace write never touches the session jar.
    expect(res.headers.getSetCookie()).toEqual([]);
    // The path segment is the id and never changes with the name.
    expect(nameOf(db, "beta")).toBe("beta-x");
  });

  test("the old slug still addresses the row — the id did not move", async () => {
    const { db } = fixture();
    const res = await putName(db, "acme", "dana", "Acme Labs");
    expect(res.status).toBe(200);
    expect(nameOf(db, "ws-acme")).toBe("Acme Labs");
  });

  test("non-owners are refused with 403 and nothing changes", async () => {
    const { db } = fixture();
    for (const [ref, login] of [
      ["ws-acme", "erin"], // admin of ws-acme
      ["beta-x", "dana"], // plain member of `beta`
    ] as const) {
      const res = await putName(db, ref, login, "Hijacked");
      expect(res.status, `${ref} ${login}`).toBe(403);
    }
    expect(nameOf(db, "ws-acme")).toBe("acme");
    expect(nameOf(db, "beta")).toBe("beta-x");
  });

  test("an outsider and an unknown ref both answer the same 404", async () => {
    const { db } = fixture();
    expect((await putName(db, "ws-acme", "mallory", "Hijacked")).status).toBe(404);
    expect((await putName(db, "ws-missing", "dana", "Hijacked")).status).toBe(404);
    expect(nameOf(db, "ws-acme")).toBe("acme");
  });

  test("an empty or whitespace-only name is a 400 with the creation form's copy", async () => {
    const { db } = fixture();
    for (const name of ["", "   "]) {
      const res = await putName(db, "ws-acme", "dana", name);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ key: "workspace.nameRequired" });
    }
    expect(nameOf(db, "ws-acme")).toBe("acme");
  });

  test("a name past the creation cap is a 400 carrying the cap", async () => {
    const { db } = fixture();
    const res = await putName(db, "ws-acme", "dana", "x".repeat(81));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ key: "workspace.nameTooLong", params: { max: 80 } });
    expect(nameOf(db, "ws-acme")).toBe("acme");
  });

  test("exactly the cap is accepted", async () => {
    const { db } = fixture();
    const longest = "x".repeat(80);
    const res = await putName(db, "ws-acme", "dana", longest);
    expect(res.status).toBe(200);
    expect(nameOf(db, "ws-acme")).toBe(longest);
  });
});
