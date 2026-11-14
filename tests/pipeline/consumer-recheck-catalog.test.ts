/**
 * Consumer recheck EVIDENCE CATALOG and window slicing (spec §7.3): which
 * trusted slices ride the wire for a row, how an oversized hunk is partitioned,
 * how those windows are ordered and numbered, and the per-slice byte bound.
 *
 * Sibling files cover status/row accounting (`consumer-recheck-status`) and the
 * conservative precedence guards (`consumer-recheck-precedence`); the doubles,
 * D1 seeders and payload builders come from ../helpers/consumer-harness.
 */
import { beforeEach, describe, expect, test } from "bun:test";
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
import { RECHECK_ASSIGNMENT_KEY, RECHECK_ASSIGNMENT_MIN } from "../../src/dashboard/runtime-config-store";
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
    h.sandbox.diffStdout = VALID_DIFF;
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = recheckDocWith({});
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // The catalog has a slice for the row, and the row is sent.
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
    // The redirect wrote a diff (numstat is non-empty) but the bounded read
    // delivered nothing: that is a CAPTURE FAILURE. Publishing it as 25
    // confident `no-evidence` verdicts is a fabrication; the round must say its
    // context was incomplete and send no recheck input.
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
    // No recheck round went out: the runner input carries no recheck section.
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
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

  test("an empty capture with an empty numstat is a genuinely empty PR: a normal round", async () => {
    // `gh pr diff` writes nothing for a zero-change PR, and the bounded read
    // returns exactly that. Two empty captures are the same PR, not a lost
    // read: no capture-failure warn, no context-incomplete labels.
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
    // The bounded read flags a byte beyond DIFF_PREFETCH_MAX_BYTES. The diff
    // exists but cannot prove a row, so the round must say "the context was
    // incomplete" — publishing `no-evidence` per row would claim the diff was
    // inspected and came up empty. Slices stay off and the round still runs
    // (no throw, no failure row): only the accounting changes.
    h.sandbox.diffStdout = "b".repeat(DIFF_PREFETCH_MAX_BYTES + 1);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorPublication(db);
    await seedOpenTarget(db);
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // The warn names the over-size cause, not the empty-capture one.
    const warn = h.logLines.find((l) => l.fields.diff_capture !== undefined);
    expect(warn?.fields.diff_capture).toBe("overflow");
    expect(warn?.level).toBe("warn");
    expect(warn?.msg).toContain("context-unavailable");
    // No slices ride, so no recheck round is dispatched.
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
    expect(prepared.body).toContain("unverifiable (context-incomplete)");
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
    expect(prepared.body).toContain("context coverage: unavailable");
    // The row is never assessed, and over-size records no failure row.
    const findingRow = db.raw.query("SELECT last_assessed_ms FROM review_findings").get() as {
      last_assessed_ms: number | null;
    };
    expect(findingRow.last_assessed_ms).toBeNull();
    expect(db.raw.query("SELECT * FROM review_failures").all()).toHaveLength(0);
  });

  test("a reply with no flag line is a capture failure, never a confident no-evidence", async () => {
    // `parseBoundedRead` names a bounded read whose reply carries NO flag line
    // `unreadable`: the diff may well be on disk, but the Worker never received
    // a verdict about it. The command always terminates its own reply, so this
    // is the transport breaking — still a capture failure, and the round must
    // say so instead of publishing `no-evidence` for every row.
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
    // Context unavailable → no recheck round goes out…
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    // …the round itself still runs (the runner input was written), and the
    // prepared body names the reason instead of claiming the rows were checked.
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
    // The concern's file is absent from the captured diff, so no slice can
    // prove it and no honest verdict is possible.
    db.raw.prepare(`UPDATE review_findings SET original_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...TARGET_ORIGINAL, filePath: "src/elsewhere.ts" }),
      TARGET_ROW_ID,
    );
    await seedAssociation(db, "PRRT_thread1");
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    // Not sent: the runner gains no --recheck-out and the input has no recheck.
    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    // The written body is the runner's input JSON (a known literal shape here).
    const writtenInput = JSON.parse(h.sandbox.writtenInputJson!) as { recheck?: unknown };
    expect(writtenInput.recheck).toBeUndefined();
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("Reassessed 0/1 prior finding(s)");
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
    // Two files in the captured diff, one selected row per file.
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
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ id: string; path: string }> };
    };
    expect(runnerInput.recheck.targets.map((t) => t.rowId)).toEqual([TARGET_ROW_ID]);
    // Only the surviving row's slice rides — the dropped row's file is gone.
    expect(runnerInput.recheck.evidence.length).toBeGreaterThan(0);
    expect(runnerInput.recheck.evidence.every((slice) => slice.path === "src/auth.ts")).toBe(true);
    // Slice ids stay stable (the shared catalog numbering, not a rebuilt one).
    expect(runnerInput.recheck.evidence[0]!.id).toBe("ev-1");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (budget)");
  });

  test("a row the catalog byte budget drops is a budget exclusion, never no-evidence", async () => {
    // Twelve provable rows whose slices all fit individually, but not together:
    // the catalog budget stops adding slices partway through the target list.
    const rowCount = 12;
    h.sandbox.diffStdout = catalogBudgetDiff(rowCount);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    h.sandbox.recheckFileContent = ""; // no document: every row is accounted by WHY it has no verdict
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
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);

    await consumer(h.makeBatch(makePayload()));

    const runnerInput = JSON.parse(h.sandbox.writtenInputJson!) as {
      recheck: { targets: Array<{ rowId: string }>; evidence: Array<{ path: string }> };
    };
    // The budget really bit: not every provable row could ride.
    expect(runnerInput.recheck.targets.length).toBeLessThan(rowCount);
    expect(new Set(runnerInput.recheck.evidence.map((slice) => slice.path)).size).toBeLessThan(rowCount);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // The dropped rows were never sent because their slices lost a BYTE budget
    // — the same cause as the size budget. `no-evidence` would claim their
    // files cannot prove them at all.
    expect(prepared.body).toMatch(/Budget row 12 \| unverifiable \(budget\)/);
    expect(prepared.body).not.toContain("unverifiable (no-evidence)");
  });

  test("the rescued rotation head rides bounded with its OWN slices, never a dropped neighbour's", async () => {
    // Two provable rows over the size cap, both on their own bodies: row A (the
    // rotation head) brings four slices of its file, row B one slice of another.
    // The head can never be dropped for want of room — an omitted row keeps its
    // clock and comes back first forever — so it rides with a bounded body and
    // as much of its own catalog as fits, while B waits its turn. What this
    // case pins is the rescue's evidence accounting: the rescued head carries
    // only its own catalog, never a slice of a row that did not ride. The
    // final-input measurement itself (a row judged WITHOUT a dropped
    // neighbour's slices) needs a fixture where that measurement decides the
    // outcome; the sibling case below is that fixture.
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
    h.sandbox.recheckFileContent = ""; // no document: each row is accounted by its own cause
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
    // The rotation head rides alone — bounded, and still the same finding row.
    expect(runnerInput.recheck.targets.map((target) => target.rowId)).toEqual([oversizedRowId]);
    const [rescued] = runnerInput.recheck.targets;
    expect(rescued!.original.title).toBe("Oversized neighbour");
    expect(rescued!.original.filePath).toBe("src/b01.ts");
    expect(rescued!.original.body.length).toBeLessThan(520 * 1024);
    expect(rescued!.original.body).toContain("[... body truncated ...]");
    // Only the head's own catalog rides: the row that did not ride leaves no
    // orphan evidence behind, and the head carries no slice it cannot cite.
    const paths = runnerInput.recheck.evidence.map((slice) => slice.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set(["src/b01.ts"]));
    expect(paths).not.toContain("src/other.ts");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    // This fixture delivers no document: the sent head is the attempted-but-
    // unusable row, the omitted one keeps its never-sent budget reason.
    expect(prepared.body).toContain("| Oversized neighbour | unverifiable (invalid-output) ");
    expect(prepared.body).toContain("| Affordable row | unverifiable (budget) ");
  });

  test("a candidate is measured against the FINAL input, never a dropped neighbour's slices", async () => {
    // The fixpoint property this suite exists to protect, isolated so the head
    // rescue cannot mask it. At the operator floor the document budget is
    // ~4.5 KiB, and three provable rows compete:
    //   C (rotation head, small body, its own small slice) → always fits
    //   B (small body, its own small slice)                → fits beside C
    //   A (520 KiB body, four ~3.6 KiB slices)             → never fits
    // Measured against the FINAL input, B's candidate carries only the slices
    // the accepted rows reference: C's and its own (~2.4 KiB) → B rides.
    // Measured against the WHOLE candidate set — the old fixpoint — B also
    // absorbs A's ~14.5 KiB and is dropped for evidence it never rode with.
    // C rides either way, so no rescue fires and the two measurements really
    // do differ: reverting to the whole-set loop makes this case send only C.
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
    h.sandbox.recheckFileContent = ""; // no document: each row is accounted by its own cause
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
    // Both fitting rows ride, in rotation order, and A's slices never enter.
    expect(runnerInput.recheck.targets.map((target) => target.rowId)).toEqual([headRowId, affordableRowId]);
    expect(runnerInput.recheck.evidence.map((slice) => slice.path).sort()).toEqual(["src/head.ts", "src/other.ts"]);
    expect(runnerInput.recheck.evidence.map((slice) => slice.path)).not.toContain("src/b01.ts");
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("| Dropped neighbour | unverifiable (budget) ");
    expect(prepared.body).toContain("| Affordable row | unverifiable (invalid-output) ");
    // The dropped row was fit-omitted, so it holds its clock and gets its turn.
    const clocks = db.raw.query("SELECT id, last_scheduled_ms FROM review_findings").all() as {
      id: string;
      last_scheduled_ms: number | null;
    }[];
    const clockById = new Map(clocks.map((row) => [row.id, row.last_scheduled_ms]));
    // All three seeded rows must be in the read: a missing one would make the
    // nullity checks vacuous.
    for (const rowId of [headRowId, affordableRowId, droppedRowId]) expect(clockById.has(rowId)).toBe(true);
    expect(clockById.get(droppedRowId)).toBeNull();
    expect(clockById.get(affordableRowId)).not.toBeNull();
    expect(clockById.get(headRowId)).not.toBeNull();
  });

  test("an oversized hunk is sliced into windows that still contain the target line", async () => {
    h.sandbox.diffStdout = oversizedAuthDiff(200);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // The concern sits at line 21 — inside the FIRST window, so its local
    // evidence exists even though the whole hunk (200 lines) exceeds the bound.
    // The closure cites the window's ADDED line at 80: an unchanged context
    // line would prove presence only.
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
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("windows are ordered nearest the concern first, so the third one is ev-1 with its own starts", async () => {
    // The added line sits at new line 180, INSIDE the third window, so the
    // window the concern is nearest to also carries a citable proof line.
    h.sandbox.diffStdout = oversizedAuthDiff(200, 179);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
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
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("addressed (verified-fix)");
  });

  test("a quote outside the cited window still fails validation", async () => {
    h.sandbox.diffStdout = oversizedAuthDiff(200);
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    // Line 190 lives in window THREE (ev-3). Citing ev-1 (lines 1-80) with that
    // quote is out of range, so the row is dropped and cannot close anything.
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
    // One 3-line hunk whose middle context line is padded so the slice lands in
    // the window between the two measurement points: the id-less object is
    // within 8 KiB (8190 bytes) while the slice as serialized — with its
    // `ev-N` id — is 8194, over the bound. Measuring before the id is assigned
    // let this slice ride the wire over the bound it claims to enforce.
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

    // The oversized slice is dropped, so nothing proves the row and no recheck
    // input is sent at all — the row is `no-evidence`, never an invalid answer.
    expect(h.sandbox.calls.some((c) => c.cmd.includes("--recheck-out"))).toBe(false);
    const prepared = h.commenterCalls.find((c) => c.op === "post-prepared")!.args as { body: string };
    expect(prepared.body).toContain("unverifiable (no-evidence)");
    expect(prepared.body).not.toContain("unverifiable (invalid-output)");
  });
  test("a head that fits with its full body carries no truncation marker", async () => {
    // The rescue ladder can reach an attempt where the head's full body fits
    // once its own catalog is dropped: at the operator floor the four slices of
    // its file do not fit beside any body, while the body alone does. A body
    // that was not cut must not claim it was.
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
    // The slices were what had to go, and they went whole.
    expect(runnerInput.recheck.evidence).toHaveLength(0);
  });

});
