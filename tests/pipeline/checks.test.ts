import { RECONCILE_DEFAULTS } from "../../src/contracts/reconcile-settings";
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
import { readCheckIdentity } from "../../src/store/review-checks";
import {
  CHECK_SUMMARIES,
  TERMINAL_FAILURE_TEXT,
  CheckRequestNotDispatched,
  attachCheckAtAcceptance,
  budgetExhaustedSummary,
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
import { syncSplitPair, createMigratedTestD1, mapAppToDefaultWorkspace, type TestD1, syncReviewBotColumn } from "../store/helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 1001;
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;

async function seededDb(): Promise<TestD1> {
  const db = createMigratedTestD1();
  db.raw.prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'checks-test', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
  // The split pair: the bot row and the default-workspace mapping the
  // same-id invariant of this release requires beside the App row.
  syncSplitPair(db);
  await mapAppToDefaultWorkspace(db, APP_ID);
  return db;
}

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
type UpdateCall = { params: ChecksRelabelParams; raw: Record<string, unknown> };

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
          creates.push({ params, raw: { ...params } as unknown as Record<string, unknown> });
          if (respond.create === undefined) throw Object.assign(new Error("nope"), { status: 500 });
          return { data: await respond.create(params) };
        },
        async update(params) {
          updates.push({ params, raw: { ...params } as unknown as Record<string, unknown> });
          if (respond.update === undefined) throw Object.assign(new Error("nope"), { status: 500 });
          const payload = await respond.update(params);
          return { data: "output" in payload ? payload : { ...payload, output: params.output } };
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

let CLOCK = T0;
function adapterFor(db: TestD1, octokit: ChecksOctokit | null) {
  return createChecksAdapter({ db, nowMs: () => CLOCK, getOctokit: async () => octokit });
}

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
    expect(raw.status).toBe("queued");
    expect("details_url" in raw).toBe(false);
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
    const result = await adapterFor(db, null).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(await runState(db, attempt)).toBe("not-sent");
  });

  test("a client whose create method is MISSING keeps the row unsent (no request, no sending mark)", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
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
        summary: null,
      },
    });
  });

  test("a missing Checks surface (no client) is unavailable, never a throw", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const result = await adapterFor(db, null).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.requests).toBe(0);
    expect(await runState(db, attempt)).toBe("not-sent");
  });

  test("a surface without the checks methods (an older/foreign client) is unavailable", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const bare = { rest: {} } as unknown as ChecksOctokit;
    const result = await adapterFor(db, bare).beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
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
        expect(result.requests).toBe(1);
      }
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
      expect(fake.creates).toHaveLength(1);
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
    if (result.kind === "unavailable") {
      expect(result.requests).toBe(0);
      expect(result.reason).toMatch(/already owns/i);
    }
    expect(fake.creates).toHaveLength(0);
  });

  test("an ownership-read failure is unavailable with zero requests", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
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
      expect(result.requests).toBe(0);
      expect(result.reason).toMatch(/ownership read failed/i);
    }
    expect(fake.creates).toHaveLength(0);
  });

  test("every unavailable lane result carries a numeric request count", async () => {
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

let attempt0!: { attempt: CheckAttempt; lease: Lease };
const scopeForAttempt0 = await seededDb();
attempt0 = await claimedAttempt(scopeForAttempt0);

describe("persisted scope identity (spec §7.6 / §7.9)", () => {
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

    CLOCK = lease.untilMs + 1;
    const result = await adapter.beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
    expect((await rowOf(db, attempt)).check_run_id).toBeNull();

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
      runPayload(identity, { id: 1, external_id: "mstar-check:v1:other:1" }),
      runPayload(identity, { id: 2, app: { id: 999 } }),
      runPayload(identity, { id: 3, head_sha: `dead${SHA.slice(4)}` }),
      runPayload(identity, { id: 4, name: "mstar-inspector review extra" }),
      runPayload(identity, { id: 5, external_id: null }),
      ours,
    ];
    const fake = fakeChecks({ pages: (_p, page) => (page === 1 ? { total_count: crowd.length, check_runs: crowd } : null) });
    const result = await adapterFor(db, fake.octokit).adoptCheckRun({ identity });
    expect(result).toEqual({ kind: "found", remote: toCheckRemote(ours)! });
    expect(fake.lists).toHaveLength(1);
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
          ? { total_count: 101, check_runs: [...filler, runPayload(identity, { id: 500 })] }
          : page === 2
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
    expect(fake.lists.map((p) => p.page)).toEqual([1, 2]);
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
    const failing = fakeChecks({});
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
    expect("title" in raw).toBe(false);
    expect("summary" in raw).toBe(false);
    expect("details_url" in raw).toBe(false);
    expect("external_id" in raw).toBe(false);
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
      runPayload(attempt.identity, { status: "in_progress", conclusion: null }),
      runPayload(attempt.identity, { status: "completed", conclusion: "failure" }),
      runPayload(attempt.identity, { status: "completed", conclusion: "success", app: { id: 777 } }),
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

  test("a reply without the frozen text is unconfirmed, never a delivery", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const first = await claimedAttempt(db);
    await attachedRun(db, first.attempt, first.lease, 4242);
    expect(await setCheckDesired(db, first.attempt.identity.attemptId, first.lease, SUCCESS, null, T0)).toBe(true);
    const textless = fakeChecks({
      update: () => runPayload(first.attempt.identity, { status: "completed", conclusion: "success", output: null }),
    });
    const unproven = await adapterFor(db, textless.octokit).completeCheck({
      identity: first.attempt.identity,
      lease: first.lease,
      checkRunId: 4242,
      conclusion: SUCCESS,
    });
    expect(unproven.kind).toBe("unavailable");
    if (unproven.kind === "unavailable") {
      expect(unproven.reason).toMatch(/frozen text/);
      expect(unproven.requests).toBe(1);
    }

    const otherSha = "89abcdef0123456789abcdef0123456789abcdef";
    const second = await claimedAttempt(db, { headSha: otherSha });
    await attachedRun(db, second.attempt, second.lease, 4343);
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () =>
        adapterFor(
          db,
          fakeChecks({
            update: () =>
              runPayload(second.attempt.identity, { status: "completed", conclusion: "failure", output: null }),
          }).octokit,
        ),
      getCheckGate: async () => GATE,
    });
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
    expect(released.observed).toBe("unknown");
    expect(released.terminal_ms).toBeNull();
    expect(released.desired).toBe("failure");
    expect(released.recovery_state).toBe("remote-unconfirmed");
    expect(released.holder).toBeNull();
    expect(released.attempts).toBe(1);
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

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fake.updates).toHaveLength(1);
    const row = await rowOf(db, attempt);
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.last_error).toContain("exceeded 100ms");
    expect(row.observed).toBe("unknown");
  });
});

describe("abandonment is not a conclusion (spec §7.10 / §7.9)", () => {
test("a begin budget that expires DURING the attach still releases the attempt", async () => {
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
    expect(row.check_run_id).toBe(4242);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
    expect(row.desired).toBe("in_progress");
    expect(row.terminal_ms).toBeNull();
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
    expect(fake.creates).toHaveLength(1);

    const row = (await db.prepare(`SELECT * FROM review_checks WHERE head_sha = ?`).bind(SHA).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.check_run_id).toBe(4242);
    expect(row.desired).toBe("in_progress");
    expect(row.desired_title).toBeNull();
    expect(row.desired_summary).toBeNull();
    expect(row.terminal_ms).toBeNull();
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

    const gone = fakeChecks({});
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

  test("a missing review row or a missing tally is an execution failure, never a pass", () => {
    for (const missing of [null, review("ship it", null)]) {
      const decided = decideConclusion({ proof: normal, outcome: "expired", gate, review: missing });
      expect(decided.desired).toBe("failure");
      expect(decided.failureStatus).toBe("unknown-failure");
      expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    }
  });

  test("an unreadable proof payload is the gate-unreadable failure, never an earlier passing row", async () => {
    const db = await seededDb();
    const unreadable = proof("review");
    db.raw
      .prepare(
        `INSERT INTO reviews (id, app_id, installation_id, owner, repo, pr_number, head_sha, verdict, envelope, reviewed_at)
         VALUES ('earlier-attempt', ?, ?, ?, ?, ?, ?, 'ship it', '{"tally":{"scorePct":96}}', datetime('now'))`,
      )
      .run(APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA);
  syncReviewBotColumn(db);
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
    expect(await readPublishedReview(db, { scope: SCOPE, headSha: SHA })).toBeNull();

    const decided = decideConclusion({ proof: unreadable, outcome: "expired", gate, review: read });
    expect(decided.desired).toBe("failure");
    expect(decided.failureStatus).toBe("unknown-failure");
    expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("an EMPTY allowed-verdict set misses every review — a saved [] gates every Check to failure", () => {
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
      expect(decided.failureStatus).toBe("unknown-failure");
      expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    }
  });

  test("no proof + pre-publication failure carries the approved wording, never the reason", () => {
    const decided = decideConclusion({
      proof: null,
      outcome: "pre-publication-failure",
      gate,
      review: null,
    });
    expect(decided.desired).toBe("failure");
    expect(decided.failureStatus).toBe("unknown-failure");
    expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("no proof + degraded-not-posted carries the approved wording", () => {
    const decided = decideConclusion({ proof: null, outcome: "degraded-not-posted", gate, review: null });
    expect(decided.desired).toBe("failure");
    expect(decided.failureStatus).toBe("unknown-failure");
    expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("no proof + skipped (nothing to review and nothing to inherit) is neutral, never a failure", () => {
    const decided = decideConclusion({ proof: null, outcome: "skipped", gate, review: null });
    expect(decided.desired).toBe("neutral");
    expect(decided.summary).toBe(CHECK_SUMMARIES.skipped);
  });

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
      expect(decided.failureStatus).toBe("unknown-failure");
      expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    }
  });

  test("an empty increment whose baseline result is unreadable fails closed with the approved wording", () => {
    const decided = decideConclusion({ proof: null, outcome: "skipped", gate, review: null, inherited });
    expect(decided.desired).toBe("failure");
    expect(decided.failureStatus).toBe("unknown-failure");
    expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("no proof + publication-unknown / expired is the unconfirmed execution failure", () => {
    for (const outcome of ["publication-unknown", "expired"] as const) {
      const decided = decideConclusion({ proof: null, outcome, gate, review: null });
      expect(decided.desired).toBe("failure");
      expect(decided.failureStatus).toBe("unknown-failure");
      expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    }
  });

  test("the deadline concludes the same approved wording whatever evidence it could not read", () => {
    const decided = decideConclusion({ proof: null, outcome: "expired", gate, review: null });
    expect(decided.desired).toBe("failure");
    expect(decided.title).toBe(CHECK_NAME);
    expect(decided.failureStatus).toBe("unknown-failure");
    expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("no proof + local-error carries the approved wording", () => {
    const decided = decideConclusion({ proof: null, outcome: "local-error", gate, review: null });
    expect(decided.desired).toBe("failure");
    expect(decided.failureStatus).toBe("unknown-failure");
    expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("an unreadable App gate is failure — no floor, no allowed list, never a default", () => {
    for (const applied of [null, review("ship it", 100)]) {
      const decided = decideConclusion({ proof: normal, outcome: "expired", gate: null, review: applied });
      expect(decided.desired).toBe("failure");
      expect(decided.failureStatus).toBe("unknown-failure");
      expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
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
      decideConclusion({ proof: null, outcome: "pre-publication-failure", gate, review: null }),
      decideConclusion({ proof: null, outcome: "publication-unknown", gate, review: null }),
      decideConclusion({ proof: null, outcome: "degraded-not-posted", gate, review: null }),
      decideConclusion({ proof: null, outcome: "expired", gate, review: null }),
      decideConclusion({ proof: null, outcome: "local-error", gate, review: null }),
    ]) {
      expect(decided.summary.length).toBeLessThanOrEqual(2_000);
      expect(decided.desired).not.toBe("in_progress");
      expect(decided.desired).not.toBe("neutral");
      expect(decided.summary).not.toMatch(/approve|approved|request changes|merge gate required|blocking/i);
      expect(decided.summary).not.toMatch(/APPROVE|REQUEST_CHANGES/);
    }
  });
});

describe("empty increment inheritance (spec §7.9)", () => {
  const BASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
  const BASE7 = BASE_SHA.slice(0, 7);

  function seedBaselineReview(
    db: TestD1,
    verdict: string,
    scorePct: number | null,
    envelope = JSON.stringify(scorePct === null ? { verdict } : { verdict, tally: { scorePct } }),
    corruptEnvelope = false,
  ): void {
    if (corruptEnvelope) db.raw.run("PRAGMA ignore_check_constraints = ON");
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id, envelope)
         VALUES (?, ?, ?, ?, ?, ?, ?,?, ?)`,
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
  syncReviewBotColumn(db);
  }

  test("the terminal Check carries the inherited baseline result, never an unconditional neutral", async () => {
    const cases: Array<{
      name: string;
      baseline: { verdict: string; scorePct: number | null } | null;
      envelope?: string;
      corruptEnvelope?: boolean;
      gate: ReviewGate | null;
      desired: CheckConclusion["desired"];
    }> = [
      { name: "baseline below the gate", baseline: { verdict: "needs fixes", scorePct: 40 }, gate: GATE, desired: "failure" },
      { name: "baseline meets the gate", baseline: { verdict: "ship it", scorePct: 92 }, gate: GATE, desired: "success" },
      { name: "readable baseline, unreadable gate", baseline: { verdict: "ship it", scorePct: 92 }, gate: null, desired: "failure" },
      { name: "unreadable baseline", baseline: null, gate: GATE, desired: "failure" },
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
      const sentSummary = (fake.updates[0]!.params as ChecksUpdateParams).output.summary;
      if (testCase.baseline !== null && testCase.gate !== null) {
        expect(sentSummary).toContain(`No new changes at ${SHA.slice(0, 7)}`);
        expect(sentSummary).toContain(BASE7);
        expect(sentSummary).toContain(`verdict "${testCase.baseline.verdict}"`);
      } else {
        expect(sentSummary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
      }
    }
  });
});

describe("terminalize reads only this attempt's own publication (spec §7.9)", () => {
  test("a prior generation's applied proof does not decide this attempt's Check", async () => {
    const db = await seededDb();
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
      TERMINAL_FAILURE_TEXT["unknown-failure"],
    );
    const row = await rowOf(db, attempt);
    expect(row.desired).toBe("failure");
    expect(row.publication_id).toBeNull();
  });

  test("a linked publication with no readable proof is UNPROVEN, never a prior generation's verdict", async () => {
    const db = await seededDb();
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
    expect((fake.updates[0]!.params as ChecksUpdateParams).output.summary).toBe(
      TERMINAL_FAILURE_TEXT["unknown-failure"],
    );
    const row = await rowOf(db, attempt);
    expect(row.desired).toBe("failure");
    expect(row.publication_id).toBe(ownId);
  });
  test("a budget-exhausted rerun never adopts a prior same-head publication's verdict", async () => {
    const db = await seededDb();
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

    const outcome = {
      kind: "budget-exhausted" as const,
      cause: "runner-deadline" as const,
      budgetWindow: "runner" as const,
      tier: "default" as const,
      budgetMs: 600_000,
      seatsDispatched: 5,
      seatsStopped: 3,
      changedLines: 402,
    };
    await lifecycle.terminalize({
      handle: {
        attemptId: attempt.identity.attemptId,
        scope: SCOPE,
        githubAppId: GITHUB_APP_ID,
        headSha: SHA,
        lease,
      },
      publicationId: null,
      outcome: "budget-exhausted",
      inheritedHeadSha: "f".repeat(40),
      budgetExhaustion: outcome,
    });

    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.raw.conclusion).toBe("failure");
    expect((fake.updates[0]!.raw.output as { summary: string }).summary).toBe(
      budgetExhaustedSummary(outcome),
    );
    const row = await rowOf(db, attempt);
    expect(row.desired).toBe("failure");
    expect(row.publication_id).toBeNull();
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
      summary: null,
    });
    expect(toCheckRemote({ ...runPayload(identity), output: { title: "t", summary: "approved text" } })?.summary).toBe(
      "approved text",
    );
    expect(toCheckRemote({ ...runPayload(identity), output: null })?.summary).toBeNull();
    expect(toCheckRemote(null)).toBeNull();
    expect(toCheckRemote(undefined)).toBeNull();
    expect(toCheckRemote({ ...runPayload(identity), id: "not-a-number" as unknown as number })).toBeNull();
    expect(toCheckRemote({ ...runPayload(identity), external_id: 42 as unknown as string })).toBeNull();
    expect(toCheckRemote({ ...runPayload(identity), app: { id: "abc" } as unknown as { id: number } })).toBeNull();
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

    const checksCall = requests.find((r) => r.url.includes("/check-runs"));
    expect(checksCall?.method).toBe("POST");
    expect(checksCall?.url).toBe("https://api.github.com/repos/acme/widgets/check-runs");
    expect(checksCall?.body).toContain(expected);

    expect(seam.constructed).toHaveLength(1);
    const write = seam.minted.find((m) => m.purpose === "review-write");
    expect(write).toBeDefined();
    expect(write?.repo).toBe("widgets");
    expect(write?.installationId).toBe(SCOPE.installationId);
    expect(write?.permissions.checks).toBe("write");
    expect(write?.permissions.contents).toBe("write");
    expect(requests.findIndex((r) => r.url.includes("/access_tokens"))).toBeLessThan(
      requests.findIndex((r) => r.url.includes("/check-runs")),
    );

    await commenter
      .getInstallationToken({ scope: SCOPE, purpose: "sandbox-read" })
      .catch(() => undefined);
    const sandbox = seam.minted.find((m) => m.purpose === "sandbox-read");
    expect(sandbox?.permissions.contents).toBe("read");
    expect(sandbox?.permissions).not.toHaveProperty("checks");
    expect(seam.constructed).toHaveLength(1);
  });

  test("a renamed repository mints installation-wide instead of failing the Checks lane", async () => {
    const db = await seededDb();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const seam: AuthSeam = { constructed: [], minted: [] };
    const mintBodies: string[] = [];
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
    expect(mintBodies[0]).toContain('"repositories"');
    expect(mintBodies[1]).not.toContain('"repositories"');
    const writeMints = seam.minted.filter((m) => m.purpose === "review-write");
    expect(writeMints).toHaveLength(2);
    expect(writeMints[0]?.installationWide).toBeUndefined();
    expect(writeMints[1]?.installationWide).toBe(true);
    expect(writeMints[1]?.permissions.checks).toBe("write");
  });

  test("the rename refusal is recognised on the error, its response, or only its message", () => {
    expect(isNameRefusal(Object.assign(new Error("boom"), { status: 404 }))).toBe(true);
    expect(isNameRefusal(Object.assign(new Error("boom"), { status: 422 }))).toBe(true);
    expect(isNameRefusal({ message: "x", response: { status: 404 } })).toBe(true);
    expect(isNameRefusal({ message: "Repository not found" })).toBe(true);
    expect(isNameRefusal(new Error("Not Found"))).toBe(true);
    expect(isNameRefusal(Object.assign(new Error("nope"), { cause: { status: 422 } }))).toBe(true);
    expect(isNameRefusal(Object.assign(new Error("boom"), { status: 500 }))).toBe(false);
    expect(isNameRefusal(new Error("rate limited"))).toBe(false);
    expect(isNameRefusal(null)).toBe(false);
    expect(isNameRefusal("plain string")).toBe(false);
  });

  test("a typed pre-dispatch refusal reports zero requests, an unknown failure stays conservative", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const notDispatched = fakeChecks({
      create: () => {
        throw new CheckRequestNotDispatched("budget exhausted — request not dispatched");
      },
    });
    const zero = await adapterFor(db, notDispatched.octokit).beginCheck({ identity: attempt.identity, lease });
    expect(zero.kind).toBe("unavailable");
    if (zero.kind === "unavailable") expect(zero.requests).toBe(0);
    expect(await runState(db, attempt)).toBe("not-sent");

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
    const takeover: Lease = { holder: "reconciler", epoch: lease.epoch + 1, untilMs: lease.untilMs };
    expect((await adapterFor(db, fake.octokit).beginCheck({ identity: attempt.identity, lease: takeover })).kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });
});

describe("the review-write permission set (spec §7.12)", () => {
  test("checks:write rides the one existing review-write set — no second credential", () => {
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
    expect(await setCheckCreateState(db, id, lease, "sending", undefined, T0)).toBe(true);
    const fake = fakeChecks({ create: () => runPayload(attempt.identity) });
    const adapter = adapterFor(db, fake.octokit);

    const result = await adapter.beginCheck({ identity: attempt.identity, lease });
    expect(result.kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);

    expect(await setCheckCreateState(db, id, lease, "not-sent", undefined, T0)).toBe(false);
    expect((await adapter.beginCheck({ identity: attempt.identity, lease })).kind).toBe("unavailable");
    expect(fake.creates).toHaveLength(0);

    const row = await rowOf(db, attempt);
    expect(row.check_run_id).toBeNull();
    expect(row.create_state).toBe("sending");
    expect(row.observed).toBe("unknown");

    const adopt = fakeChecks({});
    expect((await adapterFor(db, adopt.octokit).adoptCheckRun({ identity: attempt.identity })).kind).toBe("incomplete");
    expect(adopt.creates).toHaveLength(0);
  });
});


const ATTACH_INPUT = {
  scope: SCOPE,
  githubAppId: GITHUB_APP_ID,
  headSha: SHA,
  triggeredBy: "octocat",
  action: "review",
  deliveryId: "fixture-delivery",
} as const;

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
    expect(row.create_state).toBe("known");
    expect(row.check_run_id).toBe(4242);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");
    expect(row.desired).toBe("in_progress");
    expect(row.attempts).toBe(0);
    expect(row.execution_deadline_ms).toBe(T0 + CHECK_ATTACH_WINDOW_MS);
    expect(row.next_attempt_ms).toBe(T0 + CHECK_ATTACH_GRACE_MS);
  });

  test("a duplicate delivery for the same head mints no second run", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({ create: echoCreate });
    const deps = { db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK };

    expect((await attachCheckAtAcceptance(deps, ATTACH_INPUT)).kind).toBe("attached");
    const duplicate = await attachCheckAtAcceptance(deps, ATTACH_INPUT);
    expect(duplicate).toEqual({ kind: "skipped", reason: "busy" });
    expect(fake.creates).toHaveLength(1);
    const rows = (await db.prepare("SELECT COUNT(*) AS n FROM review_checks").first()) as { n: number };
    expect(rows.n).toBe(1);
  });

  test("a failing create never throws: the row goes to the recovery lane as possibly-sent", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({});

    const attached = await attachCheckAtAcceptance(
      { db, adapter: adapterFor(db, fake.octokit), nowMs: () => CLOCK },
      ATTACH_INPUT,
    );

    expect(attached.kind).toBe("failed");
    expect(fake.creates).toHaveLength(1);
    const row = await attachRow(db);
    expect(row.holder).toBeNull();
    expect(row.recovery_state).toBe("remote-unconfirmed");
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_ms).toBe(T0 + 60_000);
    expect(row.check_run_id).toBeNull();
  });

  test("an unavailable Checks surface is a FAILURE, not a skip: the caller owes one warn", async () => {
    const db = await seededDb();
    CLOCK = T0;
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

    expect(handle).not.toBeNull();
    expect(handle!.attemptId).toBe(attemptId);
    expect(fake.creates).toHaveLength(1);
    const adopted = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(adopted.holder).toBe(handle!.lease.holder);
    expect(adopted.lease_epoch).toBe(handle!.lease.epoch);
    expect(adopted.execution_deadline_ms).toBe(CLOCK + CHECK_LEASE_MS);

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

  test("a rerun adopts the Check its own delivery attached — the rerun key never mints a second run", async () => {
    const db = await seededDb();
    CLOCK = T0;
    const fake = fakeChecks({ create: echoCreate });
    const adapter = adapterFor(db, fake.octokit);
    const rerun = { triggeredBy: "check_run", action: "rerequested", rerunCheckRunId: 4242 } as const;
    expect(
      (
        await attachCheckAtAcceptance(
          { db, adapter, nowMs: () => CLOCK },
          { ...ATTACH_INPUT, ...rerun, deliveryId: "rerun-delivery" },
        )
      ).kind,
    ).toBe("attached");
    const attemptId = (await attachRow(db)).id as string;

    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapter,
      getCheckGate: async () => GATE,
    });
    const handle = await lifecycle.begin({
      ...ATTACH_INPUT,
      ...rerun,
      executionDeadlineMs: CLOCK + CHECK_LEASE_MS,
    });

    // The consumer's own claim must land on the attach's key: a plain-key
    // claim would create a second Check nobody asked for and orphan the first.
    expect(handle).not.toBeNull();
    expect(handle!.attemptId).toBe(attemptId);
    expect(fake.creates).toHaveLength(1);
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
    expect(row.holder).toBe("run-a");
    expect(row.lease_epoch).toBe(1);
  });

  test("a live, fresh delivery holder is not taken over: the consumer proceeds without a handle", async () => {
    const db = await seededDb();
    CLOCK = T0;
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
    const adopted = await rowOf(db, attempt);
    expect(adopted.holder).toBe(handle!.lease.holder);
    expect(adopted.lease_epoch).toBe(2);
    expect(adopted.execution_deadline_ms).toBe(CLOCK + CHECK_LEASE_MS);
    expect(await releaseCheckClaim(db, attempt.identity.attemptId, deliveryLease, CLOCK)).toBe(false);
    expect((await rowOf(db, attempt)).holder).toBe(handle!.lease.holder);
  });

  test("an attach that releases between the two adoption attempts is adopted by the retry", async () => {
    const db = await seededDb();
    CLOCK = T0;
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

  function seedHeadReview(db: TestD1, verdict: string, scorePct: number | null): void {
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, app_id, envelope)
         VALUES (?, ?, ?, ?, ?, ?, ?,?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        SCOPE.installationId,
        SCOPE.owner,
        SCOPE.repo,
        SCOPE.prNumber,
        SHA,
        verdict,
        SCOPE.appId,
        JSON.stringify(scorePct === null ? { verdict } : { verdict, tally: { scorePct } }),
      );
  syncReviewBotColumn(db);
  }

  async function skipHead(
    db: TestD1,
    fake: ReturnType<typeof fakeChecks>,
    gate: ReviewGate | null = GATE,
  ): Promise<{ attemptId: string; row: Record<string, string | number | null> }> {
    const { attemptId, deliveryId } = await attachedAttempt(db, fake);
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => gate,
    });
    expect(
      await lifecycle.settleSkipped({
        scope: SCOPE,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
        attachDeliveryId: deliveryId,
        reason: "already reviewed for this head",
      }),
    ).toBe(true);
    const row = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    return { attemptId, row };
  }

  test("a skip inherits a passing head review — success, never a neutral that masks it", async () => {
    const db = await seededDb();
    CLOCK = T0;
    seedHeadReview(db, "ship it", 92);
    const fake = settlingFake();
    const { row } = await skipHead(db, fake);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("success");
    expect(fake.updates[0]!.params.output.summary).toBe(
      CHECK_SUMMARIES.sameHeadInheritedGateMet(SHA.slice(0, 7), "ship it", 92, GATE),
    );
    expect(row.desired).toBe("success");
    expect(row.observed).toBe("success");
  });

  test("a skip inherits a head review below the floor — failure, never neutral", async () => {
    const db = await seededDb();
    CLOCK = T0;
    seedHeadReview(db, "ship it", 70);
    const fake = settlingFake();
    const { row } = await skipHead(db, fake);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("failure");
    expect(fake.updates[0]!.params.output.summary).toBe(
      CHECK_SUMMARIES.sameHeadInheritedGateMissed(SHA.slice(0, 7), "ship it", 70, GATE),
    );
    expect(row.desired).toBe("failure");
    expect(row.observed).toBe("failure");
  });

  test("a skip inherits a disallowed verdict above the floor — failure, never neutral", async () => {
    const db = await seededDb();
    CLOCK = T0;
    seedHeadReview(db, "needs fixes", 95);
    const fake = settlingFake();
    const { row } = await skipHead(db, fake);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("failure");
    expect(fake.updates[0]!.params.output.summary).toBe(
      CHECK_SUMMARIES.sameHeadInheritedGateMissed(SHA.slice(0, 7), "needs fixes", 95, GATE),
    );
    expect(row.desired).toBe("failure");
  });

  test("a malformed proof falls back to the reviews projection — one warning, never a throw", async () => {
    const db = await seededDb();
    CLOCK = T0;
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
         VALUES ('broken-proof', ?, ?, ?, ?, ?, ?, 'review', 'confirmed', '{"version":1,"artifact":null}', '{not json', 1, 'done', ?, ?)`,
      )
      .run(APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, T0, T0);
    seedHeadReview(db, "needs fixes", 40);
    const fake = settlingFake();
    const { attemptId, deliveryId } = await attachedAttempt(db, fake);
    const warnings: string[] = [];
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    expect(
      await lifecycle.settleSkipped({
        scope: SCOPE,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
        attachDeliveryId: deliveryId,
        reason: "already reviewed for this head",
        warn: (detail) => warnings.push(detail),
      }),
    ).toBe(true);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("failure");
    expect(fake.updates[0]!.params.output.summary).toBe(
      CHECK_SUMMARIES.sameHeadInheritedGateMissed(SHA.slice(0, 7), "needs fixes", 40, GATE),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("publication proof unreadable");
    const row = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.desired).toBe("failure");
  });

  test("a proof read fault settles nothing — no intent frozen, one warning", async () => {
    const db = await seededDb();
    CLOCK = T0;
    seedHeadReview(db, "needs fixes", 40);
    const fake = settlingFake();
    const { attemptId, deliveryId } = await attachedAttempt(db, fake);
    const failingDb = {
      prepare: (sql: string) => {
        if (sql.includes("review_publications")) throw new Error("D1 unavailable");
        return db.prepare(sql);
      },
      batch: (statements: Parameters<TestD1["batch"]>[0]) => db.batch(statements),
    };
    const warnings: string[] = [];
    const lifecycle = createCheckLifecycle({
      db: failingDb as never,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });

    expect(
      await lifecycle.settleSkipped({
        scope: SCOPE,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
        attachDeliveryId: deliveryId,
        reason: "already reviewed for this head",
        warn: (detail) => warnings.push(detail),
      }),
    ).toBe(false);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("publication proof read failed");
    expect(fake.updates).toHaveLength(0);
    const row = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.desired).toBe("in_progress");
    expect(row.desired_summary).toBeNull();
    expect(row.desired_title).toBeNull();
    expect(row.terminal_ms).toBeNull();
    expect(row.holder).not.toBeNull();
  });

  test("a confirmed publication without a reviews row still settles the gate result", async () => {
    const db = await seededDb();
    CLOCK = T0;
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms,
            confirmed_ms, applied_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'review', 'confirmed', ?, ?, 1, 'done', ?, ?, ?, NULL)`,
      )
      .run(
        "confirmed-proof",
        APP_ID,
        SCOPE.installationId,
        SCOPE.owner,
        SCOPE.repo,
        SCOPE.prNumber,
        SHA,
        JSON.stringify({ version: 1, artifact: { payload: { verdict: "needs fixes", tally: { scorePct: 40 } } } }),
        JSON.stringify({
          publicationId: "confirmed-proof",
          scope: SCOPE,
          headSha: SHA,
          kind: "review",
          round: 1,
          commentId: 7,
          bodySha256: "b".repeat(64),
          confirmedMs: T0,
        }),
        T0,
        T0,
        T0,
      );
    const fake = settlingFake();
    const { row } = await skipHead(db, fake);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("failure");
    expect(fake.updates[0]!.params.output.summary).toBe(
      CHECK_SUMMARIES.sameHeadInheritedGateMissed(SHA.slice(0, 7), "needs fixes", 40, GATE),
    );
    expect(row.desired).toBe("failure");
    expect(row.observed).toBe("failure");
  });

  test("a confirmed publication with no readable payload fails closed, never neutral", async () => {
    const db = await seededDb();
    CLOCK = T0;
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms, confirmed_ms)
         VALUES ('no-payload', ?, ?, ?, ?, ?, ?, 'review', 'confirmed', '{"version":1,"artifact":null}', ?, 1, 'done', ?, ?, ?)`,
      )
      .run(
        APP_ID,
        SCOPE.installationId,
        SCOPE.owner,
        SCOPE.repo,
        SCOPE.prNumber,
        SHA,
        JSON.stringify({
          publicationId: "no-payload",
          scope: SCOPE,
          headSha: SHA,
          kind: "review",
          round: 1,
          commentId: 7,
          bodySha256: "b".repeat(64),
          confirmedMs: T0,
        }),
        T0,
        T0,
        T0,
      );
    const fake = settlingFake();
    const { row } = await skipHead(db, fake);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("failure");
    expect(fake.updates[0]!.params.output.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    expect(row.desired).toBe("failure");
    expect(row.observed).toBe("failure");
  });

  test("an absent gate defers the settlement — nothing frozen, one warning", async () => {
    const db = await seededDb();
    CLOCK = T0;
    seedHeadReview(db, "needs fixes", 40);
    const fake = settlingFake();
    const { attemptId, deliveryId } = await attachedAttempt(db, fake);
    const warnings: string[] = [];
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => null,
    });

    expect(
      await lifecycle.settleSkipped({
        scope: SCOPE,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
        attachDeliveryId: deliveryId,
        reason: "already reviewed for this head",
        warn: (detail) => warnings.push(detail),
      }),
    ).toBe(false);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("gate is unreadable from this lane");
    expect(fake.updates).toHaveLength(0);
    const row = (await db.prepare("SELECT * FROM review_checks WHERE id = ?").bind(attemptId).first()) as Record<
      string,
      string | number | null
    >;
    expect(row.desired).toBe("in_progress");
    expect(row.desired_summary).toBeNull();
    expect(row.terminal_ms).toBeNull();
  });

  test("a head review without a readable score fails closed, never neutral", async () => {
    const db = await seededDb();
    CLOCK = T0;
    seedHeadReview(db, "ship it", null);
    const fake = settlingFake();
    const { row } = await skipHead(db, fake);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("failure");
    expect(fake.updates[0]!.params.output.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    expect(row.desired).toBe("failure");
  });

  test("a degraded publication settles failure from its own summary, not the projection", async () => {
    const db = await seededDb();
    CLOCK = T0;
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, app_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, proof_json, attempts, recovery_state, created_ms, updated_ms)
         VALUES ('degraded-proof', ?, ?, ?, ?, ?, ?, 'degraded', 'confirmed', '{"version":1,"artifact":null}', ?, 1, 'done', ?, ?)`,
      )
      .run(
        APP_ID,
        SCOPE.installationId,
        SCOPE.owner,
        SCOPE.repo,
        SCOPE.prNumber,
        SHA,
        JSON.stringify({
          publicationId: "degraded-proof",
          scope: SCOPE,
          headSha: SHA,
          kind: "degraded",
          round: 1,
          commentId: 7,
          bodySha256: "b".repeat(64),
          confirmedMs: T0,
        }),
        T0,
        T0,
      );
    seedHeadReview(db, "ship it", 92);
    const fake = settlingFake();
    const { row } = await skipHead(db, fake);

    expect((fake.updates[0]!.params as ChecksUpdateParams).conclusion).toBe("failure");
    expect(fake.updates[0]!.params.output.summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
    expect(row.desired).toBe("failure");
  });

  test("a skip with no published review settles the attached run neutral with the reason", async () => {
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
    expect((await listCheckReconcileBatch(db, T0, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((candidate) => candidate.identity.attemptId)).toEqual([attemptId]);
  });
  test("a retry after a neutral settlement claims a new generation and its own run", async () => {
    const db = await seededDb();
    CLOCK = T0;
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

    expect(result).toEqual({ kind: "skipped", reason: "adopted" });
  });
});


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


describe("zero-dispatch create refusal rolls the sending mark back", () => {
  test("a lease that expires after the sending mark restores not-sent with no request", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const identity = attempt.identity;
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
    if (result.kind !== "unavailable") throw new Error("unreachable");
    expect(result.requests).toBe(0);
    expect(fake.creates).toHaveLength(0);

    const row = await rowOf(db, attempt);
    expect(row.create_state).toBe("not-sent");
    expect(row.check_run_id).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_ms).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.external_id).toBe(identity.externalId);
    expect(row.generation).toBe(identity.generation);
    expect(row.terminal_ms).toBeNull();
    expect(row.holder).toBe(lease.holder);
    expect(row.lease_epoch).toBe(lease.epoch);
  });

  test("a pre-existing error survives the mark and the rollback untouched", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const identity = attempt.identity;
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
    expect(row.last_error).toBe(PRIOR);
  });

  test("a stale epoch defeats the rollback: a newer holder's state is untouched", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await db
      .prepare(`UPDATE review_checks SET holder = 'other-run', lease_epoch = ?, lease_until_ms = ? WHERE id = ?`)
      .bind(lease.epoch + 1, T0 + CHECK_RECOVERY_LEASE_MS, attempt.identity.attemptId)
      .run();

    expect(
      await rollbackCheckCreateDispatch(db, attempt.identity.attemptId, lease, T0),
    ).toBe(false);
    const row = await rowOf(db, attempt);
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
      "holder", "lease_epoch", "lease_until_ms", "bot_id", "owner", "repo", "head_sha",
    ]) {
      expect([key, after[key]]).toEqual([key, before[key]]);
    }
  });
});

describe("markQueuedBehindInflight — the held-check relabel is bounded", () => {
  const RELABEL_KEY = { headSha: SHA, triggeredBy: "octocat", action: "review", attachDeliveryId: "delivery-relabel" };

  async function relabelableRow(db: TestD1): Promise<void> {
    const result = await claimAttempt(db, {
      scope: SCOPE,
      githubAppId: GITHUB_APP_ID,
      headSha: SHA,
      triggeredBy: RELABEL_KEY.triggeredBy,
      action: RELABEL_KEY.action,
      attachDeliveryId: RELABEL_KEY.attachDeliveryId,
      holder: `delivery:${RELABEL_KEY.attachDeliveryId}`,
      nowMs: T0,
      executionDeadlineMs: T0 + CHECK_ATTACH_WINDOW_MS,
    });
    if (result.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${result.kind}`);
    await attachedRun(db, result.attempt, result.lease, 4242);
    expect(await releaseCheckClaim(db, result.attempt.identity.attemptId, result.lease, T0)).toBe(true);
  }

  const relabel = (adapter: ReturnType<typeof adapterFor>, warns: string[], updateBudgetMs = 1_000) =>
    adapter.markQueuedBehindInflight!({
      scope: SCOPE,
      ...RELABEL_KEY,
      checkRunId: 4242,
      summary: "Queued behind the review in flight for this pull request.",
      updateBudgetMs,
      warn: (detail) => warns.push(detail),
    });

  test("a rejected send is ONE warn and false — it never reaches the caller as a throw", async () => {
    const db = await seededDb();
    await relabelableRow(db);
    const fake = fakeChecks({
      update: () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    });
    const warns: string[] = [];

    expect(await relabel(adapterFor(db, fake.octokit), warns)).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("held check relabel failed: boom");
    expect(fake.updates).toHaveLength(1);
  });

  test("a send that never answers returns false inside the budget, so the retry is never held", async () => {
    const db = await seededDb();
    await relabelableRow(db);
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

describe("markInProgress — the queued → in_progress promotion (spec §7.9)", () => {
  const promote = (
    adapter: ReturnType<typeof adapterFor>,
    identity: CheckIdentity,
    lease: Lease,
    warns: string[] = [],
    updateBudgetMs = 1_000,
  ) =>
    adapter.markInProgress!({
      identity,
      lease,
      summary: "Review started for 0123456 — this run reports the review of this commit.",
      updateBudgetMs,
      warn: (detail) => warns.push(detail),
    });

  test("sends in_progress on the PERSISTED run id, carrying only the one summary", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity) });
    const warns: string[] = [];

    expect(await promote(adapterFor(db, fake.octokit), attempt.identity, lease, warns)).toEqual({
      kind: "settled",
      promoted: true,
    });

    expect(warns).toHaveLength(0);
    expect(fake.updates).toHaveLength(1);
    const raw = fake.updates[0]!.raw;
    expect(raw.status).toBe("in_progress");
    expect(raw.check_run_id).toBe(4242);
    expect(raw.output).toEqual({
      title: CHECK_NAME,
      summary: "Review started for 0123456 — this run reports the review of this commit.",
    });
    expect("conclusion" in raw).toBe(false);
  });

  test("an attempt with no attached run is refused without a send", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity) });
    const warns: string[] = [];

    expect(await promote(adapterFor(db, fake.octokit), attempt.identity, lease, warns)).toEqual({
      kind: "settled",
      promoted: false,
    });

    expect(fake.updates).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  test("a lease that is no longer live refuses the send", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity) });
    CLOCK = lease.untilMs + 1;

    expect(await promote(adapterFor(db, fake.octokit), attempt.identity, lease)).toEqual({
      kind: "settled",
      promoted: false,
    });
    expect(fake.updates).toHaveLength(0);
  });

  test("a rejected send is ONE warn and false — it never reaches the caller as a throw", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({
      update: () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      },
    });
    const warns: string[] = [];

    expect(await promote(adapterFor(db, fake.octokit), attempt.identity, lease, warns)).toEqual({
      kind: "settled",
      promoted: false,
    });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("check in-progress failed: boom");
    expect(fake.updates).toHaveLength(1);
  });

  test("a send that never answers ends at its per-call budget", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    const fake = fakeChecks({ update: () => new Promise<CheckRunPayload>(() => {}) });
    const warns: string[] = [];
    const started = Date.now();

    expect(await promote(adapterFor(db, fake.octokit), attempt.identity, lease, warns, 25)).toEqual({
      kind: "abandoned",
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("exceeded 25ms");
  });

  test("the lifecycle refuses a TERMINAL attempt before it consults the adapter", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    db.raw
      .prepare("UPDATE review_checks SET terminal_ms = ? WHERE id = ?")
      .run(T0, attempt.identity.attemptId);
    let adapterCalls = 0;
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () =>
        ({
          beginCheck: async () => ({ kind: "unavailable" as const, requests: 0, reason: "unused" }),
          adoptCheckRun: async () => ({ kind: "absent" as const }),
          completeCheck: async () => ({ kind: "unavailable" as const, requests: 0, reason: "unused" }),
          fetchCheckRun: async () => ({ kind: "absent" as const }),
          markInProgress: async () => {
            adapterCalls += 1;
            return { kind: "settled" as const, promoted: true };
          },
        }),
      getCheckGate: async () => GATE,
    });

    const answer = await lifecycle.markInProgress({
      handle: { attemptId: attempt.identity.attemptId, scope: SCOPE, githubAppId: GITHUB_APP_ID, headSha: SHA, lease },
      summary: "Review started for 0123456 — this run reports the review of this commit.",
      updateBudgetMs: 1_000,
      warn: () => {},
    });

    expect(answer).toEqual({ kind: "settled", promoted: false });
    expect(adapterCalls).toBe(0);
    expect((await rowOf(db, attempt)).observed).toBe("unknown");
  });

  test("the adapter refuses an attempt whose terminal intent is already frozen", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    await attachedRun(db, attempt, lease, 4242);
    expect(await setCheckDesired(db, attempt.identity.attemptId, lease, SUCCESS, null, T0)).toBe(true);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity) });
    const warns: string[] = [];

    const answer = await promote(adapterFor(db, fake.octokit), attempt.identity, lease, warns);

    expect(answer).toEqual({ kind: "settled", promoted: false });
    expect(fake.updates).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  test("the lifecycle promotes the handle's owned run, and a handle with no run promotes nothing", async () => {
    const db = await seededDb();
    const { attempt, lease } = await claimedAttempt(db);
    const fake = fakeChecks({ update: () => runPayload(attempt.identity) });
    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () => adapterFor(db, fake.octokit),
      getCheckGate: async () => GATE,
    });
    const handle = {
      attemptId: attempt.identity.attemptId,
      scope: SCOPE,
      githubAppId: GITHUB_APP_ID,
      headSha: SHA,
      lease,
    };
    const warns: string[] = [];
    const summary = "Review started for 0123456 — this run reports the review of this commit.";

    expect(await lifecycle.markInProgress({ handle, summary, updateBudgetMs: 1_000, warn: (d) => warns.push(d) })).toEqual({
      kind: "settled",
      promoted: false,
    });
    expect(fake.updates).toHaveLength(0);

    await attachedRun(db, attempt, lease, 4242);
    expect(await lifecycle.markInProgress({ handle, summary, updateBudgetMs: 1_000, warn: (d) => warns.push(d) })).toEqual({
      kind: "settled",
      promoted: true,
    });
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.params.output).toEqual({ title: CHECK_NAME, summary });
    expect(warns).toHaveLength(0);
  });
});

describe("budget-exhausted Check vocabulary", () => {
  const TAIL =
    " — a time-budget failure, not a verdict on the PR; shrink the diff or use a tier whose ceiling covers it.";

  test("full form states tier, seconds, both seat counts and the changed lines", () => {
    const summary = budgetExhaustedSummary({
      kind: "budget-exhausted",
      cause: "runner-deadline",
      budgetWindow: "runner",
      tier: "default",
      budgetMs: 600_000,
      seatsDispatched: 5,
      seatsStopped: 3,
      changedLines: 402,
    });
    expect(summary).toBe(
      `Review budget exhausted: default review stopped at 600s with 3/5 seats stopped before finishing (402 changed lines)${TAIL}`,
    );
  });

  test("short form appends only the observed counters, in order", () => {
    const summary = budgetExhaustedSummary({
      kind: "budget-exhausted",
      cause: "consumer-deadline",
      budgetWindow: "preparation",
      tier: "quick",
      budgetMs: 12_500,
      seatsDispatched: 0,
      seatsStopped: 0,
      changedLines: null,
    });
    expect(summary).toBe(
      `Review budget exhausted: quick review reached its 12.5s preparation budget (consumer deadline reached); 0/0 seats stopped before finishing${TAIL}`,
    );
  });
  test("a non-positive or non-integral budget never names an impossible window", () => {
    for (const budgetMs of [-46_000, 0]) {
      const summary = budgetExhaustedSummary({
        kind: "budget-exhausted",
        cause: "consumer-deadline",
        budgetWindow: "preparation",
        tier: "quick",
        budgetMs,
        seatsDispatched: null,
        seatsStopped: null,
        changedLines: null,
      });
      expect(summary).toBe(
        `Review budget exhausted: quick review reached its 0s preparation budget (consumer deadline reached)${TAIL}`,
      );
    }
    const fractional = budgetExhaustedSummary({
      kind: "budget-exhausted",
      cause: "consumer-deadline",
      budgetWindow: "preparation",
      tier: "quick",
      budgetMs: 46_500,
      seatsDispatched: null,
      seatsStopped: null,
      changedLines: null,
    });
    expect(fractional).toBe(
      `Review budget exhausted: quick review reached its 46.5s preparation budget (consumer deadline reached)${TAIL}`,
    );
  });

  test("a killed exec with no seat evidence states the budget and omits the counters", () => {
    const summary = budgetExhaustedSummary({
      kind: "budget-exhausted",
      cause: "sandbox-kill",
      budgetWindow: "runner",
      tier: "deep",
      budgetMs: 900_000,
      seatsDispatched: null,
      seatsStopped: null,
      changedLines: 17,
    });
    expect(summary).toBe(
      `Review budget exhausted: deep review reached its 900s runner budget (sandbox execution killed at its deadline); 17 changed lines${TAIL}`,
    );
  });

  test("decideConclusion publishes one failure with that summary and no pass", () => {
    const outcome = {
      kind: "budget-exhausted" as const,
      cause: "runner-deadline" as const,
      budgetWindow: "runner" as const,
      tier: "default" as const,
      budgetMs: 600_000,
      seatsDispatched: 5,
      seatsStopped: 3,
      changedLines: 402,
    };
    const conclusion = decideConclusion({
      proof: null,
      outcome: "budget-exhausted",
      gate: null,
      review: null,
      headSha: "a".repeat(40),
      budgetExhaustion: outcome,
    });
    expect(conclusion.desired).toBe("failure");
    expect(conclusion.title).toBe(CHECK_NAME);
    expect(conclusion.summary).toBe(budgetExhaustedSummary(outcome));
  });
  test("a same-head proof never outranks the typed stop — the outcome wins over a passing verdict", () => {
    const exhaustion = {
      kind: "budget-exhausted" as const,
      cause: "runner-deadline" as const,
      budgetWindow: "runner" as const,
      tier: "default" as const,
      budgetMs: 600_000,
      seatsDispatched: 5,
      seatsStopped: 3,
      changedLines: 402,
    };
    const conclusion = decideConclusion({
      proof: {
        publicationId: "prior",
        scope: SCOPE,
        headSha: SHA,
        kind: "review",
        round: 1,
        commentId: 9001,
        bodySha256: "b".repeat(64),
        confirmedMs: T0 - 10_000,
      },
      outcome: "budget-exhausted",
      gate: GATE,
      review: { verdict: "ship it", scorePct: 90 },
      headSha: SHA,
      budgetExhaustion: exhaustion,
    });
    expect(conclusion.desired).toBe("failure");
    expect(conclusion.summary).toBe(budgetExhaustedSummary(exhaustion));
  });

  test("a missing record is a named refusal, never a bare TypeError", () => {
    expect(() =>
      decideConclusion({
        proof: null,
        outcome: "budget-exhausted",
        gate: null,
        review: null,
        headSha: SHA,
      }),
    ).toThrow(/requires the resolved budgetExhaustion record/);
  });

});

describe("a resumed settlement acts only on the frozen generation", () => {
  function lifecycleFor(db: TestD1, onRemoteCall: () => void) {
    return createCheckLifecycle({
      db,
      nowMs: () => CLOCK,
      getAdapter: () =>
        ({
          beginCheck: async () => {
            onRemoteCall();
            return { kind: "unavailable", reason: "must not be reached", requests: 0 };
          },
        }) as never,
      getCheckGate: async () => GATE,
    });
  }

  test("a frozen generation that has ended is never re-minted by a resumed claim", async () => {
    const db = await seededDb();
    const first = await claimedAttempt(db);
    const frozen = await readCheckIdentity(db, first.attempt.identity.attemptId);
    if (frozen === null) throw new Error("fixture: the claim wrote no identity");
    await db
      .prepare("UPDATE review_checks SET terminal_ms = ?, holder = NULL, lease_until_ms = NULL WHERE id = ?")
      .bind(T0, first.attempt.identity.attemptId)
      .run();

    let remoteCalls = 0;
    const lifecycle = lifecycleFor(db, () => {
      remoteCalls += 1;
    });
    const adopted = await lifecycle.begin({
      scope: SCOPE,
      githubAppId: GITHUB_APP_ID,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      executionDeadlineMs: CLOCK + CHECK_LEASE_MS,
      expect: frozen,
    });

    expect(adopted).toBeNull();
    expect(remoteCalls).toBe(0);
    const rows = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_checks WHERE attempt_key = ?")
      .get(frozen.key) as { n: number };
    expect(rows.n).toBe(1);
  });

  test("a frozen pair whose row is still open is not refused by the identity check", async () => {
    const db = await seededDb();
    const attempt = await claimedAttempt(db);
    const frozen = await readCheckIdentity(db, attempt.attempt.identity.attemptId);
    if (frozen === null) throw new Error("fixture: the claim wrote no identity");

    let began = 0;
    const adapter = {
      beginCheck: async () => {
        began += 1;
        return { kind: "unavailable", reason: "test surface", requests: 0 };
      },
    } as never;
    const lifecycle = createCheckLifecycle({ db, nowMs: () => CLOCK, getAdapter: () => adapter, getCheckGate: async () => GATE });
    const adopted = await lifecycle.begin({
      scope: SCOPE,
      githubAppId: GITHUB_APP_ID,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      executionDeadlineMs: CLOCK + CHECK_LEASE_MS,
      expect: frozen,
    });

    expect(adopted).toBeNull();
    expect(began).toBe(0);
    const rows = db.raw
      .prepare("SELECT COUNT(*) AS n FROM review_checks WHERE attempt_key = ?")
      .get(frozen.key) as { n: number };
    expect(rows.n).toBe(1);
  });
});
