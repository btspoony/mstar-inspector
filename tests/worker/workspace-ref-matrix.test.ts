/**
 * Plan 98 T1 — the workspace segment resolves by id OR slug.
 *
 * One table of ref shapes × the two request surfaces that RESOLVE a workspace
 * server-side: an HTML navigation to a dashboard-rendered page (which answers a
 * rendered page or the styled 404) and an API read (bare status). Every hidden
 * shape must be the same 404 on both — a difference between an id-addressed and
 * a slug-addressed 404 would be an existence oracle for the other form.
 *
 * Each fixture workspace owns a mapped App, so a 404 can never come from a
 * missing resource: only the ref resolution can produce it.
 *
 * The ambiguous shape is the interesting one — a slug that equals another
 * workspace's id makes the single read return TWO rows, and the contract is the
 * unknown-ref 404 (plus one operator warning) rather than picking one, because
 * picking would be a cross-tenant read.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "ref", "matrix", "session", "32-bytes!"].join("-");
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

async function request(path: string, login: string, accept?: string): Promise<Request> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
  if (accept !== undefined) headers.Accept = accept;
  return new Request(`https://worker.local${path}`, { headers });
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

function seedWorkspace(
  db: TestD1,
  id: string,
  slug: string,
  deletedAt: string | null = null,
): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, ?)",
    id,
    slug,
    slug,
    new Date().toISOString(),
    deletedAt,
  );
}

function seedMembership(db: TestD1, workspaceId: string, userId: string): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    workspaceId,
    userId,
    new Date().toISOString(),
  );
}

let nextGithubAppId = 7000;

/** An App plus its workspace mapping; the slug is derived from the workspace id. */
function seedApp(db: TestD1, workspaceId: string): string {
  const slug = `${workspaceId}-app`;
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
       (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'dana', 'active', ?, ?)`,
    `app-${workspaceId}`,
    slug,
    nextGithubAppId++,
    slug,
    now,
    now,
  );
  seed(db, "INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)", `app-${workspaceId}`, workspaceId);
  return slug;
}

type Fixture = { db: TestD1; app: (workspaceId: string) => string };

/**
 * One login (`dana`) owns EVERY workspace seeded here and every one carries a
 * mapped App, so a 404 in the hidden cells can only come from the ref
 * resolution — never from a missing membership or App. The ambiguous pair is
 * `dup`: workspace `ws_dup` carries the slug `dup`, workspace `dup` carries the
 * id `dup`.
 */
function refFixture(): Fixture {
  const db = createMigratedTestD1();
  const dana = seedUser(db, "dana");
  const workspaces: Array<[string, string, string | null]> = [
    ["ws-acme", "acme", null],
    ["ws_same", "ws_same", null],
    ["ws-gone", "gone", new Date().toISOString()],
    ["ws_dup", "dup", null],
    ["dup", "dup-owner", null],
  ];
  for (const [id, slug, deletedAt] of workspaces) {
    seedWorkspace(db, id, slug, deletedAt);
    seedMembership(db, id, dana);
    seedApp(db, id);
  }
  return { db, app: (workspaceId) => `${workspaceId}-app` };
}

/** The two surfaces that resolve a workspace server-side. */
function surfaces(appOf: (workspaceId: string) => string) {
  return [
    {
      surface: "HTML GET",
      // A dashboard-rendered page: the tenant gate resolves the ref, then the
      // member gate answers the page or the styled 404.
      path: (ref: string, workspaceId: string) =>
        `/dashboard/${ref}/apps/${appOf(workspaceId)}/onboarding`,
      accept: "text/html",
    },
    {
      surface: "API GET",
      path: (ref: string) => `/dashboard/${ref}/api/apps`,
      accept: "application/json",
    },
  ] as const;
}

describe("workspace ref resolution — id, slug and both-equal serve", () => {
  test("id, slug and the creation shape (slug = id) all serve", async () => {
    const { db, app } = refFixture();
    for (const { surface, path, accept } of surfaces(app)) {
      for (const [ref, workspaceId] of [
        ["ws-acme", "ws-acme"], // the id, whose slug is `acme`
        ["acme", "ws-acme"], // the slug, whose id is `ws-acme`
        ["ws_same", "ws_same"], // creation shape: slug = id
      ] as const) {
        const res = await worker.fetch(
          await request(path(ref, workspaceId), "dana", accept),
          withSpaAssets(envFor(db)),
        );
        expect(res.status, `${surface} ${ref}`).toBe(200);
      }
    }
  });

  test("an id-addressed read and a slug-addressed read serve the SAME workspace", async () => {
    const { db } = refFixture();
    const read = async (ref: string) => {
      const res = await worker.fetch(
        await request(`/dashboard/${ref}/api/apps`, "dana", "application/json"),
        envFor(db),
      );
      expect(res.status, ref).toBe(200);
      return (await res.json()) as { apps: Array<{ slug: string }> };
    };
    const byId = await read("ws-acme");
    const bySlug = await read("acme");
    expect(byId.apps.map((app) => app.slug)).toEqual(["ws-acme-app"]);
    expect(bySlug).toEqual(byId);
  });
});

describe("workspace ref resolution — hidden shapes are the same 404 on both surfaces", () => {
  test("an unknown ref answers 404", async () => {
    const { db, app } = refFixture();
    for (const { surface, path, accept } of surfaces(app)) {
      const res = await worker.fetch(
        await request(path("ghost", "ws-acme"), "dana", accept),
        withSpaAssets(envFor(db)),
      );
      expect(res.status, surface).toBe(404);
    }
  });

  test("a soft-deleted workspace answers 404 by id and by slug", async () => {
    const { db, app } = refFixture();
    for (const { surface, path, accept } of surfaces(app)) {
      for (const ref of ["ws-gone", "gone"]) {
        const res = await worker.fetch(
          await request(path(ref, "ws-gone"), "dana", accept),
          withSpaAssets(envFor(db)),
        );
        expect(res.status, `${surface} ${ref}`).toBe(404);
      }
    }
  });

  test("an ambiguous ref answers 404 and warns once, never picking a row", async () => {
    const { db, app } = refFixture();
    // Both rows are real and BOTH have an App `dana` may manage, so a pick
    // would answer 200: the 404 is the exactly-one-row rule.
    const rows = db.raw
      .query("SELECT COUNT(*) AS n FROM workspaces WHERE id = 'dup' OR slug = 'dup'")
      .get() as { n: number };
    expect(rows.n).toBe(2);

    for (const { surface, path, accept } of surfaces(app)) {
      const warns: string[] = [];
      const original = console.warn;
      console.warn = (msg: unknown) => {
        warns.push(String(msg));
      };
      let status: number;
      try {
        const res = await worker.fetch(
          await request(path("dup", "ws_dup"), "dana", accept),
          withSpaAssets(envFor(db)),
        );
        status = res.status;
      } finally {
        console.warn = original;
      }
      expect(status, surface).toBe(404);
      const ambiguous = warns.filter((line) => line.includes('"event":"workspace_ref_ambiguous"'));
      expect(ambiguous.length, surface).toBe(1);
      expect(ambiguous[0]).toContain('"ref":"dup"');
    }
  });
});
