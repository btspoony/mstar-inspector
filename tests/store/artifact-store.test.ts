/**
 * ArtifactStore adapter tests (plan 07 Task 4) — `src/store/artifact-store.ts`
 * against the bun:sqlite test double running the real migration SQL
 * (0001 + 0002, DDL single sources).
 *
 * Acceptance points (brief T4 / spec mstar-review-v1-consumption):
 *   - put writes the v1-caliber row: envelope = full JSON, raw_output NULL,
 *     skill_version pinned, findings.severity = mergeClass (the single
 *     vocab-switch mapping point)
 *   - second put for the same sha resolves idempotently — still 1 review
 *     row, no duplicate findings, the first-written row is NOT overwritten
 *     (declared deviation from FsStore overwrite semantics)
 *   - put gate: an M1 payload (verdict "approve", stray severity key) throws
 *     with zero rows written (engine validateMstarReviewV1)
 *   - key/target disagreement and unparseable/empty-sha keys throw
 *   - other kinds (status/snapshot/residuals/json) throw; delete/list omitted
 *   - one db.batch is atomic: a mid-batch findings failure leaves zero rows
 *   - get returns the parsed envelope; missing row and M1 row (envelope
 *     NULL) → undefined
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactDoc, MstarReviewV1 } from "@mstar-harness/engine";
import { createArtifactStore, parseIdemKey, REVIEW_SKILL_VERSION } from "../../src/store/artifact-store";
import { idemKey } from "../../src/contracts/idem";
import { createTestD1 } from "./helpers";
import type { ReviewRow } from "../../src/store/types";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const KEY_TUPLE = { installation_id: 123, owner: "acme", repo: "widgets", pr_number: 42, head_sha: SHA };
const KEY = idemKey(KEY_TUPLE);

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

function reviewDoc(overrides: Partial<ArtifactDoc> = {}): ArtifactDoc {
  return { kind: "review", key: KEY, schema: "mstar.review/v1", payload: payload(), ...overrides };
}

describe("createArtifactStore().put", () => {
  test("writes the v1-caliber review row + findings with the envelope as authority", async () => {
    const db = createTestD1();
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
    // The envelope is the authoritative, losslessly restorable document;
    // raw_output is never written on the v1 path.
    expect(row.envelope).not.toBeNull();
    expect(JSON.parse(row.envelope!)).toEqual(payload());
    expect(row.raw_output).toBeNull();

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
    // mergeClass → severity column: THE vocab-switch mapping point.
    expect(finding.severity).toBe("should-fix");
    expect(finding).toMatchObject({
      category: "logic",
      file_path: "src/a.ts",
      line_start: 10,
      line_end: 12,
      title: "Null deref risk",
      body: "body",
      fingerprint: "fp-1",
      status: "open", // column default
    });
  });

  test("second put for the same key resolves idempotently — 1 row, first write wins", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc());
    await store.put(
      reviewDoc({ payload: payload({ verdict: "ship it", summary_md: "RETRY ATTEMPT" }) }),
    );

    const reviews = db.raw.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(reviews.n).toBe(1);
    const findings = db.raw.query("SELECT COUNT(*) AS n FROM findings").get() as { n: number };
    expect(findings.n).toBe(1);
    // The retry's payload must NOT overwrite the first-written row.
    const row = db.raw.query("SELECT verdict, summary_md FROM reviews").get() as {
      verdict: string;
      summary_md: string;
    };
    expect(row.verdict).toBe("needs fixes");
    expect(row.summary_md).toBe("No blocking issues.");
  });

  test("rejects an M1 payload (verdict 'approve') with zero rows written", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);

    await expect(
      store.put(reviewDoc({ payload: payload({ verdict: "approve" as never }) })),
    ).rejects.toThrow(/validateMstarReviewV1/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
  });

  test("rejects a stray M1 severity key on a finding with review.inspector-vocab", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);

    const m1 = payload();
    (m1.findings[0] as Record<string, unknown>).severity = "warning";
    await expect(store.put(reviewDoc({ payload: m1 }))).rejects.toThrow(/review\.inspector-vocab/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM findings").get()).toEqual({ n: 0 });
  });

  test("rejects a doc whose schema id is not mstar.review/v1", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);

    await expect(store.put(reviewDoc({ schema: "mstar.review/v2" }))).rejects.toThrow(/doc\.schema/);
    await expect(store.put(reviewDoc({ schema: undefined }))).rejects.toThrow(/doc\.schema/);

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
  });

  test("rejects a payload.target that disagrees with the key five-tuple", async () => {
    const db = createTestD1();
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
    const db = createTestD1();
    const store = createArtifactStore(db);

    await store.put(reviewDoc({ payload: payload({ target: undefined }) }));

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 1 });
  });

  test("rejects keys that are not parseable idemKey() strings, including an empty sha", async () => {
    const db = createTestD1();
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
    const db = createTestD1();
    const store = createArtifactStore(db);

    for (const kind of ["status", "snapshot", "residuals", "json"] as const) {
      await expect(store.put({ kind, key: "root", payload: {} })).rejects.toThrow(
        new RegExp(`"${kind}" is not persisted`),
      );
    }

    expect(db.raw.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
  });

  test("a findings failure mid-batch rolls back the review row (atomic put)", async () => {
    const db = createTestD1();
    // Inject a failure on the SECOND findings insert (title 'boom') to prove
    // the review row written earlier in the same batch is rolled back too —
    // a partial review must never survive (plan 05 T2 review I1, absorbed).
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
    const db = createTestD1();
    const store = createArtifactStore(db);

    expect(typeof store.delete).toBe("undefined");
    expect(typeof store.list).toBe("undefined");
  });
});

describe("createArtifactStore().get", () => {
  test("returns the parsed envelope for a v1 row", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);
    await store.put(reviewDoc());

    const envelope = await store.get<MstarReviewV1>({ kind: "review", key: KEY });

    expect(envelope).toEqual(payload());
    expect(envelope?.schema).toBe("mstar.review/v1");
  });

  test("returns undefined for a missing row", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);

    expect(await store.get({ kind: "review", key: KEY })).toBeUndefined();
  });

  test("returns undefined for an M1-era row (envelope NULL) — never served as v1", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);
    db.raw
      .prepare(
        `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, raw_output)
         VALUES ('m1-row', 123, 'acme', 'widgets', 42, ?, 'comment', 'M1 history', '{}')`,
      )
      .run(SHA);

    expect(await store.get<MstarReviewV1>({ kind: "review", key: KEY })).toBeUndefined();
    // The M1 row is still visible to the consumer pre-check (dedup covers it).
    expect(await store.findByIdempotencyKey(KEY_TUPLE)).not.toBeNull();
  });

  test("throws for a non-review kind and an unparseable key", async () => {
    const db = createTestD1();
    const store = createArtifactStore(db);

    await expect(store.get({ kind: "status", key: "root" })).rejects.toThrow(/"status" is not served/);
    await expect(store.get({ kind: "review", key: "junk" })).rejects.toThrow(/idemKey\(\) string/);
  });
});

describe("createArtifactStore().findByIdempotencyKey", () => {
  test("returns the row for an existing key and null for an unknown key", async () => {
    const db = createTestD1();
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
