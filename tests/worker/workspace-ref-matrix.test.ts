import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "ref", "matrix", "session", "32-bytes!"].join("-");
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

const appIds = new Map<string, number>();
let nextGithubAppId = 7000;

function githubAppIdOf(workspaceId: string): number {
  let id = appIds.get(workspaceId);
  if (id === undefined) {
    id = nextGithubAppId++;
    appIds.set(workspaceId, id);
  }
  return id;
}

function seedApp(db: TestD1, workspaceId: string): void {
  const slug = `${workspaceId}-app`;
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO review_bots
       (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'dana', 'active', ?, ?)`,
    `app-${workspaceId}`,
    slug,
    githubAppIdOf(workspaceId),
    slug,
    now,
    now,
  );
  seed(db, "INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)", `app-${workspaceId}`, workspaceId);
}

function refFixture(): TestD1 {
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
  return db;
}

function surfaces() {
  return [
    {
      surface: "HTML dashboard read",
      path: (ref: string, workspaceId: string) =>
        `/dashboard/${ref}/apps/${githubAppIdOf(workspaceId)}/onboarding`,
      accept: "text/html",
    },
    {
      surface: "API read",
      path: (ref: string, _workspaceId: string) => `/dashboard/${ref}/api/apps`,
      accept: "application/json",
    },
  ] as const;
}

type RefCase = {
  shape: string;
  refs: readonly string[];
  workspaceId: string;
  status: 200 | 404;
  ambiguousWarns: 0 | 1;
};

const REF_CASES: readonly RefCase[] = [
  { shape: "id", refs: ["ws-acme"], workspaceId: "ws-acme", status: 200, ambiguousWarns: 0 },
  { shape: "slug", refs: ["acme"], workspaceId: "ws-acme", status: 200, ambiguousWarns: 0 },
  {
    shape: "both-equal (slug = id)",
    refs: ["ws_same"],
    workspaceId: "ws_same",
    status: 200,
    ambiguousWarns: 0,
  },
  { shape: "unknown", refs: ["ghost"], workspaceId: "ws-acme", status: 404, ambiguousWarns: 0 },
  {
    shape: "soft-deleted",
    refs: ["ws-gone", "gone"],
    workspaceId: "ws-gone",
    status: 404,
    ambiguousWarns: 0,
  },
  { shape: "two-row", refs: ["dup"], workspaceId: "ws_dup", status: 404, ambiguousWarns: 1 },
];

describe("workspace ref matrix — six ref shapes × two resolving surfaces", () => {
  for (const { surface, path, accept } of surfaces()) {
    test(`${surface}: serves id, slug and slug=id; unknown, soft-deleted and two-row are the same 404`, async () => {
      const db = refFixture();
      const ambiguousRows = db.raw
        .query("SELECT COUNT(*) AS n FROM workspaces WHERE id = 'dup' OR slug = 'dup'")
        .get() as { n: number };
      expect(ambiguousRows.n).toBe(2);

      const hiddenBodies: string[] = [];
      for (const { shape, refs, workspaceId, status, ambiguousWarns } of REF_CASES) {
        for (const ref of refs) {
          const label = `${surface} · ${shape} · ${ref}`;
          const warns: string[] = [];
          const original = console.warn;
          console.warn = (msg: unknown) => {
            warns.push(String(msg));
          };
          let res: Response;
          let body: string;
          try {
            res = await worker.fetch(
              await request(path(ref, workspaceId), "dana", accept),
              withSpaAssets(envFor(db)),
            );
            body = await res.text();
          } finally {
            console.warn = original;
          }
          expect(res.status, label).toBe(status);
          const ambiguous = warns.filter((line) =>
            line.includes('"event":"workspace_ref_ambiguous"'),
          );
          expect(ambiguous.length, label).toBe(ambiguousWarns);
          if (ambiguousWarns === 1) expect(ambiguous[0], label).toContain(`"ref":"${ref}"`);
          if (status === 200) {
            expect(body, label).toContain(`${workspaceId}-app`);
          } else {
            hiddenBodies.push(body);
          }
        }
      }
      expect(new Set(hiddenBodies).size, surface).toBe(1);
    });
  }

  test("an id-addressed read and a slug-addressed read serve the SAME workspace", async () => {
    const db = refFixture();
    const read = async (ref: string) => {
      const res = await worker.fetch(
        await request(`/dashboard/${ref}/api/apps`, "dana", "application/json"),
        envFor(db),
      );
      expect(res.status, ref).toBe(200);
      return (await res.json()) as { apps: Array<{ github_app_id: number; github_slug: string | null }> };
    };
    const byId = await read("ws-acme");
    const bySlug = await read("acme");
    expect(byId.apps.map((app) => app.github_slug)).toEqual(["ws-acme-app"]);
    expect(byId.apps.map((app) => app.github_app_id)).toEqual([githubAppIdOf("ws-acme")]);
    expect(bySlug).toEqual(byId);
  });
});
