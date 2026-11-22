import { describe, expect, test } from "bun:test";
import type { ArtifactKind, MstarReviewFinding, MstarReviewV1 } from "@mstar-harness/engine";
import {
  createArtifactStore,
  parseIdemKey,
  REVIEW_SKILL_VERSION,
  type ReviewArtifactDoc,
} from "../../src/store/artifact-store";
import { computeFindingFingerprint } from "../../src/store/fingerprint";
import { REDACTED } from "../../src/pipeline/redact";
import { idemKey } from "../../src/contracts/idem";
import { createMigratedTestD1, seedTarget, type TestD1 } from "./helpers";
import type { ReviewRow } from "../../src/store/types";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const KEY_TUPLE = { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: SHA };
const KEY = idemKey(KEY_TUPLE);

const TEST_APP_ID = "11111111-2222-3333-4444-555555555555";
const TEST_TARGET_ID = "11111111-2222-3333-4444-666666666666";

function payload(overrides: Partial<MstarReviewV1> = {}): MstarReviewV1 {
  return {
    schema: "mstar.review/v1",
    verdict: "needs fixes",
    summary_md: "No blocking issues.",
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
      },
    ],
    ...overrides,
  };
}

function reviewDoc(overrides: Partial<ReviewArtifactDoc> = {}): ReviewArtifactDoc {
  return {
    kind: "review",
    key: KEY,
    schema: "mstar.review/v1",
    payload: payload(),
    appId: TEST_APP_ID,
    targetId: TEST_TARGET_ID,
    ...overrides,
  };
}

function seedAppRow(db: ReturnType<typeof createMigratedTestD1>, id: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 1001, 'store-test-app', 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id);
}

function createSeededTestD1(): TestD1 {
  const db = createMigratedTestD1();
  seedAppRow(db, TEST_APP_ID);
  seedTarget(db, TEST_APP_ID, { id: TEST_TARGET_ID });
  return db;
}

describe("createArtifactStore().put", () => {
  test("writes the v1-caliber review row + findings with the envelope as authority", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc());

    const row = db.raw.query("SELECT * FROM reviews").get() as ReviewRow;
    expect(row.installation_id).toBe(123);
    expect(row.owner).toBe("acme");
    expect(row.repo).toBe("widgets");
    expect(row.pr_number).toBe(42);
    expect(row.head_sha).toBe(SHA);
    expect(row.verdict).toBe("needs fixes");
    expect(row.summary_md).toBe("No blocking issues.");
    expect(row.skill_version).toBe(REVIEW_SKILL_VERSION);
    expect(row.envelope).not.toBeNull();
    expect(JSON.parse(row.envelope!)).toEqual(payload());
    expect(row.raw_output).toBeNull();

    expect(row.model).toBeNull();
    expect(row.provider).toBeNull();

    const finding = db.raw.query("SELECT * FROM findings").get() as {
      severity: string;
      category: string;
      file_path: string;
      line_start: number;
      line_end: number;
      title: string;
      body: string;
      fingerprint: string;
      status: string;
    };
    expect(finding.severity).toBe("should-fix");
    expect(finding).toMatchObject({
      category: "logic",
      file_path: "src/a.ts",
      line_start: 10,
      line_end: 12,
      title: "Null deref risk",
      body: "body",
      fingerprint: "fp-1",
      status: "open",
    });
  });

  test("writes the normalized computed fingerprint for findings without a hint", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    const findings: MstarReviewFinding[] = [
      {
        mergeClass: "should-fix",
        category: "logic",
        file_path: "src/a.ts",
        line_start: 15,
        line_end: 16,
        title: "Null deref risk",
        body: "b1",
      },
      { mergeClass: "nit", title: "Docs typo", body: "b2" },
    ];

    await store.put(reviewDoc({ payload: payload({ findings }) }));

    const rows = db.raw.query("SELECT title, fingerprint FROM findings ORDER BY rowid").all() as Array<{
      title: string;
      fingerprint: string | null;
    }>;
    expect(rows).toHaveLength(2);
    for (const [i, finding] of findings.entries()) {
      expect(rows[i]!.fingerprint).not.toBeNull();
      expect(rows[i]!.fingerprint).toBe(computeFindingFingerprint(finding));
    }
  });

  test("hint findings keep the hint verbatim, even when the normalized value would differ", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    const findings: MstarReviewFinding[] = [
      { mergeClass: "should-fix", title: "Titled", body: "b", fingerprint_hint: "legacy-hint-42" },
    ];

    await store.put(reviewDoc({ payload: payload({ findings }) }));

    const row = db.raw.query("SELECT fingerprint FROM findings").get() as { fingerprint: string | null };
    expect(row.fingerprint).toBe("legacy-hint-42");
    expect(row.fingerprint).not.toBe(
      computeFindingFingerprint({ mergeClass: "should-fix", title: "Titled" }),
    );
  });

  test("era semantics: put never backfills historical NULL fingerprints", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    const oldReviewId = crypto.randomUUID();
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, skill_version, envelope)
         VALUES (?, 123, 'acme', 'widgets', 42, ?, 'needs fixes', 'old', 'mstar.review/v1', NULL)`,
      )
      .run(oldReviewId, "e".repeat(40));
    db.raw
      .prepare(
        `INSERT INTO findings (id, review_id, severity, file_path, line_start, title, body, fingerprint)
         VALUES (?, ?, 'should-fix', 'src/old.ts', 1, 'Old era', 'ob', NULL)`,
      )
      .run(crypto.randomUUID(), oldReviewId);

    const newFinding: MstarReviewFinding = {
      mergeClass: "should-fix",
      category: "logic",
      file_path: "src/a.ts",
      line_start: 10,
      line_end: 12,
      title: "Null deref risk",
      body: "body",
    };
    await store.put(reviewDoc({ payload: payload({ findings: [newFinding] }) }));

    const eraRow = db.raw
      .query("SELECT fingerprint FROM findings WHERE review_id = ?")
      .get(oldReviewId) as { fingerprint: string | null };
    expect(eraRow.fingerprint).toBeNull();
    const newRow = db.raw
      .query("SELECT fingerprint FROM findings WHERE review_id != ?")
      .get(oldReviewId) as { fingerprint: string | null };
    expect(newRow.fingerprint).toBe(computeFindingFingerprint(newFinding));
  });

  test("a [REDACTED] hint is never persisted as identity — the normalized fingerprint lands instead (W-1)", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    const finding: MstarReviewFinding = {
      mergeClass: "should-fix",
      category: "logic",
      file_path: "src/a.ts",
      line_start: 10,
      line_end: 12,
      title: "Null deref risk",
      body: "body",
      fingerprint_hint: REDACTED,
    };
    await store.put(reviewDoc({ payload: payload({ findings: [finding] }) }));
    const row = db.raw.query("SELECT fingerprint FROM findings").get() as { fingerprint: string | null };
    expect(row.fingerprint).not.toBe(REDACTED);
    expect(row.fingerprint).toBe(computeFindingFingerprint(finding));
  });

  test("per-App put persists bot_id and target_id; historical NULL rows stay NULL (appId required, zero DDL)", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc());

    const perApp = db.raw.query("SELECT bot_id, target_id FROM reviews WHERE head_sha = ?").get(SHA) as {
      bot_id: string | null;
      target_id: string | null;
    };
    expect(perApp.bot_id).toBe(TEST_APP_ID);
    expect(perApp.target_id).toBe(TEST_TARGET_ID);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, skill_version, envelope, bot_id)
         VALUES (?, 123, 'acme', 'widgets', 42, ?, 'needs fixes', 'historical', 'mstar.review/v1', NULL, NULL)`,
      )
      .run(crypto.randomUUID(), "f".repeat(40));
    const legacy = db.raw.query("SELECT bot_id FROM reviews WHERE head_sha = ?").get("f".repeat(40)) as {
      bot_id: string | null;
    };
    expect(legacy.bot_id).toBeNull();
  });

  test("version records: a put carrying model/provider persists them; explicit nulls stay NULL", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc({ model: "ark/deepseek-v4-flash", provider: null }));
    await store.put(
      reviewDoc({ key: idemKey({ ...KEY_TUPLE, head_sha: "f".repeat(40) }), model: null }),
    );
    await store.put(
      reviewDoc({
        key: idemKey({ ...KEY_TUPLE, head_sha: "e".repeat(40) }),
        provider: "openrouter",
      }),
    );

    const withModel = db.raw.query("SELECT model, provider FROM reviews WHERE head_sha = ?").get(SHA) as {
      model: string | null;
      provider: string | null;
    };
    expect(withModel.model).toBe("ark/deepseek-v4-flash");
    expect(withModel.provider).toBeNull();
    const explicitNull = db.raw
      .query("SELECT model, provider FROM reviews WHERE head_sha = ?")
      .get("f".repeat(40)) as { model: string | null; provider: string | null };
    expect(explicitNull.model).toBeNull();
    expect(explicitNull.provider).toBeNull();
    const withProvider = db.raw
      .query("SELECT model, provider FROM reviews WHERE head_sha = ?")
      .get("e".repeat(40)) as { model: string | null; provider: string | null };
    expect(withProvider.model).toBeNull();
    expect(withProvider.provider).toBe("openrouter");
  });

  test("contextIncomplete: absent keeps 0, `true` persists 1 (a capture-failed round is not a base)", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc());
    await store.put(
      reviewDoc({ key: idemKey({ ...KEY_TUPLE, head_sha: "c".repeat(40) }), contextIncomplete: true }),
    );

    const healthy = db.raw.query("SELECT context_incomplete FROM reviews WHERE head_sha = ?").get(SHA) as {
      context_incomplete: number;
    };
    expect(healthy.context_incomplete).toBe(0);
    const failed = db.raw
      .query("SELECT context_incomplete FROM reviews WHERE head_sha = ?")
      .get("c".repeat(40)) as { context_incomplete: number };
    expect(failed.context_incomplete).toBe(1);
    const envelope = db.raw
      .query("SELECT envelope FROM reviews WHERE head_sha = ?")
      .get("c".repeat(40)) as { envelope: string };
    expect(JSON.parse(envelope.envelope)).toEqual(payload());
  });

  test("durationMs: a measured clock persists; an omitted one stays NULL (never fabricated)", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc({ durationMs: 42_000 }));
    await store.put(reviewDoc({ key: idemKey({ ...KEY_TUPLE, head_sha: "d".repeat(40) }) }));
    await store.put(
      reviewDoc({ key: idemKey({ ...KEY_TUPLE, head_sha: "e".repeat(40) }), durationMs: 0 }),
    );

    const measured = db.raw.query("SELECT duration_ms FROM reviews WHERE head_sha = ?").get(SHA) as {
      duration_ms: number | null;
    };
    expect(measured.duration_ms).toBe(42_000);
    const unmeasured = db.raw
      .query("SELECT duration_ms FROM reviews WHERE head_sha = ?")
      .get("d".repeat(40)) as { duration_ms: number | null };
    expect(unmeasured.duration_ms).toBeNull();
    const zeroed = db.raw
      .query("SELECT duration_ms FROM reviews WHERE head_sha = ?")
      .get("e".repeat(40)) as { duration_ms: number | null };
    expect(zeroed.duration_ms).toBe(0);
  });

  test("an appId or targetId with no row is FK-rejected with zero rows written", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await expect(store.put(reviewDoc({ appId: "no-such-app" }))).rejects.toThrow(/FOREIGN KEY/);
    await expect(store.put(reviewDoc({ targetId: "no-such-target" }))).rejects.toThrow(/FOREIGN KEY/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
  });

  test("second put for the same key resolves idempotently — 1 row, first write wins", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc());
    await store.put(
      reviewDoc({ payload: payload({ verdict: "ship it", summary_md: "RETRY ATTEMPT" }) }),
    );

    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(1);
    const findings = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(findings.n).toBe(1);
    const row = db.raw.query("SELECT verdict, summary_md FROM reviews").get() as {
      verdict: string;
      summary_md: string;
    };
    expect(row.verdict).toBe("needs fixes");
    expect(row.summary_md).toBe("No blocking issues.");
  });

  test("rejects an M1 payload (verdict 'approve') with zero rows written", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await expect(
      store.put(reviewDoc({ payload: payload({ verdict: "approve" as never }) })),
    ).rejects.toThrow(/validateMstarReviewV1/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
  });

  test("rejects a stray M1 severity key on a finding with review.inspector-vocab", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    const m1 = payload();
    (m1.findings[0] as Record<string, unknown>).severity = "warning";
    await expect(store.put(reviewDoc({ payload: m1 }))).rejects.toThrow(/review\.inspector-vocab/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
  });

  test("rejects a doc whose schema id is not mstar.review/v1", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await expect(store.put(reviewDoc({ schema: "mstar.review/v2" }))).rejects.toThrow(/doc\.schema/);
    await expect(store.put(reviewDoc({ schema: undefined }))).rejects.toThrow(/doc\.schema/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
  });

  test("rejects a payload.target that disagrees with the key five-tuple", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    const owner = payload({ target: { owner: "other", repo: "widgets", pr: 42, head_sha: SHA } });
    const sha = payload({ target: { owner: "acme", repo: "widgets", pr: 42, head_sha: "ffffffff" } });
    const pr = payload({ target: { owner: "acme", repo: "widgets", pr: 43, head_sha: SHA } });

    await expect(store.put(reviewDoc({ payload: owner }))).rejects.toThrow(
      /owner "other" != key "acme"/,
    );
    await expect(store.put(reviewDoc({ payload: sha }))).rejects.toThrow(/head_sha "ffffffff" != key/);
    await expect(store.put(reviewDoc({ payload: pr }))).rejects.toThrow(/pr 43 != key 42/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
  });

  test("accepts a payload with no target (the key five-tuple is authoritative)", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc({ payload: payload({ target: undefined }) }));

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
  });

  test("rejects keys that are not parseable idemKey() strings, including an empty sha", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    await expect(store.put(reviewDoc({ key: "not-an-idem-key" }))).rejects.toThrow(/idemKey\(\) string/);
    await expect(store.put(reviewDoc({ key: "idem:123:acme/widgets:42:" }))).rejects.toThrow(
      /head_sha must be a non-empty string/,
    );
    await expect(store.put(reviewDoc({ key: "idem:x:acme/widgets:42:abc" }))).rejects.toThrow(
      /non-numeric/,
    );
    await expect(store.put(reviewDoc({ key: "idem:123:acme:42:abc" }))).rejects.toThrow(
      /owner\/repo segment/,
    );

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
  });

  test("throws for every non-review kind and writes nothing", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    const retiredKinds = ["status", "snapshot", "residuals"] as unknown as ArtifactKind[];
    for (const kind of [...retiredKinds, "json"] as ArtifactKind[]) {
      await expect(
        store.put({ kind, key: "root", payload: {}, appId: TEST_APP_ID, targetId: TEST_TARGET_ID }),
      ).rejects.toThrow(new RegExp(`"${kind}" is not persisted`));
    }

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
  });

  test("a findings failure mid-batch rolls back the review row (atomic put)", async () => {
    const db = createSeededTestD1();
    db.raw.exec(
      `CREATE TRIGGER fail_findings BEFORE INSERT ON findings
       WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'injected findings failure'); END;`,
    );
    const store = createArtifactStore(db);

    await expect(
      store.put(
        reviewDoc({
          payload: payload({
            findings: [
              { mergeClass: "should-fix", title: "ok", body: "b1" },
              { mergeClass: "should-fix", title: "boom", body: "b2" },
            ],
          }),
        }),
      ),
    ).rejects.toThrow(/injected findings failure/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
  });

  test("delete and list are omitted (engine contract: probe typeof)", () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    expect(typeof store.delete).toBe("undefined");
    expect(typeof store.list).toBe("undefined");
  });
});

describe("createArtifactStore().put — optional summary", () => {
  test("a review whose envelope carries no summary persists, with summary_md NULL", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    const { summary_md: _omitted, ...noSummary } = payload();
    await store.put(reviewDoc({ payload: noSummary as MstarReviewV1 }));

    const row = db.raw.query("SELECT * FROM reviews").get() as ReviewRow;
    expect(row.summary_md).toBeNull();
    expect(row.verdict).toBe("needs fixes");
  });
});

describe("createArtifactStore().put — publication round", () => {
  test("stores the round the consumer staged; absent stays NULL", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    await store.put(reviewDoc({ round: 4 }));
    await store.put(reviewDoc({ key: idemKey({ ...KEY_TUPLE, head_sha: "a".repeat(40) }) }));

    const rows = db.raw
      .query("SELECT head_sha, round FROM reviews ORDER BY round")
      .all() as Array<{ head_sha: string; round: number | null }>;
    expect(rows).toEqual([
      { head_sha: "a".repeat(40), round: null },
      { head_sha: SHA, round: 4 },
    ]);
  });
});

  test("an envelope with several findings round-trips, and a repeat put writes nothing new", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    const twoFindings = payload({
      findings: [
        {
          mergeClass: "should-fix",
          category: "logic",
          file_path: "src/a.ts",
          line_start: 1,
          line_end: 2,
          title: "First",
          body: "a",
          fingerprint_hint: "fp-a",
        },
        {
          mergeClass: "nit",
          category: "style",
          file_path: "src/b.ts",
          line_start: 3,
          line_end: 4,
          title: "Second",
          body: "b",
          fingerprint_hint: "fp-b",
        },
      ],
    });
    const doc = reviewDoc({ payload: twoFindings });

    await store.put(doc);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 2 });
    expect(db.raw.query("SELECT COUNT(DISTINCT review_id) AS n FROM findings").get()).toEqual({ n: 1 });
    expect(await store.get({ kind: "review", key: KEY })).toEqual(twoFindings);

    await store.put(doc);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 2 });
  });

describe("createArtifactStore().get", () => {
  test("returns the parsed envelope for a v1 row", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    await store.put(reviewDoc());

    const envelope = await store.get<MstarReviewV1>({ kind: "review", key: KEY });

    expect(envelope).toEqual(payload());
    expect(envelope?.schema).toBe("mstar.review/v1");
  });

  test("returns undefined for a missing row", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    expect(await store.get({ kind: "review", key: KEY })).toBeUndefined();
  });

  test("returns undefined for an M1-era row (envelope NULL) — never served as v1", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, raw_output)
         VALUES ('m1-row', 123, 'acme', 'widgets', 42, ?, 'comment', 'M1 history', '{}')`,
      )
      .run(SHA);

    expect(await store.get<MstarReviewV1>({ kind: "review", key: KEY })).toBeUndefined();
    expect(await store.findByIdempotencyKey(KEY_TUPLE)).not.toBeNull();
  });

  test("throws for a non-review kind and an unparseable key", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);

    const retiredKind = "status" as unknown as ArtifactKind;
    await expect(store.get({ kind: retiredKind, key: "root" })).rejects.toThrow(/"status" is not served/);
    await expect(store.get({ kind: "review", key: "junk" })).rejects.toThrow(/idemKey\(\) string/);
  });
});

describe("createArtifactStore().findByIdempotencyKey", () => {
  test("returns the row for an existing key and null for an unknown key", async () => {
    const db = createSeededTestD1();
    const store = createArtifactStore(db);
    await store.put(reviewDoc());

    const found = await store.findByIdempotencyKey(KEY_TUPLE);
    expect(found).not.toBeNull();
    expect(found?.head_sha).toBe(SHA);
    expect(found?.owner).toBe("acme");
    expect(found?.envelope).not.toBeNull();

    const missing = await store.findByIdempotencyKey({ ...KEY_TUPLE, head_sha: "f".repeat(40) });
    expect(missing).toBeNull();
  });
});

describe("parseIdemKey", () => {
  test("round-trips an idemKey() string into the five-tuple", () => {
    expect(parseIdemKey(KEY)).toEqual(KEY_TUPLE);
  });

  test("rejects an empty head_sha (the hard sha invariant)", () => {
    expect(() => parseIdemKey(idemKey({ ...KEY_TUPLE, head_sha: "" }))).toThrow(
      /head_sha must be a non-empty string/,
    );
  });
});
