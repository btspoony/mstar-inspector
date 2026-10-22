/**
 * Plan 98 T2 — the owner-editable workspace slug.
 *
 * `PUT /:workspaceRef/api/settings/slug` is owner-only and answers the failure
 * table's machine-readable codes; the write itself is one guarded UPDATE, so a
 * refusal changes no row. The last two cases are the contract's point: a
 * rename kills the OLD ref (404, no redirect) while the id and the new slug
 * both keep resolving to the same workspace.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { setWorkspaceSlug } from "../../src/dashboard/workspace-store";
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
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
    WORKSPACE_TENANT_MODE: "strict",
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
 * `dana` too so a 403 can only come from the ROLE), and an App in `acme` so an
 * old-ref 404 can only come from the ref resolution.
 */
function fixture() {
  const db = createMigratedTestD1();
  const dana = seedUser(db, "dana");
  const erin = seedUser(db, "erin");
  // A real signed-in account with NO membership in any seeded workspace.
  seedUser(db, "mallory");
  seedWorkspace(db, "ws-acme", "acme");
  seedWorkspace(db, "beta", "beta-x");
  seedMembership(db, "ws-acme", dana, "owner");
  seedMembership(db, "beta", dana, "member");
  seedMembership(db, "ws-acme", erin, "admin");
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
       (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES ('app-acme', 'acme-app', 9001, 'acme-app', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'v1.primary.aXZpdi.cHJldGV4dA==', 'dana', 'active', ?, ?)`,
    now,
    now,
  );
  seed(db, "INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('app-acme', 'ws-acme')");
  return { db, dana, erin };
}

const slugOf = (db: TestD1, id: string): string => {
  const row: unknown = db.raw.query("SELECT slug FROM workspaces WHERE id = ?").get(id);
  if (typeof row !== "object" || row === null || !("slug" in row)) return "";
  return typeof row.slug === "string" ? row.slug : "";
};

/** The refusal's machine-readable code (empty when the body carries none). */
async function errorCode(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("code" in body)) return "";
  return typeof body.code === "string" ? body.code : "";
}

async function putSlug(
  db: TestD1,
  ref: string,
  login: string,
  slug: unknown,
): Promise<Response> {
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

/** The two read surfaces a ref must resolve on: an API read and the SPA shell. */
async function readStatus(db: TestD1, ref: string, login: string): Promise<number[]> {
  const api = await worker.fetch(
    new Request(`https://worker.local/dashboard/${ref}/api/apps`, {
      headers: {
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
        Accept: "application/json",
      },
    }),
    envFor(db),
  );
  const page = await worker.fetch(
    new Request(`https://worker.local/dashboard/${ref}/apps/acme-app/onboarding`, {
      headers: {
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
        Accept: "text/html",
      },
    }),
    withSpaAssets(envFor(db)),
  );
  return [api.status, page.status];
}

describe("PUT /:workspaceRef/api/settings/slug", () => {
  test("an owner's valid rename is stored and echoed", async () => {
    const { db } = fixture();
    const res = await putSlug(db, "acme", "dana", "acme-labs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "acme-labs" });
    expect(slugOf(db, "ws-acme")).toBe("acme-labs");
  });

  test("a reserved word is 409 slug_reserved and writes nothing", async () => {
    const { db } = fixture();
    const res = await putSlug(db, "acme", "dana", "members");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("slug_reserved");
    expect(slugOf(db, "ws-acme")).toBe("acme");
  });

  test("a duplicate is 409 slug_taken regardless of case", async () => {
    const { db } = fixture();
    // Uppercase cannot reach the store through the shape gate, so the
    // case-insensitive comparison is exercised at the store level — the layer
    // the plan pins it in (`COLLATE NOCASE`).
    expect(await setWorkspaceSlug(db, "ws-acme", "BETA-X")).toBe("slug_taken");
    expect(slugOf(db, "ws-acme")).toBe("acme");

    const res = await putSlug(db, "acme", "dana", "beta-x");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("slug_taken");
    expect(slugOf(db, "ws-acme")).toBe("acme");
  });

  test("a slug equal to another workspace's id is 409 slug_is_workspace_id", async () => {
    const { db } = fixture();
    const res = await putSlug(db, "acme", "dana", "beta");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("slug_is_workspace_id");
    expect(slugOf(db, "ws-acme")).toBe("acme");
  });

  test("a slug outside the shape gate is 400 and writes nothing", async () => {
    const { db } = fixture();
    for (const bad of ["a", "Acme", "-acme", "acme_1", "acme labs", "x".repeat(40)]) {
      const res = await putSlug(db, "acme", "dana", bad);
      expect(res.status, bad).toBe(400);
    }
    expect(slugOf(db, "ws-acme")).toBe("acme");
  });

  test("a non-owner (admin or member) is 403 and writes nothing", async () => {
    const { db } = fixture();
    for (const [ref, login] of [
      ["acme", "erin"], // workspace admin in ws-acme
      ["beta-x", "dana"], // plain member in `beta`
    ] as const) {
      const res = await putSlug(db, ref, login, "renamed");
      expect(res.status, `${ref} ${login}`).toBe(403);
    }
    expect(slugOf(db, "ws-acme")).toBe("acme");
    expect(slugOf(db, "beta")).toBe("beta-x");
  });

  test("an outsider never learns the workspace exists", async () => {
    const { db } = fixture();
    const res = await putSlug(db, "acme", "mallory", "acme-labs");
    expect(res.status).toBe(404);
    expect(slugOf(db, "ws-acme")).toBe("acme");
  });
});

describe("after a rename", () => {
  test("the old slug 404s; the id and the new slug both still resolve", async () => {
    const { db } = fixture();
    expect(await readStatus(db, "acme", "dana")).toEqual([200, 200]);

    expect((await putSlug(db, "acme", "dana", "acme-labs")).status).toBe(200);

    expect(await readStatus(db, "acme", "dana")).toEqual([404, 404]);
    expect(await readStatus(db, "acme-labs", "dana")).toEqual([200, 200]);
    expect(await readStatus(db, "ws-acme", "dana")).toEqual([200, 200]);
  });
});

describe("the slug route is workspace-only", () => {
  test("the deployment-level path does not exist", async () => {
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

  test("a slug equal to the workspace's own id is allowed (the creation shape)", async () => {
    const { db } = fixture();
    const res = await putSlug(db, "acme", "dana", "ws-acme");
    expect(res.status).toBe(200);
    expect(slugOf(db, "ws-acme")).toBe("ws-acme");
  });
});
