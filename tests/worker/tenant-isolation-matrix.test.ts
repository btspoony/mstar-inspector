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
 * Rows (numbered in file order):
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
 *   7. workspace ref grammar — the same workspace answers on its id and on its
 *      slug; every hidden ref form answers 404.
 *      NEW cell (workspace URL identifiers, 2026-10 — I-000059).
 *   8. illegal WORKSPACE_TENANT_MODE — dashboard 500 and consumer refusal
 *      before any store write, from one env value.
 *      covered by tests/worker/dashboard-tenancy.test.ts (dashboard 500) and
 *      tests/pipeline/consumer.test.ts (eager throw), composed across layers.
 *
 * Every cross-workspace cell (rows 1, 2, 4, 5, 6, 7) runs through BOTH address
 * forms — the slug and the generated id — because the segment is now
 * resolvable either way and a scoping rule that held for one form only would
 * not be isolation.
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
import { insertSupportGrant } from "../../src/dashboard/operator-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

// Dynamic AFTER the shim: the static import order would resolve the workerd
// builtin before mock.module had a chance to register it.
const { default: worker } = await import("../../src/worker/index");
const { createReviewConsumer } = await import("../../src/pipeline/consumer");

const SESSION_SECRET = ["test", "matrix", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function envFor(db: TestD1, mode?: "off" | "strict", operators?: string): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
    ...(mode === undefined ? {} : { WORKSPACE_TENANT_MODE: mode }),
    ...(operators === undefined ? {} : { PLATFORM_OPERATORS: operators }),
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

/**
 * Every persisted field a management write could touch on `app-acme`, plus the
 * key/provider row counts — one equality check per route proves refusal, not a
 * partial write.
 */
function appSnapshot(db: TestD1, appId = "app-acme") {
  return {
    app: db.raw
      .query(
        `SELECT status, review_enabled, review_trigger_mode, sandbox_image_id, deleted_at, updated_at
           FROM github_apps WHERE id = ?`,
      )
      .get(appId),
    config: db.raw.query("SELECT model_chain FROM app_model_config WHERE app_id = ?").get(appId) ?? null,
    keys: db.raw.query("SELECT COUNT(*) AS n FROM app_provider_keys WHERE app_id = ?").get(appId),
    custom: db.raw.query("SELECT COUNT(*) AS n FROM app_custom_providers WHERE app_id = ?").get(appId),
  };
}

/**
 * Every management write the App routes expose, with the payload a MANAGER
 * would accept (valid vocabulary, in-range values, existing default image, an
 * EXISTING key row to delete), so a 403 can only come from the role gate. Two
 * settings `op`s share one path; they are separate entries because each is its
 * own write branch.
 *
 * `ownerStatus` is the status the route answers on a real success — the owner
 * wave asserts exactly that, so a 400/404/500 can never pass as "authorized".
 * An entry WITHOUT `ownerStatus` cannot reach a real success offline (see the
 * keys/verify note) and is therefore excluded from the positive control.
 */
const MANAGEMENT_WRITES: ReadonlyArray<{ route: string; body?: string; ownerStatus?: number }> = [
  { route: "/apps/acme-app/disable", ownerStatus: 200 },
  { route: "/apps/acme-app/enable", ownerStatus: 200 },
  { route: "/apps/acme-app/pause", ownerStatus: 200 },
  { route: "/apps/acme-app/resume", ownerStatus: 200 },
  { route: "/apps/acme-app/review-trigger-mode", body: "mode=open", ownerStatus: 200 },
  { route: "/apps/acme-app/settings", body: "op=save-chain&model_chain=", ownerStatus: 200 },
  {
    route: "/apps/acme-app/settings",
    body: "op=save-sandbox-image&sandbox_image_id=omp",
    ownerStatus: 200,
  },
  {
    route: "/apps/acme-app/settings/key/delete",
    body: "provider=anthropic&key_id=seeded-key",
    ownerStatus: 200,
  },
  // No positive control: a real 200 here needs a live provider endpoint (the
  // route verifies with globalThis.fetch). The member-403 cell below still
  // proves the authorization decision; the success path is owned by
  // tests/worker/settings-provider-first.test.ts.
  { route: "/api/apps/acme-app/keys/verify", body: "provider=anthropic&key=sk-not-a-real-key" },
  // Last: a manager's success soft-deletes the row.
  { route: "/apps/acme-app/delete", ownerStatus: 200 },
];

describe("tenant isolation matrix (scenario × mode)", () => {
  // row 1 — layers: route family gate → membership gate → scoped App resolve
  //         → strict store read. covered by tests/worker/dashboard-tenancy.test.ts
  //         (cross-workspace 404); composed here on a manager of BOTH tenants,
  //         so the 404 can only come from the App↔workspace check. Every cell
  //         runs through BOTH address forms (slug, then the row id) — a scoping
  //         rule holding for one form only would not be isolation.
  test("row 1 · cross-workspace App serves only inside its own workspace, 404 in the sibling — by slug and by id", async () => {
    const { db } = matrixFixture();
    const strict = envFor(db, "strict");

    for (const [ownRefs, ownApp, siblingRefs] of [
      [["acme", "ws-acme"], "acme-app", ["other", "ws-other"]],
      [["other", "ws-other"], "other-app", ["acme", "ws-acme"]],
    ] as const) {
      for (const own of ownRefs) {
        const served = await worker.fetch(
          await request(`/dashboard/${own}/apps/${ownApp}/onboarding`, "dana"),
          strict,
        );
        expect(served.status, `${own}/${ownApp}`).toBe(200);
      }

      for (const sibling of siblingRefs) {
        const crossed = await worker.fetch(
          await request(`/dashboard/${sibling}/apps/${ownApp}/onboarding`, "dana"),
          strict,
        );
        expect(crossed.status, `${sibling}/${ownApp}`).toBe(404);
      }
    }
  });

  // row 2 — layers: routing gate (workspace exists) + membership gate (role row).
  //         covered by tests/worker/dashboard-tenancy.test.ts (no-membership 404);
  //         composed here over BOTH faces of the tenant (list + detail) so the
  //         absence of a membership row cannot leak as 403 on either.
  test("row 2 · a signed-in non-member gets 404 — never 403 — on the list and the detail face, by slug and by id", async () => {
    const { db } = matrixFixture();
    const env = envFor(db, "strict");

    for (const ref of ["acme", "ws-acme"]) {
      const list = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "bob"), env);
      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/acme-app/onboarding`, "bob"),
        env,
      );
      for (const [face, res] of [
        ["list", list],
        ["detail", detail],
      ] as const) {
        expect(res.status, `${ref} ${face}`).toBe(404);
        expect(res.status, `${ref} ${face}`).not.toBe(403);
      }
    }
  });

  // row 3 — layers: membership gate → canManageApp(scope.role) on EVERY
  //         management entry point. covered by
  //         tests/worker/dashboard-tenancy.test.ts (list 200 / settings POST
  //         403); composed as one actor reading, then every write route with a
  //         manager-accepted payload, with the persisted row read back after
  //         each attempt and a manager pass proving the same payload is
  //         accepted — so no 403 can be a payload rejection in disguise.
  test("row 3 · a workspace member reads the App list but every management write is 403 and lands nothing", async () => {
    const { db } = matrixFixture();
    const env = envFor(db, "strict");
    // A stored chain makes the save-chain write observable: a permitted actor
    // would CLEAR it with the same empty value.
    seed(
      db,
      "INSERT INTO app_model_config (app_id, model_chain, updated_at) VALUES (?, ?, datetime('now'))",
      "app-acme",
      "ark-plan/deepseek-v4-flash",
    );
    // A REAL key row for the delete target: deleting a nonexistent key is a
    // tolerant 2xx no-op, which would prove nothing about authorization.
    seed(
      db,
      `INSERT INTO app_provider_keys (app_id, provider, key_id, key_enc, created_at)
       VALUES (?, 'anthropic', 'seeded-key', 'v1.primary.aXZpdi.c2VlZA==', datetime('now'))`,
      "app-acme",
    );

    const list = await worker.fetch(await request("/dashboard/acme/api/apps", "mallory"), env);
    expect(list.status).toBe(200);
    const body = (await list.json()) as ListBody;
    expect(body.viewer.login).toBe("mallory");
    // Read access, not the full list contract (orphan exclusion is row 4's cell).
    expect(body.apps.map((app) => app.slug)).toContain("acme-app");

    const onboarding = await worker.fetch(
      await request("/dashboard/acme/apps/acme-app/onboarding", "mallory"),
      env,
    );
    expect(onboarding.status).toBe(403);

    const post = (login: string, route: string, form?: string) =>
      request(`/dashboard/acme${route}`, login, { method: "POST", body: form ?? "" });

    // Denial wave: every route refuses this plain member, and the row is
    // byte-identical afterwards.
    const pristine = appSnapshot(db);
    for (const { route, body: form } of MANAGEMENT_WRITES) {
      const res = await worker.fetch(await post("mallory", route, form), env);
      expect(res.status, route).toBe(403);
      expect(appSnapshot(db), route).toEqual(pristine);
    }
    expect((pristine.config as { model_chain: string }).model_chain).toBe("ark-plan/deepseek-v4-flash");

    // Reachability wave: the workspace OWNER sends the same payloads and each
    // route answers its REAL success status — so every 403 above came from the
    // role, not from a payload the route would have rejected anyway.
    for (const { route, body: form, ownerStatus } of MANAGEMENT_WRITES) {
      if (ownerStatus === undefined) continue; // no offline success path
      const res = await worker.fetch(await post("dana", route, form), env);
      expect(res.status, route).toBe(ownerStatus);
    }
    // And the writes really landed (the role gate is the only difference
    // between the two waves): the seeded key is gone and the delete took effect.
    const after = appSnapshot(db);
    expect((after.keys as { n: number }).n).toBe(0);
    expect((after.app as { deleted_at: string | null }).deleted_at).not.toBeNull();
  });

  // row 4 — layers: strict INNER JOIN read face → workspace list route / off
  //         single-table read → legacy list route. covered by
  //         tests/store/tenant-read-face.test.ts at the store level; composed
  //         here through the HTTP faces both modes serve.
  test("row 4 · an orphan App is absent from the strict workspace list and present under off, on both ref forms", async () => {
    const { db } = matrixFixture();

    for (const ref of ["acme", "ws-acme"]) {
      const strictList = await worker.fetch(
        await request(`/dashboard/${ref}/api/apps`, "dana"),
        envFor(db, "strict"),
      );
      expect(strictList.status, ref).toBe(200);
      const strictSlugs = ((await strictList.json()) as ListBody).apps.map((app) => app.slug);
      expect(strictSlugs, ref).toContain("acme-app");
      expect(strictSlugs, ref).not.toContain("orphan-app");

      // Strict detail agrees: the same unmapped row is indistinguishable from a
      // missing slug (no workspace can claim it).
      const strictDetail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/orphan-app/onboarding`, "dana"),
        envFor(db, "strict"),
      );
      expect(strictDetail.status, ref).toBe(404);
    }

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

  // row 5 — NEW cell (no task-level owner): layers: route classification →
  //         getWorkspaceByRef `deleted_at IS NULL` (after the session/user
  //         read) → scoped read. The tenant has a live membership row and a
  //         mapped App, so only the soft-delete filter can produce the 404.
  test("row 5 · a soft-deleted workspace answers 404 under strict on both ref forms despite membership and a mapped App", async () => {
    const { db } = matrixFixture();
    const env = envFor(db, "strict");

    for (const ref of ["gone", "ws-gone"]) {
      const list = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(list.status, ref).toBe(404);

      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/gone-app/onboarding`, "dana"),
        env,
      );
      expect(detail.status, ref).toBe(404);
    }

    // The rows still exist: the 404 is the gate's filter, not missing data.
    const live = db.raw
      .query(
        `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = 'ws-gone') AS members,
                (SELECT COUNT(*) FROM app_workspaces WHERE workspace_id = 'ws-gone') AS apps`,
      )
      .get() as { members: number; apps: number };
    expect(live).toEqual({ members: 1, apps: 1 });
  });

  // row 6 — layers: mode switch × workspace lifecycle × route family. The
  //         `off` rows in tests/worker/dashboard-tenancy.test.ts pin the legacy
  //         face only for LIVE workspaces; this composes the soft-deleted
  //         workspace from row 5 with the switch, proving the mode decides
  //         whether workspace lifecycle gates an App at all — the same App is
  //         reachable on the legacy face under `off` and on neither face under
  //         `strict`.
  test("row 6 · off still serves an App whose workspace was soft-deleted; strict serves it on neither face", async () => {
    const { db } = matrixFixture();

    const off = envFor(db, "off");
    const offList = await worker.fetch(await request("/dashboard/api/apps", "octocat"), off);
    expect(offList.status).toBe(200);
    expect(((await offList.json()) as ListBody).apps.map((app) => app.slug)).toContain("gone-app");
    const offDetail = await worker.fetch(
      await request("/dashboard/apps/gone-app/onboarding", "octocat"),
      off,
    );
    expect(offDetail.status).toBe(200);

    const strict = envFor(db, "strict");
    const strictLegacy = await worker.fetch(
      await request("/dashboard/apps/gone-app/onboarding", "octocat"),
      strict,
    );
    expect(strictLegacy.status).toBe(404);
    for (const ref of ["gone", "ws-gone"]) {
      const strictWorkspace = await worker.fetch(
        await request(`/dashboard/${ref}/apps/gone-app/onboarding`, "dana"),
        strict,
      );
      expect(strictWorkspace.status, ref).toBe(404);
    }
  });

  // row 7 — NEW cell (workspace URL identifiers, 2026-10 — I-000059): the ref
  //         grammar. `ws-acme` is the row id and `acme` its slug, so both
  //         reach the SAME tenant — the layer that would silently answer 404
  //         for one of the two forms is this read.
  //         (Rows are numbered in file order; this cell was labelled "row 8"
  //         when it landed and sat between rows 5 and 7.)
  test("row 7 · a workspace answers on its id and on its slug, and every hidden ref form answers 404", async () => {
    const { db } = matrixFixture();
    const env = envFor(db, "strict");
    const list = async (ref: string) => {
      const res = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(200);
      return ((await res.json()) as ListBody).apps.map((app) => app.slug);
    };
    expect(await list("acme")).toEqual(await list("ws-acme"));
    expect(await list("acme")).toEqual(["acme-app"]);

    // Unknown and soft-deleted refs are the same invisibility, by either form.
    for (const ref of ["ghost", "gone", "ws-gone"]) {
      const res = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(404);
    }
  });

  // row 8 — layers: tenantModeOf (single resolver) → dashboard gate AND
  //         consumer creation. covered by tests/worker/dashboard-tenancy.test.ts
  //         (500) and tests/pipeline/consumer.test.ts (eager throw); composed
  //         here from ONE env value so the two faces cannot drift, and the
  //         consumer is proven to refuse before it touches the store.
  test("row 8 · an illegal mode answers 500 on every dashboard face and refuses the consumer before any write", async () => {
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
  // row 9 — layers: workspace gate operator classification → support_grants
  //         workspace-keyed lookup → route access declaration. covered at the
  //         unit level by tests/worker/operator-store.test.ts (`hasValidGrant`
  //         W1 vs W2) and per-route by tests/worker/operator-matrix.test.ts;
  //         composed here because a grant's SCOPE is the isolation question —
  //         the same operator, the same grant, two tenants of one fixture.
  test("row 9 · a support grant on one workspace opens that tenant only, on both ref forms", async () => {
    const { db } = matrixFixture();
    seedUser(db, "support-bot", "member");
    await insertSupportGrant(db, {
      workspaceId: "ws-acme",
      operatorLogin: "support-bot",
      reason: "tenant-reported incident",
      grantedBy: "deployer",
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const env = envFor(db, "strict", "support-bot");

    for (const ref of ["acme", "ws-acme"]) {
      const res = await worker.fetch(
        await request(`/dashboard/${ref}/api/support/workspace`, "support-bot"),
        env,
      );
      expect(res.status, ref).toBe(200);
    }

    for (const ref of ["other", "ws-other"]) {
      const res = await worker.fetch(
        await request(`/dashboard/${ref}/api/support/workspace`, "support-bot"),
        env,
      );
      expect(res.status, ref).toBe(404);
    }

    // The audit rows land on the workspace each request addressed: reads on
    // `acme`, denials on `other`. A scoped grant would show up here as a read
    // row on the sibling workspace.
    const rows = db.raw
      .query("SELECT workspace_id, action FROM audit_events")
      .all() as Array<{ workspace_id: string; action: string }>;
    expect(rows.filter((row) => row.workspace_id === "ws-acme").map((row) => row.action)).toEqual([
      "support.read",
      "support.read",
    ]);
    expect(rows.filter((row) => row.workspace_id === "ws-other").map((row) => row.action)).toEqual([
      "support.denied",
      "support.denied",
    ]);
  });
});
