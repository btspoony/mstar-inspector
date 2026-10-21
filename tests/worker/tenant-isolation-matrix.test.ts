/**
 * Task 7 — the tenant isolation matrix.
 *
 * One executable table of (scenario × mode) cells that crosses the layers
 * built in T2–T6: the routing gate, the membership gate, the scoped App
 * resolve, the strict `app_workspaces` read face, and the mode switch itself.
 * Each row names the layer it exercises and, where a task-level test already
 * pins the same statement, is annotated `covered by <file>` — those rows assert
 * only the cross-layer composition (what happens when two of those layers act
 * on the SAME fixture), never a restatement of the owning test.
 *
 * Rows:
 *   1. cross-workspace App — serves in its own workspace, 404 in the sibling
 *      even for a manager of BOTH (scoping, not membership).
 *      covered by tests/worker/dashboard-tenancy.test.ts (cross-workspace 404)
 *   2. signed-in non-member — 404, never 403, on both faces.
 *      covered by tests/worker/dashboard-tenancy.test.ts (no-membership 404)
 *   3. workspace member — reads the list, denied every management write.
 *      covered by tests/worker/dashboard-tenancy.test.ts (member 403)
 *   4. orphan App — absent from the strict workspace list, present under off.
 *      covered by tests/store/tenant-read-face.test.ts (store-level invisibility)
 *   5. soft-deleted workspace — its slug answers 404 under strict.
 *      NEW cell (no task-level owner): the `workspaces.deleted_at` filter.
 *   6. off keeps the legacy App face for the same fixture.
 *      covered by tests/worker/dashboard-tenancy.test.ts (off legacy intact)
 *   7. illegal WORKSPACE_TENANT_MODE — dashboard 500 and consumer refusal
 *      before any store write, from one env value.
 *      covered by tests/worker/dashboard-tenancy.test.ts (dashboard 500) and
 *      tests/pipeline/consumer.test.ts (eager throw), composed across layers.
 *
 * The consumer's own orphan/off read face is deliberately NOT re-driven here:
 * its fixture builder (encrypted PEM + per-App AI config) is file-private, and
 * copying it is the STOP condition in the task brief. That cell stays owned by
 * tests/pipeline/consumer.test.ts.
 */
import { describe, expect, test } from "bun:test";
// Load shim only: the consumer statically imports ./sandbox → the workerd
// builtin `cloudflare:workers` (unresolvable in Bun's test runner).
import "../helpers/cloudflare-workers-mock";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

// Dynamic AFTER the shim: the static import order would resolve the workerd
// builtin before mock.module had a chance to register it.
const { default: worker } = await import("../../src/worker/index");
const { createReviewConsumer } = await import("../../src/pipeline/consumer");

const SESSION_SECRET = ["test", "matrix", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function envFor(db: TestD1, mode?: "off" | "strict"): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
    ...(mode === undefined ? {} : { WORKSPACE_TENANT_MODE: mode }),
  } as unknown as Env;
}

async function request(
  path: string,
  login: string,
  init: { method?: string; body?: string } = {},
): Promise<Request> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return new Request(`https://worker.local${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const seed = (db: TestD1, sql: string, ...params: Array<string | number | null>): void => {
  db.raw.prepare(sql).run(...params);
};

function seedUser(db: TestD1, login: string, role: "admin" | "member"): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)",
    id,
    login,
    role,
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

let nextGithubAppId = 5000;

/** An App row plus its single workspace mapping (migration 0026 production shape). */
function seedApp(db: TestD1, id: string, slug: string, workspaceId: string | null): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
       (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'octocat', 'active', ?, ?)`,
    id,
    slug,
    nextGithubAppId++,
    slug,
    now,
    now,
  );
  if (workspaceId !== null) {
    seed(db, "INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)", id, workspaceId);
  }
}

/**
 * The matrix fixture: two live workspaces, one soft-deleted one, and a role
 * matrix that separates membership from App ownership.
 *
 * - `dana` manages BOTH live workspaces, so any 404 she sees is scoping, not
 *   membership.
 * - `bob` owns `other` and has no row in `acme` — the no-membership cell.
 * - `mallory` is a plain `member` of `acme` — the read-allowed/write-denied cell.
 * - `octocat` is a DEPLOYMENT admin but only a workspace member, so the legacy
 *   rule and the workspace rule disagree for every route they share.
 * - `orphan-app` is mapped to nothing: the pre-0026 row the backfill missed.
 * - `gone` is soft-deleted with a live membership and a mapped App, so the
 *   route gate's `deleted_at` filter is the only thing hiding it.
 */
function matrixFixture() {
  const db = createMigratedTestD1();
  const users = {
    legacyAdmin: seedUser(db, "octocat", "admin"),
    dana: seedUser(db, "dana", "member"),
    mallory: seedUser(db, "mallory", "member"),
    bob: seedUser(db, "bob", "member"),
  };
  seedWorkspace(db, "ws-acme", "acme");
  seedWorkspace(db, "ws-other", "other");
  seedWorkspace(db, "ws-gone", "gone", new Date().toISOString());
  seedMembership(db, "ws-acme", users.legacyAdmin, "member");
  seedMembership(db, "ws-acme", users.dana, "owner");
  seedMembership(db, "ws-acme", users.mallory, "member");
  seedMembership(db, "ws-other", users.dana, "owner");
  seedMembership(db, "ws-other", users.bob, "owner");
  seedMembership(db, "ws-gone", users.dana, "owner");
  seedApp(db, "app-acme", "acme-app", "ws-acme");
  seedApp(db, "app-other", "other-app", "ws-other");
  seedApp(db, "app-orphan", "orphan-app", null);
  seedApp(db, "app-gone", "gone-app", "ws-gone");
  return { db, users };
}

type ListBody = { viewer: { login: string }; apps: Array<{ slug: string }> };

describe("tenant isolation matrix (scenario × mode)", () => {
  // row 1 — layers: route family gate → membership gate → scoped App resolve
  //         → strict store read. covered by tests/worker/dashboard-tenancy.test.ts
  //         (cross-workspace 404); composed here on a manager of BOTH tenants,
  //         so the 404 can only come from the App↔workspace check.
  test("row 1 · cross-workspace App serves only inside its own workspace, 404 in the sibling", async () => {
    const { db } = matrixFixture();
    const strict = envFor(db, "strict");

    for (const [own, ownApp, sibling] of [
      ["acme", "acme-app", "other"],
      ["other", "other-app", "acme"],
    ] as const) {
      const served = await worker.fetch(
        await request(`/dashboard/${own}/apps/${ownApp}/onboarding`, "dana"),
        strict,
      );
      expect(served.status, `${own}/${ownApp}`).toBe(200);

      const crossed = await worker.fetch(
        await request(`/dashboard/${sibling}/apps/${ownApp}/onboarding`, "dana"),
        strict,
      );
      expect(crossed.status, `${sibling}/${ownApp}`).toBe(404);
    }
  });

  // row 2 — layers: routing gate (workspace exists) + membership gate (role row).
  //         covered by tests/worker/dashboard-tenancy.test.ts (no-membership 404);
  //         composed here over BOTH faces of the tenant (list + detail) so the
  //         absence of a membership row cannot leak as 403 on either.
  test("row 2 · a signed-in non-member gets 404 — never 403 — on the list and the detail face", async () => {
    const { db } = matrixFixture();
    const env = envFor(db, "strict");

    const list = await worker.fetch(await request("/dashboard/acme/api/apps", "bob"), env);
    const detail = await worker.fetch(
      await request("/dashboard/acme/apps/acme-app/onboarding", "bob"),
      env,
    );
    for (const [face, res] of [
      ["list", list],
      ["detail", detail],
    ] as const) {
      expect(res.status, face).toBe(404);
      expect(res.status, face).not.toBe(403);
    }
  });

  // row 3 — layers: membership gate → read store → canManageApp(scope.role).
  //         covered by tests/worker/dashboard-tenancy.test.ts (member 403 /
  //         list 200); composed as ONE actor reading and being denied writing
  //         in the same workspace, with the write provably not applied.
  test("row 3 · a workspace member reads the App list but every management write is 403 and lands nothing", async () => {
    const { db } = matrixFixture();
    const env = envFor(db, "strict");

    const list = await worker.fetch(await request("/dashboard/acme/api/apps", "mallory"), env);
    expect(list.status).toBe(200);
    const body = (await list.json()) as ListBody;
    expect(body.viewer.login).toBe("mallory");
    expect(body.apps.map((app) => app.slug).sort()).toEqual(["acme-app"]);

    const onboarding = await worker.fetch(
      await request("/dashboard/acme/apps/acme-app/onboarding", "mallory"),
      env,
    );
    expect(onboarding.status).toBe(403);

    const write = await worker.fetch(
      await request("/dashboard/acme/apps/acme-app/settings", "mallory", {
        method: "POST",
        body: "op=save-sandbox-image&sandbox_image_id=not-a-real-image",
      }),
      env,
    );
    expect(write.status).toBe(403);

    // The denial is a refusal, not a silent no-op after a partial write.
    const row = db.raw
      .query("SELECT sandbox_image_id, status FROM github_apps WHERE id = 'app-acme'")
      .get() as { sandbox_image_id: string; status: string };
    expect(row.status).toBe("active");
    expect(row.sandbox_image_id).toBe("omp"); // 0018 DDL default, untouched by the refused write
  });

  // row 4 — layers: strict INNER JOIN read face → workspace list route / off
  //         single-table read → legacy list route. covered by
  //         tests/store/tenant-read-face.test.ts at the store level; composed
  //         here through the HTTP faces both modes serve.
  test("row 4 · an orphan App is absent from the strict workspace list and present under off", async () => {
    const { db } = matrixFixture();

    const strictList = await worker.fetch(
      await request("/dashboard/acme/api/apps", "dana"),
      envFor(db, "strict"),
    );
    expect(strictList.status).toBe(200);
    const strictSlugs = ((await strictList.json()) as ListBody).apps.map((app) => app.slug);
    expect(strictSlugs).toContain("acme-app");
    expect(strictSlugs).not.toContain("orphan-app");

    // Strict detail agrees: the same unmapped row is indistinguishable from a
    // missing slug (no workspace can claim it).
    const strictDetail = await worker.fetch(
      await request("/dashboard/acme/apps/orphan-app/onboarding", "dana"),
      envFor(db, "strict"),
    );
    expect(strictDetail.status).toBe(404);

    // off is unchanged: the legacy list is single-table, so the orphan shows.
    const offList = await worker.fetch(
      await request("/dashboard/api/apps", "octocat"),
      envFor(db, "off"),
    );
    expect(offList.status).toBe(200);
    const offSlugs = ((await offList.json()) as ListBody).apps.map((app) => app.slug);
    expect(offSlugs).toContain("orphan-app");

    const offDetail = await worker.fetch(
      await request("/dashboard/apps/orphan-app/onboarding", "octocat"),
      envFor(db, "off"),
    );
    expect(offDetail.status).toBe(200);
  });

  // row 5 — NEW cell (no task-level owner): layers: route gate →
  //         getWorkspaceBySlug `deleted_at IS NULL` → scoped read. The tenant
  //         has a live membership row and a mapped App, so only the soft-delete
  //         filter can produce the 404.
  test("row 5 · a soft-deleted workspace slug answers 404 under strict despite membership and a mapped App", async () => {
    const { db } = matrixFixture();
    const env = envFor(db, "strict");

    const list = await worker.fetch(await request("/dashboard/gone/api/apps", "dana"), env);
    expect(list.status).toBe(404);

    const detail = await worker.fetch(
      await request("/dashboard/gone/apps/gone-app/onboarding", "dana"),
      env,
    );
    expect(detail.status).toBe(404);

    // The rows still exist: the 404 is the gate's filter, not missing data.
    const live = db.raw
      .query(
        `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = 'ws-gone') AS members,
                (SELECT COUNT(*) FROM app_workspaces WHERE workspace_id = 'ws-gone') AS apps`,
      )
      .get() as { members: number; apps: number };
    expect(live).toEqual({ members: 1, apps: 1 });
  });

  // row 6 — layers: route family gate only. covered by
  //         tests/worker/dashboard-tenancy.test.ts (off legacy intact); composed
  //         against the SAME fixture as the strict rows above, so the pair
  //         proves the mode — not the data — decides the face.
  test("row 6 · off keeps the legacy App face for the same App that strict serves on the workspace path", async () => {
    const { db } = matrixFixture();
    const off = envFor(db, "off");

    const legacyServes = await worker.fetch(
      await request("/dashboard/apps/acme-app/onboarding", "octocat"),
      off,
    );
    expect(legacyServes.status).toBe(200);

    const workspaceHidden = await worker.fetch(
      await request("/dashboard/acme/apps/acme-app/onboarding", "dana"),
      off,
    );
    expect(workspaceHidden.status).toBe(404);

    const strictLegacyRetired = await worker.fetch(
      await request("/dashboard/apps/acme-app/onboarding", "octocat"),
      envFor(db, "strict"),
    );
    expect(strictLegacyRetired.status).toBe(404);
  });

  // row 7 — layers: tenantModeOf (single resolver) → dashboard gate AND
  //         consumer creation. covered by tests/worker/dashboard-tenancy.test.ts
  //         (500) and tests/pipeline/consumer.test.ts (eager throw); composed
  //         here from ONE env value so the two faces cannot drift, and the
  //         consumer is proven to refuse before it touches the store.
  test("row 7 · an illegal mode answers 500 on every dashboard face and refuses the consumer before any write", async () => {
    const { db } = matrixFixture();
    const env = { ...envFor(db), WORKSPACE_TENANT_MODE: "on" } as unknown as Env;
    const expected = 'invalid WORKSPACE_TENANT_MODE on — expected "off" or "strict"';

    for (const path of ["/dashboard/apps", "/dashboard/acme/apps", "/dashboard/login"]) {
      const res = await worker.fetch(await request(path, "octocat"), env);
      expect(res.status, path).toBe(500);
      expect(await res.text(), path).toContain(expected);
    }

    // The consumer resolves the same value eagerly: the throw happens while
    // the deps are built, before a message body is read or a store is written.
    expect(() => createReviewConsumer(env as never, { info() {}, warn() {}, error() {} })).toThrow(
      expected,
    );
    const counts = db.raw
      .query(
        `SELECT (SELECT COUNT(*) FROM reviews) AS reviews,
                (SELECT COUNT(*) FROM review_failures) AS failures`,
      )
      .get() as { reviews: number; failures: number };
    expect(counts).toEqual({ reviews: 0, failures: 0 });
  });
});
