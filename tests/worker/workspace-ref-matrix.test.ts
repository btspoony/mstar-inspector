/**
 * The workspace ref matrix (workspace URL identifiers, 2026-10 — I-000059).
 *
 * Six ref shapes × the two request surfaces that RESOLVE a workspace
 * server-side: an HTML navigation to a dashboard-rendered page (which answers a
 * rendered page or the styled 404) and an API read (bare status).
 *
 *   id          the row's generated `ws_…` PK             → serves
 *   slug        the human-readable segment                → serves
 *   both-equal  the creation shape, `slug = id`           → serves
 *   unknown     no row matches                            → 404
 *   soft-deleted a matching row with `deleted_at` set      → 404
 *   two-row     a slug equal to another row's id           → 404 + one warn
 *
 * Every hidden shape must be the same 404 on both surfaces, and every hidden
 * 404 must be the same BYTES: a difference between an id-addressed and a
 * slug-addressed 404 would be an existence oracle for the other form.
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

/**
 * The App's immutable GitHub App id (D0) — the detail routes address the App by
 * this, never by its local webhook path. Deterministic per workspace so the
 * path builder can name it without threading a read through the case table.
 */
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

/** An App plus its workspace mapping; the label is derived from the workspace id. */
function seedApp(db: TestD1, workspaceId: string): void {
  const slug = `${workspaceId}-app`;
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
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
  seed(db, "INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)", `app-${workspaceId}`, workspaceId);
}

/**
 * One login (`dana`) owns EVERY workspace seeded here and every one carries a
 * mapped App, so a 404 in the hidden cells can only come from the ref
 * resolution — never from a missing membership or App. The ambiguous pair is
 * `dup`: workspace `ws_dup` carries the slug `dup`, workspace `dup` carries the
 * id `dup`.
 */
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

/** The two surfaces that resolve a workspace server-side. */
function surfaces() {
  return [
    {
      surface: "HTML dashboard read",
      // A dashboard-rendered page: the tenant gate resolves the ref, then the
      // member gate answers the page or the styled 404.
      path: (ref: string, workspaceId: string) =>
        `/dashboard/${ref}/apps/${githubAppIdOf(workspaceId)}/onboarding`,
      accept: "text/html",
    },
    {
      surface: "API read",
      // Same signature as the HTML surface so one call site drives both; the
      // API read names no resource, only the workspace.
      path: (ref: string, _workspaceId: string) => `/dashboard/${ref}/api/apps`,
      accept: "application/json",
    },
  ] as const;
}

type RefCase = {
  shape: string;
  /** Every ref that names this shape; a shape may have more than one form. */
  refs: readonly string[];
  /** The workspace whose App the HTML detail path names — never a missing App. */
  workspaceId: string;
  status: 200 | 404;
  /** Structured `workspace_ref_ambiguous` lines expected per request. */
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
      // Premise of the two-row cell: BOTH rows exist and BOTH grant `dana`
      // access, so picking one would have answered 200.
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
      // One body for every hidden shape and every hidden ref form: the 404
      // cannot tell an id-addressed from a slug-addressed miss.
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
    // The list row carries GitHub's slug and the immutable App id — never the
    // local webhook path (D6).
    expect(byId.apps.map((app) => app.github_slug)).toEqual(["ws-acme-app"]);
    expect(byId.apps.map((app) => app.github_app_id)).toEqual([githubAppIdOf("ws-acme")]);
    expect(bySlug).toEqual(byId);
  });
});
