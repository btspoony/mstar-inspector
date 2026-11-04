/**
 * Consumer recheck EVIDENCE CATALOG and window slicing (spec §7.3): which
 * trusted slices ride the wire for a row, how an oversized hunk is partitioned,
 * how those windows are ordered and numbered, and the per-slice byte bound.
 *
 * Sibling files cover status/row accounting (`consumer-recheck-status`) and the
 * conservative precedence guards (`consumer-recheck-precedence`); the doubles,
 * D1 seeders and payload builders come from ../helpers/consumer-harness.
 */
import { describe, expect, test } from "bun:test";
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
  commenterCalls,
  createReviewConsumer,
  DIFF_PREFETCH_MAX_BYTES,
  logLines,
  makeBatch,
  makeEnv,
  makePayload,
  reset,
  sandbox,
  testLog,
  testOverrides,
} from "../helpers/consumer-harness";

/**
 * A src/auth.ts diff whose ONE hunk is `lineCount` lines (1-based numbering).
 * Calls list every raw hunk index so `addedAt` can place the single ADDED line
 * where a case needs it: the added text exists on the new side only, so every
 * window after it starts one line further into the file on the new side
 * (`oldStart !== newStart`). A context-only hunk carries the same strings on
 * both sides, so a side swap or an offset error would pass every window
 * assertion below unchanged.
 */
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

/**
 * One file per row, each a 320-line hunk (four 80-line windows of ~7.8 KiB
 * slices), so the 256 KiB catalog budget runs out before the last rows. Each
 * file carries one ADDED line in its first window, so every later window's
 * `newStart` is one line ahead of its `oldStart` — the fixture can tell the
 * two sides apart.
 */
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
    // The production command streams the diff back bounded; the retired shape
    // redirected gh's stdout into the file and left the exec's stdout EMPTY,
    // so `buildEvidenceCatalog("")` excluded every target and the round
    // published `no-evidence` for rows it had never shown the seat. The double
    // answers the redirect-only shape with empty stdout (exactly like the real
    // shell), so this case fails on that shape and passes on this one.
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = recheckDocWith({});
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The command both writes the numstat file and reads it back bounded.
    const diffCall = sandbox.calls.find((c) => c.cmd.includes("gh pr diff '42'"))!;
    expect(diffCall.cmd).toContain(`head -c '${DIFF_PREFETCH_MAX_BYTES}' '/workspace/pr.diff'`);
    expect(diffCall.cmd).toContain("wc -c");
    // The catalog therefore has a slice for the row, and the row is sent.
    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ id: string; path: string }> };
    };
    expect(runnerInput.recheck.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
    expect(runnerInput.recheck.evidence.map((slice) => slice.id)).toContain("ev-1");
    expect(runnerInput.recheck.evidence.every((slice) => slice.path === "src/auth.ts")).toBe(true);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
  });

  test("an empty capture is a capture failure: context-incomplete, never no-evidence for every row", async () => {
    // `gh pr diff` always emits at least a header for a real PR, so exit 0 with
    // nothing to read means the capture failed. Publishing that as 25 confident
    // `no-evidence` verdicts is a fabrication; the round must say its context
    // was incomplete and send no recheck input.
    reset();
    sandbox.diffStdout = "";
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const warn = logLines.find((l) => l.fields.diff_capture === "empty");
    expect(warn?.level).toBe("warn");
    expect(warn?.msg).toContain("context-unavailable");
    expect(sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (context-incomplete)");
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
    expect(prepared.body).toContain("context coverage: unavailable");
    // The row is never assessed, and a capture failure records no recheck row.
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("a row the trusted catalog cannot prove never rides the wire: no-evidence, never budget, never assessed", async () => {
    reset();
    sandbox.diffStdout = VALID_DIFF;
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    // The concern's file is absent from the captured diff, so no slice can
    // prove it and no honest verdict is possible.
    db.raw.prepare(`UPDATE review_findings SET original_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...TARGET_ORIGINAL, filePath: "src/elsewhere.ts" }),
      TARGET_ROW_ID,
    );
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // Not sent: the runner gains no --recheck-out and the input has no recheck.
    expect(sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    // The written body is the runner's input JSON (a known literal shape here).
    const writtenInput = JSON.parse(sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 0/1 open prior finding(s)");
    // The reason names the real cause — an unprovable row is not oversized.
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("unverifiable (budget)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
    // Nothing was attempted, so nothing is assessed and no failure is recorded.
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("slices belonging to a budget-excluded row do not ride the recheck input, and the budget is measured without them", async () => {
    reset();
    // Two files in the captured diff, one selected row per file.
    sandbox.diffStdout = [
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
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    // The second row is oversized, so the §7.3 budget drops it AFTER the
    // catalog already holds its slice.
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ id: string; path: string }> };
    };
    expect(runnerInput.recheck.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
    // Only the surviving row's slice rides — the dropped row's file is gone.
    expect(runnerInput.recheck.evidence.length).toBeGreaterThan(0);
    expect(runnerInput.recheck.evidence.every((slice) => slice.path === "src/auth.ts")).toBe(true);
    // Slice ids stay stable (the shared catalog numbering, not a rebuilt one).
    expect(runnerInput.recheck.evidence[0]!.id).toBe("ev-1");
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
  });

  test("a row the catalog byte budget drops is a budget exclusion, never no-evidence", async () => {
    reset();
    // Twelve provable rows whose slices all fit individually, but not together:
    // the catalog budget stops adding slices partway through the target list.
    const rowCount = 12;
    sandbox.diffStdout = catalogBudgetDiff(rowCount);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = ""; // no document: every row is accounted by WHY it has no verdict
    const db = await createSeededTestD1();
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ path: string }> };
    };
    // The budget really bit: not every provable row could ride.
    expect(runnerInput.recheck.targets.length).toBeLessThan(rowCount);
    expect(new Set(runnerInput.recheck.evidence.map((slice) => slice.path)).size).toBeLessThan(rowCount);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // The dropped rows were never sent because their slices lost a BYTE budget
    // — the same cause as the size budget. `no-evidence` would claim their
    // files cannot prove them at all.
    expect(prepared.body).toMatch(/Budget row 12 \| unverifiable \(budget\)/);
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
  });

  test("a size-budget row is judged against the final input, not against a dropped neighbour's slices", async () => {
    reset();
    // Two provable rows. Row A is over the §7.3 cap on its own (a ~520 KiB
    // body) and brings four slices; row B fits only once A is gone, because A's
    // slices push B's input over the cap. Measuring B against the WHOLE
    // candidate set — as the old fixpoint did — excluded it for evidence it
    // never rode with, and it never came back.
    sandbox.diffStdout = [
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
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    sandbox.recheckFileContent = ""; // no document: each row is accounted by its own cause
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ path: string }> };
    };
    // B rides alone: A cannot fit any input, so it contributes no evidence.
    expect(runnerInput.recheck.targets.map((target) => target.rowId)).toEqual([affordableRowId]);
    expect(runnerInput.recheck.evidence.map((slice) => slice.path)).toEqual(["src/other.ts"]);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // The never-sent row keeps the budget reason; the sent row was answered.
    expect(prepared.body).toContain("| Oversized neighbour | unverifiable (budget) ");
    expect(prepared.body).toContain("| Affordable row | unverifiable (invalid-output) ");
  });

  test("an oversized hunk is sliced into windows that still contain the target line", async () => {
    reset();
    sandbox.diffStdout = oversizedAuthDiff(200);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The concern sits at line 21 — inside the FIRST window, so its local
    // evidence exists even though the whole hunk (200 lines) exceeds the bound.
    // The closure cites the window's ADDED line at 80: an unchanged context
    // line would prove presence only.
    sandbox.recheckFileContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
      recheck: {
        evidence: Array<{ id: string; oldStart: number; newStart: number; oldLines: string[]; newLines: string[] }>;
      };
    };
    const window = runnerInput.recheck.evidence.find((slice) => slice.id === "ev-1")!;
    // Header arithmetic stays exact: window one starts at file line 1 and its
    // 80 NEW-side lines really do cover the target line 21.
    expect(window.oldStart).toBe(1);
    expect(window.newStart).toBe(1);
    expect(window.newLines).toHaveLength(80);
    expect(window.newLines[20]).toBe("const v021 = 1;");
    // The sides are genuinely different: the added line exists on the new side
    // only, so this window reads 79 old lines against 80 new ones.
    expect(window.oldLines).toHaveLength(79);
    expect(window.newLines[79]).toBe("const added = 1;");
    expect(window.oldLines).not.toContain("const added = 1;");
    // Slice ids stay the shared catalog's stable numbering.
    expect(runnerInput.recheck.evidence.map((slice) => slice.id)).toEqual(["ev-1", "ev-2", "ev-3"]);
    // The in-window quote validates against a line the hunk ADDED, so the row
    // closes as a verified fix.
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("windows are ordered nearest the concern first, so the third one is ev-1 with its own starts", async () => {
    reset();
    // The added line sits at new line 180, INSIDE the third window, so the
    // window the concern is nearest to also carries a citable proof line.
    sandbox.diffStdout = oversizedAuthDiff(200, 179);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The concern sits at line 180 — window THREE in file order (lines 161-200)
    // and the NEAREST window to the cited line. Nearest-first ordering must put
    // it first and number it ev-1, with the partition's own exact starts.
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    db.raw.prepare(`UPDATE review_findings SET original_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...TARGET_ORIGINAL, lineStart: 180, lineEnd: 180 }),
      TARGET_ROW_ID,
    );
    sandbox.recheckFileContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const runnerInput = JSON.parse(sandbox.writtenInputJson!) as {
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
    // Nearest first, then by distance: 161 (distance 19), 81 (99), 1 (179).
    expect(runnerInput.recheck.evidence.map((slice) => [slice.id, slice.oldStart])).toEqual([
      ["ev-1", 161],
      ["ev-2", 81],
      ["ev-3", 1],
    ]);
    const nearest = runnerInput.recheck.evidence[0]!;
    // The window's two sides are genuinely different: the added line lives on
    // the new side only, so this window reads 39 old lines against 40 new ones.
    expect(nearest.oldStart).toBe(161);
    expect(nearest.newStart).toBe(161);
    expect(nearest.newLines).toHaveLength(40);
    expect(nearest.oldLines).toHaveLength(39);
    expect(nearest.newLines[19]).toBe("const added = 1;");
    // The line-180 quote validates against THAT window, so the nearest slice is
    // the one the seat can actually cite — and it cites an added line.
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("a quote outside the cited window still fails validation", async () => {
    reset();
    sandbox.diffStdout = oversizedAuthDiff(200);
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // Line 190 lives in window THREE (ev-3). Citing ev-1 (lines 1-80) with that
    // quote is out of range, so the row is dropped and cannot close anything.
    sandbox.recheckFileContent = JSON.stringify({
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
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (invalid-output)");
    expect(prepared.body).not.toContain("addressed (verified-fix)");
  });

  test("the per-slice byte bound measures the slice AS SERIALIZED, id included", async () => {
    reset();
    // One 3-line hunk whose middle context line is padded so the slice lands in
    // the window between the two measurement points: the id-less object is
    // within 8 KiB (8190 bytes) while the slice as serialized — with its
    // `ev-N` id — is 8194, over the bound. Measuring before the id is assigned
    // let this slice ride the wire over the bound it claims to enforce.
    sandbox.diffStdout = [
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
    sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await makeEnv({ DB: db as never }), testLog, testOverrides);

    await consumer(makeBatch(makePayload()));

    // The oversized slice is dropped, so nothing proves the row and no recheck
    // input is sent at all — the row is `no-evidence`, never an invalid answer.
    expect(sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
  });
});
