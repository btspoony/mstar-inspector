/**
 * D1 store for `review_targets` — the workspace-owned review configuration.
 *
 * A bot (`review_bots`) is the execution identity: credentials, model chain,
 * sandbox image, installations, the operational pause. A target is ONE
 * repository under ONE workspace: its identity is GitHub's numeric
 * `repository.id` (D7), with `repo_owner` / `repo_name` as mutable display
 * caches a delivery refreshes. `repo_id IS NULL` is the historical state a
 * migrated row waits in (D15): only the webhook resolver and the 373 backfill
 * ever write an id onto an existing row, and every target created through a
 * runtime path binds one.
 *
 * Two read shapes, deliberately not interchangeable:
 *   - TENANT reads — `listLive`, `getInWorkspace` and the setters a route
 *     drives — carry `workspace_id` in their own SQL. An id from another
 *     workspace must read absent here.
 *   - `resolveByRepo` is the EXECUTION read a webhook delivery makes: it names
 *     a bot and the delivery's repository, never a workspace, so it carries no
 *     workspace predicate. `getForExecution` names just the target the
 *     delivery already resolved.
 *
 * Effective settings (D16) are computed, never copied while inheriting: a
 * following row reads the workspace's defaults at read time, and toggling
 * inheritance off snapshots them into the row once.
 *
 * The `db` parameter is a locally-declared narrow D1 face (types only, zero
 * imports), the convention `apps-store` follows: a real `D1Database`, the
 * bun:sqlite test double and the store layer's `D1Like` all satisfy it
 * structurally, and dashboard leaf modules import no store/pipeline code.
 */
import { PR_VERDICTS, type PrVerdict } from "@mstar-harness/engine";
import { isReviewLevel, REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";
import { DEFAULT_CHECK_MIN_SCORE, isCheckMinScoreValue } from "../contracts/review-gate";

/**
 * The per-target auto-trigger vocabulary (exact enum spelling is wire-visible:
 * the settings POST body carries it and the SPA replays it). Producer-side
 * enforced like `DELIVERY_OUTCOMES`: an off-vocabulary mode throws BEFORE any
 * row is written; the DDL CHECK is the last-line backstop.
 */
export type ReviewTriggerMode = "open" | "every_push" | "manual";

export const REVIEW_TRIGGER_MODES: readonly ReviewTriggerMode[] = Object.freeze([
  "open",
  "every_push",
  "manual",
]);

/**
 * The stored review level, or `null` when the row carries no usable choice: a
 * NULL column (follow the operator default) or a value outside the shared
 * `REVIEW_LEVELS` vocabulary. An off-vocabulary stored value is UNTRUSTED and
 * treated as absent — the review path falls back to the operator default and
 * never throws for a row it cannot read.
 */
export function parseTargetReviewLevel(value: unknown): ReviewLevel | null {
  return isReviewLevel(value) ? value : null;
}

/**
 * The review gate: a published review concludes the Check `success` only when
 * its verdict is on `passVerdicts` AND its tally score is at least `minScore`.
 * `passVerdicts` is engine `PR_VERDICTS` vocabulary — `setReviewConfig` refuses
 * anything else before writing.
 */
export type CheckGate = {
  /** Integer score floor, 0..100 inclusive (the DDL CHECK's domain). */
  minScore: number;
  /** Verdicts that satisfy the gate; `["ship it"]` until saved otherwise. */
  passVerdicts: readonly PrVerdict[];
};

/**
 * The stored verdict array, or `null` when the stored value is unreadable
 * (bad JSON, not an array, or off-vocabulary). `null` is unreadable
 * CONFIGURATION, never "the default": the effective-settings reader fails
 * closed on a row it cannot read instead of admitting verdicts nobody stored.
 */
function storedPassVerdicts(raw: string): readonly PrVerdict[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => PR_VERDICTS.includes(entry as PrVerdict))) {
      return parsed as PrVerdict[];
    }
  } catch {
    // unreadable — reported as null below
  }
  return null;
}

/**
 * One target row as the columns are stored (D1 snake_case). `deleted_at` is the
 * only removal path.
 */
export type ReviewTargetRow = {
  id: string;
  workspace_id: string;
  bot_id: string;
  /** Legacy display column; a created target carries the repository name. */
  name: string;
  /** GitHub `repository.id` — the identity. NULL only on a migrated row awaiting a claim. */
  repo_id: number | null;
  /** Mutable display caches, refreshed by a delivery that sees a new spelling. */
  repo_owner: string | null;
  repo_name: string | null;
  /** 1 = the workspace defaults answer every setting; 0 = this row's own columns. */
  follow_workspace_defaults: number;
  /** Business pause: 1 = the workspace lets this target review, 0 = paused. */
  review_enabled: number;
  review_trigger_mode: ReviewTriggerMode;
  review_level: string | null;
  check_min_score: number;
  check_pass_verdicts: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/**
 * The workspace-level answers a following target inherits (`workspaces`
 * columns): the floor is the existing `check_min_score` (0049), the other three
 * are the `default_*` columns of 0067.
 */
export type WorkspaceReviewDefaults = {
  triggerMode: ReviewTriggerMode;
  level: ReviewLevel | null;
  checkMinScore: number;
  checkPassVerdicts: string[];
};

/** What a target runs with, whichever side of the inheritance switch answers. */
export type EffectiveTargetSettings = {
  triggerMode: ReviewTriggerMode;
  level: ReviewLevel | null;
  checkMinScore: number;
  checkPassVerdicts: string[];
};

/**
 * The gate a stored row carries, or `null` when its verdict array is
 * unreadable. The execution lanes read the gate straight off a resolved row,
 * so this is the ONE parser both the tenant read and they use.
 */
export function targetCheckGate(row: {
  check_min_score: number;
  check_pass_verdicts: string;
}): CheckGate | null {
  const passVerdicts = storedPassVerdicts(row.check_pass_verdicts);
  if (passVerdicts === null) return null;
  return { minScore: row.check_min_score, passVerdicts };
}

/** Narrow D1 face, declared locally so this leaf module imports nothing. */
type TargetsStoreStatement = {
  bind(...values: unknown[]): TargetsStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
};

type TargetsStoreD1 = {
  prepare(query: string): TargetsStoreStatement;
};

/** Input for `create` — the caller owns the workspace, bot and repository facts. */
export type CreateTargetInput = {
  workspaceId: string;
  botId: string;
  /** GitHub numeric `repository.id`: the identity every runtime path binds. */
  repoId: number;
  repoOwner: string;
  repoName: string;
  createdBy: string;
};

/**
 * `create`'s outcome. A refusal is a VALUE, like every other store refusal
 * here, so the add-repository route maps it onto its `duplicates` list.
 */
export type CreateTargetOutcome =
  | { outcome: "created"; target: ReviewTargetRow }
  | { outcome: "duplicate" };

/**
 * `setReviewConfig`'s input: the columns to write. An absent key is left
 * untouched, so a route that changes one control writes one column.
 * `level: null` is a real value — "follow the operator default".
 */
export type TargetReviewConfig = {
  triggerMode?: ReviewTriggerMode;
  level?: ReviewLevel | null;
  checkMinScore?: number;
  checkPassVerdicts?: readonly PrVerdict[];
};

/**
 * The live-target predicate every tenant read/write carries. `id = ?` alone
 * would let a route check (or a bug in one) reach another workspace's row;
 * `deleted_at IS NULL` keeps a soft-deleted target out of every face.
 */
const LIVE_TARGET = "id = ? AND workspace_id = ? AND deleted_at IS NULL";

/**
 * The duplicate rule, shared by every create: a live row in this workspace
 * holding the same `repo_id`, OR the same owner/name while still unclaimed —
 * a migrated row IS the same repository (D15). This one predicate backs both
 * the add-repository refusal and the webhook claim's re-entry.
 */
const DUPLICATE_REPO = `t.workspace_id = ?2 AND t.deleted_at IS NULL
   AND (t.repo_id = ?4
        OR (t.repo_id IS NULL AND t.repo_owner = ?5 AND t.repo_name = ?6))`;

/**
 * The guarded insert behind `create`: ONE statement decides and writes, so a
 * concurrent add of the same repository writes nothing instead of racing the
 * read-then-insert. `follow_workspace_defaults = 1` is the UI-create rule (J4):
 * a new repository inherits the workspace's answers, and the row's own policy
 * columns keep the DDL defaults as inert placeholders.
 */
const CREATE_TARGET_SQL = `
  INSERT INTO review_targets
    (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
     follow_workspace_defaults, created_by, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?6, ?4, ?5, ?6, 1, ?7, datetime('now'), datetime('now')
   WHERE NOT EXISTS (SELECT 1 FROM review_targets t WHERE ${DUPLICATE_REPO})`;

/**
 * The workspace's review defaults, read once per decision (`effectiveTargetSettings`
 * callers batch them — a delivery reads one row). A missing or retired
 * workspace reads the column defaults, and an untrusted stored value degrades
 * to the conservative answer instead of throwing on a webhook path.
 */
export async function getWorkspaceReviewDefaults(
  db: TargetsStoreD1,
  workspaceId: string,
): Promise<WorkspaceReviewDefaults> {
  const row = await db
    .prepare(
      `SELECT check_min_score, default_review_trigger_mode, default_review_level,
              default_check_pass_verdicts
         FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(workspaceId)
    .first<{
      check_min_score: number | null;
      default_review_trigger_mode: string;
      default_review_level: string | null;
      default_check_pass_verdicts: string;
    }>();
  if (row === null) {
    return {
      triggerMode: "every_push",
      level: null,
      checkMinScore: DEFAULT_CHECK_MIN_SCORE,
      checkPassVerdicts: ["ship it"],
    };
  }
  return {
    triggerMode: (REVIEW_TRIGGER_MODES as readonly string[]).includes(row.default_review_trigger_mode)
      ? (row.default_review_trigger_mode as ReviewTriggerMode)
      : "every_push",
    level: parseTargetReviewLevel(row.default_review_level),
    checkMinScore: isCheckMinScoreValue(row.check_min_score)
      ? row.check_min_score
      : DEFAULT_CHECK_MIN_SCORE,
    // Unreadable stored verdicts admit nothing: an empty set fails closed,
    // where a permissive fallback would let a review through nobody configured.
    checkPassVerdicts: [...(storedPassVerdicts(row.default_check_pass_verdicts) ?? [])],
  };
}

/**
 * What the target runs with (D16). `follow_workspace_defaults = 1` answers the
 * workspace defaults — computed here, every read, never copied into the row
 * while inheriting. `= 0` answers the row's own four columns; an unreadable
 * stored verdict array fails closed (empty), like the workspace side.
 */
export function effectiveTargetSettings(
  target: ReviewTargetRow,
  defaults: WorkspaceReviewDefaults,
): EffectiveTargetSettings {
  if (target.follow_workspace_defaults === 1) {
    return {
      triggerMode: defaults.triggerMode,
      level: defaults.level,
      checkMinScore: defaults.checkMinScore,
      checkPassVerdicts: [...defaults.checkPassVerdicts],
    };
  }
  return {
    triggerMode: target.review_trigger_mode,
    level: parseTargetReviewLevel(target.review_level),
    checkMinScore: isCheckMinScoreValue(target.check_min_score)
      ? target.check_min_score
      : DEFAULT_CHECK_MIN_SCORE,
    checkPassVerdicts: [...(storedPassVerdicts(target.check_pass_verdicts) ?? [])],
  };
}

/**
 * Flip the inheritance switch (D16). `1` sets the flag only: the row's own
 * policy columns become inert, never read again. `0` snapshots the values the
 * target is running with right now into the row — reading the defaults when it
 * was inheriting, its own columns otherwise — so the toggle itself changes no
 * live behaviour. A later toggle-off re-snapshots from the then-current
 * defaults. An unknown or deleted target writes nothing.
 */
export async function setInheritance(
  db: TargetsStoreD1,
  targetId: string,
  follow: 0 | 1,
): Promise<void> {
  if (follow === 1) {
    await db
      .prepare(
        `UPDATE review_targets SET follow_workspace_defaults = 1, updated_at = datetime('now')
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(targetId)
      .run();
    return;
  }
  const target = await db
    .prepare(`SELECT * FROM review_targets WHERE id = ? AND deleted_at IS NULL`)
    .bind(targetId)
    .first<ReviewTargetRow>();
  if (!target) return;
  const effective = effectiveTargetSettings(
    target,
    await getWorkspaceReviewDefaults(db, target.workspace_id),
  );
  await db
    .prepare(
      `UPDATE review_targets
          SET follow_workspace_defaults = 0, review_trigger_mode = ?, review_level = ?,
              check_min_score = ?, check_pass_verdicts = ?, updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(
      effective.triggerMode,
      effective.level,
      effective.checkMinScore,
      JSON.stringify(effective.checkPassVerdicts),
      targetId,
    )
    .run();
}

/** Create the `review_targets` store over one D1 handle. */
export function createTargetsStore(db: TargetsStoreD1) {
  return {
    /**
     * Insert one repository target for a bot and read it back. The duplicate
     * rule refuses a live row of the same repository (an already-added one, or
     * a migrated row still unclaimed) with nothing written.
     */
    async create(input: CreateTargetInput): Promise<CreateTargetOutcome> {
      const repoOwner = input.repoOwner.trim();
      const repoName = input.repoName.trim();
      // Identity at the trust boundary: a target that cannot be resolved by
      // `repo_id` or by the owner/name fallback would be unreachable.
      if (!Number.isInteger(input.repoId) || input.repoId <= 0) {
        throw new Error(
          `targets-store: create needs a positive integer repo id (got ${JSON.stringify(input.repoId)}) — zero rows written`,
        );
      }
      if (repoOwner === "" || repoName === "") {
        throw new Error("targets-store: create needs a repository owner and name — zero rows written");
      }
      const id = crypto.randomUUID();
      const res = await db
        .prepare(CREATE_TARGET_SQL)
        .bind(id, input.workspaceId, input.botId, input.repoId, repoOwner, repoName, input.createdBy)
        .run();
      if (res.meta.changes === 0) return { outcome: "duplicate" };
      const row = await db
        .prepare(`SELECT * FROM review_targets WHERE id = ? AND deleted_at IS NULL`)
        .bind(id)
        .first<ReviewTargetRow>();
      if (!row) throw new Error("targets-store: create target row vanished on read-back");
      return { outcome: "created", target: row };
    },

    /** One live target of this workspace; another workspace's id reads null. */
    async getInWorkspace(workspaceId: string, targetId: string): Promise<ReviewTargetRow | null> {
      return db
        .prepare(`SELECT * FROM review_targets WHERE ${LIVE_TARGET}`)
        .bind(targetId, workspaceId)
        .first<ReviewTargetRow>();
    },

    /** The workspace's live targets, newest first (stable id tiebreak). */
    async listLive(workspaceId: string): Promise<ReviewTargetRow[]> {
      const res = await db
        .prepare(
          `SELECT * FROM review_targets
           WHERE workspace_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC, id`,
        )
        .bind(workspaceId)
        .all<ReviewTargetRow>();
      return res.results;
    },

    /**
     * The target a delivery acts on, by the contract's two steps:
     *
     *   1. `repo.id` known → the live row holding it for this bot; a changed
     *      owner/name refreshes the caches (a rename must not orphan a row).
     *   2. Otherwise (no id, or no row carries it yet) → the live row matching
     *      owner/name that is still unclaimed; a hit CLAIMS `repo_id` and the
     *      names inside this request. A migrated row therefore starts
     *      reviewing on its first delivery (D15).
     *
     * No hit → null and the delivery is ignored with 200. The claim refuses to
     * take an id another live row of the same workspace already holds: one
     * repository belongs to one workspace, and silently reviewing twice would
     * be worse than ignoring the delivery.
     */
    async resolveByRepo(
      botId: string,
      repo: { id: number | null; owner: string; name: string },
    ): Promise<ReviewTargetRow | null> {
      if (repo.id !== null) {
        // The workspace/repository unique index makes this at most one row.
        const hit = await db
          .prepare(
            `SELECT * FROM review_targets
             WHERE bot_id = ? AND repo_id = ? AND deleted_at IS NULL`,
          )
          .bind(botId, repo.id)
          .first<ReviewTargetRow>();
        if (hit) {
          if (hit.repo_owner === repo.owner && hit.repo_name === repo.name) return hit;
          await db
            .prepare(
              `UPDATE review_targets SET repo_owner = ?, repo_name = ?, updated_at = datetime('now')
               WHERE id = ? AND deleted_at IS NULL`,
            )
            .bind(repo.owner, repo.name, hit.id)
            .run();
          return { ...hit, repo_owner: repo.owner, repo_name: repo.name };
        }
      }
      const unclaimed = await db
        .prepare(
          `SELECT * FROM review_targets
            WHERE bot_id = ? AND repo_owner = ? AND repo_name = ?
              AND repo_id IS NULL AND deleted_at IS NULL
            LIMIT 2`,
        )
        .bind(botId, repo.owner, repo.name)
        .all<ReviewTargetRow>();
      if (unclaimed.results.length > 1) return null;
      const legacy = unclaimed.results[0];
      if (!legacy) return null;
      // A payload without an id has nothing to claim; the row still reviews.
      if (repo.id === null) return legacy;
      const claimed = await db
        .prepare(
          `UPDATE review_targets
              SET repo_id = ?, repo_owner = ?, repo_name = ?, updated_at = datetime('now')
            WHERE id = ? AND repo_id IS NULL AND deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM review_targets x
                               WHERE x.workspace_id = review_targets.workspace_id
                                 AND x.repo_id = ? AND x.deleted_at IS NULL)`,
        )
        .bind(repo.id, repo.owner, repo.name, legacy.id, repo.id)
        .run();
      if (claimed.meta.changes === 0) return null;
      return db
        .prepare(`SELECT * FROM review_targets WHERE id = ? AND deleted_at IS NULL`)
        .bind(legacy.id)
        .first<ReviewTargetRow>();
    },

    /**
     * One target by id — the EXECUTION read a queue message makes. The job
     * already names the target the webhook resolved, so there is nothing to
     * re-decide and no workspace to bind: the queue is not a tenant face. A
     * soft-deleted row reads absent, exactly like every other face.
     */
    async getForExecution(targetId: string): Promise<ReviewTargetRow | null> {
      return db
        .prepare(`SELECT * FROM review_targets WHERE id = ? AND deleted_at IS NULL`)
        .bind(targetId)
        .first<ReviewTargetRow>();
    },

    /**
     * The business pause: 1 = the workspace's reviews run, 0 = paused.
     * Writes review_enabled + updated_at (an operator mutation) and refuses a
     * soft-deleted or foreign target. Returns whether a row changed.
     */
    async setReviewEnabled(
      workspaceId: string,
      targetId: string,
      enabled: boolean,
    ): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE review_targets SET review_enabled = ?, updated_at = datetime('now')
           WHERE ${LIVE_TARGET}`,
        )
        .bind(enabled ? 1 : 0, targetId, workspaceId)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Write the review configuration columns a caller names. Every value is
     * validated BEFORE any write — an off-vocabulary mode/level or an
     * out-of-domain score/verdict throws and leaves the row untouched (the
     * settings route answers 400 first; the DDL CHECK is the last line).
     * Returns whether a row changed (false also covers an unknown or deleted
     * target, and an input naming no column).
     */
    async setReviewConfig(targetId: string, config: TargetReviewConfig): Promise<boolean> {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (config.triggerMode !== undefined) {
        if (!REVIEW_TRIGGER_MODES.includes(config.triggerMode)) {
          throw new Error(
            `targets-store: review trigger mode ${JSON.stringify(config.triggerMode)} is not on the vocabulary (${REVIEW_TRIGGER_MODES.join(" | ")}) — zero rows written`,
          );
        }
        assignments.push("review_trigger_mode = ?");
        values.push(config.triggerMode);
      }
      if (config.level !== undefined) {
        if (config.level !== null && !isReviewLevel(config.level)) {
          throw new Error(
            `targets-store: review level ${JSON.stringify(config.level)} is not on the vocabulary (${REVIEW_LEVELS.join(" | ")}) — zero rows written`,
          );
        }
        assignments.push("review_level = ?");
        values.push(config.level);
      }
      if (config.checkMinScore !== undefined) {
        if (!isCheckMinScoreValue(config.checkMinScore)) {
          throw new Error(
            `targets-store: check gate min score ${JSON.stringify(config.checkMinScore)} is outside 0..100 — zero rows written`,
          );
        }
        assignments.push("check_min_score = ?");
        values.push(config.checkMinScore);
      }
      if (config.checkPassVerdicts !== undefined) {
        for (const verdict of config.checkPassVerdicts) {
          if (!PR_VERDICTS.includes(verdict)) {
            throw new Error(
              `targets-store: check gate verdict ${JSON.stringify(verdict)} is not on PR_VERDICTS (${PR_VERDICTS.join(" | ")}) — zero rows written`,
            );
          }
        }
        assignments.push("check_pass_verdicts = ?");
        values.push(JSON.stringify(config.checkPassVerdicts));
      }
      if (assignments.length === 0) return false;
      const res = await db
        .prepare(
          `UPDATE review_targets SET ${assignments.join(", ")}, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(...values, targetId)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Soft delete (the only removal path): stamps deleted_at once — a second
     * call is a no-op returning false and the first timestamp wins. Refuses a
     * foreign target (zero rows). Returns whether THIS call performed the
     * delete.
     */
    async delete(workspaceId: string, targetId: string): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE review_targets SET deleted_at = datetime('now'), updated_at = datetime('now')
           WHERE ${LIVE_TARGET}`,
        )
        .bind(targetId, workspaceId)
        .run();
      return res.meta.changes > 0;
    },
  };
}
