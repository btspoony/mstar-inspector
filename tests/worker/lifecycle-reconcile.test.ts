/** note: M8 recovery reconciler tests (spec review-lifecycle
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
import { RECONCILE_DEFAULTS, RECONCILE_LIMITS, RECONCILE_REQUEST_ESTIMATES } from "../../src/contracts/reconcile-settings";
import { describe, expect, test } from "bun:test";
import type { MstarReviewFinding, MstarReviewV1 } from "@mstar-harness/engine";
import { idemKey } from "../../src/contracts/idem";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import {
  applyPublishedLifecycle,
  claimPublication,
  captureLineComments,
  PUBLICATION_LEASE_MS,
  listPublicationRecovery,
  listLineBatchRecovery,
  listResolutionRecovery,
  recordPublicationProof,
  readLineBatchState,
  recordLineDiscoveryFailure,
  resetLineDiscoveryFailures,
  findPublicationJournal,
  PUBLICATION_PROOF_WAIT_PHASES,
  stagePublication,
  suspendPublicationRecovery,
  suspendResolutionRecovery,
  type LifecycleRound,
  type LineIntent,
  type PublicationPayload,
  type PublicationProof,
  type VerifiedResolution,
} from "../../src/store/finding-lifecycle";
import { CHECK_LEASE_MS, claimAttempt, linkCheckPublication, releaseCheckClaim } from "../../src/store/review-checks";
import type { D1Like } from "../../src/store/types";
import {
  buildLineCommentBody,
  createReviewThreads,
  fetchThreadConversation,
  issueDigestOf,
  sha256Hex,
  threadDigestOf,
  type GraphqlOctokit,
} from "../../src/pipeline/review-threads";
import { listDiscussionWithOctokit } from "../../src/pipeline/discussion-context";
import {
  reconcileReviewLifecycle,
  type LifecycleReconcileDeps,
  type ReconcileReviewer,
  type ReconcileTransport,
  type ReviewerResolution,
} from "../../src/worker/lifecycle-reconcile";
import type { UpsertPlan } from "../../src/pipeline/comment";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { ScheduledEnv } from "../../src/worker/env";
import { createReviewCommenter, PreparedSendRejected } from "../../src/pipeline/comment";
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";
import { readAttemptHandoff, reserveAttemptHandoff } from "../../src/store/review-route-store";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import { testAppPem } from "../helpers/rsa-key";
import { RecoveryBudgetRefused } from "../../src/contracts/recovery-budget";

const APP = "11111111-2222-3333-4444-555555555555";
const APP_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const APP_C = "cccccccc-1111-2222-3333-444444444444";
const SCOPE: Scope = { appId: APP, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SCOPE_B: Scope = { appId: APP_B, installationId: 456, owner: "other", repo: "gadgets", prNumber: 7 };
const SCOPE_C: Scope = { appId: APP_C, installationId: 789, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_000_000;

/** invariant: Base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const SILENT_LOG = { warn: () => {}, info: () => {} };

/** invariant: The cron's queue binding (comment-claim outbox): these suites re-send nothing. */
const NOOP_QUEUE = { send: async () => {} } as unknown as ScheduledEnv["REVIEW_QUEUE"];

function asEnv(db: TestD1): ScheduledEnv {
  return { DB: db as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE };
}

async function reconcile(db: TestD1, deps: Omit<LifecycleReconcileDeps, "log"> = {}): Promise<
  Awaited<ReturnType<typeof reconcileReviewLifecycle>>
> {
  return reconcileReviewLifecycle(asEnv(db), { ...deps, log: SILENT_LOG });
}

// note: ---------------------------------------------------------------------------
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
      `INSERT INTO review_bots
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, review_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc-pem', 'enc-secret', 'tester', ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, `reconcile-${id}`, githubAppId, `reconcile-${id}`, status, deletedAt, reviewEnabled);
  seedTarget(db, id, { id: `target-${id}` });
  if (install) {
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
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
    targetId: `target-${scope.appId}`,
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

/**
 * note: The default admitted attempt: a launch row with NO frozen Check identity —
 * the lane whose authority is the journal claim (an App without Checks). The
 * Check-backed case seeds its own row with the frozen pair.
 */
const DEFAULT_ADMITTED_ATTEMPT = "attempt-no-check-0001";

function reviewPayload(scope: Scope, overrides: Partial<PublicationPayload> = {}): PublicationPayload {
  return {
    version: 1,
    scope,
    admittedAttemptId: DEFAULT_ADMITTED_ATTEMPT,
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
    admittedAttemptId: DEFAULT_ADMITTED_ATTEMPT,
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

/** note: Stage → claim → record proof → expire the lease (the crashed-window shape). */
async function seedConfirmedCrashed(db: TestD1, id: string, pay: PublicationPayload, nowMs = T0): Promise<void> {
  await stagePublication(db, { id, payload: pay, nowMs });
  const lease = await claimPublication(db, id, "consumer", nowMs + 1, "prepared");
  if (lease === null) throw new Error("test setup: claim failed");
  const recorded = await recordPublicationProof(db, id, lease, proofOf(id, pay, nowMs + 2));
  if (!recorded) throw new Error("test setup: proof recording failed");
  db.raw.prepare(`UPDATE review_publications SET lease_until_ms = ? WHERE id = ?`).run(nowMs - 1, id);
}

/** invariant: Seed a prepared (never sent) publication row staged `ageMs` ago. */
async function seedPrepared(db: TestD1, id: string, pay: PublicationPayload, ageMs: number): Promise<void> {
  await stagePublication(db, { id, payload: pay, nowMs: T0 - ageMs });
  // note: The payload's admitted attempt must be readable by every later lane: a
  // no-Check binding is a launch row whose pair was never frozen.
  if (pay.admittedAttemptId === DEFAULT_ADMITTED_ATTEMPT) {
    db.raw
      .prepare(`INSERT OR IGNORE INTO review_launches (attempt_id, state, claimed_at_ms) VALUES (?, 'provisioned', ?)`)
      .run(DEFAULT_ADMITTED_ATTEMPT, T0 - ageMs);
  }
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
      `INSERT INTO review_bots
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, review_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'enc-secret', 'tester', 'active', NULL, 1, datetime('now'), datetime('now'))`,
    )
    .run(id, `reconcile-${id}`, githubAppId, `reconcile-${id}`, encrypted);
  db.raw
    .prepare(
      `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
       VALUES (?, ?, ?, 'acme', datetime('now'))`,
    )
    .run(`inst-${id}-${SCOPE.installationId}`, id, SCOPE.installationId);
  seedTarget(db, id, { id: `target-${id}` });
}

function seedFindingRow(db: TestD1, id: string, publicationId: string, scope: Scope, state = "addressed"): void {
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
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
         (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
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

/** note: A resolvable "ok" reviewer resolution: the default surface throws for every
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
      postLineComments: async () => {
        throw new Error("postLineComments not expected");
      },
      recoverLineComments: async () => {
        throw new Error("recoverLineComments not expected");
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

/** note: Reviewer factory whose routing is recorded; every GitHub call throws
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

/** note: Issue `count` REAL requests through the run transport with the global fetch
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
        break; // note: budget refusal is a legitimate outcome; report what was sent
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

// note: ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    expect(reviewerCalls).toBe(0); // invariant: local apply never touches GitHub
    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    const findings = db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number };
    expect(reviews.n).toBe(1);
    expect(findings.n).toBe(1);
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied", recovery_state: "done" });
  });

  test("the apply that completes a recovered publication also settles its attempt", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    const attemptId = "attempt-recovered-apply";
    // note: The consumer staged the publication and crashed before the apply; the
    // staged payload names the attempt that must be measured.
    await seedConfirmedCrashed(db, "pub-settled", reviewPayload(SCOPE, { attemptId }));
    const payload: ReviewJobPayload = {
      installation_id: SCOPE.installationId,
      owner: SCOPE.owner,
      repo: SCOPE.repo,
      pr_number: SCOPE.prNumber,
      head_sha: SHA,
      action: "opened",
      triggered_by: "pull_request",
      botRef: { appId: SCOPE.appId },
      targetId: `target-${SCOPE.appId}`,
    };
    await reserveAttemptHandoff(db as never, {
      deliveryKey: "delivery-recovered-apply",
      attemptId,
      payload,
      nowMs: T0,
      enqueuedMs: T0 - 2_000,
      deadlineMs: T0 + 600_000,
    });

    const summary = await reconcile(db, { now: () => T0 + 1_000 });

    expect(summary.applied).toBe(1);
    // note: The applied mark and the attempt's end landed together: a recovered
    // attempt is measurable by the operator report.
    const handoff = await readAttemptHandoff(db as never, "delivery-recovered-apply");
    expect(handoff?.settledMs).toEqual(expect.any(Number));
    expect(handoff?.settledEffects).toContain("publication");
  });

  test("a recovery apply records the publication but leaves an open Check's attempt unmeasured", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    const attemptId = "attempt-recovered-open-check";
    // note: The attempt froze an OPEN Check on its launch row.
    const claimed = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 1001,
      headSha: SHA,
      triggeredBy: "pull_request",
      action: "opened",
      holder: `consumer:${attemptId}`,
      nowMs: T0,
      executionDeadlineMs: T0 + 600_000,
    });
    if (claimed.kind !== "claimed") throw new Error(`test setup: claim failed: ${claimed.kind}`);
    const check = db.raw
      .prepare("SELECT attempt_key, generation FROM review_checks WHERE id = ?")
      .get(claimed.attempt.identity.attemptId) as { attempt_key: string; generation: number };
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome,
            attempt_key, attempt_generation)
         VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted', ?, ?)`,
      )
      .run(attemptId, T0, T0 + 1, T0 + 2, check.attempt_key, check.generation);
    await seedConfirmedCrashed(db, "pub-open-check", reviewPayload(SCOPE, { attemptId }));
    const payload: ReviewJobPayload = {
      installation_id: SCOPE.installationId,
      owner: SCOPE.owner,
      repo: SCOPE.repo,
      pr_number: SCOPE.prNumber,
      head_sha: SHA,
      action: "opened",
      triggered_by: "pull_request",
      botRef: { appId: SCOPE.appId },
      targetId: `target-${SCOPE.appId}`,
    };
    await reserveAttemptHandoff(db as never, {
      deliveryKey: "delivery-open-check",
      attemptId,
      payload,
      nowMs: T0,
      enqueuedMs: T0 - 2_000,
      deadlineMs: T0 + 600_000,
    });

    const summary = await reconcile(db, { now: () => T0 + 1_000 });

    expect(summary.applied).toBe(1);
    // note: The publication effect is recorded, but the Check lane is still open, so
    // the attempt is not settled: the obligation model refuses to certify it.
    const handoff = await readAttemptHandoff(db as never, "delivery-open-check");
    expect(handoff?.settledMs).toBeNull();
    expect(handoff?.settledEffects).toContain("publication");
  });

  test("re-apply is idempotent; a crash between store.put and the applied mark re-runs the artifact as a no-op", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedConfirmedCrashed(db, "pub-1", reviewPayload(SCOPE));

    const first = await reconcile(db, { now: () => T0 + 1_000, reviewer: okReviewer() });
    expect(first.applied).toBe(1);

    // note: Simulate a crash between store.put and the applied mark: reset the
    // applied row to confirmed/pending, then reconcile again. The artifact is
    // composed on EVERY attempt (both ids derive from the apply key), so its
    // review INSERT runs and writes nothing — `ON CONFLICT DO NOTHING` — and
    // no review/finding/round may duplicate.
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
    // note: The statement is attempted and is an idempotent no-op (the row exists).
    expect(inserts).toHaveLength(1);
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
        planReviewUpsert: async () => ({ action: "update", commentId: 9, round: 2 }), // note: PR shows round 1 already published by a NEWER publication
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
        planReviewUpsert: async () => ({ action: "update", commentId: 9, round: 2 }), // note: current parsed round 1 < prepared round 2
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

    // safety: Pair-level credential health is checked (routing precedes the phase
    // work), but the age gate skips the send — no attempt, still due.
    expect(summary.examined).toBe(1);
    expect(routed).toBe(1);
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "prepared", recovery_state: "pending", attempts: 0 });
  });
});

describe("§7.9a condition 1 — a Check-backed send and its recovery share one action lease", () => {
  const ADMITTED_ATTEMPT = "attempt-two-lane-0001";

  /**
   * note: A prepared publication admitted under a Check attempt, with the launch
   * row's FROZEN `(attempt_key, generation)` pair and a real encrypted PEM.
   * Nothing links the publication by recency: the binding is the payload's
   * admitted attempt plus that row.
   */
  async function seedCheckAdmittedPrepared(db: TestD1, id: string): Promise<string> {
    await seedRealApp(db, APP, 1001);
    await seedPrepared(db, id, reviewPayload(SCOPE, { round: 2, admittedAttemptId: ADMITTED_ATTEMPT }), 120_000);
    const claimed = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 1001,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      holder: "run-a",
      nowMs: T0,
      executionDeadlineMs: T0 + CHECK_LEASE_MS,
    });
    if (claimed.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${claimed.kind}`);
    const attemptId = claimed.attempt.identity.attemptId;
    const identity = db.raw
      .prepare(`SELECT attempt_key, generation FROM review_checks WHERE id = ?`)
      .get(attemptId) as { attempt_key: string; generation: number };
    db.raw
      .prepare(
        `INSERT INTO review_launches (attempt_id, state, claimed_at_ms, attempt_key, attempt_generation)
         VALUES (?, 'provisioned', ?, ?, ?)`,
      )
      .run(ADMITTED_ATTEMPT, T0, identity.attempt_key, identity.generation);
    // note: A LATER generation also linked to the same publication: resolving by
    // recency would take ITS action lease instead of the admitted one. Close
    // the admitted row so the same key's next generation may open.
    expect(await releaseCheckClaim(db as never, attemptId, claimed.lease, T0)).toBe(true);
    db.raw.prepare(`UPDATE review_checks SET terminal_ms = ? WHERE id = ?`).run(T0, attemptId);
    const decoy = await claimAttempt(db as never, {
      scope: SCOPE,
      githubAppId: 1001,
      headSha: SHA,
      triggeredBy: "octocat",
      action: "review",
      holder: "run-b",
      nowMs: T0,
      executionDeadlineMs: T0 + CHECK_LEASE_MS,
    });
    if (decoy.kind !== "claimed") throw new Error(`fixture: expected claimed, got ${decoy.kind}`);
    expect(await linkCheckPublication(db as never, decoy.attempt.identity.attemptId, decoy.lease, id, T0)).toBe(true);
    return attemptId;
  }

  test("foreground mid-send and recovery on the same admitted action produce exactly one mutation", async () => {
    const db = createMigratedTestD1();
    const attemptId = await seedCheckAdmittedPrepared(db, "pub-lease");
    const clock = { now: T0 };
    const fg = { posts: 0 };
    const bg = { posts: 0 };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const token = (name: string) =>
      json(200, {
        token: name,
        expires_at: new Date(T0 + 3_600_000).toISOString(),
        repositories: [{ id: 1, name: "widgets" }],
        permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
        repository_selection: "selected",
      });

    // note: The recovery lane is STARTED FIRST and paused inside its plan: it has
    // already selected the publication as `prepared`, exactly the window in
    // which the foreground may take it.
    const planGate = Promise.withResolvers<void>();
    const planReached = Promise.withResolvers<void>();
    let planSuspensionUsed = false;
    const backgroundFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app")) return json(200, { id: 1001, slug: "acme-inspector" });
      if (url.endsWith("/access_tokens")) return token("ghs_bg");
      if (url.includes("/issues/42/comments")) {
        if (init?.method === "POST") {
          bg.posts += 1;
          return json(201, { id: 9100, body: "second" });
        }
        if (!planSuspensionUsed) {
          planSuspensionUsed = true;
          planReached.resolve();
          await planGate.promise;
        }
        return json(200, []);
      }
      return json(200, {});
    }) as unknown as typeof fetch;

    const realFetch = globalThis.fetch;
    globalThis.fetch = backgroundFetch;
    const env = { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, REVIEW_QUEUE: NOOP_QUEUE };
    // note: Recovery selects the row as `prepared` and suspends in its plan.
    const running = reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => clock.now });
    await planReached.promise;
    // note: The foreground's journal claim was taken one window ago and has lapsed
    // (the row is now `sending`); its ACTION lease is taken at T0 and is live
    // for the whole send.
    const journalLease = await claimPublication(db as never, "pub-lease", "consumer:fg", T0 - PUBLICATION_LEASE_MS - 1, "prepared");
    if (journalLease === null) throw new Error("fixture: the foreground journal claim was refused");
    clock.now = T0;

    const foregroundFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return token("ghs_fg");
      if (url.includes("/issues/42/comments")) {
        if (init?.method === "POST") {
          fg.posts += 1;
          return json(201, { id: 9001, body: "posted" });
        }
        // note: Mid-send: let the paused recovery finish against this exact
        // publication while the action lease is still held here.
        planGate.resolve();
        await running;
        return json(200, []);
      }
      return json(200, {});
    }) as unknown as typeof fetch;

    try {
      const commenter = createReviewCommenter(
        { APP_ID: "1001", PRIVATE_KEY: await testAppPem() },
        { db, nowMs: () => clock.now, fetchImpl: foregroundFetch },
      );
      const sent = await commenter.postPreparedReview({
        installationId: 123,
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: SHA,
        round: 2,
        targetCommentId: null,
        body: "review body",
        publicationId: "pub-lease",
        attemptId,
        journalClaim: journalLease,
      });

      expect(sent.commentId).toBe(9001);
      // note: ONE mutation for the one eligible action: the foreground's create. The
      // recovery had resumed `prepared`; the row had left it, so the claim
      // re-checked inside the dispatching statement refused and nothing was
      // sent — the row still carries the foreground's claim.
      expect(fg.posts).toBe(1);
      expect(bg.posts).toBe(0);
      expect(pubRow(db, "pub-lease")).toMatchObject({ phase: "sending", attempts: 1, last_error: null });
    } finally {
      globalThis.fetch = realFetch;
      await running;
    }
  });

  test("the no-Check lane: foreground and recovery contend on the SAME journal claim — one mutation", async () => {
    const db = createMigratedTestD1();
    await seedRealApp(db, APP, 1001);
    // note: The payload's admitted attempt is the launch row with NO frozen Check
    // identity: this is the lane whose authority is the journal claim.
    await seedPrepared(db, "pub-journal", reviewPayload(SCOPE, { round: 2 }), 120_000);
    const clock = { now: T0 };
    const fg = { posts: 0 };
    const bg = { posts: 0 };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const token = (name: string) =>
      json(200, {
        token: name,
        expires_at: new Date(T0 + 3_600_000).toISOString(),
        repositories: [{ id: 1, name: "widgets" }],
        permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
        repository_selection: "selected",
      });

    const planGate = Promise.withResolvers<void>();
    const planReached = Promise.withResolvers<void>();
    let planSuspensionUsed = false;
    const backgroundFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app")) return json(200, { id: 1001, slug: "acme-inspector" });
      if (url.endsWith("/access_tokens")) return token("ghs_bg");
      if (url.includes("/issues/42/comments")) {
        if (init?.method === "POST") {
          bg.posts += 1;
          return json(201, { id: 9100, body: "second" });
        }
        if (!planSuspensionUsed) {
          planSuspensionUsed = true;
          planReached.resolve();
          await planGate.promise;
        }
        return json(200, []);
      }
      return json(200, {});
    }) as unknown as typeof fetch;

    const realFetch = globalThis.fetch;
    globalThis.fetch = backgroundFetch;
    const env = { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, REVIEW_QUEUE: NOOP_QUEUE };
    const running = reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => clock.now });

    // note: The recovery has selected the row as `prepared` and is suspended in its
    // plan. The foreground now takes THE claim for this publication.
    await planReached.promise;
    const journalLease = await claimPublication(db as never, "pub-journal", "consumer:fg", T0, "prepared");
    if (journalLease === null) throw new Error("fixture: the foreground journal claim was refused");
    clock.now = T0;

    const foregroundFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return token("ghs_fg");
      if (url.includes("/issues/42/comments")) {
        if (init?.method === "POST") {
          fg.posts += 1;
          return json(201, { id: 9001, body: "posted" });
        }
        planGate.resolve();
        await running;
        return json(200, []);
      }
      return json(200, {});
    }) as unknown as typeof fetch;

    try {
      const commenter = createReviewCommenter(
        { APP_ID: "1001", PRIVATE_KEY: await testAppPem() },
        { db, nowMs: () => clock.now, fetchImpl: foregroundFetch },
      );
      const sent = await commenter.postPreparedReview({
        installationId: 123,
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: SHA,
        round: 2,
        targetCommentId: null,
        body: "review body",
        publicationId: "pub-journal",
        journalClaim: journalLease,
      });

      expect(sent.commentId).toBe(9001);
      // note: The recovery's claim on the same row was refused: one mutation, and the
      // row still carries the foreground's claim (holder + epoch), untouched.
      expect(fg.posts).toBe(1);
      expect(bg.posts).toBe(0);
      const row = db.raw
        .prepare(`SELECT holder, lease_epoch, phase FROM review_publications WHERE id = ?`)
        .get("pub-journal") as { holder: string | null; lease_epoch: number; phase: string };
      expect(row.holder).toBe(journalLease.holder);
      expect(row.lease_epoch).toBe(journalLease.epoch);
      expect(row.phase).toBe("sending");
    } finally {
      globalThis.fetch = realFetch;
      await running;
    }
  });
});

describe("§7.9a condition 1 — a recovery acts only on the state it resumed", () => {
  test("a row that left `prepared` while recovery was planning is refused inside the claim", async () => {
    const db = createMigratedTestD1();
    await seedRealApp(db, APP, 1001);
    await seedPrepared(db, "pub-stale", reviewPayload(SCOPE, { round: 2 }), 120_000);
    const clock = { now: T0 };
    const bg = { posts: 0 };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    const planGate = Promise.withResolvers<void>();
    const planReached = Promise.withResolvers<void>();
    let planSuspensionUsed = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app")) return json(200, { id: 1001, slug: "acme-inspector" });
      if (url.endsWith("/access_tokens")) {
        return json(200, {
          token: "ghs_stale",
          expires_at: new Date(T0 + 3_600_000).toISOString(),
          repositories: [{ id: 1, name: "widgets" }],
          permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
          repository_selection: "selected",
        });
      }
      if (url.includes("/issues/42/comments")) {
        if (init?.method === "POST") {
          bg.posts += 1;
          return json(201, { id: 9300 });
        }
        if (!planSuspensionUsed) {
          planSuspensionUsed = true;
          planReached.resolve();
          await planGate.promise;
        }
        return json(200, []);
      }
      return json(200, {});
    }) as unknown as typeof fetch;

    try {
      const running = reconcileReviewLifecycle(
        { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, REVIEW_QUEUE: NOOP_QUEUE },
        { log: SILENT_LOG, now: () => clock.now },
      );
      // note: The recovery selected the row as `prepared` and is suspended in its
      // plan. Another lane now takes it and its lease lapses (a crashed send).
      await planReached.promise;
      expect(
        await claimPublication(db as never, "pub-stale", "consumer:crashed", T0, "prepared"),
      ).not.toBeNull();
      db.raw.prepare(`UPDATE review_publications SET lease_until_ms = ? WHERE id = ?`).run(T0 - 1, "pub-stale");
      clock.now = T0;
      planGate.resolve();
      await running;

      // note: The claim re-checked the phase inside the dispatching statement: the
      // row is `sending` now, not the `prepared` this lane resumed for.
      expect(bg.posts).toBe(0);
      const row = db.raw
        .prepare(`SELECT phase, holder FROM review_publications WHERE id = ?`)
        .get("pub-stale") as { phase: string; holder: string | null };
      expect(row.phase).toBe("sending");
      expect(row.holder).toBe("consumer:crashed");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("§7.9a condition 2 — a pre-intent line batch is discovery-only", () => {
  test("a row staged before dispatch intents existed is never sent by the recovery lane", async () => {
    const db = createMigratedTestD1();
    await seedRealApp(db, APP, 1001);
    const intent: LineIntent = {
      associationId: "assoc-old",
      findingRowId: "finding-old",
      publicationId: "pub-old",
      scope: SCOPE,
      originalSha: SHA,
      round: 1,
      path: "src/a.ts",
      line: 10,
      body: "fix",
      bodySha256: "a".repeat(64),
    };
    await seedPrepared(db, "pub-old", reviewPayload(SCOPE, { lineIntents: [intent] }), 120_000);
    // note: The shape a pre-migration applied row has: work pending, intent UNKNOWN.
    db.raw
      .prepare(`UPDATE review_publications SET phase = 'applied', applied_ms = ?, recovery_state = 'done', line_dispatch_ms = -1 WHERE id = ?`)
      .run(T0, "pub-old");
    seedFindingRow(db, "finding-old", "pub-old", SCOPE);
    db.raw
      .prepare(
        `INSERT INTO review_threads
           (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
            original_sha, round, intent_json, resolution_state, verified_json, attempts, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', 'pending', NULL, 0, ?, ?)`,
      )
      .run("assoc-old", "finding-old", "pub-old", SCOPE.appId, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, T0, T0);

    const seen = { creates: 0, reviews: 0 };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app")) return json(200, { id: 1001, slug: "acme-inspector" });
      if (url.endsWith("/access_tokens")) {
        return json(200, {
          token: "ghs_old",
          expires_at: new Date(T0 + 3_600_000).toISOString(),
          repositories: [{ id: 1, name: "widgets" }],
          permissions: { contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
          repository_selection: "selected",
        });
      }
      if (url.includes("/pulls/") && url.includes("/reviews")) {
        if (init?.method === "POST") {
          seen.creates += 1;
          return json(201, { id: 9200 });
        }
        seen.reviews += 1;
        return json(200, []);
      }
      return json(200, {});
    }) as unknown as typeof fetch;

    try {
      await reconcileReviewLifecycle(
        { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, REVIEW_QUEUE: NOOP_QUEUE },
        { log: SILENT_LOG, now: () => T0 },
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    // note: The sentinel is intent-UNKNOWN: the batch may already be sent, so the
    // lane may only read it back (and capture nothing here).
    expect(seen.creates).toBe(0);
    expect(seen.reviews).toBeGreaterThanOrEqual(1);
    const row = db.raw
      .prepare(`SELECT phase, line_dispatch_ms FROM review_publications WHERE id = ?`)
      .get("pub-old") as { phase: string; line_dispatch_ms: number | null };
    expect(row.phase).toBe("applied");
    expect(row.line_dispatch_ms).toBe(-1);
  });
});

describe("line-batch discovery bound — an unmatchable batch stops starving newer ones", () => {
  type BatchColumns = {
    line_dispatch_ms: number | null;
    line_discovery_attempts: number;
    line_unresolvable_ms: number | null;
    line_unresolvable_reason: string | null;
  };

  function batchColumns(db: TestD1, id: string): BatchColumns {
    return db.raw
      .prepare(
        `SELECT line_dispatch_ms, line_discovery_attempts, line_unresolvable_ms, line_unresolvable_reason
           FROM review_publications WHERE id = ?`,
      )
      .get(id) as BatchColumns;
  }

  /** An applied publication whose line batch is still uncaptured. */
  async function seedAppliedLineBatch(
    db: TestD1,
    input: {
      id: string;
      appliedAgeMs: number;
      dispatched: boolean;
      discoveryAttempts?: number;
      headSha?: string;
      intentCount?: number;
    },
  ): Promise<void> {
    // The journal is unique per (scope, head, kind): two live batches in one
    // test need distinct heads or the second staging replays the first row.
    const headSha = input.headSha ?? SHA;
    const intents: LineIntent[] = Array.from({ length: input.intentCount ?? 1 }, (_, i) => ({
      associationId: `assoc-${input.id}${i === 0 ? "" : `-${i}`}`,
      findingRowId: `finding-${input.id}`,
      publicationId: input.id,
      scope: SCOPE,
      originalSha: headSha,
      round: 1,
      path: "src/a.ts",
      line: 10,
      body: "fix",
      bodySha256: "a".repeat(64),
    }));
    await seedPrepared(db, input.id, reviewPayload(SCOPE, { headSha, lineIntents: intents }), input.appliedAgeMs + 1);
    // A dispatched batch is discovery-only; an undispatched one is still sendable.
    db.raw
      .prepare(
        `UPDATE review_publications
            SET phase = 'applied', applied_ms = ?, recovery_state = 'done',
                line_dispatch_ms = ?, line_discovery_attempts = ?
          WHERE id = ?`,
      )
      .run(T0 - input.appliedAgeMs, input.dispatched ? T0 - 5_000 : null, input.discoveryAttempts ?? 0, input.id);
    seedFindingRow(db, `finding-${input.id}`, input.id, SCOPE);
    for (const intent of intents) {
      seedThreadRow(db, {
        id: intent.associationId,
        publicationId: input.id,
        findingRowId: intent.findingRowId,
        scope: SCOPE,
        verified: verifiedFor(intent.associationId, intent.findingRowId),
      });
    }
  }

  function recordingLog() {
    const warns: { event: string; detail: string }[] = [];
    return { warns, log: { warn: (fields: { event: string; detail: string }) => warns.push(fields), info: () => {} } };
  }

  test("an older unmatchable batch is reported once and a fresh batch is still selected", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    // The stuck batch is older AND one pass short of the bound: this pass is the
    // one that must make it leave the eligible set.
    await seedAppliedLineBatch(db, {
      id: "pub-stuck",
      appliedAgeMs: 200_000,
      dispatched: true,
      discoveryAttempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts - 1,
    });
    await seedAppliedLineBatch(db, { id: "pub-fresh", appliedAgeMs: 100_000, dispatched: false, headSha: "fedcba9876543210fedcba9876543210fedcba98" });

    const { warns, log } = recordingLog();
    const calls = { discovered: 0, sent: 0 };
    const reviewer = async () =>
      okResolution({
        recoverLineComments: async () => {
          calls.discovered += 1;
          return { posted: [], ambiguous: [], captured: false, reviewId: null, failure: "marker-missing" };
        },
        postLineComments: async () => {
          calls.sent += 1;
          return {
            posted: [{ associationId: "assoc-pub-fresh", commentId: 5001, path: "src/a.ts", line: 10 }],
            ambiguous: [],
            captured: true,
            reviewId: 5000,
          };
        },
      });

    await reconcileReviewLifecycle(asEnv(db), { now: () => T0, reviewer, log });

    // The fresh batch was selected in the same pass the older one used up its bound.
    expect(calls.sent).toBe(1);
    expect(batchColumns(db, "pub-fresh").line_dispatch_ms).toBe(T0);
    // The stuck batch left the set with the reason the pass observed, keeping
    // its row, its count and its reason for the operator.
    expect(batchColumns(db, "pub-stuck")).toEqual({
      line_dispatch_ms: T0 - 5_000,
      line_discovery_attempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts,
      line_unresolvable_ms: T0,
      line_unresolvable_reason: "marker-missing",
    });
    const reported = warns.filter((warn) => warn.event === "ops_lifecycle_line_unresolvable");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.detail).toContain("publication=pub-stuck");
    expect(reported[0]!.detail).toContain("reason=marker-missing");
    // The selector never returns it again (the fresh batch captured its comment).
    expect(await listLineBatchRecovery(db, T0 + 1, RECONCILE_DEFAULTS.lifecycleSelectLimit)).toEqual([]);

    // A second pass reports nothing new and spends no further discovery.
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0 + 1_000, reviewer, log });
    expect(warns.filter((warn) => warn.event === "ops_lifecycle_line_unresolvable")).toHaveLength(1);
    expect(batchColumns(db, "pub-stuck").line_discovery_attempts).toBe(RECONCILE_DEFAULTS.lifecycleMaxAttempts);
    expect(calls.discovered).toBe(1);
  });

  test("line recovery uses the snapshot batch size and discovery cap without losing fairness", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    db.raw.prepare("INSERT INTO review_runtime_settings (key,value,updated_at) VALUES (?,?,'now')")
      .run("platform.reconcile.lifecycle.select_limit", "1");
    db.raw.prepare("INSERT INTO review_runtime_settings (key,value,updated_at) VALUES (?,?,'now')")
      .run("platform.reconcile.lifecycle.max_attempts", "2");
    await seedAppliedLineBatch(db, { id: "pub-stuck", appliedAgeMs: 200_000, dispatched: true, discoveryAttempts: 1 });
    await seedAppliedLineBatch(db, { id: "pub-fresh", appliedAgeMs: 100_000, dispatched: false, headSha: "fedcba9876543210fedcba9876543210fedcba98" });
    const limits: unknown[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("SELECT * FROM review_publications p") && sql.includes("line_unresolvable_ms IS NULL")) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          limits.push(args.at(-1));
          return bind(...args);
        };
      }
      return statement;
    };
    await reconcileReviewLifecycle(asEnv(db), {
      now: () => T0,
      reviewer: async () => okResolution({
        recoverLineComments: async () => ({ posted: [], ambiguous: [], captured: false, reviewId: null, failure: "marker-missing" }),
        postLineComments: async () => ({
          posted: [{ associationId: "assoc-pub-fresh", commentId: 5001, path: "src/a.ts", line: 10 }],
          ambiguous: [], captured: true, reviewId: 5000,
        }),
      }),
    });
    expect(limits.length).toBeGreaterThan(1);
    expect(limits.every((limit) => limit === 1)).toBe(true);
    expect(batchColumns(db, "pub-stuck").line_discovery_attempts).toBe(2);
    expect(batchColumns(db, "pub-stuck").line_unresolvable_ms).toBe(T0);
    expect(batchColumns(db, "pub-fresh").line_dispatch_ms).toBe(T0);
    expect(await listLineBatchRecovery(db, T0 + 1, 1)).toEqual([]);
  });

  test("a batch that succeeds on its second discovery attempt resolves and is not marked unresolvable", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, { id: "pub-retry", appliedAgeMs: 100_000, dispatched: false });

    // Pass 1: the send's reply is lost, so the batch becomes discovery-only.
    const lost = okResolution({
      postLineComments: async () => {
        throw new Error("the send's reply was lost");
      },
    });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0, reviewer: async () => lost, log: SILENT_LOG });
    expect(batchColumns(db, "pub-retry").line_dispatch_ms).toBe(T0);

    // Pass 2: the readback finds the batch — it resolves, nothing is capped.
    const found = okResolution({
      recoverLineComments: async () => ({
        posted: [{ associationId: "assoc-pub-retry", commentId: 6001, path: "src/a.ts", line: 10 }],
        ambiguous: [],
        captured: true,
        reviewId: 6000,
      }),
    });
    // The unknown send still holds its 120s lease: discovery only becomes
    // selectable once that lease has lapsed.
    await reconcileReviewLifecycle(asEnv(db), {
      now: () => T0 + PUBLICATION_LEASE_MS + 1_000,
      reviewer: async () => found,
      log: SILENT_LOG,
    });

    const threads = db.raw
      .prepare(`SELECT review_id, comment_id FROM review_threads WHERE publication_id = ?`)
      .all("pub-retry") as Array<{ review_id: number | null; comment_id: number | null }>;
    expect(threads).toEqual([{ review_id: 6000, comment_id: 6001 }]);
    expect(batchColumns(db, "pub-retry")).toMatchObject({
      line_discovery_attempts: 0,
      line_unresolvable_ms: null,
      line_unresolvable_reason: null,
    });
  });

  test("a pass reaches a fresh batch behind more stuck batches than the selection width", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    // Two more stuck batches than the bounded selection returns in one query,
    // so a single SELECT would retire ten of them and never see the fresh row.
    const stuck = RECONCILE_DEFAULTS.lifecycleSelectLimit + 2;
    for (let i = 0; i < stuck; i += 1) {
      await seedAppliedLineBatch(db, {
        id: `pub-stuck-${i}`,
        appliedAgeMs: 300_000 + i,
        dispatched: true,
        discoveryAttempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts - 1,
        // 40 hex chars, distinct per batch: the journal is unique per head.
        headSha: i.toString(16).padStart(2, "0").repeat(20),
      });
    }
    await seedAppliedLineBatch(db, {
      id: "pub-behind",
      appliedAgeMs: 100_000,
      dispatched: false,
      headSha: "feedface".repeat(5),
    });

    const { warns, log } = recordingLog();
    const calls = { discovered: 0, sent: 0 };
    const reviewer = async () =>
      okResolution({
        recoverLineComments: async () => {
          calls.discovered += 1;
          return { posted: [], ambiguous: [], captured: false, reviewId: null, failure: "marker-missing" };
        },
        postLineComments: async () => {
          calls.sent += 1;
          return {
            posted: [{ associationId: "assoc-pub-behind", commentId: 8001, path: "src/a.ts", line: 10 }],
            ambiguous: [],
            captured: true,
            reviewId: 8000,
          };
        },
      });

    await reconcileReviewLifecycle(asEnv(db), { now: () => T0, reviewer, log });

    // Every stuck batch retired AND the row behind them went out in this pass.
    expect(calls.discovered).toBe(stuck);
    expect(calls.sent).toBe(1);
    expect(warns.filter((warn) => warn.event === "ops_lifecycle_line_unresolvable")).toHaveLength(stuck);
    for (let i = 0; i < stuck; i += 1) {
      expect(batchColumns(db, `pub-stuck-${i}`)).toEqual({
        line_dispatch_ms: T0 - 5_000,
        line_discovery_attempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts,
        line_unresolvable_ms: T0,
        line_unresolvable_reason: "marker-missing",
      });
    }
    expect(batchColumns(db, "pub-behind").line_dispatch_ms).toBe(T0);
  });

  test("a successful discovery resets the failed-readback count", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, { id: "pub-reset", appliedAgeMs: 100_000, dispatched: true });

    // Pass 1: one readback observed nothing — the count is 1, not yet a cap.
    const failing = async () =>
      okResolution({
        recoverLineComments: async () => ({ posted: [], ambiguous: [], captured: false, reviewId: null, failure: "marker-missing" }),
      });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0, reviewer: failing, log: SILENT_LOG });
    expect(batchColumns(db, "pub-reset").line_discovery_attempts).toBe(1);

    // Pass 2: the readback finds the batch — the count goes back to zero and
    // neither marker column was ever written.
    const succeeding = async () =>
      okResolution({
        recoverLineComments: async () => ({
          posted: [{ associationId: "assoc-pub-reset", commentId: 7001, path: "src/a.ts", line: 10 }],
          ambiguous: [],
          captured: true,
          reviewId: 7000,
        }),
      });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0 + 1_000, reviewer: succeeding, log: SILENT_LOG });

    expect(batchColumns(db, "pub-reset")).toMatchObject({
      line_discovery_attempts: 0,
      line_unresolvable_ms: null,
      line_unresolvable_reason: null,
    });
  });

  test("a stale failure cannot mark a batch another pass just completed", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, {
      id: "pub-raced",
      appliedAgeMs: 100_000,
      dispatched: true,
      discoveryAttempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts - 1,
    });

    // The concurrent recovery task saved the comment first...
    await captureLineComments(db, "pub-raced", 9000, [{ associationId: "assoc-pub-raced", commentId: 9001 }], T0);
    // ...so the stale "readback observed nothing" at the bound must be a no-op.
    expect(await recordLineDiscoveryFailure(db, "pub-raced", "marker-missing", 0, T0, RECONCILE_DEFAULTS.lifecycleMaxAttempts)).toBeNull();
    expect(batchColumns(db, "pub-raced")).toMatchObject({
      line_discovery_attempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts - 1,
      line_unresolvable_ms: null,
      line_unresolvable_reason: null,
    });
  });

  test("a stale failure cannot mark a partially captured batch", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, {
      id: "pub-partial",
      appliedAgeMs: 100_000,
      dispatched: true,
      discoveryAttempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts - 1,
      intentCount: 2,
    });

    // The observation this pass carries: no capture had persisted yet.
    expect((await readLineBatchState(db, "pub-partial")).captures).toBe(0);

    // A concurrent pass saves ONE of the two comments; the batch stays pending,
    // so the "any thread still uncaptured" predicate alone would let it retire.
    await captureLineComments(db, "pub-partial", 9100, [{ associationId: "assoc-pub-partial", commentId: 9101 }], T0);
    expect(await readLineBatchState(db, "pub-partial")).toMatchObject({ pending: true, captures: 1 });

    // The stale failure at the bound changes nothing: neither the count nor the marker.
    expect(await recordLineDiscoveryFailure(db, "pub-partial", "comment-gone", 0, T0, RECONCILE_DEFAULTS.lifecycleMaxAttempts)).toBeNull();
    expect(batchColumns(db, "pub-partial")).toMatchObject({
      line_discovery_attempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts - 1,
      line_unresolvable_ms: null,
      line_unresolvable_reason: null,
    });
  });

  test("a capture write that fails counts as a failed attempt and does not reset", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, { id: "pub-fault", appliedAgeMs: 100_000, dispatched: true, discoveryAttempts: 1 });

    // The remote read succeeds, but persisting the ids fails on that statement.
    const failingDb = new Proxy(db as unknown as Record<string, unknown>, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "prepare" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (sql.includes("SET review_id")) {
            // Fails where the capture binds its ids: nothing reaches the batch.
            return { bind: () => { throw new Error("capture write failed"); } };
          }
          return value.call(target, sql);
        };
      },
    });
    const reviewer = async () =>
      okResolution({
        recoverLineComments: async () => ({
          posted: [{ associationId: "assoc-pub-fault", commentId: 9201, path: "src/a.ts", line: 10 }],
          ambiguous: [],
          captured: true,
          reviewId: 9200,
        }),
      });

    await reconcileReviewLifecycle(
      { DB: failingDb as unknown as ScheduledEnv["DB"], REVIEW_QUEUE: NOOP_QUEUE },
      { now: () => T0, reviewer, log: SILENT_LOG },
    );

    // Nothing persisted, so the count advances instead of resetting.
    expect(batchColumns(db, "pub-fault")).toMatchObject({
      line_discovery_attempts: 2,
      line_unresolvable_ms: null,
    });
  });

  test("a partial capture counts as progress, so the next miss cannot retire the batch", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, {
      id: "pub-progress",
      appliedAgeMs: 100_000,
      dispatched: true,
      discoveryAttempts: RECONCILE_DEFAULTS.lifecycleMaxAttempts - 1,
      intentCount: 2,
    });

    // Pass 1: the readback finds one of the two comments. That PERSISTED, so the
    // count starts over even though the batch is not complete.
    const partial = async () =>
      okResolution({
        recoverLineComments: async () => ({
          posted: [{ associationId: "assoc-pub-progress", commentId: 9301, path: "src/a.ts", line: 10 }],
          ambiguous: [],
          captured: false,
          reviewId: 9300,
          failure: "comment-gone",
        }),
      });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0, reviewer: partial, log: SILENT_LOG });
    expect(batchColumns(db, "pub-progress")).toMatchObject({
      line_discovery_attempts: 0,
      line_unresolvable_ms: null,
    });

    // Pass 2: the last comment is still missing — ONE failed attempt, nowhere
    // near the bound the batch had already reached before its partial capture.
    const miss = async () =>
      okResolution({
        recoverLineComments: async () => ({
          posted: [],
          ambiguous: [],
          captured: false,
          reviewId: 9300,
          failure: "comment-gone",
        }),
      });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0 + 1_000, reviewer: miss, log: SILENT_LOG });
    expect(batchColumns(db, "pub-progress")).toMatchObject({
      line_discovery_attempts: 1,
      line_unresolvable_ms: null,
      line_unresolvable_reason: null,
    });

    // Still eligible, with the one remaining thread recoverable by a later pass.
    expect(await listLineBatchRecovery(db, T0 + 2_000, RECONCILE_DEFAULTS.lifecycleSelectLimit)).toHaveLength(1);
    const pending = db.raw
      .prepare(`SELECT id FROM review_threads WHERE publication_id = ? AND review_id IS NULL`)
      .all("pub-progress") as Array<{ id: string }>;
    expect(pending).toEqual([{ id: "assoc-pub-progress-1" }]);
  });

  test("re-listing an already captured id is not progress", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, { id: "pub-rewrite", appliedAgeMs: 100_000, dispatched: true, intentCount: 2 });

    // Pass 1 captures the first comment: a NEW id, so the count stays at zero.
    const reader = async () =>
      okResolution({
        recoverLineComments: async () => ({
          posted: [{ associationId: "assoc-pub-rewrite", commentId: 9401, path: "src/a.ts", line: 10 }],
          ambiguous: [],
          captured: false,
          reviewId: 9400,
          failure: "comment-gone",
        }),
      });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0, reviewer: reader, log: SILENT_LOG });
    expect(batchColumns(db, "pub-rewrite").line_discovery_attempts).toBe(0);

    // Pass 2 lists the SAME id again (a rewrite, not a capture) and still
    // misses the second comment: that pass saved nothing and counts.
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0 + 1_000, reviewer: reader, log: SILENT_LOG });
    expect(batchColumns(db, "pub-rewrite")).toMatchObject({
      line_discovery_attempts: 1,
      line_unresolvable_ms: null,
    });
  });

  test("the count and the reset never stamp updated_ms, so a same-head row stays unattributed", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, { id: "pub-old", appliedAgeMs: 100_000, dispatched: true, discoveryAttempts: 1 });
    const writtenAt = (
      db.raw.prepare(`SELECT updated_ms FROM review_publications WHERE id = ?`).get("pub-old") as { updated_ms: number }
    ).updated_ms;
    // A newer generation admitted after that last write, same scope and head.
    const admittedMs = T0;

    expect((await recordLineDiscoveryFailure(db, "pub-old", "marker-missing", 0, T0, RECONCILE_DEFAULTS.lifecycleMaxAttempts))?.attempts).toBe(2);
    await resetLineDiscoveryFailures(db, "pub-old");

    const after = db.raw
      .prepare(`SELECT updated_ms, line_discovery_attempts FROM review_publications WHERE id = ?`)
      .get("pub-old") as { updated_ms: number; line_discovery_attempts: number };
    expect(after).toEqual({ updated_ms: writtenAt, line_discovery_attempts: 0 });

    // The Check wait's probe reports the newest row written at/after admission;
    // bookkeeping must not hand this old row's proof to the new attempt.
    expect(
      await findPublicationJournal(db, {
        scope: SCOPE,
        headSha: SHA,
        phases: PUBLICATION_PROOF_WAIT_PHASES,
        order: "newest",
        writtenAtOrAfterMs: admittedMs,
      }),
    ).toBeNull();
  });

  test("a budget refusal is not a discovery attempt", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedAppliedLineBatch(db, { id: "pub-budget", appliedAgeMs: 100_000, dispatched: true, discoveryAttempts: 3 });

    // Returned refusal: the read never dispatched, so nothing was observed.
    const refused = async () =>
      okResolution({
        recoverLineComments: async () => ({
          posted: [],
          ambiguous: [],
          captured: false,
          reviewId: null,
          failure: "budget-refused",
        }),
      });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0, reviewer: refused, log: SILENT_LOG });
    expect(batchColumns(db, "pub-budget")).toMatchObject({
      line_discovery_attempts: 3,
      line_unresolvable_ms: null,
      line_unresolvable_reason: null,
    });

    // Thrown refusal (Octokit re-wraps the transport error in `cause`).
    const thrown = async () =>
      okResolution({
        recoverLineComments: async () => {
          throw Object.assign(new Error("Request failed"), {
            cause: new RecoveryBudgetRefused("recovery request budget exhausted"),
          });
        },
      });
    await reconcileReviewLifecycle(asEnv(db), { now: () => T0 + 2_000, reviewer: thrown, log: SILENT_LOG });
    expect(batchColumns(db, "pub-budget").line_discovery_attempts).toBe(3);

    // The work stays due: the row is still selected.
    expect(await listLineBatchRecovery(db, T0 + 3_000, RECONCILE_DEFAULTS.lifecycleSelectLimit)).toHaveLength(1);
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

    // note: The REAL §7.5 surface with unavailable identity: the resolve fails
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
        // note: jump past this round's backoff for the next pass
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
    // invariant: The row is retained (never deleted).
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
    // note: No longer selectable by the recovery reader.
    const pending = await listResolutionRecovery(db, T0 + 1_000_000, 10, RECONCILE_DEFAULTS.lifecycleMaxAttempts);
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
    seedApp(db, APP, { install: false }); // note: missing bot_installations mapping
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

    const summary = await reconcile(db, { now: () => T0 }); // safety: production routing — no credentials in tests

    expect(summary.suspended).toBe(4); // note: pub-a + pub-b + pub-c + assoc-a
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
    await reconcile(db, { now: () => T0 }); // note: production routing: disabled → suspended
    expect(pubRow(db, "pub-a").recovery_state).toBe("suspended");

    db.raw.prepare(`UPDATE review_bots SET status = 'active' WHERE id = ?`).run(APP);
    // invariant: The re-enable probe is D1-only; the injected reviewer keeps the
    // resumed pair off the suspension path for this pass.
    await reconcile(db, { now: () => T0 + 1_000, reviewer: okReviewer() });

    expect(pubRow(db, "pub-a")).toMatchObject({ recovery_state: "pending", phase: "prepared" });
    expect(pubRow(db, "pub-a").last_error).toBeNull();
  });
});

describe("suspended-pair scan fairness", () => {
  test.each(["publication", "thread"] as const)("%s recovery rotates past more than a batch of unavailable pairs", async (lane) => {
    const db = createMigratedTestD1();
    const fingerprint = await sha256Hex("enc-pem");
    const kinds = ["disabled", "missing", "deleted", "identity-mismatch"] as const;
    const repairedAssociationId = "22222222-3333-4444-5555-666666666666";
    for (let i = 0; i < RECONCILE_DEFAULTS.lifecycleSelectLimit + 2; i += 1) {
      const appId = `scan-${String(i).padStart(3, "0")}`;
      const scope = { ...SCOPE, appId };
      const repaired = i === RECONCILE_DEFAULTS.lifecycleSelectLimit + 1;
      const suspensionKind = repaired ? "disabled" : kinds[i % kinds.length]!;
      seedApp(db, appId, {
        githubAppId: 2000 + i,
        status: suspensionKind === "disabled" && !repaired ? "disabled" : "active",
        install: suspensionKind !== "missing",
        deletedAt: suspensionKind === "deleted" ? new Date(T0).toISOString() : null,
      });
      const suspension = { kind: suspensionKind, reason: "operator correction required", credentialFingerprint: fingerprint };
      const publicationId = lane === "thread" && repaired ? "33333333-4444-5555-6666-777777777777" : `pub-${i}`;
      await seedPrepared(db, publicationId, degradedPayload(scope), 0);
      if (lane === "thread") {
        const associationId = repaired ? repairedAssociationId : `assoc-${i}`;
        seedFindingRow(db, `finding-${i}`, publicationId, scope, "addressed");
        seedThreadRow(db, { id: associationId, publicationId, findingRowId: `finding-${i}`, scope,
          verified: verifiedFor(associationId, `finding-${i}`) });
        await suspendResolutionRecovery(db, scope, suspension, T0);
      } else {
        await suspendPublicationRecovery(db, scope, suspension, T0);
      }
    }

    const repairedId = RECONCILE_DEFAULTS.lifecycleSelectLimit + 1;
    let now = T0;
    let reviewer = okReviewer();
    if (lane === "thread") {
      const associationId = repairedAssociationId;
      const stored = db.raw.prepare("SELECT intent_json FROM review_threads WHERE id = ?").get(associationId) as { intent_json: string };
      const intent = JSON.parse(stored.intent_json) as LineIntent;
      let remotelyResolved = false;
      const octokit = {
        graphql: async (query: string) => {
          if (query.includes("resolveReviewThread")) {
            remotelyResolved = true;
            return { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } };
          }
          const comments = { totalCount: 0, pageInfo: { hasPreviousPage: false }, nodes: [] };
          if (query.includes("node(")) {
            return { node: {
              id: "thread-1", isResolved: remotelyResolved, isOutdated: false, path: intent.path, line: intent.line,
              pullRequest: { number: SCOPE.prNumber, headRefOid: SHA, repository: { nameWithOwner: `${SCOPE.owner}/${SCOPE.repo}` } },
              comments: { ...comments, totalCount: 1, nodes: [{
                id: "comment-11", fullDatabaseId: "11", body: buildLineCommentBody(intent),
                createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
                author: { __typename: "Bot", login: "reconcile-bot" },
              }] },
            } };
          }
          return { repository: { pullRequest: { headRefOid: SHA, comments } } };
        },
      } as unknown as GraphqlOctokit;
      const capture = await fetchThreadConversation(octokit, "thread-1");
      const verified = verifiedFor(associationId, `finding-${repairedId}`);
      verified.snapshot.digest = await threadDigestOf({ threadId: "thread-1", rootCommentId: "11", headSha: SHA, comments: capture.comments });
      verified.issueDigest = await issueDigestOf({ headSha: SHA, comments: [] });
      db.raw.prepare("UPDATE review_threads SET review_id = 777, comment_id = 11, thread_id = 'thread-1', verified_json = ? WHERE id = ?")
        .run(JSON.stringify(verified), associationId);
      const threads = createReviewThreads({
        db,
        nowMs: () => now,
        getAppIdentity: async () => ({ githubAppId: 2000 + repairedId, slug: "reconcile-bot" }),
        getOctokit: async () => octokit,
      });
      reviewer = okReviewer({ resolveFindingThread: threads.resolveFindingThread });
    }
    for (let pass = 0; pass < 3; pass += 1) {
      now = T0 + pass;
      await reconcile(db, { now: () => now, reviewer });
    }

    if (lane === "publication") {
      expect(pubRow(db, `pub-${repairedId}`).recovery_state).toBe("pending");
      expect(pubRow(db, "pub-0").recovery_state).toBe("suspended");
    } else {
      expect(threadRow(db, repairedAssociationId)).toMatchObject({
        resolution_state: "resolved",
        attempts: 1,
        last_error: null,
        next_attempt_ms: null,
        lease_until_ms: null,
      });
      expect(threadRow(db, "assoc-0").resolution_state).toBe("suspended");
    }
    db.raw.close();
  });

  test("a throwing identity probe does not pin the next scan to that pair", async () => {
    const db = createMigratedTestD1();
    for (let i = 0; i <= RECONCILE_DEFAULTS.lifecycleSelectLimit; i += 1) {
      const appId = `scan-${String(i).padStart(3, "0")}`;
      const scope = { ...SCOPE, appId };
      seedApp(db, appId, { githubAppId: 3000 + i });
      await seedPrepared(db, `pub-${i}`, degradedPayload(scope), 0);
      await suspendPublicationRecovery(db, scope, { kind: "identity-mismatch", reason: "needs proof" }, T0);
    }
    await reconcile(db, { now: () => T0, reviewer: async () => { throw new Error("probe failed"); } });
    expect(pubRow(db, "pub-0").recovery_state).toBe("suspended");
    await reconcile(db, { now: () => T0 + 1, reviewer: okReviewer() });
    expect(pubRow(db, `pub-${RECONCILE_DEFAULTS.lifecycleSelectLimit}`).recovery_state).toBe("pending");
    db.raw.close();
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

    // note: Local apply of the already-confirmed publication continues…
    expect(summary.applied).toBe(1);
    expect(pubRow(db, "pub-confirmed")).toMatchObject({ phase: "applied" });
    // note: …previously-authorized resolution retry continues…
    expect(summary.resolved).toBe(1);
    // note: …but NO new primary publication is prepared for sending.
    expect(pubRow(db, "pub-prepared")).toMatchObject({ phase: "prepared", recovery_state: "pending", attempts: 0 });
    const postCalls = db.raw.query("SELECT COUNT(*) AS n FROM review_publications WHERE phase = 'sending'").get() as { n: number };
    expect(postCalls.n).toBe(0);
  });
});

describe("budgets (spec §7.11.1)", () => {
  test("deadline exhaustion stops the thread lane without spending an attempt", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    // why: FK anchor for the thread row, staged TERMINAL so the publication lane
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
      const value = call++ < 1 ? T0 : T0 + RECONCILE_DEFAULTS.lifecycleRunBudgetMs + 1_000;
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

    expect(resolved).toBe(0); // invariant: the §7.5 surface was never entered — no claim, no attempt
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
    await seedPrepared(db, "pub-b", degradedPayload(SCOPE_B), 120_000); // note: needs GitHub → suspends with the pair
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
      // note: Pair B's installation mapping is missing (simulating the broken
      // D1-routing outcome); pair A is served.
      reviewer: async (input) => {
        routed.push(`${input.appId}:${input.installationId}`);
        if (input.appId === APP_B) return { kind: "unavailable", reason: "missing" as const };
        return healthy(input);
      },
    });

    expect(summary.applied).toBe(1); // note: pub-a
    expect(summary.resolved).toBe(1); // note: assoc-a (state persistence is the §7.5 surface's own contract)
    expect(summary.suspended).toBe(2); // note: pub-b + assoc-b
    expect(pubRow(db, "pub-a")).toMatchObject({ phase: "applied" });
    expect(pubRow(db, "pub-b")).toMatchObject({ recovery_state: "suspended" });
    expect(threadRow(db, "assoc-b").resolution_state).toBe("suspended");
    expect(resolvedScopes).toEqual([SCOPE]); // note: exact scope binding, no cross-App work
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

    // note: The wrapper folded the failure into a typed suspension, not a throw.
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
  /** note: Drive one pass and capture the run transport the factory receives. */
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

    // note: Deadline = T0 + 45s (fixed at run start). With plenty of run left the
    // per-request bound is the 5s cap...
    expect(transport.boundMs()).toBe(RECONCILE_DEFAULTS.lifecyclePerRequestMs);
    // note: ...and late in the run it collapses to the remaining time — this is the
    // clamp the review found missing (§7.11.1: "additionally capped by
    // remaining run deadline").
    clock.now = T0 + RECONCILE_DEFAULTS.lifecycleRunBudgetMs - 30;
    expect(transport.boundMs()).toBe(30);
    // invariant: Never zero/negative: a request already past the deadline gets 1ms.
    clock.now = T0 + RECONCILE_DEFAULTS.lifecycleRunBudgetMs + 10_000;
    expect(transport.boundMs()).toBe(1);

    // note: The clamp is ENFORCED on the wire, not merely computed: a hung upstream
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
      clock.now = T0 + RECONCILE_DEFAULTS.lifecycleRunBudgetMs - 40; // note: 40ms of run left
      const started = performance.now();
      await expect(transport.fetchImpl("https://api.github.com/app")).rejects.toMatchObject({
        name: "TimeoutError",
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_000); // note: far below the 5s cap — the remaining time bound it
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
      expect(seen).not.toBe(caller); // note: combined, not substituted
      expect(seen?.aborted).toBe(false);

      // note: The COMBINED signal still honours the caller's abort.
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
    // invariant: Terminal publication as the FK anchor: the publication lane stays empty
    // so the whole 80-request budget belongs to the thread lane.
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 0);
    db.raw
      .prepare(`UPDATE review_publications SET phase = 'superseded', recovery_state = 'done' WHERE id = 'pub-1'`)
      .run();
    // note: TEN due rows — the §7.11.1 selection LIMIT. The ≤15-request envelope is
    // the admission ESTIMATE: only floor(80 / 15) = 5 may even start, and the
    // requests each operation really issues are charged at the transport.
    for (let i = 0; i < RECONCILE_DEFAULTS.lifecycleSelectLimit; i += 1) {
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

    // note: Each entered operation issues a REAL request burst through the run
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
          // note: Faithful to the real §7.5 surface: entering T2 CONSUMES the claim
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
    // note: 25 + 25 + 25 = 75 actual requests by three operations; 75 + 15 > 80, so
    // the fourth is never admitted. Actual requests stay under the cap.
    expect(resolved).toBe(3);
    expect(requests).toBe(75);
    expect(requests).toBeLessThanOrEqual(RECONCILE_DEFAULTS.lifecycleMaxRequests);
    expect(summary.examined).toBe(3);

    // invariant: Budget exhaustion stops the lane BEFORE any claim/attempt mutation for
    // the rows it never reached (§7.11.1: exhaustion is not a failed attempt).
    const untouched = db.raw
      .query(`SELECT COUNT(*) AS n FROM review_threads WHERE attempts = 0 AND lease_until_ms IS NULL AND resolution_state = 'pending'`)
      .get() as { n: number };
    expect(untouched.n).toBe(RECONCILE_DEFAULTS.lifecycleSelectLimit - 3); // invariant: 7 rows never entered T2
    expect(transport).toBeDefined();

    // invariant: The meter is the TRANSPORT: the remaining allowance is exactly
    // 80 - 75 = 5, and the 6th request is refused BEFORE any dispatch.
    const realFetch = globalThis.fetch;
    const alreadySpent = requests;
    try {
      let dispatched = 0;
      globalThis.fetch = (async () => {
        dispatched += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      for (let i = 0; i < RECONCILE_DEFAULTS.lifecycleMaxRequests - alreadySpent; i += 1) {
        await transport!.fetchImpl("https://api.github.com/x");
      }
      expect(dispatched).toBe(RECONCILE_DEFAULTS.lifecycleMaxRequests - alreadySpent);
      await expect(transport!.fetchImpl("https://api.github.com/x")).rejects.toThrow(/budget exhausted/);
      expect(dispatched).toBe(RECONCILE_DEFAULTS.lifecycleMaxRequests - alreadySpent); // invariant: never dispatched
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("publication-lane spend is shared with the thread lane, shrinking how many rows may enter", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    // note: A prepared publication needing GitHub issues its real plan + send
    // requests through the SAME run transport, so its spend genuinely reduces
    // what the thread lane may admit — there is no separate allowance.
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE, { round: 1 }), 120_000);
    for (let i = 0; i < RECONCILE_DEFAULTS.lifecycleSelectLimit; i += 1) {
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
          // note: 1 (plan) + 39 (send) real requests = the publication lane's full
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
          // note: Each thread operation also issues real requests (a §7.5 resolve
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

    // note: The lane cap is a real bound on ACTUAL requests: the publication lane
    // stops dispatching at 40 even though its estimate was tiny.
    expect(publicationRequests).toBe(RECONCILE_DEFAULTS.lifecyclePublicationLaneMaxRequests);
    // note: The thread lane then shares that same run allowance: every operation that
    // entered really issued its requests, and together the two lanes stop at
    // exactly the whole-run cap — admission alone never lets the run overshoot.
    expect(threadRequests).toBe(RECONCILE_DEFAULTS.lifecycleMaxRequests - RECONCILE_DEFAULTS.lifecyclePublicationLaneMaxRequests);
    expect(publicationRequests + threadRequests).toBe(RECONCILE_DEFAULTS.lifecycleMaxRequests);
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

      // note: A single logical operation that internally paginates 40 pages: every
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

      // invariant: A request that fails AFTER leaving the Worker still consumed the run's
      // allowance: repeated failures must not be able to issue unaccounted
      // requests past the cap.
      let refused = 0;
      for (let i = 0; i < RECONCILE_DEFAULTS.lifecycleMaxRequests + 20; i += 1) {
        try {
          await transport!.fetchImpl("https://api.github.com/x");
        } catch (err) {
          if (err instanceof Error && /budget exhausted/.test(err.message)) refused += 1;
        }
      }
      expect(dispatched).toBe(RECONCILE_DEFAULTS.lifecycleMaxRequests);
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
      // note: A healthy pair: the point of this test is the METERING refusal, so the
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

      for (let i = 0; i < RECONCILE_DEFAULTS.lifecycleMaxRequests; i += 1) {
        await transport!.fetchImpl("https://api.github.com/x");
      }
      dispatched = 0;
      await expect(transport!.fetchImpl("https://api.github.com/x")).rejects.toThrow(/budget exhausted/);
      expect(dispatched).toBe(0); // invariant: refused before any dispatch
    } finally {
      globalThis.fetch = realFetch;
    }

    // invariant: The pending row was never mutated by the metering refusal: it stays due
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
    // invariant: Real encrypted PEM: the probe must actually sign a JWT and reach the
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
        // note: The live App answers with a DIFFERENT numeric id than the routed
        // github_app_id — a rotated/substituted credential pair.
        return new Response(JSON.stringify({ id: 9999, slug: "someone-else" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const summary = await reconcileReviewLifecycle(
        { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, REVIEW_QUEUE: NOOP_QUEUE },
        { log: SILENT_LOG, now: () => T0 },
      );

      // note: Durable suspension of BOTH lanes' rows for the exact pair.
      expect(summary.suspended).toBe(2);
      expect(summary.applied).toBe(0);
      expect(pubRow(db, "pub-1")).toMatchObject({ recovery_state: "suspended", attempts: 0 });
      const thread = threadRow(db, "assoc-1");
      expect(thread.resolution_state).toBe("suspended");
      expect(thread.attempts).toBe(0);
      // note: The reason names the identity mismatch so an operator can tell it
      // apart from a disabled/deleted App.
      expect(thread.last_error).toContain("live App identity does not match");

      // invariant: NO remote mutation: the only request issued was the read-only probe,
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
        // note: Degraded marker scan (paginated list) — empty page ⇒ create plan.
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
        { DB: db as unknown as ScheduledEnv["DB"], DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, REVIEW_QUEUE: NOOP_QUEUE },
        { log: SILENT_LOG, now: () => T0 },
      );

      expect(summary.suspended).toBe(0);
      expect(summary.applied).toBe(1); // note: the send went through: identity proved
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
        // note: The live App keeps answering with a DIFFERENT numeric id — the
        // credentials were never corrected.
        return new Response(JSON.stringify({ id: 9999, slug: "someone-else" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const env = {
        DB: db as unknown as ScheduledEnv["DB"],
        DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        REVIEW_QUEUE: NOOP_QUEUE,
      };
      const first = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 });
      expect(first.suspended).toBe(2);
      expect(pubRow(db, "pub-1").recovery_state).toBe("suspended");
      const identityProbesAfterFirst = requests.filter((u) => u.endsWith("/app")).length;
      expect(identityProbesAfterFirst).toBe(1);

      // safety: Second and third passes: the credentials are byte-identical, so the
      // mismatch is still proven — no re-enable, and critically NO further
      // identity probe (no churn, no remote work under unchanged credentials).
      requests.length = 0;
      const second = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 + 60_000 });
      const third = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 + 120_000 });
      expect(second.suspended).toBe(0);
      expect(third.suspended).toBe(0);
      expect(requests).toEqual([]); // invariant: zero requests: nothing was probed or mutated
      expect(pubRow(db, "pub-1")).toMatchObject({ recovery_state: "suspended", attempts: 0 });
      expect(threadRow(db, "assoc-1").resolution_state).toBe("suspended");
      expect(threadRow(db, "assoc-1").last_error).toContain("live App identity does not match");

      // safety: The operator corrects the credentials: the envelope changes, so the
      // pair is re-probed and, once the live identity matches, resumes.
      const correctedPem = await testAppPem();
      const corrected = await createSecretbox(TEST_ENCRYPTION_KEY).encryptSecret(
        correctedPem,
        `github_apps.private_key_enc:${APP}`,
      );
      db.raw.prepare(`UPDATE review_bots SET private_key_enc = ? WHERE id = ?`).run(corrected, APP);
      globalThis.fetch = (async (input: unknown) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ id: 1001, slug: "acme-inspector" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const resumed = await reconcileReviewLifecycle(env, { log: SILENT_LOG, now: () => T0 + 180_000 });
      // why: The proof succeeded, so the pair left suspension — and the identity
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
    await reconcile(db, { now: () => T0 }); // note: production routing: disabled → suspended
    expect(pubRow(db, "pub-a").recovery_state).toBe("suspended");
    expect(pubRow(db, "pub-a").last_error).toContain("suspend:disabled:");

    db.raw.prepare(`UPDATE review_bots SET status = 'active' WHERE id = ?`).run(APP);
    // safety: The status-only resume still applies: no credential identity question
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
        // invariant: The worker throws exactly what the commenter throws for a definitive
        // pre-send refusal (a foreign bot marker appeared after the plan).
        postPreparedDegraded: async () => {
          throw new PreparedSendRejected(
            "a bot degraded marker (comment 9) appeared after the pre-staging plan — refusing to create a second publication (spec §7.7)",
          );
        },
      }),
    });

    // invariant: Truthful durable state: `failed` (a request never left the Worker),
    // NOT `unknown` (which is reserved for post-attempt ambiguity).
    expect(pubRow(db, "pub-1")).toMatchObject({
      phase: "failed",
      attempts: 1,
      lease_until_ms: null,
    });
    expect(pubRow(db, "pub-1").last_error).toContain("refusing to create a second publication");
    expect(summary.errors).toBe(1);
    expect(summary.unknown).toBe(0); // note: the misclassification this fixes

    // note: Payload and digest are retained for operator inspection.
    const payload = db.raw
      .query(`SELECT payload_json, proof_json FROM review_publications WHERE id = 'pub-1'`)
      .get() as { payload_json: string; proof_json: string | null };
    expect(JSON.parse(payload.payload_json).body).toBe("degraded body");
    expect(payload.proof_json).toBeNull(); // note: no proof claim for a not-sent publication

    // invariant: Recovery never re-sends a failed row: a later pass examines it and
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
        // note: A transport throw at the send is post-attempt uncertainty (§7.9).
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
  /** note: Issue `count` requests through the REAL run transport with the global
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

    // note: The publication lane's own admission passes (its estimate fits), so the
    // row IS claimed; the allowance then runs out INSIDE the send — the
    // reachable arithmetic case this check pins.
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async (input) => {
        const runTransport = input.transport!;
        return okResolution({
          planReviewUpsert: async (): Promise<UpsertPlan> => ({ action: "create", round: 1 }),
          postPreparedDegraded: async () => {
            await spendThrough(runTransport, RECONCILE_DEFAULTS.lifecycleMaxRequests + 1);
            return { posted: true, commentId: 777 };
          },
        });
      },
    });

    // invariant: The publication was NEVER dispatched, so its durable state must stay
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

    // note: "No attempt spent" is what keeps the row immediately selectable: M8
    // re-selects it on the very next pass with its full attempt budget.
    const dueAgain = await listPublicationRecovery(db, T0, RECONCILE_DEFAULTS.lifecycleSelectLimit, RECONCILE_DEFAULTS.lifecycleMaxAttempts);
    expect(dueAgain.map((r) => r.id)).toContain("pub-1");

    // note: And the next run really does send it, proving the refusal deferred the
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
    // note: Octokit does not let a custom transport error reach the lane intact:
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
              await spendThrough(runTransport, RECONCILE_DEFAULTS.lifecycleMaxRequests + 1);
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
    // note: Same lane, same claim, same throw site — but the error is not the
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
          // invariant: Mentions the budget, but is NOT the typed refusal: identity, never
          // message text, decides.
          throw new Error("request failed while reporting: recovery request budget exhausted");
        },
      }),
    });

    expect(pubRow(db, "pub-1").phase).toBe("unknown");
    expect(summary.unknown).toBe(1);
  });
});

/** note: Issue-only discussion seen by the discovery lane: `author` posted `body`,
 * and `viewerDidAuthor` says whether THIS installation token wrote it.
 */
function issueOnlyDiscussion(author: string, body: string, ownAuthor = true) {
  return {
    listDiscussion: async () => ({
      items: [
        {
          source: "issue" as const,
          associationId: null,
          id: "51",
          author,
          ownAuthor,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          body,
        },
      ],
      issueCoverage: "complete" as const,
      issueModelCoverage: "complete" as const,
      issueDigest: "issue-digest",
      capturedMs: T0,
      threads: [],
    }),
  };
}

describe("uncertain-publication discovery ownership (spec §7.5/§7.7, P67-QC-011)", () => {
  test("discovery matches ONLY this App's authenticated authorship, never a generic [bot] suffix", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    // note: Force the row into the uncertain state discovery owns.
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
                // note: A DIFFERENT App's bot, with a byte-identical body — the
                // generic `[bot]` suffix would have accepted this.
                author: "other-app[bot]",
                ownAuthor: false,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                body,
              },
            ],
            issueCoverage: "complete",
            issueModelCoverage: "complete",
            issueDigest: "issue-digest",
            capturedMs: T0,
            threads: [],
          }),
        },
        { botLogin: "acme-inspector[bot]" },
      ),
    });

    // invariant: A foreign App's identical body is NOT proof: the row stays unknown.
    expect(pubRow(db, "pub-1").phase).toBe("unknown");
    expect(summary.applied).toBe(0);
    const unproven = db.raw
      .query(`SELECT proof_json FROM review_publications WHERE id = 'pub-1'`)
      .get() as { proof_json: string | null };
    expect(unproven.proof_json).toBeNull();

    // note: The SAME body by OUR authenticated login is proof and applies — in the
    // bare shape GraphQL `author.login` returns.
    await reconcile(db, {
      now: () => T0 + 600_000,
      reviewer: okReviewer(issueOnlyDiscussion("acme-inspector", body), { botLogin: "acme-inspector[bot]" }),
    });
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied", recovery_state: "done" });
  });

  test("a HUMAN login equal to the App slug never proves authorship, even with the exact body", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    db.raw.prepare(`UPDATE review_publications SET phase = 'sending', attempts = 1 WHERE id = 'pub-1'`).run();

    const body = "degraded body";
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer(issueOnlyDiscussion("acme-inspector", body, false), {
        botLogin: "acme-inspector[bot]",
      }),
    });

    // note: The body (marker included) is copyable content, not authorship evidence:
    // the bare login is the App's slug, so only the authenticated provenance
    // can tell this comment apart from our own.
    expect(pubRow(db, "pub-1").phase).toBe("unknown");
    expect(pubRow(db, "pub-1").attempts).toBe(2); // invariant: the miss spent exactly one
    expect(summary.applied).toBe(0);
    expect(summary.unknown).toBe(1);
    const unproven = db.raw
      .query(`SELECT proof_json FROM review_publications WHERE id = 'pub-1'`)
      .get() as { proof_json: string | null };
    expect(unproven.proof_json).toBeNull();
  });

  test("the REST-shaped `<slug>[bot]` login is the same identity and still applies", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE), 120_000);
    db.raw.prepare(`UPDATE review_publications SET phase = 'sending', attempts = 1 WHERE id = 'pub-1'`).run();

    await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer(issueOnlyDiscussion("acme-inspector[bot]", "degraded body"), {
        botLogin: "acme-inspector[bot]",
      }),
    });
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied", recovery_state: "done" });
  });
});


/** note: `listDiscussion` backed by the REAL §7.8 capture over a GraphQL transport
 * double: whether discovery can see a comment is decided by the capture switch
 * the reconciler asks for, not by the fixture.
 */
function captureBackedDiscussion(
  comments: Array<{ commentId: number; body: string; own: boolean }>,
): NonNullable<Parameters<typeof okReviewer>[0]>["listDiscussion"] {
  const octokit = {
    graphql: async () => ({
      repository: {
        pullRequest: {
          headRefOid: SHA,
          comments: {
            totalCount: comments.length,
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes: comments.map((c) => ({
              id: `i-${c.commentId}`,
              fullDatabaseId: String(c.commentId),
              body: c.body,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              author: { __typename: c.own ? "Bot" : "User", login: c.own ? "acme-inspector" : "mallory" },
              viewerDidAuthor: c.own,
            })),
          },
        },
      },
    }),
  } as unknown as GraphqlOctokit;
  return (input) => listDiscussionWithOctokit(octokit, input);
}

describe("uncertain-publication discovery through the real capture", () => {
  const preparedBody = "<!-- mstar-inspector:review-degraded:v1 round=1 -->\n\na degraded body";

  test("an App-authored comment carrying the prepared body proves the publication (no backoff)", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE, { body: preparedBody }), 120_000);
    db.raw.prepare(`UPDATE review_publications SET phase = 'sending', attempts = 1 WHERE id = 'pub-1'`).run();

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer(
        {
          listDiscussion: captureBackedDiscussion([
            { commentId: 8001, body: "a human comment", own: false },
            { commentId: 8002, body: preparedBody, own: true },
          ]),
        },
        { botLogin: "acme-inspector[bot]" },
      ),
    });

    // note: The comment existed all along; the capture was hiding it from the walk:
    // the proof lands, the lifecycle applies, and no backoff is scheduled.
    expect(pubRow(db, "pub-1")).toMatchObject({ phase: "applied", recovery_state: "done", last_error: null });
    expect(summary.applied).toBe(1);
    expect(summary.unknown).toBe(0);
  });

  test("a HUMAN comment carrying the identical body proves nothing and still settles as a miss", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    await seedPrepared(db, "pub-1", degradedPayload(SCOPE, { body: preparedBody }), 120_000);
    db.raw.prepare(`UPDATE review_publications SET phase = 'sending', attempts = 1 WHERE id = 'pub-1'`).run();

    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: okReviewer(
        { listDiscussion: captureBackedDiscussion([{ commentId: 8003, body: preparedBody, own: false }]) },
        { botLogin: "acme-inspector[bot]" },
      ),
    });

    expect(pubRow(db, "pub-1").phase).toBe("unknown");
    expect(pubRow(db, "pub-1").attempts).toBe(2);
    expect(summary.applied).toBe(0);
    expect(summary.unknown).toBe(1);
    const unproven = db.raw
      .query(`SELECT proof_json FROM review_publications WHERE id = 'pub-1'`)
      .get() as { proof_json: string | null };
    expect(unproven.proof_json).toBeNull();
  });
});

describe("runtime lifecycle selection", () => {
  function minimumRequestSettings(db: TestD1) {
    for (const [field, key] of [
      ["lifecycleMaxRequests", "max_requests"],
      ["lifecyclePublicationLaneMaxRequests", "publication_lane_max_requests"],
      ["lifecycleThreadOperationRequests", "thread_operation_requests"],
    ] as const) db.raw.prepare("INSERT INTO review_runtime_settings (key,value,updated_at) VALUES (?,?,'now')")
      .run(`platform.reconcile.lifecycle.${key}`, String(RECONCILE_LIMITS[field].min));
  }

  test("minimum request budgets publish one cold prepared row", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    minimumRequestSettings(db);
    await seedPrepared(db, "minimum-publication", reviewPayload(SCOPE), 120_000);
    const { credentials, plan, send } = RECONCILE_REQUEST_ESTIMATES;
    let dispatched = 0;
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async ({ transport }) => {
        dispatched += await meterRequests(transport!, credentials);
        return okResolution({
          planReviewUpsert: async () => {
            dispatched += await meterRequests(transport!, plan);
            return { action: "create", round: 1 };
          },
          postPreparedReview: async () => {
            const sent = await meterRequests(transport!, send);
            dispatched += sent;
            if (sent !== send) throw new Error("send budget refused");
            return { commentId: 777 };
          },
        });
      },
    });
    expect(dispatched).toBe(credentials + plan + send);
    expect(summary.applied).toBe(1);
    expect(pubRow(db, "minimum-publication")).toMatchObject({ phase: "applied", recovery_state: "done" });
  });

  test("minimum request budgets resolve one cold thread row", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    minimumRequestSettings(db);
    await seedPrepared(db, "minimum-thread", degradedPayload(SCOPE), 0);
    db.raw.prepare("UPDATE review_publications SET phase='superseded', recovery_state='done' WHERE id='minimum-thread'").run();
    seedFindingRow(db, "minimum-finding", "minimum-thread", SCOPE, "addressed");
    seedThreadRow(db, {
      id: "minimum-association", publicationId: "minimum-thread", findingRowId: "minimum-finding",
      scope: SCOPE, verified: verifiedFor("minimum-association", "minimum-finding"),
    });
    const { credentials, discovery, plan } = RECONCILE_REQUEST_ESTIMATES;
    let dispatched = 0;
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async ({ transport }) => {
        dispatched += await meterRequests(transport!, credentials);
        return okResolution({
          resolveFindingThread: async () => {
            for (const requests of [discovery, discovery, plan, discovery]) {
              const sent = await meterRequests(transport!, requests);
              dispatched += sent;
              if (sent !== requests) return { kind: "retry", reason: "api" };
            }
            return { kind: "resolved", threadId: "thread-minimum", adopted: false, outdated: false, lateChange: false };
          },
        });
      },
    });
    expect(dispatched).toBe(credentials + discovery + discovery + plan + discovery);
    expect(summary.resolved).toBe(1);
  });

  test("minimum budgets leave cold credential headroom for a different thread pair", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    seedApp(db, APP_B, { githubAppId: 1002, installationId: SCOPE_B.installationId });
    minimumRequestSettings(db);
    await seedPrepared(db, "headroom-publication", reviewPayload(SCOPE), 120_000);
    await seedPrepared(db, "headroom-thread", degradedPayload(SCOPE_B), 0);
    db.raw.prepare("UPDATE review_publications SET phase='superseded', recovery_state='done' WHERE id='headroom-thread'").run();
    seedFindingRow(db, "headroom-finding", "headroom-thread", SCOPE_B, "addressed");
    seedThreadRow(db, {
      id: "headroom-association", publicationId: "headroom-thread", findingRowId: "headroom-finding",
      scope: SCOPE_B, verified: verifiedFor("headroom-association", "headroom-finding"),
    });
    const { credentials, discovery, plan, send } = RECONCILE_REQUEST_ESTIMATES;
    let publicationRequests = 0;
    let threadRequests = 0;
    const summary = await reconcile(db, {
      now: () => T0,
      reviewer: async ({ appId, transport }) => {
        const cold = await meterRequests(transport!, credentials);
        if (appId === APP) publicationRequests += cold;
        else threadRequests += cold;
        return okResolution({
          planReviewUpsert: async () => {
            publicationRequests += await meterRequests(transport!, plan);
            return { action: "create", round: 1 };
          },
          postPreparedReview: async () => {
            const sent = await meterRequests(transport!, send);
            publicationRequests += sent;
            if (sent !== send) throw new Error("send budget refused");
            return { commentId: 777 };
          },
          resolveFindingThread: async () => {
            for (const requests of [discovery, discovery, plan, discovery]) {
              const sent = await meterRequests(transport!, requests);
              threadRequests += sent;
              if (sent !== requests) return { kind: "retry", reason: "api" };
            }
            return { kind: "resolved", threadId: "thread-headroom", adopted: false, outdated: false, lateChange: false };
          },
        });
      },
    });
    expect(publicationRequests).toBe(RECONCILE_LIMITS.lifecyclePublicationLaneMaxRequests.min);
    expect(summary, JSON.stringify({ summary, publicationRequests, threadRequests })).toMatchObject({ applied: 1, resolved: 1, errors: 0 });
    expect(threadRequests).toBe(credentials + discovery + discovery + plan + discovery);
    expect(threadRow(db, "headroom-association").resolution_state).not.toBe("local-error");
  });

  test("configured selection limit and attempt cap bound a pass with one snapshot", async () => {
    const db = createMigratedTestD1();
    seedApp(db, APP);
    for (let index = 0; index < 3; index += 1) await seedConfirmedCrashed(db, `runtime-${index}`, reviewPayload({ ...SCOPE, prNumber: 200 + index }));
    db.raw.prepare("UPDATE review_publications SET attempts = 2 WHERE id = 'runtime-0'").run();
    db.raw.prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)").run("platform.reconcile.lifecycle.select_limit", "1", "now");
    db.raw.prepare("INSERT INTO review_runtime_settings (key, value, updated_at) VALUES (?, ?, ?)").run("platform.reconcile.lifecycle.max_attempts", "2", "now");
    let reads = 0;
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = original(sql);
      if (sql.includes("review_runtime_settings WHERE key IN")) reads += 1;
      return statement;
    };
    const result = await reconcile(db, { now: () => T0 });
    expect(result.examined).toBe(1);
    expect(reads).toBe(1);
    expect(pubRow(db, "runtime-0").phase).toBe("confirmed");
    db.raw.close();
  });
});
