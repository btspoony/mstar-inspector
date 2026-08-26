/**
 * Central Review Store repository layer (plan 05 Task 2).
 *
 * Idempotent insert: `INSERT ... ON CONFLICT DO NOTHING` on the UNIQUE
 * (installation_id, owner, repo, pr_number, head_sha) constraint — a no-op
 * (`meta.changes === 0`) means another consumer already wrote the row, so the
 * outcome is `duplicate` and no findings are written (plan Clarify 3.4).
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Truncate the raw payload to 64KB of UTF-8 bytes (byte-exact cap). */
function truncateRaw(raw: string): string {
  const bytes = encoder.encode(raw);
  if (bytes.byteLength <= RAW_OUTPUT_LIMIT_BYTES) return raw;
  return decoder.decode(bytes.subarray(0, RAW_OUTPUT_LIMIT_BYTES));
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

      const inserted = await db
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
        )
        .run();

      if (inserted.meta.changes === 0) {
        // UNIQUE conflict — another consumer already stored this sha.
        return { outcome: "duplicate" };
      }

      for (const finding of input.output.findings) {
        await db
          .prepare(
            `INSERT INTO findings (id, review_id, severity, category, file_path, line_start, line_end, title, body, fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            reviewId,
            finding.severity,
            finding.category,
            finding.file_path,
            finding.line_start,
            finding.line_end,
            finding.title,
            finding.body,
            finding.fingerprint_hint ?? null,
          )
          .run();
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
