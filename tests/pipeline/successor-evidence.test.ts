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

const { createReviewConsumer, priorAttemptStopEvidence } = await import("../../src/pipeline/consumer");
const { attemptSandboxId, markAttemptRevoked, readAttemptActivation, reviewAttemptSandbox } = await import(
  "../../src/pipeline/review-attempt",
);
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
    // The successor's evidence step: the attempt's container answered
    // not-running, and the revocation landed durably.
    expect(await markAttemptRevoked(db, "attempt-1", 5)).toBe(true);
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

  test("the successor's two facts: win the activation claim, or that container answers not-running", async () => {
    const asked: string[] = [];
    const getSandboxDouble = (answer: (() => Promise<{ revoked: boolean; running: boolean }>) | undefined) =>
      async (_binding: unknown, id: string) => {
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

    // Fact A: nothing ever activated this attempt, so the guarded claim wins,
    // the row is written by the claim, and no container is even addressed.
    const empty = createMigratedTestD1();
    expect(await priorAttemptStopEvidence(empty, getSandboxDouble(async () => ({ revoked: true, running: false })), {}, "attempt-1")).toBe(
      "no-container",
    );
    expect(asked).toEqual([]);
    expect(await readAttemptActivation(empty, "attempt-1")).toEqual({
      sandboxId: attemptSandboxId("attempt-1"),
      activated: false,
      revoked: true,
    });

    // A cleanup-owned row (never activated) is claimed the same way.
    const db = createMigratedTestD1();
    seedUnactivatedAttempt(db, "attempt-2");
    expect(await priorAttemptStopEvidence(db, getSandboxDouble(async () => ({ revoked: true, running: false })), {}, "attempt-2")).toBe(
      "no-container",
    );

    // Fact B: the attempt activated, so the claim loses and its OWN container is
    // asked — on the id the provisioning row minted.
    seedProvisionedAttempt(db, "attempt-1", "review-minted-by-the-claim");
    expect(await priorAttemptStopEvidence(db, getSandboxDouble(async () => ({ revoked: true, running: false })), {}, "attempt-1")).toBe("revoked");
    expect(asked).toEqual(["review-minted-by-the-claim"]);
    // The durable mark landed with the observation.
    expect((await readAttemptActivation(db, "attempt-1"))?.revoked).toBe(true);

    // A live container: nothing is revoked and the hold stands.
    seedProvisionedAttempt(db, "attempt-3");
    expect(await priorAttemptStopEvidence(db, getSandboxDouble(async () => ({ revoked: false, running: true })), {}, "attempt-3")).toBe(
      "running",
    );
    expect((await readAttemptActivation(db, "attempt-3"))?.revoked).toBe(false);

    // A failed revoke is not a stop; nor is an absent capability, a throw, or a
    // row that carries no minted handle.
    seedProvisionedAttempt(db, "attempt-4");
    expect(
      await priorAttemptStopEvidence(
        db,
        getSandboxDouble(async () => {
          throw new Error("the revocation write failed");
        }),
        {},
        "attempt-4",
      ),
    ).toBe("unavailable");
    expect(await priorAttemptStopEvidence(db, getSandboxDouble(undefined), {}, "attempt-4")).toBe("unavailable");
    db.raw.prepare("UPDATE review_launches SET sandbox_id = NULL WHERE attempt_id = ?").run("attempt-4");
    expect(
      await priorAttemptStopEvidence(db, getSandboxDouble(async () => ({ revoked: true, running: false })), {}, "attempt-4"),
    ).toBe("unavailable");
  });

  test("no start path can obtain a handle without winning the activation", async () => {
    const addressed: string[] = [];
    const getSandbox = async (_binding: unknown, id: string) => {
      addressed.push(id);
      return { revoke: async () => ({ revoked: true, running: false }) } as never;
    };
    const db = createMigratedTestD1();
    const deps = { env: { SANDBOX: {}, DB: db }, getSandbox };

    // No row: nothing activated, so no container may be addressed.
    await expect(reviewAttemptSandbox(deps, "attempt-1")).rejects.toThrow(/activation/);
    expect(addressed).toEqual([]);

    // A row that never activated (a successor's claim, a cleanup claim) is the
    // same refusal: it exists, and it still may not start anything.
    seedUnactivatedAttempt(db, "attempt-2");
    await expect(reviewAttemptSandbox(deps, "attempt-2")).rejects.toThrow(/activation/);

    // Activated and revoked is also a refusal — the successor owns the future.
    seedProvisionedAttempt(db, "attempt-3");
    await claimUnactivatedAttemptFor(db, "attempt-3");
    await expect(reviewAttemptSandbox(deps, "attempt-3")).rejects.toThrow(/revoked/);

    // Activated and not revoked: the handle is the id the CLAIM minted.
    seedProvisionedAttempt(db, "attempt-4", "review-minted-by-the-claim");
    await reviewAttemptSandbox(deps, "attempt-4");
    expect(addressed).toEqual(["review-minted-by-the-claim"]);
  });

  test("a provisioned, unobserved attempt holds its slot — `provisioned` is not free", async () => {
    const db = createMigratedTestD1();
    // A container is created BEFORE the paid call, so a provisioning row with
    // no `launched` row may be running right now.
    seedProvisionedAttempt(db, "attempt-1");
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    expect(
      await acquireInflight(db, otherPr(8), { ...OPTS, attemptId: "attempt-2", systemCap: 1, now: LATER }),
    ).toEqual({ ok: false, reason: "system-cap" });
    // Only the observed stop frees it (a successor revoked in the same
    // transition that moved the PR).
    db.raw.prepare("UPDATE review_launches SET revoked_ms = ? WHERE attempt_id = ?").run(T0, "attempt-1");
    expect(
      await acquireInflight(db, otherPr(8), { ...OPTS, attemptId: "attempt-2", systemCap: 1, now: LATER }),
    ).toEqual({ ok: true });
  });

  test("capacity counts what may still run: a paid, unrevoked attempt holds its slot", async () => {
    const db = createMigratedTestD1();
    seedPaidAttempt(db, "attempt-1");
    expect(await acquireInflight(db, KEY, OPTS)).toEqual({ ok: true });
    expect(
      await acquireInflight(db, otherPr(8), { ...OPTS, attemptId: "attempt-2", systemCap: 1, now: LATER }),
    ).toEqual({ ok: false, reason: "system-cap" });
    db.raw.prepare("UPDATE review_launches SET revoked_ms = ? WHERE attempt_id = ?").run(T0, "attempt-1");
    expect(
      await acquireInflight(db, otherPr(8), { ...OPTS, attemptId: "attempt-2", systemCap: 1, now: LATER }),
    ).toEqual({ ok: true });
  });

  test("a live container is left alone; a stopped one is revoked and can never start again", async () => {
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
        revoke: () => Promise<{ revoked: boolean; running: boolean }>;
        runCommand: (cmd: unknown) => Promise<unknown>;
      })(ctx, {});
    };

    // Still running: the observation is taken, NOTHING is revoked, and the
    // successor must leave the PR with that holder.
    expect(await sandboxFor(true).revoke()).toEqual({ revoked: false, running: true });

    const sandbox = sandboxFor(false);
    expect(await sandbox.revoke()).toEqual({ revoked: true, running: false });
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

/** A provisioning row: the attempt ACTIVATED (so it may start), paid exec unsent. */
function seedProvisionedAttempt(db: TestD1, attemptId: string, sandboxId = attemptSandboxId(attemptId)): void {
  db.raw
    .prepare(
      `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, sandbox_id, activated_ms)
       VALUES (?, 'provisioned', ?, ?, ?)`,
    )
    .run(attemptId, 1, sandboxId, 2);
}

/** A row that never activated: a cleanup claim, or a successor's own claim. */
function seedUnactivatedAttempt(db: TestD1, attemptId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, abandoned_at_ms, sandbox_id)
       VALUES (?, 'abandoned', 1, 2, ?)`,
    )
    .run(attemptId, attemptSandboxId(attemptId));
}

/** Win the successor claim over an activated attempt (what a prior takeover left). */
async function claimUnactivatedAttemptFor(db: TestD1, attemptId: string): Promise<void> {
  db.raw.prepare("UPDATE review_launches SET revoked_ms = 3 WHERE attempt_id = ?").run(attemptId);
}

/** A `persisted` launch row: the paid exec returned, and its container may still run. */
function seedPaidAttempt(db: TestD1, attemptId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_launches
         (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome, sandbox_id, activated_ms)
       VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted', ?, ?)`,
    )
    .run(attemptId, 1, 2, 3, attemptSandboxId(attemptId), 1);
}

function revokedAtOf(db: TestD1, attemptId: string): number | null {
  const row = db.raw
    .prepare("SELECT revoked_ms FROM review_launches WHERE attempt_id = ?")
    .get(attemptId) as { revoked_ms: number | null } | undefined;
  return row?.revoked_ms ?? null;
}

/** The prior attempt's admission row, long expired. `activated` also gives it a container. */
async function seedPriorRow(db: TestD1, { activated = true }: { activated?: boolean } = {}): Promise<void> {
  // Its row IS the precondition an observation needs — and the capacity it took
  // is not free.
  if (activated) seedProvisionedAttempt(db, "attempt-prior");
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
  test("a successor that loses to an activation leaves the PR with its holder", async () => {
    const h = createConsumerHarness();
    const db = await createSeededTestD1();
    await seedPriorRow(db);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      getSandbox: async () => ({ ...h.fakeSandbox, revoke: async () => ({ revoked: false, running: true }) }),
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
    expect(refusal?.fields.succession).toBe("running");
    // The observation revoked nothing: the holder keeps its authority.
    expect(revokedAtOf(db, "attempt-prior")).toBeNull();
  });

  test("a successor that wins the claim takes over an attempt that never activated", async () => {
    const h = createConsumerHarness();
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorRow(db, { activated: false });
    const addressed: string[] = [];
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      // The prior attempt's handle may never be addressed: no container was ever
      // created for it, and the won claim is what says so.
      getSandbox: async (_binding: unknown, id: string) => {
        addressed.push(id);
        if (id === attemptSandboxId("attempt-prior")) throw new Error("that attempt never activated");
        return h.fakeSandbox;
      },
    });

    await withFrozenClock(() => consumer(h.makeBatch(makePayload())));

    expect(addressed).not.toContain(attemptSandboxId("attempt-prior"));
    expect(h.commenterCalls.length).toBeGreaterThan(0);
    expect(h.messageRetryCalls).toHaveLength(0);
    // The CLAIM wrote the row (abandoned, revoked) — the fact that frees the PR.
    const row = db.raw
      .prepare("SELECT state, activated_ms, revoked_ms FROM review_launches WHERE attempt_id = ?")
      .get("attempt-prior") as { state: string; activated_ms: number | null; revoked_ms: number | null };
    expect(row.state).toBe("abandoned");
    expect(row.activated_ms).toBeNull();
    expect(row.revoked_ms).not.toBeNull();
  });

  test("a failed revoke does not proceed: the PR stays with its holder", async () => {
    const h = createConsumerHarness();
    const db = await createSeededTestD1();
    await seedPriorRow(db);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      getSandbox: async () => ({
        ...h.fakeSandbox,
        revoke: async () => {
          throw new Error("the revocation write failed");
        },
      }),
    });

    await withFrozenClock(() => consumer(h.makeBatch(makePayload())));

    expect(rowsOf(db)).toEqual(["attempt-prior"]);
    expect(revokedAtOf(db, "attempt-prior")).toBeNull();
    expect(h.sandbox.calls).toHaveLength(0);
    const refusal = h.logLines.find((line) => line.fields.event === "review_succession_refused");
    expect(refusal?.fields.succession).toBe("unavailable");
  });

  test("the prior attempt's stopped sandbox admits the successor and the review runs", async () => {
    const h = createConsumerHarness();
    h.sandbox.runnerStdout = JSON.stringify(VALID_OUTPUT);
    const db = await createSeededTestD1();
    await seedPriorRow(db);
    const consumer = createReviewConsumer(await h.makeEnv({ DB: db as never }), h.testLog, {
      ...h.overrides,
      getSandbox: async () => ({ ...h.fakeSandbox, revoke: async () => ({ revoked: true, running: false }) }),
    });

    await withFrozenClock(() => consumer(h.makeBatch(makePayload())));

    // Admitted on evidence: the round ran to a published review instead of the
    // guard-held retry the expired row used to force.
    expect(h.sandbox.calls.length).toBeGreaterThan(0);
    expect(h.commenterCalls.length).toBeGreaterThan(0);
    expect(h.messageRetryCalls).toHaveLength(0);
    expect(h.logLines.some((line) => line.fields.event === "review_succession_refused")).toBe(false);
    // Observed not-running → revoked and succeeded in ONE transition.
    expect(revokedAtOf(db, "attempt-prior")).not.toBeNull();
  });
});
