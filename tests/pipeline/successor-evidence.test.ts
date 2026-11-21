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

const { createReviewConsumer, priorSandboxStopped } = await import("../../src/pipeline/consumer");
const { attemptSandboxId } = await import("../../src/pipeline/review-attempt");

const KEY: InflightKey = {
  installation_id: 42,
  owner: "acme",
  repo: "widgets",
  pr_number: 7,
  workspace_id: "ws_1",
};

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LATER = "2026-11-03T00:02:00Z";

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

  test("the stop observation is false unless the prior attempt's own sandbox says so", async () => {
    const asked: string[] = [];
    const getSandboxDouble = (answer: (() => Promise<boolean>) | undefined) => async (_binding: unknown, id: string) => {
      asked.push(id);
      const sandbox: Record<string, unknown> = {
        runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        claimMarker: async () => "written",
        runMarked: async () => ({ kind: "unknown" }),
        destroyMarked: async () => "unknown",
        destroy: async () => {},
      };
      if (answer !== undefined) sandbox.containerRunning = answer;
      return sandbox as never;
    };

    expect(await priorSandboxStopped(getSandboxDouble(async () => false), {}, "attempt-1")).toBe(true);
    // It asked about THAT attempt's sandbox, never the PR or the caller's.
    expect(asked).toEqual([attemptSandboxId("attempt-1")]);

    expect(await priorSandboxStopped(getSandboxDouble(async () => true), {}, "attempt-1")).toBe(false);
    expect(await priorSandboxStopped(getSandboxDouble(undefined), {}, "attempt-1")).toBe(false);
    expect(
      await priorSandboxStopped(
        getSandboxDouble(async () => {
          throw new Error("the sandbox read failed");
        }),
        {},
        "attempt-1",
      ),
    ).toBe(false);
    expect(
      await priorSandboxStopped(async () => {
        throw new Error("the sandbox could not be addressed");
      }, {}, "attempt-1"),
    ).toBe(false);
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

describe("§7.9 admission is the successor's one gate", () => {
  test("a prior sandbox still running keeps the PR: guard-held, nothing provisioned", async () => {
    const h = createConsumerHarness();
    const db = await createSeededTestD1();
    await seedPriorRow(db);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      getSandbox: async () => ({ ...h.fakeSandbox, containerRunning: async () => true }),
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
      getSandbox: async () => ({ ...h.fakeSandbox, containerRunning: async () => false }),
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
