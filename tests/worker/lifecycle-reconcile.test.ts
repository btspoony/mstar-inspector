/**
 * M8 recovery reconciler tests (plan 67 Task 5, spec review-lifecycle
 * §7.11/§7.11.1) — src/worker/lifecycle-reconcile.ts over the REAL migration
 * DDL (bun:sqlite D1 double, tests/store/helpers.ts) with the reviewer
 * surface injected (no GitHub, no credentials in tests).
 *
 * Behaviors covered (brief verification list):
 *   - staged apply after a crashed window (confirmed publication, lease
 *     expired, apply never ran) — purely local, reviewer never consulted
 *   - idempotent re-apply: a second pass re-selects nothing; a crash
 *     between store.put and the applied mark re-applies with the review
 *     INSERT skipped (§7.11.1) and zero duplicates
 *   - prepared publication recovery: staleness pre-check supersedes a
 *     stale round without sending; a current round is sent once with the
 *     same identity (claim → send → proof → apply)
 *   - resolve retry/backoff/give-up through the REAL §7.5 surface: attempts
 *     1/2/3/4 back off 1/2/4/8 min, the fifth failure lands a terminal
 *     visible local-error with the structured work line — never deleted;
 *     needs-recheck stops cycling
 *   - credential suspension for missing/disabled/deleted Apps (durable,
 *     attempts untouched, no GitHub) and exact-App re-enable on later
 *     activation
 *   - frozen paused policy: confirmed apply + resolution retry continue,
 *     prepared sends do not
 *   - budget/deadline exhaustion stops without spending an attempt
 *   - tenant/App isolation: only the failing pair is suspended
 *   - a throwing reviewer/dependency can never escape the handler
 */
import { describe, expect, test } from "bun:test";
import type { MstarReviewFinding, MstarReviewV1 } from "@mstar-harness/engine";
import { idemKey } from "../../src/contracts/idem";
import type { Scope } from "../../src/contracts/recheck";
import {
  applyPublishedLifecycle,
  claimPublication,
  listResolutionRecovery,
  recordPublicationProof,
  stagePublication,
  type LifecycleRound,
  type LineIntent,
  type PublicationPayload,
  type PublicationProof,
  type VerifiedResolution,
} from "../../src/store/finding-lifecycle";
import type { D1Like } from "../../src/store/types";
import { createReviewThreads } from "../../src/pipeline/review-threads";
import {
  reconcileReviewLifecycle,
  RECONCILE_MAX_REQUESTS,
  RECONCILE_PER_REQUEST_MS,
  RECONCILE_PUBLICATION_LANE_MAX_REQUESTS,
  RECONCILE_RUN_BUDGET_MS,
  RECONCILE_SELECT_LIMIT,
  RECONCILE_THREAD_OPERATION_REQUESTS,
  type LifecycleReconcileDeps,
  type ReconcileReviewer,
} from "../../src/worker/lifecycle-reconcile";
import type { ScheduledEnv } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const APP = "11111111-2222-3333-4444-555555555555";
const APP_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SCOPE: Scope = { appId: APP, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SCOPE_B: Scope = { appId: APP_B, installationId: 456, owner: "other", repo: "gadgets", prNumber: 7 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_000_000;

const SILENT_LOG = { warn: () => {}, info: () => {} };

function asEnv(db: TestD1): ScheduledEnv {
  return { DB: db as unknown as ScheduledEnv["DB"] };
}

async function reconcile(db: TestD1, deps: Omit<LifecycleReconcileDeps, "log"> = {}): Promise<
  Awaited<ReturnType<typeof reconcileReviewLifecycle>>
> {
  return reconcileReviewLifecycle(asEnv(db), { ...deps, log: SILENT_LOG });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type AppSeed = {
  githubAppId?: number;
  status?: string;
  deletedAt?: string | null;
  reviewEnabled?: number;
  install?: boolean;
  installationId?: number;
};

function seedApp(db: TestD1, id: string, seed: AppSeed = {}): void {
  const {
    githubAppId = 1001,
    status = "active",
    deletedAt = null,
    reviewEnabled = 1,
    install = true,
    installationId = SCOPE.installationId,
  } = seed;
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, review_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc-pem', 'enc-secret', 'tester', ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, `reconcile-${id}`, githubAppId, `reconcile-${id}`, status, deletedAt, reviewEnabled);
  if (install) {
    db.raw
      .prepare(
        `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
         VALUES (?, ?, ?, 'acme', datetime('now'))`,
      )
      .run(`inst-${id}-${installationId}`, id, installationId);
  }
}

function enginePayload(): MstarReviewV1 {
  return {
    schema: "mstar.review/v1",
    verdict: "needs fixes",
    summary_md: "One finding.",
    findings: [
      {
        mergeClass: "should-fix",
        category: "logic",
        file_path: "src/a.ts",
        line_start: 10,
        line_end: 12,
        title: "Null deref risk",
        body: "body",
        fingerprint_hint: "fp-1",
      } satisfies MstarReviewFinding,
    ],
  };
}

function artifactDoc(scope: Scope, headSha: string) {
  return {
    kind: "review" as const,
    key: idemKey({
      installation_id: scope.installationId,
      owner: scope.owner,
      repo: scope.repo,
      pr_number: scope.prNumber,
      head_sha: headSha,
    }),
    schema: "mstar.review/v1" as const,
    payload: enginePayload(),
    appId: scope.appId,
  };
}

function lifecycleRound(seenRowIds: string[]): LifecycleRound {
  return {
    selectedRowIds: [],
    assessments: [],
    seen: seenRowIds.map((rowId) => ({
      rowId,
      findingId: `finding-${rowId}`,
      original: {
        title: "Null deref risk",
        body: "Dereferencing possibly-null value.",
        filePath: "src/a.ts",
        lineStart: 10,
        lineEnd: 12,
        mergeClass: "should-fix" as const,
        category: "logic",
        fingerprintHint: "fp-1",
      },
    })),
    resolutions: [],
    coverage: { totalOpen: 1, selected: 0, assessed: 0, omitted: 0, capped: 0, contextCoverage: "complete" },
  };
}

function reviewPayload(scope: Scope, overrides: Partial<PublicationPayload> = {}): PublicationPayload {
  return {
    version: 1,
    scope,
    headSha: SHA,
    kind: "review",
    round: 1,
    targetCommentId: null,
    body: "review body",
    bodySha256: "b".repeat(64),
    artifact: artifactDoc(scope, SHA),
    lifecycle: lifecycleRound(["finding-row-1"]),
    lineIntents: [],
    ...overrides,
  };
}

function degradedPayload(scope: Scope, overrides: Partial<PublicationPayload> = {}): PublicationPayload {
  return {
    version: 1,
    scope,
    headSha: SHA,
    kind: "degraded",
    round: 1,
    targetCommentId: null,
    body: "degraded body",
    bodySha256: "c".repeat(64),
    artifact: null,
    lifecycle: null,
    lineIntents: [],
    ...overrides,
  };
}

function proofOf(id: string, pay: PublicationPayload, confirmedMs: number): PublicationProof {
  return {
    publicationId: id,
    scope: pay.scope,
    headSha: pay.headSha,
    kind: pay.kind,
    round: pay.round,
    commentId: 777,
    bodySha256: pay.bodySha256,
    confirmedMs,
  };
}

/** Stage → claim → record proof → expire the lease (the crashed-window shape). */
async function seedConfirmedCrashed(db: TestD1, id: string, pay: PublicationPayload, nowMs = T0): Promise<void> {
  await stagePublication(db, { id, payload: pay, nowMs });
  const lease = await claimPublication(db, id, "consumer", nowMs + 1);
  if (lease === null) throw new Error("test setup: claim failed");
  const recorded = await recordPublicationProof(db, id, lease, proofOf(id, pay, nowMs + 2));
  if (!recorded) throw new Error("test setup: proof recording failed");
  db.raw.prepare(`UPDATE review_publications SET lease_until_ms = ? WHERE id = ?`).run(nowMs - 1, id);
}

/** Seed a prepared (never sent) publication row staged `ageMs` ago. */
async function seedPrepared(db: TestD1, id: string, pay: PublicationPayload, ageMs: number): Promise<void> {
  await stagePublication(db, { id, payload: pay, nowMs: T0 - ageMs });
}

function seedFindingRow(db: TestD1, id: string, publicationId: string, scope: Scope, state = "addressed"): void {
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(id, scope.appId, scope.installationId, scope.owner, scope.repo, scope.prNumber, `finding-${id}`, publicationId, publicationId, SHA, SHA, state, T0, T0);
}

function seedThreadRow(
  db: TestD1,
  input: {
    id: string;
    publicationId: string;
    findingRowId: string;
    scope: Scope;
    verified: VerifiedResolution;
    state?: string;
    attempts?: number;
  },
): void {
  const intent: LineIntent = {
    associationId: input.id,
    findingRowId: input.findingRowId,
    publicationId: input.publicationId,
    scope: input.scope,
    originalSha: SHA,
    round: 1,
    path: "src/a.ts",
    line: 10,
    body: "Please fix this.",
    bodySha256: "a".repeat(64),
  };
  db.raw
    .prepare(
      `INSERT INTO review_threads
         (id, finding_row_id, publication_id, app_id, installation_id, owner, repo, pr_number,
          original_sha, round, intent_json, resolution_state, verified_json, attempts, created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id, input.findingRowId, input.publicationId,
      input.scope.appId, input.scope.installationId, input.scope.owner, input.scope.repo, input.scope.prNumber,
      SHA, JSON.stringify(intent), input.state ?? "pending", JSON.stringify(input.verified), input.attempts ?? 0, T0, T0,
    );
}

function verifiedFor(associationId: string, findingRowId: string): VerifiedResolution {
  return {
    assessment: {
      rowId: findingRowId,
      disposition: "addressed",
      reason: "verified-fix",
      evidence: null,
      relatedCurrentFindingIndexes: [],
    },
    snapshot: {
      associationId,
      threadId: "thread-1",
      commentId: 11,
      headSha: SHA,
      digest: "d".repeat(64),
      commentCount: 1,
      capturedMs: 1_000,
      coverage: "complete",
      modelCoverage: "complete",
    },
    issueDigest: "e".repeat(64),
    issueCoverage: "complete",
  };
}

/**
 * Reviewer factory whose routing is recorded; every GitHub call throws
 * unless overridden — "not expected" in lanes the test does not exercise.
 */
function okReviewer(
  overrides: Partial<ReconcileReviewer> = {},
  opts: { paused?: boolean; routed?: string[] } = {},
): NonNullable<LifecycleReconcileDeps["reviewer"]> {
  return async ({ appId, installationId }) => {
    opts.routed?.push(`${appId}:${installationId}`);
    return {
      kind: "ok",
      paused: opts.paused ?? false,
      reviewer: {
        planReviewUpsert: async () => {
          throw new Error("planReviewUpsert not expected");
        },
        postPreparedReview: async () => {
          throw new Error("postPreparedReview not expected");
        },
        postPreparedDegraded: async () => {
          throw new Error("postPreparedDegraded not expected");
        },
        listDiscussion: async () => {
          throw new Error("listDiscussion not expected");
        },
        resolveFindingThread: async () => {
          throw new Error("resolveFindingThread not expected");
        },
        ...overrides,
      },
    };
  };
}

function pubRow(db: TestD1, id: string): { phase: string; recovery_state: string; attempts: number; lease_until_ms: number | null; last_error: string | null } {
  return db.raw
    .prepare(`SELECT phase, recovery_state, attempts, lease_until_ms, last_error FROM review_publications WHERE id = ?`)
    .get(id) as never;
}

function threadRow(db: TestD1, id: string): { resolution_state: string; attempts: number; next_attempt_ms: number | null; lease_until_ms: number | null; last_error: string | null } {
  return db.raw
    .prepare(`SELECT resolution_state, attempts, next_attempt_ms, lease_until_ms, last_error FROM review_threads WHERE id = ?`)
    .get(id) as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcileReviewLifecycle — constants (spec §7.11.1)", () => {
  test("pins the budget constants", () => {
    expect(RECONCILE_MAX_REQUESTS).toBe(80);
    expect(RECONCILE_RUN_BUDGET_MS).toBe(45_000);
    expect(RECONCILE_PER_REQUEST_MS).toBe(5_000);
    expect(RECONCILE_THREAD_OPERATION_REQUESTS).toBe(15);
    expect(RECONCILE_PUBLICATION_LANE_MAX_REQUESTS).toBe(40);
    expect(RECONCILE_SELECT_LIMIT).toBe(10);
  });
});

describe("publication lane — confirmed apply", () => {
  test("applies a confirmed publication after a crashed window, purely locally", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedConfirmedCrashed(db, "pub-1", reviewPayload(SCOPE));

    let reviewerCalls = 0;
    const summary = await reconcile(db, {
      now: () => T0 + 1_000,
      reviewer: async () => {
        reviewerCalls += 1;
        throw new Error("no GitHub expected for a local apply");
      },
    });

    expect(summary.applied).toBe(1);
    expect(reviewerCalls).toBe(0); // local apply never touches GitHub
    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    const findings = db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number };
    expect(reviews.n).toBe(1);
    expect(findings.n).toBe(1);
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied", recovery_state: "done" });
  });

  test("re-apply is idempotent; a crash between store.put and the applied mark skips the review INSERT", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedConfirmedCrashed(db, "pub-1", reviewPayload(SCOPE));

    const first = await reconcile(db, { now: () => T0 + 1_000, reviewer: okReviewer() });
    expect(first.applied).toBe(1);

    // Simulate a crash between store.put and the applied mark: reset the
    // applied row to confirmed/pending, then reconcile again — the review
    // row exists, so the store.put INSERT must be SKIPPED (§7.11.1) and no
    // finding/round may duplicate.
    db.raw
      .prepare(
        `UPDATE review_publications SET phase = 'confirmed', recovery_state = 'pending',
           applied_ms = NULL, lease_until_ms = ?, holder = NULL WHERE id = 'pub-1'`,
      )
      .run(T0 - 1);

    const inserts: string[] = [];
    const env = asEnv(db);
    const inner = env.DB as unknown as D1Like;
    const countingDb: D1Like = {
      prepare(query: string) {
        if (query.includes("INSERT INTO reviews")) inserts.push(query);
        return inner.prepare(query);
      },
      batch: (statements) => inner.batch(statements),
    };
    const second = await reconcileReviewLifecycle(
      { ...env, DB: countingDb as unknown as ScheduledEnv["DB"] },
      { log: SILENT_LOG, now: () => T0 + 2_000, reviewer: okReviewer() },
    );

    expect(second.applied).toBe(1);
    expect(inserts).toHaveLength(0); // store.put skipped — the review row exists
    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    const findings = db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number };
    const rounds = db.raw.query("SELECT COUNT(*) AS n FROM review_finding_rounds").get() as { n: number };
    expect(reviews.n).toBe(1);
    expect(findings.n).toBe(1);
    expect(rounds.n).toBe(0);
  });

  test("a second reconcile pass after a completed apply re-selects nothing", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedConfirmedCrashed(db, "pub-1", reviewPayload(SCOPE));

    const first = await reconcile(db, { now: () => T0 + 1_000, reviewer: okReviewer() });
    const second = await reconcile(db, { now: () => T0 + 2_000, reviewer: okReviewer() });

    expect(first.applied).toBe(1);
    expect(second.examined).toBe(0);
    expect(second.applied).toBe(0);
    const reopen = db.raw.query("SELECT reopen_count AS n FROM review_findings").get() as { n: number };
    expect(reopen.n).toBe(0);
  });
});

describe("publication lane — prepared send", () => {
  test("supersedes a stale prepared round after the read-only pre-check, never sending", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", reviewPayload(SCOPE, { round: 1 }), 120_000);

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer({
        planReviewUpsert: async () => ({ action: "update", commentId: 9, round: 2 }), // PR shows round 1 already published by a NEWER publication
      }),
    });

    expect(summary.applied).toBe(0);
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "superseded", recovery_state: "done", attempts: 0 });
  });

  test("sends a current prepared publication once with the same identity, then proves and applies", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", reviewPayload(SCOPE, { round: 2 }), 120_000);

    const sent: Array<{ publicationId: string; round: number; body: string }> = [];
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer({
        planReviewUpsert: async () => ({ action: "update", commentId: 9, round: 2 }), // current parsed round 1 < prepared round 2
        postPreparedReview: async (input) => {
          sent.push({ publicationId: input.publicationId, round: input.round, body: input.body });
          return { commentId: 555 };
        },
      }),
    });

    expect(summary.applied).toBe(1);
    expect(sent).toEqual([{ publicationId: "pub-1", round: 2, body: "review body" }]);
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied", recovery_state: "done" });
    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(1);
  });

  test("a prepared row younger than 60s is left for the consumer, untouched", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", reviewPayload(SCOPE), 1_000);

    let routed = 0;
    const factory = okReviewer();
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async (input) => {
        routed += 1;
        return factory({ db, env: asEnv(db), appId: input.appId, installationId: input.installationId });
      },
    });

    // Pair-level credential health is checked (routing precedes the phase
    // work), but the age gate skips the send — no attempt, still due.
    expect(summary.examined).toBe(1);
    expect(routed).toBe(1);
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "prepared", recovery_state: "pending", attempts: 0 });
  });
});

describe("thread lane — retry, backoff, give-up (real §7.5 surface)", () => {
  test("retries back off 1/2/4/8 min and the fifth failure lands a visible local-error", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    // The REAL §7.5 surface with unavailable identity: the resolve fails
    // closed as retry:api and consumes one attempt through its own claim.
    const clock = { now: T0 };
    const threads = createReviewThreads({
      db,
      nowMs: () => clock.now,
      getAppIdentity: async () => null,
      getOctokit: async () => null,
    });
    const backoffsSeen: number[] = [];
    let lastAttempts = 0;
    for (let round = 0; round < 5; round++) {
      const summary = await reconcile(db, {
        now: () => clock.now,
        reviewer: okReviewer({ resolveFindingThread: threads.resolveFindingThread }),
      });
      const row = threadRow(db, "assoc-1");
      lastAttempts = row.attempts;
      if (row.next_attempt_ms !== null) backoffsSeen.push(row.next_attempt_ms - clock.now);
      expect(row.lease_until_ms).toBeNull();
      if (round < 4) {
        expect(summary.errors).toBe(1);
        expect(row.resolution_state).toBe("retry");
        expect(row.attempts).toBe(round + 1);
        // jump past this round's backoff for the next pass
        clock.now += (backoffsSeen[backoffsSeen.length - 1] ?? 0) + 1_000;
      } else {
        expect(row.attempts).toBe(5);
        expect(row.resolution_state).toBe("local-error");
        expect(row.next_attempt_ms).toBeNull();
        expect(row.last_error).toContain("gave up after 5 attempts");
        expect(row.last_error).toContain("work=assoc-1");
      }
    }
    expect(backoffsSeen).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(lastAttempts).toBe(5);
    // The row is retained (never deleted).
    const count = db.raw.query("SELECT COUNT(*) AS n FROM review_threads WHERE id = 'assoc-1'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("a needs-recheck outcome stops the cycling without touching the concern", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer({
        resolveFindingThread: async () => ({ kind: "needs-recheck", reason: "head-changed" }),
      }),
    });

    expect(summary.unknown).toBe(1);
    expect(summary.errors).toBe(0);
    const row = threadRow(db, "assoc-1");
    expect(row.resolution_state).toBe("needs-recheck");
    // No longer selectable by the recovery reader.
    const pending = await listResolutionRecovery(db, T0 + 1_000_000, 10);
    expect(pending.map((r) => r.associationId)).not.toContain("assoc-1");
  });

  test("a resolved outcome counts without extra bookkeeping", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer({
        resolveFindingThread: async () => ({ kind: "resolved", threadId: "thread-1", adopted: true, outdated: false, lateChange: false }),
      }),
    });

    expect(summary.resolved).toBe(1);
    expect(summary.errors).toBe(0);
    expect(threadRow(db, "assoc-1").next_attempt_ms).toBeNull();
  });
});

describe("credential routing — suspension and re-enable (spec §7.6/§7.11.1)", () => {
  test("missing, disabled and deleted Apps suspend their rows durably with untouched attempts", async () => {
    const db = createMigratedTestD1();
    const APP_C = "cccccccc-dddd-eeee-ffff-000000000001";
    const SCOPE_C: Scope = { appId: APP_C, installationId: 789, owner: "third", repo: "tools", prNumber: 9 };
    seedApp(db, APP, { install: false }); // missing app_installations mapping
    seedApp(db, APP_B, { githubAppId: 1002, status: "disabled", installationId: SCOPE_B.installationId });
    seedApp(db, APP_C, { githubAppId: 1003, deletedAt: new Date().toISOString(), installationId: SCOPE_C.installationId });
    await seedPrepared(db, "pub-a", degradedPayload(SCOPE), 120_000);
    await seedPrepared(db, "pub-b", degradedPayload(SCOPE_B), 120_000);
    await seedPrepared(db, "pub-c", degradedPayload(SCOPE_C), 120_000);
    seedFindingRow(db, "finding-row-1", "pub-a", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-a",
      publicationId: "pub-a",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-a", "finding-row-1"),
    });

    const summary = await reconcile(db, { now: () => T0 }); // production routing — no credentials in tests

    expect(summary.suspended).toBe(4); // pub-a + pub-b + pub-c + assoc-a
    expect(summary.applied).toBe(0);
    expect(pubRow(db, "pub-a")).toMatchObject({ recovery_state: "suspended", attempts: 0 });
    expect(pubRow(db, "pub-b")).toMatchObject({ recovery_state: "suspended", attempts: 0 });
    expect(pubRow(db, "pub-c")).toMatchObject({ recovery_state: "suspended", attempts: 0 });
    const thread = threadRow(db, "assoc-a");
    expect(thread.resolution_state).toBe("suspended");
    expect(thread.attempts).toBe(0);
    expect(thread.last_error).toContain("no GitHub mutation");
  });

  test("re-enabling the App resumes suspended rows with fresh fencing (same IDs)", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP, { status: "disabled" });
    await seedPrepared(db, "pub-a", degradedPayload(SCOPE), 120_000);
    await reconcile(db, { now: () => T0 }); // production routing: disabled → suspended
    expect(pubRow(db, "pub-a").recovery_state).toBe("suspended");

    db.raw.prepare(`UPDATE github_apps SET status = 'active' WHERE id = ?`).run(APP);
    // The re-enable probe is D1-only; the injected reviewer keeps the
    // resumed pair off the suspension path for this pass.
    await reconcile(db, { now: () => T0 + 1_000, reviewer: okReviewer() });

    expect(pubRow(db, "pub-a")).toMatchObject({ recovery_state: "pending", phase: "prepared" });
    expect(pubRow(db, "pub-a").last_error).toBeNull();
  });
});

describe("frozen paused policy (spec §7.6)", () => {
  test("paused: confirmed apply and resolution retry continue; prepared sends do not", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP, { reviewEnabled: 0 });
    await seedConfirmedCrashed(db, "pub-confirmed", reviewPayload(SCOPE));
    await seedPrepared(db, "pub-prepared", degradedPayload(SCOPE, { round: 1 }), 120_000);
    seedFindingRow(db, "finding-row-1", "pub-confirmed", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-confirmed",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    const githubCalls: string[] = [];
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer(
        {
          resolveFindingThread: async () => ({ kind: "resolved", threadId: "thread-1", adopted: true, outdated: false, lateChange: false }),
          planReviewUpsert: async () => {
            githubCalls.push("plan");
            return { action: "create", round: 1 };
          },
        },
        { paused: true, routed: githubCalls },
      ),
    });

    // Local apply of the already-confirmed publication continues…
    expect(summary.applied).toBe(1);
    expect(pubRow(db, "pub-confirmed")).toMatchObject({ phase: "applied" });
    // …previously-authorized resolution retry continues…
    expect(summary.resolved).toBe(1);
    // …but NO new primary publication is prepared for sending.
    expect(pubRow(db, "pub-prepared")).toMatchObject({ phase: "prepared", recovery_state: "pending", attempts: 0 });
    const postCalls = db.raw.query("SELECT COUNT(*) AS n FROM review_publications WHERE phase = 'sending'").get() as { n: number };
    expect(postCalls.n).toBe(0);
  });
});

describe("budgets (spec §7.11.1)", () => {
  test("deadline exhaustion stops the thread lane without spending an attempt", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    // FK anchor for the thread row, staged TERMINAL so the publication lane
    // stays empty and the clock sequence isolates the thread-lane budget.
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    db.raw.prepare(`UPDATE review_publications SET phase = 'superseded', recovery_state = 'done' WHERE id = 'pub-1'`).run();
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    let call = 0;
    const now = () => {
      const value = call++ < 1 ? T0 : T0 + RECONCILE_RUN_BUDGET_MS + 1_000;
      return value;
    };
    let resolved = 0;
    const summary = await reconcile(db, {
      now,
      reviewer: okReviewer({
        resolveFindingThread: async () => {
          resolved += 1;
          return { kind: "resolved", threadId: "t", adopted: false, outdated: false, lateChange: false };
        },
      }),
    });

    expect(resolved).toBe(0); // the §7.5 surface was never entered — no claim, no attempt
    expect(summary.examined).toBe(0);
    expect(threadRow(db, "assoc-1")).toMatchObject({ resolution_state: "pending", attempts: 0, lease_until_ms: null });
  });
});

describe("tenant/App isolation", () => {
  test("only the broken pair is suspended; the healthy pair resolves", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    seedApp(db, APP_B, { githubAppId: 1002, install: false, installationId: SCOPE_B.installationId });
    await seedConfirmedCrashed(db, "pub-a", reviewPayload(SCOPE));
    await seedPrepared(db, "pub-b", degradedPayload(SCOPE_B), 120_000); // needs GitHub → suspends with the pair
    seedFindingRow(db, "finding-row-1", "pub-a", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-a",
      publicationId: "pub-a",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-a", "finding-row-1"),
    });
    seedFindingRow(db, "finding-row-b", "pub-b", SCOPE_B, "addressed");
    seedThreadRow(db, {
      id: "assoc-b",
      publicationId: "pub-b",
      findingRowId: "finding-row-b",
      scope: SCOPE_B,
      verified: verifiedFor("assoc-b", "finding-row-b"),
    });

    const routed: string[] = [];
    const resolvedScopes: Scope[] = [];
    const healthy = okReviewer(
      {
        resolveFindingThread: async (input) => {
          resolvedScopes.push(input.scope);
          return { kind: "resolved", threadId: "t", adopted: false, outdated: false, lateChange: false };
        },
      },
      { routed },
    );
    const summary = await reconcile(db, {
      now: () => T0,
      // Pair B's installation mapping is missing (simulating the broken
      // D1-routing outcome); pair A is served.
      reviewer: async (input) => {
        routed.push(`${input.appId}:${input.installationId}`);
        if (input.appId === APP_B) return { kind: "unavailable", reason: "missing" as const };
        return healthy(input);
      },
    });

    expect(summary.applied).toBe(1); // pub-a
    expect(summary.resolved).toBe(1); // assoc-a (state persistence is the §7.5 surface's own contract)
    expect(summary.suspended).toBe(2); // pub-b + assoc-b
    expect(pubRow(db, "pub-a")).toMatchObject({ phase: "applied" });
    expect(pubRow(db, "pub-b")).toMatchObject({ recovery_state: "suspended" });
    expect(threadRow(db, "assoc-b").resolution_state).toBe("suspended");
    expect(resolvedScopes).toEqual([SCOPE]); // exact scope binding, no cross-App work
    expect(routed).toContain(`${APP}:123`);
    expect(routed).toContain(`${APP_B}:456`);
  });
});

describe("throw-proof wrapper (spec §7.11)", () => {
  test("a throwing reviewer factory never escapes the handler", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async () => {
        throw new Error("credential path exploded");
      },
    });

    // The wrapper folded the failure into a typed suspension, not a throw.
    expect(summary.suspended).toBeGreaterThanOrEqual(1);
    expect(pubRow(db, "pub-1").recovery_state).toBe("suspended");
  });

  test("a throwing clock never escapes the handler", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    const summary = await reconcileReviewLifecycle(asEnv(db), {
      log: SILENT_LOG,
      now: () => {
        throw new Error("clock exploded");
      },
      reviewer: okReviewer(),
    });
    expect(summary).toEqual({ examined: 0, applied: 0, resolved: 0, unknown: 0, suspended: 0, errors: 1 });
  });
});
