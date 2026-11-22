/**
 * note: Terminal failure status (compass D9, migration 0087) — every terminal review
 * failure persists ONE approved category, and that category selects the
 * user-facing wording.
 *
 * What this suite pins:
 *   - the approved set is exactly `paused` / `unknown-failure` / `budget-stop` /
 *     `cap-stop`, each with fixed text (or, for `budget-stop`, the existing
 *     trusted exhaustion summary) and NO interpolated error;
 *   - every terminal path `decideConclusion` reaches carries a category, and the
 *     two deliberate exceptions carry none (a missed gate is a verdict on the
 *     change; a superseded attempt is not a fault);
 *   - the operator's end-to-end cap and a spent tier window stay DISTINCT
 *     categories;
 *   - the store freezes the category in the SAME write as the terminal intent,
 *     reads it back, leaves a waiting attempt with none, clears it when a proof
 *     correction turns the failure into success, and refuses an unknown
 *     category at the schema.
 *
 * Everything runs against the real migration SQL (bun:sqlite double); no
 * GitHub, Cloudflare or Sandbox request is made (spec §7.13).
 */
import { describe, expect, test } from "bun:test";
import {
  TERMINAL_FAILURE_TEXT,
  budgetExhaustedSummary,
  createCheckLifecycle,
  decideConclusion,
  terminalFailureSummary,
  type ReviewGate,
} from "../../src/pipeline/checks";
import {
  attachCheckRunId,
  CHECK_LEASE_MS,
  CHECK_NAME,
  claimAttempt,
  claimCheckRecovery,
  getCheckAttempt,
  listCheckReconcileBatch,
  releaseCheckClaim,
  setCheckCreateState,
  setCheckDesired,
  type CheckConclusion,
  type CheckFailureStatus,
  type Lease,
  type PublicationProof,
  type PublishedReview,
  type Scope,
} from "../../src/store/review-checks";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const GITHUB_APP_ID = 1001;
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_700_000_000_000;
const DEADLINE = T0 + CHECK_LEASE_MS;
const GATE: ReviewGate = { minScore: 80, passVerdicts: ["ship it"] };

/** note: The four approved categories — nothing else may ever be persisted. */
const APPROVED: readonly CheckFailureStatus[] = ["paused", "unknown-failure", "budget-stop", "cap-stop"];

const BUDGET_RECORD = {
  kind: "budget-exhausted" as const,
  cause: "runner-deadline" as const,
  budgetWindow: "runner" as const,
  tier: "default" as const,
  budgetMs: 600_000,
  seatsDispatched: 3,
  seatsStopped: 2,
  changedLines: 420,
};

function publication(overrides: Partial<PublicationProof> = {}): PublicationProof {
  return {
    publicationId: "publication-1",
    scope: SCOPE,
    headSha: SHA,
    kind: "review",
    round: 1,
    commentId: 7,
    bodySha256: "a".repeat(64),
    confirmedMs: T0,
    ...overrides,
  };
}

function review(verdict: string, scorePct: number | null): PublishedReview {
  return { verdict, scorePct };
}

function seededDb(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'terminal-status', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, GITHUB_APP_ID);
  return db;
}

/** note: One claimed attempt holding its own live lease. */
async function claimed(db: TestD1, deliveryId?: string): Promise<{ attemptId: string; lease: Lease }> {
  const result = await claimAttempt(db, {
    scope: SCOPE,
    githubAppId: GITHUB_APP_ID,
    headSha: SHA,
    triggeredBy: "octocat",
    action: "review",
    holder: deliveryId === undefined ? "run-a" : `delivery:${deliveryId}`,
    nowMs: T0,
    executionDeadlineMs: DEADLINE,
    ...(deliveryId === undefined ? {} : { attachDeliveryId: deliveryId }),
  });
  if (result.kind !== "claimed") throw new Error(`fixture: expected a claimed attempt, got ${result.kind}`);
  return { attemptId: result.attempt.identity.attemptId, lease: result.lease };
}

describe("the approved wording set (compass D9)", () => {
  test("exactly four categories, each with its fixed approved text", () => {
    // note: The catalogue is closed: the set below IS the set a Check may carry.
    expect(Object.keys(TERMINAL_FAILURE_TEXT).sort()).toEqual(["cap-stop", "paused", "unknown-failure"]);
    expect(APPROVED).toHaveLength(4);
    for (const status of APPROVED) {
      const text = terminalFailureSummary(status, BUDGET_RECORD);
      // note: Keyed by category, not formatted from an error: the same category
      // always renders exactly the same string.
      expect(terminalFailureSummary(status, BUDGET_RECORD)).toBe(text);
      expect(text.length).toBeGreaterThan(0);
    }
    // note: `budget-stop` keeps the existing exhaustion summary, unchanged.
    expect(terminalFailureSummary("budget-stop", BUDGET_RECORD)).toBe(budgetExhaustedSummary(BUDGET_RECORD));
    // note: Each category names its single next step (or, for the budget stop, the
    // documented shrink-the-diff guidance).
    expect(TERMINAL_FAILURE_TEXT.paused).toContain("no action is needed from you");
    expect(TERMINAL_FAILURE_TEXT["unknown-failure"]).toContain("mentioning the review bot in a PR comment");
    expect(TERMINAL_FAILURE_TEXT["cap-stop"]).toContain("maximum review duration");
    expect(TERMINAL_FAILURE_TEXT["cap-stop"]).toContain("mentioning the review bot in a PR comment");
  });

  test("no approved text carries an error, a stack, a provider or an HTTP status", () => {
    const texts = [...Object.values(TERMINAL_FAILURE_TEXT), terminalFailureSummary("budget-stop", BUDGET_RECORD)];
    for (const text of texts) {
      expect(text).not.toMatch(/error|exception|stack|traceback/i);
      expect(text).not.toMatch(/anthropic|openai|bedrock|ollama|provider/i);
      expect(text).not.toMatch(/\b(?:HTTP|40[0-9]|50[0-9])\b/);
      expect(text).not.toMatch(/ghp_|sk-|bearer/i);
    }
  });

  test("a budget stop without its typed record is a caller defect, named on the throw", () => {
    expect(() => terminalFailureSummary("budget-stop")).toThrow(/budgetExhaustion record/);
  });
});

describe("every terminal path persists a category (or deliberately none)", () => {
  const verdictMissed = decideConclusion({ proof: publication(), outcome: "expired", gate: GATE, review: review("needs fixes", 40) });
  const verdictMet = decideConclusion({ proof: publication(), outcome: "expired", gate: GATE, review: review("ship it", 90) });

  /** note: name → the conclusion the terminal path freezes + the category it must carry. */
  const paths: ReadonlyArray<{ path: string; decided: CheckConclusion; status: CheckFailureStatus | null }> = [
    // note: Execution faults with no readable result.
    { path: "pre-publication-failure", decided: decideConclusion({ proof: null, outcome: "pre-publication-failure", gate: GATE, review: null }), status: "unknown-failure" },
    { path: "degraded-not-posted", decided: decideConclusion({ proof: null, outcome: "degraded-not-posted", gate: GATE, review: null }), status: "unknown-failure" },
    { path: "publication-unknown", decided: decideConclusion({ proof: null, outcome: "publication-unknown", gate: GATE, review: null }), status: "unknown-failure" },
    { path: "expired-without-proof", decided: decideConclusion({ proof: null, outcome: "expired", gate: GATE, review: null }), status: "unknown-failure" },
    { path: "local-error", decided: decideConclusion({ proof: null, outcome: "local-error", gate: GATE, review: null }), status: "unknown-failure" },
    { path: "degraded-publication", decided: decideConclusion({ proof: publication({ kind: "degraded" }), outcome: "expired", gate: GATE, review: null }), status: "unknown-failure" },
    { path: "unreadable-gate", decided: decideConclusion({ proof: publication(), outcome: "expired", gate: null, review: review("ship it", 90) }), status: "unknown-failure" },
    { path: "unreadable-tally", decided: decideConclusion({ proof: publication(), outcome: "expired", gate: GATE, review: review("ship it", null) }), status: "unknown-failure" },
    {
      path: "inherited-unreadable-baseline",
      decided: decideConclusion({
        proof: null,
        outcome: "skipped",
        gate: GATE,
        review: null,
        inherited: { headSha: SHA, reviewedHeadSha: "fedcba9876543210fedcba9876543210fedcba98" },
      }),
      status: "unknown-failure",
    },
    // note: The wall-clock categories, keyed by the WINDOW the stop drew on and never
    // by the observer's `cause`: the same spent instant is reported as
    // `sandbox-kill` by the runner input write's kill and as `consumer-deadline`
    // by the refusal right after it.
    {
      path: "budget-stop: runner window, runner-deadline",
      decided: decideConclusion({ proof: null, outcome: "budget-exhausted", gate: null, review: null, budgetExhaustion: { ...BUDGET_RECORD, cause: "runner-deadline" } }),
      status: "budget-stop",
    },
    {
      path: "budget-stop: runner window, sandbox-kill",
      decided: decideConclusion({ proof: null, outcome: "budget-exhausted", gate: null, review: null, budgetExhaustion: { ...BUDGET_RECORD, cause: "sandbox-kill" } }),
      status: "budget-stop",
    },
    {
      path: "budget-stop: runner window, consumer-deadline",
      decided: decideConclusion({ proof: null, outcome: "budget-exhausted", gate: null, review: null, budgetExhaustion: { ...BUDGET_RECORD, cause: "consumer-deadline" } }),
      status: "budget-stop",
    },
    {
      path: "cap-stop: preparation window",
      decided: decideConclusion({
        proof: null,
        outcome: "budget-exhausted",
        gate: null,
        review: null,
        budgetExhaustion: { ...BUDGET_RECORD, cause: "consumer-deadline", budgetWindow: "preparation" },
      }),
      status: "cap-stop",
    },
    // note: Deliberate exceptions: a result, and a skip that is not a fault.
    { path: "gate-missed verdict", decided: verdictMissed, status: null },
    { path: "gate-met", decided: verdictMet, status: null },
    { path: "superseded", decided: decideConclusion({ proof: null, outcome: "superseded", gate: GATE, review: null, headSha: SHA }), status: null },
    { path: "skipped-neutral", decided: decideConclusion({ proof: null, outcome: "skipped", gate: GATE, review: null }), status: null },
  ];

  test("each terminal path carries the approved category, or none by design", () => {
    for (const { path, decided, status } of paths) {
      expect({ path, status: decided.failureStatus ?? null }).toEqual({ path, status });
      if (status !== null) {
        // note: A category IS the wording: the frozen text is that category's text.
        expect({ path, summary: decided.summary }).toEqual({
          path,
          summary: terminalFailureSummary(status, BUDGET_RECORD),
        });
        expect(decided.desired).toBe("failure");
      }
    }
  });

  test("a category is only ever written with a terminal conclusion", () => {
    // note: `CheckConclusion.desired` excludes `in_progress` by type, so no path can
    // pair a category with a waiting attempt; the DB round-trip below proves
    // the same at the row.
    for (const { decided } of paths) {
      expect(decided.desired).not.toBe("in_progress");
    }
  });

  test("the cap and the tier budget are never collapsed into one category", () => {
    const cap = paths.find((entry) => entry.path.startsWith("cap-stop"))!;
    const tier = paths.find((entry) => entry.path.startsWith("budget-stop"))!;
    expect(cap.status).not.toBe(tier.status);
    expect(cap.decided.summary).not.toBe(tier.decided.summary);
  });

  test("one spent instant maps to one category, whoever observed it", () => {
    // note: The runner input write is killed at the anchored deadline (`sandbox-kill`)
    // while the refusal right after it reports the Worker's cutoff
    // (`consumer-deadline`); both spent the SAME frozen runner window, so both
    // are one category.
    const sameInstant = (["runner-deadline", "sandbox-kill", "consumer-deadline"] as const).map((cause) =>
      decideConclusion({
        proof: null,
        outcome: "budget-exhausted",
        gate: null,
        review: null,
        budgetExhaustion: { ...BUDGET_RECORD, cause, budgetWindow: "runner" },
      }),
    );
    for (const decided of sameInstant) {
      expect(decided.failureStatus).toBe("budget-stop");
      expect(decided.summary).toBe(terminalFailureSummary("budget-stop", BUDGET_RECORD));
    }
    // note: The preparation window is a different fact, whatever its cause reads.
    for (const cause of ["consumer-deadline", "sandbox-kill"] as const) {
      const decided = decideConclusion({
        proof: null,
        outcome: "budget-exhausted",
        gate: null,
        review: null,
        budgetExhaustion: { ...BUDGET_RECORD, cause, budgetWindow: "preparation" },
      });
      expect(decided.failureStatus).toBe("cap-stop");
      expect(decided.summary).toBe(TERMINAL_FAILURE_TEXT["cap-stop"]);
    }
  });
});

describe("the category is frozen with the intent (migration 0087)", () => {
  test("a failure writes its category in the same statement as the intent", async () => {
    const db = seededDb();
    const { attemptId, lease } = await claimed(db);
    // note: A WAITING attempt carries none.
    expect((await getCheckAttempt(db, attemptId))!.terminalFailureStatus).toBeNull();

    const conclusion: CheckConclusion = {
      desired: "failure",
      title: CHECK_NAME,
      summary: TERMINAL_FAILURE_TEXT["unknown-failure"],
      failureStatus: "unknown-failure",
    };
    expect(await setCheckDesired(db, attemptId, lease, conclusion, null, T0)).toBe(true);

    const row = (await getCheckAttempt(db, attemptId))!;
    expect(row.desired).toBe("failure");
    expect(row.terminalFailureStatus).toBe("unknown-failure");
    // note: The frozen text is the approved wording, verbatim.
    const stored = (await db
      .prepare("SELECT desired_summary FROM review_checks WHERE id = ?")
      .bind(attemptId)
      .first()) as { desired_summary: string };
    expect(stored.desired_summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("a paused skip settles neutral WITH the paused category", async () => {
    const db = seededDb();
    const deliveryId = "delivery-paused";
    const { attemptId, lease } = await claimed(db, deliveryId);
    // note: Attach a proven run, then give the row back the way an attach does: the
    // settlement takes a released row its own delivery created.
    expect(await setCheckCreateState(db, attemptId, lease, "sending", undefined, T0)).toBe(true);
    expect(await attachCheckRunId(db, attemptId, lease, 4242, T0)).toBe(true);
    db.raw.prepare("UPDATE review_checks SET holder = NULL, lease_until_ms = NULL WHERE id = ?").run(attemptId);

    const lifecycle = createCheckLifecycle({
      db,
      nowMs: () => T0,
      // note: Store-only settlement: the paused gate must spend no credential.
      getAdapter: () => null,
      getCheckGate: async () => null,
    });
    expect(
      await lifecycle.settleSkipped({
        scope: SCOPE,
        headSha: SHA,
        triggeredBy: "octocat",
        action: "review",
        attachDeliveryId: deliveryId,
        reason: "review paused",
        paused: true,
      }),
    ).toBe(true);

    const row = (await getCheckAttempt(db, attemptId))!;
    expect(row.desired).toBe("neutral");
    expect(row.terminalFailureStatus).toBe("paused");
  });

  test("a proof correction to success clears the category", async () => {
    const db = seededDb();
    const { attemptId, lease } = await claimed(db);
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, created_ms, updated_ms)
         VALUES ('correction-proof', ?, ?, ?, ?, ?, ?, 'review', 'prepared', '{}', ?, ?)`,
      )
      .run(APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, T0, T0);
    expect(
      await setCheckDesired(
        db,
        attemptId,
        lease,
        { desired: "failure", title: CHECK_NAME, summary: TERMINAL_FAILURE_TEXT["unknown-failure"], failureStatus: "unknown-failure" },
        null,
        T0,
      ),
    ).toBe(true);
    expect(
      await setCheckDesired(
        db,
        attemptId,
        lease,
        { desired: "success", title: CHECK_NAME, summary: "Review gate met." },
        "correction-proof",
        T0,
      ),
    ).toBe(true);

    const row = (await getCheckAttempt(db, attemptId))!;
    expect(row.desired).toBe("success");
    expect(row.terminalFailureStatus).toBeNull();
  });

  test("a proof never rewrites a frozen stop category", async () => {
    // note: Both stops name WHY the attempt ended, so a prior generation's
    // publication is not evidence that can overwrite them.
    for (const status of ["cap-stop", "budget-stop"] as const) {
      const db = seededDb();
      const { attemptId, lease } = await claimed(db);
      db.raw
        .prepare(
          `INSERT INTO review_publications
             (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
              payload_json, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'review', 'prepared', '{}', ?, ?)`,
        )
        .run(`proof-${status}`, APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, T0, T0);
      const summary =
        status === "budget-stop" ? terminalFailureSummary("budget-stop", BUDGET_RECORD) : TERMINAL_FAILURE_TEXT["cap-stop"];
      expect(
        await setCheckDesired(
          db,
          attemptId,
          lease,
          { desired: "failure", title: CHECK_NAME, summary, failureStatus: status },
          null,
          T0,
        ),
      ).toBe(true);
      expect(await setCheckDesired(
        db,
        attemptId,
        lease,
        { desired: "success", title: CHECK_NAME, summary: "Review gate met." },
        `proof-${status}`,
        T0,
      )).toBe(false);

      const row = (await getCheckAttempt(db, attemptId))!;
      expect(row.desired).toBe("failure");
      expect(row.terminalFailureStatus).toBe(status);
      const stored = (await db
        .prepare("SELECT desired_summary FROM review_checks WHERE id = ?")
        .bind(attemptId)
        .first()) as { desired_summary: string };
      expect(stored.desired_summary).toBe(summary);
    }
  });

  test("the schema refuses a category outside the approved four", async () => {
    const db = seededDb();
    const { attemptId } = await claimed(db);
    expect(() =>
      db.raw.prepare("UPDATE review_checks SET terminal_failure_status = 'runner-timeout' WHERE id = ?").run(attemptId),
    ).toThrow(/CHECK constraint failed/i);
  });

  test("a same-failure replay leaves the frozen wording and category byte-identical", async () => {
    const db = seededDb();
    const { attemptId, lease } = await claimed(db);
    expect(
      await setCheckDesired(
        db,
        attemptId,
        lease,
        {
          desired: "failure",
          title: CHECK_NAME,
          summary: TERMINAL_FAILURE_TEXT["unknown-failure"],
          failureStatus: "unknown-failure",
        },
        null,
        T0,
      ),
    ).toBe(true);
    db.raw
      .prepare(
        `INSERT INTO review_publications
           (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
            payload_json, created_ms, updated_ms)
         VALUES ('replay-proof', ?, ?, ?, ?, ?, ?, 'review', 'prepared', '{}', ?, ?)`,
      )
      .run(APP_ID, SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA, T0, T0);

    // note: A second writer with the SAME desired but its own text and category: the
    // frozen intent is what the user may already have seen, so only the proof
    // link moves.
    expect(
      await setCheckDesired(
        db,
        attemptId,
        lease,
        { desired: "failure", title: "another title", summary: TERMINAL_FAILURE_TEXT["cap-stop"], failureStatus: "cap-stop" },
        "replay-proof",
        T0,
      ),
    ).toBe(true);

    const row = (await getCheckAttempt(db, attemptId))!;
    expect(row.terminalFailureStatus).toBe("unknown-failure");
    expect(row.publicationId).toBe("replay-proof");
    const stored = (await db
      .prepare("SELECT desired_title, desired_summary FROM review_checks WHERE id = ?")
      .bind(attemptId)
      .first()) as { desired_title: string; desired_summary: string };
    expect(stored.desired_title).toBe(CHECK_NAME);
    expect(stored.desired_summary).toBe(TERMINAL_FAILURE_TEXT["unknown-failure"]);
  });

  test("an expired lease leaves the known category recoverable under the recovery claim", async () => {
    const db = seededDb();
    const { attemptId } = await claimed(db);
    // note: The attempt's own deadline ran out with nothing frozen, so its execution
    // lease is dead: the recovery lease is the only way to record what we know.
    const later = DEADLINE + 1;
    const recovery = await claimCheckRecovery(db, attemptId, "recovery:fixture", later);
    expect(recovery).not.toBeNull();
    expect(
      await setCheckDesired(
        db,
        attemptId,
        recovery!,
        {
          desired: "failure",
          title: CHECK_NAME,
          summary: terminalFailureSummary("cap-stop", BUDGET_RECORD),
          failureStatus: "cap-stop",
        },
        null,
        later,
      ),
    ).toBe(true);
    expect(await releaseCheckClaim(db, attemptId, recovery!, later)).toBe(true);

    const row = (await getCheckAttempt(db, attemptId))!;
    expect(row.desired).toBe("failure");
    expect(row.terminalFailureStatus).toBe("cap-stop");
    // note: Immediately due: a frozen intent needs no due time, so the minute lane
    // can deliver the approved wording instead of concluding an unknown failure.
    const due = await listCheckReconcileBatch(db, later);
    expect(due.map((attempt) => attempt.identity.attemptId)).toContain(attemptId);
  });
});
