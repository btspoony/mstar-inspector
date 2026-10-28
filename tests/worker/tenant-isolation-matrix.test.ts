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
 *   4. orphan App — absent from every workspace list, indistinguishable from an
 *      unknown App id on its detail route.
 *      covered by tests/store/tenant-read-face.test.ts (store-level invisibility)
 *   5. soft-deleted workspace — its slug answers 404.
 *      NEW cell (no task-level owner): the `workspaces.deleted_at` filter.
 *   6. soft-deleted workspace × App lifecycle — an App whose workspace was
 *      retired is unreachable on the one route family.
 *   7. workspace ref grammar — the same workspace answers on its id and on its
 *      slug; every hidden ref form answers 404.
 *      NEW cell (workspace URL identifiers, 2026-10 — I-000059).
 *
 * Every cross-workspace cell (rows 1, 2, 4, 5, 6, 7) runs through BOTH address
 * forms — the workspace slug and the generated id — because the segment is
 * resolvable either way and a scoping rule that held for one form only would
 * not be isolation. The App segment itself is now GitHub's numeric App id
 * (D0): there is exactly one App address form, and a non-numeric segment is
 * just as invisible as an App belonging to another workspace.
 *
 * The consumer's own orphan/off read face is deliberately NOT re-driven here:
 * its fixture builder (encrypted PEM + per-App AI config) is file-private, and
 * copying it is the STOP condition in the task brief. That cell stays owned by
 * tests/pipeline/consumer.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { insertSupportGrant } from "../../src/dashboard/operator-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

// Dynamic AFTER the shim: the static import order would resolve the workerd
// builtin before mock.module had a chance to register it.
const { default: worker } = await import("../../src/worker/index");

const SESSION_SECRET = ["test", "matrix", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function envFor(db: TestD1, operators?: string): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
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

/** Fixture Apps are addressed by these GitHub App ids (the only App identity). */
const ACME_APP_ID = 5001;
const OTHER_APP_ID = 5002;
const ORPHAN_APP_ID = 5003;
const GONE_APP_ID = 5004;

/** An App row plus its single workspace mapping (migration 0026 production shape). */
function seedApp(
  db: TestD1,
  id: string,
  slug: string,
  workspaceId: string | null,
  githubAppId: number,
): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
       (id, webhook_path, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'octocat', 'active', ?, ?)`,
    id,
    slug,
    slug,
    githubAppId,
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
  seedApp(db, "app-acme", "acme-app", "ws-acme", ACME_APP_ID);
  seedApp(db, "app-other", "other-app", "ws-other", OTHER_APP_ID);
  seedApp(db, "app-orphan", "orphan-app", null, ORPHAN_APP_ID);
  seedApp(db, "app-gone", "gone-app", "ws-gone", GONE_APP_ID);
  return { db, users };
}

type ListBody = { viewer: { login: string }; apps: Array<{ github_app_id: number; github_slug: string | null }> };

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
  { route: `/apps/${ACME_APP_ID}/disable`, ownerStatus: 200 },
  { route: `/apps/${ACME_APP_ID}/enable`, ownerStatus: 200 },
  { route: `/apps/${ACME_APP_ID}/pause`, ownerStatus: 200 },
  { route: `/apps/${ACME_APP_ID}/resume`, ownerStatus: 200 },
  { route: `/apps/${ACME_APP_ID}/review-trigger-mode`, body: "mode=open", ownerStatus: 200 },
  { route: `/apps/${ACME_APP_ID}/settings`, body: "op=save-chain&model_chain=", ownerStatus: 200 },
  {
    route: `/apps/${ACME_APP_ID}/settings`,
    body: "op=save-sandbox-image&sandbox_image_id=omp",
    ownerStatus: 200,
  },
  {
    route: `/apps/${ACME_APP_ID}/settings/key/delete`,
    body: "provider=anthropic&key_id=seeded-key",
    ownerStatus: 200,
  },
  // No positive control: a real 200 here needs a live provider endpoint (the
  // route verifies with globalThis.fetch). The member-403 cell below still
  // proves the authorization decision; the success path is owned by
  // tests/worker/settings-provider-first.test.ts.
  { route: `/api/apps/${ACME_APP_ID}/keys/verify`, body: "provider=anthropic&key=sk-not-a-real-key" },
  // Last: a manager's success soft-deletes the row.
  { route: `/apps/${ACME_APP_ID}/delete`, ownerStatus: 200 },
];

describe("tenant isolation matrix (scenario × layer)", () => {
  // row 1 — layers: route family gate → membership gate → scoped App resolve
  //         → strict store read. covered by tests/worker/dashboard-tenancy.test.ts
  //         (cross-workspace 404); composed here on a manager of BOTH tenants,
  //         so the 404 can only come from the App↔workspace check. Both
  //         tenants are addressed on both workspace ref forms — a scoping rule
  //         holding for one form only would not be isolation.
  test("row 1 · cross-workspace App serves only inside its own workspace, 404 in the sibling — on both ref forms", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    for (const [ownRefs, ownApp, siblingRefs] of [
      [["acme", "ws-acme"], ACME_APP_ID, ["other", "ws-other"]],
      [["other", "ws-other"], OTHER_APP_ID, ["acme", "ws-acme"]],
    ] as const) {
      for (const own of ownRefs) {
        const served = await worker.fetch(
          await request(`/dashboard/${own}/apps/${ownApp}/onboarding`, "dana"),
          env,
        );
        expect(served.status, `${own}/${ownApp}`).toBe(200);
      }

      for (const sibling of siblingRefs) {
        const crossed = await worker.fetch(
          await request(`/dashboard/${sibling}/apps/${ownApp}/onboarding`, "dana"),
          env,
        );
        expect(crossed.status, `${sibling}/${ownApp}`).toBe(404);
      }
    }
  });

  // row 2 — layers: routing gate (workspace exists) + membership gate (role row).
  //         covered by tests/worker/dashboard-tenancy.test.ts (no-membership 404);
  //         composed here over BOTH faces of the tenant (list + detail) so the
  //         absence of a membership row cannot leak as 403 on either.
  test("row 2 · a signed-in non-member gets 404 — never 403 — on the list and the detail face, on both ref forms", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    for (const ref of ["acme", "ws-acme"]) {
      const list = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "bob"), env);
      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${ACME_APP_ID}/onboarding`, "bob"),
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
    const env = envFor(db);
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
    expect(body.apps.map((app) => app.github_app_id)).toContain(ACME_APP_ID);

    const onboarding = await worker.fetch(
      await request(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "mallory"),
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

  // row 4 — layers: the INNER JOIN read face → workspace list route → detail
  //         resolve. covered by tests/store/tenant-read-face.test.ts at the
  //         store level; composed here through the HTTP faces.
  test("row 4 · an orphan App is absent from every workspace list, on both ref forms", async () => {
    const { db } = matrixFixture();

    for (const ref of ["acme", "ws-acme"]) {
      const list = await worker.fetch(
        await request(`/dashboard/${ref}/api/apps`, "dana"),
        envFor(db),
      );
      expect(list.status, ref).toBe(200);
      const appIds = ((await list.json()) as ListBody).apps.map((app) => app.github_app_id);
      expect(appIds, ref).toContain(ACME_APP_ID);
      expect(appIds, ref).not.toContain(ORPHAN_APP_ID);

      // The detail agrees: the same unmapped row is indistinguishable from an
      // unknown App id (no workspace can claim it).
      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${ORPHAN_APP_ID}/onboarding`, "dana"),
        envFor(db),
      );
      expect(detail.status, ref).toBe(404);
    }
  });

  // row 5 — NEW cell (no task-level owner): layers: route classification →
  //         getWorkspaceByRef `deleted_at IS NULL` (after the session/user
  //         read) → scoped read. The tenant has a live membership row and a
  //         mapped App, so only the soft-delete filter can produce the 404.
  test("row 5 · a soft-deleted workspace answers 404 under strict on both ref forms despite membership and a mapped App", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    for (const ref of ["gone", "ws-gone"]) {
      const list = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(list.status, ref).toBe(404);

      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${GONE_APP_ID}/onboarding`, "dana"),
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

  // row 6 — layers: workspace lifecycle × App lifecycle × route family. Row 5
  //         pins the ref itself; this composes it with the App resolve, proving
  //         a retired workspace takes its Apps with it on the one route family.
  test("row 6 · a retired workspace serves none of its Apps", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    const legacy = await worker.fetch(
      await request(`/dashboard/apps/${GONE_APP_ID}/onboarding`, "octocat"),
      env,
    );
    expect(legacy.status).toBe(404);
    for (const ref of ["gone", "ws-gone"]) {
      const scoped = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${GONE_APP_ID}/onboarding`, "dana"),
        env,
      );
      expect(scoped.status, ref).toBe(404);
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
    const env = envFor(db);
    const list = async (ref: string) => {
      const res = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(200);
      return ((await res.json()) as ListBody).apps.map((app) => app.github_app_id);
    };
    expect(await list("acme")).toEqual(await list("ws-acme"));
    expect(await list("acme")).toEqual([ACME_APP_ID]);

    // Unknown and soft-deleted refs are the same invisibility, by either form.
    for (const ref of ["ghost", "gone", "ws-gone"]) {
      const res = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(404);
    }
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
    const env = envFor(db, "support-bot");

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
