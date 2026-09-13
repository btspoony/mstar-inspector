/**
 * Review Check attempt registry tests (plan 68 Task 1, spec review-lifecycle
 * §7.1 second block + §7.9) — `src/store/review-checks.ts` against the
 * bun:sqlite double running the REAL migration SQL (0001 → 0021 through
 * `createMigratedTestD1`, DDL single sources).
 *
 * Behaviors covered (brief verification list):
 *   - identity: canonical `attempt_key`, the `mstar-check:v1:<uuid>:<gen>`
 *     handle, and the claim's SQL-stamped `external_id` agreeing with the TS
 *     helper (the two spellings cannot drift silently)
 *   - the claim protocol: a fresh generation gets holder + epoch 1 + a lease
 *     equal to the execution deadline; a nonterminal key is `busy` for every
 *     other holder; a terminal key returns `terminal` with its identity intact
 *   - generation uniqueness under a simulated race, with the partial unique
 *     index shown to be the actual arbiter
 *   - a failed generation is retryable as N+1 with a fresh UUID while terminal
 *     history is never overwritten
 *   - every later mutation is fenced on the exact lease triple and writes
 *     nothing once the lease is lost or the row has ended
 *   - recovery reacquires an expired lease with a new epoch, never touches a
 *     live one, and never moves `execution_deadline_ms`
 *   - terminal-intent monotonicity plus the single proof-authorized correction
 *   - observation only from fully identity-matching remote evidence
 *   - `readPublicationProof` integration through the real journal
 *   - reconcile-batch due-time selection, limits, suspension and re-enable
 *   - tenant/App isolation on every scope-bound face
 *   - the registry's boundary: nothing claims external exactly-once — the
 *     remote non-idempotency itself is covered in tests/pipeline/checks.test.ts
 */
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
  attemptKey,
  attachCheckRunId,
  CHECK_BACKOFF_MS,
  CHECK_EXTERNAL_ID_PREFIX,
  CHECK_LEASE_MS,
  CHECK_MAX_ATTEMPTS,
  CHECK_NAME,
  CHECK_RECOVERY_LEASE_MS,
  type CheckAttempt,
  type CheckConclusion,
  type CheckRemote,
  claimAttempt,
  claimCheckRecovery,
  deferCheckRecovery,
  externalIdFor,
  getCheckAttempt,
  getCheckOwnership,
  listCheckReconcileBatch,
  markCheckLocalError,
  type PublicationProof as _UnusedProof,
  readPublicationProof,
  recordCheckObservation,
  reenableChecksForApps,
  retryCheckRecovery,
  type Scope,
  setCheckCreateState,
  setCheckDesired,
  suspendCheckRecovery,
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
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, `checks-test-${id}`, githubAppId, `checks-test-${id}`);
}

function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  seedApp(db, APP_ID, APP_NUMERIC_ID);
  seedApp(db, OTHER_APP_ID, OTHER_NUMERIC_APP_ID);
  return db;
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

/** Claim, failing loudly if the result is anything but `claimed`. */
async function claim(
  db: TestD1,
  overrides: Partial<ClaimInput> = {},
): Promise<{ attempt: CheckAttempt; lease: Lease }> {
  const result = await claimAttempt(db, claimInput(overrides));
  if (result.kind !== "claimed") {
    throw new Error(`expected a claimed attempt, got ${result.kind} (generation ${result.attempt.identity.generation})`);
  }
  return result;
}

/**
 * Attach a proven run id through the LEGAL transition path: an id may only be
 * recorded for a send that was actually attempted, so the store requires
 * `sending`/`unknown` first (RL-12: a `not-sent` attempt has no run).
 */
async function attachRun(db: TestD1, id: string, lease: Lease, runId = 4242, now = T0): Promise<void> {
  expect(await setCheckCreateState(db, id, lease, "sending", undefined, now)).toBe(true);
  expect(await attachCheckRunId(db, id, lease, runId, now)).toBe(true);
}

/**
 * A copy of `obj` without `key` — for "required field missing" fixtures.
 */
function omit<T extends Record<string, unknown>>(obj: T, key: keyof T & string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy;
}

/**
 * A remote check-run payload that matches an attempt's persisted identity,
 * with per-test overrides. Defaults to a COMPLETED run carrying `intent`
 * (the conclusion the attempt was terminalized with).
 */
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
  } = {},
  intent: CheckConclusion["desired"] = "success",
): CheckRemote {
  const identity = attempt.identity;
  return {
    id: overrides.id ?? 4242,
    name: overrides.name ?? CHECK_NAME,
    head_sha: overrides.head_sha ?? identity.headSha,
    // `??` would treat an explicit `null` as absent and silently substitute the
    // real id — the "no correlation at all" rejection case must stay null.
    external_id: "external_id" in overrides ? (overrides.external_id ?? null) : identity.externalId,
    app: overrides.app === undefined ? { id: identity.githubAppId } : overrides.app,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined ? intent : overrides.conclusion,
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
    // Born in_progress/unknown/not-sent, and never unowned.
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
      // The reread returns the live row — not the loser's own MAX+1 guess.
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
    // Simulate the exact interleaving the partial unique index exists for: a
    // concurrent claimer committed its row between this claimer's eligibility
    // read and its INSERT, so this INSERT loses to the index. The loser must
    // REREAD the active row — never assume its own MAX+1.
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
    // The loser wrote nothing: the winner's row is still the only one.
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
             (id, app_id, github_app_id, installation_id, owner, repo, pr_number, head_sha,
              triggered_by, action, attempt_key, generation, external_id, create_state,
              execution_deadline_ms, desired, observed, recovery_state, attempts, terminal_ms, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'u', 'review', 'k', ?, ?, 'not-sent',
                   ?, 'in_progress', 'unknown', 'pending', 0, ?, ?, ?)`,
        )
        .run(id, APP_ID, APP_NUMERIC_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, 42, SHA, generation, `e${generation}`, T0, terminalMs, T0, T0);

    seed("a", 1);
    // A second NONTERMINAL generation for the same key is refused by the index
    // even though (attempt_key, generation) alone would have allowed it.
    expect(() => seed("b", 2)).toThrow(/UNIQUE constraint failed: review_checks.attempt_key/);
    // Terminalize the first, and the next generation is legitimate.
    db.raw.prepare(`UPDATE review_checks SET terminal_ms = ? WHERE id = 'a'`).run(T0 + 1);
    expect(() => seed("c", 2)).not.toThrow();
    // A duplicate generation number is refused by the table constraint.
    // Both the partial index and the table constraint are violated here and
    // SQLite names the partial index first; the table constraint is proven by
    // a TERMINAL duplicate below, where the partial index cannot apply.
    expect(() => seed("d", 2)).toThrow(/UNIQUE constraint failed: review_checks.attempt_key/);
    // Terminalize everything open, then only the TABLE constraint can apply —
    // and it names both columns, proving (attempt_key, generation) is also
    // unique independent of the open-row index.
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
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, {}, "success"), T0)).toBe(true);

    const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
    expect(again.kind).toBe("terminal");
    expect(again.attempt.identity.attemptId).toBe(id);
    expect(again.attempt.identity.externalId).toBe(attempt.identity.externalId);
    expect(again.attempt.checkRunId).toBe(4242);
    expect(again.attempt.terminalMs).toBe(T0);
    expect(await rowCount(db)).toBe(1);
  });

  test("a PROVEN publication dedups even while the Check observation is still unknown", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    const proof = await stageProof(db, crypto.randomUUID(), "review");
    // The intent is linked to a real journal proof; the Check side effect then
    // fails locally, so `observed` stays `unknown` while publication is PROVEN.
    expect(await setCheckDesired(db, id, lease, CONCLUSION, proof.publicationId, T0)).toBe(true);
    expect(await markCheckLocalError(db, id, lease, "gave up", T0)).toBe(true);
    const before = await rawRow(db, id);
    expect(before.observed).toBe("unknown");
    expect(before.publication_id).toBe(proof.publicationId);

    // Dedup reads PROOF, not the Check observation (§7.9): a second claim must
    // return terminal and must NOT mint generation N+1 for a published head.
    const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
    expect(again.kind).toBe("terminal");
    expect(again.attempt.identity.generation).toBe(1);
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

    // History retained: the failed generation keeps its ids and terminal mark.
    const old = await getCheckAttempt(db, id);
    expect(old?.identity.generation).toBe(1);
    expect(old?.identity.externalId).toBe(first.attempt.identity.externalId);
    expect(old?.observed).toBe("unknown");
    expect(old?.terminalMs).toBe(T0);
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
    expect(await recordCheckObservation(db, id, shifted, remoteFor(attempt, {}, "success"), T0)).toBe(false);
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
    const taken = await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1);
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
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, {}, "success"), T0)).toBe(true);
    expect((await getCheckAttempt(db, id))?.terminalMs).not.toBeNull();

    // The lease is still the caller's; the row's terminality is the fence.
    expect(await setCheckDesired(db, id, lease, FAILURE, null, T0)).toBe(false);
    expect(await attachCheckRunId(db, id, lease, 9999, T0)).toBe(false);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, {}, "success"), T0)).toBe(false);
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
    // A DIFFERENT id is refused outright: the row keeps the run it recorded,
    // so a caller cannot re-point the attempt at a lookalike (spec §7.9 "A
    // known terminal remote ID is retained, never cleared").
    expect(await attachCheckRunId(db, id, lease, 9999, T0)).toBe(false);
    expect((await getCheckAttempt(db, id))?.checkRunId).toBe(4242);
    // Re-attaching the SAME id is the idempotent success case.
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
    // A lost response: unknown, with a bounded durable reason.
    expect(await setCheckCreateState(db, id, lease, "unknown", "socket closed", T0)).toBe(true);
    expect((await getCheckAttempt(db, id))?.createState).toBe("unknown");
    expect((await rawRow(db, id)).last_error).toBe("socket closed");
    await attachRun(db, id, lease);
    // A known run means the create demonstrably happened, so the row can never
    // be walked back to `not-sent`: that would be a false durable claim AND
    // would make the attempt createable again. The id and the state both stay.
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
    // The release clears the lease, but the row still wants `in_progress`: the
    // selector admits it only at its EXECUTION deadline, never at the backoff
    // time or at `updated_ms`.
    expect(await listCheckReconcileBatch(db, T0 + CHECK_BACKOFF_MS[0]!)).toEqual([]);
    expect(await listCheckReconcileBatch(db, DEADLINE)).toHaveLength(1);
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
    // Intent is not observation: nothing terminal happened remotely.
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

    // A downgrade or lateral rewrite is refused and writes nothing.
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(false);
    expect((await getCheckAttempt(db, id))?.desired).toBe("failure");
    expect(
      await setCheckDesired(db, id, lease, { desired: "neutral", title: CHECK_NAME, summary: "s" }, null, T0),
    ).toBe(false);
    expect((await getCheckAttempt(db, id))?.desired).toBe("failure");

    // The correction needs the proof link that authorizes it.
    const proof = await stageProof(db, crypto.randomUUID(), "review");
    expect(
      await setCheckDesired(db, id, lease, { desired: "neutral", title: CHECK_NAME, summary: "s" }, proof.publicationId, T0),
    ).toBe(true);
    const corrected = await rawRow(db, id);
    expect(corrected.desired).toBe("neutral");
    expect(corrected.publication_id).toBe(proof.publicationId);
    expect(corrected.observed).toBe("unknown");
    // From success/neutral nothing further may rewrite the intent at all.
    expect(await setCheckDesired(db, id, lease, FAILURE, proof.publicationId, T0)).toBe(false);
  });

  test("recordCheckObservation requires full identity agreement", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);

    const rejections: CheckRemote[] = [
      remoteFor(attempt, { app: { id: OTHER_NUMERIC_APP_ID } }, "success"), // another App owns it
      remoteFor(attempt, { head_sha: `f${SHA.slice(1)}` }, "success"), // another commit
      remoteFor(attempt, { external_id: "mstar-check:v1:other:1" }, "success"), // another generation
      remoteFor(attempt, { external_id: null }, "success"), // no correlation at all
      remoteFor(attempt, { name: "some-other-check" }, "success"), // name alone is not ownership
      remoteFor(attempt, { app: null }, "success"), // App evidence missing
      remoteFor(attempt, { conclusion: "failure" }, "success"), // not the intended conclusion
      remoteFor(attempt, { status: "completed", conclusion: "cancelled" }, "success"), // someone else closed it
    ];
    for (const remote of rejections) {
      expect(await recordCheckObservation(db, id, lease, remote, T0)).toBe(false);
      expect((await getCheckAttempt(db, id))?.observed).toBe("unknown");
    }
    // Once a run is attached, a different id is not the same run.
    await attachRun(db, id, lease);
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, { id: 777 }, "success"), T0)).toBe(false);
    // The intended terminal state on our own run is what advances observation.
    expect(await recordCheckObservation(db, id, lease, remoteFor(attempt, {}, "success"), T0)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");
    expect(row.terminal_ms).toBe(T0);
    expect(row.check_run_id).toBe(4242);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
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
    // A repeat running observation writes nothing further.
    expect(
      await recordCheckObservation(db, id, lease, remoteFor(attempt, { status: "in_progress", conclusion: null }), T0),
    ).toBe(false);
  });
});

describe("claimCheckRecovery (spec §7.9/§7.11.2)", () => {
  test("a live holder's lease is never taken", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    expect(await claimCheckRecovery(db, attempt.identity.attemptId, "reconciler", T0 + 1_000)).toBeNull();
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
    const lease = await claimCheckRecovery(db, id, "reconciler", later);
    expect(lease).toEqual({ holder: "reconciler", epoch: 2, untilMs: later + CHECK_RECOVERY_LEASE_MS });
    const row = await getCheckAttempt(db, id);
    expect(row?.executionDeadlineMs).toBe(DEADLINE);
    expect(row?.attempts).toBe(0); // selection alone spends nothing
    // The previous holder is fenced out; the recovery holder writes.
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
    expect(await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0)).toBe(true);
    const reacquired = await claimCheckRecovery(db, id, "reconciler", T0 + 1);
    expect(reacquired).toEqual({ holder: "reconciler", epoch: 2, untilMs: T0 + 1 + CHECK_RECOVERY_LEASE_MS });
  });

  test("an unknown or already-terminal row cannot be claimed", async () => {
    const db = seededDb();
    expect(await claimCheckRecovery(db, crypto.randomUUID(), "reconciler", T0)).toBeNull();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await recordCheckObservation(db, id, lease, remoteFor(attempt, {}, "success"), T0);
    expect(await claimCheckRecovery(db, id, "reconciler", DEADLINE * 2)).toBeNull();
  });
});

describe("listCheckReconcileBatch (spec §7.11.2 predicate)", () => {
  test("a live claim lease hides a row; the release makes it a candidate", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    // A fresh claim wants in_progress and owns a live lease: not a candidate.
    expect(await listCheckReconcileBatch(db, T0 + 1)).toEqual([]);
    // A persisted terminal intent does not make it due while the lease is live.
    expect(await setCheckDesired(db, id, lease, CONCLUSION, null, T0)).toBe(true);
    expect(await listCheckReconcileBatch(db, T0 + 1)).toEqual([]);
    expect(
      await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0),
    ).toBe(true);
    // Released and terminal-intended: a candidate immediately.
    expect((await listCheckReconcileBatch(db, T0)).map((row) => row.identity.attemptId)).toEqual([id]);
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
    expect(await listCheckReconcileBatch(db, backoff - 1)).toEqual([]);
    expect(await listCheckReconcileBatch(db, backoff)).toHaveLength(1);

    // A live recovery lease hides the row even at its due time.
    const holding = await claimCheckRecovery(db, id, "reconciler", backoff);
    expect(holding).not.toBeNull();
    expect(await listCheckReconcileBatch(db, backoff)).toEqual([]);

    // Every failed recovery action spends exactly one attempt.
    for (let i = 1; i < CHECK_MAX_ATTEMPTS; i += 1) {
      // Each reacquire must wait out the PREVIOUS recovery lease (120s).
      const at = backoff + i * CHECK_RECOVERY_LEASE_MS + 1_000;
      const next = await claimCheckRecovery(db, id, `reconciler-${i}`, at);
      expect(next, `recovery claim ${i} should succeed`).not.toBeNull();
      expect(
        await deferCheckRecovery(db, id, next!, { state: "remote-unconfirmed", nextAttemptMs: 0, reason: "again" }, at),
      ).toBe(true);
    }
    expect((await getCheckAttempt(db, id))?.attempts).toBe(CHECK_MAX_ATTEMPTS);
    expect(await listCheckReconcileBatch(db, backoff + 1_000_000, CHECK_MAX_ATTEMPTS, 25)).toEqual([]);
    // A generous cap is an operator decision, not this selector's default.
    expect(await listCheckReconcileBatch(db, backoff + 1_000_000, CHECK_MAX_ATTEMPTS + 1, 25)).toHaveLength(1);
  });

  test("an in_progress attempt becomes due only at its EXECUTION deadline", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: 0, reason: "release" }, T0)).toBe(true);
    expect(await listCheckReconcileBatch(db, attempt.executionDeadlineMs - 1)).toEqual([]);
    expect((await listCheckReconcileBatch(db, attempt.executionDeadlineMs)).map((r) => r.identity.attemptId)).toEqual([id]);
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
    const batch = await listCheckReconcileBatch(db, T0 + 10_000, CHECK_MAX_ATTEMPTS, 2);
    // Oldest due time first: index 2 was scheduled for T0, index 1 for T0+1000.
    expect(batch.map((row) => row.identity.attemptId)).toEqual([ids[2]!, ids[1]!]);
    expect(await listCheckReconcileBatch(db, T0 + 10_000, CHECK_MAX_ATTEMPTS, 25)).toHaveLength(3);
  });

  test("suspended rows leave the selector and return on re-enable, keeping their identity", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);
    expect(await listCheckReconcileBatch(db, T0)).toHaveLength(1);

    expect(await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId }, "app disabled", T0)).toBe(1);
    expect(await listCheckReconcileBatch(db, T0)).toEqual([]);
    const suspended = await rawRow(db, id);
    expect(suspended.recovery_state).toBe("suspended");
    expect(suspended.external_id).toBe(attempt.identity.externalId);
    expect(suspended.terminal_ms).toBeNull();
    expect(suspended.desired).toBe("success");

    await reenableChecksForApps(db, [{ appId: APP_ID, installationId: SCOPE.installationId }], T0 + 1);
    expect(await listCheckReconcileBatch(db, T0 + 1)).toHaveLength(1);
    expect((await rawRow(db, id)).recovery_state).toBe("pending");
  });

  test("markCheckLocalError terminalizes under the fence and retains the remote id", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await attachRun(db, id, lease);
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    const recovered = await claimCheckRecovery(db, id, "reconciler", DEADLINE + 1);
    expect(recovered).not.toBeNull();
    expect(await markCheckLocalError(db, id, recovered!, "gave up after 5", DEADLINE + 1)).toBe(true);
    const row = await rawRow(db, id);
    expect(row.recovery_state).toBe("local-error");
    expect(row.terminal_ms).toBe(DEADLINE + 1);
    expect(row.attempts).toBe(1);
    expect(row.check_run_id).toBe(4242); // never cleared
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.observed).toBe("unknown"); // gave up locally, remote stays unknown
    expect(await listCheckReconcileBatch(db, DEADLINE + 1_000)).toEqual([]);
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
    // Each key keeps its own generation 1 — the partial index is per key.
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

  test("suspend/reenable bind the exact (app_id, installation_id) pair", async () => {
    const db = seededDb();
    await claim(db);
    await claim(db, { scope: { ...SCOPE, appId: OTHER_APP_ID }, githubAppId: OTHER_NUMERIC_APP_ID, holder: "run-o" });
    expect(await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId }, "disabled", T0)).toBe(1);
    const suspended = db.raw
      .prepare(`SELECT app_id, installation_id FROM review_checks WHERE recovery_state = 'suspended'`)
      .all() as { app_id: string; installation_id: number }[];
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
    const batch = await listCheckReconcileBatch(db, T0);
    expect(batch.map((row) => row.identity.scope.appId).sort()).toEqual([APP_ID, OTHER_APP_ID].sort());
    expect(batch.find((row) => row.identity.scope.appId === OTHER_APP_ID)?.identity.githubAppId).toBe(OTHER_NUMERIC_APP_ID);
  });
});

describe("publication-proof dedup is EXACT (spec §7.9)", () => {
  /** Link an arbitrary publication row to an attempt, bypassing the store. */
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
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
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
    expect(again.kind).toBe("claimed"); // unproven for THIS scope/SHA → retryable
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
    // The real shape of a staged-but-unconfirmed row: no proof yet. Prepending
    // a phase name to a row that still holds a proof would be beside the point —
    // the presence of a VALID proof is what proves publication.
    const db = seededDb();
    const { id } = await localErrorAttempt(db);
    linkPublication(db, id, crypto.randomUUID(), { phase: "prepared", proofJson: null });
    expect((await claimAttempt(db, claimInput({ holder: "run-b" }))).kind).toBe("claimed");
  });

  test("a publication that has moved on to `applied` still dedups", async () => {
    // A normally-completed publication advances past `confirmed`; its proof is
    // still the proof that this head was published, so the gate must not key on
    // a phase the row merely passes through.
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
    // Syntactically valid JSON is not a proof: the closed PublicationProof
    // shape requires every field to be present with its own JSON type. A
    // coerced-equality read (e.g. "42" == 42) is exactly what these reject.
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
        // A complete, self-consistent proof: every required field present with
        // its JSON type and the embedded identity equal to its own row.
        proofJson: JSON.stringify({
          publicationId, scope: SCOPE, headSha: SHA, kind, round: 1, commentId: 9001,
          bodySha256: "a".repeat(64), confirmedMs: T0,
        }),
      });
      const again = await claimAttempt(db, claimInput({ holder: "run-b" }));
      expect(again.kind, `kind=${kind} should dedup`).toBe("terminal");
      expect(again.attempt.identity.generation).toBe(1);
      expect(await rowCount(db)).toBe(1);
    }
  });
});

describe("recovery claim fences (spec §7.6 / §7.9)", () => {
  test("a SUSPENDED row cannot be leased until explicit re-enable", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(db, id, lease, CONCLUSION, null, T0);
    await deferCheckRecovery(db, id, lease, { state: "pending", nextAttemptMs: T0, reason: "release" }, T0);

    // Suspension is a CLAIM fence, not just a selector filter (§7.6): a stale
    // selector result or a direct caller must not lease a disabled App's row.
    expect(await suspendCheckRecovery(db, { appId: APP_ID, installationId: SCOPE.installationId }, "app disabled", T0)).toBe(1);
    expect(await claimCheckRecovery(db, id, "stale-reconciler", T0 + 1)).toBeNull();
    expect((await getCheckAttempt(db, id))?.lease).toBeNull();

    // An operator retry must NOT resurrect it either: only the explicit
    // re-enable may resume a suspended identity (spec §7.6).
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 + 1 })).toBe(false);
    expect((await rawRow(db, id)).recovery_state).toBe("suspended");

    // Re-enable returns it to `pending`, and only then is it claimable again.
    await reenableChecksForApps(db, [{ appId: APP_ID, installationId: SCOPE.installationId }], T0 + 2);
    const reacquired = await claimCheckRecovery(db, id, "reconciler", T0 + 3);
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

    // Another worker terminalizes (observed success) AFTER the operator's
    // decision to retry. The reopen is ONE conditional statement, so every
    // precondition is re-checked inside the write and the terminal row is not
    // resurrected.
    const recovery = await claimCheckRecovery(db, id, "reconciler", T0 + 1);
    expect(recovery).not.toBeNull();
    expect(await recordCheckObservation(db, id, recovery!, remoteFor(attempt, {}, "success"), T0 + 1)).toBe(true);

    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 + 2 })).toBe(false);
    const row = await rawRow(db, id);
    expect(row.observed).toBe("success");
    expect(row.terminal_ms).toBe(T0 + 1); // terminal history retained
    expect(row.recovery_state).toBe("done");
  });

  test("retry refuses a live lease, a newer active generation and a proof-complete row", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    // Live lease: refused while the claim lease is unexpired.
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 })).toBe(false);
    // Scope mismatch is refused (the retry binds the full scope).
    expect(await retryCheckRecovery(db, { scope: { ...SCOPE, repo: "elsewhere" }, attemptId: id, nowMs: DEADLINE + 1 })).toBe(false);
    // A local give-up IS retryable (it reopens the same historical identity).
    await setCheckDesired(db, id, lease, FAILURE, null, T0);
    expect(await markCheckLocalError(db, id, lease, "exhausted", T0)).toBe(true);
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: DEADLINE + 1 })).toBe(true);
    const row = await rawRow(db, id);
    expect(row.terminal_ms).toBeNull();
    expect(row.generation).toBe(1); // no new generation, no cleared identity
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.desired).toBe("failure"); // intent retained
    expect(row.observed).toBe("unknown"); // never rewritten to a fake completion
  });
});

describe("retryCheckRecovery (spec §7.11.2 step 6 store face)", () => {
  test("reopens recovery of the SAME identity and refuses a live lease", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const id = attempt.identity.attemptId;
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: T0 })).toBe(false); // live lease
    await deferCheckRecovery(db, id, lease, { state: "remote-unconfirmed", nextAttemptMs: DEADLINE + 500, reason: "down" }, T0);
    expect(await retryCheckRecovery(db, { scope: SCOPE, attemptId: id, nowMs: DEADLINE + 1 })).toBe(true);
    const row = await rawRow(db, id);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.last_error).toBeNull();
    // Identity and evidence retained: no new generation, no cleared ids.
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
    // The old row is terminal, so retry refuses it; the active row is the
    // registry's live subject and the old identity is untouched.
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
    // A different SHA proves nothing about this head.
    expect(await readPublicationProof(db, { scope: SCOPE, headSha: `f${SHA.slice(1)}` })).toBeNull();
    // A prepared-but-unconfirmed row is unproven, never a proof.
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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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

/** Stage a real journal row and confirm proof on it (the §7.7 reader's input). */
async function stageProof(
  db: TestD1,
  publicationId: string,
  kind: "review" | "degraded",
  prNumber = SCOPE.prNumber,
  headSha = SHA,
): Promise<PublicationProof> {
  await stagePublication(db, { id: publicationId, payload: payloadFor(publicationId, kind, prNumber, headSha), nowMs: T0 });
  const lease = await claimPublication(db, publicationId, `pub-${publicationId}`, T0);
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
