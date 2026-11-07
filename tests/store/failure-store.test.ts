/**
 * Failure-store tests (architect AL-1 + AL-6) — the
 * `review_failures` leaf (src/store/failure-store.ts) over the REAL
 * migration DDL (bun:sqlite D1 double, tests/store/helpers.ts).
 *
 * The store is an append-only event log: record (create) + listRecent
 * (read) are the only faces — update/delete do not exist by design
 * (audit-log semantics: the sweep counts rows, it never mutates
 * them). The best-effort contract lives at the consumer call sites; the
 * store itself fails loud.
 */

import { describe, expect, test } from "bun:test";
import {
  GITHUB_PRIMARY_RATE_LIMIT_PREFIX,
  GITHUB_RATE_LIMIT_PREFIX,
} from "../../src/contracts/failure-stages";
import {
  ADMISSION_DROP_REASONS,
  createFailureStore,
  type AdmissionDropReason,
} from "../../src/store/failure-store";
import { createMigratedTestD1 } from "./helpers";

const BASE = {
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
};

/**
 * The `review_failures.error` shape a terminal admission drop carries
 * (`handleGuardHeld`, src/pipeline/consumer.ts), with an arbitrary retry count
 * and cap pair — these tests own the reader's grouping. The producer→reader
 * contract is pinned by the consumer test, which feeds the REAL writer row
 * through `countAdmissionDrops24h()` over the same database.
 */
function dropError(reason: AdmissionDropReason): string {
  return `review dropped after 3 refused retries: ${reason} (system_cap 32, workspace_cap 4) — PR acme/widgets#42, head_sha ${BASE.head_sha}`;
}

describe("createFailureStore", () => {
  test("record persists every column; id is a uuid; created_at defaults to datetime('now')", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    await store.record({ ...BASE, stage: "parse", error: "not valid ReviewOutput JSON" });

    const rows = db.raw.query("SELECT * FROM review_failures").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...BASE,
      stage: "parse",
      error: "not valid ReviewOutput JSON",
    });
    expect(typeof rows[0]!.id).toBe("string");
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // BUG-03 created_at contract: `record` NEVER writes created_at — the
    // column is ALWAYS the DDL DEFAULT `datetime('now')` (migration 0010),
    // i.e. the `YYYY-MM-DD HH:MM:SS` UTC format the sweep's TEXT window
    // comparison depends on. A producer writing ISO-8601/epoch would
    // silently break the sweep — this pin is the guard.
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("record appends — per-attempt events share the five-tuple (no UNIQUE)", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    for (const attempt of [1, 2, 3]) {
      await store.record({ ...BASE, stage: "runner", error: `runner failed: exit ${attempt}` });
    }
    expect((await store.listRecent()).length).toBe(3);
  });

  test("record rejects an off-vocabulary stage BEFORE any row is written (producer-side enforcement)", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    await expect(store.record({ ...BASE, stage: "not-a-stage" as never, error: "boom" })).rejects.toThrow(
      /not on the producer vocabulary/,
    );
    expect((await store.listRecent()).length).toBe(0);
  });

  test("listRecent returns newest-first with a rowid tiebreak, bounded by limit", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    const ids: string[] = [];
    for (const stage of ["parse", "runner", "sandbox", "pipeline"] as const) {
      await store.record({ ...BASE, stage, error: `boom-${stage}` });
    }
    ids.push(...(db.raw.query("SELECT id FROM review_failures ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id));

    const recent = await store.listRecent(3);
    expect(recent.map((row) => row.id)).toEqual([ids[3]!, ids[2]!, ids[1]!]); // newest first
    // Default limit covers everything written in this test.
    expect((await store.listRecent()).length).toBe(4);
    // Same-second inserts keep a total order via rowid (first written = oldest).
    expect(recent[0]!.stage).toBe("pipeline");
  });

  test("countAdmissionDrops24h reads every reason at zero on an empty log", async () => {
    const store = createFailureStore(createMigratedTestD1());
    expect(await store.countAdmissionDrops24h()).toEqual({
      "pr-held": 0,
      "system-cap": 0,
      "workspace-cap": 0,
      error: 0,
    });
  });

  test("countAdmissionDrops24h groups the terminal drops by reason over the trailing 24h", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    // Three forced refusals of distinct reasons — the operator's contract.
    for (const reason of ["pr-held", "system-cap", "workspace-cap"] as const) {
      await store.record({ ...BASE, stage: "pipeline", error: dropError(reason) });
    }
    // The fourth reason (admission storage fault) is counted on its own branch.
    await store.record({ ...BASE, stage: "pipeline", error: dropError("error") });
    // Not admission drops: an ordinary pipeline failure, a drop-shaped error on
    // another stage, and a reason token outside the closed vocabulary.
    await store.record({ ...BASE, stage: "pipeline", error: "comment post failed" });
    await store.record({ ...BASE, stage: "sandbox", error: dropError("system-cap") });
    await store.record({
      ...BASE,
      stage: "pipeline",
      error: "review dropped after 3 refused retries: not-a-reason (system_cap 0, workspace_cap 0)",
    });
    // A drop outside the 24h window stays invisible. `record` never writes
    // created_at, so the old row is seeded raw through the same table.
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
    // The reason vocabulary is closed: the operator's four buckets.
    expect(ADMISSION_DROP_REASONS).toEqual(["pr-held", "system-cap", "workspace-cap", "error"]);
  });

  test("countGithubRateLimited24h counts only the secondary prefix inside the trailing 24h", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    // The metric's three in-window rows: the single catch's delivery failure
    // and the degraded delete sweep's own `rate-limit` attribution — this count
    // IS the metric, so no stage is excluded.
    await store.record({ ...BASE, stage: "pipeline", error: `${GITHUB_RATE_LIMIT_PREFIX}secondary limit on comment update` });
    await store.record({ ...BASE, stage: "pipeline", error: `${GITHUB_RATE_LIMIT_PREFIX}secondary limit on check update` });
    await store.record({ ...BASE, stage: "rate-limit", error: `${GITHUB_RATE_LIMIT_PREFIX}secondary limit on delete sweep` });
    const matchesOnly = await store.countGithubRateLimited24h();
    expect(matchesOnly).toBe(3);

    // Not counted: the primary-limit prefix is its own words, and an ordinary
    // failure carries neither prefix.
    await store.record({ ...BASE, stage: "pipeline", error: `${GITHUB_PRIMARY_RATE_LIMIT_PREFIX}primary limit on comment update` });
    await store.record({ ...BASE, stage: "pipeline", error: "comment post failed" });
    // Matching rows outside the 24h window stay invisible. The count is a
    // window-and-prefix predicate over the same index, so these decoys must
    // leave its result exactly where the in-window matches put it.
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
    const db = createMigratedTestD1();
    const index = db.raw
      .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_failures_pipeline_created'")
      .get() as { sql: string } | null;
    expect(index?.sql).toContain("WHERE stage = 'pipeline'");
    // The read's own predicate shape must seek the partial index, not scan the
    // `created_at` window and discard every non-pipeline stage row.
    const plan = (
      db.raw
        .query(
          `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM review_failures
             WHERE stage = 'pipeline' AND created_at > datetime('now', '-24 hours')`,
        )
        .all() as Array<{ detail: string }>
    ).map((row) => row.detail);
    expect(plan.join("\n")).toContain("idx_review_failures_pipeline_created (created_at>?)");
  });
});
