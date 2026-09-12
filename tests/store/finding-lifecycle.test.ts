/**
 * Finding lifecycle store tests (plan 67 Task 1, spec review-lifecycle
 * §7.1/§7.2/§7.7/§7.11.1) — `src/store/finding-lifecycle.ts` against the
 * bun:sqlite double running the real migration SQL (0001 → 0020 via
 * createMigratedTestD1; DDL single sources).
 *
 * Behaviors covered (brief verification list):
 *   - pre-publication staging round-trip; insert conflict returns the
 *     existing IMMUTABLE payload (same id or same scope+SHA+kind); oversize
 *     payload rejected, never truncated
 *   - epoch-fenced claims: live lease blocks, expiry re-claims with a new
 *     epoch, prepared → sending on claim, attempts counted
 *   - proof recording fail-closed on holder/epoch/publication mismatch;
 *     readPublicationProof by exact scope/SHA (review preferred over
 *     degraded, requested id preferred)
 *   - proof-gated idempotent apply: store.put first, ONE lifecycle batch,
 *     applied mark under the lease; degraded proof creates no review or
 *     lifecycle rows; apply is lease- and proof-gated; replay (including a
 *     replay after store.put but before the lifecycle apply) never
 *     duplicates findings, rounds or reopen counts
 *   - recurrence reopen retains the original + assessment history and never
 *     touches the old association beyond the supersede marker
 *   - identity drift is a row-keyed unverifiable annotation — the row stays
 *     open, no auto-fail, last_assessment records `identity-drift`
 *   - fair rotation: open rows oldest-waiting first, LIMIT caps at
 *     ASSESSMENT_TARGET_CAP, selected rows advance past the cap, the
 *     unselected remainder keeps its place
 *   - resolution queue selects rows with no attempt yet; superseded,
 *     unverified, leased, capped and non-queue states are excluded
 *   - tenant/App isolation on every scope-bound face; operator retry
 *     resets bookkeeping while retaining payload/proof/epochs and never
 *     waives gates
 *   - private-journal regression as CONSUMER-VISIBLE behavior: staged rows
 *     are unreachable through the reviewer-visible result read (reviews/
 *     findings) before confirmation AND after apply the journal payload
 *     (publication id, lifecycle coverage, line intents) never surfaces
 *     through it
 */
import { describe, expect, test } from "bun:test";
import type { MstarReviewFinding, MstarReviewV1 } from "@mstar-harness/engine";
import {
  applyPublishedLifecycle,
  claimPublication,
  countOpenFindings,
  listPublicationRecovery,
  listResolutionRecovery,
  PUBLICATION_LEASE_MS,
  PUBLICATION_MAX_BYTES,
  readPublicationProof,
  recordPublicationProof,
  retryLifecycleWork,
  selectAssessmentTargets,
  stagePublication,
  type LifecycleRound,
  type LineIntent,
  type Lease,
  type PublicationPayload,
  type PublicationProof,
} from "../../src/store/finding-lifecycle";
import type { Scope } from "../../src/contracts/recheck";
import { createArtifactStore, type ReviewArtifactDoc } from "../../src/store/artifact-store";
import { idemKey } from "../../src/contracts/idem";
import { createMigratedTestD1, type TestD1 } from "./helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "ffffffffffffffffffffffffffffffffffffffff";

function seedAppRow(db: TestD1, id: string, githubAppId = 1001): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, `lifecycle-test-${id}`, githubAppId, `lifecycle-test-${id}`);
}

function createSeededTestD1(): TestD1 {
  const db = createMigratedTestD1();
  seedAppRow(db, APP_ID);
  seedAppRow(db, OTHER_APP_ID, 1002);
  return db;
}

function enginePayload(overrides: Partial<MstarReviewV1> = {}): MstarReviewV1 {
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
    ...overrides,
  };
}

function artifactDoc(overrides: Partial<ReviewArtifactDoc> = {}): ReviewArtifactDoc {
  return {
    kind: "review",
    key: idemKey({ installation_id: SCOPE.installationId, owner: SCOPE.owner, repo: SCOPE.repo, pr_number: SCOPE.prNumber, head_sha: SHA }),
    schema: "mstar.review/v1",
    payload: enginePayload(),
    appId: APP_ID,
    ...overrides,
  };
}

function originalFinding() {
  return {
    title: "Null deref risk",
    body: "Dereferencing possibly-null value.",
    filePath: "src/a.ts",
    lineStart: 10,
    lineEnd: 12,
    mergeClass: "should-fix" as const,
    category: "logic",
    fingerprintHint: "fp-1",
  };
}

function seenEntry(rowId: string, findingId: string) {
  return { rowId, findingId, original: originalFinding() };
}

function intent(associationId: string, findingRowId: string, publicationId: string, round: number): LineIntent {
  return {
    associationId,
    findingRowId,
    publicationId,
    scope: SCOPE,
    originalSha: SHA,
    round,
    path: "src/a.ts",
    line: 10,
    body: "Please fix this.",
    bodySha256: "a".repeat(64),
  };
}

function lifecycleRound(overrides: Partial<LifecycleRound> = {}): LifecycleRound {
  return {
    selectedRowIds: [],
    assessments: [],
    seen: [],
    resolutions: [],
    coverage: { totalOpen: 0, selected: 0, assessed: 0, omitted: 0, capped: 0, contextCoverage: "complete" },
    ...overrides,
  };
}

function payload(overrides: Partial<PublicationPayload> = {}): PublicationPayload {
  return {
    version: 1,
    scope: SCOPE,
    headSha: SHA,
    kind: "review",
    round: 1,
    targetCommentId: null,
    body: "review body",
    bodySha256: "b".repeat(64),
    artifact: artifactDoc(),
    lifecycle: lifecycleRound(),
    lineIntents: [],
    ...overrides,
  };
}

function proof(id: string, pay: PublicationPayload, confirmedMs: number): PublicationProof {
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

/** stage → claim → record proof; returns the live lease. */
async function stageClaimProve(db: TestD1, id: string, pay: PublicationPayload, nowMs: number): Promise<Lease> {
  await stagePublication(db, { id, payload: pay, nowMs });
  const lease = await claimPublication(db, id, "consumer", nowMs + 1);
  if (lease === null) throw new Error("test setup: claim failed");
  const recorded = await recordPublicationProof(db, id, lease, proof(id, pay, nowMs + 2));
  if (!recorded) throw new Error("test setup: proof recording failed");
  return lease;
}

function publicationRow(db: TestD1, id: string): {
  phase: string; recovery_state: string; attempts: number; holder: string | null;
  lease_epoch: number; proof_json: string | null; applied_ms: number | null; confirmed_ms: number | null;
} {
  return db.raw.prepare("SELECT phase, recovery_state, attempts, holder, lease_epoch, proof_json, applied_ms, confirmed_ms FROM review_publications WHERE id = ?").get(id) as never;
}

describe("stagePublication (spec §7.7 staging)", () => {
  test("round-trips the complete payload as a prepared, pending, unleased row", async () => {
    const db = createSeededTestD1();
    const pay = payload();
    const row = await stagePublication(db, { id: "pub-1", payload: pay, nowMs: 1000 });

    expect(row.id).toBe("pub-1");
    expect(row.phase).toBe("prepared");
    expect(row.recoveryState).toBe("pending");
    expect(row.lease).toBeNull();
    expect(row.proof).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptMs).toBeNull();
    expect(row.payload).toEqual(pay);

    // Due for recovery selection immediately (no attempt yet, no lease).
    const recovery = await listPublicationRecovery(db, 2000, 10);
    expect(recovery.map((r) => r.id)).toEqual(["pub-1"]);
  });

  test("an insert conflict returns the existing IMMUTABLE payload (same id)", async () => {
    const db = createSeededTestD1();
    const first = await stagePublication(db, { id: "pub-1", payload: payload({ body: "first body" }), nowMs: 1000 });
    const second = await stagePublication(db, { id: "pub-1", payload: payload({ body: "second body" }), nowMs: 2000 });

    expect(second.id).toBe("pub-1");
    expect(second.payload.body).toBe("first body");
    expect(second).toEqual(first);
  });

  test("a second model result for the same scope+SHA+kind under a new id never overwrites", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload({ body: "first body" }), nowMs: 1000 });
    const second = await stagePublication(db, { id: "pub-2", payload: payload({ body: "second body" }), nowMs: 2000 });

    expect(second.id).toBe("pub-1");
    expect(second.payload.body).toBe("first body");
  });

  test("an oversize payload is rejected, never truncated", async () => {
    const db = createSeededTestD1();
    const oversized = payload({ body: "x".repeat(PUBLICATION_MAX_BYTES + 16) });
    await expect(stagePublication(db, { id: "pub-big", payload: oversized, nowMs: 1000 })).rejects.toThrow(/journal cap/);
    const count = db.raw.query("SELECT COUNT(*) AS n FROM review_publications").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("claimPublication / recordPublicationProof (spec §7.7 step 8)", () => {
  test("claim is epoch-fenced: live lease blocks, expiry re-claims with a new epoch", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });

    const lease1 = await claimPublication(db, "pub-1", "consumer", 2000);
    expect(lease1).toEqual({ holder: "consumer", epoch: 1, untilMs: 2000 + PUBLICATION_LEASE_MS });
    // prepared → sending on claim; one attempt counted.
    expect(publicationRow(db, "pub-1").phase).toBe("sending");
    expect(publicationRow(db, "pub-1").attempts).toBe(1);

    // Another holder (or the same one) cannot claim a live lease.
    expect(await claimPublication(db, "pub-1", "recovery", 3000)).toBeNull();

    // After expiry the recovery lane wins with epoch 2.
    const lease2 = await claimPublication(db, "pub-1", "recovery", 2000 + PUBLICATION_LEASE_MS + 1);
    expect(lease2).toEqual({ holder: "recovery", epoch: 2, untilMs: 2000 + PUBLICATION_LEASE_MS + 1 + PUBLICATION_LEASE_MS });
    expect(publicationRow(db, "pub-1").attempts).toBe(2);
  });

  test("claim refuses terminal phases (applied)", async () => {
    const db = createSeededTestD1();
    const lease = await stageClaimProve(db, "pub-1", payload(), 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);
    expect(await claimPublication(db, "pub-1", "recovery", 3000)).toBeNull();
  });

  test("proof recording fails closed on holder/epoch/publication mismatch", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    const lease = (await claimPublication(db, "pub-1", "consumer", 2000)) ?? (() => { throw new Error("setup"); })();
    const p = proof("pub-1", payload(), 3000);

    expect(await recordPublicationProof(db, "pub-1", { holder: "someone-else", epoch: lease.epoch, untilMs: lease.untilMs }, p)).toBe(false);
    expect(await recordPublicationProof(db, "pub-1", { holder: "consumer", epoch: lease.epoch + 7, untilMs: lease.untilMs }, p)).toBe(false);
    expect(
      await recordPublicationProof(db, "pub-1", lease, { ...p, publicationId: "pub-other" }),
    ).toBe(false);
    expect(publicationRow(db, "pub-1").phase).toBe("sending");
    expect(publicationRow(db, "pub-1").proof_json).toBeNull();

    expect(await recordPublicationProof(db, "pub-1", lease, p)).toBe(true);
    expect(publicationRow(db, "pub-1").phase).toBe("confirmed");
    expect(publicationRow(db, "pub-1").confirmed_ms).toBe(3000);
  });

  test("readPublicationProof reads by exact scope/SHA, preferring review and the requested id", async () => {
    const db = createSeededTestD1();
    await stageClaimProve(db, "pub-rev", payload({ kind: "review" }), 1000);
    await stageClaimProve(db, "pub-deg", payload({ kind: "degraded", artifact: null, lifecycle: null, lineIntents: [] }), 1000);

    // Review proof takes precedence over degraded within the exact scope/SHA.
    const byScope = await readPublicationProof(db, { scope: SCOPE, headSha: SHA });
    expect(byScope?.publicationId).toBe("pub-rev");
    expect(byScope?.kind).toBe("review");

    // The requested publication id is preferred.
    const byId = await readPublicationProof(db, { scope: SCOPE, headSha: SHA, publicationId: "pub-deg" });
    expect(byId?.publicationId).toBe("pub-deg");
    expect(byId?.kind).toBe("degraded");

    // Foreign scope/SHA proves nothing.
    expect(await readPublicationProof(db, { scope: SCOPE, headSha: SHA2 })).toBeNull();
    expect(await readPublicationProof(db, { scope: { ...SCOPE, repo: "other" }, headSha: SHA })).toBeNull();
  });
});

describe("applyPublishedLifecycle (spec §7.2 state machine + §7.7 step 9)", () => {
  test("happy path: store.put rows + lifecycle rows + applied mark in order", async () => {
    const db = createSeededTestD1();
    const pay = payload({
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
        coverage: { totalOpen: 1, selected: 1, assessed: 1, omitted: 0, capped: 0, contextCoverage: "complete" },
      }),
      lineIntents: [intent("assoc-1", "row-1", "pub-1", 1)],
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);

    // Publication applied under the lease, recovery done, lease released.
    const pub = publicationRow(db, "pub-1");
    expect(pub.phase).toBe("applied");
    expect(pub.recovery_state).toBe("done");
    expect(pub.holder).toBeNull();
    expect(pub.applied_ms).toBe(2000);

    // store.put wrote the public result rows (envelope + finding).
    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(1);
    const publicFindings = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(publicFindings.n).toBe(1);

    // Lifecycle rows: one open finding, one round history, one intent.
    const finding = db.raw.prepare("SELECT * FROM review_findings WHERE id = 'row-1'").get() as {
      state: string; reopen_count: number; first_publication_id: string; last_publication_id: string;
      first_seen_round: number; last_seen_round: number; last_assessed_ms: number | null; last_scheduled_ms: number | null;
    };
    expect(finding.state).toBe("open");
    expect(finding.reopen_count).toBe(0);
    expect(finding.first_publication_id).toBe("pub-1");
    expect(finding.last_publication_id).toBe("pub-1");
    expect(finding.first_seen_round).toBe(1);
    expect(finding.last_seen_round).toBe(1);
    expect(finding.last_assessed_ms).toBe(2000);
    expect(finding.last_scheduled_ms).toBe(2000);

    const rounds = db.raw.query("SELECT publication_id, round FROM review_finding_rounds").all() as Array<{ publication_id: string; round: number }>;
    expect(rounds).toEqual([{ publication_id: "pub-1", round: 1 }]);

    const thread = db.raw.prepare("SELECT resolution_state, superseded_by_publication_id, intent_json FROM review_threads WHERE id = 'assoc-1'").get() as {
      resolution_state: string; superseded_by_publication_id: string | null; intent_json: string;
    };
    expect(thread.resolution_state).toBe("pending");
    expect(thread.superseded_by_publication_id).toBeNull();
    expect(JSON.parse(thread.intent_json).associationId).toBe("assoc-1");

    // Applied publications leave the recovery lane.
    expect(await listPublicationRecovery(db, 3000, 10)).toEqual([]);
  });

  test("apply is proof-gated and lease-gated", async () => {
    const db = createSeededTestD1();
    const pay = payload({ lifecycle: lifecycleRound({ seen: [seenEntry("row-1", "f-1")] }) });
    await stagePublication(db, { id: "pub-1", payload: pay, nowMs: 1000 });
    const lease = await claimPublication(db, "pub-1", "consumer", 2000);
    if (lease === null) throw new Error("setup");

    // No proof yet — apply refuses.
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 3000)).toBe(false);
    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(0);

    await recordPublicationProof(db, "pub-1", lease, proof("pub-1", pay, 2500));

    // Wrong holder / wrong epoch / expired lease — all refuse.
    expect(await applyPublishedLifecycle(db, "pub-1", { holder: "other", epoch: lease.epoch, untilMs: lease.untilMs }, 3000)).toBe(false);
    expect(await applyPublishedLifecycle(db, "pub-1", { holder: "consumer", epoch: lease.epoch + 1, untilMs: lease.untilMs }, 3000)).toBe(false);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, lease.untilMs + 1)).toBe(false);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n).toBe(0);

    expect(await applyPublishedLifecycle(db, "pub-1", lease, 3000)).toBe(true);
  });

  test("idempotent replay: a second apply changes nothing", async () => {
    const db = createSeededTestD1();
    const pay = payload({
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      }),
      lineIntents: [intent("assoc-1", "row-1", "pub-1", 1)],
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 5000)).toBe(true); // idempotent short-circuit

    const counts = (table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(counts("reviews")).toBe(1);
    expect(counts("findings")).toBe(1);
    expect(counts("review_findings")).toBe(1);
    expect(counts("review_finding_rounds")).toBe(1);
    expect(counts("review_threads")).toBe(1);
    expect((db.raw.prepare("SELECT reopen_count FROM review_findings WHERE id = 'row-1'").get() as { reopen_count: number }).reopen_count).toBe(0);
  });

  test("replay after store.put but before the lifecycle apply does not duplicate findings", async () => {
    const db = createSeededTestD1();
    const pay = payload({
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      }),
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    // Simulate the crash window: the atomic store.put committed, the
    // lifecycle batch never ran.
    const store = createArtifactStore(db);
    await store.put(pay.artifact!);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(1);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n).toBe(0);

    // Recovery replays: store.put is a UNIQUE no-op, the lifecycle batch
    // applies once.
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 3000)).toBe(true);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(1);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number }).n).toBe(1);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n).toBe(1);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_finding_rounds").get() as { n: number }).n).toBe(1);
  });

  test("degraded proof creates no normal review or lifecycle rows", async () => {
    const db = createSeededTestD1();
    const pay = payload({ kind: "degraded", artifact: null, lifecycle: null, lineIntents: [] });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(0);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number }).n).toBe(0);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n).toBe(0);
    const pub = publicationRow(db, "pub-1");
    expect(pub.phase).toBe("applied");
    expect(pub.recovery_state).toBe("done");
  });

  test("a review-kind payload missing its artifact/lifecycle fails closed", async () => {
    const db = createSeededTestD1();
    const lease = await stageClaimProve(db, "pub-1", payload({ artifact: null, lifecycle: null }), 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(false);
    expect(publicationRow(db, "pub-1").phase).toBe("confirmed");
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(0);
  });
});

describe("recurrence reopen and identity drift (spec §7.2)", () => {
  test("recurrence reopens a closed concern, retains history, and never touches the old thread", async () => {
    const db = createSeededTestD1();
    // Round 1: the concern is reported, assessed addressed, line comment
    // intent assoc-1 preallocated.
    const pay1 = payload({
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "addressed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      }),
      lineIntents: [intent("assoc-1", "row-1", "pub-1", 1)],
    });
    const lease1 = await stageClaimProve(db, "pub-1", pay1, 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease1, 2000)).toBe(true);
    expect((db.raw.prepare("SELECT state FROM review_findings WHERE id = 'row-1'").get() as { state: string }).state).toBe("addressed");

    // T4 persisted a verified resolution snapshot on assoc-1 before the
    // inline attempt (raw write — the T4 surface owns this transition).
    db.raw.prepare("UPDATE review_threads SET verified_json = '{\"snapshot\":1}' WHERE id = 'assoc-1'").run();

    // Round 2 at a new SHA: the same fingerprint is reported again (no
    // assessment selected — capped).
    const pay2 = payload({
      headSha: SHA2,
      round: 2,
      artifact: artifactDoc({
        key: idemKey({ installation_id: SCOPE.installationId, owner: SCOPE.owner, repo: SCOPE.repo, pr_number: SCOPE.prNumber, head_sha: SHA2 }),
        payload: enginePayload({ summary_md: "Recurring." }),
      }),
      lifecycle: lifecycleRound({
        seen: [seenEntry("row-1", "f-1")],
        coverage: { totalOpen: 1, selected: 0, assessed: 0, omitted: 0, capped: 1, contextCoverage: "complete" },
      }),
      lineIntents: [intent("assoc-2", "row-1", "pub-2", 2)],
    });
    const lease2 = await stageClaimProve(db, "pub-2", pay2, 10_000);
    expect(await applyPublishedLifecycle(db, "pub-2", lease2, 11_000)).toBe(true);

    const row = db.raw.prepare("SELECT * FROM review_findings WHERE id = 'row-1'").get() as {
      state: string; reopen_count: number; original_json: string; first_publication_id: string;
      first_seen_round: number; last_seen_round: number; last_publication_id: string; last_assessment_json: string | null;
    };
    // Reopened at the new round; original and round-1 assessment history retained.
    expect(row.state).toBe("open");
    expect(row.reopen_count).toBe(1);
    expect(JSON.parse(row.original_json).title).toBe("Null deref risk");
    expect(row.first_publication_id).toBe("pub-1");
    expect(row.first_seen_round).toBe(1);
    expect(row.last_seen_round).toBe(2);
    expect(row.last_publication_id).toBe("pub-2");
    expect(row.last_assessment_json !== null && JSON.parse(row.last_assessment_json).reason === "verified-fix").toBe(true);

    // The old association: superseded marker ONLY — remote identity,
    // resolution state, verified snapshot and attempts untouched.
    const oldThread = db.raw.prepare("SELECT * FROM review_threads WHERE id = 'assoc-1'").get() as {
      superseded_by_publication_id: string | null; resolution_state: string; verified_json: string | null;
      comment_id: number | null; thread_id: string | null; attempts: number;
    };
    expect(oldThread.superseded_by_publication_id).toBe("pub-2");
    expect(oldThread.resolution_state).toBe("pending");
    expect(oldThread.verified_json).toBe("{\"snapshot\":1}");
    expect(oldThread.comment_id).toBeNull();
    expect(oldThread.thread_id).toBeNull();
    expect(oldThread.attempts).toBe(0);

    // The fresh association is the live one.
    const newThread = db.raw.prepare("SELECT superseded_by_publication_id, round FROM review_threads WHERE id = 'assoc-2'").get() as {
      superseded_by_publication_id: string | null; round: number;
    };
    expect(newThread.superseded_by_publication_id).toBeNull();
    expect(newThread.round).toBe(2);

    // Resolution queue: the superseded row is out even though it still has
    // a verified snapshot; the fresh association has none yet.
    expect(await listResolutionRecovery(db, 12_000, 10)).toEqual([]);
  });

  test("identity drift is a row-keyed unverifiable annotation — the row stays open", async () => {
    const db = createSeededTestD1();
    const pay1 = payload({
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      }),
    });
    const lease1 = await stageClaimProve(db, "pub-1", pay1, 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease1, 2000)).toBe(true);

    // Round 2: changed fingerprint hint, contradictory concern — the
    // assessment is keyed to the SAME row and conservatively unverifiable.
    const pay2 = payload({
      headSha: SHA2,
      round: 2,
      artifact: artifactDoc({
        key: idemKey({ installation_id: SCOPE.installationId, owner: SCOPE.owner, repo: SCOPE.repo, pr_number: SCOPE.prNumber, head_sha: SHA2 }),
      }),
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "unverifiable", reason: "identity-drift", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      }),
    });
    const lease2 = await stageClaimProve(db, "pub-2", pay2, 10_000);
    expect(await applyPublishedLifecycle(db, "pub-2", lease2, 11_000)).toBe(true);

    const row = db.raw.prepare("SELECT * FROM review_findings WHERE id = 'row-1'").get() as {
      state: string; reopen_count: number; last_assessment_json: string | null; last_assessed_ms: number | null;
    };
    // No auto-fail: the row-keyed identity survived; the drift is an
    // annotation for display, not a ban.
    expect(row.state).toBe("open");
    expect(row.reopen_count).toBe(0);
    expect(row.last_assessment_json !== null && JSON.parse(row.last_assessment_json).reason).toBe("identity-drift");
    expect(row.last_assessed_ms).toBe(11_000);

    // Both rounds' assessment history is retained.
    const rounds = db.raw.query("SELECT round FROM review_finding_rounds WHERE finding_row_id = 'row-1' ORDER BY round").all() as Array<{ round: number }>;
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
  });

  test("an addressed assessment in the same round re-closes a reopened row", async () => {
    const db = createSeededTestD1();
    const pay1 = payload({
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "addressed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      }),
    });
    const lease1 = await stageClaimProve(db, "pub-1", pay1, 1000);
    await applyPublishedLifecycle(db, "pub-1", lease1, 2000);

    // Round 2 reports the fingerprint again AND verifies the fix.
    const pay2 = payload({
      headSha: SHA2,
      round: 2,
      artifact: artifactDoc({
        key: idemKey({ installation_id: SCOPE.installationId, owner: SCOPE.owner, repo: SCOPE.repo, pr_number: SCOPE.prNumber, head_sha: SHA2 }),
      }),
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "addressed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
      }),
    });
    const lease2 = await stageClaimProve(db, "pub-2", pay2, 10_000);
    await applyPublishedLifecycle(db, "pub-2", lease2, 11_000);

    const row = db.raw.prepare("SELECT state, reopen_count FROM review_findings WHERE id = 'row-1'").get() as {
      state: string; reopen_count: number;
    };
    // The recurrence happened (reopen counted), then this round's verified
    // assessment closed it again — recurrence never overrides re-verified evidence.
    expect(row.reopen_count).toBe(1);
    expect(row.state).toBe("addressed");
  });
});

describe("fair rotation (spec §7.2)", () => {
  test("open rows select oldest-waiting first, capped at 25; applying a confirmed publication advances past the cap", async () => {
    const db = createSeededTestD1();
    // A staged publication provides the FK parent for 26 raw lifecycle rows.
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    for (let i = 1; i <= 26; i++) {
      db.raw
        .prepare(
          `INSERT INTO review_findings
             (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
              first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
              first_seen_round, last_seen_round, state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', ?, ?)`,
        )
        .run(`row-${i}`, APP_ID, 123, "acme", "widgets", 42, `f-${i}`, JSON.stringify(originalFinding()), SHA, SHA, i * 10, i * 10);
    }

    expect(await countOpenFindings(db, SCOPE)).toBe(26);

    // LIMIT caps at ASSESSMENT_TARGET_CAP even if a caller asks for more.
    const selected = await selectAssessmentTargets(db, SCOPE, 500);
    expect(selected).toHaveLength(25);
    expect(selected.map((t) => t.rowId)).toEqual(Array.from({ length: 25 }, (_, i) => `row-${i + 1}`));
    // Targets carry the ORIGINAL concern, not a title.
    expect(selected[0]!.original.body).toBe("Dereferencing possibly-null value.");

    // The confirmed publication applies: the 25 selected targets advance
    // last_scheduled_ms; the unselected remainder keeps its place.
    const pay = payload({
      headSha: SHA2,
      artifact: artifactDoc({
        key: idemKey({ installation_id: SCOPE.installationId, owner: SCOPE.owner, repo: SCOPE.repo, pr_number: SCOPE.prNumber, head_sha: SHA2 }),
      }),
      lifecycle: lifecycleRound({
        selectedRowIds: selected.map((t) => t.rowId),
        seen: selected.map((t) => seenEntry(t.rowId, t.findingId)),
        coverage: { totalOpen: 26, selected: 25, assessed: 0, omitted: 25, capped: 0, contextCoverage: "complete" },
      }),
    });
    const lease = await stageClaimProve(db, "pub-2", pay, 100_000);
    expect(await applyPublishedLifecycle(db, "pub-2", lease, 100_000)).toBe(true);

    // Still 26 open (omitted outputs stay open), but the queue rotated:
    // the previously unselected row-26 is now first, and every later entry
    // is one of the previously selected rows now waiting behind it (the
    // cap still holds — one of the 25 rotated rows is truncated by LIMIT).
    expect(await countOpenFindings(db, SCOPE)).toBe(26);
    const next = await selectAssessmentTargets(db, SCOPE, 25);
    expect(next).toHaveLength(25);
    expect(next[0]!.rowId).toBe("row-26");
    const previouslySelected = new Set(selected.map((t) => t.rowId));
    for (const target of next.slice(1)) {
      expect(previouslySelected.has(target.rowId)).toBe(true);
    }
  });

  test("a reopened row enters at the current time behind already-waiting rows", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    const insertFinding = (id: string, findingId: string, createdMs: number, state: string) =>
      db.raw
        .prepare(
          `INSERT INTO review_findings
             (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
              first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
              first_seen_round, last_seen_round, state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pub-1', 'pub-1', ?, ?, 1, 1, ?, ?, ?)`,
        )
        .run(id, APP_ID, 123, "acme", "widgets", 42, findingId, JSON.stringify(originalFinding()), SHA, SHA, state, createdMs, createdMs);
    insertFinding("row-old", "f-old", 1000, "open"); // waiting since 1000
    insertFinding("row-closed", "f-closed", 2000, "addressed"); // closed earlier
    insertFinding("row-newer", "f-newer", 5000, "open");

    // pub-2 re-reports row-closed (recurrence) — it must enter the queue at
    // nowMs, BEHIND row-old and row-newer... no: at current time (10_000),
    // which is after every existing waiter.
    const pay = payload({
      headSha: SHA2,
      round: 2,
      artifact: artifactDoc({
        key: idemKey({ installation_id: SCOPE.installationId, owner: SCOPE.owner, repo: SCOPE.repo, pr_number: SCOPE.prNumber, head_sha: SHA2 }),
      }),
      lifecycle: lifecycleRound({
        seen: [seenEntry("row-closed", "f-closed")],
      }),
    });
    const lease = await stageClaimProve(db, "pub-2", pay, 10_000);
    await applyPublishedLifecycle(db, "pub-2", lease, 10_000);

    const order = await selectAssessmentTargets(db, SCOPE, 25);
    expect(order.map((t) => t.rowId)).toEqual(["row-old", "row-newer", "row-closed"]);
  });
});

describe("resolution queue selection (spec §7.11.1)", () => {
  async function seedThread(
    db: TestD1,
    id: string,
    overrides: Partial<Record<string, unknown>> = {},
  ): Promise<void> {
    // One shared FK parent publication; re-staging is an idempotent no-op.
    await stagePublication(db, { id: "pub-seed", payload: payload(), nowMs: 1000 });
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pub-seed', 'pub-seed', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(`finding-for-${id}`, APP_ID, 123, "acme", "widgets", 42, `f-${id}`, JSON.stringify(originalFinding()), SHA, SHA);
    const row = {
      id,
      finding_row_id: `finding-for-${id}`,
      publication_id: "pub-seed",
      app_id: APP_ID,
      installation_id: 123,
      owner: "acme",
      repo: "widgets",
      pr_number: 42,
      original_sha: SHA,
      round: 1,
      intent_json: "{}",
      resolution_state: "pending",
      verified_json: "{\"snapshot\":1}",
      attempts: 0,
      next_attempt_ms: null as number | null,
      holder: null as string | null,
      lease_until_ms: null as number | null,
      superseded_by_publication_id: null as string | null,
      created_ms: 1000,
      ...overrides,
    };
    db.raw
      .prepare(
        `INSERT INTO review_threads
           (id, finding_row_id, publication_id, app_id, installation_id, owner, repo, pr_number,
            original_sha, round, intent_json, resolution_state, verified_json, attempts,
            next_attempt_ms, holder, lease_until_ms, superseded_by_publication_id, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.finding_row_id, row.publication_id, row.app_id, row.installation_id,
        row.owner, row.repo, row.pr_number, row.original_sha, row.round, row.intent_json,
        row.resolution_state, row.verified_json, row.attempts, row.next_attempt_ms,
        row.holder, row.lease_until_ms, row.superseded_by_publication_id, row.created_ms, row.created_ms,
      );
  }

  test("selects rows with no attempt yet; excludes superseded/unverified/leased/capped/non-queue rows", async () => {
    const db = createSeededTestD1();
    await seedThread(db, "t-due", { created_ms: 1000 }); // pending, verified, no attempt → due
    await seedThread(db, "t-superseded", { created_ms: 2000, superseded_by_publication_id: "pub-x" });
    await seedThread(db, "t-unverified", { created_ms: 3000, verified_json: null });
    await seedThread(db, "t-needs-recheck", { created_ms: 4000, resolution_state: "needs-recheck" });
    await seedThread(db, "t-leased", { created_ms: 5000, holder: "m8", lease_until_ms: 99_000 });
    await seedThread(db, "t-capped", { created_ms: 6000, attempts: 5 });
    await seedThread(db, "t-future", { created_ms: 7000, next_attempt_ms: 200_000 });
    await seedThread(db, "t-retry", { created_ms: 8000, resolution_state: "retry" });

    const queue = await listResolutionRecovery(db, 10_000, 10);
    expect(queue).toEqual([
      { associationId: "t-due", scope: SCOPE },
      { associationId: "t-retry", scope: SCOPE },
    ]);
  });

  test("expired leases re-enter the queue; scopes are bound per row", async () => {
    const db = createSeededTestD1();
    await seedThread(db, "t-expired", { holder: "m8", lease_until_ms: 5000 });
    const queue = await listResolutionRecovery(db, 6000, 10);
    expect(queue.map((q) => q.associationId)).toEqual(["t-expired"]);
    expect(queue[0]!.scope).toEqual(SCOPE);
  });
});

describe("tenant/App isolation", () => {
  test("scope-bound faces never return another App's or repo's rows", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES ('row-other-app', ?, ?, ?, ?, ?, 'f-1', ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(OTHER_APP_ID, 123, "acme", "widgets", 42, JSON.stringify(originalFinding()), SHA, SHA);

    // Another row under the SAME app but a different repo.
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES ('row-other-repo', ?, ?, ?, ?, ?, 'f-1', ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(APP_ID, 123, "acme", "other-repo", 42, JSON.stringify(originalFinding()), SHA, SHA);

    expect(await countOpenFindings(db, SCOPE)).toBe(0);
    expect(await selectAssessmentTargets(db, SCOPE, 25)).toEqual([]);
    expect(await readPublicationProof(db, { scope: { ...SCOPE, appId: OTHER_APP_ID }, headSha: SHA })).toBeNull();
    expect(await readPublicationProof(db, { scope: SCOPE, headSha: SHA })).toBeNull(); // staged ≠ proven
  });

  test("operator retry with a mismatched scope is refused", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    expect(
      await retryLifecycleWork(db, { scope: { ...SCOPE, repo: "other" }, publicationId: "pub-1", nowMs: 2000 }),
    ).toBe(false);
  });
});

describe("retryLifecycleWork (spec §7.11.1 operator retry)", () => {
  test("exactly one work ID is required", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    expect(await retryLifecycleWork(db, { scope: SCOPE, nowMs: 2000 })).toBe(false);
    expect(await retryLifecycleWork(db, { scope: SCOPE, publicationId: "pub-1", associationId: "a-1", nowMs: 2000 })).toBe(false);
  });

  test("publication retry resets bookkeeping on a free lease and retains payload/proof/phase/epoch", async () => {
    const db = createSeededTestD1();
    const pay = payload({ lifecycle: lifecycleRound({ seen: [seenEntry("row-1", "f-1")] }) });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    // Live lease → refused.
    expect(await retryLifecycleWork(db, { scope: SCOPE, publicationId: "pub-1", nowMs: 2000 })).toBe(false);

    // After expiry: attempts/next_attempt/error reset; epoch retained;
    // payload, proof and phase untouched.
    const before = publicationRow(db, "pub-1");
    expect(await retryLifecycleWork(db, { scope: SCOPE, publicationId: "pub-1", nowMs: lease.untilMs + 1 })).toBe(true);
    const after = publicationRow(db, "pub-1");
    expect(after.attempts).toBe(0);
    expect(after.recovery_state).toBe("pending");
    expect(after.phase).toBe("confirmed");
    expect(after.proof_json).not.toBeNull();
    expect(after.lease_epoch).toBe(before.lease_epoch);
    expect(after.applied_ms).toBeNull();
  });

  test("association retry resets queue state but never resurrects needs-recheck/abandoned rows", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, app_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES ('row-1', ?, ?, ?, ?, ?, 'f-1', ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(APP_ID, 123, "acme", "widgets", 42, JSON.stringify(originalFinding()), SHA, SHA);
    const insertThread = (id: string, resolutionState: string) =>
      db.raw
        .prepare(
          `INSERT INTO review_threads
             (id, finding_row_id, publication_id, app_id, installation_id, owner, repo, pr_number,
              original_sha, round, intent_json, resolution_state, verified_json, attempts, last_error, created_ms, updated_ms)
           VALUES (?, 'row-1', 'pub-1', ?, ?, ?, ?, ?, ?, 1, '{}', ?, '{\"snapshot\":1}', 3, 'boom', 1000, 1000)`,
        )
        .run(id, APP_ID, 123, "acme", "widgets", 42, SHA, resolutionState);
    insertThread("a-local-error", "local-error");
    insertThread("a-needs-recheck", "needs-recheck");

    expect(await retryLifecycleWork(db, { scope: SCOPE, associationId: "a-local-error", nowMs: 2000 })).toBe(true);
    const retried = db.raw.prepare("SELECT resolution_state, attempts, last_error, verified_json FROM review_threads WHERE id = 'a-local-error'").get() as {
      resolution_state: string; attempts: number; last_error: string | null; verified_json: string | null;
    };
    expect(retried.resolution_state).toBe("retry");
    expect(retried.attempts).toBe(0);
    expect(retried.last_error).toBeNull();
    expect(retried.verified_json).not.toBeNull(); // verified snapshot retained

    // needs-recheck must wait for the next real review — retry is refused.
    expect(await retryLifecycleWork(db, { scope: SCOPE, associationId: "a-needs-recheck", nowMs: 2000 })).toBe(false);
    expect(
      (db.raw.prepare("SELECT resolution_state FROM review_threads WHERE id = 'a-needs-recheck'").get() as { resolution_state: string }).resolution_state,
    ).toBe("needs-recheck");
  });
});

describe("private journal visibility (spec §7.1, consumer-visible behavior)", () => {
  test("staged rows are unreachable through the reviewer-visible result read — before confirmation and after apply", async () => {
    const db = createSeededTestD1();
    const pay = payload({
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-1"],
        seen: [seenEntry("row-1", "f-1")],
        assessments: [
          { rowId: "row-1", disposition: "unverifiable", reason: "budget", evidence: null, relatedCurrentFindingIndexes: [] },
        ],
        coverage: { totalOpen: 1, selected: 1, assessed: 1, omitted: 0, capped: 0, contextCoverage: "truncated" },
      }),
      lineIntents: [intent("assoc-1", "row-1", "pub-1", 1)],
    });

    // Pre-confirmation staging: the reviewer-visible result read (the public
    // reviews/findings surfaces a dashboard result API queries) shows nothing.
    await stagePublication(db, { id: "pub-1", payload: pay, nowMs: 1000 });
    const resultReadBefore = db.raw
      .prepare("SELECT id FROM reviews WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?")
      .get(SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA);
    expect(resultReadBefore).toBeNull();
    expect((db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number }).n).toBe(0);

    // Pre-confirmation staging never appears as a published result even via
    // a fuzzy body search over the result surfaces.
    const fuzzy = db.raw
      .prepare("SELECT COUNT(*) AS n FROM reviews WHERE envelope LIKE '%' || ? || '%' OR summary_md LIKE '%' || ? || '%'")
      .get("pub-1", "pub-1") as { n: number };
    expect(fuzzy.n).toBe(0);

    // Confirm + apply.
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    await applyPublishedLifecycle(db, "pub-1", lease, 2000);

    // The published result is now visible — and it is exactly the envelope-
    // published review, NOT the journal: the private payload (publication
    // id, lifecycle coverage, line intents, private body) never surfaces
    // through the result read, even after apply.
    const resultReadAfter = db.raw
      .prepare("SELECT id, envelope, summary_md FROM reviews WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?")
      .get(SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA) as { id: string; envelope: string; summary_md: string | null };
    expect(resultReadAfter).toBeDefined();

    const envelope = JSON.parse(resultReadAfter.envelope) as Record<string, unknown>;
    expect(Object.keys(envelope)).not.toContain("lifecycle");
    expect(Object.keys(envelope)).not.toContain("lineIntents");
    expect(Object.keys(envelope)).not.toContain("coverage");

    const leakProbe = db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM reviews
         WHERE envelope LIKE '%' || ? || '%' OR summary_md LIKE '%' || ? || '%'`,
      )
      .get("pub-1", "pub-1") as { n: number };
    expect(leakProbe.n).toBe(0);

    const bodyLeak = db.raw
      .prepare("SELECT COUNT(*) AS n FROM findings WHERE title LIKE '%' || ? || '%' OR body LIKE '%' || ? || '%'")
      .get("assoc-1", "pub-1") as { n: number };
    expect(bodyLeak.n).toBe(0);
  });
});
