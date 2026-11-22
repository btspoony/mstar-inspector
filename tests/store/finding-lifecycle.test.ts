import { describe, expect, test } from "bun:test";
import type { MstarReviewFinding, MstarReviewV1 } from "@mstar-harness/engine";
import {
  applyPublishedLifecycle,
  claimPublication,
  countRecheckableFindings,
  hasUnprovenDegradedPublication,
  listPublicationRecovery,
  listResolutionRecovery,
  listSuspendedLifecycleApps,
  markPublicationFailed,
  PUBLICATION_LEASE_MS,
  PUBLICATION_MAX_BYTES,
  readPublicationProof,
  recordPublicationProof,
  releaseUnspentPublicationClaim,
  retryLifecycleWork,
  selectAssessmentTargets,
  stagePublication,
  suspendPublicationRecovery,
  suspendResolutionRecovery,
  suspensionCredentialOf,
  suspensionKindOf,
  suspensionReasonOf,
  type LifecycleRound,
  type LineIntent,
  type Lease,
  type PublicationPayload,
  type PublicationProof,
} from "../../src/store/finding-lifecycle";
import type { Scope } from "../../packages/shared/src/recheck-wire";
import type { D1BatchResult, D1Like, D1StatementLike } from "../../src/store/types";
import { createArtifactStore, type ReviewArtifactDoc } from "../../src/store/artifact-store";
import { idemKey } from "../../src/contracts/idem";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createMigratedTestD1, seedTarget, type TestD1 } from "./helpers";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_APP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TARGET_ID = "11111111-2222-3333-4444-777777777777";
const OTHER_TARGET_ID = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const SCOPE: Scope = { appId: APP_ID, installationId: 123, owner: "acme", repo: "widgets", prNumber: 42 };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "ffffffffffffffffffffffffffffffffffffffff";

function seedAppRow(db: TestD1, id: string, githubAppId = 1001): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, githubAppId, `lifecycle-test-${id}`);
}

function createSeededTestD1(): TestD1 {
  const db = createMigratedTestD1();
  seedAppRow(db, APP_ID);
  seedAppRow(db, OTHER_APP_ID, 1002);
  seedTarget(db, APP_ID, { id: TARGET_ID });
  seedTarget(db, OTHER_APP_ID, { id: OTHER_TARGET_ID });
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
    targetId: TARGET_ID,
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

async function stageClaimProve(db: TestD1, id: string, pay: PublicationPayload, nowMs: number): Promise<Lease> {
  await stagePublication(db, { id, payload: pay, nowMs });
  const lease = await claimPublication(db, id, "consumer", nowMs + 1, "prepared");
  if (lease === null) throw new Error("test setup: claim failed");
  const recorded = await recordPublicationProof(db, id, lease, proof(id, pay, nowMs + 2));
  if (!recorded) throw new Error("test setup: proof recording failed");
  return lease;
}

function publicationRow(db: TestD1, id: string): {
  phase: string; recovery_state: string; attempts: number; holder: string | null;
  lease_epoch: number; proof_json: string | null; applied_ms: number | null; confirmed_ms: number | null;
  lease_until_ms: number | null; next_attempt_ms: number | null;
} {
  return db.raw.prepare("SELECT phase, recovery_state, attempts, holder, lease_epoch, proof_json, applied_ms, confirmed_ms, lease_until_ms, next_attempt_ms FROM review_publications WHERE id = ?").get(id) as never;
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

    const lease1 = await claimPublication(db, "pub-1", "consumer", 2000, "prepared");
    expect(lease1).toEqual({ holder: "consumer", epoch: 1, untilMs: 2000 + PUBLICATION_LEASE_MS });
    expect(publicationRow(db, "pub-1").phase).toBe("sending");
    expect(publicationRow(db, "pub-1").attempts).toBe(1);

    expect(await claimPublication(db, "pub-1", "recovery", 3000, "sending")).toBeNull();

    const lease2 = await claimPublication(db, "pub-1", "recovery", 2000 + PUBLICATION_LEASE_MS + 1, "sending");
    expect(lease2).toEqual({ holder: "recovery", epoch: 2, untilMs: 2000 + PUBLICATION_LEASE_MS + 1 + PUBLICATION_LEASE_MS });
    expect(publicationRow(db, "pub-1").attempts).toBe(2);
  });

  test("claim refuses terminal phases (applied)", async () => {
    const db = createSeededTestD1();
    const lease = await stageClaimProve(db, "pub-1", payload(), 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);
    expect(await claimPublication(db, "pub-1", "recovery", 3000, "confirmed")).toBeNull();
  });

  test("releaseUnspentPublicationClaim returns a never-dispatched claim to due prepared (P67-QC-018)", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });

    const lease = (await claimPublication(db, "pub-1", "lifecycle-reconcile", 2000, "prepared")) ?? (() => { throw new Error("setup"); })();
    expect(publicationRow(db, "pub-1").phase).toBe("sending");
    expect(publicationRow(db, "pub-1").attempts).toBe(1);

    expect(await releaseUnspentPublicationClaim(db, "pub-1", lease, 3000)).toBe(true);
    const released = publicationRow(db, "pub-1");
    expect(released.phase).toBe("prepared");
    expect(released.attempts).toBe(0);
    expect(released.holder).toBeNull();
    expect(released.lease_until_ms).toBeNull();
    expect(released.next_attempt_ms).toBeNull();
    expect(await listPublicationRecovery(db, 3000, 10)).toHaveLength(1);

    const reClaim = await claimPublication(db, "pub-1", "lifecycle-reconcile", 4000, "prepared");
    expect(reClaim).not.toBeNull();
    expect(publicationRow(db, "pub-1").phase).toBe("sending");
    expect(publicationRow(db, "pub-1").attempts).toBe(1);
  });

  test("releaseUnspentPublicationClaim is fenced: a stale or already-terminal claim is refused", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    const lease = (await claimPublication(db, "pub-1", "lifecycle-reconcile", 2000, "prepared")) ?? (() => { throw new Error("setup"); })();

    expect(await releaseUnspentPublicationClaim(db, "pub-1", { ...lease, holder: "other" }, 3000)).toBe(false);
    expect(await releaseUnspentPublicationClaim(db, "pub-1", { ...lease, epoch: lease.epoch + 5 }, 3000)).toBe(false);
    expect(publicationRow(db, "pub-1").phase).toBe("sending");

    expect(await recordPublicationProof(db, "pub-1", lease, proof("pub-1", payload(), 3000))).toBe(true);
    expect(await releaseUnspentPublicationClaim(db, "pub-1", lease, 4000)).toBe(false);
    expect(publicationRow(db, "pub-1").phase).toBe("confirmed");
  });

  test("proof recording fails closed on holder/epoch/publication mismatch", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    const lease = (await claimPublication(db, "pub-1", "consumer", 2000, "prepared")) ?? (() => { throw new Error("setup"); })();
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

    const byScope = await readPublicationProof(db, { scope: SCOPE, headSha: SHA });
    expect(byScope?.publicationId).toBe("pub-rev");
    expect(byScope?.kind).toBe("review");

    const byId = await readPublicationProof(db, { scope: SCOPE, headSha: SHA, publicationId: "pub-deg" });
    expect(byId?.publicationId).toBe("pub-deg");
    expect(byId?.kind).toBe("degraded");

    expect(await readPublicationProof(db, { scope: SCOPE, headSha: SHA2 })).toBeNull();
    expect(await readPublicationProof(db, { scope: { ...SCOPE, repo: "other" }, headSha: SHA })).toBeNull();
  });
});

describe("applyPublishedLifecycle (spec §7.2 state machine + §7.7 step 9)", () => {
  test("stamps the publication round onto the stored reviews row", async () => {
    const db = createSeededTestD1();
    const pay = payload({ round: 4, lifecycle: lifecycleRound({ seen: [seenEntry("row-1", "f-1")] }) });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);

    expect(db.raw.query("SELECT round FROM reviews").get()).toEqual({ round: 4 });
    const finding = db.raw.prepare("SELECT first_seen_round FROM review_findings WHERE id = 'row-1'").get() as {
      first_seen_round: number;
    };
    expect(finding.first_seen_round).toBe(4);
  });

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

    const pub = publicationRow(db, "pub-1");
    expect(pub.phase).toBe("applied");
    expect(pub.recovery_state).toBe("done");
    expect(pub.holder).toBeNull();
    expect(pub.applied_ms).toBe(2000);

    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(1);
    const publicFindings = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(publicFindings.n).toBe(1);

    const finding = db.raw.prepare("SELECT * FROM review_findings WHERE id = 'row-1'").get() as {
      state: string; reopen_count: number; first_publication_id: string; last_publication_id: string;
      first_seen_round: number; last_seen_round: number; last_assessed_ms: number | null; last_scheduled_ms: number | null;
      target_id: string | null;
    };
    expect(finding.state).toBe("open");
    expect(finding.target_id).toBe(TARGET_ID);
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

    expect(await listPublicationRecovery(db, 3000, 10)).toEqual([]);
  });

  test("apply is proof-gated and lease-gated", async () => {
    const db = createSeededTestD1();
    const pay = payload({ lifecycle: lifecycleRound({ seen: [seenEntry("row-1", "f-1")] }) });
    await stagePublication(db, { id: "pub-1", payload: pay, nowMs: 1000 });
    const lease = await claimPublication(db, "pub-1", "consumer", 2000, "prepared");
    if (lease === null) throw new Error("setup");

    expect(await applyPublishedLifecycle(db, "pub-1", lease, 3000)).toBe(false);
    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(0);

    await recordPublicationProof(db, "pub-1", lease, proof("pub-1", pay, 2500));

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
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 5000)).toBe(true);

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

    const store = createArtifactStore(db);
    await store.put(pay.artifact!);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(1);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n).toBe(0);

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

  test("a chunked apply stops writing once the lease is replaced (§7.11.1 chunk fence)", async () => {
    const db = createSeededTestD1();
    const seen = Array.from({ length: 30 }, (_, i) => seenEntry(`row-${i}`, `f-${i}`));
    const pay = payload({
      lifecycle: lifecycleRound({ seen }),
      lineIntents: seen.map((entry, i) => intent(`assoc-${i}`, entry.rowId, "pub-1", 1)),
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    let reads = 0;
    const applied = await applyPublishedLifecycle(db, "pub-1", lease, 2000, () => {
      reads += 1;
      if (reads === 4) {
        db.raw
          .prepare(`UPDATE review_publications SET holder = 'other', lease_epoch = lease_epoch + 1 WHERE id = 'pub-1'`)
          .run();
      }
      return 2000;
    });

    expect(reads).toBe(4);
    expect(applied).toBe(false);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n).toBe(25);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(1);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number }).n).toBe(1);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_threads").get() as { n: number }).n).toBe(0);
    expect(publicationRow(db, "pub-1").phase).toBe("confirmed");
  });

  test("a chunked apply stops when its own lease expires between chunks", async () => {
    const db = createSeededTestD1();
    const seen = Array.from({ length: 30 }, (_, i) => seenEntry(`row-${i}`, `f-${i}`));
    const pay = payload({ lifecycle: lifecycleRound({ seen }) });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    let reads = 0;
    const applied = await applyPublishedLifecycle(db, "pub-1", lease, 2000, () => {
      reads += 1;
      return reads < 4 ? 2000 : lease.untilMs + 1;
    });

    expect(applied).toBe(false);
    expect(reads).toBe(4);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n).toBe(25);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n).toBe(1);
    expect(publicationRow(db, "pub-1").phase).toBe("confirmed");
  });
});

function leaseMutationAtWriteBoundary(db: TestD1, mutate: () => void): D1Like {
  let inBatch = false;
  let directRun = false;
  return {
    prepare(query: string): D1StatementLike {
      const inner = db.prepare(query);
      const statement: D1StatementLike = {
        bind(...values: unknown[]): D1StatementLike {
          inner.bind(...values);
          return statement;
        },
        first<T = Record<string, unknown>>(): Promise<T | null> {
          return inner.first<T>();
        },
        all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return inner.all<T>();
        },
        run<T = Record<string, unknown>>() {
          if (!inBatch && !directRun) {
            directRun = true;
            mutate();
          }
          return inner.run<T>();
        },
      };
      return statement;
    },
    async batch(statements: D1StatementLike[]): Promise<D1BatchResult[]> {
      mutate();
      inBatch = true;
      try {
        return await db.batch(statements);
      } finally {
        inBatch = false;
      }
    },
  };
}

describe("atomic live-lease fence at the mutation boundary (spec §7.11.1)", () => {
  const count = (db: TestD1, table: string): number => {
    const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  };

  test("a lease replaced at the mutation boundary writes no lifecycle row and never marks applied", async () => {
    const db = createSeededTestD1();
    const pay = payload({
      lifecycle: lifecycleRound({ selectedRowIds: ["row-1"], seen: [seenEntry("row-1", "f-1")] }),
      lineIntents: [intent("assoc-1", "row-1", "pub-1", 1)],
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    await createArtifactStore(db).put(pay.artifact!);

    const raced = leaseMutationAtWriteBoundary(db, () => {
      db.raw
        .prepare(`UPDATE review_publications SET holder = 'rival', lease_epoch = lease_epoch + 1 WHERE id = 'pub-1'`)
        .run();
    });

    expect(await applyPublishedLifecycle(raced, "pub-1", lease, 2000)).toBe(false);
    expect(count(db, "review_findings")).toBe(0);
    expect(count(db, "review_finding_rounds")).toBe(0);
    expect(count(db, "review_threads")).toBe(0);
    expect(publicationRow(db, "pub-1")).toMatchObject({ phase: "confirmed", applied_ms: null });
  });

  test("an expired same-holder lease writes nothing and refuses the applied marker", async () => {
    const db = createSeededTestD1();
    const pay = payload({
      lifecycle: lifecycleRound({ selectedRowIds: ["row-1"], seen: [seenEntry("row-1", "f-1")] }),
      lineIntents: [intent("assoc-1", "row-1", "pub-1", 1)],
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    await createArtifactStore(db).put(pay.artifact!);

    const raced = leaseMutationAtWriteBoundary(db, () => {
      db.raw.prepare(`UPDATE review_publications SET lease_until_ms = ? WHERE id = 'pub-1'`).run(1999);
    });

    expect(await applyPublishedLifecycle(raced, "pub-1", lease, 2000)).toBe(false);
    expect(count(db, "review_findings")).toBe(0);
    expect(count(db, "review_threads")).toBe(0);
    expect(publicationRow(db, "pub-1")).toMatchObject({ phase: "confirmed", applied_ms: null });
  });

  test("a replacement between chunks cannot write the remaining chunks", async () => {
    const db = createSeededTestD1();
    const seen = Array.from({ length: 30 }, (_, i) => seenEntry(`row-${i}`, `f-${i}`));
    const pay = payload({
      lifecycle: lifecycleRound({ seen }),
      lineIntents: seen.map((entry, i) => intent(`assoc-${i}`, entry.rowId, "pub-1", 1)),
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    await createArtifactStore(db).put(pay.artifact!);

    let writes = 0;
    const raced = leaseMutationAtWriteBoundary(db, () => {
      writes += 1;
      if (writes === 3) {
        db.raw
          .prepare(`UPDATE review_publications SET holder = 'rival', lease_epoch = lease_epoch + 1 WHERE id = 'pub-1'`)
          .run();
      }
    });

    expect(await applyPublishedLifecycle(raced, "pub-1", lease, 2000)).toBe(false);
    expect(count(db, "review_findings")).toBe(25);
    expect(count(db, "review_threads")).toBe(0);
    expect(publicationRow(db, "pub-1")).toMatchObject({ phase: "confirmed", applied_ms: null });
  });

  test("the degraded applied marker is atomically expiry-fenced", async () => {
    const db = createSeededTestD1();
    const pay = payload({ kind: "degraded", artifact: null, lifecycle: null });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);

    const raced = leaseMutationAtWriteBoundary(db, () => {
      db.raw.prepare(`UPDATE review_publications SET lease_until_ms = ? WHERE id = 'pub-1'`).run(1999);
    });

    expect(await applyPublishedLifecycle(raced, "pub-1", lease, 2000)).toBe(false);
    expect(publicationRow(db, "pub-1")).toMatchObject({ phase: "confirmed", applied_ms: null });

    db.raw.prepare(`UPDATE review_publications SET lease_until_ms = ? WHERE id = 'pub-1'`).run(lease.untilMs);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);
    expect(publicationRow(db, "pub-1").phase).toBe("applied");
  });
});

describe("recurrence reopen and identity drift (spec §7.2)", () => {
  test("recurrence reopens a closed concern, retains history, and never touches the old thread", async () => {
    const db = createSeededTestD1();
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

    db.raw.prepare("UPDATE review_threads SET verified_json = '{\"snapshot\":1}' WHERE id = 'assoc-1'").run();

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
    expect(row.state).toBe("open");
    expect(row.reopen_count).toBe(1);
    expect(JSON.parse(row.original_json).title).toBe("Null deref risk");
    expect(row.first_publication_id).toBe("pub-1");
    expect(row.first_seen_round).toBe(1);
    expect(row.last_seen_round).toBe(2);
    expect(row.last_publication_id).toBe("pub-2");
    expect(row.last_assessment_json !== null && JSON.parse(row.last_assessment_json).reason === "verified-fix").toBe(true);

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

    const newThread = db.raw.prepare("SELECT superseded_by_publication_id, round FROM review_threads WHERE id = 'assoc-2'").get() as {
      superseded_by_publication_id: string | null; round: number;
    };
    expect(newThread.superseded_by_publication_id).toBeNull();
    expect(newThread.round).toBe(2);

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
    expect(row.state).toBe("open");
    expect(row.reopen_count).toBe(0);
    expect(row.last_assessment_json !== null && JSON.parse(row.last_assessment_json).reason).toBe("identity-drift");
    expect(row.last_assessed_ms).toBe(11_000);

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
    expect(row.reopen_count).toBe(1);
    expect(row.state).toBe("addressed");
  });
});

describe("fair rotation (spec §7.2)", () => {
  test("open rows select oldest-waiting first, capped at 25; applying a confirmed publication advances past the cap", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    for (let i = 1; i <= 26; i++) {
      db.raw
        .prepare(
          `INSERT INTO review_findings
             (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
              first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
              first_seen_round, last_seen_round, state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', ?, ?)`,
        )
        .run(`row-${i}`, APP_ID, 123, "acme", "widgets", 42, `f-${i}`, JSON.stringify(originalFinding()), SHA, SHA, i * 10, i * 10);
    }

    expect(await countRecheckableFindings(db, SCOPE)).toBe(26);

    const selected = await selectAssessmentTargets(db, SCOPE, 500);
    expect(selected).toHaveLength(25);
    expect(selected.map((t) => t.rowId)).toEqual(Array.from({ length: 25 }, (_, i) => `row-${i + 1}`));
    expect(selected[0]!.original.body).toBe("Dereferencing possibly-null value.");

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

    expect(await countRecheckableFindings(db, SCOPE)).toBe(26);
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
             (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
              first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
              first_seen_round, last_seen_round, state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pub-1', 'pub-1', ?, ?, 1, 1, ?, ?, ?)`,
        )
        .run(id, APP_ID, 123, "acme", "widgets", 42, findingId, JSON.stringify(originalFinding()), SHA, SHA, state, createdMs, createdMs);
    insertFinding("row-old", "f-old", 1000, "open");
    insertFinding("row-closed", "f-closed", 2000, "addressed");
    insertFinding("row-newer", "f-newer", 5000, "open");

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

  const insertFinding = (db: TestD1, id: string, state: string, createdMs: number): void => {
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pub-1', 'pub-1', ?, ?, 1, 1, ?, ?, ?)`,
      )
      .run(id, APP_ID, 123, "acme", "widgets", 42, `f-${id}`, JSON.stringify(originalFinding()), SHA, SHA, state, createdMs, createdMs);
  };

  const insertThread = (
    db: TestD1,
    id: string,
    findingRowId: string,
    resolutionState: string,
    superseded: string | null = null,
  ): void => {
    db.raw
      .prepare(
        `INSERT INTO review_threads
           (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
            original_sha, round, intent_json, resolution_state, verified_json,
            superseded_by_publication_id, created_ms, updated_ms)
         VALUES (?, ?, 'pub-1', ?, 123, 'acme', 'widgets', 42, ?, 1, '{}', ?, '{"snapshot":1}', ?, ?, ?)`,
      )
      .run(id, findingRowId, APP_ID, SHA, resolutionState, superseded, 1000, 1000);
  };

  test("addressed rows re-enter the rotation only while an association is still non-terminal", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    insertFinding(db, "row-open", "open", 1000);
    insertFinding(db, "row-pending", "addressed", 2000);
    insertFinding(db, "row-retry", "addressed", 3000);
    insertFinding(db, "row-needs-recheck", "addressed", 4000);
    insertFinding(db, "row-local-error", "addressed", 5000);
    insertFinding(db, "row-resolved", "addressed", 6000);
    insertFinding(db, "row-abandoned", "addressed", 7000);
    insertFinding(db, "row-superseded", "addressed", 8000);
    insertFinding(db, "row-untracked", "addressed", 9000);
    insertThread(db, "t-pending", "row-pending", "pending");
    insertThread(db, "t-retry", "row-retry", "retry");
    insertThread(db, "t-needs-recheck", "row-needs-recheck", "needs-recheck");
    insertThread(db, "t-local-error", "row-local-error", "local-error");
    insertThread(db, "t-resolved", "row-resolved", "resolved");
    insertThread(db, "t-abandoned", "row-abandoned", "abandoned");
    insertThread(db, "t-superseded", "row-superseded", "pending", "pub-x");

    const selected = await selectAssessmentTargets(db, SCOPE, 25);
    expect(selected.map((t) => t.rowId)).toEqual([
      "row-open", "row-pending", "row-retry", "row-needs-recheck", "row-local-error",
    ]);
    const totalOpen = await countRecheckableFindings(db, SCOPE);
    expect(totalOpen).toBe(5);
    expect(selected.length).toBeLessThanOrEqual(totalOpen);
  });

  test("a re-selected addressed row advances last_scheduled_ms, so it cannot starve the rows behind it", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1000 });
    insertFinding(db, "row-a", "addressed", 1000);
    insertFinding(db, "row-b", "addressed", 2000);
    insertThread(db, "t-a", "row-a", "pending");
    insertThread(db, "t-b", "row-b", "pending");

    expect((await selectAssessmentTargets(db, SCOPE, 1)).map((t) => t.rowId)).toEqual(["row-a"]);
    const pay = payload({
      headSha: SHA2,
      round: 2,
      artifact: artifactDoc({
        key: idemKey({ installation_id: SCOPE.installationId, owner: SCOPE.owner, repo: SCOPE.repo, pr_number: SCOPE.prNumber, head_sha: SHA2 }),
      }),
      lifecycle: lifecycleRound({
        selectedRowIds: ["row-a"],
        coverage: { totalOpen: 2, selected: 1, assessed: 0, omitted: 1, capped: 1, contextCoverage: "complete" },
      }),
    });
    const lease = await stageClaimProve(db, "pub-2", pay, 10_000);
    expect(await applyPublishedLifecycle(db, "pub-2", lease, 10_000)).toBe(true);

    const clock = db.raw.query("SELECT last_scheduled_ms FROM review_findings WHERE id = 'row-a'").get() as {
      last_scheduled_ms: number | null;
    };
    expect(clock.last_scheduled_ms).toBe(10_000);
    expect((await selectAssessmentTargets(db, SCOPE, 1)).map((t) => t.rowId)).toEqual(["row-b"]);
  });
});

describe("resolution queue selection (spec §7.11.1)", () => {
  async function seedThread(
    db: TestD1,
    id: string,
    overrides: Partial<Record<string, unknown>> = {},
  ): Promise<void> {
    await stagePublication(db, { id: "pub-seed", payload: payload(), nowMs: 1000 });
    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pub-seed', 'pub-seed', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(`finding-for-${id}`, APP_ID, 123, "acme", "widgets", 42, `f-${id}`, JSON.stringify(originalFinding()), SHA, SHA);
    const row = {
      id,
      finding_row_id: `finding-for-${id}`,
      publication_id: "pub-seed",
      bot_id: APP_ID,
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
           (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
            original_sha, round, intent_json, resolution_state, verified_json, attempts,
            next_attempt_ms, holder, lease_until_ms, superseded_by_publication_id, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.finding_row_id, row.publication_id, row.bot_id, row.installation_id,
        row.owner, row.repo, row.pr_number, row.original_sha, row.round, row.intent_json,
        row.resolution_state, row.verified_json, row.attempts, row.next_attempt_ms,
        row.holder, row.lease_until_ms, row.superseded_by_publication_id, row.created_ms, row.created_ms,
      );
  }

  test("selects rows with no attempt yet; excludes superseded/unverified/leased/capped/non-queue rows", async () => {
    const db = createSeededTestD1();
    await seedThread(db, "t-due", { created_ms: 1000 });
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
           (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES ('row-other-app', ?, ?, ?, ?, ?, 'f-1', ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(OTHER_APP_ID, 123, "acme", "widgets", 42, JSON.stringify(originalFinding()), SHA, SHA);

    db.raw
      .prepare(
        `INSERT INTO review_findings
           (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES ('row-other-repo', ?, ?, ?, ?, ?, 'f-1', ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(APP_ID, 123, "acme", "other-repo", 42, JSON.stringify(originalFinding()), SHA, SHA);

    expect(await countRecheckableFindings(db, SCOPE)).toBe(0);
    expect(await selectAssessmentTargets(db, SCOPE, 25)).toEqual([]);
    expect(await readPublicationProof(db, { scope: { ...SCOPE, appId: OTHER_APP_ID }, headSha: SHA })).toBeNull();
    expect(await readPublicationProof(db, { scope: SCOPE, headSha: SHA })).toBeNull();
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

    expect(await retryLifecycleWork(db, { scope: SCOPE, publicationId: "pub-1", nowMs: 2000 })).toBe(false);

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
           (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
            first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
            first_seen_round, last_seen_round, state, created_ms, updated_ms)
         VALUES ('row-1', ?, ?, ?, ?, ?, 'f-1', ?, 'pub-1', 'pub-1', ?, ?, 1, 1, 'open', 1000, 1000)`,
      )
      .run(APP_ID, 123, "acme", "widgets", 42, JSON.stringify(originalFinding()), SHA, SHA);
    const insertThread = (id: string, resolutionState: string) =>
      db.raw
        .prepare(
          `INSERT INTO review_threads
             (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number,
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
    expect(retried.verified_json).not.toBeNull();

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

    await stagePublication(db, { id: "pub-1", payload: pay, nowMs: 1000 });
    const resultReadBefore = db.raw
      .prepare("SELECT id FROM reviews WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?")
      .get(SCOPE.installationId, SCOPE.owner, SCOPE.repo, SCOPE.prNumber, SHA);
    expect(resultReadBefore).toBeNull();
    expect((db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number }).n).toBe(0);

    const fuzzy = db.raw
      .prepare("SELECT COUNT(*) AS n FROM reviews WHERE envelope LIKE '%' || ? || '%' OR summary_md LIKE '%' || ? || '%'")
      .get("pub-1", "pub-1") as { n: number };
    expect(fuzzy.n).toBe(0);

    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    await applyPublishedLifecycle(db, "pub-1", lease, 2000);

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

describe("definitive pre-send failure is a durable phase (spec §7.7, P67-QC-010)", () => {
  test("markPublicationFailed sets phase='failed' and retains payload/attempts; recovery stops selecting it", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1_000 });
    const lease = await claimPublication(db, "pub-1", "holder", 2_000, "prepared");
    if (lease === null) throw new Error("setup: claim failed");

    const ok = await markPublicationFailed(db, "pub-1", lease, "definitive rejection before send", 3_000);
    expect(ok).toBe(true);

    const row = db.raw
      .prepare(`SELECT phase, payload_json, proof_json, attempts, holder, lease_until_ms, recovery_state, last_error
                FROM review_publications WHERE id = 'pub-1'`)
      .get() as {
        phase: string; payload_json: string; proof_json: string | null; attempts: number;
        holder: string | null; lease_until_ms: number | null; recovery_state: string; last_error: string | null;
      };
    expect(row.phase).toBe("failed");
    expect(row.last_error).toContain("definitive rejection before send");
    expect(JSON.parse(row.payload_json).body).toBe("review body");
    expect(row.proof_json).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.holder).toBeNull();
    expect(row.lease_until_ms).toBeNull();
    expect(row.recovery_state).toBe("pending");

    const selected = await listPublicationRecovery(db, 10_000, 10);
    expect(selected.map((r) => r.phase)).toEqual(["failed"]);
  });

  test("a post-attempt unknown is NOT marked failed — the two states stay distinct", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1_000 });
    const lease = await claimPublication(db, "pub-1", "holder", 2_000, "prepared");
    if (lease === null) throw new Error("setup: claim failed");
    const confirmed = await recordPublicationProof(db, "pub-1", lease, {
      publicationId: "pub-1",
      scope: SCOPE,
      headSha: SHA,
      kind: "review",
      round: 1,
      commentId: 5,
      bodySha256: payload().bodySha256,
      confirmedMs: 3_000,
    });
    expect(confirmed).toBe(true);
    const stale = { holder: "holder", epoch: lease.epoch, untilMs: 0 };
    expect(await markPublicationFailed(db, "pub-1", stale, "late", 4_000)).toBe(false);
    const row = db.raw.prepare(`SELECT phase FROM review_publications WHERE id = 'pub-1'`).get() as { phase: string };
    expect(row.phase).toBe("confirmed");
  });
});

describe("degraded-cleanup journal gate (spec §7.7 step 11, P67-QC-008)", () => {
  test("an unproven degraded publication blocks cleanup; proof or a terminal failure unblocks it", async () => {
    const db = createSeededTestD1();
    expect(await hasUnprovenDegradedPublication(db, SCOPE)).toBe(false);

    await stagePublication(db, { id: "deg-1", payload: payload({ kind: "degraded", artifact: null, lifecycle: null, body: "degraded body", bodySha256: "c".repeat(64) }), nowMs: 1_000 });
    expect(await hasUnprovenDegradedPublication(db, SCOPE)).toBe(true);

    db.raw.prepare(`UPDATE review_publications SET phase = 'sending' WHERE id = 'deg-1'`).run();
    expect(await hasUnprovenDegradedPublication(db, SCOPE)).toBe(true);
    db.raw.prepare(`UPDATE review_publications SET phase = 'unknown' WHERE id = 'deg-1'`).run();
    expect(await hasUnprovenDegradedPublication(db, SCOPE)).toBe(true);

    db.raw.prepare(`UPDATE review_publications SET phase = 'failed' WHERE id = 'deg-1'`).run();
    expect(await hasUnprovenDegradedPublication(db, SCOPE)).toBe(false);

    db.raw
      .prepare(`UPDATE review_publications SET phase = 'confirmed', proof_json = '{}' WHERE id = 'deg-1'`)
      .run();
    expect(await hasUnprovenDegradedPublication(db, SCOPE)).toBe(false);
  });

  test("a REVIEW publication never blocks the degraded cleanup (kind-scoped)", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1_000 });
    expect(await hasUnprovenDegradedPublication(db, SCOPE)).toBe(false);
  });
});

describe("durable suspension kinds (spec §7.6, P67-QC-007)", () => {
  test("empty and zero-sized scans do not advance the cursor", async () => {
    const db = createSeededTestD1();
    expect(await listSuspendedLifecycleApps(db, 2)).toEqual([]);
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1_000 });
    await suspendPublicationRecovery(db, SCOPE, { kind: "disabled", reason: "disabled" }, 2_000);
    expect(await listSuspendedLifecycleApps(db, 0)).toEqual([]);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM lifecycle_recovery_cursor").get()).toMatchObject({ n: 0 });
    expect(await listSuspendedLifecycleApps(db, 1)).toHaveLength(1);
    db.raw.close();
  });

  test("pair pages rotate durably, wrap, and survive removal of the cursor pair", async () => {
    const db = createSeededTestD1();
    const pairs = [SCOPE, { ...SCOPE, installationId: 124 }, { ...SCOPE, appId: OTHER_APP_ID }];
    for (const [i, scope] of pairs.entries()) {
      await stagePublication(db, { id: `pub-${i}`, payload: payload({ scope }), nowMs: 1_000 });
      await suspendPublicationRecovery(db, scope, { kind: "disabled", reason: "disabled" }, 2_000);
    }
    const selected = (rows: Awaited<ReturnType<typeof listSuspendedLifecycleApps>>) =>
      rows.map(({ appId, installationId }) => ({ appId, installationId }));
    const expected = pairs.map(({ appId, installationId }) => ({ appId, installationId }));
    expect(selected(await listSuspendedLifecycleApps(db, 2))).toEqual(expected.slice(0, 2));
    expect(selected(await listSuspendedLifecycleApps(db, 2))).toEqual([expected[2]!, expected[0]!]);
    db.raw.prepare("DELETE FROM review_publications WHERE id = 'pub-0'").run();
    expect(selected(await listSuspendedLifecycleApps(db, 2))).toEqual(expected.slice(1));
    expect(selected(await listSuspendedLifecycleApps(db, 2))).toEqual(expected.slice(1));
    db.raw.close();
  });

  test("suspension kinds round-trip through the durable reason, with the credential fingerprint", () => {
    const fingerprint = "a".repeat(64);
    const reason = suspensionReasonOf("identity-mismatch", "live App identity does not match", fingerprint);
    expect(suspensionKindOf(reason)).toBe("identity-mismatch");
    expect(suspensionCredentialOf(reason)).toBe(fingerprint);
    const plain = suspensionReasonOf("missing", "mapping missing");
    expect(suspensionKindOf(plain)).toBe("missing");
    expect(suspensionCredentialOf(plain)).toBeNull();
    expect(suspensionKindOf("a legacy operator note")).toBe("unknown");
    expect(suspensionKindOf(null)).toBe("unknown");
  });

  test("listSuspendedLifecycleApps marks identity-mismatch pairs as requiring an identity proof, disabled ones not", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1_000 });
    const fingerprint = "b".repeat(64);
    await suspendPublicationRecovery(
      db,
      { appId: APP_ID, installationId: 123 },
      { kind: "identity-mismatch", reason: "identity mismatch", credentialFingerprint: fingerprint },
      2_000,
    );
    let pairs = await listSuspendedLifecycleApps(db, 10);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      appId: APP_ID,
      installationId: 123,
      requiresIdentityProof: true,
      credentialFingerprint: fingerprint,
    });

    const db2 = createSeededTestD1();
    await stagePublication(db2, { id: "pub-2", payload: payload(), nowMs: 1_000 });
    await suspendPublicationRecovery(
      db2,
      { appId: APP_ID, installationId: 123 },
      { kind: "disabled", reason: "disabled" },
      2_000,
    );
    pairs = await listSuspendedLifecycleApps(db2, 10);
    expect(pairs[0]).toMatchObject({ requiresIdentityProof: false, credentialFingerprint: null });
  });

  test("the thread lane's suspension carries the kind too, and both lanes agree on the pair", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1_000 });
    await stagePublication(db, { id: "pub-2", payload: payload({ kind: "degraded", artifact: null, lifecycle: null, body: "degraded body", bodySha256: "c".repeat(64) }), nowMs: 1_000 });
    const fingerprint = "c".repeat(64);
    await suspendPublicationRecovery(
      db,
      { appId: APP_ID, installationId: 123 },
      { kind: "identity-mismatch", reason: "identity mismatch", credentialFingerprint: fingerprint },
      2_000,
    );
    await suspendResolutionRecovery(
      db,
      { appId: APP_ID, installationId: 123 },
      { kind: "identity-mismatch", reason: "identity mismatch", credentialFingerprint: fingerprint },
      2_000,
    );
    const pairs = await listSuspendedLifecycleApps(db, 10);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.requiresIdentityProof).toBe(true);
    expect(pairs[0]!.credentialFingerprint).toBe(fingerprint);
  });

  test("disagreeing credential fingerprints on one pair withhold the fingerprint (forcing a fresh proof)", async () => {
    const db = createSeededTestD1();
    await stagePublication(db, { id: "pub-1", payload: payload(), nowMs: 1_000 });
    await stagePublication(
      db,
      { id: "pub-2", payload: payload({ kind: "degraded", artifact: null, lifecycle: null, body: "degraded body" }), nowMs: 1_000 },
    );
    await suspendPublicationRecovery(
      db,
      { appId: APP_ID, installationId: 123 },
      { kind: "identity-mismatch", reason: "identity mismatch", credentialFingerprint: "d".repeat(64) },
      2_000,
    );
    db.raw
      .prepare(
        `UPDATE review_publications SET recovery_state = 'suspended', last_error = ?
         WHERE id = 'pub-2'`,
      )
      .run(suspensionReasonOf("identity-mismatch", "identity mismatch", "e".repeat(64)));
    const pairs = await listSuspendedLifecycleApps(db, 1);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.requiresIdentityProof).toBe(true);
    expect(pairs[0]!.credentialFingerprint).toBeNull();
  });
});

describe("target attribution follows the repository", () => {
  const TARGET_B_ID = "11111111-2222-3333-4444-aaaaaaaaaaaa";
  const WORKSPACE_B = "ws-b-fixed";
  const PAGE = { offset: 0, limit: 10 };
  const scopeA = { kind: "target", targetId: TARGET_ID, workspaceId: "default" } as const;
  const scopeB = { kind: "target", targetId: TARGET_B_ID, workspaceId: WORKSPACE_B } as const;

  function attributionFixture(): TestD1 {
    const db = createMigratedTestD1();
    seedAppRow(db, APP_ID);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES (?, ?, ?, NULL, datetime('now'))`,
      )
      .run(WORKSPACE_B, WORKSPACE_B, WORKSPACE_B);
    seedTarget(db, APP_ID, { id: TARGET_ID, repoId: 101, repoOwner: "acme", repoName: "widgets" });
    seedTarget(db, APP_ID, {
      id: TARGET_B_ID,
      workspaceId: WORKSPACE_B,
      repoId: 202,
      repoOwner: "acme",
      repoName: "gadgets",
    });
    for (const [targetId, repo] of [
      [TARGET_ID, "widgets"],
      [TARGET_B_ID, "gadgets"],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO pull_requests
             (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, 'acme', ?, 42, 'PR', 'open', 'sha', datetime('now'), datetime('now'))`,
        )
        .run(`pr-${targetId}`, APP_ID, targetId, repo);
    }
    return db;
  }

  function repoScope(repo: string): Scope {
    return { ...SCOPE, repo };
  }

  function delivery(
    repo: string,
    opts: {
      headSha?: string;
      round?: number;
      hintTargetId?: string;
      seen?: Array<{ rowId: string; findingId: string }>;
      selectedRowIds?: string[];
      assessments?: LifecycleRound["assessments"];
      artifactPayload?: MstarReviewV1;
    } = {},
  ): PublicationPayload {
    const scope = repoScope(repo);
    const headSha = opts.headSha ?? SHA;
    return payload({
      scope,
      headSha,
      round: opts.round ?? 1,
      artifact: artifactDoc({
        key: idemKey({
          installation_id: scope.installationId,
          owner: scope.owner,
          repo: scope.repo,
          pr_number: scope.prNumber,
          head_sha: headSha,
        }),
        targetId: opts.hintTargetId ?? TARGET_ID,
        ...(opts.artifactPayload === undefined ? {} : { payload: opts.artifactPayload }),
      }),
      lifecycle: lifecycleRound({
        selectedRowIds: opts.selectedRowIds ?? [],
        assessments: opts.assessments ?? [],
        seen: (opts.seen ?? []).map((entry) => seenEntry(entry.rowId, entry.findingId)),
      }),
    });
  }

  test("a repository keeps the target that first recorded it", async () => {
    const db = attributionFixture();
    const first = await stageClaimProve(
      db,
      "pub-1",
      delivery("widgets", { seen: [{ rowId: "row-1", findingId: "f-1" }] }),
      1000,
    );
    expect(await applyPublishedLifecycle(db, "pub-1", first, 2000)).toBe(true);

    const second = await stageClaimProve(
      db,
      "pub-2",
      delivery("widgets", { headSha: SHA2, round: 2, seen: [{ rowId: "row-1", findingId: "f-1" }] }),
      10_000,
    );
    expect(await applyPublishedLifecycle(db, "pub-2", second, 11_000)).toBe(true);

    expect(
      db.raw.query("SELECT finding_id, target_id FROM review_findings").all(),
    ).toEqual([{ finding_id: "f-1", target_id: TARGET_ID }]);
    expect(
      db.raw.query("SELECT head_sha, target_id FROM reviews ORDER BY head_sha").all(),
    ).toEqual([
      { head_sha: SHA, target_id: TARGET_ID },
      { head_sha: SHA2, target_id: TARGET_ID },
    ]);

    const store = createReviewBotsStore(db);
    expect(await store.countPullRequestRecords(scopeA, "acme", "widgets", 42)).toEqual({
      findings: 1,
      reviews: 2,
      failures: 0,
      must_fix: 0,
    });
    expect(
      (await store.listPullRequestFindings(scopeA, "acme", "widgets", 42, PAGE))!.items.map((row) => row.finding_id),
    ).toEqual(["f-1"]);

    const fromB = await store.countPullRequestRecords(scopeB, "acme", "gadgets", 42);
    expect(fromB.findings).toBe(0);
    expect(fromB.reviews).toBe(0);
    const fromBFindings = (await store.listPullRequestFindings(scopeB, "acme", "gadgets", 42, PAGE))!;
    expect(fromBFindings.items).toEqual([]);
    expect(fromBFindings.total).toBe(0);
    expect(await store.listPullRequestFindings(scopeA, "acme", "widgets", 43, PAGE)).toBeNull();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get()).toEqual({ n: 1 });
  });

  test("another repository's delivery lands on its own target", async () => {
    const db = attributionFixture();
    const fromA = await stageClaimProve(
      db,
      "pub-a",
      delivery("widgets", { seen: [{ rowId: "row-1", findingId: "f-1" }] }),
      1000,
    );
    expect(await applyPublishedLifecycle(db, "pub-a", fromA, 2000)).toBe(true);

    const fromB = await stageClaimProve(
      db,
      "pub-b",
      delivery("gadgets", { headSha: SHA2, seen: [{ rowId: "row-2", findingId: "f-2" }] }),
      10_000,
    );
    expect(await applyPublishedLifecycle(db, "pub-b", fromB, 11_000)).toBe(true);

    expect(
      db.raw.query("SELECT finding_id, target_id FROM review_findings ORDER BY finding_id").all(),
    ).toEqual([
      { finding_id: "f-1", target_id: TARGET_ID },
      { finding_id: "f-2", target_id: TARGET_B_ID },
    ]);
    expect(db.raw.query("SELECT repo, target_id FROM reviews ORDER BY repo").all()).toEqual([
      { repo: "gadgets", target_id: TARGET_B_ID },
      { repo: "widgets", target_id: TARGET_ID },
    ]);

    const store = createReviewBotsStore(db);
    expect(await store.countPullRequestRecords(scopeA, "acme", "widgets", 42)).toEqual({
      findings: 1,
      reviews: 1,
      failures: 0,
      must_fix: 0,
    });
    expect(await store.countPullRequestRecords(scopeB, "acme", "gadgets", 42)).toEqual({
      findings: 1,
      reviews: 1,
      failures: 0,
      must_fix: 0,
    });
    expect(
      (await store.listPullRequestFindings(scopeA, "acme", "widgets", 42, PAGE))!.items.map((row) => row.finding_id),
    ).toEqual(["f-1"]);
    expect(
      (await store.listPullRequestFindings(scopeB, "acme", "gadgets", 42, PAGE))!.items.map((row) => row.finding_id),
    ).toEqual(["f-2"]);
  });

  test("a failed chunk for a repository is repaired on retry", async () => {
    const db = attributionFixture();
    const manyFindings = Array.from({ length: 30 }, (_, i) => ({
      mergeClass: "should-fix" as const,
      category: "logic",
      file_path: `src/f${i}.ts`,
      line_start: i + 1,
      line_end: i + 2,
      title: `Finding ${i}`,
      body: "body",
      fingerprint_hint: `fp-${i}`,
    }));
    const pay = delivery("widgets", {
      hintTargetId: TARGET_B_ID,
      selectedRowIds: ["row-1"],
      seen: [{ rowId: "row-1", findingId: "f-1" }],
      assessments: [
        {
          rowId: "row-1",
          disposition: "unverifiable",
          reason: "no-evidence",
          evidence: null,
          relatedCurrentFindingIndexes: [],
        },
      ],
      artifactPayload: enginePayload({ findings: manyFindings }),
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    db.raw.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON review_finding_rounds BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    await expect(applyPublishedLifecycle(db, "pub-1", lease, 2000)).rejects.toThrow(/boom/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 30 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT DISTINCT target_id FROM reviews").all()).toEqual([{ target_id: TARGET_ID }]);

    db.raw.exec("DROP TRIGGER boom");
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 3000)).toBe(true);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 30 });
    expect(db.raw.query("SELECT COUNT(DISTINCT review_id) AS n FROM findings").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT finding_id, target_id FROM review_findings").all()).toEqual([
      { finding_id: "f-1", target_id: TARGET_ID },
    ]);
  });

  test("a partially committed artifact is repaired by the next attempt", async () => {
    const db = attributionFixture();
    const manyFindings = Array.from({ length: 30 }, (_, i) => ({
      mergeClass: "should-fix" as const,
      category: "logic",
      file_path: `src/h${i}.ts`,
      line_start: i + 1,
      line_end: i + 2,
      title: `Finding ${i}`,
      body: "body",
      fingerprint_hint: `fp-${i}`,
    }));
    const pay = payload({
      artifact: artifactDoc({ payload: enginePayload({ findings: manyFindings }) }),
      lifecycle: lifecycleRound({ seen: [seenEntry("row-1", "f-1")] }),
    });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    db.raw.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON findings WHEN (SELECT COUNT(*) FROM findings) >= 24 BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    await expect(applyPublishedLifecycle(db, "pub-1", lease, 2000)).rejects.toThrow(/boom/);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 24 });

    db.raw.exec("DROP TRIGGER boom");
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 3000)).toBe(true);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 30 });
    expect(db.raw.query("SELECT COUNT(DISTINCT review_id) AS n FROM findings").get()).toEqual({ n: 1 });
  });

  test("one repository's apply cannot attach findings to another repository's review", async () => {
    const db = attributionFixture();
    const twoFindings = [0, 1].map((i) => ({
      mergeClass: "should-fix" as const,
      category: "logic",
      file_path: `src/k${i}.ts`,
      line_start: i + 1,
      line_end: i + 2,
      title: `Finding ${i}`,
      body: "body",
      fingerprint_hint: `fp-${i}`,
    }));
    const aArtifact = artifactDoc({ payload: enginePayload({ findings: twoFindings }) });
    await createArtifactStore(db).put(aArtifact);
    expect(db.raw.query("SELECT id, repo, target_id FROM reviews").all()).toEqual([
      { id: aArtifact.key, repo: "widgets", target_id: TARGET_ID },
    ]);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings WHERE review_id = ?").get(aArtifact.key)).toEqual({
      n: 2,
    });

    const pay = delivery("gadgets", {
      hintTargetId: TARGET_ID,
      seen: [{ rowId: "row-2", findingId: "f-2" }],
      artifactPayload: enginePayload({ findings: twoFindings }),
    });
    const lease = await stageClaimProve(db, "pub-2", pay, 1000);
    expect(await applyPublishedLifecycle(db, "pub-2", lease, 2000)).toBe(true);

    const bKey = pay.artifact!.key;
    expect(db.raw.query("SELECT id, repo, target_id FROM reviews ORDER BY repo").all()).toEqual([
      { id: bKey, repo: "gadgets", target_id: TARGET_B_ID },
      { id: aArtifact.key, repo: "widgets", target_id: TARGET_ID },
    ]);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings WHERE review_id = ?").get(aArtifact.key)).toEqual({
      n: 2,
    });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings WHERE review_id = ?").get(bKey)).toEqual({ n: 2 });
    expect(db.raw.query("SELECT finding_id, target_id FROM review_findings").all()).toEqual([
      { finding_id: "f-2", target_id: TARGET_B_ID },
    ]);
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id, target_id)
           VALUES ('review-dup', ?, 'acme', 'widgets', 42, ?, 'needs fixes', ?, ?)`,
        )
        .run(SCOPE.installationId, SHA, APP_ID, TARGET_ID),
    ).toThrow(/UNIQUE/);
  });

  test("a superseded lease aborts the artifact chunk too", async () => {
    const db = attributionFixture();
    const twoFindings = [0, 1].map((i) => ({
      mergeClass: "should-fix" as const,
      category: "logic",
      file_path: `src/g${i}.ts`,
      line_start: i + 1,
      line_end: i + 2,
      title: `Finding ${i}`,
      body: "body",
      fingerprint_hint: `fp-${i}`,
    }));
    const pay = payload({ artifact: artifactDoc({ payload: enginePayload({ findings: twoFindings }) }) });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    db.raw.exec(
      `CREATE TRIGGER rival_after_review AFTER INSERT ON reviews BEGIN
         UPDATE review_publications SET holder = 'rival', lease_epoch = lease_epoch + 1 WHERE id = 'pub-1';
       END`,
    );

    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(false);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_findings").get()).toEqual({ n: 0 });
    expect(publicationRow(db, "pub-1")).toMatchObject({ phase: "confirmed", applied_ms: null });
  });

  test("a new fingerprint under a repository lands on that repository's target", async () => {
    const db = attributionFixture();
    const first = await stageClaimProve(
      db,
      "pub-1",
      delivery("widgets", { seen: [{ rowId: "row-1", findingId: "f-1" }] }),
      1000,
    );
    expect(await applyPublishedLifecycle(db, "pub-1", first, 2000)).toBe(true);

    const second = await stageClaimProve(
      db,
      "pub-2",
      delivery("gadgets", {
        headSha: SHA2,
        hintTargetId: TARGET_ID,
        seen: [{ rowId: "row-2", findingId: "f-2" }],
      }),
      10_000,
    );
    expect(await applyPublishedLifecycle(db, "pub-2", second, 11_000)).toBe(true);

    expect(
      db.raw.query("SELECT finding_id, target_id FROM review_findings ORDER BY finding_id").all(),
    ).toEqual([
      { finding_id: "f-1", target_id: TARGET_ID },
      { finding_id: "f-2", target_id: TARGET_B_ID },
    ]);

    const store = createReviewBotsStore(db);
    expect(
      (await store.listPullRequestFindings(scopeB, "acme", "gadgets", 42, PAGE))!.items.map((row) => row.finding_id),
    ).toEqual(["f-2"]);
    expect(
      (await store.listPullRequestFindings(scopeA, "acme", "widgets", 42, PAGE))!.items.map((row) => row.finding_id),
    ).toEqual(["f-1"]);
  });
});

describe("public findings attach to the review that exists", () => {
  function seedHistoricalReview(db: TestD1, id: string): void {
    db.raw
      .prepare(
        `INSERT INTO reviews
           (id, installation_id, owner, repo, pr_number, head_sha, verdict, bot_id, target_id)
         VALUES (?, ?, 'acme', 'widgets', 42, ?, 'needs fixes', ?, ?)`,
      )
      .run(id, SCOPE.installationId, SHA, APP_ID, TARGET_ID);
  }

  test("a review written under a UUID id adopts this attempt's findings", async () => {
    const db = createSeededTestD1();
    const historicalId = crypto.randomUUID();
    seedHistoricalReview(db, historicalId);
    const pay = payload({ lifecycle: lifecycleRound({ seen: [seenEntry("row-1", "f-1")] }) });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);

    expect(db.raw.query("SELECT id FROM reviews").all()).toEqual([{ id: historicalId }]);
    expect(
      db.raw.query("SELECT COUNT(*) AS n, COUNT(DISTINCT review_id) AS reviews FROM findings").get(),
    ).toEqual({ n: 1, reviews: 1 });
    expect(db.raw.query("SELECT DISTINCT review_id FROM findings").all()).toEqual([
      { review_id: historicalId },
    ]);
    expect(db.raw.query("SELECT finding_id, target_id FROM review_findings").all()).toEqual([
      { finding_id: "f-1", target_id: TARGET_ID },
    ]);
  });

  test("a head with no review yet gets this attempt's derived id", async () => {
    const db = createSeededTestD1();
    const pay = payload({ lifecycle: lifecycleRound({ seen: [seenEntry("row-1", "f-1")] }) });
    const lease = await stageClaimProve(db, "pub-1", pay, 1000);
    expect(await applyPublishedLifecycle(db, "pub-1", lease, 2000)).toBe(true);

    const derived = pay.artifact!.key;
    expect(db.raw.query("SELECT id FROM reviews").all()).toEqual([{ id: derived }]);
    expect(db.raw.query("SELECT DISTINCT review_id FROM findings").all()).toEqual([
      { review_id: derived },
    ]);
  });
});
