/**
 * GET /api/apps/:appId/pull-requests,
 * GET /api/apps/:appId/pull-requests/:owner/:repo/:number and its three
 * `findings` / `reviews` / `failures` section reads — the App-scoped PR ledger
 * faces (migration 0039).
 *
 * Both ride the SAME gate ladder as every other App JSON read: membership →
 * App-id resolution (unknown / soft-deleted / CROSS-WORKSPACE all collapse into
 * the one `unknown app` 404) → the workspace owner/admin role. The head answers
 * `{ pull_request, counts, latest_review }`; each section answers one page plus
 * its total. A
 * tuple this App never received is a 404 on every path — the address is the
 * ledger's own key, so a same-number PR in another repo is a miss, never a
 * fallback. Bad paging is a 400, never a silent default — but a well-formed
 * `limit` outside `[1, 50]` is clamped into it rather than rejected.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { parsePullRequestDetail } from "../../src/spa/pages/data";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** Each fixture App gets its own numeric GitHub id (the App's only address). */
const ACME_APP_ID = 3001;
const OTHER_APP_ID = 3002;

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as unknown as Env;
}

async function seedApp(
  db: TestD1,
  opts: { id: string; githubAppId: number; workspaceId: string; slug: string },
): Promise<void> {
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(opts.id, opts.slug, opts.githubAppId, opts.slug, now, now);
  db.raw
    .prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)")
    .run(opts.id, opts.workspaceId);
}

/**
 * Two workspaces, one App each. `octocat` owns `acme` and belongs to nothing in
 * `other`, so the cross-workspace denial is real membership, not a missing row.
 */
async function fixture(): Promise<TestD1> {
  const db = createMigratedTestD1();
  const now = new Date().toISOString();
  const workspaces: Array<[string, string]> = [
    ["ws-acme", "acme"],
    ["ws-other", "other"],
  ];
  for (const [id, slug] of workspaces) {
    db.raw
      .prepare(
        "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
      )
      .run(id, slug, slug, now);
  }
  const octocat = await createUser(db, { login: "octocat", role: "member" });
  db.raw
    .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws-acme', ?, 'owner', ?)")
    .run(octocat.id, now);
  await seedApp(db, { id: "app-acme", githubAppId: ACME_APP_ID, workspaceId: "ws-acme", slug: "acme-app" });
  await seedApp(db, { id: "app-other", githubAppId: OTHER_APP_ID, workspaceId: "ws-other", slug: "other-app" });
  await createAppsStore(db).upsertPullRequest({
    appId: "app-acme",
    owner: "acme",
    repo: "widgets",
    prNumber: 131,
    title: "Add a thing",
    state: "open",
    headSha: "sha-1",
  });
  return db;
}

async function getFace(path: string, db: TestD1, login = "octocat"): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
    }),
    envFor(db),
  );
}

describe("GET /api/apps/:appId/pull-requests", () => {
  test("a PR with null title / head_sha still appears, with empty strings", async () => {
    const db = await fixture();
    // The payload for a sparse delivery omits both (migration 0039 keeps them
    // nullable). One such row must not blank the whole list.
    await createAppsStore(db).upsertPullRequest({
      appId: "app-acme",
      owner: "acme",
      repo: "widgets",
      prNumber: 132,
      state: "open",
    });
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests`, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pull_requests: Array<Record<string, unknown>> };
    const sparse = body.pull_requests.find((row) => row.number === 132);
    expect(sparse).toMatchObject({ title: "", head_sha: "" });
  });

  test("an unknown state is clamped to 'open'", async () => {
    const db = await fixture();
    db.raw
      .prepare("UPDATE pull_requests SET state = 'draft-ish' WHERE app_id = 'app-acme' AND pr_number = 131")
      .run();
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests`, db);
    const body = (await res.json()) as { pull_requests: Array<Record<string, unknown>> };
    expect(body.pull_requests[0]!.state).toBe("open");
  });

  test("lists this App's PRs with the contract row shape", async () => {
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests`, await fixture());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pull_requests: Array<Record<string, unknown>> };
    expect(body.pull_requests.length).toBe(1);
    expect(body.pull_requests[0]).toMatchObject({
      number: 131,
      owner: "acme",
      repo: "widgets",
      title: "Add a thing",
      state: "open",
      head_sha: "sha-1",
      latest_review: null,
      failure_count: 0,
    });
  });

  test("an App from another workspace answers the same 404 as an unknown one", async () => {
    const db = await fixture();
    // `octocat` owns acme; app-other lives in ws-other. Addressing it under the
    // acme workspace ref must not resolve, and the body must not name it.
    const cross = await getFace(`/dashboard/acme/api/apps/${OTHER_APP_ID}/pull-requests`, db);
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual({ error: "unknown app" });
  });

  test("without a session → 302 to login", async () => {
    const res = await worker.fetch(
      new Request(`https://worker.local/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests`),
      envFor(await fixture()),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

const detailPath = `/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/acme/widgets/131`;
const sectionPath = (section: "findings" | "reviews" | "failures") => `${detailPath}/${section}`;

/** The installation the failure join reads (one App, one installation). */
function seedInstallation(db: TestD1): void {
  db.raw
    .prepare(
      "INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i1', 'app-acme', 77, 'acme', datetime('now'))",
    )
    .run();
}

/** `count` reviews for #131, oldest first, so the store's newest-first order is observable. */
function seedReviews(db: TestD1, count: number): void {
  for (let index = 0; index < count; index += 1) {
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, reviewed_at, app_id)
         VALUES (?, 77, 'acme', 'widgets', 131, ?, 'comment', ?, 'app-acme')`,
      )
      .run(`r-${index}`, `sha-${index}`, `2026-01-${String(index + 1).padStart(2, "0")} 00:00:00`);
  }
}

function seedFailure(db: TestD1, id = "fx-1"): void {
  db.raw
    .prepare(
      `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
       VALUES (?, 77, 'acme', 'widgets', 131, 'sha-1', 'sandbox', 'timeout')`,
    )
    .run(id);
}

/** Lifecycle findings: one publication, one row per entry. */
function seedFindings(
  db: TestD1,
  entries: Array<{ id: string; findingId: string; mergeClass: string; filePath: string | null; lineStart: number | null }>,
): void {
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
       VALUES ('p1', 'app-acme', 77, 'acme', 'widgets', 131, 'sha-1', 'review', 'applied', '{}', 1, 1)`,
    )
    .run();
  for (const entry of entries) {
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES (?, 'app-acme', 77, 'acme', 'widgets', 131, ?, ?, 'p1', 'p1', 'sha-1', 'sha-1', 1, 1, 'open', 1, 1)`,
      )
      .run(
        entry.id,
        entry.findingId,
        JSON.stringify({
          title: `Finding ${entry.findingId}`,
          body: "",
          filePath: entry.filePath,
          lineStart: entry.lineStart,
          lineEnd: entry.lineStart,
          mergeClass: entry.mergeClass,
          category: null,
          fingerprintHint: null,
        }),
      );
  }
}

describe("GET /api/apps/:appId/pull-requests/:owner/:repo/:number", () => {
  test("a review with NULL provider / model / summary round-trips as empty strings", async () => {
    const db = await fixture();
    // The v1 pipeline always writes reviews.provider NULL (the artifact store
    // persists the payload's null), and a degraded run may omit model /
    // summary. The whole detail panel must still parse.
    seedInstallation(db);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, model, provider, app_id)
         VALUES ('r-null', 77, 'acme', 'widgets', 131, 'sha-1', 'comment', NULL, NULL, NULL, 'app-acme')`,
      )
      .run();

    // The head's counts are the review count; the row itself rides the page.
    const head = (await (await getFace(detailPath, db)).json()) as { counts: { reviews: number } };
    expect(head.counts.reviews).toBe(1);

    const res = await getFace(sectionPath("reviews"), db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ verdict: "comment", summary_md: "", model: "", provider: "" });
  });

  test("a repo-wide finding (null file_path) round-trips as ''", async () => {
    const db = await fixture();
    seedInstallation(db);
    seedFindings(db, [{ id: "row-1", findingId: "F-1", mergeClass: "nit", filePath: null, lineStart: null }]);

    const res = await getFace(sectionPath("findings"), db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ finding_id: "F-1", file_path: "", line: null });
  });

  test("returns the head row and its counts only — no record arrays", async () => {
    const db = await fixture();
    seedInstallation(db);
    seedReviews(db, 2);
    seedFailure(db);
    seedFindings(db, [
      { id: "row-1", findingId: "F-1", mergeClass: "must-fix", filePath: "src/a.ts", lineStart: 3 },
      { id: "row-2", findingId: "F-2", mergeClass: "nit", filePath: null, lineStart: null },
    ]);

    const res = await getFace(detailPath, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pull_request: Record<string, unknown>;
      counts: Record<string, number>;
      latest_review: Record<string, unknown> | null;
    };
    // The newest review rides the ENVELOPE, beside `counts`: the head row's
    // shape is the list's row shape, and the header's verdict/attribution
    // source outlives any paged reviews list.
    expect(Object.keys(body).sort()).toEqual(["counts", "latest_review", "pull_request"]);
    expect(body.pull_request).toMatchObject({
      number: 131,
      owner: "acme",
      repo: "widgets",
      failure_count: 1,
    });
    expect(body.pull_request).not.toHaveProperty("latest_review");
    expect(body.latest_review).toEqual({
      verdict: "comment",
      summary_md: "",
      model: "",
      provider: "",
      reviewed_at: "2026-01-02 00:00:00",
      head_sha: "sha-1",
    });
    expect(body.counts).toEqual({ findings: 2, reviews: 2, failures: 1, must_fix: 1 });
  });

  test("the SPA parser reads this route's own body: the headline keeps its model and provider", async () => {
    // Cross-boundary: the real route body through the real parser. A field
    // moved to the other end of the envelope re-drifting fails HERE, not only
    // in a component test that feeds a hand-built payload.
    const db = await fixture();
    seedInstallation(db);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, model, provider, reviewed_at, app_id)
         VALUES ('r-attributed', 77, 'acme', 'widgets', 131, 'sha-1', 'needs fixes', 'The race is reachable.', 'kimi-for-coding', 'openrouter', '2026-01-02 00:00:00', 'app-acme')`,
      )
      .run();

    const res = await getFace(detailPath, db);
    expect(res.status).toBe(200);
    const parsed = parsePullRequestDetail(await res.json());
    expect(parsed).not.toBeNull();
    expect(parsed?.latest_review).toEqual({
      verdict: "needs fixes",
      summary_md: "The race is reachable.",
      model: "kimi-for-coding",
      provider: "openrouter",
      reviewed_at: "2026-01-02 00:00:00",
      head_sha: "sha-1",
    });
    // The head row's own nullable slot stays empty (the wire no longer fills
    // it): the review reaches the header only through the envelope, so the two
    // ends provably agree on WHERE.
    expect(parsed?.pull_request.latest_review).toBeNull();
  });

  test("each section pages with limit and offset, and defaults to 10 rows", async () => {
    const db = await fixture();
    seedInstallation(db);
    seedReviews(db, 12);
    // No paging params: the server's default limit is 10.
    const first = (await (await getFace(sectionPath("reviews"), db)).json()) as {
      items: Array<{ reviewed_at: string }>;
      total: number;
    };
    expect(first.total).toBe(12);
    expect(first.items).toHaveLength(10);
    expect(first.items[0]?.reviewed_at).toBe("2026-01-12 00:00:00");

    const paged = (await (await getFace(`${sectionPath("reviews")}?limit=2&offset=2`, db)).json()) as {
      items: Array<{ reviewed_at: string }>;
      total: number;
    };
    expect(paged.total).toBe(12);
    expect(paged.items.map((item) => item.reviewed_at)).toEqual([
      "2026-01-10 00:00:00",
      "2026-01-09 00:00:00",
    ]);
  });

  test("findings severity filters exactly and returns the filtered total", async () => {
    const db = await fixture();
    seedInstallation(db);
    seedFindings(db, [
      { id: "row-1", findingId: "F-1", mergeClass: "must-fix", filePath: "src/a.ts", lineStart: 3 },
      { id: "row-2", findingId: "F-2", mergeClass: "nit", filePath: null, lineStart: null },
    ]);
    const all = (await (await getFace(sectionPath("findings"), db)).json()) as { total: number };
    expect(all.total).toBe(2);

    const filtered = (await (
      await getFace(`${sectionPath("findings")}?severity=must-fix`, db)
    ).json()) as { items: Array<{ finding_id: string }>; total: number };
    expect(filtered.total).toBe(1);
    expect(filtered.items.map((item) => item.finding_id)).toEqual(["F-1"]);

    // An empty severity is no filter; an unmatched one is an empty page.
    const noFilter = (await (await getFace(`${sectionPath("findings")}?severity=`, db)).json()) as {
      total: number;
    };
    expect(noFilter.total).toBe(2);
    const unmatched = (await (await getFace(`${sectionPath("findings")}?severity=blocker`, db)).json()) as {
      items: unknown[];
      total: number;
    };
    expect(unmatched).toEqual({ items: [], total: 0 });
  });

  test("malformed paging is a 400 on every section", async () => {
    const db = await fixture();
    seedInstallation(db);
    for (const section of ["findings", "reviews", "failures"] as const) {
      for (const query of ["limit=abc", "limit=", "limit=1e3", "limit=-1", "offset=-1", "offset=1.5"]) {
        const res = await getFace(`${sectionPath(section)}?${query}`, db);
        expect(res.status, `${section}?${query}`).toBe(400);
      }
    }
  });

  test("an offset past the documented maximum is a 400, not a scan", async () => {
    const db = await fixture();
    seedInstallation(db);
    seedReviews(db, 12);
    // 100000 is the last accepted offset (RECORD_PAGE_OFFSET_MAX); one past it
    // is a window no PR history can reach, so it is malformed paging, not a
    // page that walks and discards the whole family before answering empty.
    const atMax = await getFace(`${sectionPath("reviews")}?offset=100000`, db);
    expect(atMax.status).toBe(200);
    const atMaxPage = (await atMax.json()) as { items: unknown[] };
    expect(atMaxPage.items).toEqual([]);
    const past = await getFace(`${sectionPath("reviews")}?offset=100001`, db);
    expect(past.status).toBe(400);
    expect(await past.json()).toEqual({ error: "invalid paging" });
  });

  test("an out-of-bounds limit is clamped into [1, 50], not rejected", async () => {
    const db = await fixture();
    seedInstallation(db);
    // More than the maximum page size, so the ceiling is observable: accepting
    // or ignoring a limit of 51 would answer with 51 rows.
    seedReviews(db, 51);
    // limit=0 clamps up to 1: a one-row page, not a 400.
    const floorLimit = await getFace(`${sectionPath("reviews")}?limit=0`, db);
    expect(floorLimit.status).toBe(200);
    const floored = (await floorLimit.json()) as { items: unknown[]; total: number };
    expect(floored.items).toHaveLength(1);
    expect(floored.total).toBe(51);

    // limit=51 clamps down to 50: one full maximum page, and the total stays the
    // unpaged count of the whole corpus.
    const ceilingLimit = await getFace(`${sectionPath("reviews")}?limit=51`, db);
    expect(ceilingLimit.status).toBe(200);
    const ceilinged = (await ceilingLimit.json()) as { items: unknown[]; total: number };
    expect(ceilinged.items).toHaveLength(50);
    expect(ceilinged.total).toBe(51);
  });

  test("an unknown PR number → 404", async () => {
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/acme/widgets/999`, await fixture());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown pull request" });
  });

  test("an unknown PR is a 404 on every section path", async () => {
    for (const section of ["findings", "reviews", "failures"] as const) {
      const res = await getFace(
        `/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/acme/widgets/999/${section}`,
        await fixture(),
      );
      expect(res.status, section).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown pull request" });
    }
  });

  test("the number in a repo this App never received → 404, no same-number fallback", async () => {
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/acme/gadgets/131`, await fixture());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown pull request" });
  });

  test("a non-numeric number is the same 404 (no number-spelling alias)", async () => {
    for (const number of ["0x1f", "1e3", "1.5"]) {
      const res = await getFace(
        `/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/acme/widgets/${number}`,
        await fixture(),
      );
      expect(res.status, number).toBe(404);
    }
  });

  test("a cross-workspace App → 404 before the PR lookup", async () => {
    const res = await getFace(
      `/dashboard/acme/api/apps/${OTHER_APP_ID}/pull-requests/acme/widgets/131`,
      await fixture(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown app" });
  });
});
