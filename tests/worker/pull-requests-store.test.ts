/**
 * PR ledger store faces (migration 0039) — `upsertPullRequest`,
 * `listPullRequests`, `getPullRequest`.
 *
 * The fixture is the full migration set (the store helper walks
 * `migrations/`), so 0039 is the real DDL. Rows for `reviews`,
 * `review_failures`, `app_installations` and `review_findings` are seeded raw:
 * this file pins the READ shape (latest review, failure count, findings
 * projection), not the pipeline that writes those tables.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createAppsStore } from "../../src/dashboard/apps-store";

const APP_ID = "app-pr-ledger";

/** An App row + its workspace mapping (both reads join `app_workspaces`). */
function seedApp(db: TestD1, id = APP_ID, githubAppId = 2001): string {
  const now = "2026-01-01T00:00:00.000Z";
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(id, githubAppId, id, now, now);
  db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')").run(id);
  return id;
}

const PR = { appId: APP_ID, owner: "acme", repo: "widgets", prNumber: 131, title: "Add a thing", state: "open", headSha: "sha-1" };

describe("upsertPullRequest", () => {
  test("insert then re-delivery keeps ONE row on the (app, owner, repo, number) key", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ ...PR, headSha: "sha-2" });
    const rows = db.raw.prepare("SELECT * FROM pull_requests WHERE app_id = ?").all(APP_ID) as Array<{
      head_sha: string;
      title: string;
      state: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.head_sha).toBe("sha-2");
  });

  test("a second delivery advances last_seen_at and leaves first_seen_at alone", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    db.raw.prepare("UPDATE pull_requests SET first_seen_at = '2020-01-01 00:00:00', last_seen_at = '2020-01-01 00:00:00'").run();
    await createAppsStore(db).upsertPullRequest(PR);
    const row = db.raw
      .prepare("SELECT first_seen_at, last_seen_at FROM pull_requests WHERE app_id = ?")
      .get(APP_ID) as { first_seen_at: string; last_seen_at: string };
    expect(row.first_seen_at).toBe("2020-01-01 00:00:00");
    expect(row.last_seen_at).not.toBe("2020-01-01 00:00:00");
  });

  test("an omitted title / head_sha keeps the stored value; state always overwrites", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ appId: APP_ID, owner: "acme", repo: "widgets", prNumber: 131, state: "merged" });
    const row = db.raw
      .prepare("SELECT title, state, head_sha FROM pull_requests WHERE app_id = ?")
      .get(APP_ID) as { title: string; state: string; head_sha: string };
    expect(row.title).toBe("Add a thing");
    expect(row.head_sha).toBe("sha-1");
    expect(row.state).toBe("merged");
  });
});

describe("listPullRequests", () => {
  test("attaches the newest review, counts failures, and reads [] for a PR with neither", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ ...PR, prNumber: 132, title: "Second", headSha: "sha-b" });
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i1', ?, 77, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id, reviewed_at)
         VALUES ('r-old', 77, 'acme', 'widgets', 131, 'sha-0', 'comment', ?, '2026-01-01 00:00:00'),
                ('r-new', 77, 'acme', 'widgets', 131, 'sha-1', 'approve', ?, '2026-02-01 00:00:00')`,
      )
      .run(APP_ID, APP_ID);
    for (const id of ["f1", "f2"]) {
      db.raw
        .prepare(
          `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
           VALUES (?, 77, 'acme', 'widgets', 131, 'sha-1', 'runner', 'boom')`,
        )
        .run(id);
    }

    const rows = await createAppsStore(db).listPullRequests(APP_ID);
    expect(rows.length).toBe(2);
    const byNumber = new Map(rows.map((row) => [row.number, row]));
    expect(byNumber.get(131)!.latest_review).toEqual({ verdict: "approve", reviewed_at: "2026-02-01 00:00:00" });
    expect(byNumber.get(131)!.failure_count).toBe(2);
    expect(byNumber.get(132)!.latest_review).toBeNull();
    expect(byNumber.get(132)!.failure_count).toBe(0);
  });

  test("a sibling App's reviews and failures never leak into the list", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createAppsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i2', 'other-app', 88, 'acme', datetime('now'))")
      .run();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id)
         VALUES ('r-other', 88, 'acme', 'widgets', 131, 'sha-x', 'request-changes', 'other-app')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES ('f-other', 88, 'acme', 'widgets', 131, 'sha-x', 'runner', 'boom')`,
      )
      .run();

    const rows = await createAppsStore(db).listPullRequests(APP_ID);
    expect(rows.length).toBe(1);
    expect(rows[0]!.latest_review).toBeNull();
    expect(rows[0]!.failure_count).toBe(0);
  });

  test("is not N+1: three seeded PRs cost three statements, not one per row", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    for (const n of [1, 2, 3]) await createAppsStore(db).upsertPullRequest({ ...PR, prNumber: n });
    // Count prepared statements by wrapping the handle the store receives.
    let prepares = 0;
    const counted = {
      prepare(query: string) {
        prepares += 1;
        return db.prepare(query);
      },
      batch: db.batch.bind(db),
    };
    const rows = await createAppsStore(counted as never).listPullRequests(APP_ID);
    expect(rows.length).toBe(3);
    expect(prepares).toBe(3);
  });
});

describe("getPullRequest", () => {
  test("returns the row with reviews, failures and findings", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    db.raw
      .prepare("INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at) VALUES ('i3', ?, 99, 'acme', datetime('now'))")
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, model, provider, app_id)
         VALUES ('r1', 99, 'acme', 'widgets', 131, 'sha-1', 'approve', 'looks good', 'm1', 'p1', ?)`,
      )
      .run(APP_ID);
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES ('fx', 99, 'acme', 'widgets', 131, 'sha-1', 'sandbox', 'timeout')`,
      )
      .run();
    seedFinding(db, { findingId: "F-1", mergeClass: "must-fix", title: "Null deref", filePath: "src/a.ts", lineStart: 12, body: "guard it" });

    const detail = await createAppsStore(db).getPullRequest(APP_ID, "acme", "widgets", 131);
    expect(detail).not.toBeNull();
    expect(detail!.pull_request.latest_review).toEqual({ verdict: "approve", reviewed_at: expect.any(String) });
    expect(detail!.pull_request.failure_count).toBe(1);
    expect(detail!.reviews.length).toBe(1);
    expect(detail!.reviews[0]!.summary_md).toBe("looks good");
    expect(detail!.failures).toEqual([{ stage: "sandbox", error: "timeout", created_at: expect.any(String) }]);
    expect(detail!.findings).toEqual([
      { finding_id: "F-1", severity: "must-fix", title: "Null deref", file_path: "src/a.ts", line: 12, body: "guard it" },
    ]);
  });

  test("unknown PR number → null (the route's 404)", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    expect(await createAppsStore(db).getPullRequest(APP_ID, "acme", "widgets", 999)).toBeNull();
  });

  test("the same number in another repo of the SAME App → null, never a fallback", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    await createAppsStore(db).upsertPullRequest(PR);
    await createAppsStore(db).upsertPullRequest({ ...PR, repo: "gadgets", title: "Other repo's #131" });
    // Both rows exist under #131; asking for a repo that has none must miss
    // rather than answer with either of them.
    expect(await createAppsStore(db).getPullRequest(APP_ID, "acme", "sprockets", 131)).toBeNull();
    expect((await createAppsStore(db).getPullRequest(APP_ID, "acme", "gadgets", 131))!.pull_request.title).toBe(
      "Other repo's #131",
    );
  });

  test("a PR number that belongs to a sibling App → null", async () => {
    const db = createMigratedTestD1();
    seedApp(db);
    seedApp(db, "other-app", 2002);
    await createAppsStore(db).upsertPullRequest({ ...PR, appId: "other-app" });
    expect(await createAppsStore(db).getPullRequest(APP_ID, "acme", "widgets", 131)).toBeNull();
  });
});

/** One lifecycle finding row: `original_json` is the detail face's only source. */
function seedFinding(
  db: TestD1,
  finding: { findingId: string; mergeClass: string; title: string; filePath: string; lineStart: number; body: string },
): void {
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
       VALUES ('p1', ?, 99, 'acme', 'widgets', 131, 'sha-1', 'review', 'applied', '{}', 1, 1)`,
    )
    .run(APP_ID);
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms)
       VALUES ('row-1', ?, 99, 'acme', 'widgets', 131, ?, ?, 'p1', 'p1', 'sha-1', 'sha-1', 1, 1, 'open', 1, 1)`,
    )
    .run(
      APP_ID,
      finding.findingId,
      JSON.stringify({
        title: finding.title,
        body: finding.body,
        filePath: finding.filePath,
        lineStart: finding.lineStart,
        lineEnd: finding.lineStart,
        mergeClass: finding.mergeClass,
        category: null,
        fingerprintHint: null,
      }),
    );
}
