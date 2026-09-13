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
 *   - whole-run accounting: the pair identity probe is reserved with the
 *     thread operation, and an ATTEMPTED-then-rejected plan request is
 *     charged before its await so repeated failures cannot exceed ≤80
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
  listPublicationRecovery,
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
  type ReconcileTransport,
  type ReviewerResolution,
} from "../../src/worker/lifecycle-reconcile";
import type { UpsertPlan } from "../../src/pipeline/comment";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { ScheduledEnv } from "../../src/worker/env";
import { PreparedSendRejected } from "../../src/pipeline/comment";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { testAppPem } from "../helpers/rsa-key";

const APP = "11111111-2222-3333-4444-555555555555";
const APP_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const APP_C = "cccccccc-1111-2222-3333-444444444444";
const SCOPE: Scope = { appId: APP, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SCOPE_B: Scope = { appId: APP_B, installationId: 456, owner: "other", repo: "gadgets", prNumber: 7 };
const SCOPE_C: Scope = { appId: APP_C, installationId: 789, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_000_000;

/** Base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

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

/**
 * Seed an App whose stored `private_key_enc` is a REAL, decryptable PKCS#8
 * PEM. The production factory's identity proof must sign a JWT before it can
 * reach the transport, so the `'enc-pem'` placeholder `seedApp` uses can
 * never exercise the live-identity path.
 */
async function seedRealApp(db: TestD1, id: string, githubAppId: number): Promise<void> {
  const pem = await testAppPem();
  const encrypted = await createSecretbox(TEST_ENCRYPTION_KEY).encryptSecret(
    pem,
    `github_apps.private_key_enc:${id}`,
  );
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, review_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'enc-secret', 'tester', 'active', NULL, 1, datetime('now'), datetime('now'))`,
    )
    .run(id, `reconcile-${id}`, githubAppId, `reconcile-${id}`, encrypted);
  db.raw
    .prepare(
      `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
       VALUES (?, ?, ?, 'acme', datetime('now'))`,
    )
    .run(`inst-${id}-${SCOPE.installationId}`, id, SCOPE.installationId);
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
 * A resolvable "ok" reviewer resolution: the default surface throws for every
 * operation the test did not explicitly override, so an unexpected GitHub call
 * is a loud test failure rather than a silent pass.
 */
function okResolution(
  overrides: Partial<ReconcileReviewer> = {},
  opts: { paused?: boolean; botLogin?: string } = {},
): Extract<ReviewerResolution, { kind: "ok" }> {
  return {
    kind: "ok",
    paused: opts.paused ?? false,
    botLogin: opts.botLogin ?? "reconcile-bot[bot]",
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
}

/**
 * Reviewer factory whose routing is recorded; every GitHub call throws
 * unless overridden — "not expected" in lanes the test does not exercise.
 */
function okReviewer(
  overrides: Partial<ReconcileReviewer> = {},
  opts: { paused?: boolean; routed?: string[]; botLogin?: string } = {},
): NonNullable<LifecycleReconcileDeps["reviewer"]> {
  return async ({ appId, installationId }) => {
    opts.routed?.push(`${appId}:${installationId}`);
    return okResolution(overrides, opts);
  };
}

/**
 * Issue `count` REAL requests through the run transport with the global fetch
 * neutralized, and report how many were actually dispatched. Tests use this to
 * make an injected reviewer faithful to the §7.5 surface (which really issues
 * GitHub requests) without touching the network — the transport's own metering
 * is then exercised by the run, not simulated.
 */
async function meterRequests(transport: ReconcileTransport, count: number): Promise<number> {
  const realFetch = globalThis.fetch;
  let dispatched = 0;
  try {
    globalThis.fetch = (async () => {
      dispatched += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    for (let i = 0; i < count; i += 1) {
      try {
        await transport.fetchImpl(`https://api.github.com/x?n=${i}`);
      } catch {
        break; // budget refusal is a legitimate outcome; report what was sent
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return dispatched;
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

describe("enforced per-request transport bound (spec §7.11.1)", () => {
  /** Drive one pass and capture the run transport the factory receives. */
  async function captureTransport(db: TestD1, clock: { now: number }): Promise<{
    transport: ReconcileTransport;
    boundedMs: () => number;
  }> {
    let captured: ReconcileTransport | undefined;
    await reconcile(db, {
      now: () => clock.now,
      reviewer: async (input) => {
        captured = input.transport;
        return { kind: "unavailable", reason: "missing" };
      },
    });
    if (captured === undefined) throw new Error("the run never built a transport");
    return { transport: captured, boundedMs: captured.boundMs };
  }

  test("a request is clamped to the REMAINING run time, not only the 5s cap", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    const clock = { now: T0 };
    const { transport } = await captureTransport(db, clock);

    // Deadline = T0 + 45s (fixed at run start). With plenty of run left the
    // per-request bound is the 5s cap...
    expect(transport.boundMs()).toBe(RECONCILE_PER_REQUEST_MS);
    // ...and late in the run it collapses to the remaining time — this is the
    // clamp the review found missing (§7.11.1: "additionally capped by
    // remaining run deadline").
    clock.now = T0 + RECONCILE_RUN_BUDGET_MS - 30;
    expect(transport.boundMs()).toBe(30);
    // Never zero/negative: a request already past the deadline gets 1ms.
    clock.now = T0 + RECONCILE_RUN_BUDGET_MS + 10_000;
    expect(transport.boundMs()).toBe(1);

    // The clamp is ENFORCED on the wire, not merely computed: a hung upstream
    // rejects inside the bound because the seam passes an aborting signal.
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) {
            reject(new Error("the bounded seam issued a request with no abort signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason));
        })) as unknown as typeof fetch;
      clock.now = T0 + RECONCILE_RUN_BUDGET_MS - 40; // 40ms of run left
      const started = performance.now();
      await expect(transport.fetchImpl("https://api.github.com/app")).rejects.toMatchObject({
        name: "TimeoutError",
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_000); // far below the 5s cap — the remaining time bound it
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a caller-supplied signal is preserved, not replaced, by the clamp", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    const clock = { now: T0 };
    const { transport } = await captureTransport(db, clock);

    const realFetch = globalThis.fetch;
    try {
      let seen: AbortSignal | null | undefined;
      globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
        seen = init?.signal;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof fetch;

      const caller = AbortSignal.timeout(60_000);
      await transport.fetchImpl("https://api.github.com/app", { signal: caller });
      expect(seen).not.toBe(caller); // combined, not substituted
      expect(seen?.aborted).toBe(false);

      // The COMBINED signal still honours the caller's abort.
      const aborting = new AbortController();
      const promise = transport.fetchImpl("https://api.github.com/app", { signal: aborting.signal });
      aborting.abort(new Error("caller cancelled"));
      expect(seen?.aborted).toBe(true);
      await promise;
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("thread lane request budget (spec §7.11.1)", () => {
  test("the resolution lane admits on its per-operation envelope, and every ACTUAL request is metered", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    // Terminal publication as the FK anchor: the publication lane stays empty
    // so the whole 80-request budget belongs to the thread lane.
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    db.raw
      .prepare(`UPDATE review_publications SET phase = 'superseded', recovery_state = 'done' WHERE id = 'pub-1'`)
      .run();
    // TEN due rows — the §7.11.1 selection LIMIT. The ≤15-request envelope is
    // the admission ESTIMATE: only floor(80 / 15) = 5 may even start, and the
    // requests each operation really issues are charged at the transport.
    for (let i = 0; i < RECONCILE_SELECT_LIMIT; i += 1) {
      const rowId = `finding-row-${i}`;
      const assocId = `assoc-${i}`;
      seedFindingRow(db, rowId, "pub-1", SCOPE, "addressed");
      seedThreadRow(db, {
        id: assocId,
        publicationId: "pub-1",
        findingRowId: rowId,
        scope: SCOPE,
        verified: verifiedFor(assocId, rowId),
      });
    }

    // Each entered operation issues a REAL request burst through the run
    // transport, exactly as the §7.5 surface does — this is what the meter has
    // to see. 25 requests per operation means the whole-run cap is reached
    // after three operations, and the fourth is refused ADMISSION before any
    // claim (its ≤15-request estimate no longer fits).
    const perOperationRequests = 25;
    let requests = 0;
    let resolved = 0;
    let transport: ReconcileTransport | undefined;
    const summary = await reconcileReviewLifecycle(asEnv(db), {
      log: SILENT_LOG,
      now: () => T0,
      reviewer: async (input) => {
        transport = input.transport;
        const runTransport = input.transport!;
        return okResolution({
          // Faithful to the real §7.5 surface: entering T2 CONSUMES the claim
          // (attempt counted, lease taken) AND issues real requests.
          resolveFindingThread: async (input2) => {
            resolved += 1;
            requests += await meterRequests(runTransport, perOperationRequests);
            db.raw
              .prepare(
                `UPDATE review_threads SET attempts = attempts + 1, holder = 't2', lease_until_ms = ?,
                   resolution_state = 'resolved', updated_ms = ? WHERE id = ?`,
              )
              .run(T0 + 60_000, T0, input2.associationId);
            return { kind: "resolved", threadId: "t", adopted: false, outdated: false, lateChange: false };
          },
        });
      },
    });

    expect(RECONCILE_MAX_REQUESTS).toBe(80);
    // 25 + 25 + 25 = 75 actual requests by three operations; 75 + 15 > 80, so
    // the fourth is never admitted. Actual requests stay under the cap.
    expect(resolved).toBe(3);
    expect(requests).toBe(75);
    expect(requests).toBeLessThanOrEqual(RECONCILE_MAX_REQUESTS);
    expect(summary.examined).toBe(3);

    // Budget exhaustion stops the lane BEFORE any claim/attempt mutation for
    // the rows it never reached (§7.11.1: exhaustion is not a failed attempt).
    const untouched = db.raw
      .query(`SELECT COUNT(*) AS n FROM review_threads WHERE attempts = 0 AND lease_until_ms IS NULL AND resolution_state = 'pending'`)
      .get() as { n: number };
    expect(untouched.n).toBe(RECONCILE_SELECT_LIMIT - 3); // 7 rows never entered T2
    expect(transport).toBeDefined();

    // The meter is the TRANSPORT: the remaining allowance is exactly
    // 80 - 75 = 5, and the 6th request is refused BEFORE any dispatch.
    const realFetch = globalThis.fetch;
    const alreadySpent = requests;
    try {
      let dispatched = 0;
      globalThis.fetch = (async () => {
        dispatched += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      for (let i = 0; i < RECONCILE_MAX_REQUESTS - alreadySpent; i += 1) {
        await transport!.fetchImpl("https://api.github.com/x");
      }
      expect(dispatched).toBe(RECONCILE_MAX_REQUESTS - alreadySpent);
      await expect(transport!.fetchImpl("https://api.github.com/x")).rejects.toThrow(/budget exhausted/);
      expect(dispatched).toBe(RECONCILE_MAX_REQUESTS - alreadySpent); // never dispatched
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("publication-lane spend is shared with the thread lane, shrinking how many rows may enter", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    // A prepared publication needing GitHub issues its real plan + send
    // requests through the SAME run transport, so its spend genuinely reduces
    // what the thread lane may admit — there is no separate allowance.
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE, { round: 1 }), 120_000);
    for (let i = 0; i < RECONCILE_SELECT_LIMIT; i += 1) {
      const rowId = `finding-row-${i}`;
      const assocId = `assoc-${i}`;
      seedFindingRow(db, rowId, "pub-1", SCOPE, "addressed");
      seedThreadRow(db, {
        id: assocId,
        publicationId: "pub-1",
        findingRowId: rowId,
        scope: SCOPE,
        verified: verifiedFor(assocId, rowId),
      });
    }

    let threadRequests = 0;
    let entered = 0;
    let publicationRequests = 0;
    await reconcileReviewLifecycle(asEnv(db), {
      log: SILENT_LOG,
      now: () => T0,
      reviewer: async (input) => {
        const runTransport = input.transport!;
        return okResolution({
          // 1 (plan) + 39 (send) real requests = the publication lane's full
          // half share (40) — exactly the §7.11.1 "publication lane gets at
          // most half the run budget before the thread lane" rule.
          planReviewUpsert: async () => {
            publicationRequests += await meterRequests(runTransport, 1);
            return { action: "create", round: 1 };
          },
          postPreparedDegraded: async () => {
            publicationRequests += await meterRequests(runTransport, 39);
            return { posted: true, commentId: 777 };
          },
          // Each thread operation also issues real requests (a §7.5 resolve
          // walks several endpoints), so the lane must live inside what the
          // publication lane left of the SHARED cap.
          resolveFindingThread: async () => {
            entered += 1;
            threadRequests += await meterRequests(runTransport, 20);
            return { kind: "resolved", threadId: "t", adopted: false, outdated: false, lateChange: false };
          },
        });
      },
    });

    // The lane cap is a real bound on ACTUAL requests: the publication lane
    // stops dispatching at 40 even though its estimate was tiny.
    expect(publicationRequests).toBe(RECONCILE_PUBLICATION_LANE_MAX_REQUESTS);
    // The thread lane then shares that same run allowance: every operation that
    // entered really issued its requests, and together the two lanes stop at
    // exactly the whole-run cap — admission alone never lets the run overshoot.
    expect(threadRequests).toBe(RECONCILE_MAX_REQUESTS - RECONCILE_PUBLICATION_LANE_MAX_REQUESTS);
    expect(publicationRequests + threadRequests).toBe(RECONCILE_MAX_REQUESTS);
    expect(entered).toBeGreaterThan(0);
  });
});

describe("actual-request metering at the transport (spec §7.11.1 ≤80, P67-QC-009)", () => {
  test("pagination pages are metered individually, not as one operation", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    db.raw
      .prepare(`UPDATE review_publications SET phase = 'superseded', recovery_state = 'done' WHERE id = 'pub-1'`)
      .run();
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    let transport: ReconcileTransport | undefined;
    await reconcileReviewLifecycle(asEnv(db), {
      log: SILENT_LOG,
      now: () => T0,
      reviewer: async (input) => {
        transport = input.transport;
        return { kind: "unavailable", reason: "missing" };
      },
    });
    expect(transport).toBeDefined();

    const realFetch = globalThis.fetch;
    try {
      let dispatched = 0;
      globalThis.fetch = (async () => {
        dispatched += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      // A single logical operation that internally paginates 40 pages: every
      // page is a REAL request and must consume the cap one by one. Under the
      // old per-operation reservation this whole burst was charged as one or
      // two requests, which is exactly why the bound did not hold.
      for (let page = 0; page < 40; page += 1) {
        await transport!.fetchImpl(`https://api.github.com/items?page=${page}`);
      }
      expect(dispatched).toBe(40);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("actual requests cannot exceed the whole-run cap even across a failing operation", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    db.raw
      .prepare(`UPDATE review_publications SET phase = 'superseded', recovery_state = 'done' WHERE id = 'pub-1'`)
      .run();
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    let transport: ReconcileTransport | undefined;
    await reconcileReviewLifecycle(asEnv(db), {
      log: SILENT_LOG,
      now: () => T0,
      reviewer: async (input) => {
        transport = input.transport;
        return { kind: "unavailable", reason: "missing" };
      },
    });
    expect(transport).toBeDefined();

    const realFetch = globalThis.fetch;
    try {
      let dispatched = 0;
      globalThis.fetch = (async () => {
        dispatched += 1;
        throw new Error("transport exploded");
      }) as unknown as typeof fetch;

      // A request that fails AFTER leaving the Worker still consumed the run's
      // allowance: repeated failures must not be able to issue unaccounted
      // requests past the cap.
      let refused = 0;
      for (let i = 0; i < RECONCILE_MAX_REQUESTS + 20; i += 1) {
        try {
          await transport!.fetchImpl("https://api.github.com/x");
        } catch (err) {
          if (err instanceof Error && /budget exhausted/.test(err.message)) refused += 1;
        }
      }
      expect(dispatched).toBe(RECONCILE_MAX_REQUESTS);
      expect(refused).toBe(20);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a request without admission fails BEFORE dispatch and leaves durable work pending", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    db.raw
      .prepare(`UPDATE review_publications SET phase = 'superseded', recovery_state = 'done' WHERE id = 'pub-1'`)
      .run();
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    let transport: ReconcileTransport | undefined;
    await reconcileReviewLifecycle(asEnv(db), {
      log: SILENT_LOG,
      now: () => T0,
      // A healthy pair: the point of this test is the METERING refusal, so the
      // row must stay selectable (not suspended by a credential problem).
      reviewer: async (input) => {
        transport = input.transport;
        return okResolution();
      },
    });

    const realFetch = globalThis.fetch;
    try {
      let dispatched = 0;
      globalThis.fetch = (async () => {
        dispatched += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      for (let i = 0; i < RECONCILE_MAX_REQUESTS; i += 1) {
        await transport!.fetchImpl("https://api.github.com/x");
      }
      dispatched = 0;
      await expect(transport!.fetchImpl("https://api.github.com/x")).rejects.toThrow(/budget exhausted/);
      expect(dispatched).toBe(0); // refused before any dispatch
    } finally {
      globalThis.fetch = realFetch;
    }

    // The pending row was never mutated by the metering refusal: it stays due
    // and selectable, so the work is durable rather than lost.
    expect(threadRow(db, "assoc-1")).toMatchObject({
      resolution_state: "pending",
      attempts: 0,
      lease_until_ms: null,
    });
  });
});

describe("live App identity mismatch → durable suspension (spec §7.6/§7.11.1)", () => {
  test("the production factory suspends the exact pair on a live identity mismatch, mutating nothing", async () => {
    const db = createMigratedTestD1();
    // Real encrypted PEM: the probe must actually sign a JWT and reach the
    // transport, otherwise the mismatch is never classifiable.
    await seedRealApp(db, APP, 1001);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    const realFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string }> = [];
    try {
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET" });
        // The live App answers with a DIFFERENT numeric id than the routed
        // github_app_id — a rotated/substituted credential pair.
        return new Response(JSON.stringify({ id: 9999, slug: "someone-else" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const summary = await reconcileReviewLifecycle(
        { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
        { log: SILENT_LOG, now: () => T0 },
      );

      // Durable suspension of BOTH lanes' rows for the exact pair.
      expect(summary.suspended).toBe(2);
      expect(summary.applied).toBe(0);
      expect(pubRow(db, "pub-1")).toMatchObject({ recovery_state: "suspended", attempts: 0 });
      const thread = threadRow(db, "assoc-1");
      expect(thread.resolution_state).toBe("suspended");
      expect(thread.attempts).toBe(0);
      // The reason names the identity mismatch so an operator can tell it
      // apart from a disabled/deleted App.
      expect(thread.last_error).toContain("live App identity does not match");

      // NO remote mutation: the only request issued was the read-only probe,
      // and no publication send was attempted.
      expect(requests).toEqual([{ url: "https://api.github.com/app", method: "GET" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a MATCHING live identity proceeds (the mismatch suspension is caused by the identity, not a blanket failure)", async () => {
    const db = createMigratedTestD1();
    await seedRealApp(db, APP, 1001);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE, { round: 1 }), 120_000);

    const realFetch = globalThis.fetch;
    const posts: string[] = [];
    try {
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") posts.push(url);
        if (url.endsWith("/app")) {
          return new Response(JSON.stringify({ id: 1001, slug: "acme-inspector" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/access_tokens")) {
          return new Response(
            JSON.stringify({
              token: "ghs_test",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              repositories: [{ id: 1, name: "widgets" }],
              permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
              repository_selection: "selected",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Degraded marker scan (paginated list) — empty page ⇒ create plan.
        if (url.includes("/issues/42/comments")) {
          return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.endsWith("/issues/42/comments")) {
          return new Response(JSON.stringify({ id: 777, body: "posted" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: 777 }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const summary = await reconcileReviewLifecycle(
        { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
        { log: SILENT_LOG, now: () => T0 },
      );

      expect(summary.suspended).toBe(0);
      expect(summary.applied).toBe(1); // the send went through: identity proved
      expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an identity-mismatch suspension is DURABLE: unchanged credentials issue nothing and never re-enable (P67-QC-007)", async () => {
    const db = createMigratedTestD1();
    await seedRealApp(db, APP, 1001);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    seedFindingRow(db, "finding-row-1", "pub-1", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "assoc-1",
      publicationId: "pub-1",
      findingRowId: "finding-row-1",
      scope: SCOPE,
      verified: verifiedFor("assoc-1", "finding-row-1"),
    });

    const realFetch = globalThis.fetch;
    const requests: string[] = [];
    try {
      globalThis.fetch = (async (input: unknown) => {
        requests.push(String(input));
        // The live App keeps answering with a DIFFERENT numeric id — the
        // credentials were never corrected.
        return new Response(JSON.stringify({ id: 9999, slug: "someone-else" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const env = { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY };
      const first = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 });
      expect(first.suspended).toBe(2);
      expect(pubRow(db, "pub-1").recovery_state).toBe("suspended");
      const identityProbesAfterFirst = requests.filter((u) => u.endsWith("/app")).length;
      expect(identityProbesAfterFirst).toBe(1);

      // Second and third passes: the credentials are byte-identical, so the
      // mismatch is still proven — no re-enable, and critically NO further
      // identity probe (no churn, no remote work under unchanged credentials).
      requests.length = 0;
      const second = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 + 60_000 });
      const third = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 + 120_000 });
      expect(second.suspended).toBe(0);
      expect(third.suspended).toBe(0);
      expect(requests).toEqual([]); // zero requests: nothing was probed or mutated
      expect(pubRow(db, "pub-1")).toMatchObject({ recovery_state: "suspended", attempts: 0 });
      expect(threadRow(db, "assoc-1").resolution_state).toBe("suspended");
      expect(threadRow(db, "assoc-1").last_error).toContain("live App identity does not match");

      // The operator corrects the credentials: the envelope changes, so the
      // pair is re-probed and, once the live identity matches, resumes.
      const correctedPem = await testAppPem();
      const corrected = await createSecretbox(TEST_ENCRYPTION_KEY).encryptSecret(
        correctedPem,
        `github_apps.private_key_enc:${APP}`,
      );
      db.raw.prepare(`UPDATE github_apps SET private_key_enc = ? WHERE id = ?`).run(corrected, APP);
      globalThis.fetch = (async (input: unknown) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ id: 1001, slug: "acme-inspector" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const resumed = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 + 180_000 });
      // The proof succeeded, so the pair left suspension — and the identity
      // probe is exactly what authorized it.
      expect(requests.some((u) => u.endsWith("/app"))).toBe(true);
      expect(pubRow(db, "pub-1").recovery_state).not.toBe("suspended");
      expect(resumed.suspended).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a disabled App still resumes by status alone — the durable rule targets identity mismatch, not churn (P67-QC-007)", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP, { status: "disabled" });
    await seedPrepared(db, "pub-a", degradedPayload(SCOPE), 120_000);
    await reconcile(db, { now: () => T0 }); // production routing: disabled → suspended
    expect(pubRow(db, "pub-a").recovery_state).toBe("suspended");
    expect(pubRow(db, "pub-a").last_error).toContain("suspend:disabled:");

    db.raw.prepare(`UPDATE github_apps SET status = 'active' WHERE id = ?`).run(APP);
    // The status-only resume still applies: no credential identity question
    // was ever at issue for a disabled App.
    await reconcile(db, { now: () => T0 + 1_000, reviewer: okReviewer() });
    expect(pubRow(db, "pub-a")).toMatchObject({ recovery_state: "pending", phase: "prepared" });
  });
});

describe("definitive pre-send rejection → durable failed phase (spec §7.7, P67-QC-010)", () => {
  test("M8 records a definitive rejection as failed, never unknown — and never re-sends it", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE, { round: 2 }), 120_000);

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer({
        planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "update", commentId: 7, round: 2 }),
        // The worker throws exactly what the commenter throws for a definitive
        // pre-send refusal (a foreign bot marker appeared after the plan).
        postPreparedDegraded: async () => {
          throw new PreparedSendRejected(
            "a bot degraded marker (comment 9) appeared after the pre-staging plan — refusing to create a second publication (spec §7.7)",
          );
        },
      }),
    });

    // Truthful durable state: `failed` (a request never left the Worker),
    // NOT `unknown` (which is reserved for post-attempt ambiguity).
    expect(pubRow(db, "pub-1")).toMatchObject({
      phase: "failed",
      attempts: 1,
      lease_until_ms: null,
    });
    expect(pubRow(db, "pub-1").last_error).toContain("refusing to create a second publication");
    expect(summary.errors).toBe(1);
    expect(summary.unknown).toBe(0); // the misclassification this fixes

    // Payload and digest are retained for operator inspection.
    const payload = db.raw
      .query(`SELECT payload_json, proof_json FROM review_publications WHERE id = 'pub-1'`)
      .get() as { payload_json: string; proof_json: string | null };
    expect(JSON.parse(payload.payload_json).body).toBe("degraded body");
    expect(payload.proof_json).toBeNull(); // no proof claim for a not-sent publication

    // Recovery never re-sends a failed row: a later pass examines it and
    // leaves it exactly as it is.
    let reSendAttempted = false;
    await reconcile(db, {
      now: () => T0 + 600_000,
      reviewer: okReviewer({
        planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "update", commentId: 7, round: 2 }),
        postPreparedDegraded: async () => {
          reSendAttempted = true;
          return { posted: true, commentId: 777 };
        },
      }),
    });
    expect(reSendAttempted).toBe(false);
    expect(pubRow(db, "pub-1").phase).toBe("failed");
  });

  test("an uncertain post-attempt send stays unknown, not failed (the distinction is real, not cosmetic)", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE, { round: 2 }), 120_000);

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer({
        planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "update", commentId: 7, round: 2 }),
        // A transport throw at the send is post-attempt uncertainty (§7.9).
        postPreparedDegraded: async () => {
          throw new Error("socket hang up after the request left the Worker");
        },
      }),
    });

    expect(pubRow(db, "pub-1").phase).toBe("unknown");
    expect(summary.unknown).toBe(1);
    expect(summary.errors).toBe(1);
  });
});

describe("budget refusal inside a claimed send (spec §7.11.1, P67-QC-018)", () => {
  /**
   * Issue `count` requests through the REAL run transport with the global
   * fetch neutralized. Unlike `meterRequests`, this deliberately does NOT
   * swallow the refusal: the transport's own throw propagates to the caller,
   * which is exactly how the §7.5 surface experiences an exhausted allowance.
   */
  async function spendThrough(transport: ReconcileTransport, count: number): Promise<void> {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
      for (let i = 0; i < count; i += 1) {
        await transport.fetchImpl(`https://api.github.com/x?n=${i}`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("a pre-dispatch refusal releases the claim: row back to due prepared, no attempt spent, re-sendable", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);

    // The publication lane's own admission passes (its estimate fits), so the
    // row IS claimed; the allowance then runs out INSIDE the send — the
    // reachable arithmetic case this check pins.
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async (input) => {
        const runTransport = input.transport!;
        return okResolution({
          planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "create", round: 1 }),
          postPreparedDegraded: async () => {
            await spendThrough(runTransport, RECONCILE_MAX_REQUESTS + 1);
            return { posted: true, commentId: 777 };
          },
        });
      },
    });

    // The publication was NEVER dispatched, so its durable state must stay
    // sendable: `prepared` — not the post-attempt `unknown` that read-only
    // discovery would then own forever — due, unleased, with the claim's
    // attempt returned.
    expect(pubRow(db, "pub-1")).toMatchObject({
      phase: "prepared",
      recovery_state: "pending",
      attempts: 0,
      lease_until_ms: null,
    });
    expect(summary.unknown).toBe(0);

    // "No attempt spent" is what keeps the row immediately selectable: M8
    // re-selects it on the very next pass with its full attempt budget.
    const dueAgain = await listPublicationRecovery(db, T0, RECONCILE_SELECT_LIMIT);
    expect(dueAgain.map((r) => r.id)).toContain("pub-1");

    // And the next run really does send it, proving the refusal deferred the
    // publication rather than abandoning it.
    let sent = 0;
    await reconcile(db, {
      now: () => T0 + 1_000,
      reviewer: okReviewer({
        planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "create", round: 1 }),
        postPreparedDegraded: async () => {
          sent += 1;
          return { posted: true, commentId: 777 };
        },
      }),
    });
    expect(sent).toBe(1);
  });

  test("the refusal is recognized through the cause chain a real transport rejection carries", async () => {
    // Octokit does not let a custom transport error reach the lane intact:
    // `@octokit/request`'s fetchWrapper re-wraps every non-abort rejection in
    // a RequestError with the original parked on `cause`. If classification
    // only unwrapped a bare throw, a real pre-dispatch refusal would read as
    // post-attempt uncertainty and strand an unsent publication. This
    // reproduces that exact wrap around the REAL refusal type.
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async (input) => {
        const runTransport = input.transport!;
        return okResolution({
          planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "create", round: 1 }),
          postPreparedDegraded: async () => {
            try {
              await spendThrough(runTransport, RECONCILE_MAX_REQUESTS + 1);
            } catch (refusal) {
              throw new Error("Request failed", { cause: refusal });
            }
            return { posted: true, commentId: 777 };
          },
        });
      },
    });

    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "prepared", attempts: 0, lease_until_ms: null });
    expect(summary.unknown).toBe(0);
  });

  test("a post-attempt failure at the same boundary still becomes unknown (the distinction is not a blanket excuse)", async () => {
    // Same lane, same claim, same throw site — but the error is not the
    // budget refusal, so the send MAY have landed and `unknown` remains the
    // honest phase. This is the guard against over-broad classification.
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer({
        planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "create", round: 1 }),
        postPreparedDegraded: async () => {
          // Mentions the budget, but is NOT the typed refusal: identity, never
          // message text, decides.
          throw new Error("request failed while reporting: recovery request budget exhausted");
        },
      }),
    });

    expect(pubRow(db, "pub-1").phase).toBe("unknown");
    expect(summary.unknown).toBe(1);
  });
});

describe("uncertain-publication discovery ownership (spec §7.5/§7.7, P67-QC-011)", () => {
  test("discovery matches ONLY the exact authenticated bot login, never a generic [bot] suffix", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    // Force the row into the uncertain state discovery owns.
    db.raw.prepare(`UPDATE review_publications SET phase = 'sending', attempts = 1 WHERE id = 'pub-1'`).run();

    const body = "degraded body";
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer(
        {
          listDiscussion: async () => ({
            items: [
              {
                source: "issue",
                associationId: null,
                id: "51",
                // A DIFFERENT App's bot, with a byte-identical body — the
                // generic `[bot]` suffix would have accepted this.
                author: "other-app[bot]",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                body,
              },
            ],
            issueCoverage: "complete",
            issueDigest: "issue-digest",
            capturedMs: T0,
            threads: [],
          }),
        },
        { botLogin: "acme-inspector[bot]" },
      ),
    });

    // A foreign App's identical body is NOT proof: the row stays unknown.
    expect(pubRow(db, "pub-1").phase).toBe("unknown");
    expect(summary.applied).toBe(0);
    const unproven = db.raw
      .query(`SELECT proof_json FROM review_publications WHERE id = 'pub-1'`)
      .get() as { proof_json: string | null };
    expect(unproven.proof_json).toBeNull();

    // The SAME body by OUR authenticated login is proof and applies.
    await reconcile(db, {
      now: () => T0 + 600_000,
      reviewer: okReviewer(
        {
          listDiscussion: async () => ({
            items: [
              {
                source: "issue",
                associationId: null,
                id: "51",
                author: "acme-inspector[bot]",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                body,
              },
            ],
            issueCoverage: "complete",
            issueDigest: "issue-digest",
            capturedMs: T0,
            threads: [],
          }),
        },
        { botLogin: "acme-inspector[bot]" },
      ),
    });
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied", recovery_state: "done" });
  });
});
