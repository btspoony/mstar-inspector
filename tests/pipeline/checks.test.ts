/**
 * GitHub Checks adapter tests (plan 68 Task 1, spec review-lifecycle §7.9) —
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
  claimAttempt,
  attachCheckRunId,
  CHECK_LEASE_MS,
  CHECK_NAME,
  CHECK_RECOVERY_LEASE_MS,
  rollbackCheckCreateDispatch,
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
  createChecksAdapter,
  decideConclusion,
  remoteBelongsTo,
  toCheckRemote,
  type CheckRunPayload,
  type ChecksCreateParams,
  type ChecksListPage,
  type ChecksListParams,
  type ChecksOctokit,
  type ChecksUpdateParams,
} from "../../src/pipeline/checks";
import { generateKeyPairSync } from "node:crypto";
import {
  createReviewCommenter,
  type CommenterFetch,
  REVIEW_WRITE_PERMISSIONS,
  SANDBOX_READ_PERMISSIONS,
  type AuthSeam,
} from "../../src/pipeline/comment";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 1001;
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;

function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 'checks-test', ?, 'checks-test', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
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
type UpdateCall = { params: ChecksUpdateParams; raw: Record<string, unknown> };

/**
 * A scripted Checks surface. `respond` decides each call's answer; throws are
 * how an API/permission failure is simulated (octokit rejects with `{status}`).
 */
function fakeChecks(respond: Partial<{
  create: (params: ChecksCreateParams) => Promise<CheckRunPayload> | CheckRunPayload;
  update: (params: ChecksUpdateParams) => Promise<CheckRunPayload> | CheckRunPayload;
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

const SUCCESS: CheckConclusion = {
  desired: "success",
  title: CHECK_NAME,
  summary: CHECK_SUMMARIES.success(SHA.slice(0, 7), 1),
};

describe("beginCheck — the create contract", () => {
  test("sends external_id, the exact name and the authoritative SHA, and NO details_url", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    // No client at all: nothing was attempted, so `not-sent` must survive —
    // marking it `sending` would strand the attempt as possibly-sent.
    const result = await adapterFor(db, null).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(await runState(db, attempt)).toBe("not-sent");
  });

  test("a client whose create method is MISSING keeps the row unsent (no request, no sending mark)", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const result = await adapterFor(db, null).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    // No client, no request: nothing can have been created remotely.
    if (result.kind === "unavailable") expect(result.requests).toBe(0);
    expect(await runState(db, attempt)).toBe("not-sent");
  });

  test("a surface without the checks methods (an older/foreign client) is unavailable", async () => {
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const bare = { rest: {} } as unknown as ChecksOctokit;
    const result = await adapterFor(db, bare).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    // A definitive pre-send refusal: reported as zero requests so a caller can
    // tell it apart from an answered failure.
    if (result.kind === "unavailable") expect(result.requests).toBe(0);
  });

  test("a throwing client factory is unavailable, never an exception", async () => {
    const db = seededDb();
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
      const db = seededDb();
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
    const db = seededDb();
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
      const db = seededDb();
      const { attempt, lease } = await claimedAttempt(db);
      const fake = fakeChecks({ create: () => runPayload(attempt.identity, foreign) });
      const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease });
      expect(result.kind).toBe("unavailable");
      expect(fake.creates).toHaveLength(1); // it DID send; the answer was not ours
    }
  });

  test("a response missing identity evidence (null app / non-positive id) is unavailable", async () => {
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => ({ ...runPayload(attempt.identity), app: null }) });
    expect((await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
    const fake2 = fakeChecks({ create: () => ({ ...runPayload(attempt.identity), id: 0 }) });
    expect((await adapterFor(db, fake2.octokit).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
  });

  test("a malformed response body is unavailable", async () => {
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => null as unknown as CheckRunPayload });
    expect((await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
  });

  test("an attempt that already owns a run is never created again", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
    const { attempt } = await claimedAttempt(db);
    const stale: Lease = { holder: "run-a", epoch: 1, untilMs: T0 + CHECK_LEASE_MS + 1 };
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const result = await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease: stale });
    expect(result.kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
  });

  test("a caller whose identity disagrees with the persisted row sends nothing", async () => {
    const db = seededDb();
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
      const db = seededDb();
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
      const db = seededDb();
      const { attempt } = await claimedAttempt(db);
      const fake = fakeChecks({});
      const result = await adapterFor(db, fake.octokit).adoptCheckRun({
        identity: { ...attempt.identity, scope: { ...attempt.identity.scope, ...change } },
      });
      expect(result.kind).toBe("incomplete");
      expect(fake.lists).toHaveLength(0);
    });

    test(`fetchCheckRun refuses a changed scope (${label}) and issues no request`, async () => {
      const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
    const { attempt } = await claimedAttempt(db);
    const sibling = { ...attempt.identity, externalId: "mstar-check:v1:11111111-1111-4111-8111-111111111111:1" };
    const fake = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: 1, check_runs: [runPayload(sibling)] } : null) });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity });
    expect(result.kind).toBe("absent");
  });

  test("never adopts another PR's or another App's run even at the same SHA", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
    const { attempt } = await claimedAttempt(db);
    const filler = (page: number) =>
      Array.from({ length: 100 }, (_, i) => runPayload(attempt.identity, { id: page * 1000 + i, external_id: `x${page}-${i}` }));
    const fake = fakeChecks({ pages: (_p, page) => (page <= 2 ? { total_count: 9999, check_runs: filler(page) } : null) });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity });
    expect(result.kind).toBe("incomplete");
    expect(fake.lists.map((p) => p.page)).toEqual([1, 2]); // the bound is honoured
  });

  test("a complete walk with no match is absent (and adoption writes nothing)", async () => {
    const db = seededDb();
    const { attempt } = await claimedAttempt(db);
    const fake = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: 0, check_runs: [] } : null) });
    expect((await adapterFor(db, fake.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("absent");
    expect((await rowOf(db, attempt)).check_run_id).toBeNull();
    expect((await rowOf(db, attempt)).create_state).toBe("not-sent");
  });

  test("two distinct matching runs are ambiguous; one malformed candidate is ambiguous", async () => {
    const db = seededDb();
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
    const db = seededDb();
    const { attempt } = await claimedAttempt(db);
    const failing = fakeChecks({}); // no `pages` responder → listForRef rejects 500
    expect((await adapterFor(db, failing.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
    expect((await adapterFor(db, null).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
  });

  test("adoption is read-only: no create and no update is issued", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    expect(raw).toMatchObject({ check_run_id: 4242, status: "completed", conclusion: "success", title: CHECK_NAME });
    expect(raw.summary).toBe(SUCCESS.summary);
    expect("details_url" in raw).toBe(false);
    expect("external_id" in raw).toBe(false); // the caller cannot re-point a run at another identity
  });

  test("a lease that expires during client resolution blocks the update request", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity, { status: "completed", conclusion: "success" }) });
    expect(
      (await adapterFor(db, fake.octokit).completeCheck({ identity: attempt.identity, lease, checkRunId: 12345, conclusion: SUCCESS })).kind,
    ).toBe("unavailable");
    expect(fake.updates).toHaveLength(0);
  });

  test("an unpersisted intent cannot be sent (desired is frozen before the update)", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
      const db = seededDb();
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
});

describe("frozen terminal intent (spec §7.9)", () => {
  test("the update ships the PERSISTED text, not the caller's copies", async () => {
    const db = seededDb();
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
    expect(raw.title).toBe(CHECK_NAME);
    expect(raw.summary).toBe(SUCCESS.summary);
    expect(raw.summary).not.toContain("xxxx");
  });

  test("an oversized or multi-line intent is bounded at persistence", async () => {
    const db = seededDb();
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
    const db = seededDb();
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

describe("fetchCheckRun — the recovery lane's read", () => {
  test("returns the run only when its identity matches this attempt", async () => {
    const db = seededDb();
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
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ get: () => runPayload(attempt.identity, { id: 111 }) });
    expect((await adapterFor(db, fake.octokit).fetchCheckRun({ identity: attempt.identity, checkRunId: 4242 })).kind).toBe("unavailable");
  });
});

describe("decideConclusion — the §7.9 matrix from persisted proof", () => {
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

  const outcomes = [
    "pre-publication-failure",
    "degraded-not-posted",
    "publication-unknown",
    "expired",
    "local-error",
  ] as const;

  test("a confirmed NORMAL publication is success for every outcome (side effects never demote it)", () => {
    for (const outcome of outcomes) {
      const decided = decideConclusion({ proof: normal, outcome });
      expect(decided.desired).toBe("success");
      expect(decided.summary).toBe(`Review published for ${SHA.slice(0, 7)} (round ${normal.round}). Execution completion only; not code approval or a merge gate.`);
      expect(decided.title).toBe(CHECK_NAME);
    }
  });

  test("a confirmed DEGRADED publication is neutral", () => {
    for (const outcome of outcomes) {
      const decided = decideConclusion({ proof: degraded, outcome });
      expect(decided.desired).toBe("neutral");
      expect(decided.summary).toBe("Review output was invalid; a degraded summary comment was published.");
    }
  });

  test("no proof + pre-publication failure is failure with the reason in the summary", () => {
    const decided = decideConclusion({ proof: null, outcome: "pre-publication-failure", reason: "sandbox clone rejected" });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe(
      "Review execution failed before publication: sandbox clone rejected. No review was published.",
    );
  });

  test("no proof + degraded-not-posted is failure with the degraded-notice wording", () => {
    const decided = decideConclusion({ proof: null, outcome: "degraded-not-posted" });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe("Review output was invalid and the degraded notice was not published.");
  });

  test("no proof + publication-unknown / expired is the unconfirmed failure", () => {
    for (const outcome of ["publication-unknown", "expired"] as const) {
      const decided = decideConclusion({ proof: null, outcome });
      expect(decided.desired).toBe("failure");
      expect(decided.summary).toBe(
        "Review attempt could not be confirmed complete; publication status is unknown.",
      );
    }
  });

  test("no proof + local-error is the exhausted finalization wording", () => {
    const decided = decideConclusion({ proof: null, outcome: "local-error" });
    expect(decided.desired).toBe("failure");
    expect(decided.summary).toBe("Finalization could not be confirmed. Manual inspection may be required.");
  });

  test("every summary is bounded and free of verdict/approval language", () => {
    for (const decided of [
      decideConclusion({ proof: normal, outcome: "publication-unknown" }),
      decideConclusion({ proof: degraded, outcome: "publication-unknown" }),
      decideConclusion({ proof: null, outcome: "pre-publication-failure", reason: "x".repeat(9_000) }),
      decideConclusion({ proof: null, outcome: "publication-unknown" }),
      decideConclusion({ proof: null, outcome: "degraded-not-posted" }),
      decideConclusion({ proof: null, outcome: "expired" }),
      decideConclusion({ proof: null, outcome: "local-error" }),
    ]) {
      expect(decided.summary.length).toBeLessThanOrEqual(2_000);
      expect(decided.desired).not.toBe("in_progress");
      // D3/RL-10: never an approval, never a merge gate.
      expect(decided.summary).not.toMatch(/approve|approved|request changes|blocking|merge gate required/i);
      expect(decided.summary).not.toMatch(/APPROVE|REQUEST_CHANGES/);
    }
  });

  test("an untrusted reason cannot smuggle a token or newlines into a public summary", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "pre-publication-failure",
      reason: `ghp_SECRETVALUE123\nsecond line <script>`,
    });
    expect(decided.summary).not.toContain("ghp_SECRETVALUE123");
    expect(decided.summary).not.toContain("\n");
    expect(decided.summary).toContain("[REDACTED]");
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
    const db = seededDb();
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

  test("a typed pre-dispatch refusal reports zero requests, an unknown failure stays conservative", async () => {
    const db = seededDb();
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
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const partial = { rest: { checks: { create: undefined } } } as unknown as ChecksOctokit;
    expect((await adapterFor(db, partial).beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
    expect((await adapterFor(db, partial).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
    expect(
      (await adapterFor(db, partial).completeCheck({ identity: attempt.identity, lease, checkRunId: 1, conclusion: SUCCESS })).kind,
    ).toBe("unavailable");
  });

  test("an unowned attempt produces no request even when a client is present", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
// Zero-dispatch rollback (plan 68 integrated seam fix 2)
// ---------------------------------------------------------------------------

/**
 * The cross-task seam: `beginCheck` persists `create_state = 'sending'` before
 * it may dispatch, and its LAST fence before the callable is a fresh live-lease
 * re-proof. When that fence fails, no Checks request was invoked — the row must
 * not be left claiming that one might have been.
 */
describe("zero-dispatch create refusal rolls the sending mark back", () => {
  test("a lease that expires after the sending mark restores not-sent with no request", async () => {
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
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
    const db = seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);

    expect(await rollbackCheckCreateDispatch(db, attempt.identity.attemptId, lease, T0)).toBe(false);
    const row = await rowOf(db, attempt);
    expect(row.check_run_id).toBe(4242);
    expect(row.create_state).toBe("known");
  });

  test("the rollback moves only create_state: no attempt, backoff, error or identity change", async () => {
    const db = seededDb();
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
