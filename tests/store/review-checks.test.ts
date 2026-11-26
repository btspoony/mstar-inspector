import { RECONCILE_DEFAULTS } from "../../src/contracts/reconcile-settings";
import { describe, expect, test } from "bun:test";
import {
  claimPublication,
  type Lease,
  type PublicationPayload,
  type PublicationProof,
  recordPublicationProof,
  stagePublication,
} from "../../src/store/finding-lifecycle";
import {
  adoptReleasedCheckAttempt,
  attemptKey,
  attachCheckRunId,
  CHECK_ATTACH_GRACE_MS,
  CHECK_ATTACH_WINDOW_MS,
  CHECK_BACKOFF_MS,
  CHECK_EXTERNAL_ID_PREFIX,
  CHECK_LEASE_MS,
  CHECK_NAME,
  CHECK_RECOVERY_LEASE_MS,
  type CheckAttempt,
  type CheckConclusion,
  type CheckRemote,
  claimAttachedCheckForSettlement,
  claimAttempt,
  claimCheckRecovery,
  deferCheckRecovery,
  externalIdFor,
  getCheckAttempt,
  getCheckOwnership,
  linkCheckPublication,
  listCheckReconcileBatch,
  markCheckLocalError,
  markCheckQueuedBehindInflight,
  type PublicationProof as _UnusedProof,
  readPublicationProof,
  recordCheckObservation,
  reenableChecksForApps,
  checkSuspensionKindOf,
  checkSuspensionReason,
  listReenableableCheckPairs,
  releaseAttachedCheck,
  releaseCheckClaim,
  suspendCheckForPause,
  releaseExpiredCheckClaim,
  rollbackCheckCreateDispatch,
  retryCheckRecovery,
  type ClaimAttemptResult,
  type Scope,
  setCheckCreateState,
  setCheckDesired,
  setCheckFallbackDesired,
  suspendCheckRecovery,
  suspensionCredentialOf,
} from "../../src/store/review-checks";
import { createMigratedTestD1, type TestD1 } from "./helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const APP_NUMERIC_ID = 1001;
const OTHER_NUMERIC_APP_ID = 1002;
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;
const DEADLINE = T0 + CHECK_LEASE_MS;

function seedApp(db: TestD1, id: string, githubAppId: number): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, githubAppId, `checks-test-${id}`);
}

function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  seedApp(db, APP_ID, APP_NUMERIC_ID);
  seedApp(db, OTHER_APP_ID, OTHER_NUMERIC_APP_ID);
  return db;
}

function seedPublicationRow(db: TestD1, id: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, created_ms, updated_ms)
       VALUES (?, ?, 123, 'acme', 'widgets', 42, ?, 'review', 'prepared', '{}', ?, ?)`,
    )
    .run(id, APP_ID, SHA, T0, T0);
}

type ClaimInput = Parameters<typeof claimAttempt>[1];

function claimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    scope: SCOPE,
    githubAppId: APP_NUMERIC_ID,
    headSha: SHA,
    triggeredBy: "octocat",
    action: "review",
    holder: "run-a",
    nowMs: T0,
    executionDeadlineMs: DEADLINE,
    ...overrides,
  };
}

function attemptOfClaim(result: ClaimAttemptResult): CheckAttempt {
  if (result.kind === "absent") throw new Error("fixture: the claim found no row for the key");
  return result.attempt;
}

async function claim(
  db: TestD1,
  overrides: Partial<ClaimInput> = {},
): Promise<{ attempt: CheckAttempt; lease: Lease }> {
  const result = await claimAttempt(db, claimInput(overrides));
  if (result.kind !== "claimed") {
    throw new Error(`expected a claimed attempt, got ${result.kind}`);
  }
  return result;
}

async function attachRun(db: TestD1, id: string, lease: Lease, runId = 4242, now = T0): Promise<void> {
  expect(await setCheckCreateState(db, id, lease, "sending", undefined, now)).toBe(true);
  expect(await attachCheckRunId(db, id, lease, runId, now)).toBe(true);
}

function omit<T extends Record<string, unknown>>(obj: T, key: keyof T & string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy;
}

function remoteFor(
  attempt: CheckAttempt,
  overrides: {
    id?: number;
    name?: string;
    head_sha?: string;
    external_id?: string | null;
    app?: { id: number } | null;
    status?: string;
    conclusion?: string | null;
    summary?: string | null;
  } = {},
  intent: CheckConclusion["desired"] = "success",
): CheckRemote {
  const identity = attempt.identity;
  return {
    id: overrides.id ?? 4242,
    name: overrides.name ?? CHECK_NAME,
    head_sha: overrides.head_sha ?? identity.headSha,
    external_id: "external_id" in overrides ? (overrides.external_id ?? null) : identity.externalId,
    app: overrides.app === undefined ? { id: identity.githubAppId } : overrides.app,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined ? intent : overrides.conclusion,
    summary: overrides.summary === undefined ? null : overrides.summary,
  };
}

const CONCLUSION: CheckConclusion = {
  desired: "success",
  title: CHECK_NAME,
  summary: "Review published for 0123456 (round 1). Execution completion only.",
};

const FAILURE: CheckConclusion = {
  desired: "failure",
  title: CHECK_NAME,
  summary: "Review attempt could not be confirmed complete; publication status is unknown.",
};

async function rawRow(db: TestD1, id: string): Promise<Record<string, string | number | null>> {
  return (await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(id).first()) as Record<
    string,
    string | number | null
  >;
}

async function rowCount(db: TestD1): Promise<number> {
  return ((await db.prepare(`SELECT COUNT(*) AS n FROM review_checks`).first()) as { n: number }).n;
}

describe("attemptKey / externalIdFor (spec §7.9 identity)", () => {
  test("attemptKey is the canonical JSON array in spec order", () => {
    expect(
      attemptKey({
        appId: APP_ID,
        installationId: 123,
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
      }),
    ).toBe(JSON.stringify([APP_ID, 123, "acme", "widgets", 42, SHA, "octocat", "review"]));
  });

  test("every identity component changes the key (no cross-tenant collision)", () => {
    const base = {
      appId: APP_ID,
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
    };
    const key = attemptKey(base);
    expect(attemptKey({ ...base, headSha: `f${SHA.slice(1)}` })).not.toBe(key);
    expect(attemptKey({ ...base, action: "review-requested" })).not.toBe(key);
    expect(attemptKey({ ...base, triggeredBy: "someone-else" })).not.toBe(key);
    expect(attemptKey({ ...base, appId: OTHER_APP_ID })).not.toBe(key);
    expect(attemptKey({ ...base, installationId: 999 })).not.toBe(key);
    expect(attemptKey({ ...base, owner: "Other" })).not.toBe(key);
    expect(attemptKey({ ...base, repo: "other-repo" })).not.toBe(key);
    expect(attemptKey({ ...base, prNumber: 43 })).not.toBe(key);
  });

  test("externalIdFor uses mstar-check:v1:<uuid>:<gen>", () => {
    const id = crypto.randomUUID();
    expect(externalIdFor(id, 1)).toBe(`${CHECK_EXTERNAL_ID_PREFIX}${id}:1`);
    expect(externalIdFor(id, 7)).toBe(`mstar-check:v1:${id}:7`);
  });

  test("externalIdFor refuses a non-UUID id or a non-positive generation", () => {
    expect(() => externalIdFor("attempt-42", 1)).toThrow(/canonical lowercase UUID/);
    expect(() => externalIdFor(crypto.randomUUID().toUpperCase(), 1)).toThrow(/canonical lowercase UUID/);
    expect(() => externalIdFor(crypto.randomUUID(), 0)).toThrow(/positive integer/);
    expect(() => externalIdFor(crypto.randomUUID(), 1.5)).toThrow(/positive integer/);
  });
});

describe("claimAttempt (spec §7.9 claim protocol)", () => {
  test("a fresh claim owns the row: epoch 1, lease equal to the execution deadline, external id stamped", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);

    expect(attempt.identity.generation).toBe(1);
    expect(attempt.identity.externalId).toBe(externalIdFor(attempt.identity.attemptId, 1));
    expect(attempt.identity.scope).toEqual(SCOPE);
    expect(attempt.identity.githubAppId).toBe(APP_NUMERIC_ID);
    expect(attempt.identity.headSha).toBe(SHA);
    expect(lease).toEqual({ holder: "run-a", epoch: 1, untilMs: DEADLINE });
    expect(attempt.executionDeadlineMs).toBe(DEADLINE);
    expect(attempt.desired).toBe("in_progress");
    expect(attempt.observed).toBe("unknown");
    expect(attempt.createState).toBe("not-sent");
    expect(attempt.recoveryState).toBe("pending");
    expect(attempt.checkRunId).toBeNull();
    expect(attempt.terminalMs).toBeNull();
    expect(attempt.attempts).toBe(0);
  });

  test("the claim carries holder and lease in the same statement as the insert", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBe("run-a");
    expect(row.lease_epoch).toBe(1);
    expect(row.lease_until_ms).toBe(DEADLINE);
    expect(row.created_ms).toBe(T0);
    expect(row.updated_ms).toBe(T0);
  });

  test("a nonterminal key is busy for every other holder, returning the ACTIVE row", async () => {
    const db = seededDb();
    const first = await claim(db);
    const second = await claimAttempt(db, claimInput({ holder: "run-b" }));

    expect(second.kind).toBe("busy");
    if (second.kind === "busy") {
      expect(second.attempt.identity.attemptId).toBe(first.attempt.identity.attemptId);
      expect(second.attempt.identity.generation).toBe(1);
      expect(second.attempt.identity.externalId).toBe(first.attempt.identity.externalId);
    }
    expect(await rowCount(db)).toBe(1);
  });

  test("an EXPIRED nonterminal attempt is still busy: expired work belongs to recovery", async () => {
    const db = seededDb();
    const first = await claim(db);
    const later = await claimAttempt(
      db,
      claimInput({ holder: "run-b", nowMs: DEADLINE + 60_000, executionDeadlineMs: DEADLINE + 60_000 + CHECK_LEASE_MS }),
    );
    expect(later.kind).toBe("busy");
    if (later.kind === "busy") expect(later.attempt.identity.attemptId).toBe(first.attempt.identity.attemptId);
    expect(await rowCount(db)).toBe(1);
  });

  test("generation uniqueness survives a simulated race: exactly one claimer wins", async () => {
    const db = seededDb();
    const first = await claim(db);
    const losing: TestD1 = {
      ...db,
      batch: async () => {
        throw new Error("UNIQUE constraint failed: review_checks.attempt_key");
      },
    };
    const lost = await claimAttempt(losing, claimInput({ holder: "run-b" }));
    expect(lost.kind).toBe("busy");
    if (lost.kind === "busy") {
      expect(lost.attempt.identity.attemptId).toBe(first.attempt.identity.attemptId);
      expect(lost.attempt.identity.generation).toBe(1);
    }
    expect(await rowCount(db)).toBe(1);
    const open = db.raw
      .prepare(`SELECT generation, COUNT(*) AS n FROM review_checks WHERE terminal_ms IS NULL GROUP BY generation`)
      .all() as { generation: number; n: number }[];
    expect(open).toEqual([{ generation: 1, n: 1 }]);
  });

  test("the partial unique index is the arbiter: one nonterminal generation per key, terminal history unlimited", () => {
    const db = seededDb();
    const seed = (id: string, generation: number, terminalMs: number | null = null) =>
      db.raw
        .prepare(
          `INSERT INTO review_checks
             (id, bot_id, github_app_id, installation_id, owner, repo, pr_number, head_sha,
              triggered_by, action, attempt_key, generation, external_id, create_state,
              execution_deadline_ms, desired, observed, recovery_state, attempts, terminal_ms, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'u', 'review', 'k', ?, ?, 'not-sent',
                   ?, 'in_progress', 'unknown', 'pending', 0, ?, ?, ?)`,
        )
        .run(id, APP_ID, APP_NUMERIC_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, 42, SHA, generation, `e${generation}`, T0, terminalMs, T0, T0);

    seed("a", 1);
    expect(() => seed("b", 2)).toThrow(/UNIQUE constraint failed: review_checks.attempt_key/);
    db.raw.prepare(`UPDATE review_checks SET terminal_ms = ? WHERE id = 'a'`).run(T0 + 1);
    expect(() => seed("c", 2)).not.toThrow();
    expect(() => seed("d", 2)).toThrow(/UNIQUE constraint failed: review_checks.attempt_key/);
    db.raw.prepare(`UPDATE review_checks SET terminal_ms = ? WHERE terminal_ms IS NULL`).run(T0 + 2);
    expect(() => seed("f", 2, 5)).toThrow(
      /UNIQUE constraint failed: review_checks.attempt_key, review_checks.generation/,
    );
  });

  test("terminal + observed success returns terminal/dedup and retains the remote identity", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(true);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0)).toBe(true);

    const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
    expect(again.kind).toBe("terminal");
    expect(attemptOfClaim(again).identity.attemptId).toBe(id);
    expect(attemptOfClaim(again).identity.externalId).toBe(attempt.identity.externalId);
    expect(attemptOfClaim(again).checkRunId).toBe(4242);
    expect(attemptOfClaim(again).terminalMs).toBe(T0);
    expect(await rowCount(db)).toBe(1);
  });

  test("a PROVEN publication dedups even while the Check observation is still unknown", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const proof = await stageProof(db, crypto.randomUUID(), "review");
    expect(await setCheckDesired(db, id, lease, CONCLUSION, proof.publicationId, T0)).toBe(true);
    expect(await markCheckLocalError(db, id, lease, "gave up", T0)).toBe(true);
    const before = await rawRow(db, id);
    expect(before.observed).toBe("unknown");
    expect(before.publication_id).toBe(proof.publicationId);

    const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
    expect(again.kind).toBe("terminal");
    expect(attemptOfClaim(again).identity.generation).toBe(1);
    expect(await rowCount(db)).toBe(1);
  });

  test("an attempt that ended without publication is retryable as generation 2 with a fresh identity", async () => {
    const db = seededDb();
    const first = await claim(db);
    const id = first.attempt.identity.attemptId;
    await setCheckDesired(db, id, first.lease, FAILURE, null, T0);
    expect(await markCheckLocalError(db, id, first.lease, "recovery exhausted", T0)).toBe(true);

    const second = await claim(db, {
      holder: "run-c",
      nowMs: DEADLINE + 1_000,
      executionDeadlineMs: DEADLINE + 1_000 + CHECK_LEASE_MS,
    });
    expect(second.attempt.identity.generation).toBe(2);
    expect(second.attempt.identity.attemptId).not.toBe(id);
    expect(second.attempt.identity.externalId).toBe(externalIdFor(second.attempt.identity.attemptId, 2));

    const old = await getCheckAttempt(db, id);
    expect(old?.identity.generation).toBe(1);
    expect(old?.identity.externalId).toBe(first.attempt.identity.externalId);
    expect(old?.observed).toBe("unknown");
    expect(old?.terminalMs).toBe(T0);
  });

  test("two reruns of one head claim fresh attempts; the ordinary key is untouched", async () => {
    const db = seededDb();
    const base = {
      appId: APP_ID,
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: SHA,
      triggeredBy: "check_run",
      action: "rerequested",
    };
    const rerun = (rerunCheckRunId: number, holder: string) =>
      claim(db, { triggeredBy: "check_run", action: "rerequested", rerunCheckRunId, holder });

    const first = await rerun(4242, "run-rerun-a");
    const second = await rerun(4243, "run-rerun-b");

    // Each rerun is its own attempt: a shared key would have answered `busy`
    // and the operator would never see the second run.
    expect(first.attempt.identity.generation).toBe(1);
    expect(second.attempt.identity.generation).toBe(1);
    expect(second.attempt.identity.attemptId).not.toBe(first.attempt.identity.attemptId);
    expect((await rawRow(db, second.attempt.identity.attemptId)).attempt_key).toBe(
      attemptKey({ ...base, rerunCheckRunId: 4243 }),
    );
    expect((await rawRow(db, first.attempt.identity.attemptId)).attempt_key).not.toBe(
      (await rawRow(db, second.attempt.identity.attemptId)).attempt_key,
    );
    expect(await rowCount(db)).toBe(2);

    // The same rerequested event (GitHub's redelivery) still dedups.
    const duplicate = await claimAttempt(
      db,
      claimInput({ triggeredBy: "check_run", action: "rerequested", rerunCheckRunId: 4243, holder: "run-rerun-c" }),
    );
    expect(duplicate.kind).toBe("busy");

    // An ordinary delivery has no suffix: the canonical tuple stays byte-identical.
    expect(attemptKey({ ...base, triggeredBy: "pull_request", action: "opened" })).toBe(
      JSON.stringify([APP_ID, 123, "acme", "widgets", 42, SHA, "pull_request", "opened"]),
    );
  });

  test("claim refuses a blank holder and a deadline that is not in the future", async () => {
    const db = seededDb();
    await expect(claimAttempt(db, claimInput({ holder: "" }))).rejects.toThrow(/nonblank holder/);
    await expect(claimAttempt(db, claimInput({ executionDeadlineMs: T0 }))).rejects.toThrow(/after the claim time/);
    expect(await rowCount(db)).toBe(0);
  });
});

describe("fenced mutations (spec §7.9)", () => {
  test("every writer refuses a wrong holder, a stale epoch and a wrong lease end", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const stale: Lease = { ...lease, epoch: lease.epoch + 1 };
    const foreign: Lease = { ...lease, holder: "intruder" };
    const shifted: Lease = { ...lease, untilMs: lease.untilMs + 1 };

    expect(await attachCheckRunId(db, id, stale, 1, T0)).toBe(false);
    expect(await attachCheckRunId(db, id, foreign, 1, T0)).toBe(false);
    expect(await attachCheckRunId(db, id, shifted, 1, T0)).toBe(false);
    expect(await setCheckDesired(db, id, stale, CONCLUSION, null, T0)).toBe(false);
    expect(await setCheckDesired(db, id, foreign, CONCLUSION, null, T0)).toBe(false);
    expect(await setCheckCreateState(db, id, foreign, "sending", undefined, T0)).toBe(false);
    expect(await recordCheckObservation(db, id, shifted, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0)).toBe(false);
    expect(await getCheckOwnership(db, id, stale, T0)).toBeNull();

    const row = await getCheckAttempt(db, id);
    expect(row?.checkRunId).toBeNull();
    expect(row?.desired).toBe("in_progress");
    expect(row?.createState).toBe("not-sent");
    expect(row?.observed).toBe("unknown");
    expect(row?.lease).toEqual(lease);
  });

  test("a lost lease makes every later write a no-op", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const taken = await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(taken).not.toBeNull();

    expect(await attachCheckRunId(db, id, lease, 4242, T0)).toBe(false);
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(false);
    expect(await deferCheckRecovery(db, id, lease, { state: "remote-unconfirmed", nextAttemptMs: T0, reason: "x" }, T0)).toBe(false);
    expect(await markCheckLocalError(db, id, lease, "x", T0)).toBe(false);

    const row = await getCheckAttempt(db, id);
    expect(row?.checkRunId).toBeNull();
    expect(row?.desired).toBe("in_progress");
    expect(row?.lease?.holder).toBe("reconciler");
    expect(row?.lease?.epoch).toBe(2);
  });

  test("terminal rows accept no further mutation (history is never overwritten)", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0)).toBe(true);
    expect((await getCheckAttempt(db, id))?.terminalMs).not.toBeNull();

    expect(await setCheckDesired(db, id, lease, FAILURE, null, T0)).toBe(false);
    expect(await attachCheckRunId(db, id, lease, 9999, T0)).toBe(false);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0)).toBe(false);
    const after = await getCheckAttempt(db, id);
    expect(after?.desired).toBe("success");
    expect(after?.observed).toBe("success");
    expect(after?.checkRunId).toBe(4242);
  });

  test("an attached remote id is never replaced, and re-attaching the same id is idempotent", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect((await getCheckAttempt(db, id))?.createState).toBe("known");
    expect(await attachCheckRunId(db, id, lease, 9999, T0)).toBe(false);
    expect((await getCheckAttempt(db, id))?.checkRunId).toBe(4242);
    expect(await attachCheckRunId(db, id, lease, 4242, T0)).toBe(true);
    expect((await getCheckAttempt(db, id))?.checkRunId).toBe(4242);
  });

  test("attachCheckRunId rejects a non-positive id", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    await expect(attachCheckRunId(db, attempt.identity.attemptId, lease, 0, T0)).rejects.toThrow(/positive integer/);
    await expect(attachCheckRunId(db, attempt.identity.attemptId, lease, -3, T0)).rejects.toThrow(/positive integer/);
  });

  test("create_state advances for the send lifecycle without clearing a known id", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, T0)).toBe(true);
    expect((await getCheckAttempt(db, id))?.createState).toBe("sending");
    expect(await setCheckCreateState(db, id, lease, "unknown", "socket closed", T0)).toBe(true);
    expect((await getCheckAttempt(db, id))?.createState).toBe("unknown");
    expect((await rawRow(db, id)).last_error).toBe("socket closed");
    await attachRun(db, id, lease);
    expect(await setCheckCreateState(db, id, lease, "not-sent", undefined, T0)).toBe(false);
    const row = await getCheckAttempt(db, id);
    expect(row?.createState).toBe("known");
    expect(row?.checkRunId).toBe(4242);
  });

  test("deferCheckRecovery changes only recovery state, backoff and the error", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(
      await deferCheckRecovery(
        db,
        id,
        lease,
        { state: "remote-unconfirmed", nextAttemptMs: T0 + CHECK_BACKOFF_MS[0]!, reason: "403 checks:write missing" },
        T0,
      ),
    ).toBe(true);
    const row = await rawRow(db, id);
    expect(row.desired).toBe("in_progress");
    expect(row.observed).toBe("unknown");
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("403 checks:write missing");
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(await listCheckReconcileBatch(db, T0 + CHECK_BACKOFF_MS[0]!, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    expect(await listCheckReconcileBatch(db, T0 + CHECK_BACKOFF_MS[0]! - 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
  });

  test("linkCheckPublication writes ONLY the publication link under the live fence", async () => {
    const db = seededDb();
    seedPublicationRow(db, "publication-a");
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const before = await rawRow(db, id);

    expect(await linkCheckPublication(db, id, lease, "publication-a", T0)).toBe(true);

    expect(await rawRow(db, id)).toEqual({ ...before, publication_id: "publication-a" });
  });

  test("linkCheckPublication refuses a foreign, stale or expired lease and a terminal row", async () => {
    const db = seededDb();
    seedPublicationRow(db, "publication-a");
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;

    expect(await linkCheckPublication(db, id, { ...lease, holder: "intruder" }, "publication-a", T0)).toBe(false);
    expect(await linkCheckPublication(db, id, { ...lease, epoch: lease.epoch + 1 }, "publication-a", T0)).toBe(false);
    expect(await linkCheckPublication(db, id, { ...lease, untilMs: lease.untilMs + 1 }, "publication-a", T0)).toBe(false);
    expect(await linkCheckPublication(db, id, lease, "publication-a", lease.untilMs)).toBe(false);
    expect((await rawRow(db, id)).publication_id).toBeNull();

    await attachRun(db, id, lease);
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0)).toBe(true);
    expect((await rawRow(db, id)).terminal_ms).not.toBeNull();
    expect(await linkCheckPublication(db, id, lease, "publication-a", T0)).toBe(false);
    expect((await rawRow(db, id)).publication_id).toBeNull();
  });

  test("setCheckDesired freezes the intent, keeps the row nonterminal and bounds the summary", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await setCheckDesired(db, id, lease, { ...CONCLUSION, summary: "x".repeat(5_000) }, null, T0)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.desired).toBe("success");
    expect(row.desired_title).toBe(CHECK_NAME);
    expect(typeof row.desired_summary).toBe("string");
    expect((row.desired_summary as string).length).toBe(2_000);
    expect(row.terminal_ms).toBeNull();
    expect(row.observed).toBe("unknown");
  });

  test("the frozen summary survives a second, proof-linked write of the same intent", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const proof = await stageProof(db, crypto.randomUUID(), "review");
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(true);
    expect(await setCheckDesired(db, id, lease, CONCLUSION, proof.publicationId, T0)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.desired).toBe("success");
    expect(row.publication_id).toBe(proof.publicationId);
  });

  test("terminal intent is monotonic; a positive proof correction is the only exception", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await setCheckDesired(db, id, lease, FAILURE, null, T0)).toBe(true);

    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(false);
    expect((await getCheckAttempt(db, id))?.desired).toBe("failure");
    expect(
      await setCheckDesired(db, id, lease, { desired: "neutral", title: CHECK_NAME, summary: "s" }, null, T0),
    ).toBe(false);
    expect((await getCheckAttempt(db, id))?.desired).toBe("failure");

    const proof = await stageProof(db, crypto.randomUUID(), "review");
    expect(
      await setCheckDesired(db, id, lease, { desired: "neutral", title: CHECK_NAME, summary: "s" }, proof.publicationId, T0),
    ).toBe(true);
    const corrected = await rawRow(db, id);
    expect(corrected.desired).toBe("neutral");
    expect(corrected.publication_id).toBe(proof.publicationId);
    expect(corrected.observed).toBe("unknown");
    expect(await setCheckDesired(db, id, lease, FAILURE, proof.publicationId, T0)).toBe(false);
  });

  test("recordCheckObservation requires full identity agreement", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);

    const rejections: CheckRemote[] = [
      remoteFor(attempt, { app: { id: OTHER_NUMERIC_APP_ID } }, "success"),
      remoteFor(attempt, { head_sha: `f${SHA.slice(1)}` }, "success"),
      remoteFor(attempt, { external_id: "mstar-check:v1:other:1" }, "success"),
      remoteFor(attempt, { external_id: null }, "success"),
      remoteFor(attempt, { name: "some-other-check" }, "success"),
      remoteFor(attempt, { app: null }, "success"),
      remoteFor(attempt, { conclusion: "failure" }, "success"),
      remoteFor(attempt, { status: "completed", conclusion: "cancelled" }, "success"),
    ];
    for (const remote of rejections) {
      expect(await recordCheckObservation(db, id, lease, remote, T0)).toBe(false);
      expect((await getCheckAttempt(db, id))?.observed).toBe("unknown");
    }
    await attachRun(db, id, lease);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { id: 777 }, "success"), T0)).toBe(false);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");
    expect(row.terminal_ms).toBe(T0);
    expect(row.check_run_id).toBe(4242);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
  });

  test("a completed reply is a delivery only when it carries the frozen text", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(true);

    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: null }, "success"), T0)).toBe(false);
    expect((await getCheckAttempt(db, id))?.observed).toBe("unknown");
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: "Review failed." }, "success"), T0)).toBe(false);
    const unread = await getCheckAttempt(db, id);
    expect(unread?.observed).toBe("unknown");
    expect(unread?.terminalMs).toBeNull();

    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0)).toBe(true);
    const delivered = await getCheckAttempt(db, id);
    expect(delivered?.observed).toBe("success");
    expect(delivered?.terminalMs).toBe(T0);
  });

  test("an in-progress observation attaches the id but never terminalizes", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(
      await recordCheckObservation(db, id, lease, remoteFor(attempt, { status: "in_progress", conclusion: null }), T0),
    ).toBe(true);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("in_progress");
    expect(row.check_run_id).toBe(4242);
    expect(row.create_state).toBe("known");
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(
      await recordCheckObservation(db, id, lease, remoteFor(attempt, { status: "in_progress", conclusion: null }), T0),
    ).toBe(false);
  });
});

describe("setCheckFallbackDesired (give-up fallback, spec §7.9/§7.10)", () => {
  const GATE_FAILURE: CheckConclusion = {
    desired: "failure",
    title: CHECK_NAME,
    summary: `Review gate missed for ${SHA.slice(0, 7)}: verdict "needs fixes", score 40 (floor 80; allowed: ship it).`,
  };

  test("the first frozen intent is immutable in either write order", async () => {
    {
      const db = seededDb();
      const { attempt, lease } = await claim(db);
      const id = attempt.identity.attemptId;
      expect(await setCheckFallbackDesired(db, id, lease, FAILURE, T0)).toBe(true);
      expect(await setCheckDesired(db, id, lease, GATE_FAILURE, null, T0)).toBe(true);
      const row = await rawRow(db, id);
      expect(row.desired).toBe("failure");
      expect(row.desired_summary).toBe(FAILURE.summary);
    }
    {
      const db = seededDb();
      const { attempt, lease } = await claim(db);
      const id = attempt.identity.attemptId;
      expect(await setCheckDesired(db, id, lease, GATE_FAILURE, null, T0)).toBe(true);
      expect(await setCheckFallbackDesired(db, id, lease, FAILURE, T0)).toBe(false);
      const row = await rawRow(db, id);
      expect(row.desired).toBe("failure");
      expect(row.desired_summary).toBe(GATE_FAILURE.summary);
    }
  });
});

describe("claimCheckRecovery (spec §7.9/§7.11.2)", () => {
  test("the claim repeats the FULL selector predicate, not just liveness", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const beforeDeadline = DEADLINE - 1;

    db.raw.prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?`).run(id);
    expect(await claimCheckRecovery(db, id, "reconciler", beforeDeadline, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();

    expect(await claimCheckRecovery(db, id, "reconciler", DEADLINE, RECONCILE_DEFAULTS.checkMaxAttempts)).not.toBeNull();

    const second = await claim(db, { action: "second" });
    const sid = second.attempt.identity.attemptId;
    await setCheckDesired(db, sid, second.lease, CONCLUSION, null, T0);
    expect(
      await deferCheckRecovery(db, sid, second.lease, { state: "pending", nextAttemptMs: 0, reason: "release" }, T0),
    ).toBe(true);
    db.raw.prepare(`UPDATE review_checks SET next_attempt_ms = ? WHERE id = ?`).run(DEADLINE + 1_000, sid);
    expect(await claimCheckRecovery(db, sid, "reconciler", DEADLINE, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();
    expect(await claimCheckRecovery(db, sid, "reconciler", DEADLINE + 1_000, RECONCILE_DEFAULTS.checkMaxAttempts)).not.toBeNull();
  });

  test("the claim refuses a row at the attempt cap", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    db.raw.prepare(`UPDATE review_checks SET attempts = ? WHERE id = ?`).run(RECONCILE_DEFAULTS.checkMaxAttempts, id);
    expect(await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();
    expect(await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts + 1)).not.toBeNull();
  });

  test("releaseCheckClaim gives a claim back with nothing else moved", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    const recovery = await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(recovery).not.toBeNull();
    const before = await rawRow(db, id);

    expect(await releaseCheckClaim(db, id, recovery!, DEADLINE + 1)).toBe(true);
    const after = await rawRow(db, id);
    expect(after.holder).toBeNull();
    expect(after.lease_until_ms).toBeNull();
    expect(after.attempts).toBe(before.attempts);
    expect(after.next_attempt_ms).toBe(before.next_attempt_ms);
    expect(after.desired).toBe(before.desired);
    expect(after.observed).toBe(before.observed);
    expect(after.last_error).toBe(before.last_error);
    expect(after.publication_id).toBe(before.publication_id);
    expect(await listCheckReconcileBatch(db, DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    expect(await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts)).not.toBeNull();
  });

  test("releaseCheckClaim is a no-op once the lease has moved", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    const recovery = await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts);
    const stale: Lease = { holder: "reconciler", epoch: recovery!.epoch - 1, untilMs: recovery!.untilMs };
    expect(await releaseCheckClaim(db, id, stale, DEADLINE + 1)).toBe(false);
    expect((await rawRow(db, id)).holder).toBe("reconciler");
  });

  test("a live holder's lease is never taken", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    expect(await claimCheckRecovery(db, attempt.identity.attemptId, "reconciler", T0 + 1_000, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();
    const row = await getCheckAttempt(db, attempt.identity.attemptId);
    expect(row?.lease?.holder).toBe("run-a");
    expect(row?.lease?.epoch).toBe(1);
    expect(row?.attempts).toBe(0);
  });

  test("an expired lease is reacquired with a new epoch; the execution deadline never moves", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const id = attempt.identity.attemptId;
    const later = DEADLINE + 5_000;
    const lease = await claimCheckRecovery(db, id, "reconciler", later, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(lease).toEqual({ holder: "reconciler", epoch: 2, untilMs: later + CHECK_RECOVERY_LEASE_MS });
    const row = await getCheckAttempt(db, id);
    expect(row?.executionDeadlineMs).toBe(DEADLINE);
    expect(row?.attempts).toBe(0);
    const staleLease: Lease = { holder: "run-a", epoch: 1, untilMs: DEADLINE };
    expect(await setCheckCreateState(db, id, staleLease, "unknown", "lost", later)).toBe(false);
    expect(
      await deferCheckRecovery(db, id, lease!, { state: "remote-unconfirmed", nextAttemptMs: later + 60_000, reason: "still down" }, later),
    ).toBe(true);
    expect((await getCheckAttempt(db, id))?.executionDeadlineMs).toBe(DEADLINE);
  });

  test("a released lease is claimable by recovery", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    expect(await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0)).toBe(true);
    const reacquired = await claimCheckRecovery(db, id, "reconciler", T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(reacquired).toEqual({ holder: "reconciler", epoch: 2, untilMs: T0 + 1 + CHECK_RECOVERY_LEASE_MS });
  });

  test("an unknown or already-terminal row cannot be claimed", async () => {
    const db = seededDb();
    expect(await claimCheckRecovery(db, crypto.randomUUID(), "reconciler", T0, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0);
    expect(await claimCheckRecovery(db, id, "reconciler", DEADLINE * 2, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();
  });
});

describe("zero-dispatch rollback and the no-request claim release (integrated seam fix 2)", () => {
  test("a sending mark with no remote id rolls back to not-sent and nothing else moves", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, T0)).toBe(true);
    const before = await rawRow(db, id);

    expect(await rollbackCheckCreateDispatch(db, id, lease, T0 + 1)).toBe(true);
    const after = await rawRow(db, id);
    expect(after.create_state).toBe("not-sent");
    for (const key of [
      "attempts", "next_attempt_ms", "last_error", "desired", "observed", "external_id",
      "generation", "check_run_id", "publication_id", "terminal_ms", "holder",
      "lease_epoch", "lease_until_ms", "bot_id", "installation_id", "owner", "repo",
      "pr_number", "head_sha",
    ]) {
      expect([key, after[key]]).toEqual([key, before[key]]);
    }
  });

  test("the sending mark preserves an existing error instead of fabricating one", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const PRIOR = "check get failed: 502 bad gateway";
    db.raw.prepare(`UPDATE review_checks SET last_error = ? WHERE id = ?`).run(PRIOR, id);

    expect(await setCheckCreateState(db, id, lease, "sending", undefined, T0)).toBe(true);
    expect((await rawRow(db, id)).last_error).toBe(PRIOR);
    expect(await setCheckCreateState(db, id, lease, "unknown", "socket closed", T0)).toBe(true);
    expect((await rawRow(db, id)).last_error).toBe("socket closed");
  });

  test("rollback refuses to disguise a row that already carries a remote id", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, T0)).toBe(true);
    await attachCheckRunId(db, id, lease, 4242, T0);
    db.raw.prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`).run(id);

    expect(await rollbackCheckCreateDispatch(db, id, lease, T0 + 1)).toBe(false);
    const row = await rawRow(db, id);
    expect(row.check_run_id).toBe(4242);
    expect(row.create_state).toBe("sending");
    expect(row.external_id).toBe(attempt.identity.externalId);
  });

  test("rollback is defeated by a newer epoch, leaving the new holder untouched", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, T0)).toBe(true);
    db.raw
      .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = ?, lease_until_ms = ? WHERE id = ?`)
      .run(lease.epoch + 1, T0 + CHECK_RECOVERY_LEASE_MS, id);
    expect(await rollbackCheckCreateDispatch(db, id, lease, T0)).toBe(false);
    const row = await rawRow(db, id);
    expect(row.holder).toBe("other-run");
    expect(row.lease_epoch).toBe(lease.epoch + 1);
    expect(row.create_state).toBe("sending");
  });

  test("releaseExpiredCheckClaim releases an EXPIRED lease that releaseCheckClaim cannot", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    const recovery = await claimCheckRecovery(db, id, "reconciler", T0, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(recovery).not.toBeNull();
    const afterExpiry = recovery!.untilMs + 1;

    expect(await releaseCheckClaim(db, id, recovery!, afterExpiry)).toBe(false);
    expect((await rawRow(db, id)).holder).toBe("reconciler");

    const before = await rawRow(db, id);
    expect(await releaseExpiredCheckClaim(db, id, recovery!, afterExpiry)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(before.attempts);
    expect(row.next_attempt_ms).toBe(before.next_attempt_ms);
    expect(row.desired).toBe(before.desired);
    expect(row.observed).toBe(before.observed);
    expect(row.terminal_ms).toBeNull();
    expect(await listCheckReconcileBatch(db, afterExpiry, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });

  test("releaseExpiredCheckClaim still refuses a newer epoch", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const stale: Lease = { holder: lease.holder, epoch: lease.epoch + 5, untilMs: lease.untilMs };
    expect(await releaseExpiredCheckClaim(db, id, stale, T0)).toBe(false);
    expect((await rawRow(db, id)).holder).toBe(lease.holder);
  });
});

describe("attach grace (spec §7.9)", () => {
  test("a released attach row is due at the grace, not before", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:attach",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    const grace = T0 + CHECK_ATTACH_GRACE_MS;
    expect(await releaseAttachedCheck(db, id, lease, grace, T0)).toBe(true);

    const row = (await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(id).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.next_attempt_ms).toBe(grace);
    expect(row.holder).toBeNull();
    expect(row.create_state).toBe("known");
    expect(row.check_run_id).toBe(4242);
    expect(row.desired).toBe("in_progress");
    expect(row.attempts).toBe(0);

    expect(await listCheckReconcileBatch(db, grace - 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
    expect((await listCheckReconcileBatch(db, grace, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((candidate) => candidate.identity.attemptId)).toEqual([id]);
    expect(await claimCheckRecovery(db, id, "reconciler", grace, RECONCILE_DEFAULTS.checkMaxAttempts)).not.toBeNull();
  });
});

describe("a settled neutral row does not retire the head (spec §7.9)", () => {
  test("a later claim for the same head is a new generation with a new run id", async () => {
    const db = seededDb();
    const first = await claim(db);
    const firstId = first.attempt.identity.attemptId;
    await attachRun(db, firstId, first.lease, 4242);
    expect(
      await setCheckDesired(
        db,
        firstId,
        first.lease,
        { desired: "neutral", title: CHECK_NAME, summary: "review paused" },
        null,
        T0,
      ),
    ).toBe(true);
    expect(
      await recordCheckObservation(
        db,
        firstId,
        first.lease,
        {
          id: 4242,
          name: CHECK_NAME,
          head_sha: SHA,
          external_id: first.attempt.identity.externalId,
          app: { id: APP_NUMERIC_ID },
          status: "completed",
          conclusion: "neutral",
          summary: "review paused",
        },
        T0,
      ),
    ).toBe(true);
    const settled = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(firstId).first()) as Record<
      string,
      string | number | null
    >;
    expect(settled.observed).toBe("neutral");
    expect(settled.terminal_ms).not.toBeNull();
    expect(settled.publication_id).toBeNull();

    const second = await claimAttempt(db, claimInput({ holder: "run-b", nowMs: T0 + 60_000 }));
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") return;
    expect(second.attempt.identity.generation).toBe(2);
    expect(second.attempt.identity.attemptId).not.toBe(firstId);
    expect(second.attempt.identity.externalId).not.toBe(first.attempt.identity.externalId);
  });
});
describe("the settlement claim follows the delivery identity (spec §7.9)", () => {
  const settleAs = (db: TestD1, attachDeliveryId?: string) =>
    claimAttachedCheckForSettlement(db, {
      scope: SCOPE,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId,
      holder: "skip:settler",
      executionDeadlineMs: T0 + CHECK_LEASE_MS,
      nowMs: T0,
    });

  test("a row under the MESSAGE'S OWN delivery holder is taken, without waiting for staleness", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:mine",
      attachDeliveryId: "mine",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    await attachRun(db, attempt.identity.attemptId, lease);

    const taken = await settleAs(db, "mine");
    expect(taken).not.toBeNull();
    expect(taken!.lease.holder).toBe("skip:settler");
    expect(taken!.lease.epoch).toBe(2);
  });

  test("ANOTHER delivery's holder is never taken, fresh or stale", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:other",
      attachDeliveryId: "other",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);

    expect(await settleAs(db, "mine")).toBeNull();
    db.raw.prepare("UPDATE review_checks SET updated_ms = ? WHERE id = ?").run(T0 - 60_000, id);
    expect(await settleAs(db, "mine")).toBeNull();
    const held = await getCheckAttempt(db, id);
    expect(held?.lease?.holder).toBe("delivery:other");
    expect(held?.lease?.epoch).toBe(1);
    expect(await settleAs(db, "other")).not.toBeNull();
  });

  test("a RELEASED row created by this delivery is taken — the budget-expiry arm", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:mine",
      attachDeliveryId: "mine",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await releaseAttachedCheck(db, id, lease, T0 + CHECK_ATTACH_GRACE_MS, T0)).toBe(true);

    const taken = await settleAs(db, "mine");
    expect(taken).not.toBeNull();
    expect(taken!.lease.holder).toBe("skip:settler");
    expect(taken!.attempt.identity.attemptId).toBe(id);
  });

  test("a delivery whose attach found the key owned settles nothing", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:other",
      attachDeliveryId: "other",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    await attachRun(db, attempt.identity.attemptId, lease);

    expect(await settleAs(db, "mine")).toBeNull();
  });

  test("another delivery's RELEASED row is not taken either", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:other",
      attachDeliveryId: "other",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await releaseAttachedCheck(db, id, lease, T0 + CHECK_ATTACH_GRACE_MS, T0)).toBe(true);

    expect(await settleAs(db, "mine")).toBeNull();
    expect(await settleAs(db, "other")).not.toBeNull();
  });
  test("no attach identity settles nothing, even a released row", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:mine",
      attachDeliveryId: "mine",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await releaseAttachedCheck(db, id, lease, T0 + CHECK_ATTACH_GRACE_MS, T0)).toBe(true);

    expect(await settleAs(db, undefined)).toBeNull();
    const released = await getCheckAttempt(db, id);
    expect(released?.lease).toBeNull();
    expect(await settleAs(db, "mine")).not.toBeNull();
  });
});
describe("markCheckQueuedBehindInflight (spec §7.9 held-Check text)", () => {
  const queuedAs = (db: TestD1, attachDeliveryId: string | undefined) =>
    markCheckQueuedBehindInflight(db, {
      scope: SCOPE,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId,
      title: CHECK_NAME,
      summary: "Queued behind the review in flight for this pull request.",
      nowMs: T0 + 1,
    });

  test("this delivery's attached row is relabelled and answers its run id", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:mine",
      attachDeliveryId: "mine",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);

    expect(await queuedAs(db, "mine")).toEqual({ id, checkRunId: 4242 });
    const row = await rawRow(db, id);
    expect(row.desired_title).toBe(CHECK_NAME);
    expect(row.desired_summary).toBe("Queued behind the review in flight for this pull request.");
    expect(row.desired).toBe("in_progress");
    expect(row.observed).toBe("unknown");
    expect(row.terminal_ms).toBeNull();
  });

  test("a foreign attach id relabels nothing — a duplicate delivery shares the key", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:other",
      attachDeliveryId: "other",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);

    expect(await queuedAs(db, "mine")).toBeNull();
    expect(await queuedAs(db, undefined)).toBeNull();
    expect((await rawRow(db, id)).desired_summary).toBeNull();
  });

  test("a row another lane is USING is never relabelled — the creator column is history, not ownership", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:mine",
      attachDeliveryId: "mine",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await releaseAttachedCheck(db, id, lease, T0 + CHECK_ATTACH_GRACE_MS, T0)).toBe(true);
    expect(
      await adoptReleasedCheckAttempt(db, {
        attemptId: id,
        githubAppId: APP_NUMERIC_ID,
        holder: "consumer:other",
        executionDeadlineMs: T0 + CHECK_LEASE_MS,
        nowMs: T0 + 1,
      }),
    ).not.toBeNull();

    expect(await queuedAs(db, "mine")).toBeNull();
    const row = await rawRow(db, id);
    expect(row.desired_title).toBeNull();
    expect(row.desired_summary).toBeNull();
    expect(row.holder).toBe("consumer:other");
    expect(row.desired).toBe("in_progress");
  });

  test("a row an adopting delivery lane holds is refused the same way", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:mine",
      attachDeliveryId: "mine",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await releaseAttachedCheck(db, id, lease, T0 + CHECK_ATTACH_GRACE_MS, T0)).toBe(true);
    expect(
      await adoptReleasedCheckAttempt(db, {
        attemptId: id,
        githubAppId: APP_NUMERIC_ID,
        holder: "delivery:other",
        executionDeadlineMs: T0 + CHECK_LEASE_MS,
        nowMs: T0 + 1,
      }),
    ).not.toBeNull();

    expect(await queuedAs(db, "mine")).toBeNull();
    expect((await rawRow(db, id)).desired_summary).toBeNull();
  });

  test("a terminal row keeps its frozen text", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db, {
      holder: "delivery:mine",
      attachDeliveryId: "mine",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(true);
    expect(
      await recordCheckObservation(db, id, lease, remoteFor(attempt, { summary: CONCLUSION.summary }), T0),
    ).toBe(true);

    expect(await queuedAs(db, "mine")).toBeNull();
    const row = await rawRow(db, id);
    expect(row.desired_summary).toBe(CONCLUSION.summary);
    expect(row.terminal_ms).not.toBeNull();
  });
});

describe("listCheckReconcileBatch (spec §7.11.2 predicate)", () => {
  test("a live claim lease hides a row; the release makes it a candidate", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await listCheckReconcileBatch(db, T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(true);
    expect(await listCheckReconcileBatch(db, T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
    expect(
      await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0),
    ).toBe(true);
    expect((await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((row) => row.identity.attemptId)).toEqual([id]);
  });

  test("backoff, a live recovery lease and the attempt cap are all respected", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    const backoff = T0 + CHECK_BACKOFF_MS[0]!;
    expect(
      await deferCheckRecovery(db, id, lease, { state: "remote-unconfirmed", nextAttemptMs: backoff, reason: "down" }, T0),
    ).toBe(true);
    expect(await listCheckReconcileBatch(db, backoff - 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
    expect(await listCheckReconcileBatch(db, backoff, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);

    const holding = await claimCheckRecovery(db, id, "reconciler", backoff, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(holding).not.toBeNull();
    expect(await listCheckReconcileBatch(db, backoff, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);

    for (let i = 1; i < RECONCILE_DEFAULTS.checkMaxAttempts; i += 1) {
      const at = backoff + i * CHECK_RECOVERY_LEASE_MS + 1_000;
      const next = await claimCheckRecovery(db, id, `reconciler-${i}`, at, RECONCILE_DEFAULTS.checkMaxAttempts);
      expect(next, `recovery claim ${i} should succeed`).not.toBeNull();
      expect(
        await deferCheckRecovery(db, id, next!, { state: "remote-unconfirmed", nextAttemptMs: 0, reason: "again" }, at),
      ).toBe(true);
    }
    expect((await getCheckAttempt(db, id))?.attempts).toBe(RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(await listCheckReconcileBatch(db, backoff + 1_000_000, RECONCILE_DEFAULTS.checkMaxAttempts, 25)).toEqual([]);
    expect(await listCheckReconcileBatch(db, backoff + 1_000_000, RECONCILE_DEFAULTS.checkMaxAttempts + 1, 25)).toHaveLength(1);
  });

  test("a released in_progress attempt is due on its own backoff, before its EXECUTION deadline", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(
      await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0 + 1_000, reason: "release" }, T0),
    ).toBe(true);
    expect(await listCheckReconcileBatch(db, T0 + 999, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
    expect((await listCheckReconcileBatch(db, T0 + 1_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((r) => r.identity.attemptId)).toEqual([id]);
    expect(T0 + 1_000).toBeLessThan(attempt.executionDeadlineMs);
  });

  test("an in_progress attempt nobody released is due only at its EXECUTION deadline", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?`).run(attempt.identity.attemptId);
    expect(await listCheckReconcileBatch(db, attempt.executionDeadlineMs - 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
    expect((await listCheckReconcileBatch(db, attempt.executionDeadlineMs, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((r) => r.identity.attemptId)).toEqual([
      attempt.identity.attemptId,
    ]);
  });

  test("ordering is oldest-due first and the limit is honoured", async () => {
    const db = seededDb();
    const ids: string[] = [];
    for (const [index, pr] of [11, 12, 13].entries()) {
      const { attempt, lease } = await claim(db, { scope: { ...SCOPE, prNumber: pr }, holder: `h${index}` });
      ids.push(attempt.identity.attemptId);
      await setCheckDesired(db, attempt.identity.attemptId, lease, CONCLUSION, null, T0);
      expect(
        await deferCheckRecovery(
          db,
          attempt.identity.attemptId,
          lease,
          { state: "pending", nextAttemptMs: T0 + (2 - index) * 1_000, reason: "schedule" },
          T0,
        ),
      ).toBe(true);
    }
    const batch = await listCheckReconcileBatch(db, T0 + 10_000, RECONCILE_DEFAULTS.checkMaxAttempts, 2);
    expect(batch.map((row) => row.identity.attemptId)).toEqual([ids[2]!, ids[1]!]);
    expect(await listCheckReconcileBatch(db, T0 + 10_000, RECONCILE_DEFAULTS.checkMaxAttempts, 25)).toHaveLength(3);
  });

  test("suspended rows leave the selector and return on re-enable, keeping their identity", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);

    expect(await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId }, "app disabled", T0)).toBe(1);
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
    const suspended = await rawRow(db, id);
    expect(suspended.recovery_state).toBe("suspended");
    expect(suspended.external_id).toBe(attempt.identity.externalId);
    expect(suspended.terminal_ms).toBeNull();
    expect(suspended.desired).toBe("success");

    await reenableChecksForApps(db, [{ appId: APP_ID, installationId: SCOPE.installationId }], T0 + 1);
    expect(await listCheckReconcileBatch(db, T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
    expect((await rawRow(db, id)).recovery_state).toBe("pending");
  });

  test("markCheckLocalError terminalizes under the fence and retains the remote id", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    const recovered = await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(recovered).not.toBeNull();
    expect(await markCheckLocalError(db, id, recovered!, "gave up after 5", DEADLINE + 1)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("local-error");
    expect(row.terminal_ms).toBe(DEADLINE + 1);
    expect(row.attempts).toBe(1);
    expect(row.check_run_id).toBe(4242);
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.observed).toBe("unknown");
    expect(await listCheckReconcileBatch(db, DEADLINE + 1_000, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toEqual([]);
  });
});

describe("tenant and App isolation (spec §7.0)", () => {
  test("another App or installation is a different key; scope mismatch blocks operator retry", async () => {
    const db = seededDb();
    const mine = await claim(db);
    const otherApp = await claim(db, { scope: { ...SCOPE, appId: OTHER_APP_ID }, githubAppId: OTHER_NUMERIC_APP_ID, holder: "run-o" });
    const otherInstallation = await claim(db, { scope: { ...SCOPE, installationId: 555 }, holder: "run-i" });
    expect(otherApp.attempt.identity.attemptId).not.toBe(mine.attempt.identity.attemptId);
    expect(otherInstallation.attempt.identity.attemptId).not.toBe(mine.attempt.identity.attemptId);
    expect(await rowCount(db)).toBe(3);
    expect((await rawRow(db, otherApp.attempt.identity.attemptId)).generation).toBe(1);

    expect(
      await retryCheckRecovery(db, { scope: { ...SCOPE, appId: OTHER_APP_ID }, attemptId: mine.attempt.identity.attemptId, nowMs: T0 }),
    ).toBe(false);
    expect(
      await retryCheckRecovery(db, { scope: { ...SCOPE, repo: "other-repo" }, attemptId: mine.attempt.identity.attemptId, nowMs: T0 }),
    ).toBe(false);
  });

  test("observation refuses a run owned by another App even when the external id matches", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    await setCheckDesired(db, attempt.identity.attemptId, lease, CONCLUSION, null, T0);
    expect(
      await recordCheckObservation(
        db,
        attempt.identity.attemptId,
        lease,
        remoteFor(attempt, { app: { id: OTHER_NUMERIC_APP_ID } }, "success"),
        T0,
      ),
    ).toBe(false);
  });

  test("suspend/reenable bind the exact (bot_id, installation_id) pair", async () => {
    const db = seededDb();
    for (const [index, input] of [
      {},
      { scope: { ...SCOPE, appId: OTHER_APP_ID }, githubAppId: OTHER_NUMERIC_APP_ID, holder: "run-o" },
    ].entries()) {
      const { attempt, lease } = await claim(db, input as Partial<ClaimInput>);
      await setCheckDesired(db, attempt.identity.attemptId, lease, CONCLUSION, null, T0);
      await deferCheckRecovery(db, attempt.identity.attemptId, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0 + index);
    }
    expect(await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId }, "disabled", T0)).toBe(1);
    const suspended = db.raw
      .prepare(`SELECT bot_id, installation_id FROM review_checks WHERE recovery_state = 'suspended'`)
      .all() as { bot_id: string; installation_id: number }[];
    expect(suspended).toEqual([{ app_id: APP_ID, installation_id: SCOPE.installationId }]);
  });

  test("the reconcile batch is not scope-filtered but every row keeps its own authenticated scope", async () => {
    const db = seededDb();
    const a = await claim(db);
    const b = await claim(db, { scope: { ...SCOPE, appId: OTHER_APP_ID }, githubAppId: OTHER_NUMERIC_APP_ID, holder: "run-o" });
    for (const { attempt, lease } of [a, b]) {
      await setCheckDesired(db, attempt.identity.attemptId, lease, CONCLUSION, null, T0);
      await deferCheckRecovery(db, attempt.identity.attemptId, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    }
    const batch = await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit);
    expect(batch.map((row) => row.identity.scope.appId).sort()).toEqual([APP_ID, OTHER_APP_ID].sort());
    expect(batch.find((row) => row.identity.scope.appId === OTHER_APP_ID)?.identity.githubAppId).toBe(OTHER_NUMERIC_APP_ID);
  });
});

describe("publication-proof dedup is EXACT (spec §7.9)", () => {
  function linkPublication(
    db: TestD1,
    id: string,
    publicationId: string,
    fields: {
      appId?: string;
      installationId?: number;
      owner?: string;
      repo?: string;
      prNumber?: number;
      headSha?: string;
      kind?: string;
      phase?: string;
      proofJson?: string | null;
    } = {},
  ): void {
    const appId = fields.appId ?? APP_ID;
    db.raw
      .prepare(
        `INSERT OR REPLACE INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, holder, lease_epoch, lease_until_ms, attempts,
            recovery_state, last_error, created_ms, updated_ms, confirmed_ms, applied_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, NULL, 0, NULL, 0, 'pending', NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        publicationId, appId, fields.installationId ?? SCOPE.installationId, fields.owner ?? SCOPE.owner,
        fields.repo ?? SCOPE.repo, fields.prNumber ?? SCOPE.prNumber, fields.headSha ?? SHA,
        fields.kind ?? "review", fields.phase ?? "confirmed",
        fields.proofJson === undefined ? JSON.stringify({
          publicationId, scope: SCOPE, headSha: SHA, kind: "review", round: 1, commentId: 9001,
          bodySha256: "a".repeat(64), confirmedMs: T0,
        }) : fields.proofJson,
        T0, T0,
      );
    db.raw.prepare(`UPDATE review_checks SET publication_id = ?, terminal_ms = ? WHERE id = ?`).run(publicationId, T0, id);
  }

  async function localErrorAttempt(db: TestD1) {
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await setCheckDesired(db, id, lease, FAILURE, null, T0)).toBe(true);
    expect(await markCheckLocalError(db, id, lease, "gave up", T0)).toBe(true);
    return { id, attempt };
  }

  test("a FOREIGN-SCOPE publication id does not suppress a new claim", async () => {
    const db = seededDb();
    const { id } = await localErrorAttempt(db);
    linkPublication(db, id, crypto.randomUUID(), { owner: "someone-else", headSha: `f${SHA.slice(1)}` });
    const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
    if (again.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${again.kind}`);
    expect(again.attempt.identity.generation).toBe(2);
  });

  test("another App's or installation's proof does not suppress a new claim", async () => {
    const db = seededDb();
    const { id } = await localErrorAttempt(db);
    linkPublication(db, id, crypto.randomUUID(), { appId: OTHER_APP_ID, installationId: 999 });
    expect((await claimAttempt(db, claimInput({ holder: "run-b" }))).kind).toBe("claimed");
  });

  test("MALFORMED proof JSON does not suppress a new claim", async () => {
    const db = seededDb();
    const { id } = await localErrorAttempt(db);
    linkPublication(db, id, crypto.randomUUID(), { proofJson: "{not json at all" });
    expect((await claimAttempt(db, claimInput({ holder: "run-b" }))).kind).toBe("claimed");
  });

  test("a PREPARED (unproven) publication does not suppress a new claim", async () => {
    const db = seededDb();
    const { id } = await localErrorAttempt(db);
    linkPublication(db, id, crypto.randomUUID(), { phase: "prepared", proofJson: null });
    expect((await claimAttempt(db, claimInput({ holder: "run-b" }))).kind).toBe("claimed");
  });

  test("a publication that has moved on to `applied` still dedups", async () => {
    for (const phase of ["applied", "superseded"]) {
      const db = seededDb();
      const { id } = await localErrorAttempt(db);
      linkPublication(db, id, crypto.randomUUID(), { phase });
      const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
      expect(again.kind, `phase=${phase}`).toBe("terminal");
      expect(await rowCount(db)).toBe(1);
    }
  });

  test("a proof whose EMBEDDED identity disagrees with its row does not suppress a claim", async () => {
    const db = seededDb();
    const { id } = await localErrorAttempt(db);
    linkPublication(db, id, crypto.randomUUID(), {
      proofJson: JSON.stringify({
        publicationId: "x", scope: { ...SCOPE, owner: "elsewhere" }, headSha: SHA, kind: "review",
        round: 1, commentId: 9001, bodySha256: "a".repeat(64), confirmedMs: T0,
      }),
    });
    expect((await claimAttempt(db, claimInput({ holder: "run-b" }))).kind).toBe("claimed");
  });

  test("a proof with a malformed SHAPE does not suppress a claim", async () => {
    const cases: string[] = [
      JSON.stringify({ publicationId: "x", scope: SCOPE, headSha: SHA, kind: "review", round: 0, commentId: 9001, bodySha256: "a".repeat(64), confirmedMs: T0 }),
      JSON.stringify({ publicationId: "x", scope: SCOPE, headSha: SHA, kind: "review", round: 1, commentId: 0, bodySha256: "a".repeat(64), confirmedMs: T0 }),
      JSON.stringify({ publicationId: "x", scope: SCOPE, headSha: SHA, kind: "review", round: 1, commentId: 9001, bodySha256: "short", confirmedMs: T0 }),
      JSON.stringify({ publicationId: "x", scope: SCOPE, headSha: SHA, kind: "bogus", round: 1, commentId: 9001, bodySha256: "a".repeat(64), confirmedMs: T0 }),
    ];
    for (const proofJson of cases) {
      const db = seededDb();
      const { id } = await localErrorAttempt(db);
      linkPublication(db, id, crypto.randomUUID(), { proofJson });
      expect((await claimAttempt(db, claimInput({ holder: "run-b" }))).kind).toBe("claimed");
    }
  });

  test("an INCOMPLETE or TYPE-WRONG proof never suppresses a claim", async () => {
    const base = { publicationId: "ID", scope: SCOPE, headSha: SHA, kind: "review", round: 1, commentId: 9001, bodySha256: "a".repeat(64), confirmedMs: T0 };
    const cases: [string, Record<string, unknown>][] = [
      ["confirmedMs missing", omit(base, "confirmedMs")],
      ["confirmedMs as string", { ...base, confirmedMs: String(T0) }],
      ["confirmedMs as bool", { ...base, confirmedMs: true }],
      ["confirmedMs negative", { ...base, confirmedMs: -1 }],
      ["confirmedMs zero", { ...base, confirmedMs: 0 }],
      ["installationId as string", { ...base, scope: { ...SCOPE, installationId: String(SCOPE.installationId) } }],
      ["prNumber as string", { ...base, scope: { ...SCOPE, prNumber: String(SCOPE.prNumber) } }],
      ["prNumber as float", { ...base, scope: { ...SCOPE, prNumber: SCOPE.prNumber + 0.5 } }],
      ["bodySha256 missing", omit(base, "bodySha256")],
      ["headSha missing", omit(base, "headSha")],
      ["kind missing", omit(base, "kind")],
      ["round as float", { ...base, round: 1.5 }],
      ["commentId as string", { ...base, commentId: "9001" }],
      ["publicationId mismatch", { ...base, publicationId: "another-id" }],
    ];
    for (const [label, proof] of cases) {
      const db = seededDb();
      const { id } = await localErrorAttempt(db);
      const publicationId = crypto.randomUUID();
      linkPublication(db, id, publicationId, {
        proofJson: JSON.stringify({
          ...proof,
          publicationId: proof.publicationId === "ID" ? publicationId : proof.publicationId,
        }),
      });
      const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
      expect(again.kind, label).toBe("claimed");
      expect(again.kind === "claimed" && again.attempt.identity.generation, label).toBe(2);
    }
  });

  test("a VALID exact-scope proof still dedups (normal and degraded alike)", async () => {
    for (const kind of ["review", "degraded"] as const) {
      const db = seededDb();
      const { id } = await localErrorAttempt(db);
      const publicationId = crypto.randomUUID();
      linkPublication(db, id, publicationId, {
        kind,
        proofJson: JSON.stringify({
          publicationId, scope: SCOPE, headSha: SHA, kind, round: 1, commentId: 9001,
          bodySha256: "a".repeat(64), confirmedMs: T0,
        }),
      });
      const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
      if (again.kind !== "terminal") throw new Error(`fixture: expected terminal, got ${again.kind}`);
      expect(again.kind, `kind=${kind} should dedup`).toBe("terminal");
      expect(again.attempt.identity.generation).toBe(1);
      expect(await rowCount(db)).toBe(1);
    }
  });
});

describe("a frozen-pair claim never mints", () => {
  async function frozenPair(db: TestD1, id: string) {
    const row = await rawRow(db, id);
    return { key: row.attempt_key as string, generation: row.generation as number };
  }

  test("an OPEN frozen generation answers busy with that row, never a fresh claim", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const frozen = await frozenPair(db, attempt.identity.attemptId);

    const again = await claimAttempt(db, claimInput({ holder: "run-b", expect: frozen }));

    expect(again.kind).toBe("busy");
    expect(attemptOfClaim(again).identity.generation).toBe(frozen.generation);
    expect(await rowCount(db)).toBe(1);
  });

  test("a frozen generation that ENDED answers absent and inserts nothing", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const frozen = await frozenPair(db, id);
    await attachRun(db, id, lease);
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(true);
    expect(await markCheckLocalError(db, id, lease, "gave up", T0)).toBe(true);
    expect((await rawRow(db, id)).terminal_ms).toBe(T0);

    const before = await rowCount(db);
    const again = await claimAttempt(db, claimInput({ holder: "run-b", expect: frozen }));

    expect(again.kind).toBe("absent");
    expect(await rowCount(db)).toBe(before);
  });
});

describe("recovery claim fences (spec §7.6 / §7.9)", () => {
  test("a SUSPENDED row cannot be leased until explicit re-enable", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);

    expect(await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId }, "app disabled", T0)).toBe(1);
    expect(await claimCheckRecovery(db, id, "stale-reconciler", T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts)).toBeNull();
    expect((await getCheckAttempt(db, id))?.lease).toBeNull();

    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 + 1 })).toBe(false);
    expect((await rawRow(db, id)).recovery_state).toBe("suspended");

    await reenableChecksForApps(db, [{ appId: APP_ID, installationId: SCOPE.installationId }], T0 + 2);
    const reacquired = await claimCheckRecovery(db, id, "reconciler", T0 + 3, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(reacquired).not.toBeNull();
    expect(reacquired?.epoch).toBe(2);
  });

  test("terminalize-vs-retry: the retry loses safely to a concurrent terminalization", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);

    const recovery = await claimCheckRecovery(db, id, "reconciler", T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts);
    expect(recovery).not.toBeNull();
    expect(await recordCheckObservation(db, id, recovery!, remoteFor(attempt, { summary: CONCLUSION.summary }, "success"), T0 + 1)).toBe(true);

    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 + 2 })).toBe(false);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).toBe(T0 + 1);
    expect(row.recovery_state).toBe("done");
  });

  test("retry refuses a live lease, a newer active generation and a proof-complete row", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 })).toBe(false);
    expect(await retryCheckRecovery(db, { scope: { ...SCOPE, repo: "elsewhere" }, attemptId: id, nowMs: DEADLINE + 1 })).toBe(false);
    await setCheckDesired(db, id, lease, FAILURE, null, T0);
    expect(await markCheckLocalError(db, id, lease, "exhausted", T0)).toBe(true);
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: DEADLINE + 1 })).toBe(true);
    const row = await rawRow(db, id);
    expect(row.terminal_ms).toBeNull();
    expect(row.generation).toBe(1);
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.desired).toBe("failure");
    expect(row.observed).toBe("unknown");
  });
});

describe("retryCheckRecovery (spec §7.11.2 step 6 store face)", () => {
  test("reopens recovery of the SAME identity and refuses a live lease", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 })).toBe(false);
    await deferCheckRecovery(db, id, lease, { state: "remote-unconfirmed", nextAttemptMs: DEADLINE + 500, reason: "down" }, T0);
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: DEADLINE + 1 })).toBe(true);
    const row = await rawRow(db, id);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.last_error).toBeNull();
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.generation).toBe(1);
    expect(row.check_run_id).toBeNull();
    expect(row.desired).toBe("in_progress");
  });

  test("a row a newer active generation superseded stays put for inspection", async () => {
    const db = seededDb();
    const first = await claim(db);
    const oldId = first.attempt.identity.attemptId;
    await setCheckDesired(db, oldId, first.lease, FAILURE, null, T0);
    await markCheckLocalError(db, oldId, first.lease, "exhausted", T0);
    const second = await claim(db, {
      holder: "run-z",
      nowMs: DEADLINE + 1,
      executionDeadlineMs: DEADLINE + 1 + CHECK_LEASE_MS,
    });
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: oldId, nowMs: DEADLINE + 2 })).toBe(false);
    expect((await rawRow(db, oldId)).generation).toBe(1);
    expect((await rawRow(db, second.attempt.identity.attemptId)).generation).toBe(2);
  });
});

describe("readPublicationProof integration (spec §7.7/§7.9)", () => {
  test("proof is read by exact scope/SHA, normal over degraded, this attempt's id preferred", async () => {
    const db = seededDb();
    const degraded = await stageProof(db, crypto.randomUUID(), "degraded");
    const normal = await stageProof(db, crypto.randomUUID(), "review");

    expect((await readPublicationProof(db, { scope: SCOPE, headSha: SHA }))?.publicationId).toBe(normal.publicationId);
    expect(
      (await readPublicationProof(db, { scope: SCOPE, headSha: SHA, publicationId: degraded.publicationId }))?.publicationId,
    ).toBe(degraded.publicationId);
    expect(await readPublicationProof(db, { scope: SCOPE, headSha: `f${SHA.slice(1)}` })).toBeNull();
    const preparedOnly = crypto.randomUUID();
    await stagePublication(db, { id: preparedOnly, payload: payloadFor(preparedOnly, "review", 77), nowMs: T0 });
    expect(await readPublicationProof(db, { scope: { ...SCOPE, prNumber: 77 }, headSha: SHA })).toBeNull();
  });

  test("a Check attempt can be terminalized from a real journal proof", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const proof = await stageProof(db, crypto.randomUUID(), "review");
    const read = await readPublicationProof(db, { scope: SCOPE, headSha: SHA, publicationId: proof.publicationId });
    expect(read).not.toBeNull();
    expect(await setCheckDesired(db, id, lease, CONCLUSION, read!.publicationId, T0)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.desired).toBe("success");
    expect(row.publication_id).toBe(proof.publicationId);
  });
});


function payloadFor(id: string, kind: "review" | "degraded", prNumber: number, headSha = SHA): PublicationPayload {
  return {
    version: 1,
    scope: { ...SCOPE, prNumber },
    headSha,
    kind,
    round: 1,
    targetCommentId: null,
    body: `body for ${id}`,
    bodySha256: "a".repeat(64),
    artifact: null,
    lifecycle: null,
    lineIntents: [],
  };
}

async function stageProof(
  db: TestD1,
  publicationId: string,
  kind: "review" | "degraded",
  prNumber = SCOPE.prNumber,
  headSha = SHA,
): Promise<PublicationProof> {
  await stagePublication(db, { id: publicationId, payload: payloadFor(publicationId, kind, prNumber, headSha), nowMs: T0 });
  const lease = await claimPublication(db, publicationId, `pub-${publicationId}`, T0, "prepared");
  if (lease === null) throw new Error("fixture: publication claim failed");
  const proof: PublicationProof = {
    publicationId,
    scope: { ...SCOPE, prNumber },
    headSha,
    kind,
    round: 1,
    commentId: 9001,
    bodySha256: "a".repeat(64),
    confirmedMs: T0 + 10,
  };
  expect(await recordPublicationProof(db, publicationId, lease, proof)).toBe(true);
  return proof;
}


describe("suspension encoding and no-churn re-enable (P68-QC-003)", () => {
  const DIGEST = "b".repeat(64);

  async function suspendedRow(
    db: TestD1,
    kind: Parameters<typeof checkSuspensionReason>[0],
    fingerprint?: string,
    appId = APP_ID,
  ): Promise<{ id: string; externalId: string; lease: Lease }> {
    const { attempt, lease } = await claim(db, { scope: { ...SCOPE, appId }, action: `attempt-${kind}-${appId}` });
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    const written = await suspendCheckRecovery(
      db,
      { appId, installationId: SCOPE.installationId },
      checkSuspensionReason(kind, "suspended", fingerprint),
      T0,
    );
    if (written !== 1) throw new Error(`fixture: suspension did not land (${written})`);
    return { id, externalId: attempt.identity.externalId, lease };
  }

  test("the codec round-trips every kind and fails closed on anything unrecognized", () => {
    for (const kind of ["disabled", "identity-mismatch", "missing", "deleted", "decrypt-failed", "paused"] as const) {
      expect(checkSuspensionKindOf(checkSuspensionReason(kind, "why", DIGEST))).toBe(kind);
    }
    expect(suspensionCredentialOf(checkSuspensionReason("identity-mismatch", "why", DIGEST))).toBe(DIGEST);
    expect(checkSuspensionKindOf("app disabled — no Check mutation")).toBe("unknown");
    expect(checkSuspensionKindOf("suspend:something-new: why")).toBe("unknown");
    expect(checkSuspensionKindOf(null)).toBe("unknown");
  });

  test("an UNCHANGED fingerprint is filtered out; a corrected one resumes", async () => {
    const db = seededDb();
    const { id } = await suspendedRow(db, "identity-mismatch", DIGEST);

    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: DIGEST },
      ]),
    ).toEqual([]);
    expect(await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(0);

    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: "c".repeat(64) },
      ]),
    ).toEqual([{ appId: APP_ID, installationId: SCOPE.installationId }]);
    await reenableChecksForApps(db, [{ appId: APP_ID, installationId: SCOPE.installationId }], T0 + 1);
    expect((await listCheckReconcileBatch(db, T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((r) => r.identity.attemptId)).toEqual([id]);
  });

  test("the store read: a mixed-kind pair is resumable only when EVERY suspended row is releasable", async () => {
    const db = seededDb();
    const first = await claim(db, { headSha: "a".repeat(40) });
    const second = await claim(db, { headSha: "b".repeat(40) });
    for (const attempt of [first, second]) {
      await setCheckDesired(db, attempt.attempt.identity.attemptId, attempt.lease, CONCLUSION, null, T0);
      await deferCheckRecovery(
        db,
        attempt.attempt.identity.attemptId,
        attempt.lease,
        { state: "pending", nextAttemptMs: T0, reason: "release" },
        T0,
      );
    }
    await suspendCheckRecovery(
      db,
      { appId: APP_ID, installationId: SCOPE.installationId },
      checkSuspensionReason("identity-mismatch", "suspended", DIGEST),
      T0,
    );
    db.raw
      .prepare(`UPDATE review_checks SET last_error = ? WHERE id = ?`)
      .run(checkSuspensionReason("paused", "kill switch"), second.attempt.identity.attemptId);
    const pair = { appId: APP_ID, installationId: SCOPE.installationId };
    expect(
      await listReenableableCheckPairs(db, [{ ...pair, currentFingerprint: DIGEST }]),
    ).toEqual([]);

    expect(
      await listReenableableCheckPairs(db, [{ ...pair, currentFingerprint: "e".repeat(64) }]),
    ).toEqual([pair]);
  });

  test("a live holder is never resumed", async () => {
    const db = seededDb();
    const { id } = await suspendedRow(db, "identity-mismatch", DIGEST);
    db.raw.prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = 5 WHERE id = ?`).run(id);
    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: "c".repeat(64) },
      ]),
    ).toEqual([]);
  });

  test("an UNREADABLE current digest proves nothing, so the pair stays suspended (F-005)", async () => {
    const db = seededDb();
    await suspendedRow(db, "identity-mismatch", DIGEST);
    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: null },
      ]),
    ).toEqual([]);
  });

  test("a suspension recorded WITHOUT a digest resumes once a current digest is readable (F-005)", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    expect(
      await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId },
        checkSuspensionReason("missing", "mapping missing"), T0),
    ).toBe(1);
    expect(suspensionCredentialOf((await rawRow(db, id)).last_error as string)).toBeNull();

    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: "f".repeat(64) },
      ]),
    ).toEqual([{ appId: APP_ID, installationId: SCOPE.installationId }]);
  });

  test("a re-stamp overwrites the digest so the next pass is D1-only", async () => {
    const db = seededDb();
    const { id } = await suspendedRow(db, "identity-mismatch", DIGEST);
    const NEW = "d".repeat(64);
    expect(
      await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId },
        checkSuspensionReason("identity-mismatch", "new", NEW), T0 + 1),
    ).toBe(1);
    const row = await rawRow(db, id);
    expect(suspensionCredentialOf(row.last_error as string)).toBe(NEW);
    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: NEW },
      ]),
    ).toEqual([]);
  });

  test("a not-active App is never resumable, whatever the kind or proof", async () => {
    const db = seededDb();
    await suspendedRow(db, "disabled", "a".repeat(64));
    db.raw.prepare(`UPDATE review_bots SET status = 'disabled' WHERE id = ?`).run(APP_ID);
    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: null },
      ]),
    ).toEqual([]);
  });

  test("a paused hold resumes only when the kill switch lifts", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    expect(await suspendCheckForPause(db, id, lease, "App is paused", T0)).toBe(true);
    expect((await rawRow(db, id)).recovery_state).toBe("suspended");
    db.raw.prepare(`UPDATE review_bots SET review_enabled = 0 WHERE id = ?`).run(APP_ID);

    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: null },
      ]),
    ).toEqual([]);

    db.raw.prepare(`UPDATE review_bots SET review_enabled = 1 WHERE id = ?`).run(APP_ID);
    expect(
      await listReenableableCheckPairs(db, [
        { appId: APP_ID, installationId: SCOPE.installationId, currentFingerprint: null },
      ]),
    ).toEqual([{ appId: APP_ID, installationId: SCOPE.installationId }]);
    await reenableChecksForApps(db, [{ appId: APP_ID, installationId: SCOPE.installationId }], T0 + 1);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(await listCheckReconcileBatch(db, T0 + 1, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).toHaveLength(1);
  });

  test("suspendCheckForPause preserves the identity and spends no attempt", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    const before = await rawRow(db, id);
    expect(await suspendCheckForPause(db, id, lease, "paused", T0)).toBe(true);
    const after = await rawRow(db, id);
    expect(after.recovery_state).toBe("suspended");
    expect(checkSuspensionKindOf(after.last_error as string)).toBe("paused");
    for (const key of ["attempts", "desired", "observed", "external_id", "generation", "check_run_id", "publication_id", "terminal_ms"]) {
      expect([key, after[key]]).toEqual([key, before[key]]);
    }
    const stale: Lease = { holder: lease.holder, epoch: lease.epoch + 1, untilMs: lease.untilMs };
    expect(await suspendCheckForPause(db, id, stale, "paused", T0)).toBe(false);
  });
});
