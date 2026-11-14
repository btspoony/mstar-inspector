/**
 * GitHub Checks adapter tests (spec review-lifecycle §7.9) —
 * `src/pipeline/checks.ts` against the REAL attempt registry (migration 0021
 * through `createMigratedTestD1`) and a scripted Checks surface.
 *
 * Every Check HTTP request in these tests is answered by a script. NOTHING
 * HERE IS LIVE-VERIFIED: no GitHub, Cloudflare, D1 or Sandbox request is made
 * or claimed (spec §7.13). The mocks exist to falsify the adapter's decisions
 * — what it sends, what it refuses to send, and how it reports a transport it
 * cannot trust — not to demonstrate GitHub's behavior.
 *
 * Behaviors covered (brief verification list):
 *   - create contract: `external_id` present, NO `details_url`, exact run name,
 *     the authoritative head SHA
 *   - a missing Checks surface, a 403/404 permission rejection and any API
 *     failure return `unavailable` and never throw
 *   - send fencing: nothing is created or updated for an attempt the caller no
 *     longer holds, for a run id the attempt never persisted, or against a
 *     terminal intent the caller did not freeze first
 *   - `in_progress` can never reach a completion send
 *   - adoption matches ONLY the persisted external id, App id, SHA and name,
 *     across at most two `filter: "all"` pages; a saturated walk, a malformed
 *     candidate or two distinct matches is never `absent`
 *   - the full conclusion matrix from PERSISTED proof (published / degraded /
 *     unproven × every outcome), including `expired` and `local-error`
 *   - the spec's non-idempotency boundary: a lost create response is reported
 *     honestly rather than retried blindly (no blanket exactly-once claim)
 *   - the single-credential invariant: the surface narrowing on the real
 *     @octokit/rest instance exposes no second auth path
 */
import { describe, expect, test } from "bun:test";
import {
  adoptReleasedCheckAttempt,
  claimAttempt,
  attachCheckRunId,
  CHECK_ATTACH_GRACE_MS,
  CHECK_ATTACH_WINDOW_MS,
  CHECK_LEASE_MS,
  CHECK_NAME,
  CHECK_RECOVERY_LEASE_MS,
  listCheckReconcileBatch,
  rollbackCheckCreateDispatch,
  readPublishedReview,
  recordTerminalizeOutcome,
  releaseAttachedCheck,
  releaseCheckClaim,
  setCheckCreateState,
  setCheckDesired,
  type CheckAttempt,
  type CheckConclusion,
  type CheckIdentity,
  type Lease,
  type PublicationProof,
  type Scope,
} from "../../src/store/review-checks";
import {
  CHECK_SUMMARIES,
  CheckRequestNotDispatched,
  attachCheckAtAcceptance,
  createChecksAdapter,
  createCheckBeginLatch,
  createCheckLifecycle,
  decideConclusion,
  remoteBelongsTo,
  toCheckRemote,
  type CheckRunPayload,
  type ChecksCreateParams,
  type ChecksRelabelParams,
  type ChecksListPage,
  type ChecksListParams,
  type ChecksOctokit,
  type ChecksUpdateParams,
  type ReviewGate,
} from "../../src/pipeline/checks";
import { generateKeyPairSync } from "node:crypto";
import {
  createReviewCommenter,
  isNameRefusal,
  type CommenterFetch,
  REVIEW_WRITE_PERMISSIONS,
  SANDBOX_READ_PERMISSIONS,
  type AuthSeam,
} from "../../src/pipeline/comment";
import { createMigratedTestD1, mapAppToDefaultWorkspace, type TestD1 } from "../store/helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 1001;
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;

async function seededDb(): Promise<TestD1> {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'checks-test', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
  await mapAppToDefaultWorkspace(db, APP_ID);
  return db;
}

/** Claim one attempt against the real registry. */
async function claimedAttempt(
  db: TestD1,
  overrides: Partial<Parameters<typeof claimAttempt>[1]> = {},
): Promise<{ attempt: CheckAttempt; lease: Lease }> {
  CLOCK = T0;
  const result = await claimAttempt(db, {
    scope: SCOPE,
    githubAppId: GITHUB_APP_ID,
    headSha: SHA,
    triggeredBy: "octocat",
    action: "review",
    holder: "run-a",
    nowMs: T0,
    executionDeadlineMs: T0 + CHECK_LEASE_MS,
    ...overrides,
  });
  if (result.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${result.kind}`);
  return result;
}

/** A check-run payload GitHub would answer with, overrideable per test. */
function runPayload(identity: CheckIdentity, overrides: Partial<CheckRunPayload> = {}): CheckRunPayload {
  return {
    id: 4242,
    name: CHECK_NAME,
    head_sha: identity.headSha,
    external_id: identity.externalId,
    status: "in_progress",
    conclusion: null,
    app: { id: identity.githubAppId },
    ...overrides,
  };
}

type CreateCall = { params: ChecksCreateParams; raw: Record<string, unknown> };
/** The request shape the adapter sends: a terminal update or a text-only relabel. */
type UpdateCall = { params: ChecksRelabelParams; raw: Record<string, unknown> };

/**
 * A scripted Checks surface. `respond` decides each call's answer; throws are
 * how an API/permission failure is simulated (octokit rejects with `{status}`).
 */
function fakeChecks(respond: Partial<{
  create: (params: ChecksCreateParams) => Promise<CheckRunPayload> | CheckRunPayload;
  update: (params: ChecksRelabelParams) => Promise<CheckRunPayload> | CheckRunPayload;
  get: (params: { owner: string; repo: string; check_run_id: number }) => CheckRunPayload;
  pages: (params: ChecksListParams, page: number) => ChecksListPage | null;
}> = {}): {
  octokit: ChecksOctokit;
  creates: CreateCall[];
  updates: UpdateCall[];
  lists: ChecksListParams[];
} {
  const creates: CreateCall[] = [];
  const updates: UpdateCall[] = [];
  const lists: ChecksListParams[] = [];
  const octokit: ChecksOctokit = {
    rest: {
      checks: {
        async create(params) {
          // Record the RAW object the adapter built, so an extra key (a
          // details_url, a caller-chosen id) is visible to the assertions.
          creates.push({ params, raw: { ...params } as unknown as Record<string, unknown> });
          if (respond.create === undefined) throw Object.assign(new Error("nope"), { status: 500 });
          return { data: await respond.create(params) };
        },
        async update(params) {
          updates.push({ params, raw: { ...params } as unknown as Record<string, unknown> });
          if (respond.update === undefined) throw Object.assign(new Error("nope"), { status: 500 });
          return { data: await respond.update(params) };
        },
        async get(params) {
          if (respond.get === undefined) throw Object.assign(new Error("missing"), { status: 404 });
          return { data: respond.get(params) };
        },
        async listForRef(params) {
          lists.push(params);
          const page = respond.pages?.(params, params.page) ?? null;
          if (page === null) throw Object.assign(new Error("nope"), { status: 500 });
          return { data: page };
        },
      },
    },
  };
  return { octokit, creates, updates, lists };
}

/** The transaction clock every test drives explicitly (spec §7.0). */
let CLOCK = T0;
function adapterFor(db: TestD1, octokit: ChecksOctokit | null) {
  return createChecksAdapter({ db, nowMs: () => CLOCK, getOctokit: async () => octokit });
}

/** The gate the seeded test App carries (migration 0045's DDL default). */
const GATE: ReviewGate = { minScore: 80, passVerdicts: ["ship it"] };

const SUCCESS: CheckConclusion = {
  desired: "success",
  title: CHECK_NAME,
  summary: CHECK_SUMMARIES.gateMet(SHA.slice(0, 7), 1, "ship it", 90, GATE),
};

describe("beginCheck — the create contract", () => {
  test("sends external_id, the exact name and the authoritative SHA, and NO details_url", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const identity = attempt.identity;
    const fake = fakeChecks({ create: () => runPayload(identity) });
    const result = await adapterFor(db, fake.octokit).beginCheck({ identity, lease });

    expect(result.kind).toBe("ready");
    expect(fake.creates).toHaveLength(1);
    const raw = fake.creates[0]!.raw;
    expect(raw.external_id).toBe(identity.externalId);
    expect(raw.name).toBe(CHECK_NAME);
    expect(raw.head_sha).toBe(SHA);
    expect(raw.owner).toBe("acme");
    expect(raw.repo).toBe("widgets");
    expect(raw.status).toBe("in_progress");
    // spec §7.9 / RL-12: details_url is omitted ENTIRELY (not null, not "").
    expect("details_url" in raw).toBe(false);
    // No caller-chosen run identity is ever sent on create.
    expect("id" in raw).toBe(false);
    expect("check_run_id" in raw).toBe(false);
    expect("output" in raw).toBe(false);
  });

  test("`sending` is persisted BEFORE the create request leaves", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    let stateAtSend: string | undefined;
    const fake = fakeChecks({
      create: () => {
        // Read the durable row at the moment GitHub would receive the request:
        // a lost response is only recoverable if this already says `sending`.
        stateAtSend = String((db.raw.prepare(`SELECT create_state FROM review_checks WHERE id = ?`).get(attempt.identity.attemptId) as { create_state: string }).create_state);
        return runPayload(attempt.identity);
      },
    });
    expect((await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease })).kind).toBe("ready");
    expect(stateAtSend).toBe("sending");
  });

  test("a create that never reached the wire leaves the row unsent", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    // No client at all: nothing was attempted, so `not-sent` must survive —
    // marking it `sending` would strand the attempt as possibly-sent.
    const result = await adapterFor(db, null).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(await runState(db, attempt)).toBe("not-sent");
  });

  test("a client whose create method is MISSING keeps the row unsent (no request, no sending mark)", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    // A surface exists but the exact callable does not: calling it would throw
    // and look like a possibly-lost send, so it must be refused pre-emptively.
    const partial = { rest: { checks: { update: async () => ({ data: null }) } } } as unknown as ChecksOctokit;
    const result = await adapterFor(db, partial).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(await runState(db, attempt)).toBe("not-sent");
    expect((await rowOf(db, attempt)).check_run_id).toBeNull();
  });

  test("a lease that expires during client resolution blocks the create request", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    // The clock advances past the lease while the client is being resolved —
    // exactly what a real token mint can do. The pre-flight snapshot is not a
    // sufficient send fence; the check must be re-sampled before the request.
    const adapter = createChecksAdapter({
      db,
      nowMs: () => CLOCK,
      getOctokit: async () => {
        CLOCK = lease.untilMs + 1;
        return fake.octokit;
      },
    });
    const result = await adapter.beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
    // Proven pre-send: the fence refused before any request left.
    if (result.kind === "unavailable") expect(result.requests).toBe(0);
    expect(await runState(db, attempt)).toBe("not-sent");
  });

  test("a matching response yields the remote evidence, not an opinion", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity, { id: 987654 }) });
    const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease });
    expect(result).toEqual({
      kind: "ready",
      remote: {
        id: 987654,
        name: CHECK_NAME,
        head_sha: SHA,
        external_id: attempt.identity.externalId,
        app: { id: GITHUB_APP_ID },
        status: "in_progress",
        conclusion: null,
      },
    });
  });

  test("a missing Checks surface (no client) is unavailable, never a throw", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const result = await adapterFor(db, null).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    // No client, no request: nothing can have been created remotely.
    if (result.kind === "unavailable") expect(result.requests).toBe(0);
    expect(await runState(db, attempt)).toBe("not-sent");
  });

  test("a surface without the checks methods (an older/foreign client) is unavailable", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const bare = { rest: {} } as unknown as ChecksOctokit;
    const result = await adapterFor(db, bare).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    // A definitive pre-send refusal: reported as zero requests so a caller can
    // tell it apart from an answered failure.
    if (result.kind === "unavailable") expect(result.requests).toBe(0);
  });

  test("a throwing client factory is unavailable, never an exception", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const adapter = createChecksAdapter({
      db,
      nowMs: () => CLOCK,
      getOctokit: async () => {
        throw new Error("grant mint refused");
      },
    });
    const result = await adapter.beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toMatch(/grant mint refused|no review-write/i);
      expect(result.requests).toBe(0);
    }
  });

  test("403 and 404 permission rejections are unavailable with a named reason", async () => {
    for (const status of [403, 404]) {
      const db = await seededDb();
      const { attempt, lease } = await claimedAttempt(db);
      const fake = fakeChecks({
        create: () => {
          throw Object.assign(new Error("Resource not accessible by integration"), { status });
        },
      });
      const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease });
      expect(result.kind).toBe("unavailable");
      if (result.kind === "unavailable") {
        expect(result.reason).toContain(String(status));
        expect(result.reason.toLowerCase()).toContain("check create");
        // The answer was requested: the run may exist, so the caller must
        // recover by adoption rather than create again.
        expect(result.requests).toBe(1);
      }
      // The attempt stays honest: still un-created, nothing observed.
      const row = await rowOf(db, attempt);
      expect(row.observed).toBe("unknown");
      expect(row.check_run_id).toBeNull();
    }
  });

  test("a 5xx/API failure is unavailable", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({
      create: () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  test("a response that is not our run is unavailable (never adopted)", async () => {
    for (const foreign of [
      { app: { id: 777 } },
      { external_id: "mstar-check:v1:other:1" },
      { name: "other-check" },
      { head_sha: `beef${SHA.slice(4)}` },
    ]) {
      const db = await seededDb();
      const { attempt, lease } = await claimedAttempt(db);
      const fake = fakeChecks({ create: () => runPayload(attempt.identity, foreign) });
      const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease });
      expect(result.kind).toBe("unavailable");
      expect(fake.creates).toHaveLength(1); // it DID send; the answer was not ours
    }
  });

  test("a response missing identity evidence (null app / non-positive id) is unavailable", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => ({ ...runPayload(attempt.identity), app: null }) });
    expect((await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
    const fake2 = fakeChecks({ create: () => ({ ...runPayload(attempt.identity), id: 0 }) });
    expect((await adapterFor(db, fake2.octokit).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
  });

  test("a malformed response body is unavailable", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => null as unknown as CheckRunPayload });
    expect((await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
  });

  test("an attempt that already owns a run is never created again", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    // The refusal is a definitive pre-dispatch one: the additive contract
    // reports a NUMBER, so a caller can read `requests` without narrowing.
    if (result.kind === "unavailable") {
      expect(result.requests).toBe(0);
      expect(result.reason).toMatch(/already owns/i);
    }
    expect(fake.creates).toHaveLength(0); // no duplicate create for an owned run
  });

  test("an ownership-read failure is unavailable with zero requests", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    // The ownership read is the FIRST D1 statement the lane issues; failing it
    // inside `prepare` is the module-level equivalent of a D1 outage.
    const failingDb = {
      ...db,
      prepare: (query: string) => {
        if (query.includes("FROM review_checks")) {
          return {
            bind: () => {
              throw new Error("d1 down");
            },
          } as never;
        }
        return db.prepare(query);
      },
    } as typeof db;
    const result = await adapterFor(failingDb, fake.octokit).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      // A refused guard read never dispatched anything, and the count is
      // numeric rather than undefined.
      expect(result.requests).toBe(0);
      expect(result.reason).toMatch(/ownership read failed/i);
    }
    expect(fake.creates).toHaveLength(0);
  });

  test("every unavailable lane result carries a numeric request count", async () => {
    // The additive `requests` contract is only useful if NO refusal path can
    // leave it undefined: an undefined count would be read as a false
    // zero-request classification by the recovery lane.
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const noClient = await adapterFor(db, null).beginCheck({ identity: attempt.identity, lease });
    const bareSurface = await adapterFor(db, { rest: {} } as unknown as ChecksOctokit).beginCheck({
      identity: attempt.identity,
      lease,
    });
    const stale = await adapterFor(db, fakeChecks().octokit).beginCheck({
      identity: attempt.identity,
      lease: { holder: "run-a", epoch: 1, untilMs: T0 + CHECK_LEASE_MS + 1 },
    });
    await attachedRun(db, attempt, lease, 4242);
    const alreadyAttached = await adapterFor(db, fakeChecks().octokit).beginCheck({ identity: attempt.identity, lease });
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    const unowned = await adapterFor(db, fakeChecks().octokit).completeCheck({
      identity: { ...attempt.identity, attemptId: "11111111-2222-3333-4444-666666666666" },
      lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });

    for (const lane of [noClient, bareSurface, stale, alreadyAttached, unowned]) {
      expect(lane.kind).toBe("unavailable");
      if (lane.kind === "unavailable") expect(typeof lane.requests).toBe("number");
    }
  });

  test("a stale lease sends nothing (the fence is checked immediately before the send)", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const stale: Lease = { holder: "run-a", epoch: 1, untilMs: T0 + CHECK_LEASE_MS + 1 };
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease: stale });
    expect(result.kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
  });

  test("a caller whose identity disagrees with the persisted row sends nothing", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const wrong = { ...attempt.identity, externalId: "mstar-check:v1:forged:9" };
    const result = await adapterFor(db, fake.octokit).beginCheck({ identity: wrong, lease });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.reason).toMatch(/disagrees/);
    expect(fake.creates).toHaveLength(0);
  });
});

// A hoisted attempt for the "not our run" loop above (fresh db per iteration).
let attempt0!: { attempt: CheckAttempt; lease: Lease };
const scopeForAttempt0 = await seededDb();
attempt0 = await claimedAttempt(scopeForAttempt0);

describe("persisted scope identity (spec §7.6 / §7.9)", () => {
  /**
   * A valid lease proves WHO holds the attempt, not WHICH scope it belongs to.
   * Every scope-bound operation must therefore compare the caller's identity
   * against the persisted row before resolving a client or issuing a request:
   * otherwise a lease-holder could aim the purpose-scoped client at another
   * installation or repository while every Check field still matched.
   */
  const scopeChanges: [string, Partial<CheckIdentity["scope"]>][] = [
    ["appId", { appId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }],
    ["installationId", { installationId: 999 }],
    ["owner", { owner: "other-owner" }],
    ["repo", { repo: "other-repo" }],
    ["prNumber", { prNumber: 43 }],
  ];

  for (const [label, change] of scopeChanges) {
    test(`beginCheck refuses a changed scope (${label}) and issues no request`, async () => {
      const db = await seededDb();
      const { attempt, lease } = await claimedAttempt(db);
      const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
      const result = await adapterFor(db, fake.octokit).beginCheck({
        identity: { ...attempt.identity, scope: { ...attempt.identity.scope, ...change } },
        lease,
      });
      expect(result.kind).toBe("unavailable");
      expect(fake.creates).toHaveLength(0);
    });

    test(`adoptCheckRun refuses a changed scope (${label}) and issues no request`, async () => {
      const db = await seededDb();
      const { attempt } = await claimedAttempt(db);
      const fake = fakeChecks({});
      const result = await adapterFor(db, fake.octokit).adoptCheckRun({
        identity: { ...attempt.identity, scope: { ...attempt.identity.scope, ...change } },
      });
      expect(result.kind).toBe("incomplete");
      expect(fake.lists).toHaveLength(0);
    });

    test(`fetchCheckRun refuses a changed scope (${label}) and issues no request`, async () => {
      const db = await seededDb();
      const { attempt } = await claimedAttempt(db);
      const fake = fakeChecks({ get: () => runPayload(attempt.identity, { id: 4242 }) });
      const result = await adapterFor(db, fake.octokit).fetchCheckRun({
        identity: { ...attempt.identity, scope: { ...attempt.identity.scope, ...change } },
        checkRunId: 4242,
      });
      expect(result.kind).toBe("unavailable");
    });
  }

  test("a changed generation or external id is refused too", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const adapter = adapterFor(db, fake.octokit);
    expect((await adapter.beginCheck({
      identity: { ...attempt.identity, generation: attempt.identity.generation + 1 },
      lease,
    })).kind).toBe("unavailable");
    expect((await adapter.beginCheck({
      identity: { ...attempt.identity, externalId: "mstar-check:v1:other:1" },
      lease,
    })).kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
  });

  test("routing uses the PERSISTED scope, not a caller-supplied one", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const asked: { installationId: number; repo: string }[] = [];
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const adapter = createChecksAdapter({
      db,
      nowMs: () => CLOCK,
      getOctokit: async ({ scope }) => {
        asked.push({ installationId: scope.installationId, repo: scope.repo });
        return fake.octokit;
      },
    });
    expect((await adapter.beginCheck({ identity: attempt.identity, lease })).kind).toBe("ready");
    expect(asked).toEqual([{ installationId: SCOPE.installationId, repo: SCOPE.repo }]);
  });
});

describe("the live-lease send fence (spec §7.9)", () => {
  test("an EXPIRED lease with otherwise-exact fields sends nothing and mutates nothing", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const id = attempt.identity.attemptId;
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const adapter = adapterFor(db, fake.octokit);

    // The exact persisted lease triple, but time has passed its `untilMs`. An
    // expired holder must not create a remote run merely because recovery has
    // not yet bumped the epoch.
    CLOCK = lease.untilMs + 1;
    const result = await adapter.beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
    expect((await rowOf(db, attempt)).check_run_id).toBeNull();

    // Nothing local may be written under the expired lease either.
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, CLOCK)).toBe(false);
    expect((await rowOf(db, attempt)).create_state).toBe("not-sent");
  });

  test("an expired lease cannot complete a run it previously owned", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });

    CLOCK = lease.untilMs + 1;
    const result = await adapterFor(db, fake.octokit).completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });
    expect(result.kind).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });
});

describe("adoptCheckRun — the adoption fences", () => {
  test("adopts ONLY the run whose external id, App id, SHA and name all match", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const identity = attempt.identity;
    const ours = runPayload(identity, { status: "completed", conclusion: "action_required" });
    const crowd = [
      runPayload(identity, { id: 1, external_id: "mstar-check:v1:other:1" }), // another attempt
      runPayload(identity, { id: 2, app: { id: 999 } }), // another App
      runPayload(identity, { id: 3, head_sha: `dead${SHA.slice(4)}` }), // another commit
      runPayload(identity, { id: 4, name: "mstar-inspector review extra" }), // lookalike name
      runPayload(identity, { id: 5, external_id: null }), // uncorrelated run
      ours,
    ];
    const fake = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: crowd.length, check_runs: crowd } : null) });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity });
    expect(result).toEqual({ kind: "found", remote: toCheckRemote(ours)! });
    expect(fake.lists).toHaveLength(1);
    // The bounded query carries the identity, not a name-only guess.
    expect(fake.lists[0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      ref: SHA,
      check_name: CHECK_NAME,
      app_id: GITHUB_APP_ID,
      filter: "all",
      per_page: 100,
      page: 1,
    });
  });

  test("never adopts the run of ANOTHER GENERATION (different external id)", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const sibling = { ...attempt.identity, externalId: "mstar-check:v1:11111111-1111-4111-8111-111111111111:1" };
    const fake = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: 1, check_runs: [runPayload(sibling)] } : null) });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity });
    expect(result.kind).toBe("absent");
  });

  test("never adopts another PR's or another App's run even at the same SHA", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const foreign = [
      runPayload(attempt.identity, { external_id: attempt.identity.externalId.replace(":1", ":1"), head_sha: SHA, app: { id: GITHUB_APP_ID } }),
    ];
    // A run that matches on everything is ours; each single-field break is not.
    const exact = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: 1, check_runs: foreign } : null) });
    expect((await adapterFor(db, exact.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("found");
    for (const broken of [
      { app: { id: GITHUB_APP_ID + 1 } },
      { head_sha: `0f${SHA.slice(2)}` },
      { external_id: null },
      { name: "mstar-inspector review" + " " },
    ]) {
      const fake = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: 1, check_runs: [runPayload(attempt.identity, broken)] } : null) });
      expect((await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("absent");
    }
  });

  test("at most two pages are read, and a match is found on the second", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const filler = Array.from({ length: 100 }, (_, i) => runPayload(attempt.identity, { id: i + 1, external_id: `x${i}` }));
    const fake = fakeChecks({
      pages: (_p, page) =>
        page === 1
          ? { total_count: 101, check_runs: filler }
          : page === 2
            ? { total_count: 101, check_runs: [runPayload(attempt.identity, { id: 555 })] }
            : null,
    });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity });
    expect(result.kind).toBe("found");
    expect(fake.lists.map((p) => p.page)).toEqual([1, 2]);
  });

  test("a saturated page-1 match must finish the walk: a duplicate on page 2 is ambiguous", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const identity = attempt.identity;
    const filler = Array.from({ length: 99 }, (_, i) => runPayload(identity, { id: i + 1, external_id: `x${i}` }));
    const fake = fakeChecks({
      pages: (_p, page) =>
        page === 1
          // SATURATED (100 runs) with exactly ONE match: the pre-fix walk
          // returned `found` here without ever reading page 2.
          ? { total_count: 101, check_runs: [...filler, runPayload(identity, { id: 500 })] }
          : page === 2
            // The duplicate the incomplete walk could not see.
            ? { total_count: 101, check_runs: [runPayload(identity, { id: 501 })] }
            : null,
    });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity });
    expect(result.kind).toBe("ambiguous");
    expect(fake.lists.map((p) => p.page)).toEqual([1, 2]);
  });

  test("a saturated page-1 match is confirmed by a complete page 2 (uniqueness proven)", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const identity = attempt.identity;
    const filler = Array.from({ length: 99 }, (_, i) => runPayload(identity, { id: i + 1, external_id: `x${i}` }));
    const fake = fakeChecks({
      pages: (_p, page) =>
        page === 1
          ? { total_count: 100, check_runs: [...filler, runPayload(identity, { id: 500 })] }
          : page === 2
            // A SHORT page exhausts the candidate set: uniqueness is now proven.
            ? { total_count: 100, check_runs: [runPayload(identity, { id: 9, external_id: "someone-else" })] }
            : null,
    });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity });
    expect(result).toMatchObject({ kind: "found", remote: { id: 500 } });
    expect(fake.lists.map((p) => p.page)).toEqual([1, 2]);
  });

  test("a still-saturated two-page walk with one match stays incomplete, never found", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const identity = attempt.identity;
    const pageWith = (page: number, match: boolean) => {
      // 100 runs = a SATURATED page; the match-bearing page carries 99 fillers
      // plus our run, the other carries 100 fillers so the walk never exhausts.
      const fillers = Array.from({ length: match ? 99 : 100 }, (_, i) =>
        runPayload(identity, { id: page * 1000 + i, external_id: `x${page}-${i}` }),
      );
      return match ? [...fillers, runPayload(identity, { id: 500 })] : fillers;
    };
    const fake = fakeChecks({
      pages: (_p, page) =>
        page === 1
          ? { total_count: 9999, check_runs: pageWith(1, true) }
          : page === 2
            ? { total_count: 9999, check_runs: pageWith(2, false) }
            : null,
    });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity });
    // Uniqueness was never proven: the bound is all the honesty this lane may spend.
    expect(result.kind).toBe("incomplete");
    expect(fake.lists.map((p) => p.page)).toEqual([1, 2]);
  });

  test("a saturated 2-page walk without a match is INCOMPLETE, never absent", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const filler = (page: number) =>
      Array.from({ length: 100 }, (_, i) => runPayload(attempt.identity, { id: page * 1000 + i, external_id: `x${page}-${i}` }));
    const fake = fakeChecks({ pages: (_p, page) => (page <= 2 ? { total_count: 9999, check_runs: filler(page) } : null) });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity });
    expect(result.kind).toBe("incomplete");
    expect(fake.lists.map((p) => p.page)).toEqual([1, 2]); // the bound is honoured
  });

  test("a complete walk with no match is absent (and adoption writes nothing)", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const fake = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: 0, check_runs: [] } : null) });
    expect((await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("absent");
    expect((await rowOf(db, attempt)).check_run_id).toBeNull();
    expect((await rowOf(db, attempt)).create_state).toBe("not-sent");
  });

  test("two distinct matching runs are ambiguous; one malformed candidate is ambiguous", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const two = fakeChecks({
      pages: () => ({
        total_count: 2,
        check_runs: [runPayload(attempt.identity, { id: 1 }), runPayload(attempt.identity, { id: 2 })],
      }),
    });
    expect((await adapterFor(db, two.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("ambiguous");
    const broken = fakeChecks({
      pages: () => ({ total_count: 1, check_runs: [{ ...runPayload(attempt.identity), id: -1 }] }),
    });
    expect((await adapterFor(db, broken.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("ambiguous");
  });

  test("an errored or missing walk is incomplete (absence needs a complete read)", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const failing = fakeChecks({}); // no `pages` responder → listForRef rejects 500
    expect((await adapterFor(db, failing.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
    expect((await adapterFor(db, null).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
  });

  test("adoption is read-only: no create and no update is issued", async () => {
    const db = await seededDb();
    const { attempt } = await claimedAttempt(db);
    const fake = fakeChecks({
      pages: () => ({ total_count: 1, check_runs: [runPayload(attempt.identity)] }),
      create: () => {
        throw new Error("beginCheck must not be called by adoption");
      },
      update: () => {
        throw new Error("completeCheck must not be called by adoption");
      },
    });
    expect((await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("found");
    expect(fake.creates).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });
});

describe("completeCheck — the terminal send", () => {
  test("sends the frozen intent and returns the validated terminal evidence", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    const fake = fakeChecks({
      update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }),
    });
    const result = await adapterFor(db, fake.octokit).completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });
    expect(result.kind).toBe("completed");
    expect(fake.updates).toHaveLength(1);
    const raw = fake.updates[0]!.raw;
    expect(raw).toMatchObject({
      check_run_id: 4242,
      status: "completed",
      conclusion: "success",
      output: { title: CHECK_NAME, summary: SUCCESS.summary },
    });
    // The text belongs to GitHub's `output` object only: a top-level pair is
    // dropped by the API, so a run would carry no gate result at all.
    expect("title" in raw).toBe(false);
    expect("summary" in raw).toBe(false);
    expect("details_url" in raw).toBe(false);
    expect("external_id" in raw).toBe(false); // the caller cannot re-point a run at another identity
  });

  test("a lease that expires during client resolution blocks the update request", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });
    const adapter = createChecksAdapter({
      db,
      nowMs: () => CLOCK,
      getOctokit: async () => {
        CLOCK = lease.untilMs + 1;
        return fake.octokit;
      },
    });
    const result = await adapter.completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });
    expect(result.kind).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });

  test("a client with no callable update method is refused before any request", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    const partial = { rest: { checks: { create: async () => ({ data: null }) } } } as unknown as ChecksOctokit;
    const result = await adapterFor(db, partial).completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });
    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.reason).toMatch(/no callable update/);
  });

  test("a run id the attempt never persisted is refused before any request", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });
    const result = await adapterFor(db, fake.octokit).completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 9999,
      conclusion: SUCCESS,
    });
    expect(result.kind).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });

  test("an unattached attempt cannot terminalize any caller-supplied run", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });
    expect(
      (await adapterFor(db, fake.octokit).completeCheck({ identity: attempt.identity, lease, checkRunId: 12345, conclusion: SUCCESS })).kind,
    ).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });

  test("an unpersisted intent cannot be sent (desired is frozen before the update)", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });
    const result = await adapterFor(db, fake.octokit).completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.reason).toMatch(/never persisted|terminal intent/);
    expect(fake.updates).toHaveLength(0);
  });

  test("a conclusion that disagrees with the persisted intent is refused", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    await setCheckDesired(db, attempt.identity.attemptId, lease, { ...SUCCESS, desired: "neutral" }, null, T0);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });
    expect(
      (await adapterFor(db, fake.octokit).completeCheck({ identity: attempt.identity, lease, checkRunId: 4242, conclusion: SUCCESS })).kind,
    ).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });

  test("in_progress can never reach the wire", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity) });
    // The type excludes it; a cast proves the runtime guard holds too.
    const notTerminal = { desired: "in_progress", title: CHECK_NAME, summary: "s" } as unknown as CheckConclusion;
    expect(
      (await adapterFor(db, fake.octokit).completeCheck({ identity: attempt.identity, lease, checkRunId: 4242, conclusion: notTerminal })).kind,
    ).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });

  test("a lost lease sends nothing, and a run whose identity moved is refused", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });
    const taken = { ...lease, epoch: lease.epoch + 1 };
    expect(
      (await adapterFor(db, fake.octokit).completeCheck({ identity: attempt.identity, lease: taken, checkRunId: 4242, conclusion: SUCCESS })).kind,
    ).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });

  test("a response that is not the intended terminal state is unavailable", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    for (const echo of [
      runPayload(attempt.identity, { status: "in_progress", conclusion: null }), // not completed
      runPayload(attempt.identity, { status: "completed", conclusion: "failure" }), // different conclusion
      runPayload(attempt.identity, { status: "completed", conclusion: "success", app: { id: 777 } }), // not ours
    ]) {
      const fake = fakeChecks({ update: () => echo });
      expect(
        (await adapterFor(db, fake.octokit).completeCheck({ identity: attempt.identity, lease, checkRunId: 4242, conclusion: SUCCESS })).kind,
      ).toBe("unavailable");
    }
  });

  test("a 403/5xx update is unavailable with a named reason (never an exception)", async () => {
    for (const status of [403, 502]) {
      const db = await seededDb();
      const { attempt, lease } = await claimedAttempt(db);
      await attachedRun(db, attempt, lease, 4242);
      await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
      const fake = fakeChecks({
        update: () => {
          throw Object.assign(new Error("blocked"), { status });
        },
      });
      const result = await adapterFor(db, fake.octokit).completeCheck({
        identity: attempt.identity,
        lease,
        checkRunId: 4242,
        conclusion: SUCCESS,
      });
      expect(result.kind).toBe("unavailable");
      if (result.kind === "unavailable") expect(result.reason).toMatch(/check update/);
      // An unavailable terminalization never marks the remote observed.
      expect((await rowOf(db, attempt)).observed).toBe("unknown");
    }
  });

  test("check update budget: a timed-out update is unavailable and the lifecycle releases the lease", async () => {
    const db = await seededDb();
    const BUDGET_MS = 20;
    const adapter = createChecksAdapter({
      db,
      nowMs: () => CLOCK,
      getOctokit: async () => fakeChecks({ update: () => new Promise<CheckRunPayload>(() => {}) }).octokit,
      updateBudgetMs: BUDGET_MS,
    });

    // Layer 1 — the adapter: a send that never answers is an unproven REQUEST
    // (1), never a success claim, and it returns at the injected budget.
    const first = await claimedAttempt(db);
    await attachedRun(db, first.attempt, first.lease, 4242);
    expect(await setCheckDesired(db, first.attempt.identity.attemptId, first.lease, SUCCESS, null, T0)).toBe(true);
    const startedAt = Date.now();
    const timedOut = await adapter.completeCheck({
      identity: first.attempt.identity,
      lease: first.lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(timedOut.kind).toBe("unavailable");
    if (timedOut.kind === "unavailable") {
      expect(timedOut.requests).toBe(1);
      expect(timedOut.reason).toMatch(/check update/);
    }

    // Layer 2 — the lifecycle: the same timed-out send reaches terminalize as
    // `requests: 1`, so the attempt is released through the EXISTING
    // deferCheckRecovery path (no new release code lives in the adapter).
    const otherSha = "89abcdef0123456789abcdef0123456789abcdef";
    const second = await claimedAttempt(db, { headSha: otherSha });
    await attachedRun(db, second.attempt, second.lease, 4343);
    const lifecycle = createCheckLifecycle({ db, nowMs: () => CLOCK, getAdapter: () => adapter, getCheckGate: async () => GATE });
    await lifecycle.terminalize({
      handle: {
        attemptId: second.attempt.identity.attemptId,
        scope: SCOPE,
        githubAppId: GITHUB_APP_ID,
        headSha: otherSha,
        lease: second.lease,
      },
      publicationId: null,
      outcome: "publication-unknown",
    });
    const released = await rowOf(db, second.attempt);
    expect(released.recovery_state).toBe("remote-unconfirmed");
    expect(released.holder).toBeNull();
    expect(released.lease_until_ms).toBeNull();
    expect(released.attempts).toBe(1);
    expect(released.next_attempt_ms).toBe(T0 + 60_000);
  });
});

describe("frozen terminal intent (spec §7.9)", () => {
  test("the update ships the PERSISTED text, not the caller's copies", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const id = attempt.identity.attemptId;
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, id, lease, SUCCESS, null, T0)).toBe(true);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });

    // The caller presents a DIVERGENT (and oversized) conclusion for the same
    // enum. The frozen text must win, so nothing unredacted/unbounded reaches
    // the public Check surface.
    const result = await adapterFor(db, fake.octokit).completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 4242,
      conclusion: { desired: "success", title: "hijacked", summary: "x".repeat(5_000) },
    });
    expect(result.kind).toBe("completed");
    expect(fake.updates).toHaveLength(1);
    const raw = fake.updates[0]!.raw;
    const output = raw.output as { title: string; summary: string };
    expect(output.title).toBe(CHECK_NAME);
    expect(output.summary).toBe(SUCCESS.summary);
    expect(output.summary).not.toContain("xxxx");
  });

  test("an oversized or multi-line intent is bounded at persistence", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const id = attempt.identity.attemptId;
    await setCheckDesired(
      db,
      id,
      lease,
      { desired: "failure", title: "t".repeat(500), summary: `line one\nline two\n${"y".repeat(4_000)}` },
      null,
      T0,
    );
    const row = await rowOf(db, attempt);
    expect((row.desired_title as string).length).toBeLessThanOrEqual(120);
    expect((row.desired_summary as string).length).toBeLessThanOrEqual(2_000);
    expect(row.desired_summary).not.toContain("\n");
  });

  test("a divergent conclusion enum is still refused before any request", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "failure" }) });
    const result = await adapterFor(db, fake.octokit).completeCheck({
      identity: attempt.identity,
      lease,
      checkRunId: 4242,
      conclusion: { desired: "failure", title: CHECK_NAME, summary: "different" },
    });
    expect(result.kind).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });
});

describe("per-call update budget (spec §7.10)", () => {
  test("a terminalize per-call bound fires on an adapter built without its own fallback", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    // The adapter carries NO `updateBudgetMs` of its own, so only the caller's
    // per-call value can end this send (its fallback is the 5 s default).
    const fake = fakeChecks({ update: () => Promise.withResolvers<CheckRunPayload>().promise });
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    const startedAt = Date.now();
    await lifecycle.terminalize({
      handle: {
        attemptId: attempt.identity.attemptId,
        scope: attempt.identity.scope,
        githubAppId: attempt.identity.githubAppId,
        headSha: SHA,
        lease,
      },
      publicationId: null,
      outcome: "publication-unknown",
      updateBudgetMs: 100,
    });

    // The update WAS sent and the per-call bound ended it: the 5 s fallback
    // would neither finish this fast nor name 100 ms as the bound.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fake.updates).toHaveLength(1);
    const row = await rowOf(db, attempt);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.last_error).toContain("exceeded 100ms");
    // A timed-out send may still have landed: `observed` never advances here.
    expect(row.observed).toBe("unknown");
  });
});

describe("abandonment is not a conclusion (spec §7.10 / §7.9)", () => {
test("a begin budget that expires DURING the attach still releases the attempt", async () => {
    // The measured shape behind "a Check that only closes at the 900 s
    // deadline": the consumer's 2 s bound expires while the attach write is in
    // flight, so the handle below is returned into a promise nobody awaits.
    // Left on a live lease the row can only be taken over when the execution
    // deadline expires; released, recovery adopts the run within a minute.
    const db = await seededDb();
    CLOCK = T0;
    const latch = createCheckBeginLatch();
    const fake = fakeChecks({
      create: (params) => ({
        id: 4242,
        name: params.name,
        head_sha: params.head_sha,
        external_id: params.external_id,
        status: "in_progress",
        conclusion: null,
        app: { id: GITHUB_APP_ID },
      }),
    });
    const base = adapterFor(db, fake.octokit);
    // The lifecycle's OWN attach write is where the budget expires: the adapter
    // has already created and attached the run, so the pre-attach latch check
    // has passed and only the post-attach one can see the abandonment.
    const dbAtAttach = Object.create(db, {
      prepare: {
        value: (sql: string) => {
          if (sql.includes("check_run_id = COALESCE")) latch.abandon();
          return db.prepare(sql);
        },
      },
    }) as typeof db;
    const lifecycle = createCheckLifecycle({
      db: dbAtAttach,
      nowMs: () => CLOCK,
      getAdapter: () => base,
      getCheckGate: async () => GATE,
    });

    const handle = await lifecycle.begin({
      scope: SCOPE,
      githubAppId: GITHUB_APP_ID,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      executionDeadlineMs: T0 + CHECK_LEASE_MS,
      latch,
    });
    expect(handle).toBeNull();
    expect(fake.creates).toHaveLength(1);

    const row = (await db.prepare(`SELECT * FROM review_checks WHERE head_sha = ?`).bind(SHA).first()) as Record<
      string,
      string | number | null
    >;
    // The run is retained for adoption, and the row is RELEASED rather than
    // left holding a lease nothing will terminalize.
    expect(row.check_run_id).toBe(4242);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
    // No conclusion of its own: the reconciler owes it.
    expect(row.desired).toBe("in_progress");
    expect(row.terminal_ms).toBeNull();
    // The row names the branch, which is what the diagnostic column is for.
    expect(row.terminalize_outcome).toBe("no-handle");
  });

  test("an abandoned begin leaves no terminal intent, only the honest recovery state", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({
      create: (params) => ({
        id: 4242,
        name: params.name,
        head_sha: params.head_sha,
        external_id: params.external_id,
        status: "in_progress",
        conclusion: null,
        app: { id: GITHUB_APP_ID },
      }),
    });
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });
    // The consumer's 2 s bound elapsed while this create ran: the latch is
    // already tripped when the lifecycle reads it.
    const latch = createCheckBeginLatch();
    latch.abandon();

    const handle = await lifecycle.begin({
      scope: SCOPE,
      githubAppId: GITHUB_APP_ID,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      executionDeadlineMs: T0 + CHECK_LEASE_MS,
      latch,
    });
    expect(handle).toBeNull();
    // The create DID run, and the run id is retained so recovery adopts it.
    expect(fake.creates).toHaveLength(1);

    const row = (await db.prepare(`SELECT * FROM review_checks WHERE head_sha = ?`).bind(SHA).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.check_run_id).toBe(4242);
    // No terminal intent: freezing one is what left a red Check behind a review
    // that published afterwards. The reconciler owes this conclusion.
    expect(row.desired).toBe("in_progress");
    expect(row.desired_title).toBeNull();
    expect(row.desired_summary).toBeNull();
    expect(row.terminal_ms).toBeNull();
    // Released with the honest recovery state (a request was spent) and the
    // first backoff rung; no attempt burned beyond the claim's own.
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
  });
});

describe("fetchCheckRun — the recovery lane's read", () => {
  test("returns the run only when its identity matches this attempt", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ get: () => runPayload(attempt.identity, { id: 4242 }) });
    const found = await adapterFor(db, fake.octokit).fetchCheckRun({ identity: attempt.identity, checkRunId: 4242 });
    expect(found.kind).toBe("found");

    const foreign = fakeChecks({ get: () => runPayload({ ...attempt.identity, externalId: "mstar-check:v1:x:1" }, { id: 4242 }) });
    expect((await adapterFor(db, foreign.octokit).fetchCheckRun({ identity: attempt.identity, checkRunId: 4242 })).kind).toBe("absent");

    const gone = fakeChecks({}); // 404 by default
    expect((await adapterFor(db, gone.octokit).fetchCheckRun({ identity: attempt.identity, checkRunId: 4242 })).kind).toBe("absent");
  });

  test("a run id that does not echo the request is unavailable (a proxy lied)", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ get: () => runPayload(attempt.identity, { id: 111 }) });
    expect((await adapterFor(db, fake.octokit).fetchCheckRun({ identity: attempt.identity, checkRunId: 4242 })).kind).toBe("unavailable");
  });
});

describe("decideConclusion — the §7.9 gate matrix from persisted proof", () => {
  const proof = (kind: "review" | "degraded"): PublicationProof => ({
    publicationId: crypto.randomUUID(),
    scope: SCOPE,
    headSha: SHA,
    kind,
    round: 3,
    commentId: 9001,
    bodySha256: "b".repeat(64),
    confirmedMs: T0,
  });
  const normal = proof("review");
  const degraded = proof("degraded");
  const gate: ReviewGate = { minScore: 80, passVerdicts: ["ship it"] };
  const review = (verdict: string, scorePct: number | null) => ({ verdict, scorePct });
  const sha7 = SHA.slice(0, 7);

  const outcomes = [
    "pre-publication-failure",
    "degraded-not-posted",
    "publication-unknown",
    "expired",
    "local-error",
    "skipped",
  ] as const;

  test("a confirmed normal publication decides from proof: success when the gate is met, whatever the terminal outcome", () => {
    // A proven publication is never demoted by how the attempt ended. The
    // sweep is the WHOLE outcome vocabulary — an unconfirmed or expired
    // attempt, a pre-publication failure, a rejected degraded send, an
    // exhausted finalization — because the proof, not the terminal outcome,
    // decides once a durable normal publication exists.
    for (const outcome of outcomes) {
      for (const score of [80, 100]) {
        const decided = decideConclusion({
          proof: normal,
          outcome,
          gate,
          review: review("ship it", score),
        });
        expect(decided.desired).toBe("success");
        expect(decided.summary).toBe(CHECK_SUMMARIES.gateMet(sha7, normal.round, "ship it", score, gate));
        // The wording is pinned independently of the summary builder.
        expect(decided.summary).toContain('verdict "ship it"');
        expect(decided.summary).toContain(`score ${score}`);
        expect(decided.summary).toContain("floor 80");
        expect(decided.title).toBe(CHECK_NAME);
      }
    }
  });

  test("a score below the floor is failure; the summary names verdict, score, floor and allowed verdicts", () => {
    const decided = decideConclusion({ proof: normal, outcome: "expired", gate, review: review("ship it", 79) });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe(CHECK_SUMMARIES.gateMissed(sha7, "ship it", 79, gate));
    expect(decided.summary).toContain('"ship it"');
    expect(decided.summary).toContain("score 79");
    expect(decided.summary).toContain("floor 80");
    expect(decided.summary).toContain("allowed: ship it");
    expect(decided.title).toBe(CHECK_NAME);
  });

  test("a verdict outside the passing set is failure even at a high score", () => {
    for (const verdict of ["needs fixes", "blocked", "incomplete"]) {
      const decided = decideConclusion({ proof: normal, outcome: "expired", gate, review: review(verdict, 95) });
      expect(decided.desired).toBe("failure");
      expect(decided.summary).toBe(CHECK_SUMMARIES.gateMissed(sha7, verdict, 95, gate));
    }
  });

  test("a missing review row or a missing tally is an unreadable-gate failure, never a pass", () => {
    for (const missing of [null, review("ship it", null)]) {
      const decided = decideConclusion({ proof: normal, outcome: "expired", gate, review: missing });
      expect(decided.desired).toBe("failure");
      expect(decided.summary).toBe(CHECK_SUMMARIES.gateUnreadable(sha7, gate));
    }
  });

  test("an unreadable proof payload is the gate-unreadable failure, never an earlier passing row", async () => {
    // RL-12: an earlier attempt for the same head SHA already wrote a passing
    // `reviews` row. This attempt's proof payload carries no artifact envelope,
    // so the review it published is UNREADABLE — and an unreadable proof must
    // never be backfilled from the projection of another attempt's apply.
    const db = await seededDb();
    const unreadable = proof("review");
    db.raw
      .prepare(
        `INSERT INTO reviews
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, verdict, envelope, reviewed_at)
         VALUES ('earlier-attempt', ?, ?, ?, ?, ?, ?, 'ship it', '{"tally":{"scorePct":96}}', datetime('now'))`,
      )
      .run(APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA);
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'review', 'confirmed', '{"version":1,"artifact":null}', ?, ?)`,
      )
      .run(
        unreadable.publicationId, APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo,
        SCOPE.prNumber, SHA, T0, T0,
      );

    const read = await readPublishedReview(db, {
      scope: SCOPE,
      headSha: SHA,
      publicationId: unreadable.publicationId,
    });
    expect(read).toBeNull();
    // Without a proof id there is no review to judge at all: `null`, never the
    // projection — the set row above stays unread by this call.
    expect(await readPublishedReview(db, { scope: SCOPE, headSha: SHA })).toBeNull();

    const decided = decideConclusion({ proof: unreadable, outcome: "expired", gate, review: read });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe(CHECK_SUMMARIES.gateUnreadable(sha7, gate));
  });

  test("an EMPTY allowed-verdict set misses every review — a saved [] gates every Check to failure", () => {
    // The settings route stores an empty submission as `[]` (readable
    // configuration, never a null gate — see apps-store.test.ts), so no
    // published verdict can be on the allowed set: every proof-carrying Check
    // concludes failure.
    const empty: ReviewGate = { minScore: 0, passVerdicts: [] };
    for (const verdict of ["ship it", "needs fixes", "blocked", "incomplete"]) {
      const decided = decideConclusion({ proof: normal, outcome: "expired", gate: empty, review: review(verdict, 100) });
      expect(decided.desired).toBe("failure");
    }
  });

  test("a confirmed DEGRADED publication is failure for every outcome (neutral is unreachable)", () => {
    for (const outcome of outcomes) {
      const decided = decideConclusion({ proof: degraded, outcome, gate, review: review("ship it", 100) });
      expect(decided.desired).toBe("failure");
      expect(decided.summary).toBe("Review output was invalid; a degraded summary comment was published.");
    }
  });

  test("no proof + pre-publication failure is failure with the reason in the summary", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "pre-publication-failure",
      gate,
      review: null,
      reason: "sandbox clone rejected",
    });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe(
      "Review execution failed before publication: sandbox clone rejected. No review was published.",
    );
  });

  test("no proof + degraded-not-posted is failure with the degraded-notice wording", () => {
    const decided = decideConclusion({ proof: null, outcome: "degraded-not-posted", gate, review: null });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe("Review output was invalid and the degraded notice was not published.");
  });

  test("no proof + skipped (nothing to review and nothing to inherit) is neutral, never a failure", () => {
    // The callers that know the reviewed head pass it (`inherited`); without
    // one there is no result to carry, and the round is not an execution
    // failure either.
    const decided = decideConclusion({ proof: null, outcome: "skipped", gate, review: null });
    expect(decided.desired).toBe("neutral");
    expect(decided.summary).toBe(CHECK_SUMMARIES.skipped);
  });

  // An EMPTY increment is not a free-standing round: its content IS the
  // reviewed head's, so the Check inherits THAT head's gate result. There is
  // no neutral exit on this branch (not even an unreadable baseline) —
  // otherwise one empty commit would replace a failing required Check for the
  // same content with `neutral`.
  const base7 = "fedcba9";
  const inherited = { headSha: SHA, reviewedHeadSha: "fedcba9876543210fedcba9876543210fedcba98" };

  test("an empty increment inherits a missed baseline gate as failure", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "skipped",
      gate,
      review: review("needs fixes", 40),
      inherited,
    });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe(CHECK_SUMMARIES.inheritedGateMissed(sha7, base7, "needs fixes", 40, gate));
    // The head has no new changes and the result belongs to the reviewed head.
    expect(decided.summary).toContain(`No new changes at ${sha7}`);
    expect(decided.summary).toContain(base7);
    expect(decided.summary).toContain('verdict "needs fixes"');
    expect(decided.summary).not.toMatch(/approve|approved|merge gate/i);
  });

  test("an empty increment inherits a met baseline gate as success", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "skipped",
      gate,
      review: review("ship it", 92),
      inherited,
    });
    expect(decided.desired).toBe("success");
    expect(decided.summary).toBe(CHECK_SUMMARIES.inheritedGateMet(sha7, base7, "ship it", 92, gate));
    expect(decided.summary).toContain(`No new changes at ${sha7}`);
    expect(decided.summary).toContain(`score 92`);
    // Naming the inherited result is not an approval of the head under check.
    expect(decided.summary).not.toMatch(/approve|approved/i);
  });

  test("an empty increment fails closed when the current gate or the inherited score is unreadable", () => {
    const unreadable: Array<{ gate: ReviewGate | null; review: { verdict: string; scorePct: number | null } }> = [
      { gate: null, review: review("ship it", 96) },
      { gate, review: review("ship it", null) },
    ];
    for (const input of unreadable) {
      const decided = decideConclusion({ proof: null, outcome: "skipped", ...input, inherited });
      expect(decided.desired).toBe("failure");
      expect(decided.summary).toContain(`No new changes at ${sha7}`);
      expect(decided.summary).toContain(base7);
    }
  });

  test("an empty increment whose baseline result is unreadable fails closed and says why", () => {
    const decided = decideConclusion({ proof: null, outcome: "skipped", gate, review: null, inherited });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe(CHECK_SUMMARIES.inheritedUnreadable(sha7, base7));
    expect(decided.summary).toContain(base7);
    expect(decided.summary).toContain("could not be read");
    expect(decided.summary).toContain("failing closed");
  });

  test("no proof + publication-unknown / expired is the unconfirmed failure", () => {
    for (const outcome of ["publication-unknown", "expired"] as const) {
      const decided = decideConclusion({ proof: null, outcome, gate, review: null });
      expect(decided.desired).toBe("failure");
      expect(decided.summary).toBe(
        "Review attempt could not be confirmed complete; publication status is unknown.",
      );
    }
  });

  // The deadline ended the wait without a proof. Each named cause replaces the
  // generic unknown, so the frozen Check says which evidence it could not read.
  test("a deadline with no publication row staged names that cause", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "expired",
      gate,
      review: null,
      unconfirmedCause: "unstaged",
    });
    expect(decided.desired).toBe("failure");
    expect(decided.title).toBe(CHECK_NAME);
    expect(decided.summary).toBe(CHECK_SUMMARIES.unconfirmedUnstaged);
    expect(decided.summary).toContain("no publication row was staged");
  });

  test("a deadline whose staged publication never landed its proof names that cause", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "expired",
      gate,
      review: null,
      unconfirmedCause: "unproven",
    });
    expect(decided.desired).toBe("failure");
    expect(decided.title).toBe(CHECK_NAME);
    expect(decided.summary).toBe(CHECK_SUMMARIES.unconfirmedUnproven);
    expect(decided.summary).toContain("the proof never landed");
  });

  test("a deadline whose proof read failed names that cause", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "expired",
      gate,
      review: null,
      unconfirmedCause: "unreadable",
    });
    expect(decided.desired).toBe("failure");
    expect(decided.title).toBe(CHECK_NAME);
    expect(decided.summary).toBe(CHECK_SUMMARIES.unconfirmedUnreadable);
    expect(decided.summary).toContain("could not be read");
  });

  test("no proof + local-error is the exhausted finalization wording", () => {
    const decided = decideConclusion({ proof: null, outcome: "local-error", gate, review: null });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe("Finalization could not be confirmed. Manual inspection may be required.");
  });

  test("an unreadable App gate is failure — no floor, no allowed list, never a default", () => {
    for (const applied of [null, review("ship it", 100)]) {
      const decided = decideConclusion({ proof: normal, outcome: "expired", gate: null, review: applied });
      expect(decided.desired).toBe("failure");
      expect(decided.summary).toBe(CHECK_SUMMARIES.gateUnreadableConfig(sha7));
      // A gate that could not be read must not be described as if it were.
      expect(decided.summary).not.toContain("floor");
      expect(decided.summary).not.toContain("allowed:");
    }
  });

  test("a non-default gate is honored (any passing verdict at a lower floor)", () => {
    const loose: ReviewGate = { minScore: 50, passVerdicts: ["ship it", "needs fixes"] };
    const decided = decideConclusion({ proof: normal, outcome: "expired", gate: loose, review: review("needs fixes", 60) });
    expect(decided.desired).toBe("success");
    expect(decided.summary).toBe(CHECK_SUMMARIES.gateMet(sha7, normal.round, "needs fixes", 60, loose));
  });

  test("every summary is bounded and carries no review-approval verbs", () => {
    for (const decided of [
      decideConclusion({ proof: normal, outcome: "publication-unknown", gate, review: review("ship it", 96) }),
      decideConclusion({ proof: normal, outcome: "expired", gate, review: review("needs fixes", 40) }),
      decideConclusion({ proof: normal, outcome: "expired", gate, review: null }),
      decideConclusion({ proof: normal, outcome: "expired", gate: null, review: review("ship it", 96) }),
      decideConclusion({ proof: degraded, outcome: "publication-unknown", gate, review: null }),
      decideConclusion({ proof: null, outcome: "pre-publication-failure", gate, review: null, reason: "x".repeat(9_000) }),
      decideConclusion({ proof: null, outcome: "publication-unknown", gate, review: null }),
      decideConclusion({ proof: null, outcome: "degraded-not-posted", gate, review: null }),
      decideConclusion({ proof: null, outcome: "expired", gate, review: null }),
      decideConclusion({ proof: null, outcome: "expired", gate, review: null, unconfirmedCause: "unstaged" }),
      decideConclusion({ proof: null, outcome: "expired", gate, review: null, unconfirmedCause: "unproven" }),
      decideConclusion({ proof: null, outcome: "expired", gate, review: null, unconfirmedCause: "unreadable" }),
      decideConclusion({ proof: null, outcome: "local-error", gate, review: null }),
    ]) {
      expect(decided.summary.length).toBeLessThanOrEqual(2_000);
      expect(decided.desired).not.toBe("in_progress");
      expect(decided.desired).not.toBe("neutral");
      // D3/RL-10: never an approval, never a merge gate.
      expect(decided.summary).not.toMatch(/approve|approved|request changes|merge gate required|blocking/i);
      expect(decided.summary).not.toMatch(/APPROVE|REQUEST_CHANGES/);
    }
  });

  test("an untrusted reason cannot smuggle a token or newlines into a public summary", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "pre-publication-failure",
      gate,
      review: null,
      reason: `ghp_SECRETVALUE123\nsecond line <script>`,
    });
    expect(decided.summary).not.toContain("ghp_SECRETVALUE123");
    expect(decided.summary).not.toContain("\n");
    expect(decided.summary).toContain("[REDACTED]");
  });
});

describe("empty increment inheritance (spec §7.9)", () => {
  const BASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
  const BASE7 = BASE_SHA.slice(0, 7);

  /** The reviewed head's row: exactly the fields the inherited read consumes. */
  function seedBaselineReview(
    db: TestD1,
    verdict: string,
    scorePct: number | null,
    envelope = JSON.stringify(scorePct === null ? { verdict } : { verdict, tally: { scorePct } }),
    /**
     * The schema's `json_valid(envelope)` CHECK normally forbids an unparseable
     * payload; disable it for the one case that exercises the reader's own
     * defensive parse (a schema divergence or a pre-CHECK row).
     */
    corruptEnvelope = false,
  ): void {
    if (corruptEnvelope) db.raw.exec("PRAGMA ignore_check_constraints = ON");
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id, envelope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        SCOPE.installationId,
        SCOPE.owner,
        SCOPE.repo,
        SCOPE.prNumber,
        BASE_SHA,
        verdict,
        SCOPE.appId,
        envelope,
      );
  }

  test("the terminal Check carries the inherited baseline result, never an unconditional neutral", async () => {
    const cases: Array<{
      name: string;
      baseline: { verdict: string; scorePct: number | null } | null;
      /** Raw row envelope, for a row whose payload cannot be read. */
      envelope?: string;
      /** Insert the envelope with the schema's JSON CHECK disabled. */
      corruptEnvelope?: boolean;
      gate: ReviewGate | null;
      desired: CheckConclusion["desired"];
    }> = [
      // The bypass this test exists for: an empty commit must not turn the
      // reviewed head's failing gate into a neutral required check.
      { name: "baseline below the gate", baseline: { verdict: "needs fixes", scorePct: 40 }, gate: GATE, desired: "failure" },
      { name: "baseline meets the gate", baseline: { verdict: "ship it", scorePct: 92 }, gate: GATE, desired: "success" },
      { name: "readable baseline, unreadable gate", baseline: { verdict: "ship it", scorePct: 92 }, gate: null, desired: "failure" },
      { name: "unreadable baseline", baseline: null, gate: GATE, desired: "failure" },
      // The row exists but its payload cannot be read: still a failure, never
      // a neutral that an empty commit could use to shed a required check.
      { name: "corrupt baseline envelope", baseline: null, envelope: "{not json", corruptEnvelope: true, gate: GATE, desired: "failure" },
      { name: "baseline envelope without a verdict", baseline: null, envelope: JSON.stringify({ tally: { scorePct: 90 } }), gate: GATE, desired: "failure" },
    ];

    for (const testCase of cases) {
      const db = await seededDb();
      if (testCase.baseline !== null) {
        seedBaselineReview(db, testCase.baseline.verdict, testCase.baseline.scorePct, testCase.envelope, testCase.corruptEnvelope);
      } else if (testCase.envelope !== undefined) {
        seedBaselineReview(db, "ship it", 100, testCase.envelope, testCase.corruptEnvelope);
      }
      const { attempt, lease } = await claimedAttempt(db);
      await attachedRun(db, attempt, lease, 4242);
      const fake = fakeChecks({
        update: () => runPayload(attempt.identity, { status: "completed", conclusion: testCase.desired }),
      });
      const lifecycle = createCheckLifecycle({
        db,
        nowMs: () => CLOCK,
        getAdapter: () => adapterFor(db, fake.octokit),
        getCheckGate: async () => testCase.gate,
      });

      await lifecycle.terminalize({
        handle: {
          attemptId: attempt.identity.attemptId,
          scope: SCOPE,
          githubAppId: GITHUB_APP_ID,
          headSha: SHA,
          lease,
        },
        publicationId: null,
        outcome: "skipped",
        inheritedHeadSha: BASE_SHA,
      });

      // The ONE remote send is the inherited conclusion, the row freezes and
      // observes it, and nothing was published: the Check is the only change.
      expect(fake.updates).toHaveLength(1);
      const row = await rowOf(db, attempt);
      expect({
        case: testCase.name,
        sent: fake.updates[0]!.raw.conclusion,
        desired: row.desired,
        observed: row.observed,
      }).toEqual({
        case: testCase.name,
        sent: testCase.desired,
        desired: testCase.desired,
        observed: testCase.desired,
      });
      expect((fake.updates[0]!.raw.output as { summary: string }).summary).toContain(`No new changes at ${SHA.slice(0, 7)}`);
      expect((fake.updates[0]!.raw.output as { summary: string }).summary).toContain(BASE7);
      if (testCase.baseline === null) {
        // A baseline that cannot be read fails the check closed.
        expect((fake.updates[0]!.raw.output as { summary: string }).summary).toContain("could not be read");
        expect((fake.updates[0]!.raw.output as { summary: string }).summary).toContain("failing closed");
      } else if (testCase.gate !== null) {
        expect((fake.updates[0]!.raw.output as { summary: string }).summary).toContain(`verdict "${testCase.baseline.verdict}"`);
      }
    }
  });
});

describe("terminalize reads only this attempt's own publication (spec §7.9)", () => {
  test("a prior generation's applied proof does not decide this attempt's Check", async () => {
    const db = await seededDb();
    // RL-12: a re-trigger reuses the head SHA, so the earlier generation's
    // publication is head-matched too — and it is the OLDEST, which is exactly
    // the row a head-keyed read returns. Its applied proof carries a
    // gate-meeting verdict, so adopting it would freeze `success` on a round
    // that published nothing at all.
    const priorId = crypto.randomUUID();
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms,
            confirmed_ms, applied_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'review', 'applied', ?, ?, 1, 'done', ?, ?, ?, ?)`,
      )
      .run(
        priorId, APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA,
        JSON.stringify({ version: 1, artifact: { payload: { verdict: "ship it", tally: { scorePct: 90 } } } }),
        JSON.stringify({
          publicationId: priorId,
          scope: SCOPE,
          headSha: SHA,
          kind: "review",
          round: 1,
          commentId: 9001,
          bodySha256: "b".repeat(64),
          confirmedMs: T0 - 10_000,
        } satisfies PublicationProof),
        T0 - 20_000, T0 - 10_000, T0 - 10_000, T0 - 5_000,
      );

    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({
      update: () => runPayload(attempt.identity, { status: "completed", conclusion: "failure" }),
    });
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    // This attempt published nothing of its own and inherits no reviewed head,
    // so it has no proof to decide from: unproven, never the prior verdict.
    await lifecycle.terminalize({
      handle: {
        attemptId: attempt.identity.attemptId,
        scope: SCOPE,
        githubAppId: GITHUB_APP_ID,
        headSha: SHA,
        lease,
      },
      publicationId: null,
      outcome: "publication-unknown",
    });

    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.raw.conclusion).toBe("failure");
    expect((fake.updates[0]!.raw.output as { summary: string }).summary).toBe(
      "Review attempt could not be confirmed complete; publication status is unknown.",
    );
    const row = await rowOf(db, attempt);
    expect(row.desired).toBe("failure");
    // The frozen intent claims no publication: the prior generation's link is
    // not this attempt's evidence.
    expect(row.publication_id).toBeNull();
  });

  test("a linked publication with no readable proof is UNPROVEN, never a prior generation's verdict", async () => {
    const db = await seededDb();
    // One row exists per scope/head/kind, so a same-SHA re-trigger owns the
    // DEGRADED row: its own publication is still in flight and carries no proof
    // yet, while the PRIOR generation's `review` row is applied, proven and
    // gate-meeting. The store reader's head fallback returns that older row, so
    // without the id-equality guard this attempt's Check is frozen `success`
    // from a review it never produced.
    const priorId = crypto.randomUUID();
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms,
            confirmed_ms, applied_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'review', 'applied', ?, ?, 1, 'done', ?, ?, ?, ?)`,
      )
      .run(
        priorId, APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA,
        JSON.stringify({ version: 1, artifact: { payload: { verdict: "ship it", tally: { scorePct: 90 } } } }),
        JSON.stringify({
          publicationId: priorId,
          scope: SCOPE,
          headSha: SHA,
          kind: "review",
          round: 1,
          commentId: 9001,
          bodySha256: "b".repeat(64),
          confirmedMs: T0 - 10_000,
        } satisfies PublicationProof),
        T0 - 20_000, T0 - 10_000, T0 - 10_000, T0 - 5_000,
      );
    const ownId = crypto.randomUUID();
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'degraded', 'sending', '{}', NULL, 1, 'pending', ?, ?)`,
      )
      .run(ownId, APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, T0, T0);

    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({
      update: () => runPayload(attempt.identity, { status: "completed", conclusion: "failure" }),
    });
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    // The attempt's own publication is linked but unreadable, so it has no
    // proof to decide from: unproven, never the prior row's gate-derived
    // `success`.
    await lifecycle.terminalize({
      handle: {
        attemptId: attempt.identity.attemptId,
        scope: SCOPE,
        githubAppId: GITHUB_APP_ID,
        headSha: SHA,
        lease,
      },
      publicationId: ownId,
      outcome: "publication-unknown",
    });

    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.raw.conclusion).toBe("failure");
    expect((fake.updates[0]!.raw.output as { summary: string }).summary).toBe(
      "Review attempt could not be confirmed complete; publication status is unknown.",
    );
    const row = await rowOf(db, attempt);
    expect(row.desired).toBe("failure");
    // The frozen link is THIS attempt's own publication, never the prior row.
    expect(row.publication_id).toBe(ownId);
  });
});

describe("identity helpers", () => {
  test("toCheckRemote keeps the evidence fields and rejects a payload that cannot carry identity", () => {
    const identity = attempt0.attempt.identity;
    const ok = toCheckRemote(runPayload(identity));
    expect(ok).toEqual({
      id: 4242,
      name: CHECK_NAME,
      head_sha: SHA,
      external_id: identity.externalId,
      app: { id: GITHUB_APP_ID },
      status: "in_progress",
      conclusion: null,
    });
    expect(toCheckRemote(null)).toBeNull();
    expect(toCheckRemote(undefined)).toBeNull();
    expect(toCheckRemote({ ...runPayload(identity), id: "not-a-number" as unknown as number })).toBeNull();
    expect(toCheckRemote({ ...runPayload(identity), external_id: 42 as unknown as string })).toBeNull();
    expect(toCheckRemote({ ...runPayload(identity), app: { id: "abc" } as unknown as { id: number } })).toBeNull();
    // A bigint id (the installed schema's `number | bigint`) is narrowed to a
    // number, so remote evidence stays JSON-safe.
    expect(toCheckRemote({ ...runPayload(identity), id: 4242n as unknown as number })?.id).toBe(4242);
    expect(toCheckRemote({ ...runPayload(identity), app: { id: 1001n as unknown as number } })?.app).toEqual({ id: 1001 });
  });

  test("remoteBelongsTo needs all four fields (never name alone, never PR association)", () => {
    const identity = attempt0.attempt.identity;
    expect(remoteBelongsTo(runPayload(attempt0.attempt.identity) as never, identity)).toBe(true);
    for (const broken of [
      { app: { id: 999 } },
      { external_id: "other" },
      { head_sha: "other" },
      { name: "other" },
      { app: null },
    ]) {
      expect(remoteBelongsTo(runPayload(identity, broken) as never, identity)).toBe(false);
    }
  });
});

describe("credential boundary (spec §7.6 / §7.9)", () => {
  test("a REAL Checks operation rides the commenter's one review-write mint", async () => {
    // This drives an actual adapter operation obtained through the real
    // `createReviewCommenter`, over a controlled transport, and observes the
    // credential construction behind it. It fails if `getChecksOctokit` built a
    // second client, minted a second `createAppAuth`, or used any purpose other
    // than review-write — none of which the previous method-presence test could
    // detect. The private key is generated per run purely so auth-app can sign
    // its JWT; the single HTTP request it makes (and the Checks request) are
    // answered locally, so nothing here is a live GitHub call.
    const db = await seededDb();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const seam: AuthSeam = { constructed: [], minted: [] };
    const requests: { method: string; url: string; body: string }[] = [];
    const fetchImpl: CommenterFetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push({ method, url, body });
      if (url.includes("/access_tokens")) {
        // The installation-token mint auth-app issues; answered locally.
        return new Response(
          JSON.stringify({
            token: "ghs_controlled",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write", checks: "write" },
            repository_selection: "selected",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      // The Checks create the adapter issues.
      return new Response(
        JSON.stringify({
          id: 4242,
          name: CHECK_NAME,
          head_sha: SHA,
          external_id: expected,
          status: "in_progress",
          conclusion: null,
          app: { id: GITHUB_APP_ID },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };

    const CLOCK_T = T0;
    const attempt = await claimedAttempt(db);
    const expected = attempt.attempt.identity.externalId;
    const commenter = createReviewCommenter(
      { APP_ID: String(GITHUB_APP_ID), PRIVATE_KEY: privateKey },
      { db, nowMs: () => CLOCK_T, fetchImpl, authSeam: seam },
    );
    expect(commenter.checks).toBeDefined();

    const result = await commenter.checks!.beginCheck({ identity: attempt.attempt.identity, lease: attempt.lease });
    expect(result.kind).toBe("ready");

    // The Checks call went through the wire, to the PERSISTED scope.
    const checksCall = requests.find((r) => r.url.includes("/check-runs"));
    expect(checksCall?.method).toBe("POST");
    expect(checksCall?.url).toBe("https://api.github.com/repos/acme/widgets/check-runs");
    expect(checksCall?.body).toContain(expected);

    // ONE credential object served the whole operation.
    expect(seam.constructed).toHaveLength(1);
    // The mint that authorised it is the review-write one, for THIS repository,
    // carrying checks:write — not a sandbox or other-purpose grant.
    const write = seam.minted.find((m) => m.purpose === "review-write");
    expect(write).toBeDefined();
    expect(write?.repo).toBe("widgets");
    expect(write?.installationId).toBe(SCOPE.installationId);
    expect(write?.permissions.checks).toBe("write");
    expect(write?.permissions.contents).toBe("write");
    // The mint precedes the Checks request: the request used that grant.
    expect(requests.findIndex((r) => r.url.includes("/access_tokens"))).toBeLessThan(
      requests.findIndex((r) => r.url.includes("/check-runs")),
    );

    // The Sandbox lane still requests a read-only set with no checks scope.
    await commenter
      .getInstallationToken({ scope: SCOPE, purpose: "sandbox-read" })
      .catch(() => undefined);
    const sandbox = seam.minted.find((m) => m.purpose === "sandbox-read");
    expect(sandbox?.permissions.contents).toBe("read");
    expect(sandbox?.permissions).not.toHaveProperty("checks");
    // Still exactly one construction after a second lane ran.
    expect(seam.constructed).toHaveLength(1);
  });

  test("a renamed repository mints installation-wide instead of failing the Checks lane", async () => {
    // Observed production shape: the persisted scope names a repository that
    // was renamed afterwards. GitHub matches `repositoryNames` EXACTLY, so the
    // scoped mint 404s forever while the REST paths themselves follow the
    // rename — the Check then never leaves `in_progress`.
    const db = await seededDb();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const seam: AuthSeam = { constructed: [], minted: [] };
    const mintBodies: string[] = [];
    // GitHub answers a rename with 404 on some paths and 422 on others; both
    // must trigger the same retry.
    const refusalStatus = 422;
    const fetchImpl: CommenterFetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/access_tokens")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      mintBodies.push(typeof init?.body === "string" ? init.body : "");
      if (mintBodies.length === 1) {
        return new Response(JSON.stringify({ message: "Repository not found" }), {
          status: refusalStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          token: "ghs_wide",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write", checks: "write" },
          repository_selection: "all",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const commenter = createReviewCommenter(
      { APP_ID: String(GITHUB_APP_ID), PRIVATE_KEY: privateKey },
      { db, nowMs: () => T0, fetchImpl, authSeam: seam },
    );

    const grant = await commenter.getInstallationToken({ scope: SCOPE, purpose: "review-write" });
    expect(grant.token).toBe("ghs_wide");
    expect(mintBodies).toHaveLength(2);
    // The first mint was narrowed to the (now stale) repository name; the retry
    // is the same installation and permission set, simply not repository-scoped.
    expect(mintBodies[0]).toContain('"repositories"');
    expect(mintBodies[1]).not.toContain('"repositories"');
    const writeMints = seam.minted.filter((m) => m.purpose === "review-write");
    expect(writeMints).toHaveLength(2);
    expect(writeMints[0]?.installationWide).toBeUndefined();
    expect(writeMints[1]?.installationWide).toBe(true);
    expect(writeMints[1]?.permissions.checks).toBe("write");
  });

  test("the rename refusal is recognised on the error, its response, or only its message", () => {
    // A guard that reads one shape silently disables the mint fallback, which is
    // how a renamed repository froze a Check for hours.
    expect(isNameRefusal(Object.assign(new Error("boom"), { status: 404 }))).toBe(true);
    expect(isNameRefusal(Object.assign(new Error("boom"), { status: 422 }))).toBe(true);
    expect(isNameRefusal({ message: "x", response: { status: 404 } })).toBe(true);
    expect(isNameRefusal({ message: "Repository not found" })).toBe(true);
    expect(isNameRefusal(new Error("Not Found"))).toBe(true);
    expect(isNameRefusal(Object.assign(new Error("nope"), { cause: { status: 422 } }))).toBe(true);
    // Anything else stays a real failure, never a retry.
    expect(isNameRefusal(Object.assign(new Error("boom"), { status: 500 }))).toBe(false);
    expect(isNameRefusal(new Error("rate limited"))).toBe(false);
    expect(isNameRefusal(null)).toBe(false);
    expect(isNameRefusal("plain string")).toBe(false);
  });

  test("a typed pre-dispatch refusal reports zero requests, an unknown failure stays conservative", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    // The transport refused BEFORE dispatch (a budget/allocation gate): the
    // marker is what tells the lane nothing left the process.
    const notDispatched = fakeChecks({
      create: () => {
        throw new CheckRequestNotDispatched("budget exhausted — request not dispatched");
      },
    });
    const zero = await adapterFor(db, notDispatched.octokit).beginCheck({ identity: attempt.identity, lease });
    expect(zero.kind).toBe("unavailable");
    if (zero.kind === "unavailable") expect(zero.requests).toBe(0);
    // The `sending` mark is rolled back so the attempt is createable again.
    expect(await runState(db, attempt)).toBe("not-sent");

    // An UNKNOWN failure must stay adopt-only: octokit's re-wrapped error
    // (marker parked on `cause`) is still recognised, but a plain error is not.
    const second = await claimedAttempt(db, { headSha: SHA.replace("0", "e") });
    const wrapped = fakeChecks({
      create: () => {
        throw Object.assign(new Error("RequestError"), { cause: new CheckRequestNotDispatched("refused before dispatch") });
      },
    });
    const viaCause = await adapterFor(db, wrapped.octokit).beginCheck({ identity: second.attempt.identity, lease: second.lease });
    expect(viaCause.kind).toBe("unavailable");
    if (viaCause.kind === "unavailable") expect(viaCause.requests).toBe(0);

    const third = await claimedAttempt(db, { headSha: SHA.replace("0", "d") });
    const unknown = fakeChecks({
      create: () => {
        throw new Error("socket hangup");
      },
    });
    const conservative = await adapterFor(db, unknown.octokit).beginCheck({ identity: third.attempt.identity, lease: third.lease });
    expect(conservative.kind).toBe("unavailable");
    if (conservative.kind === "unavailable") expect(conservative.requests).toBe(1);
    // An unprovable failure keeps the durable `sending` mark (adopt-only).
    expect(await runState(db, third.attempt)).toBe("sending");
  });

  test("a client whose checks surface is absent fails soft, without throwing", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const partial = { rest: { checks: { create: undefined } } } as unknown as ChecksOctokit;
    expect((await adapterFor(db, partial).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
    expect((await adapterFor(db, partial).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
    expect(
      (await adapterFor(db, partial).completeCheck({ identity: attempt.identity, lease, checkRunId: 1, conclusion: SUCCESS })).kind,
    ).toBe("unavailable");
  });

  test("an unowned attempt produces no request even when a client is present", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    // Terminalize the attempt through the store, then the adapter must refuse.
    await attachedRun(db, attempt, lease, 4242);
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    expect(await setCheckCreateState(db, attempt.identity.attemptId, lease, "sending", undefined, T0)).toBe(true);
    const fake = fakeChecks({
      create: () => {
        throw new Error("must not send");
      },
      update: () => {
        throw new Error("must not send");
      },
    });
    // A recovery takeover fences the original holder out of every send.
    const takeover: Lease = { holder: "reconciler", epoch: lease.epoch + 1, untilMs: lease.untilMs };
    expect((await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease: takeover })).kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });
});

describe("the review-write permission set (spec §7.12)", () => {
  test("checks:write rides the one existing review-write set — no second credential", () => {
    // The Checks lane reuses the commenter's purpose-scoped credential. Adding
    // a separate client/permission set would be a second auth construction
    // point, which the plan forbids; this pins that the write set carries
    // checks:write and that the read-only sandbox grant stays narrow.
    expect(REVIEW_WRITE_PERMISSIONS.checks).toBe("write");
    expect(REVIEW_WRITE_PERMISSIONS.contents).toBe("write");
    expect(REVIEW_WRITE_PERMISSIONS.metadata).toBe("read");
    expect(REVIEW_WRITE_PERMISSIONS.pull_requests).toBe("write");
    expect(REVIEW_WRITE_PERMISSIONS.issues).toBe("write");
    expect(SANDBOX_READ_PERMISSIONS).not.toHaveProperty("checks");
  });
});

describe("the remote non-idempotency boundary (RL-12)", () => {
  test("a create whose response was lost is never blindly re-created", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const id = attempt.identity.attemptId;
    // The send was ATTEMPTED and the response was lost: `sending` with no id.
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, T0)).toBe(true);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const adapter = adapterFor(db, fake.octokit);

    // A second begin on a possibly-sent attempt must issue NO create request:
    // `external_id` is correlation, not server-side idempotency (RL-12), so a
    // blind retry could leave two live runs for one head.
    const result = await adapter.beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);

    // Nor is the state resettable into a createable one: `not-sent` is a
    // definitive pre-send claim and may not be re-asserted after a send was
    // attempted. The row therefore stays honestly un-resolved.
    expect(await setCheckCreateState(db, id, lease, "not-sent", undefined, T0)).toBe(false);
    expect((await adapter.beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);

    const row = await rowOf(db, attempt);
    expect(row.check_run_id).toBeNull();
    expect(row.create_state).toBe("sending");
    expect(row.observed).toBe("unknown");

    // Read-only adoption remains the recovery route; with no matching run it
    // reports incomplete rather than absence, and still creates nothing.
    const adopt = fakeChecks({});
    expect((await adapterFor(db, adopt.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
    expect(adopt.creates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attach at delivery acceptance (spec §7.7 step 4) and adoption (§7.9)
// ---------------------------------------------------------------------------

/** The delivery-side attach call, over the real registry and a scripted surface. */
const ATTACH_INPUT = {
  scope: SCOPE,
  githubAppId: GITHUB_APP_ID,
  headSha: SHA,
  triggeredBy: "octocat",
  action: "review",
  // The delivery identity the attach records on its row and hands to the
  // message: a later settlement must match BOTH.
  deliveryId: "fixture-delivery",
} as const;

/** A create response that echoes the attempt's own identity (the adapter's proof). */
function echoCreate(params: ChecksCreateParams): CheckRunPayload {
  return {
    id: 4242,
    name: CHECK_NAME,
    head_sha: params.head_sha,
    external_id: params.external_id,
    status: "in_progress",
    conclusion: null,
    app: { id: GITHUB_APP_ID },
  };
}

/**
 * Count the adoption claim's ONE statement (epoch bump + execution-deadline
 * move) instead of timing the retry: "was the second attempt entered?" is then
 * a number, not a wall clock. `before` runs synchronously just before the Nth
 * statement, which is how a test drives a state change strictly BETWEEN the two
 * attempts.
 */
function countingAdoptions(
  db: TestD1,
  before?: (n: number) => void,
): { db: TestD1; adoptions: () => number } {
  let n = 0;
  const wrapped = {
    raw: db.raw,
    batch: db.batch.bind(db),
    prepare(query: string) {
      if (query.includes("lease_epoch = lease_epoch + 1") && query.includes("execution_deadline_ms = ?")) {
        n += 1;
        before?.(n);
      }
      return db.prepare(query);
    },
  } as unknown as TestD1;
  return { db: wrapped, adoptions: () => n };
}

async function attachRow(db: TestD1): Promise<Record<string, string | number | null>> {
  return (await db.prepare("SELECT * FROM review_checks ORDER BY created_ms, id LIMIT 1").first()) as Record<
    string,
    string | number | null
  >;
}

describe("attach on delivery acceptance (spec §7.7 step 4)", () => {
  test("creates exactly one run and leaves the row adoptable for the consumer", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({ create: echoCreate });

    const attached = await attachCheckAtAcceptance(
      { db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK },
      ATTACH_INPUT,
    );

    expect(attached.kind).toBe("attached");
    expect(fake.creates).toHaveLength(1);
    const row = await attachRow(db);
    // The durable facts the consumer's `begin` adopts, and nothing else: no
    // holder, no lease, no spent attempt — the row is released, not owned.
    expect(row.create_state).toBe("known");
    expect(row.check_run_id).toBe(4242);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.desired).toBe("in_progress");
    expect(row.attempts).toBe(0);
    // The attach window, not the execution window: a queued message admitted
    // minutes later must still find its row adoptable.
    expect(row.execution_deadline_ms).toBe(T0 + CHECK_ATTACH_WINDOW_MS);
    // ...and if nobody adopts it, the recovery lane may take it at the grace
    // instead of at the window's expiry. A due time, not a delay: adoption
    // ignores it, so the ordinary path still takes the row immediately.
    expect(row.next_attempt_ms).toBe(T0 + CHECK_ATTACH_GRACE_MS);
  });

  test("a duplicate delivery for the same head mints no second run", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({ create: echoCreate });
    const deps = { db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK };

    expect((await attachCheckAtAcceptance(deps, ATTACH_INPUT)).kind).toBe("attached");
    // A queue redelivery / a second webhook for the same head: the claim is
    // `busy`, so nothing is created and nothing is overwritten — a SKIP, not
    // a failure, so the caller logs nothing for it.
    const duplicate = await attachCheckAtAcceptance(deps, ATTACH_INPUT);
    expect(duplicate).toEqual({ kind: "skipped", reason: "busy" });
    expect(fake.creates).toHaveLength(1);
    const rows = (await db.prepare("SELECT COUNT(*) AS n FROM review_checks").first()) as { n: number };
    expect(rows.n).toBe(1);
  });

  test("a failing create never throws: the row goes to the recovery lane as possibly-sent", async () => {
    const db = await seededDb();
    CLOCK = T0;
    // The scripted surface rejects the create (an API/permission failure).
    const fake = fakeChecks({});

    const attached = await attachCheckAtAcceptance(
      { db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK },
      ATTACH_INPUT,
    );

    // A real failure, not a skip: this is the arm the caller owes a warn.
    expect(attached.kind).toBe("failed");
    expect(fake.creates).toHaveLength(1);
    const row = await attachRow(db);
    expect(row.holder).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
    // The run id is unknown, so recovery adopts instead of blindly creating.
    expect(row.check_run_id).toBeNull();
  });

  test("an unavailable Checks surface is a FAILURE, not a skip: the caller owes one warn", async () => {
    const db = await seededDb();
    CLOCK = T0;
    // No client at all (a missing/refused credential): nothing was created, and
    // the row is handed to recovery. The distinction from `skipped` is what
    // makes the delivery path log the failure instead of staying silent.
    const result = await attachCheckAtAcceptance({ db, adapter: adapterFor(db, null), nowMs: () => CLOCK }, ATTACH_INPUT);

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toMatch(/no review-write Checks client/);
    const row = await attachRow(db);
    expect(row.holder).toBeNull();
    expect(row.create_state).toBe("not-sent");
    expect(row.recovery_state).toBe("pending");
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
  });
});

describe("adoption of a released attach row (spec §7.9)", () => {
  test("the consumer adopts the attached run and terminalizes it inline", async () => {
    const db = await seededDb();
    CLOCK = T0;
    let externalId = "";
    const fake = fakeChecks({
      create: (params) => {
        externalId = params.external_id;
        return echoCreate(params);
      },
      update: (params) => ({
        id: params.check_run_id,
        name: CHECK_NAME,
        head_sha: SHA,
        external_id: externalId,
        status: "completed",
        conclusion: (params as ChecksUpdateParams).conclusion,
        app: { id: GITHUB_APP_ID },
      }),
    });
    const adapter = adapterFor(db, fake.octokit);
    expect((await attachCheckAtAcceptance({ db, adapter, nowMs: () => CLOCK }, ATTACH_INPUT)).kind).toBe("attached");
    const row = await attachRow(db);
    const attemptId = row.id as string;

    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapter,
      getCheckGate: async () => GATE,
    });
    const handle = await lifecycle.begin({
      ...ATTACH_INPUT,
      executionDeadlineMs: CLOCK + CHECK_LEASE_MS,
    });

    // The SAME row and the SAME run: no second generation, no second create.
    expect(handle).not.toBeNull();
    expect(handle!.attemptId).toBe(attemptId);
    expect(fake.creates).toHaveLength(1);
    const adopted = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(adopted.holder).toBe(handle!.lease.holder);
    expect(adopted.lease_epoch).toBe(handle!.lease.epoch);
    // The long attach window is narrowed to the execution window the adopting
    // invocation owns.
    expect(adopted.execution_deadline_ms).toBe(CLOCK + CHECK_LEASE_MS);

    // Step 12 runs against the adopted lease: the run reaches its conclusion
    // inline, which is what the consumer records as `completed`.
    await lifecycle.terminalize({ handle: handle!, publicationId: null, outcome: "publication-unknown" });
    expect(fake.updates).toHaveLength(1);
    const terminal = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(terminal.desired).toBe("failure");
    expect(terminal.observed).toBe("failure");
    expect(terminal.terminal_ms).not.toBeNull();
    await recordTerminalizeOutcome(db, attemptId, "completed", 5);
    const recorded = (await db.prepare("SELECT terminalize_outcome FROM review_checks WHERE id = ?").bind(attemptId).first()) as {
      terminalize_outcome: string;
    };
    expect(recorded.terminalize_outcome).toBe("completed");
  });

  test("a row a live holder owns is not adopted, so the review proceeds without a handle", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const { attempt, lease } = await claimedAttempt(db, { holder: "run-a" });
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ create: echoCreate });

    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });
    const handle = await lifecycle.begin({ ...ATTACH_INPUT, executionDeadlineMs: CLOCK + CHECK_LEASE_MS });

    expect(handle).toBeNull();
    expect(fake.creates).toHaveLength(0);
    const row = await rowOf(db, attempt);
    // The live holder keeps its lease: the epoch did not move.
    expect(row.holder).toBe("run-a");
    expect(row.lease_epoch).toBe(1);
  });

  test("a live, fresh delivery holder is not taken over: the consumer proceeds without a handle", async () => {
    const db = await seededDb();
    CLOCK = T0;
    // The overlap the ordering cannot remove: the delivery path gave up waiting
    // and its attach is still running. A holder that wrote a moment ago is
    // working, not stalled, so the consumer must leave it alone.
    const { attempt, lease } = await claimedAttempt(db, { holder: "delivery:attach-in-flight" });
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ create: echoCreate });

    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });
    const handle = await lifecycle.begin({ ...ATTACH_INPUT, executionDeadlineMs: CLOCK + CHECK_LEASE_MS });

    expect(handle).toBeNull();
    expect(fake.creates).toHaveLength(0);
    const row = await rowOf(db, attempt);
    expect(row.holder).toBe("delivery:attach-in-flight");
    expect(row.lease_epoch).toBe(1);
  });

  test("a stalled delivery holder is taken over, and its late write is refused by the epoch fence", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const { attempt, lease: deliveryLease } = await claimedAttempt(db, { holder: "delivery:stalled" });
    await attachedRun(db, attempt, deliveryLease, 4242);
    // The holder has written nothing for longer than the staleness bound: one
    // token mint, one create and two D1 writes do not take that long, so it is
    // stalled (a reclaimed isolate, a hung release).
    await db
      .prepare("UPDATE review_checks SET updated_ms = ? WHERE id = ?")
      .bind(T0 - 6_000, attempt.identity.attemptId)
      .run();
    const fake = fakeChecks({ create: echoCreate });

    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });
    const handle = await lifecycle.begin({ ...ATTACH_INPUT, executionDeadlineMs: CLOCK + CHECK_LEASE_MS });

    expect(handle).not.toBeNull();
    expect(handle!.attemptId).toBe(attempt.identity.attemptId);
    // Same run, narrowed window, epoch bumped: the adopting lease is the one
    // the handle carries.
    const adopted = await rowOf(db, attempt);
    expect(adopted.holder).toBe(handle!.lease.holder);
    expect(adopted.lease_epoch).toBe(2);
    expect(adopted.execution_deadline_ms).toBe(CLOCK + CHECK_LEASE_MS);
    // The stalled holder's late release is refused: its lease triple no longer
    // matches, so it cannot overwrite the adopting invocation's row.
    expect(await releaseCheckClaim(db, attempt.identity.attemptId, deliveryLease, CLOCK)).toBe(false);
    expect((await rowOf(db, attempt)).holder).toBe(handle!.lease.holder);
  });

  test("an attach that releases between the two adoption attempts is adopted by the retry", async () => {
    const db = await seededDb();
    CLOCK = T0;
    // The message was admitted while the delivery holder was still mid-attach:
    // the first adoption refuses a fresh live holder, and the attach releases
    // strictly BETWEEN the two attempts — driven from the second adoption
    // statement, so nothing races a wall clock.
    const { attempt, lease: deliveryLease } = await claimedAttempt(db, {
      holder: "delivery:attach-in-flight",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    await attachedRun(db, attempt, deliveryLease, 4242);
    const counting = countingAdoptions(db, (n) => {
      if (n !== 2) return;
      db.raw
        .prepare(
          `UPDATE review_checks
              SET holder = NULL, lease_until_ms = NULL, next_attempt_ms = ?
            WHERE id = ? AND holder = ? AND lease_epoch = ?`,
        )
        .run(T0 + CHECK_ATTACH_GRACE_MS, attempt.identity.attemptId, "delivery:attach-in-flight", 1);
    });
    const fake = fakeChecks({ create: echoCreate });
    const lifecycle = createCheckLifecycle({
      db: counting.db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    const handle = await lifecycle.begin({ ...ATTACH_INPUT, executionDeadlineMs: CLOCK + CHECK_LEASE_MS });

    // Exactly two adoption statements ran, and the second one took the row.
    expect(counting.adoptions()).toBe(2);
    expect(handle).not.toBeNull();
    expect(handle!.attemptId).toBe(attempt.identity.attemptId);
    expect(handle!.lease.untilMs).toBeGreaterThan(CLOCK);
    expect(fake.creates).toHaveLength(0);
    const row = await rowOf(db, attempt);
    expect(row.holder).toBe(handle!.lease.holder);
    expect(row.lease_epoch).toBe(2);
    expect(row.execution_deadline_ms).toBe(CLOCK + CHECK_LEASE_MS);
  });

  test("the retry never waits on a consumer holder", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const { attempt, lease } = await claimedAttempt(db, { holder: "consumer:another-run" });
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ create: echoCreate });
    const counting = countingAdoptions(db);
    const lifecycle = createCheckLifecycle({
      db: counting.db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    const handle = await lifecycle.begin({ ...ATTACH_INPUT, executionDeadlineMs: CLOCK + CHECK_LEASE_MS });

    // A running review's holder is not waited for: one adoption statement, no
    // second attempt, no handle.
    expect(handle).toBeNull();
    expect(counting.adoptions()).toBe(1);
    const row = await rowOf(db, attempt);
    expect(row.holder).toBe("consumer:another-run");
    expect(row.lease_epoch).toBe(1);
  });

  test("the retry never waits on a frozen intent", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const { attempt, lease } = await claimedAttempt(db, {
      holder: "delivery:attach",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    const fake = fakeChecks({ create: echoCreate });
    const counting = countingAdoptions(db);
    const lifecycle = createCheckLifecycle({
      db: counting.db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    const handle = await lifecycle.begin({ ...ATTACH_INPUT, executionDeadlineMs: CLOCK + CHECK_LEASE_MS });

    // A frozen intent belongs to recovery: one adoption statement, no second
    // attempt, no handle.
    expect(handle).toBeNull();
    expect(counting.adoptions()).toBe(1);
    const row = await rowOf(db, attempt);
    expect(row.desired).toBe("success");
    expect(row.holder).toBe("delivery:attach");
    expect(row.lease_epoch).toBe(1);
  });

  test("an adoption that lands after the begin budget releases the row instead of returning a handle", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({ create: echoCreate });
    expect((await attachCheckAtAcceptance({ db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK }, ATTACH_INPUT)).kind).toBe(
      "attached",
    );
    const row = await attachRow(db);
    const attemptId = row.id as string;
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });
    // The consumer's 2 s budget elapsed while the adoption write was in flight:
    // the handle would go into a promise nobody awaits, so the row is handed
    // back with the run it owns recorded as a no-handle exit.
    const latch = createCheckBeginLatch();
    latch.abandon();

    const handle = await lifecycle.begin({
      ...ATTACH_INPUT,
      executionDeadlineMs: CLOCK + CHECK_LEASE_MS,
      latch,
    });

    expect(handle).toBeNull();
    const released = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(released.holder).toBeNull();
    expect(released.lease_until_ms).toBeNull();
    expect(released.recovery_state).toBe("remote-unconfirmed");
    expect(released.attempts).toBe(1);
    expect(released.terminalize_outcome).toBe("no-handle");
    // The run id survives, so recovery adopts this run instead of a second one.
    expect(released.check_run_id).toBe(4242);
  });

  test("a terminal row is never adopted", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({ create: echoCreate });
    expect(
      (await attachCheckAtAcceptance({ db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK }, ATTACH_INPUT)).kind,
    ).toBe("attached");
    const row = await attachRow(db);
    const attemptId = row.id as string;
    await db.prepare("UPDATE review_checks SET terminal_ms = ? WHERE id = ?").bind(T0, attemptId).run();

    expect(
      await adoptReleasedCheckAttempt(db, {
        attemptId,
        githubAppId: GITHUB_APP_ID,
        holder: "consumer:late",
        executionDeadlineMs: CLOCK + CHECK_LEASE_MS,
        nowMs: CLOCK,
      }),
    ).toBeNull();
  });
});

describe("skip settlement (spec §7.9 / RL-10)", () => {
  /** Attach one run for the fixture scope and return the row's attempt id. */
  async function attachedAttempt(
    db: TestD1,
    fake: ReturnType<typeof fakeChecks>,
  ): Promise<{ attemptId: string; deliveryId: string }> {
    const result = await attachCheckAtAcceptance(
      { db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK },
      ATTACH_INPUT,
    );
    if (result.kind !== "attached") throw new Error(`fixture: expected attached, got ${result.kind}`);
    return { attemptId: (await attachRow(db)).id as string, deliveryId: result.deliveryId };
  }

  /** A scripted surface whose update echoes the intended terminal state. */
  function settlingFake(): ReturnType<typeof fakeChecks> {
    let externalId = "";
    return fakeChecks({
      create: (params) => {
        externalId = params.external_id;
        return echoCreate(params);
      },
      update: (params) => ({
        id: params.check_run_id,
        name: CHECK_NAME,
        head_sha: SHA,
        external_id: externalId,
        status: "completed",
        conclusion: (params as ChecksUpdateParams).conclusion,
        app: { id: GITHUB_APP_ID },
      }),
    });
  }

  test("a skipped delivery settles the attached run neutral with the reason", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = settlingFake();
    const { attemptId, deliveryId } = await attachedAttempt(db, fake);
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    const settled = await lifecycle.settleSkipped({
      scope: SCOPE,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId: deliveryId,
      reason: "already reviewed for this head",
    });

    expect(settled).toBe(true);
    // ONE bounded update, carrying neutral and the skip reason — never a
    // proof-derived failure.
    expect(fake.updates).toHaveLength(1);
    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("neutral");
    expect(fake.updates[0]!.params.output.summary).toContain("already reviewed for this head");
    const row = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.desired).toBe("neutral");
    expect(row.observed).toBe("neutral");
    expect(row.terminal_ms).not.toBeNull();
    expect(row.recovery_state).toBe("done");
  });

  test("without a Checks surface the skip freezes the neutral intent for the reconciler", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = settlingFake();
    const { attemptId, deliveryId } = await attachedAttempt(db, fake);
    // No commenter/adapter at all (the paused gate makes zero credential
    // calls, architect lock L4): the settlement must still take the row and
    // leave a conclusion the recovery lane can send.
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => null,
      getCheckGate: async () => GATE,
    });

    const settled = await lifecycle.settleSkipped({
      scope: SCOPE,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId: deliveryId,
      reason: "review paused",
    });

    expect(settled).toBe(true);
    expect(fake.updates).toHaveLength(0);
    const row = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.desired).toBe("neutral");
    expect(row.observed).toBe("unknown");
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.next_attempt_ms).toBeNull();
    expect(row.terminal_ms).toBeNull();
    // A frozen intent is due immediately: no due time, no proof to wait for.
    expect((await listCheckReconcileBatch(db, T0)).map((candidate) => candidate.identity.attemptId)).toEqual([attemptId]);
  });
  test("a retry after a neutral settlement claims a new generation and its own run", async () => {
    const db = await seededDb();
    CLOCK = T0;
    // Each create mints a distinct run id, so "its own run" is provable.
    let runSeq = 5000;
    const externalByRun = new Map<number, string>();
    const fake = fakeChecks({
      create: (params) => {
        runSeq += 1;
        externalByRun.set(runSeq, params.external_id);
        return { ...echoCreate(params), id: runSeq };
      },
      update: (params) => ({
        id: params.check_run_id,
        name: CHECK_NAME,
        head_sha: SHA,
        external_id: externalByRun.get(params.check_run_id) ?? "",
        status: "completed",
        conclusion: (params as ChecksUpdateParams).conclusion,
        app: { id: GITHUB_APP_ID },
      }),
    });
    const adapter = adapterFor(db, fake.octokit);
    const { attemptId: firstId, deliveryId } = await attachedAttempt(db, fake);
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapter,
      getCheckGate: async () => GATE,
    });

    // The guard refusal settles this delivery's run neutral.
    expect(
      await lifecycle.settleSkipped({
        scope: SCOPE,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
        attachDeliveryId: deliveryId,
        reason: "review admission refused: pr-held",
      }),
    ).toBe(true);
    const settled = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(firstId).first()) as Record<
      string,
      string | number | null
    >;
    expect(settled.observed).toBe("neutral");
    expect(settled.terminal_ms).not.toBeNull();
    const settledRunId = settled.check_run_id as number;

    // The retry (60 s later) claims a NEW generation: the settled row does not
    // retire the head, and the new generation mints its own run.
    CLOCK = T0 + 60_000;
    const handle = await lifecycle.begin({ ...ATTACH_INPUT, executionDeadlineMs: CLOCK + CHECK_LEASE_MS });
    expect(handle).not.toBeNull();
    expect(handle!.attemptId).not.toBe(firstId);
    expect(fake.creates).toHaveLength(2);
    const retryRow = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(handle!.attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(retryRow.generation).toBe(2);
    expect(retryRow.check_run_id).not.toBe(settledRunId);
    expect(retryRow.check_run_id).not.toBeNull();
    expect(retryRow.observed).toBe("unknown");
    expect(retryRow.terminal_ms).toBeNull();
  });
  test("a duplicate skip is a no-op: the row is already terminal", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = settlingFake();
    const { deliveryId } = await attachedAttempt(db, fake);
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });
    const settle = () =>
      lifecycle.settleSkipped({
        scope: SCOPE,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
        attachDeliveryId: deliveryId,
        reason: "already reviewed for this head",
      });

    expect(await settle()).toBe(true);
    // The second delivery's skip finds a terminal row: nothing to take, no
    // second remote update.
    expect(await settle()).toBe(false);
    expect(fake.updates).toHaveLength(1);
  });

  test("a skip never takes a live consumer holder", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const { attempt, lease } = await claimedAttempt(db, { holder: "consumer:running" });
    await attachedRun(db, attempt, lease, 4242);
    const deliveryId = "own-delivery";
    const fake = settlingFake();
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    const settled = await lifecycle.settleSkipped({
      scope: SCOPE,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId: deliveryId,
      reason: "review paused",
    });

    expect(settled).toBe(false);
    expect(fake.updates).toHaveLength(0);
    const row = await rowOf(db, attempt);
    expect(row.holder).toBe("consumer:running");
    expect(row.lease_epoch).toBe(1);
    expect(row.desired).toBe("in_progress");
    expect(row.terminal_ms).toBeNull();
  });

  test("a skip never takes a frozen intent", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const { attempt, lease } = await claimedAttempt(db, {
      holder: "delivery:attach",
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    // The id MATCHES the row's own delivery holder: the refusal here is the
    // frozen intent, not a missing identity.
    const deliveryId = "attach";
    const fake = settlingFake();
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    const settled = await lifecycle.settleSkipped({
      scope: SCOPE,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId: deliveryId,
      reason: "review paused",
    });

    expect(settled).toBe(false);
    expect(fake.updates).toHaveLength(0);
    const row = await rowOf(db, attempt);
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("unknown");
  });

  test("a release fenced out by an adopting consumer is a skip, not an attach failure", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({ create: echoCreate });
    // The admitted consumer adopts the row before this invocation releases it:
    // the epoch moves, so the release matches zero rows. Driving the adoption
    // from the release statement makes the overlap exact.
    const wrapped = {
      raw: db.raw,
      batch: db.batch.bind(db),
      prepare(query: string) {
        if (query.includes("holder = NULL") && query.includes("next_attempt_ms = ?")) {
          db.raw
            .prepare(
              `UPDATE review_checks
                  SET holder = 'consumer:winner', lease_epoch = lease_epoch + 1,
                      lease_until_ms = ?, execution_deadline_ms = ?, updated_ms = ?
                WHERE holder LIKE 'delivery:%'`,
            )
            .run(T0 + CHECK_LEASE_MS, T0 + CHECK_LEASE_MS, T0);
        }
        return db.prepare(query);
      },
    } as unknown as TestD1;

    const result = await attachCheckAtAcceptance(
      { db: wrapped, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK },
      ATTACH_INPUT,
    );

    // The consumer owns the row now: nothing failed, and the attach says so.
    expect(result).toEqual({ kind: "skipped", reason: "adopted" });
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Attach a proven run id through the LEGAL transition path. The store now
 * refuses to attach an id to an attempt whose create was never sent (that
 * would record a run this attempt did not create), so tests must first record
 * the send attempt — exactly as the pipeline does.
 */
async function attachedRun(db: TestD1, attempt: CheckAttempt, lease: Lease, runId: number, now = T0): Promise<void> {
  expect(await setCheckCreateState(db, attempt.identity.attemptId, lease, "sending", undefined, now)).toBe(true);
  expect(await attachCheckRunId(db, attempt.identity.attemptId, lease, runId, now)).toBe(true);
}

async function rowOf(db: TestD1, attempt: CheckAttempt): Promise<Record<string, string | number | null>> {
  return (await db.prepare(`SELECT * FROM review_checks WHERE id = ?`).bind(attempt.identity.attemptId).first()) as Record<
    string,
    string | number | null
  >;
}

async function runState(db: TestD1, attempt: CheckAttempt): Promise<string | null> {
  return ((await rowOf(db, attempt)).create_state as string | null) ?? null;
}

// ---------------------------------------------------------------------------
// Zero-dispatch rollback
// ---------------------------------------------------------------------------

/**
 * The cross-task seam: `beginCheck` persists `create_state = 'sending'` before
 * it may dispatch, and its LAST fence before the callable is a fresh live-lease
 * re-proof. When that fence fails, no Checks request was invoked — the row must
 * not be left claiming that one might have been.
 */
describe("zero-dispatch create refusal rolls the sending mark back", () => {
  test("a lease that expires after the sending mark restores not-sent with no request", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const identity = attempt.identity;
    const fake = fakeChecks({ create: () => runPayload(identity) });
    // `beginCheck` reads the clock twice before dispatch: once for the opening
    // ownership guard, once for the pre-call live-lease re-proof. The clock
    // crosses the lease end on that SECOND read — exactly T2's post-`sending`,
    // pre-call fence — while the durable `sending` write still used the valid
    // first reading.
    let calls = 0;
    const adapter = createChecksAdapter({
      db,
      nowMs: () => {
        calls += 1;
        return calls >= 2 ? lease.untilMs + 1 : CLOCK;
      },
      getOctokit: async () => fake.octokit,
    });

    const result = await adapter.beginCheck({ identity, lease });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") throw new Error("unreachable");
    // The additive contract: zero Checks calls were invoked.
    expect(result.requests).toBe(0);
    expect(fake.creates).toHaveLength(0);

    const row = await rowOf(db, attempt);
    expect(row.create_state).toBe("not-sent");
    expect(row.check_run_id).toBeNull();
    // Nothing else moved: no attempt, no backoff, no error, no identity loss.
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    // The `sending` mark is a transition, not an error, so nothing fabricated
    // and nothing real was lost.
    expect(row.last_error).toBeNull();
    expect(row.external_id).toBe(identity.externalId);
    expect(row.generation).toBe(identity.generation);
    expect(row.terminal_ms).toBeNull();
    // The lease is intact so the caller can still release/attach under it.
    expect(row.holder).toBe(lease.holder);
    expect(row.lease_epoch).toBe(lease.epoch);
  });

  test("a pre-existing error survives the mark and the rollback untouched", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const identity = attempt.identity;
    // A real diagnostic already on the row (e.g. from an earlier deferral).
    const PRIOR = "check get failed: 502 bad gateway";
    await db
      .prepare(`UPDATE review_checks SET last_error = ? WHERE id = ?`)
      .bind(PRIOR, identity.attemptId)
      .run();

    const fake = fakeChecks({ create: () => runPayload(identity) });
    let calls = 0;
    const adapter = createChecksAdapter({
      db,
      nowMs: () => {
        calls += 1;
        return calls >= 2 ? lease.untilMs + 1 : CLOCK;
      },
      getOctokit: async () => fake.octokit,
    });

    const result = await adapter.beginCheck({ identity, lease });
    expect(result.kind).toBe("unavailable");
    const row = await rowOf(db, attempt);
    expect(row.create_state).toBe("not-sent");
    // The sending mark is a transition, not an error: the prior value is
    // neither overwritten with a fabricated sentinel nor cleared.
    expect(row.last_error).toBe(PRIOR);
  });

  test("a stale epoch defeats the rollback: a newer holder's state is untouched", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    // A newer recovery claim takes the row over (epoch bumps) after this
    // caller's `sending` write.
    await db
      .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = ?, lease_until_ms = ? WHERE id = ?`)
      .bind(lease.epoch + 1, T0 + CHECK_RECOVERY_LEASE_MS, attempt.identity.attemptId)
      .run();

    expect(
      await rollbackCheckCreateDispatch(db, attempt.identity.attemptId, lease, T0),
    ).toBe(false);
    const row = await rowOf(db, attempt);
    // The newer holder's row is exactly as it was.
    expect(row.holder).toBe("other-run");
    expect(row.lease_epoch).toBe(lease.epoch + 1);
    expect(row.check_run_id).toBeNull();
  });

  test("a known remote id is never disguised as unsent", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);

    expect(await rollbackCheckCreateDispatch(db, attempt.identity.attemptId, lease, T0)).toBe(false);
    const row = await rowOf(db, attempt);
    expect(row.check_run_id).toBe(4242);
    expect(row.create_state).toBe("known");
  });

  test("the rollback moves only create_state: no attempt, backoff, error or identity change", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await setCheckCreateState(db, attempt.identity.attemptId, lease, "sending", undefined, T0);
    const before = await rowOf(db, attempt);

    expect(await rollbackCheckCreateDispatch(db, attempt.identity.attemptId, lease, T0 + 1)).toBe(true);
    const after = await rowOf(db, attempt);
    expect(after.create_state).toBe("not-sent");
    for (const key of [
      "attempts", "next_attempt_ms", "last_error", "desired", "observed",
      "external_id", "generation", "check_run_id", "publication_id", "terminal_ms",
      "holder", "lease_epoch", "lease_until_ms", "app_id", "owner", "repo", "head_sha",
    ]) {
      expect([key, after[key]]).toEqual([key, before[key]]);
    }
  });
});

describe("markQueuedBehindInflight — the held-check relabel is bounded", () => {
  const relabel = (adapter: ReturnType<typeof adapterFor>, warns: string[], updateBudgetMs = 1_000) =>
    adapter.markQueuedBehindInflight!({
      scope: SCOPE,
      checkRunId: 4242,
      summary: "Queued behind the review in flight for this pull request.",
      updateBudgetMs,
      warn: (detail) => warns.push(detail),
    });

  test("a rejected send is ONE warn and false — it never reaches the caller as a throw", async () => {
    const db = await seededDb();
    const fake = fakeChecks({
      update: () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    });
    const warns: string[] = [];

    expect(await relabel(adapterFor(db, fake.octokit), warns)).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("held check relabel failed: boom");
    // The one request WAS sent — nothing here claims otherwise.
    expect(fake.updates).toHaveLength(1);
  });

  test("a send that never answers returns false inside the budget, so the retry is never held", async () => {
    const db = await seededDb();
    // GitHub accepts the request and never answers it: only the budget ends it.
    const fake = fakeChecks({ update: () => new Promise<CheckRunPayload>(() => {}) });
    const warns: string[] = [];
    const started = Date.now();

    expect(await relabel(adapterFor(db, fake.octokit), warns, 25)).toBe(false);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("exceeded 25ms");
  });

  test("no Checks surface is a silent false: nothing to send, nothing to warn about", async () => {
    const db = await seededDb();
    const warns: string[] = [];

    expect(await relabel(adapterFor(db, null), warns)).toBe(false);
    expect(warns).toHaveLength(0);
  });
});
