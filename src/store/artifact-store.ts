
import {
  validateMstarReviewV1,
  type ArtifactDoc,
  type ArtifactRef,
  type ArtifactStore,
  type MstarReviewV1,
} from "@mstar-harness/engine";
import type { IdempotencyKey } from "../contracts/idem";
import { OMP_SANDBOX_IMAGE_PINS } from "../contracts/sandbox-images";
import type { D1Like, ReviewRow } from "./types";
import { computeFindingFingerprint } from "./fingerprint";

/** Schema id accepted by `put` / carried by every persisted review doc. */
export const REVIEW_SCHEMA = "mstar.review/v1" as const;

/**
 * `reviews.skill_version` for every v1 row (write caliber, spec § 新行写入
 * 口径): the pinned engine version + harness image commit, derived from the
 * omp image's declared pins (`OMP_SANDBOX_IMAGE_PINS`) so the attribution
 * anchor cannot drift from the build pin.
 */
export const REVIEW_SKILL_VERSION =
  `${OMP_SANDBOX_IMAGE_PINS.harnessVersion}+${OMP_SANDBOX_IMAGE_PINS.harnessRef.slice(0, 8)}`;

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
 * per-App attribution (QC fix wave 1 F-001; REQUIRED) and the version
 * records (`model` / `provider`). A
 * structural superset of the engine contract — the engine package is
 * unchanged; the consumer is the only production caller and always passes
 * `appId` (the new contract's single shape).
 */
export type ReviewArtifactDoc = ArtifactDoc & {
  appId: string;
  targetId: string;
  model?: string | null;
  provider?: string | null;
  contextIncomplete?: boolean;
  durationMs?: number;
  round?: number | null;
};

/**
 * A SQL expression a NEW row's `target_id` is written with, instead of a
 * value. The caller owns the text and its binds; the store only splices it
 * into the INSERT it already builds. The lifecycle apply uses it so a review
 * row carries the live installation binding — evaluated by the inserting
 * statement, exactly like the findings insert of the same apply — instead of a
 * target resolved before the write (no pre-batch read, no later rewrite).
 */
export type TargetIdExpression = {
  sql: string;
  binds: readonly unknown[];
};

/** One statement `put` would run, composed but not executed. */
export type ComposedStatement = {
  sql: string;
  binds: unknown[];
};

/** `put` inputs that are not part of the artifact document itself. */
export type ArtifactPutOptions = {
  targetIdExpression?: TargetIdExpression;
  guard?: { sql: string; binds: unknown[] };
};

/** The D1 store face: the engine `ArtifactStore` plus the consumer's pre-check. */
export type D1ArtifactStore = ArtifactStore & {
  put(doc: ReviewArtifactDoc, options?: ArtifactPutOptions): Promise<void>;
  statementsFor(doc: ReviewArtifactDoc, options?: ArtifactPutOptions): ComposedStatement[];
  findByIdempotencyKey(key: IdempotencyKey): Promise<ReviewRow | null>;
};

/**
 * why: Create the D1-backed ArtifactStore for `kind: "review"`. Absorbs the
 * retired review-store's (src/store/reviews.ts, deleted this task)
 * batch atomicity and UNIQUE duplicate handling:
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
  function composeStatements(
    doc: ReviewArtifactDoc,
    options?: ArtifactPutOptions,
  ): ComposedStatement[] {
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

    const gate = validateMstarReviewV1(doc.payload);
    if (!gate.ok) {
      const detail = gate.violations.map((v) => `${v.code}: ${v.message}`).join("; ");
      throw new Error(
        `artifact-store: payload failed validateMstarReviewV1 (${detail}) — zero rows written`,
      );
    }
    const payload = doc.payload as MstarReviewV1;
    assertTargetAgrees(key, payload);

    const reviewId = doc.key;
    const appId = doc.appId;
    const targetIdSql = options?.targetIdExpression?.sql ?? "?";
    const targetIdBinds: readonly unknown[] =
      options?.targetIdExpression === undefined ? [doc.targetId] : options.targetIdExpression.binds;
    const reviewColumns = `(id, installation_id, owner, repo, pr_number, head_sha, verdict, summary_md, skill_version, envelope, bot_id, target_id, model, provider, context_incomplete, duration_ms, round)`;
    const reviewValues = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${targetIdSql}, ?, ?, ?, ?, ?`;
    const reviewStmt: ComposedStatement = {
      sql:
        options?.guard === undefined
          ? `INSERT INTO reviews ${reviewColumns}
           VALUES (${reviewValues})
           ON CONFLICT (installation_id, owner, repo, pr_number, head_sha) DO NOTHING`
          : `INSERT INTO reviews ${reviewColumns}
           SELECT ${reviewValues} WHERE ${options.guard.sql}
           ON CONFLICT (installation_id, owner, repo, pr_number, head_sha) DO NOTHING`,
      binds: [
        reviewId,
        key.installation_id,
        key.owner,
        key.repo,
        key.pr_number,
        key.head_sha,
        payload.verdict,
        payload.summary_md ?? null,
        REVIEW_SKILL_VERSION,
        JSON.stringify(payload),
        appId,
        ...targetIdBinds,
        doc.model ?? null,
        doc.provider ?? null,
        doc.contextIncomplete === true ? 1 : 0,
        doc.durationMs ?? null,
        doc.round ?? null,
        ...(options?.guard?.binds ?? []),
      ],
    };

    const findingStmts: ComposedStatement[] = payload.findings.map((finding, index) => ({
      sql: `INSERT INTO findings (id, review_id, severity, category, file_path, line_start, line_end, title, body, fingerprint)
             SELECT ?, COALESCE((SELECT id FROM reviews
                                  WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?), ?),
                    ?, ?, ?, ?, ?, ?, ?, ?
                ${options?.guard === undefined ? "WHERE 1" : `WHERE ${options.guard.sql}`}
             ON CONFLICT (id) DO NOTHING`,
      binds: [
          `${doc.key}#${index}`,
          key.installation_id,
          key.owner,
          key.repo,
          key.pr_number,
          key.head_sha,
          reviewId,
          finding.mergeClass,
          finding.category ?? null,
          finding.file_path ?? null,
          finding.line_start ?? null,
          finding.line_end ?? null,
          finding.title,
          finding.body,
          computeFindingFingerprint(finding),
          ...(options?.guard?.binds ?? []),
      ],
    }));

    return [reviewStmt, ...findingStmts];
  }

  return {
    async put(doc: ReviewArtifactDoc, options?: ArtifactPutOptions): Promise<void> {
      const statements = composeStatements(doc, options);
      const results = await db.batch(
        statements.map((statement) => db.prepare(statement.sql).bind(...statement.binds)),
      );

      if (results[0]!.meta.changes === 0) {
        return;
      }
    },

    statementsFor(doc: ReviewArtifactDoc, options?: ArtifactPutOptions): ComposedStatement[] {
      return composeStatements(doc, options);
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
