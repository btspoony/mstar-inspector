/**
 * Central Review Store repository layer (plan 05 Task 2).
 *
 * Idempotent insert: `INSERT ... ON CONFLICT DO NOTHING` on the UNIQUE
 * (installation_id, owner, repo, pr_number, head_sha) constraint — a no-op
 * (`meta.changes === 0`) means another consumer already wrote the row, so the
 * outcome is `duplicate` and no findings are written (plan Clarify 3.4).
 *
 * Atomicity (plan 05 T2 review I1): the review row and ALL its findings are
 * written in ONE `db.batch([...])` call. Cloudflare D1 documents batch as a
 * transaction — "Statements are executed sequentially and non-concurrently as
 * a transaction. If any statement fails, the entire sequence is aborted or
 * rolled back" (developers.cloudflare.com/d1/worker-api/d1-database). A
 * mid-batch findings failure therefore leaves ZERO review rows, so a queue
 * retry's `findByIdempotencyKey` cannot find a partial review and skip the
 * GitHub comment (the unrecoverable-partial-review failure mode). The real
 * `D1Database` has no `transaction()` method (workers-types 5.20260825.1:
 * prepare/batch/exec/withSession/dump only), so batch is the transactional
 * primitive; the bun:sqlite test double implements it with an explicit
 * BEGIN/COMMIT/ROLLBACK around the statements (bun:sqlite's async
 * `db.transaction()` does not roll back, so it cannot model D1 batch).
 *
 * Duplicate outcome inside the batch: findings are guarded by
 * `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ?)`.
 * On a UNIQUE no-op the review insert changes 0 rows, the new UUID does not
 * exist, and each findings statement writes 0 rows — no FK failure, batch
 * succeeds, and the caller branches on `changes === 0` to return
 * `{ outcome: "duplicate" }`. Only the named UNIQUE conflict is treated as
 * duplicate; any other statement error still throws (and rolls back).
 *
 * Module boundary (compass contracts A): type-only imports only — no
 * worker/pipeline/session/omp runtime dependencies. The `db` parameter is the
 * narrow D1 face (`D1Like`) so the bun:sqlite test double and a real
 * `D1Database` both satisfy it structurally (plan Clarify 5).
 */

import type { IdempotencyKey } from "../contracts/idem";
import type { D1Like, ReviewInsert, ReviewRow, StoreResult } from "./types";

/** Cap for `raw_output` (plan Clarify 4): summary_md + raw JSON, 64KB max. */
const RAW_OUTPUT_LIMIT_BYTES = 64 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Truncate the raw payload to 64KB of UTF-8 bytes (byte-exact cap, plan 05 T2
 * review Minor 1). Cutting at the byte boundary can split a multi-byte code
 * point; the replacement character re-encodes to 3 bytes, which can push the
 * result back over the cap. Shrink until the re-encoded payload fits — the
 * loop invariant is "stored bytes ≤ 64KB", and it terminates within a few
 * bytes (only the single incomplete trailing sequence can grow).
 */
function truncateRaw(raw: string): string {
  const bytes = encoder.encode(raw);
  if (bytes.byteLength <= RAW_OUTPUT_LIMIT_BYTES) return raw;
  let end = RAW_OUTPUT_LIMIT_BYTES;
  let truncated = decoder.decode(bytes.subarray(0, end));
  while (encoder.encode(truncated).byteLength > RAW_OUTPUT_LIMIT_BYTES) {
    end--;
    truncated = decoder.decode(bytes.subarray(0, end));
  }
  return truncated;
}

export type ReviewStore = {
  insertReview(input: ReviewInsert): Promise<StoreResult>;
  findByIdempotencyKey(key: IdempotencyKey): Promise<ReviewRow | null>;
  listByRepo(owner: string, repo: string, limit?: number): Promise<ReviewRow[]>;
};

export function createReviewStore(db: D1Like): ReviewStore {
  return {
    async insertReview(input) {
      if (!input.key.head_sha) {
        throw new Error("insertReview: head_sha must be a non-empty string");
      }
      const reviewId = crypto.randomUUID();
      const raw = truncateRaw(input.raw);

      const reviewStmt = db
        .prepare(
          `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, model, skill_version, raw_output)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (installation_id, owner, repo, pr_number, head_sha) DO NOTHING`,
        )
        .bind(
          reviewId,
          input.key.installation_id,
          input.key.owner,
          input.key.repo,
          input.key.pr_number,
          input.key.head_sha,
          input.output.verdict,
          input.output.summary_md,
          input.model ?? null,
          input.skill_version ?? null,
          raw,
        );

      // Findings are guarded by WHERE EXISTS on the review id: on a UNIQUE
      // no-op the review insert writes 0 rows, the new UUID does not exist,
      // and each findings statement writes 0 rows — the batch succeeds and
      // the caller returns { outcome: "duplicate" } below.
      const findingStmts = input.output.findings.map((finding) =>
        db
          .prepare(
            `INSERT INTO findings (id, review_id, severity, category, file_path, line_start, line_end, title, body, fingerprint)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ?)`,
          )
          .bind(
            crypto.randomUUID(),
            reviewId,
            // Interim vocab mapping point (plan 07 Task 3): findings rows
            // carry the mstar.review/v1 mergeClass in the legacy `severity`
            // column until Task 4's ArtifactStore replaces this store.
            finding.mergeClass,
            finding.category,
            finding.file_path,
            finding.line_start,
            finding.line_end,
            finding.title,
            finding.body,
            finding.fingerprint_hint ?? null,
            reviewId,
          ),
      );

      const results = await db.batch([reviewStmt, ...findingStmts]);

      if (results[0]!.meta.changes === 0) {
        // UNIQUE conflict — another consumer already stored this sha.
        return { outcome: "duplicate" };
      }

      return { outcome: "inserted", reviewId };
    },

    async findByIdempotencyKey(key) {
      return db
        .prepare(
          `SELECT * FROM reviews
           WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?`,
        )
        .bind(key.installation_id, key.owner, key.repo, key.pr_number, key.head_sha)
        .first<ReviewRow>();
    },

    async listByRepo(owner, repo, limit) {
      const params: unknown[] = [owner, repo];
      let sql = "SELECT * FROM reviews WHERE owner = ? AND repo = ? ORDER BY reviewed_at DESC";
      if (limit !== undefined) {
        sql += " LIMIT ?";
        params.push(limit);
      }
      const { results } = await db.prepare(sql).bind(...params).all<ReviewRow>();
      return results;
    },
  };
}
