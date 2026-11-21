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
  claimPublicationLease,
  releasePublicationLease,
} from "../../src/store/finding-lifecycle";
import type { D1Like } from "../../src/store/types";
import {
  PUBLICATION_ACTION_CHECK_COMPLETE,
  createChecksAdapter,
  type CheckRunPayload,
  type ChecksOctokit,
  type ChecksRelabelParams,
} from "../../src/pipeline/checks";
import {
  PreparedSendRejected,
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

/** A scripted Checks surface that records every update it was asked to send. */
function fakeChecks(identity: CheckIdentity): { octokit: ChecksOctokit; updates: ChecksRelabelParams[] } {
  const updates: ChecksRelabelParams[] = [];
  const octokit: ChecksOctokit = {
    rest: {
      checks: {
        async create() {
          throw new Error("this lane never creates");
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
  return { octokit, updates };
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

/** A scripted Issues surface; `onScan` is where the marker scan's cost is simulated. */
function fakeIssues(onScan?: () => void): {
  octokit: PostOctokit;
  calls: { verb: string; params: Record<string, unknown> }[];
} {
  const calls: { verb: string; params: Record<string, unknown> }[] = [];
  const octokit: PostOctokit = {
    paginate: async () => {
      onScan?.();
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
  db,
  nowMs: () => CLOCK,
  attemptId,
});

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
