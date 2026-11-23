
import { describe, expect, test } from "bun:test";
import {
  GITHUB_PRIMARY_RATE_LIMIT_PREFIX,
  GITHUB_RATE_LIMIT_PREFIX,
} from "../../src/contracts/failure-stages";
import {
  ADMISSION_DROP_REASONS,
  createFailureStore,
  type AdmissionDropReason,
  type ReviewFailureInput,
} from "../../src/store/failure-store";
import { createMigratedTestD1, seedBot, seedTarget } from "./helpers";

const TARGET_ID = "target-failures";

const BASE = {
  target_id: TARGET_ID,
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
};

function createFailureDb() {
  const db = createMigratedTestD1();
  seedBot(db, "bot-failures", 9201);
  seedTarget(db, "bot-failures", { id: TARGET_ID });
  return db;
}

/** A row always carries a code and its sentence; the tests below vary only what they assert. */
function failureRow(stage: ReviewFailureInput["stage"], error: string): ReviewFailureInput {
  return {
    ...BASE,
    stage,
    code: "review.internal.unclassified",
    message: "the review did not complete",
    error,
  };
}

function dropError(reason: AdmissionDropReason): string {
  return `review dropped after 3 refused retries: ${reason} (system_cap 32, workspace_cap 4) — PR acme/widgets#42, head_sha ${BASE.head_sha}`;
}

describe("createFailureStore", () => {
  test("record persists every column; id is a uuid; created_at defaults to datetime('now')", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    await store.record(failureRow("parse", "not valid ReviewOutput JSON"));

    const rows = db.raw.query("SELECT * FROM review_failures").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...BASE,
      stage: "parse",
      error_code: "review.internal.unclassified",
      message: "the review did not complete",
      track_id: expect.any(String),
      error: "not valid ReviewOutput JSON",
    });
    expect(typeof rows[0]!.id).toBe("string");
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("record appends — per-attempt events share the five-tuple (no UNIQUE)", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    for (const attempt of [1, 2, 3]) {
      await store.record({
      ...BASE,
      stage: "runner",
      code: "review.internal.unclassified",
      message: "the review did not complete",
      error: `runner failed: exit ${attempt}` });
    }
    expect((await store.listRecent()).length).toBe(3);
  });

  test("record rejects an off-vocabulary stage BEFORE any row is written (producer-side enforcement)", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    await expect(store.record({ ...failureRow("parse", "boom"), stage: "not-a-stage" as never })).rejects.toThrow(
      /not on the producer vocabulary/,
    );
    expect((await store.listRecent()).length).toBe(0);
  });

  test("listRecent returns newest-first with a rowid tiebreak, bounded by limit", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    const ids: string[] = [];
    for (const stage of ["parse", "runner", "sandbox", "pipeline"] as const) {
      await store.record(failureRow(stage, `boom-${stage}`));
    }
    ids.push(...(db.raw.query("SELECT id FROM review_failures ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id));

    const recent = await store.listRecent(3);
    expect(recent.map((row) => row.id)).toEqual([ids[3]!, ids[2]!, ids[1]!]);
    expect((await store.listRecent()).length).toBe(4);
    expect(recent[0]!.stage).toBe("pipeline");
  });

  test("countAdmissionDrops24h reads every reason at zero on an empty log", async () => {
    const store = createFailureStore(createFailureDb());
    expect(await store.countAdmissionDrops24h()).toEqual({
      "pr-held": 0,
      "system-cap": 0,
      "workspace-cap": 0,
      error: 0,
    });
  });

  test("countAdmissionDrops24h groups the terminal drops by reason over the trailing 24h", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    for (const reason of ["pr-held", "system-cap", "workspace-cap"] as const) {
      await store.record(failureRow("pipeline", dropError(reason)));
    }
    await store.record(failureRow("pipeline", dropError("error")));
    await store.record(failureRow("pipeline", "comment post failed"));
    await store.record(failureRow("sandbox", dropError("system-cap")));
    await store.record(
      failureRow(
        "pipeline",
        "review dropped after 3 refused retries: not-a-reason (system_cap 0, workspace_cap 0)",
      ),
    );
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-25 hours'))`,
      )
      .run(
        crypto.randomUUID(),
        BASE.installation_id,
        BASE.owner,
        BASE.repo,
        BASE.pr_number,
        BASE.head_sha,
        "pipeline",
        dropError("system-cap"),
      );

    expect(await store.countAdmissionDrops24h()).toEqual({
      "pr-held": 1,
      "system-cap": 1,
      "workspace-cap": 1,
      error: 1,
    });
    expect(ADMISSION_DROP_REASONS).toEqual(["pr-held", "system-cap", "workspace-cap", "error"]);
  });

  test("countGithubRateLimited24h counts only the secondary prefix inside the trailing 24h", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    await store.record({
      ...BASE,
      stage: "pipeline",
      code: "review.internal.unclassified",
      message: "the review did not complete",
      error: `${GITHUB_RATE_LIMIT_PREFIX}secondary limit on comment update` });
    await store.record({
      ...BASE,
      stage: "pipeline",
      code: "review.internal.unclassified",
      message: "the review did not complete",
      error: `${GITHUB_RATE_LIMIT_PREFIX}secondary limit on check update` });
    await store.record(failureRow("rate-limit", `${GITHUB_RATE_LIMIT_PREFIX}secondary limit on delete sweep`));
    const matchesOnly = await store.countGithubRateLimited24h();
    expect(matchesOnly).toBe(3);

    await store.record({
      ...BASE,
      stage: "pipeline",
      code: "review.internal.unclassified",
      message: "the review did not complete",
      error: `${GITHUB_PRIMARY_RATE_LIMIT_PREFIX}primary limit on comment update` });
    await store.record(failureRow("pipeline", "comment post failed"));
    const oldRow = db.raw.prepare(
      `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    );
    for (const age of ["-25 hours", "-48 hours"]) {
      oldRow.run(
        crypto.randomUUID(),
        BASE.installation_id,
        BASE.owner,
        BASE.repo,
        BASE.pr_number,
        BASE.head_sha,
        "pipeline",
        `${GITHUB_RATE_LIMIT_PREFIX}secondary limit on comment update`,
        age,
      );
    }

    expect(await store.countGithubRateLimited24h()).toBe(matchesOnly);
  });

  test("the trailing-24h pipeline read is served by its partial window index (0048)", () => {
    const db = createFailureDb();
    const exists = db.raw
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_failures_pipeline_created'")
      .get();
    expect(exists).not.toBeNull();
    const plan = (
      db.raw
        .query(
          `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM review_failures
             WHERE stage = 'pipeline' AND created_at > datetime('now', '-24 hours')`,
        )
        .all() as Array<{ detail: string }>
    ).map((row) => row.detail);
    // The invariant: this read is served by THAT index, not by a table scan.
    expect(plan.join("\n")).toContain("idx_review_failures_pipeline_created");
  });
});

describe("review_failures error_code / track_id (0104)", () => {
  test("record persists the code and the attempt's track id", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    await store.record({
      ...BASE,
      stage: "runner",
      code: "review.budget.runner_spent",
      trackId: "attempt-7",
      message: "the review used its whole time budget",
      error: "summary\nmechanism detail",
    });
    const row = db.raw.query("SELECT error_code, track_id, error FROM review_failures").get();
    expect(row).toEqual({
      error_code: "review.budget.runner_spent",
      track_id: "attempt-7",
      error: "summary\nmechanism detail",
    });
  });

  test("a row keyed by its own id is its own track id", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    await store.record({ ...failureRow("parse", "boom"), id: "attempt-9:parse" });
    expect(db.raw.query("SELECT id, track_id FROM review_failures").get()).toEqual({
      id: "attempt-9:parse",
      track_id: "attempt-9:parse",
    });

    // No identity: the generated row id becomes the track id.
    await store.record(failureRow("pipeline", "no identity"));
    const generated = db.raw
      .query("SELECT id, error_code, track_id FROM review_failures WHERE id <> 'attempt-9:parse'")
      .get() as { id: string; error_code: string | null; track_id: string };
    expect(generated.error_code).toBe("review.internal.unclassified");
    expect(generated.track_id).toBe(generated.id);
  });

  test("the settlement statement writes both columns too (replay-safe insert)", async () => {
    const db = createFailureDb();
    const { settlementFailureRowStatement } = await import("../../src/store/failure-store");
    await settlementFailureRowStatement(
      db,
      {
        ...BASE,
        stage: "pipeline",
        code: "review.internal.unclassified",
        trackId: "attempt-settled",
        message: "the review did not complete",
      error: "summary\ndetail",
      },
      "attempt-settled",
    ).run();
    const row = db.raw.query("SELECT error_code, track_id FROM review_failures").get();
    expect(row).toEqual({ error_code: "review.internal.unclassified", track_id: "attempt-settled" });
  });

  test("0104 indexes (error_code, created_at) and both columns are nullable", async () => {
    const db = createFailureDb();
    const columns = (db.raw.query("PRAGMA index_info(idx_review_failures_code_created)").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(columns).toEqual(["error_code", "created_at"]);
    const declared = db.raw.query("PRAGMA table_info(review_failures)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    for (const name of ["error_code", "track_id"]) {
      expect(declared.find((column) => column.name === name)).toMatchObject({ notnull: 0 });
    }
  });

  test("a historical row (code NULL) is still returned, unchanged, by listRecent and the detail read", async () => {
    const db = createFailureDb();
    const store = createFailureStore(db);
    // Written by a build before 0104: no code, no message, no track id.
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-1", BASE.target_id, BASE.installation_id, BASE.owner, BASE.repo, BASE.pr_number, BASE.head_sha, "sandbox", "the old mechanism text");
    const recent = await store.listRecent();
    expect(recent[0]).toMatchObject({
      stage: "sandbox",
      error: "the old mechanism text",
      error_code: null,
      message: null,
      track_id: null,
    });
  });
});
