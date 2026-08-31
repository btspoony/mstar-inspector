/**
 * D1 ArtifactStore adapter (plan 07 Task 4) — the ONE write authority for
 * review persistence. Implements the engine `ArtifactStore` contract for
 * `kind: "review"` only; every other kind (status / snapshot / residuals /
 * json) throws — fail-loud, never a silent no-op pretending success. D1
 * never enumerates or deletes: `delete` / `list` are omitted, which the
 * engine contract explicitly allows (callers probe
 * `typeof store.list === "function"`).
 *
 * Intentional deviation from the engine FsStore overwrite semantics
 * (architect-locked, spec mstar-review-v1-consumption § ArtifactStore): a
 * `put` whose UNIQUE (installation_id, owner, repo, pr_number, head_sha)
 * key already exists does NOT overwrite — it resolves successfully and the
 * first-written row wins. The UNIQUE hard invariant outranks FsStore's
 * last-write-wins: a queue retry losing the write race must never clobber
 * the already-stored review or duplicate its findings. Declared here
 * because the module header is the contract surface for that deviation.
 *
 * Era model (migration 0002): `reviews.envelope IS NOT NULL` ⇔ the row
 * follows the v0.3+ path (mstar.review/v1). M1 rows keep raw_output + M1
 * vocab as read-only history — never rewritten. New rows never write
 * raw_output (the envelope is authoritative; raw_output's 64KB truncation
 * is not losslessly restorable). `findings.severity` carries the harness
 * merge class for v1 rows — the SINGLE vocab-switch mapping point
 * (`MstarReviewFinding.mergeClass` → `severity` column); M1 rows keep
 * critical | warning | suggestion | info. Era disambiguation is always
 * `reviews.envelope IS NOT NULL`.
 *
 * Module boundary (compass contracts A): type imports + the engine
 * pure-function gate (`validateMstarReviewV1` via the engine root entry —
 * the only workerd-legal face) only; no worker/pipeline/session/omp
 * dependencies. The `db` parameter is the narrow D1 face (`D1Like`) so the
 * bun:sqlite test double and a real `D1Database` both satisfy it
 * structurally (plan Clarify 5).
 *
 * Per-App attribution (plan 13, migration 0005): the put doc carries an
 * OPTIONAL caller-supplied `appId` — the resolved `appRef`'s id for per-App
 * messages — which is bound into `reviews.app_id`. Legacy messages (appRef
 * absent or `{ kind: "legacy" }`) omit it and the row keeps `app_id` NULL
 * (Clarify #3: NULL = legacy). The column's FK to `github_apps(id)` makes an
 * unknown appId a loud batch failure, never a silent mis-attribution.
 *
 * Version records (plan 18 Task 1): the put doc may carry the review's
 * `model` (the effective model chain's head selector, consumer-resolved)
 * and `provider` (always NULL on the v1 path — architect AL-2) — both
 * OPTIONAL; omitted = NULL (byte-compat for pre-plan-18 callers).
 */

import {
  validateMstarReviewV1,
  type ArtifactDoc,
  type ArtifactRef,
  type ArtifactStore,
  type MstarReviewV1,
} from "@mstar-harness/engine";
import type { IdempotencyKey } from "../contracts/idem";
import type { D1Like, ReviewRow } from "./types";
import { computeFindingFingerprint } from "./fingerprint";

/** Schema id accepted by `put` / carried by every persisted review doc. */
export const REVIEW_SCHEMA = "mstar.review/v1" as const;

/**
 * `reviews.skill_version` for every v1 row (write caliber, spec § 新行写入
 * 口径): the pinned engine version + harness image commit.
 */
export const REVIEW_SKILL_VERSION = "3.5.0+f1b60df0";

/** Number of `:`-separated segments in an `idemKey()` string. */
const IDEM_KEY_PARTS = 5;

/**
 * Parse an `idemKey()` string (`idem:{installation_id}:{owner}/{repo}:{pr_number}:{head_sha}`)
 * back into its five-tuple — fail-loud on anything unparseable. An empty
 * head_sha is the hard rejection (compass contracts B / S5: a review
 * without a resolved sha is never stored); the schema-level
 * `CHECK (head_sha <> '')` backstops this at the DDL layer.
 */
export function parseIdemKey(key: string): IdempotencyKey {
  const parts = key.split(":");
  if (parts.length !== IDEM_KEY_PARTS || parts[0] !== "idem") {
    throw new Error(
      `artifact-store: key is not an idemKey() string: ${JSON.stringify(key)}`,
    );
  }
  if (!/^\d+$/.test(parts[1]!) || !/^\d+$/.test(parts[3]!)) {
    throw new Error(
      `artifact-store: key has non-numeric installation_id or pr_number: ${JSON.stringify(key)}`,
    );
  }
  const slug = parts[2]!.split("/");
  const owner = slug[0];
  const repo = slug[1];
  if (slug.length !== 2 || !owner || !repo) {
    throw new Error(
      `artifact-store: key has a malformed owner/repo segment: ${JSON.stringify(key)}`,
    );
  }
  const head_sha = parts[4]!;
  if (head_sha === "") {
    throw new Error("artifact-store: head_sha must be a non-empty string");
  }
  return {
    installation_id: Number(parts[1]),
    owner,
    repo,
    pr_number: Number(parts[3]),
    head_sha,
  };
}

/**
 * Cross-check the envelope `target` (when present) against the five-tuple
 * parsed from the idempotency key (architect-locked: 不一致 throw). Fields
 * the envelope omits are not checked — `installation_id` exists only in the
 * key, so the key is authoritative for the five-tuple.
 */
function assertTargetAgrees(key: IdempotencyKey, payload: MstarReviewV1): void {
  const target = payload.target;
  if (target === undefined) return;
  const mismatches: string[] = [];
  if (target.owner !== undefined && target.owner !== key.owner) {
    mismatches.push(`owner ${JSON.stringify(target.owner)} != key ${JSON.stringify(key.owner)}`);
  }
  if (target.repo !== undefined && target.repo !== key.repo) {
    mismatches.push(`repo ${JSON.stringify(target.repo)} != key ${JSON.stringify(key.repo)}`);
  }
  if (target.pr !== undefined && target.pr !== key.pr_number) {
    mismatches.push(`pr ${target.pr} != key ${key.pr_number}`);
  }
  if (target.head_sha !== undefined && target.head_sha !== key.head_sha) {
    mismatches.push(
      `head_sha ${JSON.stringify(target.head_sha)} != key ${JSON.stringify(key.head_sha)}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `artifact-store: payload.target disagrees with the idempotency key (${mismatches.join("; ")}) — zero rows written`,
    );
  }
}

/**
 * The review put input: the engine `ArtifactDoc` plus the caller-supplied
 * per-App attribution (plan 13, QC fix wave 1 F-001) and the plan-18
 * version records (`model` / `provider`). A structural superset
 * of the engine contract — the engine package is unchanged; the consumer is
 * the only production caller and passes `appId` for per-App messages only
 * (legacy/absent appRef omits it → the row keeps `app_id` NULL).
 */
export type ReviewArtifactDoc = ArtifactDoc & {
  /**
   * `github_apps.id` the review belongs to (per-App jobs). Optional —
   * absent/NULL means a legacy (env-App) review. Never a credential.
   */
  appId?: string;
  /**
   * Version record (plan 18 Task 1): the effective model chain's HEAD
   * selector the review ran with, resolved consumer-side via
   * `effectiveModelChain` (single-sourced with `buildRunnerEnv`). Optional;
   * absent/NULL = unset (the in-image default ran — the default selector is
   * recorded in plan 19's runbook, never hardcoded worker-side).
   */
  model?: string | null;
  /**
   * Version record (plan 18 Task 1): always NULL on the v1 path —
   * `RunnerAppConfig` carries a multi-provider key set, not one provider
   * (architect AL-2: do not invent a mapping). Optional; omitted = NULL.
   */
  provider?: string | null;
};

/** The D1 store face: the engine `ArtifactStore` plus the consumer's pre-check. */
export type D1ArtifactStore = ArtifactStore & {
  /**
   * Widened put input (see `ReviewArtifactDoc`): the optional `appId` rides
   * the doc into `reviews.app_id`; the optional `model` / `provider`
   * version records (plan 18 Task 1) ride into `reviews.model` /
   * `reviews.provider` (absent/NULL = unset).
   */
  put(doc: ReviewArtifactDoc): Promise<void>;
  /**
   * Consumer idempotency pre-check (dedup before clone/diff/run). Not part
   * of the engine `ArtifactStore` interface — it stays on the store face
   * (spec mstar-review-v1-consumption § ArtifactStore).
   */
  findByIdempotencyKey(key: IdempotencyKey): Promise<ReviewRow | null>;
};

/**
 * Create the D1-backed ArtifactStore for `kind: "review"`. Absorbs the
 * retired review-store's (src/store/reviews.ts, deleted this task)
 * batch atomicity and UNIQUE duplicate handling (plan 05 T2):
 *
 * The review row and ALL its findings are written in ONE `db.batch([...])`
 * call — Cloudflare D1 documents batch as a transaction ("if any statement
 * fails, the entire sequence is aborted or rolled back"), so a mid-batch
 * findings failure leaves ZERO review rows and a queue retry's
 * `findByIdempotencyKey` cannot find a partial review. Duplicate outcome
 * inside the batch: findings are guarded by
 * `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ?)`
 * — on a UNIQUE no-op the review insert changes 0 rows, the new UUID does
 * not exist, and each findings statement writes 0 rows: no FK failure, the
 * batch succeeds, and the caller's idempotent `put` resolves. Only the
 * named UNIQUE conflict is treated as the idempotent no-op; any other
 * statement error still throws (and rolls back).
 */
export function createArtifactStore(db: D1Like): D1ArtifactStore {
  return {
    async put(doc: ReviewArtifactDoc): Promise<void> {
      if (doc.kind !== "review") {
        throw new Error(
          `artifact-store: kind ${JSON.stringify(doc.kind)} is not persisted by the D1 store (only "review")`,
        );
      }
      if (doc.schema !== REVIEW_SCHEMA) {
        throw new Error(
          `artifact-store: doc.schema must be ${JSON.stringify(REVIEW_SCHEMA)}, got ${JSON.stringify(doc.schema ?? null)}`,
        );
      }
      const key = parseIdemKey(doc.key);

      // Put gate (spec 产品要求 2 /纵深防御): the container already validated
      // this envelope; re-validate BEFORE any row is written so M1 vocab or
      // a malformed envelope fails loud with zero rows written.
      const gate = validateMstarReviewV1(doc.payload);
      if (!gate.ok) {
        const detail = gate.violations.map((v) => `${v.code}: ${v.message}`).join("; ");
        throw new Error(
          `artifact-store: payload failed validateMstarReviewV1 (${detail}) — zero rows written`,
        );
      }
      const payload = doc.payload as MstarReviewV1;
      assertTargetAgrees(key, payload);

      const reviewId = crypto.randomUUID();
      // app_id: the caller-supplied per-App attribution (NULL for legacy —
      // Clarify #3: NULL = legacy). `?? null` because D1 .bind() rejects
      // undefined; the FK to github_apps(id) rejects an unknown appId loud.
      const appId = doc.appId ?? null;
      const reviewStmt = db
        .prepare(
          `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, skill_version, envelope, app_id, model, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (installation_id, owner, repo, pr_number, head_sha) DO NOTHING`,
        )
        .bind(
          reviewId,
          key.installation_id,
          key.owner,
          key.repo,
          key.pr_number,
          key.head_sha,
          payload.verdict,
          payload.summary_md,
          REVIEW_SKILL_VERSION,
          // The validated envelope object itself — full JSON, losslessly
          // restorable via get() (no 64KB truncation on this column).
          JSON.stringify(payload),
          appId,
          // Version records (plan 18 Task 1): the caller-supplied chain head
          // selector / provider — `?? null` because D1 .bind() rejects
          // undefined; omitted put-input fields persist NULL (byte-compat).
          doc.model ?? null,
          doc.provider ?? null,
        );
      // raw_output stays NULL on the v1 path: the envelope is authoritative
      // (its 64KB truncation is not losslessly restorable).

      // Findings are guarded by WHERE EXISTS on the review id: on a UNIQUE
      // no-op the review insert writes 0 rows, the new UUID does not exist,
      // and each findings statement writes 0 rows — the batch succeeds and
      // the idempotent put resolves below.
      const findingStmts = payload.findings.map((finding) =>
        db
          .prepare(
            `INSERT INTO findings (id, review_id, severity, category, file_path, line_start, line_end, title, body, fingerprint)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ?)`,
          )
          .bind(
            crypto.randomUUID(),
            reviewId,
            // THE vocab-switch mapping point (architect-locked): v1 rows
            // carry the harness merge class in the legacy `severity` column.
            finding.mergeClass,
            // D1 .bind() rejects undefined; optional finding fields
            // (envelope contract: category/location may be omitted) are
            // coalesced to NULL.
            finding.category ?? null,
            finding.file_path ?? null,
            finding.line_start ?? null,
            finding.line_end ?? null,
            finding.title,
            finding.body,
            // Plan 21 (AL-21-1): the persist path is the single fingerprint
            // write point — a non-blank hint is returned verbatim by the
            // pure function; otherwise the normalized FNV-1a fingerprint.
            computeFindingFingerprint(finding),
            reviewId,
          ),
      );

      const results = await db.batch([reviewStmt, ...findingStmts]);

      if (results[0]!.meta.changes === 0) {
        // UNIQUE conflict — another consumer already stored this sha.
        // Idempotent success: the first-written row wins and is never
        // overwritten (module-header deviation from FsStore semantics).
        return;
      }
    },

    async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
      if (ref.kind !== "review") {
        throw new Error(
          `artifact-store: kind ${JSON.stringify(ref.kind)} is not served by the D1 store (only "review")`,
        );
      }
      const key = parseIdemKey(ref.key);
      const row = await db
        .prepare(
          `SELECT envelope FROM reviews
           WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?`,
        )
        .bind(key.installation_id, key.owner, key.repo, key.pr_number, key.head_sha)
        .first<{ envelope: string | null }>();
      // Missing row → undefined; M1-era row (envelope NULL) → undefined:
      // M1 history is never served as a v1 envelope (era model, migration
      // 0002).
      if (row === null || row.envelope === null) return undefined;
      return JSON.parse(row.envelope) as T;
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
  };
}
/**
 * Previous-round fingerprint set for cross-round repeat dedup (plan 21
 * Task 3, AL-21-2): the latest v1 review row for the same
 * (installation_id, owner, repo, pr_number) — `envelope IS NOT NULL` era
 * gate, ORDER BY reviewed_at DESC, id DESC LIMIT 1 — then that row's
 * findings' non-NULL fingerprints. NO head_sha exclusion: the consumer
 * assembles BEFORE the current sha row exists (post → put order), so a
 * same-sha re-review reads its own previous row = all-repeat semantics
 * (documented in AL-21-2). Returns an empty set when no v1 review exists
 * (first round) or the latest row has no fingerprint-bearing findings.
 * Callers treat a throw as first-round semantics (never blocks the review).
 */
export async function previousRoundFingerprints(
  db: D1Like,
  key: { installation_id: number; owner: string; repo: string; pr_number: number },
): Promise<ReadonlySet<string>> {
  const review = await db
    .prepare(
      `SELECT id FROM reviews
       WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND envelope IS NOT NULL
       ORDER BY reviewed_at DESC, id DESC LIMIT 1`,
    )
    .bind(key.installation_id, key.owner, key.repo, key.pr_number)
    .first<{ id: string }>();
  if (review === null) return new Set();
  const rows = await db
    .prepare(`SELECT fingerprint FROM findings WHERE review_id = ? AND fingerprint IS NOT NULL`)
    .bind(review.id)
    .all<{ fingerprint: string }>();
  return new Set(rows.results.map((row) => row.fingerprint));
}
