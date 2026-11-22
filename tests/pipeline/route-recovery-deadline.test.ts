/**
 * note: Route recovery claims 6, 7 and 9 — the attempt's frozen instant.
 *
 * 6. The paid call cannot start or end past the frozen instant even when the
 *    request queues or the marker proof takes time: the remaining window is
 *    re-derived inside the container request immediately before the exec, with
 *    the kill grace subtracted — not by the caller before it.
 * 7. The guard window and the attempt's instant are computed from ONE settled
 *    value, including when a legacy row is anchored concurrently by two callers.
 * 9. A container suspended between reading its clock and starting the bounded
 *    command cannot make the paid process outlive the frozen instant (the
 *    controlled-`date` regression the plan asks for).
 *
 * Claims 6 and 9 execute the EXACT wrapper string the container runs, with a
 * controlled `date`/`timeout` on PATH, so the assertion is about the commands
 * the container would start — not about the source's shape.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// note: Load shim FIRST: a static import of the sandbox module would be hoisted above
// it (it imports `cloudflare:workers`, unresolvable in Bun's runner).
import "../helpers/cloudflare-workers-mock";

import { createSeededTestD1, VALID_OUTPUT } from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { withFrozenClock } from "../helpers/clock";
import { deliveryKeyOf, readAttemptHandoff } from "../../src/store/review-route-store";
import { REVIEW_ATTEMPT_CAP_DEFAULT_MS } from "../../src/dashboard/runtime-config-store";
import type { TestD1 } from "../store/helpers";
import type { D1Like, D1StatementLike } from "../../src/store/types";

const { EXEC_DEADLINE_WRAPPER } = await import("../../src/pipeline/sandbox");
const { createReviewConsumer } = await import("../../src/pipeline/consumer");

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

/** note: A PATH dir carrying this case's `date` and (optionally) `timeout` doubles. */
function fakeTools(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mstar-deadline-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** note: Run the exact wrapper the container runs, with `dir` first on PATH. */
function runWrapper(dir: string, deadlineSec: number, graceMs: number, command: string) {
  return Bun.spawnSync(
    ["/bin/sh", "-c", EXEC_DEADLINE_WRAPPER, "mstar-deadline", String(deadlineSec), String(graceMs), command],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` } },
  );
}

/** note: A `timeout` double that records the argv it was started with. */
function timeoutRecorder(recordPath: string): string {
  return `#!/bin/sh\nprintf '%s\\n' "$@" > '${recordPath}'\nexit 0\n`;
}

describe("claim 6 — the remaining window is re-derived in the container, grace subtracted", () => {
  test("a request that queued 120s still grants only what is left, minus the kill grace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-deadline-"));
    const record = join(dir, "timeout-argv");
    // note: The clock the container sees: the request queued / the marker proof took
    // 120s of the attempt's window before the shell could evaluate it.
    const fakeNow = 1_900_000_000;
    const tools = fakeTools({
      date: `#!/bin/sh\nprintf '%s\\n' '${fakeNow}'\n`,
      timeout: timeoutRecorder(record),
    });

    const deadline = fakeNow + 600;
    const ran = runWrapper(tools, deadline, 5_000, "bun run review");

    expect(ran.exitCode).toBe(0);
    const argv = readFileSync(record, "utf8").trimEnd().split("\n");
    // note: 600s window, minus the one-second shave, minus the SIGKILL grace.
    expect(argv[0]).toBe("--kill-after=5");
    expect(argv[1]).toBe("594");
    // note: The child is the paid command, and the bound was computed HERE — no
    // host-side duration is handed over.
    expect(argv.slice(2)).toEqual(["/bin/sh", "-lc", "bun run review"]);
  });

  test("a window at or below the grace starts nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-deadline-"));
    const record = join(dir, "timeout-argv");
    const fakeNow = 1_900_000_000;
    const tools = fakeTools({
      date: `#!/bin/sh\nprintf '%s\\n' '${fakeNow}'\n`,
      timeout: timeoutRecorder(record),
    });

    const ran = runWrapper(tools, fakeNow + 3, 5_000, "bun run review");

    expect(ran.exitCode).toBe(124);
    expect(() => readFileSync(record, "utf8")).toThrow();
  });
});

describe("claim 9 — a suspended shell cannot outlive the frozen instant", () => {
  test("a clock sample taken before a suspension does not start the paid command after it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-deadline-"));
    const record = join(dir, "timeout-argv");
    const marker = join(dir, "paid-started");
    const state = join(dir, "date-called");
    const fakeNow = 1_900_000_000;
    // note: The controlled `date` of the plan's regression: its first answer is a
    // pre-deadline stamp, and it BLOCKS before returning. The suspension it
    // models advances the wall clock past the deadline; every later call reads
    // the resumed clock. (A genuine short sleep is the only way to model a
    // suspended process — a fake timer cannot stall a child shell.)
    const tools = fakeTools({
      date: `#!/bin/sh
if [ -f '${state}' ]; then printf '%s\\n' '${fakeNow + 1_200}'; exit 0; fi
: > '${state}'
printf '%s\\n' '${fakeNow}'
sleep 1
`,
      timeout: `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\n' "$@" > '${record}'\nexit 0\n`,
    });

    // note: 120s of window at the stale sample; the suspension lands 1200s later.
    const ran = runWrapper(tools, fakeNow + 120, 5_000, "bun run review");

    // note: The stale sample alone would have started the paid command with ~114s.
    // The second, post-suspension sample sees the window gone: nothing starts.
    expect(ran.exitCode).toBe(124);
    expect(() => readFileSync(marker, "utf8")).toThrow();
    expect(() => readFileSync(record, "utf8")).toThrow();
  });
});

/**
 * note: The D1 face with ONE hook: the attempt-cap read runs `before` first. That is
 * exactly where a concurrent delivery's first-writer anchor can land while THIS
 * delivery is still computing its own candidate (the read is between its
 * handoff read and its reserve).
 */
function dbAnchoringOnCapRead(db: TestD1, before: () => void): D1Like {
  let armed = false;
  return {
    prepare(query: string): D1StatementLike {
      const statement = db.prepare(query);
      if (!query.includes("FROM review_runtime_settings")) return statement;
      let bound: unknown[] = [];
      const target = (): D1StatementLike => statement.bind(...bound);
      return {
        bind(...values: unknown[]) {
          bound = values;
          armed = values[0] === "review.attempt.duration_cap_ms";
          return this;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          if (armed) {
            armed = false;
            before();
          }
          return target().first<T>();
        },
        all<T = Record<string, unknown>>() {
          return target().all<T>();
        },
        run<T = Record<string, unknown>>() {
          return target().run<T>();
        },
      } as D1StatementLike;
    },
  } as unknown as D1Like;
}

describe("claim 7 — one settled instant for the lease and the attempt", () => {
  test("a legacy row anchored by another delivery while this one computes its candidate", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    const createdAt = Date.now() - 1_000;
    // note: A row written before the deadline column existed: unanchored.
    db.raw
      .prepare(
        `INSERT INTO review_attempt_handoffs
           (delivery_key, attempt_id, payload_json, state, deadline_ms, created_ms, updated_ms)
         VALUES (?, ?, ?, 'owed', NULL, ?, ?)`,
      )
      .run(key, "attempt-legacy", JSON.stringify(payload), createdAt, createdAt);
    // note: This delivery's own cap: 15 minutes, so its candidate would end far
    // before the settled instant the other writer freezes.
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.attempt.duration_cap_ms', '900000', datetime('now'), 'tester')`,
      )
      .run();
    const settledDeadline = createdAt + 3_600_000;

    let leaseExpiry = Number.NaN;
    let seenDeadline = Number.NaN;
    const consumer = createReviewConsumer(
      await h.makeEnv({
        DB: dbAnchoringOnCapRead(db, () => {
          // note: The OTHER delivery wins the first-writer anchor right now, between
          // this delivery's handoff read and its own reserve.
          db.raw
            .prepare("UPDATE review_attempt_handoffs SET deadline_ms = ? WHERE delivery_key = ?")
            .run(settledDeadline, key);
        }) as never,
      }),
      h.testLog,
      {
        ...h.overrides,
        startAttempt: async (deps, ref) => {
          seenDeadline = ref.deadlineMs;
          // note: The lease THIS attempt holds while it is still running.
          const row = await deps.env.DB.prepare("SELECT expires_at FROM review_inflight WHERE attempt_id = ?")
            .bind(ref.attemptId)
            .first<{ expires_at: string }>();
          leaseExpiry = row === null ? Number.NaN : Date.parse(row.expires_at);
        },
      },
    );

    await consumer(h.makeBatch(payload));

    // note: The attempt executes under the settled instant, and its lease outlives
    // that same instant — never the shorter candidate this delivery computed.
    expect(seenDeadline).toBe(settledDeadline);
    expect(leaseExpiry).not.toBeNaN();
    expect(leaseExpiry).toBeGreaterThan(settledDeadline);
  });
});

/** note: Rows the completed round wrote — the review itself, not a shape probe. */
function reviewCount(db: TestD1): number {
  const row = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
  return row.n;
}

/**
 * note: Claim 10 — the attempt's clock starts when the delivery CLAIMS the job.
 * A pr-held guard's cumulative backoff (2460s+) outruns the operator cap, so a
 * message can be delivered long after the enqueue stamp it was sent with. An
 * anchor on that stamp leaves every such delivery a spent deadline: prepare
 * refuses, nothing is reviewed, and the retry only burns the next attempt.
 */
describe("claim 10 — a delayed delivery is anchored on its claim, not its enqueue stamp", () => {
  test("a delivery past the guard backoff derives a positive budget and completes prepare", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    await withFrozenClock(async (clock) => {
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);
      const batch = h.makeBatch(payload);
      // note: The guard's cumulative delayed retries, spent before admission —
      // the platform keeps the ORIGINAL send stamp across them.
      const delivered = batch.messages[0];
      if (delivered === undefined) throw new Error("the batch carries no message");
      delivered.timestamp = new Date(clock.now - 2_460_000);
      await consumer(batch);

      // note: The round really ran to its review, and the clock it ran under is
      // the operator cap from THIS delivery — not the stamp it was sent with.
      expect(reviewCount(db)).toBe(1);
      const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
      expect(handoff?.deadlineMs).toBe(clock.now + REVIEW_ATTEMPT_CAP_DEFAULT_MS);
    });
  });

  test("an attempt whose frozen deadline is spent settles as a recorded refusal", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    await withFrozenClock(async (clock) => {
      // note: The attempt's own instant is already gone. Delivery anchoring must
      // not resurrect it: a genuinely spent attempt refuses, durably.
      const spent = clock.now - 60_000;
      db.raw
        .prepare(
          `INSERT INTO review_attempt_handoffs
             (delivery_key, attempt_id, payload_json, state, deadline_ms, created_ms, updated_ms)
           VALUES (?, ?, ?, 'owed', ?, ?, ?)`,
        )
        .run(key, "attempt-spent", JSON.stringify(payload), spent, spent, spent);
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);
      await expect(consumer(h.makeBatch(payload))).resolves.toBeUndefined();
    });

    // note: One ack, no retry: the stop is terminal because a durable row records it.
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(1);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toContain("budget-exhausted:");
    expect(h.sandbox.calls.some((call) => call.cmd.includes("--input"))).toBe(false);
  });
});
