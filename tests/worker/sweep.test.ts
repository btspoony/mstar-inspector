/**
 * Ops sweep tests (plan 19 Task 1, architect verdict AL-6) — the cron
 * failure sweep (src/worker/sweep.ts) over the REAL migration DDL
 * (bun:sqlite D1 double, tests/store/helpers.ts) plus a recording fake for
 * the window-SQL pin and an injected fetch for the webhook paths.
 *
 * Pinned contracts: threshold constants (threshold > 5, 24h window, 3s
 * webhook timeout), the trailing-24h window SQL, the `ops_sweep_alert`
 * payload shape (`dlq_check: "skipped"` — DLQ depth is NOT read), webhook
 * absent = log-only, webhook failure = warn log only (never throws).
 */

import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createFailureStore } from "../../src/store/failure-store";
import type { D1Like, D1StatementLike } from "../../src/store/types";
import {
  runSweep,
  SWEEP_FAILURE_THRESHOLD,
  SWEEP_WEBHOOK_TIMEOUT_MS,
  SWEEP_WINDOW_HOURS,
  type SweepAlertFields,
  type SweepLog,
  type SweepWarnFields,
} from "../../src/worker/sweep";
import { createMigratedTestD1 } from "../store/helpers";

const BASE = {
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
};

type WarnCall = { fields: SweepAlertFields | SweepWarnFields; msg?: string };

function captureLog(): { log: SweepLog; calls: WarnCall[] } {
  const calls: WarnCall[] = [];
  return { log: { warn: (fields, msg) => void calls.push({ fields, msg }) }, calls };
}

/** Seed `count` in-window failure rows (created_at defaults to now). */
async function seedInWindow(db: D1Like, count: number): Promise<void> {
  const store = createFailureStore(db);
  for (let i = 0; i < count; i++) {
    await store.record({ ...BASE, stage: "runner", error: `boom-${i}` });
  }
}

/** Seed one row OUTSIDE the trailing-24h window (25h ago). */
function seedOutsideWindow(db: D1Like & { raw: Database }): void {
  db.raw
    .query(
      `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pipeline', 'old boom', datetime('now', '-25 hours'))`,
    )
    .run(crypto.randomUUID(), BASE.installation_id, BASE.owner, BASE.repo, BASE.pr_number, BASE.head_sha);
}

/** Minimal D1Like that records the query text and answers COUNT = 0. */
function recordingDb(captured: string[]): D1Like {
  return {
    prepare(query: string): D1StatementLike {
      captured.push(query);
      const stmt: D1StatementLike = {
        bind(..._values: unknown[]): D1StatementLike {
          return stmt;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          return { n: 0 } as T;
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: [] as T[] };
        },
        async run<T = Record<string, unknown>>(): Promise<{
          results: T[];
          meta: { changes: number; last_row_id: number };
        }> {
          return { results: [] as T[], meta: { changes: 0, last_row_id: 0 } };
        },
      };
      return stmt;
    },
    async batch(): Promise<[]> {
      return [];
    },
  };
}

describe("runSweep", () => {
  test("pins the AL-6 threshold/window/timeout constants", () => {
    expect(SWEEP_FAILURE_THRESHOLD).toBe(5);
    expect(SWEEP_WINDOW_HOURS).toBe(24);
    expect(SWEEP_WEBHOOK_TIMEOUT_MS).toBe(3000);
  });

  test("counts review_failures with the trailing-24h window SQL", async () => {
    const captured: string[] = [];
    const result = await runSweep(recordingDb(captured));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("FROM review_failures");
    expect(captured[0]).toContain("created_at > datetime('now', '-24 hours')");
    expect(result).toEqual({ failures24h: 0, thresholdBreached: false, webhook: "not_attempted" });
  });

  test("counts only in-window rows, across all stages (parse + runner/sandbox/pipeline)", async () => {
    const db = createMigratedTestD1();
    const store = createFailureStore(db);
    for (const stage of ["parse", "runner", "sandbox", "pipeline"] as const) {
      await store.record({ ...BASE, stage, error: `boom-${stage}` });
    }
    seedOutsideWindow(db); // 25h-old row must NOT be counted

    const result = await runSweep(db, { log: captureLog().log });
    expect(result.failures24h).toBe(4);
    expect(result.thresholdBreached).toBe(false);
  });

  test("threshold boundary: exactly 5 in-window rows does not alert", async () => {
    const db = createMigratedTestD1();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD);
    const { log, calls } = captureLog();

    const result = await runSweep(db, { log });
    expect(result).toEqual({ failures24h: 5, thresholdBreached: false, webhook: "not_attempted" });
    expect(calls).toHaveLength(0);
  });

  test("breach (6 rows) emits the ops_sweep_alert event; absent webhook = log-only", async () => {
    const db = createMigratedTestD1();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const fetchImpl = mock(() => Promise.resolve(new Response("ok")));

    const result = await runSweep(db, { log, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ failures24h: 6, thresholdBreached: true, webhook: "absent" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fields).toEqual({
      event: "ops_sweep_alert",
      failures_24h: 6,
      dlq_check: "skipped",
      thresholds: { failures_24h: 5, window_hours: 24 },
    });
  });

  test("breach with webhook POSTs the alert payload as JSON with a timeout signal", async () => {
    const db = createMigratedTestD1();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log } = captureLog();
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response("ok");
    }) as unknown as typeof fetch;

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("posted");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://ops.example/hook");
    expect(seen[0]!.init?.method).toBe("POST");
    expect((seen[0]!.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({
      event: "ops_sweep_alert",
      failures_24h: 6,
      dlq_check: "skipped",
      thresholds: { failures_24h: 5, window_hours: 24 },
    });
  });

  test("webhook failure degrades to a warn log and never throws", async () => {
    const db = createMigratedTestD1();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const fetchImpl = (async () => {
      throw new Error("sink unreachable");
    }) as unknown as typeof fetch;

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.fields).toMatchObject({ event: "ops_sweep_alert" });
    expect(calls[1]!.fields).toMatchObject({ event: "ops_sweep_alert_webhook_failed", detail: "sink unreachable" });
  });

  test("D1 errors propagate to the caller (the scheduled handler owns the catch-all)", async () => {
    const broken: D1Like = {
      prepare(): D1StatementLike {
        throw new Error("d1 down");
      },
      async batch(): Promise<[]> {
        return [];
      },
    };
    await expect(runSweep(broken, { log: captureLog().log })).rejects.toThrow("d1 down");
  });
});
