import { PR_VERDICTS, type PrVerdict } from "@mstar-harness/engine";
import { isReviewLevel, REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";
import {
  CHECK_MIN_SCORE_MAX,
  CHECK_MIN_SCORE_MIN,
  DEFAULT_CHECK_MIN_SCORE,
  isCheckMinScoreValue,
} from "../contracts/review-gate";
import { UnknownWorkspaceError } from "./runtime-config-store";

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
  minScore: number;
  passVerdicts: readonly PrVerdict[];
};

function storedPassVerdicts(raw: string): readonly PrVerdict[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => PR_VERDICTS.includes(entry as PrVerdict))) {
      return parsed as PrVerdict[];
    }
  } catch {
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
  name: string;
  repo_id: number | null;
  repo_owner: string | null;
  repo_name: string | null;
  follow_workspace_defaults: number;
  review_enabled: number;
  review_drafts: number;
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
 * A row of the repository list (product spec J1): the target's own columns plus
 * the bot's display name and the newest review stamp. `last_reviewed_at` is
 * `null` for a repository no review has finished on yet.
 */
export type LiveTargetListRow = ReviewTargetRow & {
  app_name: string;
  last_reviewed_at: string | null;
  reviews_total: number;
  reviews_7d: number;
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
  checkPassVerdicts: readonly PrVerdict[];
  checkPassVerdictsReadable: boolean;
};

/** What a target runs with, whichever side of the inheritance switch answers. */
export type EffectiveTargetSettings = {
  triggerMode: ReviewTriggerMode;
  level: ReviewLevel | null;
  checkMinScore: number;
  checkPassVerdicts: readonly PrVerdict[];
  checkPassVerdictsReadable: boolean;
};

/**
 * A TARGET's settings: the inheritable policy answers plus the target-owned
 * facts. `reviewDrafts` is answered from the row in BOTH inheritance branches
 * (D12) — the workspace defaults carry no such answer, so this stays off
 * `WorkspaceReviewDefaults` and off the workspace-defaults payload.
 */
export type EffectiveReviewTargetSettings = EffectiveTargetSettings & {
  reviewDrafts: boolean;
};

/**
 * The Check gate these settings authorise, or `null` when the verdict array
 * that answered them is unreadable. The execution lanes and the settings face
 * read the gate through this ONE derivation, so neither can invent a gate the
 * stored configuration does not state.
 */
export function checkGateOf(settings: EffectiveTargetSettings): CheckGate | null {
  return settings.checkPassVerdictsReadable
    ? { minScore: settings.checkMinScore, passVerdicts: settings.checkPassVerdicts }
    : null;
}

type TargetsStoreStatement = {
  bind(...values: unknown[]): TargetsStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
};

type TargetsStoreD1 = {
  prepare(query: string): TargetsStoreStatement;
};

type TargetsStoreBatchD1 = TargetsStoreD1 & {
  batch(statements: TargetsStoreStatement[]): Promise<Array<{ meta: { changes: number } }>>;
};

/** Input for `create` — the caller owns the workspace, bot and repository facts. */
export type CreateTargetInput = {
  workspaceId: string;
  botId: string;
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
  reviewDrafts?: boolean;
  follow?: 0 | 1;
};

const LIVE_TARGET = "id = ? AND workspace_id = ? AND deleted_at IS NULL";

const DUPLICATE_REPO = `t.bot_id = ?3 AND t.deleted_at IS NULL
   AND (t.repo_id = ?4
        OR (t.repo_id IS NULL AND t.repo_owner = ?5 COLLATE NOCASE
            AND t.repo_name = ?6 COLLATE NOCASE))`;

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
      checkPassVerdictsReadable: true,
    };
  }
  const verdicts = storedPassVerdicts(row.default_check_pass_verdicts);
  return {
    triggerMode: (REVIEW_TRIGGER_MODES as readonly string[]).includes(row.default_review_trigger_mode)
      ? (row.default_review_trigger_mode as ReviewTriggerMode)
      : "every_push",
    level: parseTargetReviewLevel(row.default_review_level),
    checkMinScore: isCheckMinScoreValue(row.check_min_score)
      ? row.check_min_score
      : DEFAULT_CHECK_MIN_SCORE,
    checkPassVerdicts: [...(verdicts ?? [])],
    checkPassVerdictsReadable: verdicts !== null,
  };
}

/**
 * `setWorkspaceReviewDefaults`'s input: the `workspaces` columns a caller
 * names — the three `default_*` review answers plus the gate floor
 * (`check_min_score`, 0049). An absent key is left untouched, like
 * `setReviewConfig`; `level: null` is a real value.
 */
export type WorkspaceReviewDefaultPatch = {
  triggerMode?: ReviewTriggerMode;
  level?: ReviewLevel | null;
  checkPassVerdicts?: readonly PrVerdict[];
  checkMinScore?: number;
};

const CHECK_MIN_SCORE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'workspace.check_min_score.set', 'workspace', ?3,
         json_object('before', (SELECT CASE
                                        WHEN typeof(check_min_score) = 'integer'
                                         AND check_min_score BETWEEN ${CHECK_MIN_SCORE_MIN} AND ${CHECK_MIN_SCORE_MAX}
                                        THEN check_min_score
                                        ELSE NULL END
                                  FROM workspaces WHERE id = ?3),
                     'after', ?4),
         ?5
   WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?3 AND deleted_at IS NULL)`;

/**
 * THE writer of the workspace's review defaults (`/api/targets/defaults`) and
 * of its gate floor — the floor is `workspaces.check_min_score`, and the
 * legacy `PUT /api/settings/check-min-score` delegates here, so exactly one
 * statement stores it.
 *
 * Every value is validated before the first write, so an off-vocabulary value
 * leaves every column untouched. A named floor rides a `batch`: its audit row
 * reads the OLD value, so it must run before the UPDATE, in one transaction.
 * Throws `UnknownWorkspaceError` when named columns matched no live row;
 * `false` means the caller named nothing.
 */
export async function setWorkspaceReviewDefaults(
  db: TargetsStoreBatchD1,
  workspaceId: string,
  patch: WorkspaceReviewDefaultPatch,
  actor: string,
): Promise<boolean> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (patch.triggerMode !== undefined) {
    if (!REVIEW_TRIGGER_MODES.includes(patch.triggerMode)) {
      throw new Error(
        `targets-store: default review trigger mode ${JSON.stringify(patch.triggerMode)} is not on the vocabulary (${REVIEW_TRIGGER_MODES.join(" | ")}) — zero rows written`,
      );
    }
    assignments.push("default_review_trigger_mode = ?");
    values.push(patch.triggerMode);
  }
  if (patch.level !== undefined) {
    if (patch.level !== null && !isReviewLevel(patch.level)) {
      throw new Error(
        `targets-store: default review level ${JSON.stringify(patch.level)} is not on the vocabulary (${REVIEW_LEVELS.join(" | ")}) — zero rows written`,
      );
    }
    assignments.push("default_review_level = ?");
    values.push(patch.level);
  }
  if (patch.checkPassVerdicts !== undefined) {
    for (const verdict of patch.checkPassVerdicts) {
      if (!PR_VERDICTS.includes(verdict)) {
        throw new Error(
          `targets-store: default check gate verdict ${JSON.stringify(verdict)} is not on PR_VERDICTS (${PR_VERDICTS.join(" | ")}) — zero rows written`,
        );
      }
    }
    assignments.push("default_check_pass_verdicts = ?");
    values.push(JSON.stringify(patch.checkPassVerdicts));
  }
  if (patch.checkMinScore !== undefined) {
    if (!isCheckMinScoreValue(patch.checkMinScore)) {
      throw new Error(
        `targets-store: workspace check gate min score ${JSON.stringify(patch.checkMinScore)} is outside 0..100 — zero rows written`,
      );
    }
    assignments.push("check_min_score = ?");
    values.push(patch.checkMinScore);
  }
  if (assignments.length === 0) return false;
  const update = db.prepare(
    `UPDATE workspaces SET ${assignments.join(", ")}
      WHERE id = ? AND deleted_at IS NULL`,
  );
  const changes =
    patch.checkMinScore === undefined
      ? (await update.bind(...values, workspaceId).run()).meta.changes
      : (
          await db.batch([
            db
              .prepare(CHECK_MIN_SCORE_AUDIT_SQL)
              .bind(
                crypto.randomUUID(),
                actor,
                workspaceId,
                patch.checkMinScore,
                new Date().toISOString(),
              ),
            update.bind(...values, workspaceId),
          ])
        )[1]?.meta.changes ?? 0;
  if (changes === 0) throw new UnknownWorkspaceError(workspaceId);
  return true;
}

function ownTargetSettings(target: ReviewTargetRow): EffectiveReviewTargetSettings {
  const verdicts = storedPassVerdicts(target.check_pass_verdicts);
  return {
    triggerMode: target.review_trigger_mode,
    level: parseTargetReviewLevel(target.review_level),
    checkMinScore: isCheckMinScoreValue(target.check_min_score)
      ? target.check_min_score
      : DEFAULT_CHECK_MIN_SCORE,
    checkPassVerdicts: [...(verdicts ?? [])],
    checkPassVerdictsReadable: verdicts !== null,
    reviewDrafts: target.review_drafts !== 0,
  };
}

/**
 * What the target runs with (D16). `follow_workspace_defaults = 1` answers the
 * workspace defaults — computed here, every read, never copied into the row
 * while inheriting. `= 0` answers the row's own four columns.
 *
 * `reviewDrafts` is answered from the ROW in both branches: it is a
 * target-owned admission fact like the pause, and the workspace defaults carry
 * no such answer (D12).
 */
export function effectiveTargetSettings(
  target: ReviewTargetRow,
  defaults: WorkspaceReviewDefaults,
): EffectiveReviewTargetSettings {
  if (target.follow_workspace_defaults !== 1) return ownTargetSettings(target);
  return {
    triggerMode: defaults.triggerMode,
    level: defaults.level,
    checkMinScore: defaults.checkMinScore,
    checkPassVerdicts: [...defaults.checkPassVerdicts],
    checkPassVerdictsReadable: defaults.checkPassVerdictsReadable,
    reviewDrafts: target.review_drafts !== 0,
  };
}

/**
 * THE effective-settings read every lane uses (webhook trigger, review
 * execution, Check gate, settings face): the workspace defaults are read only
 * for a target that actually inherits, so an own-columns target pays no second
 * D1 round trip for a value its row already answers.
 */
export async function readEffectiveTargetSettings(
  db: TargetsStoreD1,
  target: ReviewTargetRow,
): Promise<EffectiveReviewTargetSettings> {
  return target.follow_workspace_defaults === 1
    ? effectiveTargetSettings(target, await getWorkspaceReviewDefaults(db, target.workspace_id))
    : ownTargetSettings(target);
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
  workspaceId: string,
  targetId: string,
  follow: 0 | 1,
): Promise<void> {
  if (follow === 1) {
    await db
      .prepare(
        `UPDATE review_targets SET follow_workspace_defaults = 1, updated_at = datetime('now')
         WHERE ${LIVE_TARGET}`,
      )
      .bind(targetId, workspaceId)
      .run();
    return;
  }
  const target = await db
    .prepare(`SELECT * FROM review_targets WHERE ${LIVE_TARGET}`)
    .bind(targetId, workspaceId)
    .first<ReviewTargetRow>();
  if (!target) return;
  const effective = effectiveTargetSettings(target, await getWorkspaceReviewDefaults(db, workspaceId));
  await db
    .prepare(
      `UPDATE review_targets
          SET follow_workspace_defaults = 0, review_trigger_mode = ?, review_level = ?,
              check_min_score = ?, check_pass_verdicts = ?, updated_at = datetime('now')
        WHERE ${LIVE_TARGET}`,
    )
    .bind(
      effective.triggerMode,
      effective.level,
      effective.checkMinScore,
      JSON.stringify(effective.checkPassVerdicts),
      targetId,
      workspaceId,
    )
    .run();
}

/** Create the `review_targets` store over one D1 handle. */
export function createTargetsStore(db: TargetsStoreD1) {
  return {
    async create(input: CreateTargetInput): Promise<CreateTargetOutcome> {
      const repoOwner = input.repoOwner.trim();
      const repoName = input.repoName.trim();
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

    async getInWorkspace(workspaceId: string, targetId: string): Promise<ReviewTargetRow | null> {
      return db
        .prepare(`SELECT * FROM review_targets WHERE ${LIVE_TARGET}`)
        .bind(targetId, workspaceId)
        .first<ReviewTargetRow>();
    },

    async countLive(workspaceId: string): Promise<number> {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_targets
            WHERE workspace_id = ? AND deleted_at IS NULL`,
        )
        .bind(workspaceId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

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

    async listLiveWithApp(workspaceId: string): Promise<LiveTargetListRow[]> {
      const res = await db
        .prepare(
          `SELECT t.*,
                  COALESCE(b.github_name, b.github_slug, CAST(b.github_app_id AS TEXT)) AS app_name,
                  (SELECT MAX(r.reviewed_at) FROM reviews r WHERE r.target_id = t.id) AS last_reviewed_at,
                  (SELECT COUNT(*) FROM reviews r WHERE r.target_id = t.id) AS reviews_total,
                  (SELECT COUNT(*) FROM reviews r
                    WHERE r.target_id = t.id
                      AND r.reviewed_at >= datetime('now', '-7 days')) AS reviews_7d
             FROM review_targets t
             LEFT JOIN review_bots b ON b.id = t.bot_id
            WHERE t.workspace_id = ? AND t.deleted_at IS NULL
            ORDER BY (last_reviewed_at IS NULL), last_reviewed_at DESC, t.id`,
        )
        .bind(workspaceId)
        .all<LiveTargetListRow>();
      return res.results;
    },

    async listLiveByBot(botId: string): Promise<ReviewTargetRow[]> {
      const res = await db
        .prepare(
          `SELECT * FROM review_targets
           WHERE bot_id = ? AND deleted_at IS NULL
           ORDER BY created_at, id`,
        )
        .bind(botId)
        .all<ReviewTargetRow>();
      return res.results;
    },

    async resolveByRepo(
      botId: string,
      repo: { id: number | null; owner: string; name: string },
    ): Promise<ReviewTargetRow | null> {
      if (repo.id !== null) {
        const hit = await db
          .prepare(
            `SELECT * FROM review_targets
             WHERE bot_id = ? AND repo_id = ? AND deleted_at IS NULL
             ORDER BY created_at, id LIMIT 1`,
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
            WHERE bot_id = ? AND repo_owner = ? COLLATE NOCASE AND repo_name = ? COLLATE NOCASE
              AND repo_id IS NULL AND deleted_at IS NULL
            ORDER BY created_at, id
            LIMIT 2`,
        )
        .bind(botId, repo.owner, repo.name)
        .all<ReviewTargetRow>();
      if (unclaimed.results.length > 1) return null;
      const legacy = unclaimed.results[0];
      if (legacy) {
        if (repo.id === null) return legacy;
        const claimed = await db
          .prepare(
            `UPDATE review_targets
                SET repo_id = ?, repo_owner = ?, repo_name = ?, updated_at = datetime('now')
              WHERE id = ? AND repo_id IS NULL AND deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM review_targets x
                                 WHERE x.bot_id = review_targets.bot_id
                                   AND x.repo_id = ? AND x.deleted_at IS NULL)`,
          )
          .bind(repo.id, repo.owner, repo.name, legacy.id, repo.id)
          .run();
        if (claimed.meta.changes === 0) return null;
        return db
          .prepare(`SELECT * FROM review_targets WHERE id = ? AND deleted_at IS NULL`)
          .bind(legacy.id)
          .first<ReviewTargetRow>();
      }
      if (repo.id === null) return null;
      const firstDelivery = await db
        .prepare(
          `UPDATE review_targets
              SET repo_id = ?, repo_owner = ?, repo_name = ?, updated_at = datetime('now')
            WHERE bot_id = ?
              AND repo_id IS NULL AND repo_owner IS NULL AND repo_name IS NULL
              AND deleted_at IS NULL
              AND (SELECT COUNT(*) FROM review_targets x
                    WHERE x.bot_id = ? AND x.repo_id IS NULL
                      AND x.repo_owner IS NULL AND x.repo_name IS NULL
                      AND x.deleted_at IS NULL) = 1
              AND NOT EXISTS (SELECT 1 FROM review_targets y
                               WHERE y.bot_id = review_targets.bot_id
                                 AND y.repo_id = ? AND y.deleted_at IS NULL)`,
        )
        .bind(repo.id, repo.owner, repo.name, botId, botId, repo.id)
        .run();
      if (firstDelivery.meta.changes === 0) return null;
      return db
        .prepare(
          `SELECT * FROM review_targets
            WHERE bot_id = ? AND repo_id = ? AND deleted_at IS NULL
            ORDER BY created_at, id LIMIT 1`,
        )
        .bind(botId, repo.id)
        .first<ReviewTargetRow>();
    },

    async getForExecution(targetId: string): Promise<ReviewTargetRow | null> {
      return db
        .prepare(`SELECT * FROM review_targets WHERE id = ? AND deleted_at IS NULL`)
        .bind(targetId)
        .first<ReviewTargetRow>();
    },

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

    async setReviewConfig(
      workspaceId: string,
      targetId: string,
      config: TargetReviewConfig,
    ): Promise<boolean> {
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
      if (config.reviewDrafts !== undefined) {
        assignments.push("review_drafts = ?");
        values.push(config.reviewDrafts ? 1 : 0);
      }
      if (config.follow !== undefined) {
        assignments.unshift("follow_workspace_defaults = ?");
        values.unshift(config.follow);
      }
      if (assignments.length === 0) return false;
      const res = await db
        .prepare(
          `UPDATE review_targets SET ${assignments.join(", ")}, updated_at = datetime('now')
           WHERE ${LIVE_TARGET}`,
        )
        .bind(...values, targetId, workspaceId)
        .run();
      return res.meta.changes > 0;
    },

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
