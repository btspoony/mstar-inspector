import { beforeEach, describe, expect, test } from "bun:test";
import { RECHECK_ASSIGNMENT_PROSE_BYTES } from "../../packages/shared/src/recheck-wire";
import {
  SHA,
  TARGET_ORIGINAL,
  TARGET_ROW_ID,
  VALID_DIFF,
  VALID_OUTPUT,
  createSeededTestD1,
  recheckDocWith,
  seedAssociation,
  seedOpenTarget,
  seedPriorPublication,
} from "../helpers/consumer-fixtures";
import {
  RECHECK_ASSIGNMENT_KEY,
  RECHECK_ASSIGNMENT_MAX,
  RECHECK_ASSIGNMENT_MIN,
} from "../../src/dashboard/runtime-config-store";
import {
  createConsumerHarness,
  DIFF_PREFETCH_MAX_BYTES,
  loadConsumer,
  makePayload,
} from "../helpers/consumer-harness";

const { createReviewConsumer } = await loadConsumer();

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function oversizedAuthDiff(lineCount: number, addedAt = 79): string {
  return [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "index 1111111..2222222 100644",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    `@@ -1,${lineCount - 1} +1,${lineCount} @@`,
    ...Array.from({ length: lineCount }, (_, i) =>
      i === addedAt
        ? "+const added = 1;"
        : ` const v${String(i + 1).padStart(3, "0")} = 1;`,
    ),
    "",
  ].join("\n");
}

function catalogBudgetDiff(files: number): string {
  const body = Array.from({ length: 320 }, (_, i) =>
    (i === 10 ? `+const added${String(i + 1).padStart(3, "0")} = 1;` : ` const v${String(i + 1).padStart(3, "0")} = 1;`).padEnd(
      45,
      " ",
    ),
  );
  return Array.from({ length: files }, (_, i) => {
    const path = `src/b${String(i + 1).padStart(2, "0")}.ts`;
    return [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,319 +1,320 @@",
      ...body,
    ].join("\n");
  }).join("\n") + "\n";
}

describe("recheck evidence catalog and window slicing (§7.3)", () => {
  test("a captured diff rides the bounded read, so the catalog proves the row (was: empty capture → zero slices)", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = recheckDocWith({});
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ id: string; path: string }> };
    };
    expect(runnerInput.recheck.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
    expect(runnerInput.recheck.evidence.map((slice) => slice.id)).toContain("ev-1");
    expect(runnerInput.recheck.evidence.every((slice) => slice.path === "src/auth.ts")).toBe(true);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
  });

  test("an empty capture with a non-empty numstat is a capture failure: context-incomplete, never no-evidence for every row", async () => {
    h.sandbox.diffStdout = "";
    h.sandbox.numstatStdout = "10\t2\tsrc/auth.ts\n";
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const warn = h.logLines.find((l) => l.fields.diff_capture === "empty");
    expect(warn?.level).toBe("warn");
    expect(warn?.msg).toContain("context-unavailable");
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (context-incomplete)");
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
    expect(prepared.body).toContain("context coverage: unavailable");
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("an empty capture with an empty numstat is a genuinely empty PR: a normal round", async () => {
    h.sandbox.diffStdout = "";
    h.sandbox.numstatStdout = "";
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.logLines.some((l) => l.fields.diff_capture !== undefined)).toBe(false);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("context-incomplete");
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("an over-bound capture is context-incomplete, never a fabricated no-evidence per row", async () => {
    h.sandbox.diffStdout = "b".repeat(DIFF_PREFETCH_MAX_BYTES + 1);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const warn = h.logLines.find((l) => l.fields.diff_capture !== undefined);
    expect(warn?.fields.diff_capture).toBe("overflow");
    expect(warn?.level).toBe("warn");
    expect(warn?.msg).toContain("context-unavailable");
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
    expect(prepared.body).toContain("unverifiable (context-incomplete)");
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
    expect(prepared.body).toContain("context coverage: unavailable");
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("a reply with no flag line is a capture failure, never a confident no-evidence", async () => {
    h.sandbox.diffReadStdout = "";
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const warn = h.logLines.find((l) => l.fields.diff_capture !== undefined);
    expect(warn?.fields.diff_capture).toBe("unreadable");
    expect(warn?.level).toBe("warn");
    expect(warn?.msg).toContain("context-unavailable");
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (context-incomplete)");
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
    expect(prepared.body).toContain("context coverage: unavailable");
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("a row the trusted catalog cannot prove never rides the wire: no-evidence, never budget, never assessed", async () => {
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    db.raw.prepare(`UPDATE review_findings SET original_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...TARGET_ORIGINAL, filePath: "src/elsewhere.ts" }),
      TARGET_ROW_ID,
    );
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("slices belonging to a budget-excluded row do not ride the recheck input, and the budget is measured without them", async () => {
    h.sandbox.diffStdout = [
      VALID_DIFF,
      "diff --git a/src/other.ts b/src/other.ts",
      "index 3333333..4444444 100644",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1,2 +1,3 @@",
      " export const a = 1;",
      "+export const b = 2;",
      " export const c = 3;",
      "",
    ].join("\n");
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedOpenTarget(db, {
      rowId: "eeeeeeee-0000-4000-8000-000000000005",
      findingId: "finding-oversized",
      original: {
        title: "Oversized concern",
        filePath: "src/other.ts",
        lineStart: 1,
        body: "y".repeat(600 * 1024),
      },
      nowMs: 2_100,
    });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ id: string; path: string }> };
    };
    expect(runnerInput.recheck.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
    expect(runnerInput.recheck.evidence.length).toBeGreaterThan(0);
    expect(runnerInput.recheck.evidence.every((slice) => slice.path === "src/auth.ts")).toBe(true);
    expect(runnerInput.recheck.evidence[0]!.id).toBe("ev-1");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
  });

  test("a row the catalog byte budget drops is a budget exclusion, never no-evidence", async () => {
    const rowCount = 12;
    h.sandbox.diffStdout = catalogBudgetDiff(rowCount);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    const db = await createSeededTestD1();
    db.raw
      .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(RECHECK_ASSIGNMENT_KEY, String(RECHECK_ASSIGNMENT_MAX), new Date().toISOString());
    await seedPriorPublication(db);
    for (let i = 0; i < rowCount; i++) {
      await seedOpenTarget(db, {
        rowId: `eeeeeeee-0000-4000-8000-000000000${String(i + 10).padStart(3, "0")}`,
        findingId: `finding-budget-${i + 1}`,
        original: {
          title: `Budget row ${i + 1}`,
          filePath: `src/b${String(i + 1).padStart(2, "0")}.ts`,
          lineStart: 1,
          lineEnd: 1,
        },
        nowMs: 1_000 + i,
      });
    }
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ path: string }> };
    };
    const targets = runnerInput.recheck.targets.length;
    expect(targets).toBeGreaterThan(0);
    expect(targets).toBeLessThan(rowCount);
    expect(runnerInput.recheck.evidence.length).toBe(targets * 4);
    const paths = new Set(runnerInput.recheck.evidence.map((slice) => slice.path));
    expect(paths.size).toBe(targets);
    expect(paths.size).toBeLessThan(rowCount);
    expect(
      jsonBytes(runnerInput.recheck) + RECHECK_ASSIGNMENT_PROSE_BYTES,
    ).toBeLessThanOrEqual(RECHECK_ASSIGNMENT_MAX);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toMatch(/Budget row 12 \| unverifiable \(budget\)/);
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
  });

  test("the rescued rotation head rides bounded with its OWN slices, never a dropped neighbour's", async () => {
    h.sandbox.diffStdout = [
      catalogBudgetDiff(1),
      "diff --git a/src/other.ts b/src/other.ts",
      "index 3333333..4444444 100644",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1,2 +1,3 @@",
      " export const a = 1;",
      "+export const b = 2;",
      " export const c = 3;",
      "",
    ].join("\n");
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    const oversizedRowId = "eeeeeeee-0000-4000-8000-00000000000a";
    const affordableRowId = "eeeeeeee-0000-4000-8000-00000000000b";
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db, {
      rowId: oversizedRowId,
      findingId: "finding-oversized-neighbour",
      original: {
        title: "Oversized neighbour",
        filePath: "src/b01.ts",
        lineStart: 1,
        lineEnd: 1,
        body: "a".repeat(520 * 1024),
      },
      nowMs: 2_000,
    });
    await seedOpenTarget(db, {
      rowId: affordableRowId,
      findingId: "finding-affordable",
      original: {
        title: "Affordable row",
        filePath: "src/other.ts",
        lineStart: 1,
        lineEnd: 1,
        body: "b".repeat(515_000),
      },
      nowMs: 2_100,
    });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: {
        targets: Array<{ rowId: string; original: { title: string; filePath: string; body: string } }>;
        evidence: Array<{ path: string }>;
      };
    };
    expect(runnerInput.recheck.targets.map((target) => target.rowId)).toEqual([oversizedRowId]);
    const [rescued] = runnerInput.recheck.targets;
    expect(rescued!.original.title).toBe("Oversized neighbour");
    expect(rescued!.original.filePath).toBe("src/b01.ts");
    expect(rescued!.original.body.length).toBeLessThan(520 * 1024);
    expect(rescued!.original.body).toContain("[... body truncated ...]");
    const paths = runnerInput.recheck.evidence.map((slice) => slice.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set(["src/b01.ts"]));
    expect(paths).not.toContain("src/other.ts");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("| Oversized neighbour | unverifiable (invalid-output) ");
    expect(prepared.body).toContain("| Affordable row | unverifiable (budget) ");
  });

  test("a candidate is measured against the FINAL input, never a dropped neighbour's slices", async () => {
    h.sandbox.diffStdout = [
      catalogBudgetDiff(1),
      "diff --git a/src/other.ts b/src/other.ts",
      "index 3333333..4444444 100644",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1,2 +1,3 @@",
      " export const a = 1;",
      "+export const b = 2;",
      " export const c = 3;",
      "diff --git a/src/head.ts b/src/head.ts",
      "index 5555555..6666666 100644",
      "--- a/src/head.ts",
      "+++ b/src/head.ts",
      "@@ -1,2 +1,3 @@",
      " export const x = 1;",
      "+export const y = 2;",
      " export const z = 3;",
      "",
    ].join("\n");
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    const headRowId = "eeeeeeee-0000-4000-8000-00000000000c";
    const affordableRowId = "eeeeeeee-0000-4000-8000-00000000000d";
    const droppedRowId = "eeeeeeee-0000-4000-8000-00000000000e";
    const db = await createSeededTestD1();
    db.raw
      .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(RECHECK_ASSIGNMENT_KEY, String(RECHECK_ASSIGNMENT_MIN), new Date().toISOString());
    await seedPriorPublication(db);
    await seedOpenTarget(db, {
      rowId: headRowId,
      findingId: "finding-small-head",
      original: {
        title: "Small head",
        filePath: "src/head.ts",
        lineStart: 1,
        lineEnd: 1,
        body: "c".repeat(200),
      },
      nowMs: 1_400,
    });
    await seedOpenTarget(db, {
      rowId: affordableRowId,
      findingId: "finding-affordable",
      original: {
        title: "Affordable row",
        filePath: "src/other.ts",
        lineStart: 1,
        lineEnd: 1,
        body: "b".repeat(200),
      },
      nowMs: 1_500,
    });
    await seedOpenTarget(db, {
      rowId: droppedRowId,
      findingId: "finding-dropped-neighbour",
      original: {
        title: "Dropped neighbour",
        filePath: "src/b01.ts",
        lineStart: 1,
        lineEnd: 1,
        body: "a".repeat(520 * 1024),
      },
      nowMs: 1_600,
    });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ path: string }> };
    };
    expect(runnerInput.recheck.targets.map((target) => target.rowId)).toEqual([headRowId, affordableRowId]);
    expect(runnerInput.recheck.evidence.map((slice) => slice.path).sort()).toEqual(["src/head.ts", "src/other.ts"]);
    expect(runnerInput.recheck.evidence.map((slice) => slice.path)).not.toContain("src/b01.ts");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("| Dropped neighbour | unverifiable (budget) ");
    expect(prepared.body).toContain("| Affordable row | unverifiable (invalid-output) ");
    const clocks = db.raw.query("SELECT id, last_scheduled_ms FROM review_findings").all() as {
      id: string;
      last_scheduled_ms: number | null;
    }[];
    const clockById = new Map(clocks.map((row) => [row.id, row.last_scheduled_ms]));
    for (const rowId of [headRowId, affordableRowId, droppedRowId]) expect(clockById.has(rowId)).toBe(true);
    expect(clockById.get(droppedRowId)).toBeNull();
    expect(clockById.get(affordableRowId)).not.toBeNull();
    expect(clockById.get(headRowId)).not.toBeNull();
  });

  test("an oversized hunk is sliced into windows that still contain the target line", async () => {
    h.sandbox.diffStdout = oversizedAuthDiff(200);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        {
          rowId: TARGET_ROW_ID,
          disposition: "addressed",
          reason: "verified-fix",
          evidence: {
            kind: "current-code",
            sliceId: "ev-1",
            startLine: 80,
            endLine: 80,
            quote: "const added = 1;",
            explanation: "The guard now bounds the value.",
          },
          relatedCurrentFindingIndexes: [],
        },
      ],
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: {
        evidence: Array<{ id: string; oldStart: number; newStart: number; oldLines: string[]; newLines: string[] }>;
      };
    };
    const window = runnerInput.recheck.evidence.find((slice) => slice.id === "ev-1")!;
    expect(window.oldStart).toBe(1);
    expect(window.newStart).toBe(1);
    expect(window.newLines).toHaveLength(80);
    expect(window.newLines[20]).toBe("const v021 = 1;");
    expect(window.oldLines).toHaveLength(79);
    expect(window.newLines[79]).toBe("const added = 1;");
    expect(window.oldLines).not.toContain("const added = 1;");
    expect(runnerInput.recheck.evidence.map((slice) => slice.id)).toEqual(["ev-1", "ev-2", "ev-3"]);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("windows are ordered nearest the concern first, so the third one is ev-1 with its own starts", async () => {
    h.sandbox.diffStdout = oversizedAuthDiff(200, 179);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    db.raw.prepare(`UPDATE review_findings SET original_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...TARGET_ORIGINAL, lineStart: 180, lineEnd: 180 }),
      TARGET_ROW_ID,
    );
    h.sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        {
          rowId: TARGET_ROW_ID,
          disposition: "addressed",
          reason: "verified-fix",
          evidence: {
            kind: "current-code",
            sliceId: "ev-1",
            startLine: 180,
            endLine: 180,
            quote: "const added = 1;",
            explanation: "The guard now bounds the value.",
          },
          relatedCurrentFindingIndexes: [],
        },
      ],
    });
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: {
        evidence: Array<{
          id: string;
          oldStart: number;
          newStart: number;
          oldLines: string[];
          newLines: string[];
        }>;
      };
    };
    expect(runnerInput.recheck.evidence.map((slice) => [slice.id, slice.oldStart])).toEqual([
      ["ev-1", 161],
      ["ev-2", 81],
      ["ev-3", 1],
    ]);
    const nearest = runnerInput.recheck.evidence[0]!;
    expect(nearest.oldStart).toBe(161);
    expect(nearest.newStart).toBe(161);
    expect(nearest.newLines).toHaveLength(40);
    expect(nearest.oldLines).toHaveLength(39);
    expect(nearest.newLines[19]).toBe("const added = 1;");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("a quote outside the cited window still fails validation", async () => {
    h.sandbox.diffStdout = oversizedAuthDiff(200);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = JSON.stringify({
      schema: "mstar.recheck/v1",
      headSha: SHA,
      results: [
        {
          rowId: TARGET_ROW_ID,
          disposition: "addressed",
          reason: "verified-fix",
          evidence: {
            kind: "current-code",
            sliceId: "ev-1",
            startLine: 190,
            endLine: 190,
            quote: "const v190 = 1;",
            explanation: "Cited far outside the slice it names.",
          },
          relatedCurrentFindingIndexes: [],
        },
      ],
    });
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("addressed (verified-fix)");
  });

  test("the per-slice byte bound measures the slice AS SERIALIZED, id included", async () => {
    h.sandbox.diffStdout = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index 1111111..2222222 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -19,3 +19,3 @@",
      " const header = req.headers;",
      ` const filler = "${"x".repeat(3854)}";`,
      " const claims = decode(token);",
      "",
    ].join("\n");
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
  });
  test("a head that fits with its full body carries no truncation marker", async () => {
    h.sandbox.diffStdout = catalogBudgetDiff(1);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = "";
    const db = await createSeededTestD1();
    db.raw
      .prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(RECHECK_ASSIGNMENT_KEY, String(RECHECK_ASSIGNMENT_MIN), new Date().toISOString());
    await seedPriorPublication(db);
    const body = "q".repeat(1_000);
    await seedOpenTarget(db, {
      rowId: "full-body-head-row",
      findingId: "full-body-head-finding",
      original: { body, filePath: "src/b01.ts", lineStart: 1, lineEnd: 1, fingerprintHint: "full-body-fp" },
      nowMs: 1_500,
    });
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string; original: { body: string } }>; evidence: unknown[] };
    };
    expect(runnerInput.recheck.targets).toHaveLength(1);
    expect(runnerInput.recheck.targets[0]!.original.body).toBe(body);
    expect(runnerInput.recheck.targets[0]!.original.body).not.toContain("[... body truncated ...]");
    expect(runnerInput.recheck.evidence).toHaveLength(0);
  });

});
