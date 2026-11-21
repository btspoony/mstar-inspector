/**
 * Publication-lease wiring tests (spec review-lifecycle §7.9, ADR
 * `2026-11-21-two-tier-lease-for-long-review`): every GitHub send proves
 * publication AUTHORITY for its exact action at the moment of the send.
 *
 * Proven here against the REAL store and scripted transports:
 *   - a Check terminal update and a prepared review comment refuse to send
 *     while another holder — a send OR the same action's recovery — owns the
 *     action's lease;
 *   - a lease that lapses between acquisition and dispatch refuses AT dispatch,
 *     after the token mint / marker scan that spent the window;
 *   - a settled send releases the action and nothing else: the attempt's
 *     execution lease is untouched, and releasing execution never releases a
 *     held publication lease;
 *   - send and recovery contend on the SAME key, so switching intent cannot
 *     bypass a live holder.
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import {
  CHECK_LEASE_MS,
  CHECK_NAME,
  attachCheckRunId,
  claimAttempt,
  releaseCheckClaim,
  setCheckCreateState,
  setCheckDesired,
  type CheckConclusion,
  type CheckIdentity,
  type Lease,
} from "../../src/store/review-checks";
import {
  PUBLICATION_LEASE_MS,
  claimDegradedTarget,
  claimPublication,
  claimPublicationLease,
  releasePublicationLease,
  stagePublication,
} from "../../src/store/finding-lifecycle";
import type { D1Like, D1StatementLike } from "../../src/store/types";
import {
  PUBLICATION_ACTION_CHECK_COMPLETE,
  PUBLICATION_ACTION_CHECK_CREATE,
  createChecksAdapter,
  type CheckRunPayload,
  type ChecksCreateParams,
  type ChecksOctokit,
  type ChecksRelabelParams,
} from "../../src/pipeline/checks";
import {
  PreparedSendRejected,
  PublicationDeadlineSpent,
  createReviewCommenter,
  deleteDegradedCommentWithOctokit,
  postPreparedReviewWithOctokit,
  type PostOctokit,
  type PublicationSendGuard,
} from "../../src/pipeline/comment";
import { createMigratedTestD1, mapAppToDefaultWorkspace, type TestD1 } from "../store/helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 1001;
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;
const RUN_ID = 4242;

/** The transaction clock every test drives explicitly (spec §7.0). */
let CLOCK = T0;

async function seededDb(): Promise<TestD1> {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'publication-lease-test', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
  await mapAppToDefaultWorkspace(db, APP_ID);
  return db;
}

/** One claimed attempt holding a live execution lease from `T0`. */
async function claimedAttempt(db: D1Like): Promise<{ attemptId: string; identity: CheckIdentity; lease: Lease }> {
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
  });
  if (result.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${result.kind}`);
  return { attemptId: result.attempt.identity.attemptId, identity: result.attempt.identity, lease: result.lease };
}

const SUCCESS: CheckConclusion = { desired: "success", title: CHECK_NAME, summary: "review gate met" };

/** The attempt with an attached run and its terminal intent frozen at `T0`. */
async function readyToComplete(db: D1Like): Promise<{ attemptId: string; identity: CheckIdentity; lease: Lease }> {
  const claim = await claimedAttempt(db);
  expect(await setCheckCreateState(db, claim.attemptId, claim.lease, "sending", undefined, T0)).toBe(true);
  expect(await attachCheckRunId(db, claim.attemptId, claim.lease, RUN_ID, T0)).toBe(true);
  expect(await setCheckDesired(db, claim.attemptId, claim.lease, SUCCESS, null, T0)).toBe(true);
  return claim;
}

function runPayload(identity: CheckIdentity, overrides: Partial<CheckRunPayload> = {}): CheckRunPayload {
  return {
    id: RUN_ID,
    name: CHECK_NAME,
    head_sha: identity.headSha,
    external_id: identity.externalId,
    status: "completed",
    conclusion: "success",
    app: { id: identity.githubAppId },
    ...overrides,
  };
}

/** A scripted Checks surface that records every request it was asked to send. */
function fakeChecks(identity: CheckIdentity): {
  octokit: ChecksOctokit;
  updates: ChecksRelabelParams[];
  creates: ChecksCreateParams[];
} {
  const updates: ChecksRelabelParams[] = [];
  const creates: ChecksCreateParams[] = [];
  const octokit: ChecksOctokit = {
    rest: {
      checks: {
        async create(params) {
          creates.push(params);
          return { data: runPayload(identity, { status: "queued" }) };
        },
        async update(params) {
          updates.push(params);
          return { data: runPayload(identity) };
        },
        async get() {
          throw new Error("this lane never reads");
        },
        async listForRef() {
          throw new Error("this lane never lists");
        },
      },
    },
  };
  return { octokit, updates, creates };
}

async function publicationRow(
  db: D1Like,
  attemptId: string,
  actionKey: string,
): Promise<{ holder: string | null; lease_epoch: number; lease_until_ms: number | null; mode: string | null } | null> {
  return db
    .prepare(`SELECT holder, lease_epoch, lease_until_ms, mode FROM publication_leases WHERE attempt_id = ? AND action_key = ?`)
    .bind(attemptId, actionKey)
    .first<{ holder: string | null; lease_epoch: number; lease_until_ms: number | null; mode: string | null }>();
}

async function checkRow(db: D1Like, attemptId: string): Promise<{
  holder: string | null; lease_epoch: number; lease_until_ms: number | null; execution_deadline_ms: number;
}> {
  const row = await db
    .prepare(`SELECT holder, lease_epoch, lease_until_ms, execution_deadline_ms FROM review_checks WHERE id = ?`)
    .bind(attemptId)
    .first<{ holder: string | null; lease_epoch: number; lease_until_ms: number | null; execution_deadline_ms: number }>();
  if (row === null) throw new Error("fixture: attempt row vanished");
  return row;
}

describe("Check send — the publication lease of check:complete", () => {
  test("a terminal update is refused while another holder owns the action", async () => {
    const db = await seededDb();
    const { attemptId, identity, lease } = await readyToComplete(db);
    // The action's lease is live under a RECOVERY holder: a send must contend
    // with it, not bypass it.
    expect(
      await claimPublicationLease(db, {
        attemptId, actionKey: PUBLICATION_ACTION_CHECK_COMPLETE, holder: "recover:2", mode: "recover", nowMs: T0,
      }),
    ).not.toBeNull();
    const fake = fakeChecks(identity);
    const adapter = createChecksAdapter({ db, nowMs: () => CLOCK, getOctokit: async () => fake.octokit });

    const result = await adapter.completeCheck({ identity, lease, checkRunId: RUN_ID, conclusion: SUCCESS });

    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.reason).toMatch(/publication lease for check:complete is held by another holder/);
    expect(result.kind === "unavailable" && result.requests).toBe(0);
    expect(fake.updates).toHaveLength(0);
    // The refused send released nothing: the live acquisition is still theirs.
    expect((await publicationRow(db, attemptId, PUBLICATION_ACTION_CHECK_COMPLETE))?.holder).toBe("recover:2");
  });

  test("a lease that lapses between acquisition and dispatch refuses at dispatch", async () => {
    const db = await seededDb();
    const { attemptId, identity, lease } = await readyToComplete(db);
    const fake = fakeChecks(identity);
    // Token minting and client resolution cross the 120 s publication window
    // (the execution lease is still live — CHECK_LEASE_MS is longer).
    const adapter = createChecksAdapter({
      db,
      nowMs: () => CLOCK,
      getOctokit: async () => {
        CLOCK = T0 + PUBLICATION_LEASE_MS + 1;
        return fake.octokit;
      },
    });

    const result = await adapter.completeCheck({ identity, lease, checkRunId: RUN_ID, conclusion: SUCCESS });

    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.reason).toMatch(
      /publication lease check:complete lapsed before the update request/,
    );
    expect(result.kind === "unavailable" && result.requests).toBe(0);
    expect(fake.updates).toHaveLength(0);
    // Handed off: the action is free for the recovery lane again.
    expect((await publicationRow(db, attemptId, PUBLICATION_ACTION_CHECK_COMPLETE))?.holder).toBeNull();
  });

  test("a settled update releases only the publication lease", async () => {
    const db = await seededDb();
    const { attemptId, identity, lease } = await readyToComplete(db);
    const fake = fakeChecks(identity);
    const adapter = createChecksAdapter({ db, nowMs: () => CLOCK, getOctokit: async () => fake.octokit });

    expect((await adapter.completeCheck({ identity, lease, checkRunId: RUN_ID, conclusion: SUCCESS })).kind).toBe("completed");
    expect(fake.updates).toHaveLength(1);

    const released = await publicationRow(db, attemptId, PUBLICATION_ACTION_CHECK_COMPLETE);
    expect(released?.holder).toBeNull();
    expect(released?.lease_until_ms).toBeNull();
    expect(released?.mode).toBe("send");
    // The attempt's EXECUTION lease is a different row and stays exactly as it
    // was: a settled publication never gives away the right to run the attempt.
    const row = await checkRow(db, attemptId);
    expect(row.holder).toBe(lease.holder);
    expect(row.lease_epoch).toBe(lease.epoch);
    expect(row.lease_until_ms).toBe(lease.untilMs);
  });
});

/** The prepared-review send input: a create (no target) with a fixed body. */
const commentInput = (publicationId: string) => ({
  installationId: 123,
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: SHA,
  round: 1,
  targetCommentId: null,
  body: "the exact prepared body",
  publicationId,
});

/** An Issues surface; `onScan` is where the marker scan's cost is simulated. */
function fakeIssues(onScan?: () => void | Promise<void>): {
  octokit: PostOctokit;
  calls: { verb: string; params: Record<string, unknown> }[];
} {
  const calls: { verb: string; params: Record<string, unknown> }[] = [];
  const octokit: PostOctokit = {
    paginate: async () => {
      await onScan?.();
      return [];
    },
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        updateComment: async (params) => {
          calls.push({ verb: "update", params });
          return {};
        },
        createComment: async (params) => {
          calls.push({ verb: "create", params });
          return { data: { id: 9001 } };
        },
      },
    },
  };
  return { octokit, calls };
}

const guardFor = (db: D1Like, attemptId: string): PublicationSendGuard => ({
  kind: "lease",
  db,
  nowMs: () => CLOCK,
  attemptId,
});

/** The no-Check-row lane: the caller's §7.7 journal claim, proved at dispatch. */
const journalGuard = (db: D1Like, publicationId: string, claim: Lease): PublicationSendGuard => ({
  kind: "journal",
  db,
  nowMs: () => CLOCK,
  publicationId,
  claim,
});

/** Stage and claim ONE journal publication, returning the claim this sender holds. */
async function journalClaim(db: D1Like, publicationId: string): Promise<Lease> {
  await stagePublication(db, {
    id: publicationId,
    nowMs: T0,
    payload: {
      version: 1,
      scope: SCOPE,
      headSha: SHA,
      kind: "review",
      round: 1,
      targetCommentId: null,
      body: "prepared body",
      bodySha256: "0".repeat(64),
      artifact: null,
      lifecycle: null,
      lineIntents: [],
    },
  });
  const lease = await claimPublication(db, publicationId, "consumer:journal", T0);
  if (lease === null) throw new Error("fixture: journal claim refused");
  return lease;
}

async function journalRow(db: D1Like, publicationId: string): Promise<{ holder: string | null; lease_epoch: number }> {
  const row = await db
    .prepare(`SELECT holder, lease_epoch FROM review_publications WHERE id = ?`)
    .bind(publicationId)
    .first<{ holder: string | null; lease_epoch: number }>();
  if (row === null) throw new Error("fixture: journal row vanished");
  return row;
}

describe("prepared comment send — the publication lease of comment:<publicationId>", () => {
  test("a review-comment send is refused while recovery owns the action", async () => {
    const db = await seededDb();
    const { attemptId } = await claimedAttempt(db);
    expect(
      await claimPublicationLease(db, {
        attemptId, actionKey: "comment:pub-1", holder: "recover:2", mode: "recover", nowMs: T0,
      }),
    ).not.toBeNull();
    const fake = fakeIssues();

    const failure = await postPreparedReviewWithOctokit(fake.octokit, commentInput("pub-1"), guardFor(db, attemptId)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PreparedSendRejected);
    expect((failure as Error).message).toMatch(/publication lease for comment:pub-1 is held by another holder/);
    expect(fake.calls).toHaveLength(0);
    expect((await publicationRow(db, attemptId, "comment:pub-1"))?.holder).toBe("recover:2");
  });

  test("a lease that lapses during the marker scan refuses the create", async () => {
    const db = await seededDb();
    const { attemptId } = await claimedAttempt(db);
    // The scan is the unbounded await between acquiring the action and the
    // mutation — here it spends the whole 120 s window.
    const fake = fakeIssues(() => {
      CLOCK = T0 + PUBLICATION_LEASE_MS + 1;
    });

    const failure = await postPreparedReviewWithOctokit(fake.octokit, commentInput("pub-2"), guardFor(db, attemptId)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PreparedSendRejected);
    expect((failure as Error).message).toMatch(/publication lease comment:pub-2 is no longer held by this sender/);
    expect(fake.calls).toHaveLength(0);
    expect((await publicationRow(db, attemptId, "comment:pub-2"))?.holder).toBeNull();
  });

  test("a settled send releases the action, and send and recovery contend on that key", async () => {
    const db = await seededDb();
    const { attemptId } = await claimedAttempt(db);
    const fake = fakeIssues();

    const sent = await postPreparedReviewWithOctokit(fake.octokit, commentInput("pub-3"), guardFor(db, attemptId));

    expect(sent.commentId).toBe(9001);
    expect(fake.calls.map((call) => call.verb)).toEqual(["create"]);
    const released = await publicationRow(db, attemptId, "comment:pub-3");
    expect(released?.holder).toBeNull();
    expect(released?.mode).toBe("send");
    // The SAME key is what recovery takes: the released send hands it over...
    const recovered = await claimPublicationLease(db, {
      attemptId, actionKey: "comment:pub-3", holder: "pub:recover-b", mode: "recover", nowMs: CLOCK,
    });
    expect(recovered).not.toBeNull();
    // ...and a live recovery blocks the next send of that action.
    expect(
      await claimPublicationLease(db, {
        attemptId, actionKey: "comment:pub-3", holder: "send:again", mode: "send", nowMs: CLOCK,
      }),
    ).toBeNull();
    expect((await publicationRow(db, attemptId, "comment:pub-3"))?.lease_epoch).toBe(recovered!.epoch);
  });
});

describe("the two lease tiers release independently", () => {
  test("releasing execution leaves a held publication lease held; releasing publication leaves the Check row intact", async () => {
    const db = await seededDb();
    const { attemptId, lease } = await claimedAttempt(db);
    expect(
      await claimPublicationLease(db, {
        attemptId, actionKey: PUBLICATION_ACTION_CHECK_COMPLETE, holder: "pub:send-a", mode: "send", nowMs: T0,
      }),
    ).not.toBeNull();

    // The unrelated execution path gives its own lease back...
    expect(await releaseCheckClaim(db, attemptId, lease, T0)).toBe(true);
    // ...and the publication lease is still held.
    expect((await publicationRow(db, attemptId, PUBLICATION_ACTION_CHECK_COMPLETE))?.holder).toBe("pub:send-a");

    const held = { holder: "pub:send-a", epoch: (await publicationRow(db, attemptId, PUBLICATION_ACTION_CHECK_COMPLETE))!.lease_epoch, untilMs: T0 + PUBLICATION_LEASE_MS };
    expect(await releasePublicationLease(db, { attemptId, actionKey: PUBLICATION_ACTION_CHECK_COMPLETE, lease: held, nowMs: T0 })).toBe(true);
    expect((await publicationRow(db, attemptId, PUBLICATION_ACTION_CHECK_COMPLETE))?.holder).toBeNull();
    // The Check row is untouched by either publication release.
    const row = await checkRow(db, attemptId);
    expect(row.holder).toBeNull(); // cleared by the EXECUTION release above, not by the publication one
    expect(row.execution_deadline_ms).toBe(T0 + CHECK_LEASE_MS);
  });
});

// ---------------------------------------------------------------------------
// Fix-round regressions: identity, absence, and the pre-dispatch re-proofs
// ---------------------------------------------------------------------------

/**
 * A store whose `publication_leases` reads answer late — the await between
 * acquiring the action and the mutation that no in-process clock otherwise
 * produces.
 */
function delayedFenceRead(db: D1Like, delayMs: number): D1Like {
  const wrap = (query: string, inner: D1StatementLike): D1StatementLike => ({
    bind: (...values) => wrap(query, inner.bind(...values)),
    first: async <T = Record<string, unknown>>() => {
      if (query.includes("FROM publication_leases")) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return inner.first<T>();
    },
    all: <T = Record<string, unknown>>() => inner.all<T>(),
    run: <T = Record<string, unknown>>() => inner.run<T>(),
  });
  return {
    prepare: (query) => wrap(query, db.prepare(query)),
    batch: (statements) => db.batch(statements),
  };
}

const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

describe("the key's identity is the Check attempt, never the execution one", () => {
  test("a comment send naming an id that is not a Check attempt is refused", async () => {
    const db = await seededDb();
    await claimedAttempt(db);
    // The container/execution identity the pipeline used to pass. A lease row
    // for it exists and is live — the exact phantom fence the wrong id built.
    const executionId = "review-0e5c1f2a-container";
    expect(
      await claimPublicationLease(db, {
        attemptId: executionId, actionKey: "comment:pub-x", holder: "send:comment:pub-x", mode: "send", nowMs: T0,
      }),
    ).not.toBeNull();
    const fake = fakeIssues();

    const failure = await postPreparedReviewWithOctokit(fake.octokit, commentInput("pub-x"), guardFor(db, executionId)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PreparedSendRejected);
    expect((failure as Error).message).toMatch(/is not a Check attempt/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("publication authority is required, not optional", () => {
  test("a send that presents neither a Check attempt nor a journal claim is refused", async () => {
    const db = await seededDb();
    let requests = 0;
    const commenter = createReviewCommenter(
      { APP_ID: "1", PRIVATE_KEY: TEST_PRIVATE_KEY },
      {
        db,
        nowMs: () => CLOCK,
        fetchImpl: async () => {
          requests += 1;
          return new Response("{}", { status: 200 });
        },
      },
    );

    const failure = await commenter.postPreparedReview(commentInput("pub-7")).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparedSendRejected);
    expect((failure as Error).message).toMatch(/no publication authority for pub-7/);
    expect(requests).toBe(0);
  });

  test("a send naming an attempt through a store-less commenter is refused before any request", async () => {
    let requests = 0;
    const commenter = createReviewCommenter(
      { APP_ID: "1", PRIVATE_KEY: TEST_PRIVATE_KEY },
      {
        fetchImpl: async () => {
          requests += 1;
          return new Response("{}", { status: 200 });
        },
      },
    );

    const failure = await commenter
      .postPreparedReview({ ...commentInput("pub-5"), attemptId: "attempt-without-store" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparedSendRejected);
    expect((failure as Error).message).toMatch(/built without the journal store/);
    expect(requests).toBe(0);
  });
});

describe("the held-check relabel re-proves its row at dispatch", () => {
  test("a row that stopped qualifying during client resolution is not relabelled", async () => {
    const db = await seededDb();
    // A released delivery row in the shape the predicate relabels.
    const claim = await claimAttempt(db, {
      scope: SCOPE,
      githubAppId: GITHUB_APP_ID,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId: "delivery-relabel",
      holder: "delivery:delivery-relabel",
      nowMs: T0,
      executionDeadlineMs: T0 + CHECK_LEASE_MS,
    });
    if (claim.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${claim.kind}`);
    expect(await setCheckCreateState(db, claim.attempt.identity.attemptId, claim.lease, "sending", undefined, T0)).toBe(true);
    expect(await attachCheckRunId(db, claim.attempt.identity.attemptId, claim.lease, RUN_ID, T0)).toBe(true);
    const fake = fakeChecks(claim.attempt.identity);
    const adapter = createChecksAdapter({
      db,
      nowMs: () => CLOCK,
      getOctokit: async () => {
        // The review reaches its conclusion while the client is being resolved:
        // freezing the intent makes the conditional write at dispatch select
        // nothing, so the queued text can never overwrite the settled run.
        expect(await setCheckDesired(db, claim.attempt.identity.attemptId, claim.lease, SUCCESS, null, T0)).toBe(true);
        return fake.octokit;
      },
    });

    const sent = await adapter.markQueuedBehindInflight!({
      scope: SCOPE,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      attachDeliveryId: "delivery-relabel",
      checkRunId: RUN_ID,
      summary: "Queued behind the live review for this pull request.",
      updateBudgetMs: 1_000,
      warn: () => {},
    });

    expect(sent).toBe(false);
    expect(fake.updates).toHaveLength(0);
  });
});

describe("the degraded cleanup deletes only the marker it scanned", () => {
  test("a marker rewritten after the scan is left in place", async () => {
    const marker = (round: number) =>
      `<!-- mstar-inspector:review-degraded:v1 round=${round} -->\n**Review degraded: output failed schema validation**`;
    // The scan sees round 1; by the delete the same comment carries round 2 —
    // a newer degraded publication that must survive.
    const bodies = [marker(1), marker(2)];
    let scans = 0;
    const deleted: number[] = [];
    const octokit: PostOctokit = {
      paginate: async () => [{ id: 7001, body: bodies[Math.min(scans++, bodies.length - 1)]!, user: { type: "Bot" } }],
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          updateComment: async () => ({}),
          createComment: async () => ({}),
          deleteComment: async (params) => {
            deleted.push(params.comment_id as number);
            return {};
          },
        },
      },
    };

    const outcome = await deleteDegradedCommentWithOctokit(octokit, {
      appId: APP_ID,
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      error: "",
      rawOutput: "",
    });

    expect(outcome.deleted).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(deleted).toEqual([]);
  });

  test("a newer staged body survives, and no writer may reuse the target during the delete", async () => {
    const db = await seededDb();
    const marker = `<!-- mstar-inspector:review-degraded:v1 round=1 -->\n**Review degraded: output failed schema validation**`;
    let scans = 0;
    let deletes = 0;
    let writerClaimWon = false;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) {
        return json(200, {
          token: "ghs_cleanup",
          expires_at: new Date(T0 + 3_600_000).toISOString(),
          repositories: [{ id: 1, name: "widgets" }],
          permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
          repository_selection: "selected",
        });
      }
      if (url.includes("/issues/42/comments")) {
        if (init?.method === "DELETE") {
          deletes += 1;
          return json(200, {});
        }
        scans += 1;
        if (scans === 2) {
          // Paused between the scan and the delete: a newer degraded body is
          // staged for the SAME target, and a writer tries to reuse it.
          await stagePublication(db, {
            id: "pub-newer-degraded",
            nowMs: T0,
            payload: {
              version: 1,
              scope: SCOPE,
              headSha: SHA,
              kind: "degraded",
              round: 2,
              targetCommentId: 7001,
              body: "newer degraded body",
              bodySha256: "d".repeat(64),
              artifact: null,
              lifecycle: null,
              lineIntents: [],
            },
          });
          const writer = await claimDegradedTarget(db, {
            scope: SCOPE,
            commentId: 7001,
            holder: "degraded:writer",
            nowMs: T0,
          });
          writerClaimWon = writer !== null;
        }
        return json(200, [{ id: 7001, body: marker, user: { type: "Bot" } }]);
      }
      return json(200, {});
    }) as unknown as typeof fetch;

    // The PRODUCTION factory: its delete wires both the preservation recheck
    // and the target exclusion against the same journal.
    const commenter = createReviewCommenter(
      { APP_ID: "1001", PRIVATE_KEY: TEST_PRIVATE_KEY },
      { db, nowMs: () => T0, fetchImpl },
    );
    const outcome = await commenter.deleteDegradedComment({
      appId: APP_ID,
      installationId: 123,
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      error: "",
      rawOutput: "",
    });

    expect(scans).toBeGreaterThanOrEqual(2);
    // The cleanup holds the exact target while its delete is in flight: the
    // writer's acquisition must lose, not race the DELETE.
    expect(writerClaimWon).toBe(false);
    // A newer staged body is still that comment's evidence: no delete.
    expect(outcome.deleted).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(deletes).toBe(0);
  });
});

describe("the frozen deadline is read after the lease proof", () => {
  test("a lease read that outlives notAfterMs refuses at dispatch", async () => {
    const db = await seededDb();
    const { attemptId } = await claimedAttempt(db);
    const fake = fakeIssues();
    // The lease proof's read answers 250ms late; the frozen instant is 150ms
    // away. A clock read BEFORE the verification would see 150ms of room.
    const slow = delayedFenceRead(db, 250);
    const notAfterMs = Date.now() + 150;

    const failure = await postPreparedReviewWithOctokit(
      fake.octokit,
      { ...commentInput("pub-timing"), notAfterMs },
      { kind: "lease", db: slow, nowMs: () => Date.now(), attemptId },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PublicationDeadlineSpent);
    expect((failure as Error).message).toMatch(/frozen deadline passed/);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix round 2: the no-Check lane's own authority, and the Check create
// ---------------------------------------------------------------------------

describe("the no-Check lane proves its journal claim at dispatch", () => {
  test("a claim taken over during the scan refuses the send", async () => {
    const db = await seededDb();
    const claim = await journalClaim(db, "pub-j1");
    // The recovery lane takes the journal row over while this sender scans.
    const fake = fakeIssues(async () => {
      expect(await claimPublication(db, "pub-j1", "recovery:9", T0 + PUBLICATION_LEASE_MS + 1)).not.toBeNull();
    });

    const failure = await postPreparedReviewWithOctokit(
      fake.octokit,
      commentInput("pub-j1"),
      journalGuard(db, "pub-j1", claim),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparedSendRejected);
    expect((failure as Error).message).toMatch(/publication lease comment:pub-j1 is no longer held by this sender/);
    expect(fake.calls).toHaveLength(0);
  });

  test("a send that still holds the claim dispatches, and the caller keeps the claim", async () => {
    const db = await seededDb();
    const claim = await journalClaim(db, "pub-j2");
    const fake = fakeIssues();

    const sent = await postPreparedReviewWithOctokit(
      fake.octokit,
      commentInput("pub-j2"),
      journalGuard(db, "pub-j2", claim),
    );

    expect(sent.commentId).toBe(9001);
    expect(fake.calls.map((call) => call.verb)).toEqual(["create"]);
    // The §7.7 claim belongs to the caller: the send proves it but never hands
    // it to recovery (the caller releases after the proof is persisted).
    const row = await journalRow(db, "pub-j2");
    expect(row.holder).toBe(claim.holder);
    expect(row.lease_epoch).toBe(claim.epoch);
  });
});

describe("the Check create proves its own action lease", () => {
  test("a create is refused while another holder owns check:create", async () => {
    const db = await seededDb();
    const { attemptId, identity, lease } = await claimedAttempt(db);
    expect(
      await claimPublicationLease(db, {
        attemptId, actionKey: PUBLICATION_ACTION_CHECK_CREATE, holder: "recover:2", mode: "recover", nowMs: T0,
      }),
    ).not.toBeNull();
    const fake = fakeChecks(identity);
    const adapter = createChecksAdapter({ db, nowMs: () => CLOCK, getOctokit: async () => fake.octokit });

    const result = await adapter.beginCheck({ identity, lease });

    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.reason).toMatch(
      /publication lease for check:create is held by another holder/,
    );
    expect(result.kind === "unavailable" && result.requests).toBe(0);
    expect(fake.creates).toHaveLength(0);
    // Nothing was attempted, so the row keeps its honest pre-send state.
    const row = await db
      .prepare(`SELECT create_state FROM review_checks WHERE id = ?`)
      .bind(attemptId)
      .first<{ create_state: string }>();
    expect(row?.create_state).toBe("not-sent");
  });
});
