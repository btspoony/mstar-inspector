import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../helpers/cloudflare-workers-mock";

import { createSeededTestD1, VALID_OUTPUT } from "../helpers/consumer-fixtures";
import { createConsumerHarness, failureRows, makePayload } from "../helpers/consumer-harness";
import { withFrozenClock } from "../helpers/clock";
import { deliveryKeyOf, readAttemptHandoff } from "../../src/store/review-route-store";
import { deriveReviewBudget, EXEC_TIMEOUT_GIT_MS, postRunnerReserveMs } from "../../src/review-budget";
import { CHECK_TERMINALIZE_DEFAULT, REVIEW_ATTEMPT_CAP_DEFAULT_MS } from "../../src/dashboard/runtime-config-store";
import type { TestD1 } from "../store/helpers";
import type { D1Like, D1StatementLike } from "../../src/store/types";

// note: Loaded after the workerd shim above: `sandbox.ts` imports
// `cloudflare:workers`, and a bare specifier resolves at LINK time — a static
// import here would fail before `mock.module` could register the module.
const { EXEC_DEADLINE_WRAPPER } = await import("../../src/pipeline/sandbox");
const { boundedStepTimeout, readReviewLaunch, RoundBudgetSpent } = await import("../../src/pipeline/review-attempt");
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

    // 125 is the wrapper's own pre-exec refusal; 124 stays the platform's
    // timeout kill for a command that did start.
    expect(ran.exitCode).toBe(125);
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

    expect(ran.exitCode).toBe(125);
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
      // the platform keeps the ORIGINAL send stamp across them. Constructed, not
      // mutated: `Message.timestamp` is readonly.
      const sentAt = new Date(clock.now - 2_460_000);
      const delivered = {
        ...batch,
        messages: batch.messages.map((message) => ({ ...message, timestamp: sentAt })),
      };
      await consumer(delivered);

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

/**
 * note: D5 — the round clock has ONE origin. The cap is frozen at first
 * admission from the delivery's ENTRY instant, and the row stores that same
 * instant as `created_ms`; a redelivery hours later reads both back from the
 * row instead of deriving an origin of its own. Two origins against one frozen
 * deadline is what produced the staging refusals with a deadline still in the
 * future.
 */
describe("claim 11 — one origin for the round clock", () => {
  test("the first admission stores its ENTRY instant as created_ms, not the reservation's", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    await withFrozenClock(async (clock) => {
      // note: Entry at `t0`; the cap read is the first await after the entry
      // sample, and the clock advances 3s while it is in flight — so the
      // reservation's own `Date.now()` is a LATER instant. `created_ms` must
      // still be the entry instant, because that is what the cap was frozen
      // from.
      const t0 = clock.now;
      const slowAdmission = dbAnchoringOnCapRead(db, () => {
        clock.now = t0 + 3_000;
      });
      const consumer = createReviewConsumer(await h.makeEnv({ DB: slowAdmission as never }), h.testLog, h.overrides);
      await consumer(h.makeBatch(payload));

      const handoff = await readAttemptHandoff(db as never, deliveryKeyOf(payload));
      expect(handoff?.createdMs).toBe(t0);
      expect(handoff?.deadlineMs).toBe(t0 + REVIEW_ATTEMPT_CAP_DEFAULT_MS);
    });
  });

  test("a redelivery 400s later builds the SAME origin and deadline from the row", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    await withFrozenClock(async (clock) => {
      // note: What the first admission wrote: origin `t0`, deadline
      // `t0 + cap`. The delivery happens 400s later — long enough that an
      // origin taken from ITS clock would put the window far past the frozen
      // deadline.
      const t0 = clock.now;
      const deadlineMs = t0 + REVIEW_ATTEMPT_CAP_DEFAULT_MS;
      db.raw
        .prepare(
          `INSERT INTO review_attempt_handoffs
             (delivery_key, attempt_id, payload_json, state, deadline_ms, created_ms, updated_ms)
           VALUES (?, ?, ?, 'owed', ?, ?, ?)`,
        )
        .run(key, "attempt-redelivered", JSON.stringify(payload), deadlineMs, t0, t0);
      clock.now = t0 + 400_000;

      const seen: Array<{ roundStartedAt: number; budgetStartMs: number; deadlineMs: number }> = [];
      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
        ...h.overrides,
        startAttempt: async (_deps, ref) => {
          seen.push({
            roundStartedAt: ref.roundStartedAt,
            budgetStartMs: ref.budgetStartMs,
            deadlineMs: ref.deadlineMs,
          });
        },
      });
      await consumer(h.makeBatch(payload));

      expect(seen).toHaveLength(1);
      // note: Both the origin and the instant it anchored come OFF THE ROW.
      expect(seen[0]!.budgetStartMs).toBe(t0);
      expect(seen[0]!.deadlineMs).toBe(deadlineMs);
      // note: `roundStartedAt` still names this delivery, and only logging uses it.
      expect(seen[0]!.roundStartedAt).toBe(t0 + 400_000);
      // note: One frozen window, the same one the first delivery would derive
      // from the same pair — that pair is what both `deriveReviewBudget` sites
      // are called with.
      const budget = deriveReviewBudget({
        roundStartMs: seen[0]!.budgetStartMs,
        deadlineMs: seen[0]!.deadlineMs,
        terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
        level: "default",
      });
      expect(budget.runnerCutoffMs).toBe(deadlineMs - postRunnerReserveMs(CHECK_TERMINALIZE_DEFAULT));
      expect(budget.preparationBudgetMs).toBe(budget.runnerCutoffMs - t0);
      expect(budget.preparationBudgetMs).toBeGreaterThan(0);
    });
  });

  test("a spent preparation window is refused on the FIRST prepare entry, with no negative millisecond number", async () => {
    const db = await createSeededTestD1();
    const payload = makePayload();
    const key = deliveryKeyOf(payload);
    await withFrozenClock(async (clock) => {
      // note: The frozen DEADLINE is still in the future — the post-runner
      // reserve is what makes the preparation window spent. The old derivation
      // read this delivery's clock as the origin, saw a live window and
      // proceeded until the diff stage refused it minutes later; the frozen
      // origin refuses at the entry.
      const createdMs = clock.now - 100_000;
      const deadlineMs = createdMs + 233_000;
      expect(deadlineMs).toBeGreaterThan(clock.now);
      expect(
        deriveReviewBudget({
          roundStartMs: createdMs,
          deadlineMs,
          terminalizeMs: CHECK_TERMINALIZE_DEFAULT,
          level: "default",
        }).preparationBudgetMs,
      ).toBeLessThanOrEqual(0);
      db.raw
        .prepare(
          `INSERT INTO review_attempt_handoffs
             (delivery_key, attempt_id, payload_json, state, deadline_ms, created_ms, updated_ms)
           VALUES (?, ?, ?, 'owed', ?, ?, ?)`,
        )
        .run(key, "attempt-spent-preparation", JSON.stringify(payload), deadlineMs, createdMs, createdMs);

      const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, h.overrides);
      await consumer(h.makeBatch(payload));
    });

    // note: One ack, no retry: the refusal is terminal, and it is the FIRST
    // prepare entry's — nothing was provisioned and no Check was claimed.
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.messageAckCalls).toHaveLength(1);
    expect(h.sandbox.calls).toHaveLength(0);
    // note: The durable proof no paid work ran: cleanup's abandon leaves the
    // row `abandoned` (a row that was never claimed, here, so no row at all)
    // and nothing ever reached `launched`.
    const paid = db.raw
      .query("SELECT COUNT(*) AS n FROM review_launches WHERE launched_at_ms IS NOT NULL")
      .get() as { n: number };
    expect(paid.n).toBe(0);
    expect(reviewCount(db)).toBe(0);
    expect(failureRows(db)).toHaveLength(1);
    const error = String(failureRows(db)[0]!.error);
    expect(error).toContain("budget-exhausted:");
    // note: The operator text names no raw negative remainder.
    expect(error).not.toMatch(/-\d+ms/);
  });

  test("the spent-window refusal names the step without a remainder", () => {
    let thrown: unknown;
    try {
      boundedStepTimeout(Date.now() - 60_000, EXEC_TIMEOUT_GIT_MS, "diff capture", "preparation");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RoundBudgetSpent);
    const spent = thrown as InstanceType<typeof RoundBudgetSpent>;
    expect(spent.window).toBe("preparation");
    expect(spent.message).toContain("diff capture");
    expect(spent.message).not.toMatch(/-\d+ms/);
  });
});
