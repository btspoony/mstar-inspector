/**
 * M7 Check recovery reconciler tests (plan 68 Task 3, spec review-lifecycle
 * §7.11.2 + §7.11 composition) — `src/worker/check-reconcile.ts` over the REAL
 * migration DDL (bun:sqlite D1 double, tests/store/helpers.ts) with the
 * credential/adapter surface injected (no GitHub, no credentials in tests).
 *
 * Behaviors covered (brief verification list):
 *   - the exact §7.11.2 due selector: live leases, not-yet-due backoff, an
 *     `in_progress` attempt before its EXECUTION deadline, the attempt cap and
 *     suspended rows of an unusable App are all left alone
 *   - an expired `in_progress` attempt becomes a TERMINAL conclusion decided
 *     from persisted proof (normal → success, degraded → neutral, none →
 *     unconfirmed failure); `in_progress` is never handed to `completeCheck`
 *   - adoption BEFORE create: a possibly-sent create is resolved read-only,
 *     a definitively `not-sent` row creates once, and an unproven/ambiguous
 *     absence never creates
 *   - a terminal response is validated against the persisted intent: a
 *     mismatch is not recorded, and an old-epoch response persists nothing
 *   - backoff 1/2/4/8/16 min and give-up at the fifth failure to `local-error`
 *     with `terminal_ms` and the remote id RETAINED
 *   - budgets: ≤6 requests/row, ≤100 requests/run, ≤5s/request clamped by the
 *     remaining run deadline — a deferral mutates nothing and spends no attempt
 *   - tenant/App isolation on the suspension path, plus the status-driven
 *     re-enable loop
 *   - a throwing dependency cannot escape the handler
 *   - the §7.11 scheduled composition `runSweep` → `reconcileReviewLifecycle`
 *     → `reconcileReviewChecks`, each stage caught independently
 */
import { describe, expect, test } from "bun:test";
import type { Scope } from "../../src/contracts/recheck";
import {
  CHECK_BACKOFF_MS,
  CHECK_MAX_ATTEMPTS,
  CHECK_NAME,
  CHECK_RECONCILE_LIMIT,
  CHECK_RECOVERY_LEASE_MS,
  claimAttempt,
  setCheckCreateState,
  setCheckDesired,
  type CheckAttempt,
  type CheckConclusion,
  type CheckIdentity,
  type CheckRemote,
  type Lease,
  type PublicationProof,
} from "../../src/store/review-checks";
import {
  CHECK_RECONCILE_MAX_REQUESTS,
  CHECK_RECONCILE_PER_REQUEST_MS,
  CHECK_RECONCILE_RUN_BUDGET_MS,
  CHECK_ROW_MAX_REQUESTS,
  defaultCheckReconcileLog,
  reconcileReviewChecks,
  type CheckCredentialFactory,
  type CheckReconcileDeps,
  type CheckTransport,
} from "../../src/worker/check-reconcile";
import type { ScheduledEnv } from "../../src/worker/env";
import { defaultReconcileLog } from "../../src/worker/lifecycle-reconcile";
import { defaultSweepLog } from "../../src/worker/sweep";
import worker from "../../src/worker/index";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const APP = "11111111-2222-3333-4444-555555555555";
const APP_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NUMERIC_APP = 1001;
const NUMERIC_APP_B = 1002;
const SCOPE: Scope = { appId: APP, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SCOPE_B: Scope = { appId: APP_B, installationId: 456, owner: "other", repo: "gadgets", prNumber: 7 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;
/** The consumer's claim happened an hour before T0; its lease died 30 min before. */
const CLAIM_AT = T0 - 3_600_000;
const EXPIRED_DEADLINE = T0 - 1_800_000;

const SILENT_LOG = { warn: () => {}, info: () => {} };

function asEnv(db: TestD1): ScheduledEnv {
  return { DB: db as unknown as ScheduledEnv["DB"] };
}

function seedApp(
  db: TestD1,
  id: string,
  githubAppId: number,
  options: { install?: boolean; installationId?: number; status?: string } = {},
): void {
  const { install = true, installationId = 123, status = "active" } = options;
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, review_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc-pem', 'enc-secret', 'tester', ?, NULL, 1, datetime('now'), datetime('now'))`,
    )
    .run(id, `checks-${id}`, githubAppId, `checks-${id}`, status);
  if (install) {
    db.raw
      .prepare(
        `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
         VALUES (?, ?, ?, 'acme', datetime('now'))`,
      )
      .run(`inst-${id}-${installationId}`, id, installationId);
  }
}

function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  seedApp(db, APP, NUMERIC_APP);
  seedApp(db, APP_B, NUMERIC_APP_B, { installationId: SCOPE_B.installationId });
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function claim(
  db: TestD1,
  overrides: Partial<Parameters<typeof claimAttempt>[1]> = {},
): Promise<{ attempt: CheckAttempt; lease: Lease }> {
  const result = await claimAttempt(db, {
    scope: SCOPE,
    githubAppId: NUMERIC_APP,
    headSha: SHA,
    triggeredBy: "octocat",
    action: "review",
    holder: "consumer-run",
    nowMs: CLAIM_AT,
    executionDeadlineMs: EXPIRED_DEADLINE,
    ...overrides,
  });
  if (result.kind !== "claimed") {
    throw new Error(`expected a claimed attempt, got ${result.kind}`);
  }
  return { attempt: result.attempt, lease: result.lease };
}

function remoteFor(identity: CheckIdentity, overrides: Partial<CheckRemote> = {}): CheckRemote {
  return {
    id: overrides.id ?? 4242,
    name: overrides.name ?? CHECK_NAME,
    head_sha: overrides.head_sha ?? identity.headSha,
    external_id: overrides.external_id === undefined ? identity.externalId : overrides.external_id,
    app: overrides.app === undefined ? { id: identity.githubAppId } : overrides.app,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined ? "success" : overrides.conclusion,
  };
}

/** A self-consistent persisted publication proof for the attempt's scope/SHA. */
function proofFor(identity: CheckIdentity, kind: "review" | "degraded" = "review"): PublicationProof {
  return {
    publicationId: `pub-${identity.attemptId}`,
    scope: identity.scope,
    headSha: identity.headSha,
    kind,
    round: 3,
    commentId: 77,
    bodySha256: "a".repeat(64),
    confirmedMs: T0 - 10_000,
  };
}

function seedPublication(
  db: TestD1,
  scope: Scope,
  headSha: string,
  proof: PublicationProof,
  phase = "confirmed",
): void {
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms, confirmed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, 'done', ?, ?, ?)`,
    )
    .run(
      proof.publicationId,
      scope.appId,
      scope.installationId,
      scope.owner,
      scope.repo,
      scope.prNumber,
      headSha,
      proof.kind,
      phase,
      JSON.stringify(proof),
      T0 - 20_000,
      T0 - 10_000,
      T0 - 10_000,
    );
}

async function rawRow(db: TestD1, id: string): Promise<Record<string, string | number | null>> {
  return (await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(id).first()) as Record<
    string,
    string | number | null
  >;
}

// ---------------------------------------------------------------------------
// Scripted adapter double + real dispatch meter
// ---------------------------------------------------------------------------

type AdoptOutcome = { kind: "found"; remote: CheckRemote } | { kind: "absent" | "incomplete" | "ambiguous" };
type BeginOutcome = { kind: "ready"; remote: CheckRemote } | { kind: "unavailable"; reason: string };
type FetchOutcome = { kind: "found"; remote: CheckRemote } | { kind: "absent" } | { kind: "unavailable"; reason: string };
type CompleteOutcome = { kind: "completed"; remote: CheckRemote } | { kind: "unavailable"; reason: string };

type AdapterScript = {
  /**
   * REAL requests each adapter call issues through the run transport before
   * answering. 1 mirrors a single-request operation; a higher value simulates
   * the multi-request shapes the live adapter can produce (a paginated
   * adoption walk, a token mint plus a call), which is what the per-row
   * bound has to absorb.
   */
  requestsPerCall?: number;
  adopt?: (identity: CheckIdentity) => Promise<AdoptOutcome>;
  begin?: (identity: CheckIdentity) => Promise<BeginOutcome>;
  fetch?: (identity: CheckIdentity, checkRunId: number) => Promise<FetchOutcome>;
  complete?: (identity: CheckIdentity, checkRunId: number, conclusion: CheckConclusion) => Promise<CompleteOutcome>;
};

/** Counts real dispatches — the transport is the only path to `fetch`. */
function stubFetch(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * The injected credential factory: one purpose-scoped "adapter" per App pair
 * whose operations issue real requests through the run's own transport, so
 * every assertion about budgets counts genuine dispatches rather than
 * simulated ones. `scopeFor` is the one pair the script serves; every other
 * pair resolves `unavailable`, exactly like a routing miss.
 *
 * `beginCheck` deliberately writes the durable `sending` transition through
 * the REAL store, because that is what the live adapter does before it lets a
 * create request leave — a double that skipped it would make the row's
 * `not-sent` state contradict the run it just created.
 */
function scriptedCredentials(
  db: TestD1,
  script: AdapterScript = {},
  capture?: { transport?: CheckTransport },
  scopeFor: Scope = SCOPE,
): CheckCredentialFactory {
  return async ({ scope, transport }) => {
    if (capture !== undefined) capture.transport = transport;
    if (scope.appId !== scopeFor.appId || scope.installationId !== scopeFor.installationId) {
      return { kind: "unavailable", reason: "missing" };
    }
    const perCall = script.requestsPerCall ?? 1;
    const spend = async (): Promise<void> => {
      for (let i = 0; i < perCall; i += 1) {
        try {
          await transport.fetchImpl("https://api.github.com/checks");
        } catch {
          return; // refused before dispatch — the caller reads budget.refused
        }
      }
    };
    return {
      kind: "ok",
      adapter: {
        adoptCheckRun: async ({ identity }) => {
          await spend();
          return script.adopt === undefined ? { kind: "absent" } : script.adopt(identity);
        },
        beginCheck: async ({ identity, lease }) => {
          // Mirror the live adapter: `sending` is persisted BEFORE the request.
          // One millisecond inside the recovery lease is a valid fence instant
          // for every clock these tests use.
          await setCheckCreateState(db, identity.attemptId, lease, "sending", undefined, lease.untilMs - 1);
          await spend();
          return script.begin === undefined
            ? { kind: "unavailable", reason: "no create scripted" }
            : script.begin(identity);
        },
        fetchCheckRun: async ({ identity, checkRunId }) => {
          await spend();
          return script.fetch === undefined
            ? { kind: "unavailable", reason: "no fetch scripted" }
            : script.fetch(identity, checkRunId);
        },
        completeCheck: async ({ identity, checkRunId, conclusion }) => {
          await spend();
          return script.complete === undefined
            ? { kind: "unavailable", reason: "no complete scripted" }
            : script.complete(identity, checkRunId, conclusion);
        },
      },
    };
  };
}

/**
 * The ordinary healthy flow: nothing is observable yet, the create lands, and
 * the run then reads back terminal and in agreement with the frozen intent.
 */
function agreeingScript(
  conclusion: CheckConclusion["desired"] = "failure",
  checkRunId = 4242,
): AdapterScript {
  return {
    adopt: async () => ({ kind: "absent" }),
    begin: async (identity) => ({
      kind: "ready",
      remote: remoteFor(identity, { id: checkRunId, status: "in_progress", conclusion: null }),
    }),
    fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { id: checkRunId, status: "completed", conclusion }) }),
  };
}

function run(db: TestD1, deps: CheckReconcileDeps = {}) {
  // The caller's log wins when supplied (tests that assert on warn events);
  // silence is only the default.
  return reconcileReviewChecks(asEnv(db), { log: SILENT_LOG, ...deps });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("budget and selector constants (spec §7.11.2)", () => {
  test("pins the §7.11.2 verbatim bounds", () => {
    expect(CHECK_RECONCILE_MAX_REQUESTS).toBe(100);
    expect(CHECK_RECONCILE_RUN_BUDGET_MS).toBe(60_000);
    expect(CHECK_RECONCILE_PER_REQUEST_MS).toBe(5_000);
    expect(CHECK_ROW_MAX_REQUESTS).toBe(6);
    expect(CHECK_MAX_ATTEMPTS).toBe(5);
    expect(CHECK_RECONCILE_LIMIT).toBe(25);
    expect(CHECK_RECOVERY_LEASE_MS).toBe(120_000);
    expect(CHECK_BACKOFF_MS).toEqual([60_000, 120_000, 240_000, 480_000, 960_000]);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("due selection (spec §7.11.2 predicate)", () => {
  test("a LIVE lease is never examined, claimed or mutated by a stale reconciler", async () => {
    const db = seededDb();
    // The consumer still holds an unexpired claim lease.
    const { attempt, lease } = await claim(db, { executionDeadlineMs: T0 + 900_000 });
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db) });
      expect(summary.examined).toBe(0);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.holder).toBe(lease.holder);
    expect(row.lease_epoch).toBe(lease.epoch);
    expect(row.lease_until_ms).toBe(lease.untilMs);
    expect(row.terminal_ms).toBeNull();
    expect(fetchStub.urls).toHaveLength(0);
  });

  test("an expired ATTEMPT under a live LEASE stays protected (expiry is not a takeover)", async () => {
    const db = seededDb();
    // The execution deadline has passed, but the recovery lease the claim
    // carries is still live: an expired attempt is not an expired lease.
    const { attempt } = await claim(db, { nowMs: T0, executionDeadlineMs: T0 + 900_000 });
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0 + 1_000, credentials: scriptedCredentials(db) });
      expect(summary.examined).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).terminal_ms).toBeNull();
  });

  test("an in_progress attempt is not due before its EXECUTION deadline", async () => {
    const db = seededDb();
    const { attempt } = await claim(db, { nowMs: T0, executionDeadlineMs: T0 + 900_000 });
    // Released and backoff-due, but the execution deadline is still ahead.
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = 1, next_attempt_ms = ? WHERE id = ?`)
      .run(T0, attempt.identity.attemptId);
    const summary = await run(db, { now: () => T0 + 60_000, credentials: scriptedCredentials(db) });
    expect(summary.examined).toBe(0);
  });

  test("a not-yet-due row and a row at the attempt cap are both left alone", async () => {
    const db = seededDb();
    const due = await claim(db, { action: "due" });
    const early = await claim(db, { action: "early", triggeredBy: "other" });
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, next_attempt_ms = ?, attempts = 1 WHERE id = ?`)
      .run(T0 + 60_000, early.attempt.identity.attemptId);
    const capped = await claim(db, { action: "capped", triggeredBy: "third" });
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = ? WHERE id = ?`)
      .run(CHECK_MAX_ATTEMPTS, capped.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript()) });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, early.attempt.identity.attemptId)).terminal_ms).toBeNull();
    expect((await rawRow(db, capped.attempt.identity.attemptId)).attempts).toBe(CHECK_MAX_ATTEMPTS);
    expect((await rawRow(db, capped.attempt.identity.attemptId)).terminal_ms).toBeNull();
  });

  test("a lease that goes LIVE between selection and claim stops the row (selection grants no ownership)", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    const fetchStub = stubFetch();
    try {
      // The row is due when selected; before this lane can claim it, another
      // invocation acquires a live lease (the credentials step runs in that
      // window). The conditional reacquire must then refuse, and the lane must
      // write NOTHING — selection alone grants no ownership (§7.11.2 step 1).
      const summary = await run(db, {
        now: () => T0,
        credentials: async () => {
          db.raw
            .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = 9, lease_until_ms = ? WHERE id = ?`)
            .run(T0 + CHECK_RECOVERY_LEASE_MS, attempt.identity.attemptId);
          return {
            kind: "ok",
            adapter: {
              adoptCheckRun: async () => {
                throw new Error("adoption must not run: the claim fence refused first");
              },
              beginCheck: async () => {
                throw new Error("create must not run: the claim fence refused first");
              },
              fetchCheckRun: async () => {
                throw new Error("fetch must not run: the claim fence refused first");
              },
              completeCheck: async () => {
                throw new Error("complete must not run: the claim fence refused first");
              },
            },
          };
        },
      });
      expect(summary.completed).toBe(0);
      expect(summary.gaveUp).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    // The other holder's lease, epoch and timestamps are untouched.
    expect(row.holder).toBe("other-run");
    expect(row.lease_epoch).toBe(9);
    expect(row.lease_until_ms).toBe(T0 + CHECK_RECOVERY_LEASE_MS);
    expect(row.attempts).toBe(0);
    expect(row.terminal_ms).toBeNull();
    expect(row.desired).toBe("in_progress");
    expect(lease.holder).toBe("consumer-run");
  });

  test("a suspended row of a DISABLED App is not examined and stays suspended", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended' WHERE id = ?`)
      .run(attempt.identity.attemptId);
    db.raw.prepare(`UPDATE github_apps SET status = 'disabled' WHERE id = ?`).run(APP);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db) });
      expect(summary.examined).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");
  });
});

// ---------------------------------------------------------------------------
// Proof-based terminal conclusions for an expired attempt
// ---------------------------------------------------------------------------

describe("expired attempt → terminal conclusion from persisted proof (spec §7.9)", () => {
  test("a matching normal publication proof concludes success and marks observed", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            // The lane must never hand an `in_progress` value to the update,
            // and the shipped text is the frozen proof-derived intent.
            expect(conclusion.desired).toBe("success");
            expect(conclusion.title).toBe(CHECK_NAME);
            expect(conclusion.summary).toContain("Review published for 0123456 (round 3).");
            expect(conclusion.summary).toContain("not code approval or a merge gate");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success" }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
      expect(summary.gaveUp).toBe(0);
      expect(summary.unconfirmed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
    expect(row.recovery_state).toBe("done");
    expect(row.terminal_ms).toBe(T0);
    expect(row.publication_id).toBe(proof.publicationId);
  });

  test("a confirmed degraded publication concludes neutral, not success", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    seedPublication(db, SCOPE, SHA, proofFor(attempt.identity, "degraded"), "applied");
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("neutral");
            expect(conclusion.summary).toBe("Review output was invalid; a degraded summary comment was published.");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "neutral" }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("neutral");
    expect(row.observed).toBe("neutral");
  });

  test("an expired attempt with NO proof concludes an honest unconfirmed failure", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("failure");
            expect(conclusion.summary).toBe(
              "Review attempt could not be confirmed complete; publication status is unknown.",
            );
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).observed).toBe("failure");
  });

  test("a newly discovered proof CORRECTS a persisted unknown failure to success on the same run", async () => {
    const db = seededDb();
    const { attempt, lease } = await claim(db);
    // The consumer already froze an unconfirmed failure with no proof link.
    expect(
      await setCheckDesired(
        db,
        attempt.identity.attemptId,
        lease,
        { desired: "failure", title: CHECK_NAME, summary: "unconfirmed" },
        null,
        CLAIM_AT,
      ),
    ).toBe(true);
    const proof = proofFor(attempt.identity, "review");
    seedPublication(db, SCOPE, SHA, proof);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("success");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "success" }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("success");
    expect(row.publication_id).toBe(proof.publicationId);
    // The correction happened on the SAME owned run — no second generation.
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM review_checks`).first()).toEqual({ n: 1 });
  });

  test("proof from ANOTHER SHA never decides this attempt's conclusion", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    seedPublication(db, SCOPE, `f${SHA.slice(1)}`, proofFor(attempt.identity, "review"));
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity, _id, conclusion) => {
            expect(conclusion.desired).toBe("failure");
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
          },
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.desired).toBe("failure");
    expect(row.publication_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adopt before create
// ---------------------------------------------------------------------------

describe("adoption before creation (spec §7.9 / RL-12)", () => {
  test("a possibly-sent create is resolved by read-only adoption, never a second create", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    // A create was attempted (durable `sending`) and its run exists remotely.
    db.raw.prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`).run(attempt.identity.attemptId);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async (identity) => ({
            kind: "found",
            remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }),
          }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { id: 909, status: "in_progress", conclusion: null }) }),
          complete: async (identity, runId) => {
            expect(runId).toBe(909);
            return { kind: "completed", remote: remoteFor(identity, { id: 909, conclusion: "failure" }) };
          },
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBe(909);
    expect(row.create_state).toBe("known");
  });

  test("a definitively unsent attempt creates exactly once when adoption proves absence", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { id: 555, status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { id: 555, status: "in_progress", conclusion: null }) }),
          complete: async (identity) => ({ kind: "completed", remote: remoteFor(identity, { id: 555, conclusion: "failure" }) }),
        }),
      });
      expect(summary.completed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(1);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBe(555);
    expect(row.create_state).toBe("known");
  });

  test("an UNPROVEN absence (incomplete walk) never creates and stays recoverable", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "incomplete" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }),
      });
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBeNull();
    expect(row.create_state).toBe("not-sent");
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
    expect(row.attempts).toBe(1);
  });

  test("a possibly-sent create with an OBSERVED absence is still never re-created (uncertain stays remote-unconfirmed)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    // `sending` means a create request may have reached GitHub. An absence in
    // the listForRef window is NOT proof none was created — GitHub's own
    // listing is bounded — so the honest answer is read-only recovery only.
    db.raw.prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`).run(attempt.identity.attemptId);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }),
      });
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.create_state).toBe("sending");
    expect(row.check_run_id).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
  });

  test("an ambiguous walk (two matching candidates) never creates", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "ambiguous" }),
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
        }),
      });
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("remote-unconfirmed");
  });
});

// ---------------------------------------------------------------------------
// Response validation / stale epoch
// ---------------------------------------------------------------------------

describe("response validation and stale-epoch writes (spec §7.11.2 step 4)", () => {
  test("a terminal response that does not match the persisted intent is NOT recorded", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          // The remote closed with a DIFFERENT conclusion (a manual close or
          // another writer) — evidence of something else, never an observation
          // of this attempt's intended outcome.
          complete: async (identity) => ({ kind: "completed", remote: remoteFor(identity, { conclusion: "cancelled" }) }),
        }),
      });
      expect(summary.completed).toBe(0);
      expect(summary.unconfirmed).toBe(1);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.observed).toBe("unknown");
    expect(row.desired).toBe("failure");
    expect(row.terminal_ms).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
  });

  test("an old-epoch response cannot persist an observation once the lease moved", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          fetch: async (identity) => ({ kind: "found", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
          complete: async (identity) => {
            // Between the validated response and the local write, another
            // invocation's recovery claim takes the row over (new epoch).
            db.raw
              .prepare(`UPDATE review_checks SET lease_epoch = lease_epoch + 1 WHERE id = ?`)
              .run(identity.attemptId);
            return { kind: "completed", remote: remoteFor(identity, { conclusion: "failure" }) };
          },
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    // The stale writer advanced neither `observed` nor terminality.
    expect(row.observed).toBe("unknown");
    expect(row.terminal_ms).toBeNull();
  });

  test("a known remote id is RETAINED when its run is absent remotely (never cleared to create a lookalike)", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 321 WHERE id = ?`)
      .run(attempt.identity.attemptId);
    let creates = 0;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          begin: async (identity) => {
            creates += 1;
            return { kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) };
          },
          fetch: async () => ({ kind: "absent" }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    expect(creates).toBe(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.check_run_id).toBe(321);
    expect(row.create_state).toBe("known");
    expect(row.recovery_state).toBe("remote-unconfirmed");
  });
});

// ---------------------------------------------------------------------------
// Backoff and give-up
// ---------------------------------------------------------------------------

describe("backoff and honest give-up (spec §7.11.2 steps 4–5)", () => {
  test("a first failure defers with the 1-minute backoff, releases the lease and spends one attempt", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => ({ kind: "unavailable", reason: "check create failed: socket hang up" }),
        }),
      });
      expect(summary.unconfirmed).toBe(1);
      expect(summary.gaveUp).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[0]!);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.terminal_ms).toBeNull();
  });

  test("the fifth failure gives up to local-error with terminal_ms and every remote identity RETAINED", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(
        `UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, attempts = ?, create_state = 'known', check_run_id = 777 WHERE id = ?`,
      )
      .run(CHECK_MAX_ATTEMPTS - 1, attempt.identity.attemptId);
    const warned: { event: string; detail: string }[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        log: { warn: (fields) => void warned.push(fields), info: () => {} },
        credentials: scriptedCredentials(db, {
          fetch: async () => ({ kind: "unavailable", reason: "check get failed: 502" }),
        }),
      });
      expect(summary.gaveUp).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.recovery_state).toBe("local-error");
    expect(row.terminal_ms).toBe(T0);
    // Nothing dropped, nothing cleared, no false closure claimed.
    expect(row.check_run_id).toBe(777);
    expect(row.external_id).toBe(attempt.identity.externalId);
    expect(row.generation).toBe(attempt.identity.generation);
    const giveUp = warned.find((entry) => entry.event === "ops_check_reconcile_gave_up");
    expect(giveUp).toBeDefined();
    expect(giveUp!.detail).toContain(`app=${APP}`);
    expect(giveUp!.detail).toContain(`work=${attempt.identity.attemptId}`);
    expect(giveUp!.detail).not.toContain(SHA);
  });

  test("give-up never fires below the cap, and the deferral follows the 1/2/4/8 ladder", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`UPDATE review_checks SET attempts = 3 WHERE id = ?`).run(attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async () => ({ kind: "absent" }),
          begin: async () => ({ kind: "unavailable", reason: "check create failed: 500" }),
        }),
      });
    } finally {
      fetchStub.restore();
    }
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + CHECK_BACKOFF_MS[3]!); // 8 minutes
    expect(row.terminal_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe("request budgets (spec §7.11.2 step 5)", () => {
  test("admission stops a row at ≤6 dispatched requests, mutating nothing and spending no attempt", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const fetchStub = stubFetch();
    try {
      // Each adapter call issues 4 real requests, so the row's flow would need
      // 8 (adopt + create) — the per-row bound must refuse the last two
      // BEFORE dispatch.
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          requestsPerCall: 4,
          adopt: async () => ({ kind: "absent" }),
          begin: async (identity) => ({ kind: "ready", remote: remoteFor(identity, { status: "in_progress", conclusion: null }) }),
        }),
      });
      expect(summary.gaveUp).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(fetchStub.urls).toHaveLength(CHECK_ROW_MAX_REQUESTS);
    const row = await rawRow(db, attempt.identity.attemptId);
    // The deferral mutated NOTHING and spent NO attempt: the row stays due.
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.terminal_ms).toBeNull();
  });

  test("the run refuses at ≤100 requests and never dispatches the 101st", async () => {
    const db = seededDb();
    await claim(db);
    const capture: { transport?: CheckTransport } = {};
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => T0,
        credentials: async ({ transport }) => {
          capture.transport = transport;
          return { kind: "unavailable", reason: "missing" };
        },
      });
      const transport = capture.transport;
      if (transport === undefined) throw new Error("the run never built a transport");
      const before = fetchStub.urls.length;
      for (let i = 0; i < CHECK_RECONCILE_MAX_REQUESTS; i += 1) {
        await transport.fetchImpl(`https://api.github.com/x?n=${i}`);
      }
      expect(fetchStub.urls.length - before).toBe(CHECK_RECONCILE_MAX_REQUESTS);
      await expect(transport.fetchImpl("https://api.github.com/x?over=1")).rejects.toThrow(/budget exhausted/);
      expect(fetchStub.urls.length - before).toBe(CHECK_RECONCILE_MAX_REQUESTS);
    } finally {
      fetchStub.restore();
    }
  });

  test("each request is bounded at ≤5s and clamped by the remaining run deadline", async () => {
    const db = seededDb();
    await claim(db);
    const capture: { transport?: CheckTransport } = {};
    let clock = T0;
    const fetchStub = stubFetch();
    try {
      await run(db, {
        now: () => clock,
        credentials: async ({ transport }) => {
          capture.transport = transport;
          return { kind: "unavailable", reason: "missing" };
        },
      });
      const transport = capture.transport!;
      expect(transport.boundMs()).toBe(CHECK_RECONCILE_PER_REQUEST_MS);
      clock = T0 + CHECK_RECONCILE_RUN_BUDGET_MS - 10;
      expect(transport.boundMs()).toBe(10);
      clock = T0 + CHECK_RECONCILE_RUN_BUDGET_MS;
      expect(transport.boundMs()).toBe(1); // never zero or negative
    } finally {
      fetchStub.restore();
    }
  });

  test("an exhausted run stops before claiming, leaving the row due with no attempt spent", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    let clock = T0;
    const fetchStub = stubFetch();
    try {
      // The run's deadline is computed at the pass's start (T0), then the clock
      // jumps past it: no request can be admitted, so nothing is claimed.
      const summary = await run(db, {
        now: () => {
          const value = clock;
          clock = T0 + CHECK_RECONCILE_RUN_BUDGET_MS;
          return value;
        },
        credentials: scriptedCredentials(db, agreeingScript()),
      });
      expect(summary.examined).toBe(1);
      expect(summary.completed).toBe(0);
    } finally {
      fetchStub.restore();
    }
    expect(fetchStub.urls).toHaveLength(0);
    const row = await rawRow(db, attempt.identity.attemptId);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.terminal_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tenant / App isolation and re-enable
// ---------------------------------------------------------------------------

describe("tenant/App isolation and status-driven re-enable (spec §7.6)", () => {
  test("only the unusable pair is suspended; the healthy pair still completes", async () => {
    const db = seededDb();
    const good = await claim(db, { action: "good" });
    const bad = await claim(db, { scope: SCOPE_B, githubAppId: NUMERIC_APP_B, action: "bad" });
    // The bad pair's row carries a remote run id, so its suspension path is
    // reached without any create/adopt for a pair that has no credentials.
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'known', check_run_id = 42 WHERE id = ?`)
      .run(bad.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, { now: () => T0, credentials: scriptedCredentials(db, agreeingScript()) });
      expect(summary.completed).toBe(1);
      expect(summary.suspended).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, good.attempt.identity.attemptId)).recovery_state).toBe("done");
    const badRow = await rawRow(db, bad.attempt.identity.attemptId);
    expect(badRow.recovery_state).toBe("suspended");
    expect(badRow.terminal_ms).toBeNull();
    // The suspended row kept its whole identity for a later inspection.
    expect(badRow.external_id).toBe(bad.attempt.identity.externalId);
    expect(badRow.app_id).toBe(APP_B);
    expect(badRow.attempts).toBe(0);
  });

  test("re-enable resumes only suspended work of ACTIVE, non-deleted Apps", async () => {
    const db = seededDb();
    const healthy = await claim(db, { action: "healthy" });
    const disabled = await claim(db, { scope: SCOPE_B, githubAppId: NUMERIC_APP_B, action: "disabled" });
    db.raw
      .prepare(
        `UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended' WHERE id IN (?, ?)`,
      )
      .run(healthy.attempt.identity.attemptId, disabled.attempt.identity.attemptId);
    // The second row's App is disabled: its suspension must survive untouched,
    // which is observable as the lane never even ASKING for that pair.
    db.raw.prepare(`UPDATE github_apps SET status = 'disabled' WHERE id = ?`).run(APP_B);
    const asked: string[] = [];
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: async ({ scope }) => {
          asked.push(scope.appId);
          return { kind: "unavailable", reason: "disabled" };
        },
      });
      // Only the healthy pair was examined. The disabled App's row stayed
      // suspended and was never claimed, asked about, or terminalized.
      expect(summary.examined).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect(asked).toEqual([APP]);
    const disabledRow = await rawRow(db, disabled.attempt.identity.attemptId);
    expect(disabledRow.recovery_state).toBe("suspended");
    expect(disabledRow.terminal_ms).toBeNull();
    expect(disabledRow.holder).toBeNull();
  });

  test("a healthy App's suspended row is re-enabled, then re-suspended while its credentials stay unusable", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw
      .prepare(`UPDATE review_checks SET holder = NULL, lease_until_ms = NULL, recovery_state = 'suspended' WHERE id = ?`)
      .run(attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      // The row is resumed by App status, then the credential check fails
      // again — it ends suspended, never silently left running.
      const summary = await run(db, {
        now: () => T0,
        credentials: async () => ({ kind: "unavailable", reason: "disabled" }),
      });
      expect(summary.suspended).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");

    // A WORKING credential on the next pass proves the re-enable loop is real.
    const second = stubFetch();
    try {
      const summary = await run(db, { now: () => T0 + 1_000, credentials: scriptedCredentials(db, agreeingScript()) });
      expect(summary.completed).toBe(1);
    } finally {
      second.restore();
    }
    expect((await rawRow(db, attempt.identity.attemptId)).observed).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// Throw-proofing
// ---------------------------------------------------------------------------

describe("throw-proofing (spec §7.11 composition)", () => {
  test("a throwing credential factory is contained: the pair is suspended, never a throw", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    const warned: { event: string }[] = [];
    const summary = await run(db, {
      now: () => T0,
      log: { warn: (fields) => void warned.push(fields), info: () => {} },
      credentials: async () => {
        throw new Error("token mint exploded");
      },
    });
    // A throwing credential path is an unusable PAIR (M8's precedent): the row
    // is suspended durably and nothing propagates out of the pass.
    expect(summary.suspended).toBe(1);
    expect(summary.errors).toBe(0);
    expect(warned.some((entry) => entry.event === "ops_check_reconcile_credential_failed")).toBe(true);
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");
  });

  test("an unbound DB binding and a broken D1 both resolve without throwing", async () => {
    const unbound = await reconcileReviewChecks({} as ScheduledEnv, { log: SILENT_LOG });
    expect(unbound).toEqual({ examined: 0, completed: 0, unconfirmed: 0, suspended: 0, gaveUp: 0, errors: 0 });

    const broken = {
      prepare(): never {
        throw new Error("d1 down");
      },
      batch: async () => [],
    } as unknown as TestD1;
    const summary = await run(broken);
    expect(summary.errors).toBe(1);
  });

  test("a throwing adapter on one row never stops the other due row", async () => {
    const db = seededDb();
    // The other row must be IN FLIGHT durably for adoption to be legal on it.
    const first = await claim(db, { action: "first" });
    const second = await claim(db, { action: "second", triggeredBy: "other", headSha: `f${SHA.slice(1)}` });
    db.raw
      .prepare(`UPDATE review_checks SET create_state = 'sending' WHERE id = ?`)
      .run(second.attempt.identity.attemptId);
    const fetchStub = stubFetch();
    try {
      const summary = await run(db, {
        now: () => T0,
        credentials: scriptedCredentials(db, {
          adopt: async (identity) => {
            if (identity.attemptId === first.attempt.identity.attemptId) throw new Error("adapter exploded");
            return { kind: "found", remote: remoteFor(identity, { id: 61, status: "in_progress", conclusion: null }) };
          },
          fetch: async (identity, checkRunId) => ({
            kind: "found",
            remote: remoteFor(identity, { id: checkRunId, status: "completed", conclusion: "failure" }),
          }),
        }),
      });
      expect(summary.examined).toBe(2);
      expect(summary.completed).toBe(1);
      expect(summary.errors).toBe(1);
    } finally {
      fetchStub.restore();
    }
    expect((await rawRow(db, second.attempt.identity.attemptId)).observed).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// Scheduled composition (spec §7.11)
// ---------------------------------------------------------------------------

/**
 * Capture each stage's own structured log sink. The three stages report
 * through three different default sinks, and each emits its terminal line
 * exactly once per pass — so the ORDER of those lines is direct evidence of
 * the composition order (§7.11) rather than an assertion about wiring.
 */
async function captureComposition(env: ScheduledEnv): Promise<string[]> {
  const events: string[] = [];
  const sweepWarn = defaultSweepLog.warn;
  const lifecycleWarn = defaultReconcileLog.warn;
  const lifecycleInfo = defaultReconcileLog.info;
  const checkWarn = defaultCheckReconcileLog.warn;
  const checkInfo = defaultCheckReconcileLog.info;
  defaultSweepLog.warn = (fields) => void events.push(String((fields as { event?: unknown }).event));
  defaultReconcileLog.warn = (fields) => void events.push(fields.event);
  defaultReconcileLog.info = (fields) => void events.push(String(fields.event));
  defaultCheckReconcileLog.warn = (fields) => void events.push(fields.event);
  defaultCheckReconcileLog.info = (fields) => void events.push(String(fields.event));
  try {
    await worker.scheduled({} as never, env, {} as never);
  } finally {
    defaultSweepLog.warn = sweepWarn;
    defaultReconcileLog.warn = lifecycleWarn;
    defaultReconcileLog.info = lifecycleInfo;
    defaultCheckReconcileLog.warn = checkWarn;
    defaultCheckReconcileLog.info = checkInfo;
  }
  return events;
}

describe("scheduled composition (spec §7.11)", () => {
  test("runs runSweep → reconcileReviewLifecycle → reconcileReviewChecks, in that order", async () => {
    const db = seededDb();
    // A breached failure window makes the sweep stage emit its alert line, and
    // a due Check row of an App with NO installation mapping makes the real
    // Checks lane suspend it — a durable, network-free stage effect.
    const store = db.raw;
    for (let i = 0; i < 6; i += 1) {
      store
        .prepare(
          `INSERT INTO review_failures (installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
           VALUES (1, 'acme', 'widgets', 1, '', 'runner', ?, datetime('now'))`,
        )
        .run(`boom-${i}`);
    }
    const { attempt } = await claim(db);
    store.prepare(`DELETE FROM app_installations WHERE app_id = ?`).run(APP);

    const events = await captureComposition({ DB: db as unknown as ScheduledEnv["DB"] });

    const sweepAt = events.indexOf("ops_sweep_alert");
    const lifecycleAt = events.indexOf("ops_lifecycle_reconcile");
    const checksAt = events.indexOf("ops_check_reconcile");
    expect(sweepAt).toBeGreaterThanOrEqual(0);
    expect(lifecycleAt).toBeGreaterThan(sweepAt);
    expect(checksAt).toBeGreaterThan(lifecycleAt);
    // The Checks stage really ran: its durable suspension is present.
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");
  });

  test("a throwing sweep and a throwing lifecycle lane neither stop the Checks lane nor escape the handler", async () => {
    const db = seededDb();
    const { attempt } = await claim(db);
    db.raw.prepare(`DELETE FROM app_installations WHERE app_id = ?`).run(APP);
    // A broken DB makes the sweep's own D1 read throw and both reconcilers'
    // internal catch fire — one stage's failure never becomes another's.
    const broken = {
      prepare(): never {
        throw new Error("d1 down");
      },
      batch: async () => [],
    } as unknown as TestD1;

    const events = await captureComposition({ DB: broken as unknown as ScheduledEnv["DB"] });

    expect(events[0]).toBe("retention_swept_failed");
    expect(events).toContain("ops_sweep_failed");
    expect(events).toContain("ops_lifecycle_reconcile_failed");
    expect(events).toContain("ops_check_reconcile_failed");

    // And with a working DB both later lanes still reach their terminal lines.
    const events2 = await captureComposition({ DB: db as unknown as ScheduledEnv["DB"] });
    expect(events2).toContain("ops_lifecycle_reconcile");
    expect(events2).toContain("ops_check_reconcile");
    expect((await rawRow(db, attempt.identity.attemptId)).recovery_state).toBe("suspended");
  });
});
