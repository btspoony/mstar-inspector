/**
 * Spec §7.9 — the successor transition. Capacity and PR ownership move only on
 * an OBSERVATION that the prior attempt's sandbox stopped; a lapsed lease, a
 * quiet Workflow or elapsed time never reassigns them. A request that may
 * already have reached GitHub is reconciled by readback under a fresh claim and
 * is never resent.
 *
 * The store/consumer tests drive the production conditional write and the
 * production reconciler; the doubles only stand in for GitHub and the sandbox.
 */
import { describe, expect, test } from "bun:test";

// Load shim FIRST: a static import of the pipeline would be hoisted above it
// (consumer → ./sandbox → `cloudflare:workers`, unresolvable in Bun's runner).
import "../helpers/cloudflare-workers-mock";

import {
  acquireInflight,
  type AcquireInflightOptions,
  type InflightKey,
} from "../../src/store/inflight-store";
import { attachCheckRunId, setCheckCreateState } from "../../src/store/review-checks";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { withFrozenClock } from "../helpers/clock";
import { VALID_OUTPUT, createSeededTestD1 } from "../helpers/consumer-fixtures";
import { createConsumerHarness, makePayload } from "../helpers/consumer-harness";
import {
  CLAIM_AT,
  EXPIRED_DEADLINE,
  OFFLINE_FETCH,
  T0,
  claim,
  rawRow,
  remoteFor,
  run,
  scriptedCredentials,
  seededDb,
  type AdapterScript,
} from "../worker/helpers/check-reconcile";

const { createReviewConsumer, priorSandboxRevoked } = await import("../../src/pipeline/consumer");
const { attemptSandboxId } = await import("../../src/pipeline/review-attempt");
const { SandboxV1 } = await import("../../src/pipeline/sandbox");
const { shellCommand } = await import("../../src/pipeline/shell-command");
const { recordTerminalDispatch } = await import("../../src/store/review-checks");

const KEY: InflightKey = {
  installation_id: 42,
  owner: "acme",
  repo: "widgets",
  pr_number: 7,
  workspace_id: "ws_1",
};

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LATER = "2026-11-03T00:02:00Z";

/** Another PR of the same tenant — the one a full system cap must refuse. */
function otherPr(prNumber: number): InflightKey {
  return { ...KEY, pr_number: prNumber };
}

const OPTS: AcquireInflightOptions = {
  systemCap: 32,
  workspaceCap: 16,
  attemptId: "attempt-1",
  ttlSeconds: 60,
  headSha: SHA,
  now: "2026-11-03T00:00:00Z",
};


/** The PR rows this suite asserts on, in write order. */
function rowsOf(db: TestD1): string[] {
  const rows = db.raw.query("SELECT attempt_id FROM review_inflight ORDER BY rowid").all() as Array<{
    attempt_id: string;
  }>;
  return rows.map((row) => row.attempt_id);
}

describe("§7.9 the successor transition", () => {
  test("expiry alone refuses: the lapsed lease is a fence, not a stopped executor", async () => {
    const db = createMigratedTestD1();
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    // The prior attempt's row is long expired and its paid state is accounted
    // for — everything the old rule needed. It is still not evidence.
    expect(await acquireInflight(db, KEY, { ...OPTS, attemptId: "attempt-2", now: LATER })).toEqual({
      ok: false,
      reason: "pr-held",
      heldHeadSha: SHA,
      heldAttemptId: "attempt-1",
      heldExpired: true,
    });
    expect(rowsOf(db)).toEqual(["attempt-1"]);
  });

  test("a confirmed stop plus the expired fence reassigns the PR and the slot", async () => {
    const db = createMigratedTestD1();
    seedPaidAttempt(db, "attempt-1");
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    const newerSha = "fedcba9876543210fedcba9876543210fedcba98";
    expect(
      await acquireInflight(db, KEY, {
        ...OPTS,
        attemptId: "attempt-2",
        headSha: newerSha,
        now: LATER,
        priorStopped: { attemptId: "attempt-1" },
      }),
    ).toEqual({ ok: true });
    // One row, the successor's, and it owns both the PR and a capacity slot
    // (the caps count only live rows, so the expired predecessor held neither).
    expect(rowsOf(db)).toEqual(["attempt-2"]);
    const [row] = db.raw
      .query("SELECT head_sha FROM review_inflight")
      .all() as Array<{ head_sha: string }>;
    expect(row!.head_sha).toBe(newerSha);
    // The revocation commits in the SAME transaction: the displaced attempt may
    // never start anything again.
    expect(revokedAtOf(db, "attempt-1")).not.toBeNull();
  });

  test("an observation taken for another attempt never replaces this one", async () => {
    const db = createMigratedTestD1();
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    // The probe named attempt-0; the row belongs to attempt-1. The conditional
    // write binds the observed id to the row's own attempt_id, so it refuses.
    expect(
      await acquireInflight(db, KEY, {
        ...OPTS,
        attemptId: "attempt-2",
        now: LATER,
        priorStopped: { attemptId: "attempt-0" },
      }),
    ).toMatchObject({ ok: false, reason: "pr-held", heldAttemptId: "attempt-1" });
    expect(rowsOf(db)).toEqual(["attempt-1"]);
  });

  test("the stop is a REVOCATION, not a reading: a live container, no capability or a throw is not a stop", async () => {
    const asked: string[] = [];
    const getSandboxDouble = (answer: (() => Promise<{ running: boolean }>) | undefined) => async (
      _binding: unknown,
      id: string,
    ) => {
      asked.push(id);
      const sandbox: Record<string, unknown> = {
        runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        claimMarker: async () => "written",
        runMarked: async () => ({ kind: "unknown" }),
        destroyMarked: async () => "unknown",
        destroy: async () => {},
      };
      if (answer !== undefined) sandbox.revoke = answer;
      return sandbox as never;
    };

    expect(await priorSandboxRevoked(getSandboxDouble(async () => ({ running: false })), {}, "attempt-1")).toBe(true);
    // It revoked THAT attempt's sandbox, never the PR's or the caller's.
    expect(asked).toEqual([attemptSandboxId("attempt-1")]);
    // A container that won the start race keeps the PR where it is.
    expect(await priorSandboxRevoked(getSandboxDouble(async () => ({ running: true })), {}, "attempt-1")).toBe(false);
    expect(await priorSandboxRevoked(getSandboxDouble(undefined), {}, "attempt-1")).toBe(false);
    expect(
      await priorSandboxRevoked(
        getSandboxDouble(async () => {
          throw new Error("the revocation write failed");
        }),
        {},
        "attempt-1",
      ),
    ).toBe(false);
    expect(
      await priorSandboxRevoked(async () => {
        throw new Error("the sandbox could not be addressed");
      }, {}, "attempt-1"),
    ).toBe(false);
  });

  test("capacity counts what may still run: an expired, unrevoked attempt holds its slot", async () => {
    const db = createMigratedTestD1();
    seedPaidAttempt(db, "attempt-1");
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    // Cap 1, the row expired — but attempt-1's paid run returned and nothing
    // revoked it, so its container may still run: no slot for another PR.
    expect(
      await acquireInflight(db, otherPr(8), { ...OPTS, attemptId: "attempt-2", systemCap: 1, now: LATER }),
    ).toEqual({ ok: false, reason: "system-cap" });
    // With the attempt revoked (a successor took its PR), the slot is free.
    db.raw.prepare("UPDATE review_launches SET revoked_ms = ? WHERE attempt_id = ?").run(T0, "attempt-1");
    expect(
      await acquireInflight(db, otherPr(8), { ...OPTS, attemptId: "attempt-2", systemCap: 1, now: LATER }),
    ).toEqual({ ok: true });
  });

  test("a revoked attempt cannot start a container again", async () => {
    const contexts: Array<{ started: unknown[] }> = [];
    const container = (running: boolean) => {
      const state = { running };
      const started: unknown[] = [];
      contexts.push({ started });
      return {
        get running() {
          return state.running;
        },
        images: { sandbox: "img" },
        start: (opts: unknown) => {
          started.push(opts);
          state.running = true;
        },
        setInactivityTimeout: async () => {},
        exec: async () => {
          throw new Error("no exec in this double");
        },
        destroy: async () => {
          state.running = false;
        },
      };
    };
    const sandboxFor = (running: boolean) => {
      const durable = new Map<string, unknown>();
      const ctx = {
        container: container(running),
        storage: {
          get: async (key: string) => durable.get(key),
          put: async (key: string, value: unknown) => void durable.set(key, value),
        },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => await fn(),
      };
      return new (SandboxV1 as unknown as new (ctx: unknown, env: unknown) => {
        revoke: () => Promise<{ running: boolean }>;
        runCommand: (cmd: unknown) => Promise<unknown>;
      })(ctx, {});
    };

    // Still running: the revocation lands, and the answer says so (the
    // successor must then leave the PR alone).
    expect(await sandboxFor(true).revoke()).toEqual({ running: true });

    const sandbox = sandboxFor(false);
    expect(await sandbox.revoke()).toEqual({ running: false });
    // The revoked attempt cannot provision a container — every start path goes
    // through the one gate, and a replay cannot resurrect it.
    await expect(sandbox.runCommand(shellCommand("true"))).rejects.toThrow(/revoked/);
    expect(contexts.at(-1)!.started).toHaveLength(0);
  });
});

describe("§7.9 an already-issued request is reconciled, never resent", () => {
  test("a fresh claim reads the owned run back and sends no second terminal update", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const attemptId = attempt.identity.attemptId;
    // The run this attempt already created and proved (the delivery attach's
    // shape): a terminal update was issued for it, but its reply was lost, so
    // the row carries the frozen intent and no observation.
    await setCheckCreateState(db, attemptId, lease, "sending", undefined, CLAIM_AT);
    expect(await attachCheckRunId(db, attemptId, lease, 4242, CLAIM_AT)).toBe(true);

    const sent: string[] = [];
    const script: AdapterScript = {
      // The request DID land: GitHub already carries the intended conclusion.
      fetch: async (identity) => ({
        kind: "found",
        remote: remoteFor(identity, { id: 4242, status: "completed", conclusion: "failure" }),
      }),
      complete: async () => {
        sent.push("update");
        return { kind: "unavailable", reason: "a second terminal update was sent", requests: 1 };
      },
    };
    const summary = await run(db, {
      now: () => T0,
      credentials: scriptedCredentials(db, script),
      fetchImpl: OFFLINE_FETCH,
    });

    // Zero resends: the readback decided, and `observed` advanced from it.
    expect(sent).toHaveLength(0);
    expect(summary.completed).toBe(1);
    const row = await rawRow(db, attemptId);
    expect(row.observed).toBe("failure");
    expect(row.terminal_ms).not.toBeNull();
    // The reconciliation ran under a FRESH acquisition (epoch bumped), not the
    // dead consumer lease the row was left on.
    expect(row.holder).toBe("check-reconcile");
    expect(Number(row.lease_epoch)).toBe(lease.epoch + 1);
    expect(EXPIRED_DEADLINE).toBeLessThan(T0);
  });
});

/** The PR `makePayload()` names, as `seedInflight` in the consumer suite holds it. */
const PRIOR_KEY: InflightKey = {
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  workspace_id: "default",
};

/** A `persisted` launch row: the paid exec returned, and its container may still run. */
function seedPaidAttempt(db: TestD1, attemptId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_launches
         (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome)
       VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted')`,
    )
    .run(attemptId, 1, 2, 3);
}

function revokedAtOf(db: TestD1, attemptId: string): number | null {
  const row = db.raw
    .prepare("SELECT revoked_ms FROM review_launches WHERE attempt_id = ?")
    .get(attemptId) as { revoked_ms: number | null } | undefined;
  return row?.revoked_ms ?? null;
}

/** The prior attempt's admission row, long expired, with an accounted paid state. */
async function seedPriorRow(db: TestD1): Promise<void> {
  expect(
    await acquireInflight(db, PRIOR_KEY, {
      systemCap: 32,
      workspaceCap: 16,
      attemptId: "attempt-prior",
      ttlSeconds: 60,
      headSha: null,
      now: "2020-01-01T00:00:00.000Z",
    }),
  ).toEqual({ ok: true });
}

describe("§7.9 an already-dispatched terminal update is discovery, never a resend", () => {
  test("a dispatched-but-unlanded update is read back and never sent twice", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const attemptId = attempt.identity.attemptId;
    await setCheckCreateState(db, attemptId, lease, "sending", undefined, CLAIM_AT);
    expect(await attachCheckRunId(db, attemptId, lease, 4242, CLAIM_AT)).toBe(true);

    // Phase 1 — the real dispatch sequence: the lane freezes its intent, then
    // the adapter records the dispatch and the reply is LOST.
    let firstSends = 0;
    const losing: AdapterScript = {
      fetch: async (identity) => ({
        kind: "found",
        remote: remoteFor(identity, { id: 4242, status: "in_progress", conclusion: null }),
      }),
      complete: async (identity) => {
        firstSends += 1;
        const live = await rawRow(db, identity.attemptId);
        await recordTerminalDispatch(
          db,
          identity.attemptId,
          { holder: String(live.holder), epoch: Number(live.lease_epoch), untilMs: Number(live.lease_until_ms) },
          T0,
        );
        return { kind: "unavailable", reason: "the reply was lost", requests: 1 };
      },
    };
    await run(db, { now: () => T0, credentials: scriptedCredentials(db, losing), fetchImpl: OFFLINE_FETCH });
    expect(firstSends).toBe(1);
    expect((await rawRow(db, attemptId)).terminal_dispatch_ms).toBe(T0);

    // Phase 2 — a fresh recovery claim reads the run still `in_progress`. That
    // read is NOT proof the request failed to land, so the update is never
    // re-sent: the intent makes the pass discovery-only.
    let secondSends = 0;
    const resent: AdapterScript = {
      fetch: async () => ({ kind: "found", remote: remoteFor(attempt.identity, { id: 4242, status: "in_progress", conclusion: null }) }),
      complete: async () => {
        secondSends += 1;
        return { kind: "unavailable", reason: "a second terminal update was sent", requests: 1 };
      },
    };
    await run(db, {
      now: () => T0 + 120_000,
      credentials: scriptedCredentials(db, resent),
      fetchImpl: OFFLINE_FETCH,
    });

    expect(secondSends).toBe(0);
    const row = await rawRow(db, attemptId);
    expect(row.terminal_dispatch_ms).toBe(T0);
    expect(row.observed).toBe("unknown");
    // The unconfirmed dispatch is charged so the ladder can end honestly
    // instead of re-reading forever.
    expect(Number(row.attempts)).toBe(2);
  });
});

describe("§7.9 admission is the successor's one gate", () => {
  test("a prior sandbox still running keeps the PR: guard-held, nothing provisioned", async () => {
    const h = createConsumerHarness();
    const db = await createSeededTestD1();
    await seedPriorRow(db);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      getSandbox: async () => ({ ...h.fakeSandbox, revoke: async () => ({ running: true }) }),
    });

    await withFrozenClock(() => consumer(h.makeBatch(makePayload())));

    // The row is expired, so only the stop observation stands between this
    // delivery and a second review of the same PR.
    expect(rowsOf(db)).toEqual(["attempt-prior"]);
    expect(h.sandbox.calls).toHaveLength(0);
    expect(h.commenterCalls).toHaveLength(0);
    expect(h.messageRetryCalls).toEqual([{ attempts: 1, delaySeconds: 60 }]);
    const refusal = h.logLines.find((line) => line.fields.event === "review_succession_refused");
    expect(refusal?.fields.prior_attempt_id).toBe("attempt-prior");
  });

  test("the prior attempt's stopped sandbox admits the successor and the review runs", async () => {
    const h = createConsumerHarness();
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorRow(db);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      getSandbox: async () => ({ ...h.fakeSandbox, revoke: async () => ({ running: false }) }),
    });

    await withFrozenClock(() => consumer(h.makeBatch(makePayload())));

    // Admitted on evidence: the round ran to a published review instead of the
    // guard-held retry the expired row used to force.
    expect(h.sandbox.calls.length).toBeGreaterThan(0);
    expect(h.commenterCalls.length).toBeGreaterThan(0);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.logLines.some((line) => line.fields.event === "review_succession_refused")).toBe(false);
  });
});
