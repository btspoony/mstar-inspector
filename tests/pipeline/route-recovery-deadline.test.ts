import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../helpers/cloudflare-workers-mock";

import { createSeededTestD1, VALID_OUTPUT } from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { withFrozenClock } from "../helpers/clock";
import { deliveryKeyOf, readAttemptHandoff } from "../../src/store/review-route-store";
import { readReviewLaunch } from "../../src/pipeline/review-attempt";
import { REVIEW_ATTEMPT_CAP_DEFAULT_MS } from "../../src/dashboard/runtime-config-store";
import type { TestD1 } from "../store/helpers";
import type { D1Like, D1StatementLike } from "../../src/store/types";

const { EXEC_DEADLINE_WRAPPER } = await import("../../src/pipeline/sandbox");
const { createReviewConsumer } = await import("../../src/pipeline/consumer");

let h = createConsumerHarness();
beforeEach(() => {
  h = createConsumerHarness();
});

function fakeTools(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mstar-deadline-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return dir;
}

function runWrapper(dir: string, deadlineSec: number, graceMs: number, command: string) {
  return Bun.spawnSync(
    ["/bin/sh", "-c", EXEC_DEADLINE_WRAPPER, "mstar-deadline", String(deadlineSec), String(graceMs), command],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` } },
  );
}

function timeoutRecorder(recordPath: string): string {
  return `#!/bin/sh\nprintf '%s\\n' "$@" > '${recordPath}'\nexit 0\n`;
}

describe("claim 6 — the remaining window is re-derived in the container, grace subtracted", () => {
  test("a request that queued 120s still grants only what is left, minus the kill grace", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-deadline-"));
    const record = join(dir, "timeout-argv");
    const fakeNow = 1_900_000_000;
    const tools = fakeTools({
      date: `#!/bin/sh\nprintf '%s\\n' '${fakeNow}'\n`,
      timeout: timeoutRecorder(record),
    });

    const deadline = fakeNow + 600;
    const ran = runWrapper(tools, deadline, 5_000, "bun run review");

    expect(ran.exitCode).toBe(0);
    const argv = readFileSync(record, "utf8").trimEnd().split("\n");
    expect(argv[0]).toBe("--kill-after=5");
    expect(argv[1]).toBe("594");
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
    const tools = fakeTools({
      date: `#!/bin/sh
if [ -f '${state}' ]; then printf '%s\\n' '${fakeNow + 1_200}'; exit 0; fi
: > '${state}'
printf '%s\\n' '${fakeNow}'
sleep 1
`,
      timeout: `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\n' "$@" > '${record}'\nexit 0\n`,
    });

    const ran = runWrapper(tools, fakeNow + 120, 5_000, "bun run review");

    expect(ran.exitCode).toBe(124);
    expect(() => readFileSync(marker, "utf8")).toThrow();
    expect(() => readFileSync(record, "utf8")).toThrow();
  });
});

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
    db.raw
      .prepare(
        `INSERT INTO review_attempt_handoffs
           (delivery_key, attempt_id, payload_json, state, deadline_ms, created_ms, updated_ms)
         VALUES (?, ?, ?, 'owed', NULL, ?, ?)`,
      )
      .run(key, "attempt-legacy", JSON.stringify(payload), createdAt, createdAt);
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
          const row = await deps.env.DB.prepare("SELECT expires_at FROM review_inflight WHERE attempt_id = ?")
            .bind(ref.attemptId)
            .first<{ expires_at: string }>();
          leaseExpiry = row === null ? Number.NaN : Date.parse(row.expires_at);
        },
      },
    );

    await consumer(h.makeBatch(payload));

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
      await consumer(h.makeBatch(payload));
    });

    // note: One ack, no retry: the stop is terminal because a durable row records it.
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(1);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).toContain("budget-exhausted:");
    // note: The durable launch fact: no paid outcome was ever recorded for the attempt
    // (an unlaunched row ends `provisioned` or `abandoned`), so no paid work ran.
    const launch = await readReviewLaunch(db as never, "attempt-spent");
    expect(launch?.state === "provisioned" || launch?.state === "abandoned").toBe(true);
  });
});
