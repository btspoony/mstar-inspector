/**
 * D1 store for `review_targets` / `target_owner_allowlist` — the
 * workspace-owned review configuration.
 *
 * A bot (`review_bots`) is the execution identity: credentials, model chain,
 * sandbox image, installations, the operational pause. A target is what a
 * workspace configures: trigger mode, review depth, Check gate, owner
 * allowlist and the business pause. This module is the ONE write authority for
 * those columns and for the owner allowlist rows.
 *
 * Two read shapes, deliberately not interchangeable:
 *   - TENANT reads — `getById`, `list`, `getCheckGate`, `getAllowlist` and
 *     every setter — carry `workspace_id` in their own SQL. A route check is
 *     not the contract: an id from another workspace must read absent here.
 *   - `resolve` is the EXECUTION read a webhook delivery makes: it names a bot
 *     and the delivery's installation, never a workspace, so it carries no
 *     workspace predicate. It is also what an execution lane uses to find the
 *     one target of a bot it already resolved a bot row for.
 *
 * `installation_id` is never written here. Backfill binds it when it creates
 * the target; a delivery must not copy one on, and releasing a slot is not
 * this store's job.
 *
 * The `db` parameter is a locally-declared narrow D1 face (types only, zero
 * imports), the convention `apps-store` follows: a real `D1Database`, the
 * bun:sqlite test double and the store layer's `D1Like` all satisfy it
 * structurally, and dashboard leaf modules import no store/pipeline code.
 * `batch()` exists because the owner-allowlist replace must commit as a set.
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
 * `passVerdicts` is engine `PR_VERDICTS` vocabulary — `saveCheckGate` refuses
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
 * CONFIGURATION, never "the default": the Check lanes read the gate on every
 * terminalization and must fail closed on a row they cannot read.
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
 * One target row as the columns are stored (D1 snake_case). `deleted_at` is
 * the only removal path; `installation_id` is the backfill's binding.
 */
export type ReviewTargetRow = {
  id: string;
  workspace_id: string;
  bot_id: string;
  name: string;
  installation_id: number | null;
  account_login: string | null;
  /** Business pause: 1 = the workspace lets this target review, 0 = paused. */
  review_enabled: number;
  review_trigger_mode: ReviewTriggerMode;
  review_level: string | null;
  check_min_score: number;
  check_pass_verdicts: string;
  allowlist_enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** The owner allowlist: `enabled` is the switch, `owners` the accepted logins. */
export type OwnerAllowlist = {
  enabled: boolean;
  owners: readonly string[];
};

/**
 * The owner allowlist's accepted size: the whole set is replaced inside ONE D1
 * batch, so an unbounded paste would build an arbitrarily large batch. 100
 * covers every realistic shared install. Enforced by `saveAllowlist` (the
 * layer that states the batch-size invariant) and, for the operator-facing
 * 400, by the settings route.
 */
export const ALLOWLIST_MAX_OWNERS = 100;

/**
 * Collapse the allowlist owner set: GitHub logins are case-insensitive, so
 * `Ada` and `ada` are ONE owner and the first submitted spelling is the one
 * kept. Order is NOT preserved: the table has no sequence column and
 * `getAllowlist` reads `ORDER BY owner_login`, so the settings form lists the
 * owners alphabetically however they were submitted.
 */
export function dedupeOwnerLogins(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  return logins.filter((login) => {
    const folded = login.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
}

/**
 * The gate a stored row carries, or `null` when its verdict array is
 * unreadable. The execution lanes read the gate straight off a resolved row
 * (`resolve`), so this is the ONE parser both the tenant read and they use.
 */
export function targetCheckGate(row: {
  check_min_score: number;
  check_pass_verdicts: string;
}): CheckGate | null {
  const passVerdicts = storedPassVerdicts(row.check_pass_verdicts);
  if (passVerdicts === null) return null;
  return { minScore: row.check_min_score, passVerdicts };
}

/** Input for `create` — the caller owns the workspace and bot facts. */
export type CreateTargetInput = {
  workspaceId: string;
  botId: string;
  name: string;
  createdBy: string;
  /**
   * The score floor the target starts at. Omitted → the product default; the
   * manifest commit passes the workspace's own default so a new target
   * inherits the tenant's floor instead of the column's historical value.
   */
  checkMinScore?: number;
};

/** Narrow D1 face, declared locally so this leaf module imports nothing. */
type TargetsStoreStatement = {
  bind(...values: unknown[]): TargetsStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: unknown[]; meta: { changes: number; last_row_id: number } }>;
};

type TargetsStoreD1 = {
  prepare(query: string): TargetsStoreStatement;
  batch(statements: TargetsStoreStatement[]): Promise<Array<{ meta: { changes: number } }>>;
};

/**
 * The live-target predicate every tenant read/write carries. `id = ?` alone
 * would let a route check (or a bug in one) reach another workspace's row;
 * `deleted_at IS NULL` keeps a soft-deleted target out of every face.
 */
const LIVE_TARGET = "id = ? AND workspace_id = ? AND deleted_at IS NULL";

/** Create the review_targets / target_owner_allowlist store over one D1 handle. */
export function createTargetsStore(db: TargetsStoreD1) {
  return {
    /**
     * Insert one target for a bot and read it back. The policy columns keep
     * the DDL defaults — `review_enabled` 1, `review_trigger_mode`
     * `every_push`, `review_level` NULL, `["ship it"]` verdicts, allowlist off
     * — because those ARE the contract's create-path defaults; only the score
     * floor is caller-supplied. `installation_id` stays NULL: the create path
     * binds no installation.
     *
     * The manifest commit writes this same shape inline, inside ITS batch (bot
     * + workspace mapping + target), because a bot must not exist without its
     * target and a second statement outside that batch could not be atomic.
     */
    async create(input: CreateTargetInput): Promise<ReviewTargetRow> {
      const id = crypto.randomUUID();
      const minScore = isCheckMinScoreValue(input.checkMinScore)
        ? input.checkMinScore
        : DEFAULT_CHECK_MIN_SCORE;
      await db
        .prepare(
          `INSERT INTO review_targets
             (id, workspace_id, bot_id, name, check_min_score, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .bind(id, input.workspaceId, input.botId, input.name, minScore, input.createdBy)
        .run();
      const row = await db
        .prepare(`SELECT * FROM review_targets WHERE ${LIVE_TARGET}`)
        .bind(id, input.workspaceId)
        .first<ReviewTargetRow>();
      if (!row) throw new Error("targets-store: create target row vanished on read-back");
      return row;
    },

    /** One live target of this workspace; another workspace's id reads null. */
    async getById(workspaceId: string, targetId: string): Promise<ReviewTargetRow | null> {
      return db
        .prepare(`SELECT * FROM review_targets WHERE ${LIVE_TARGET}`)
        .bind(targetId, workspaceId)
        .first<ReviewTargetRow>();
    },

    /** The workspace's live targets, newest first (stable id tiebreak). */
    async list(workspaceId: string): Promise<ReviewTargetRow[]> {
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
     * The bot's single live target IN this workspace — the TENANT read the
     * dashboard faces use. Same liveness predicate as every setter, so a
     * target that belongs to another workspace resolves null here instead of
     * handing a foreign row to a route that already checked membership. Two
     * live targets in one workspace are ambiguous → null, the same rule
     * `resolve` applies.
     */
    async resolveInWorkspace(
      workspaceId: string,
      botId: string,
    ): Promise<ReviewTargetRow | null> {
      const rows = await db
        .prepare(
          `SELECT * FROM review_targets
           WHERE bot_id = ? AND workspace_id = ? AND deleted_at IS NULL
           LIMIT 2`,
        )
        .bind(botId, workspaceId)
        .all<ReviewTargetRow>();
      return rows.results.length === 1 ? rows.results[0]! : null;
    },

    /**
     * The target a delivery or an execution lane acts on, by the contract's
     * two steps: the non-deleted row bound to the delivery's installation
     * when one exists, else the bot's ONLY non-deleted target, else null.
     *
     * Two guards sit on those steps and are `resolve`-local on purpose, so the
     * webhook, the Check reconciler and every dashboard lane agree:
     *
     *   - A binding whose `bot_installations` row carries `removed_at` resolves
     *     NOTHING and does not fall through to the single-target step: falling
     *     through would silently re-attribute a deletion to another target.
     *     The target keeps the binding, so a reinstall resumes reviewing
     *     without a new claim.
     *   - A `shared` bot loses the single-target fallback entirely. Any
     *     installation of a shared bot would otherwise review as the official
     *     workspace's target with no claim, which is exactly the attribution
     *     the platform forbids: an unclaimed installation is referenced by no
     *     target. An `owned` bot's fallback is untouched.
     *
     * `installationId` null means "no delivery installation" (a dashboard or
     * lane read): only the single-target step can answer.
     */
    async resolve(botId: string, installationId: number | null): Promise<ReviewTargetRow | null> {
      if (installationId !== null) {
        // One read for the binding and its installation's removal stamp, so
        // the guard costs no round trip on the hot path.
        const bound = await db
          .prepare(
            `SELECT t.*, EXISTS (
                      SELECT 1 FROM bot_installations i
                       WHERE i.bot_id = t.bot_id AND i.installation_id = t.installation_id
                         AND i.removed_at IS NOT NULL) AS installation_removed
               FROM review_targets t
              WHERE t.bot_id = ? AND t.installation_id = ? AND t.deleted_at IS NULL`,
          )
          .bind(botId, installationId)
          .first<ReviewTargetRow & { installation_removed: number }>();
        if (bound) {
          const { installation_removed: removed, ...target } = bound;
          if (removed !== 0) return null;
          return target;
        }
      }
      const rows = await db
        .prepare(
          `SELECT t.* FROM review_targets t JOIN review_bots b ON b.id = t.bot_id
            WHERE t.bot_id = ? AND t.deleted_at IS NULL AND b.scope <> 'shared'
            LIMIT 2`,
        )
        .bind(botId)
        .all<ReviewTargetRow>();
      return rows.results.length === 1 ? rows.results[0]! : null;
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
     * Select the auto-trigger mode. The mode must be on the
     * REVIEW_TRIGGER_MODES vocabulary — anything else throws BEFORE any write
     * (the settings route answers 400 first; the DDL CHECK is the last line).
     * Returns whether a row changed (false also covers an unknown, deleted or
     * foreign target).
     */
    async setReviewTriggerMode(
      workspaceId: string,
      targetId: string,
      mode: ReviewTriggerMode,
    ): Promise<boolean> {
      if (!REVIEW_TRIGGER_MODES.includes(mode)) {
        throw new Error(
          `targets-store: review trigger mode ${JSON.stringify(mode)} is not on the vocabulary (${REVIEW_TRIGGER_MODES.join(" | ")}) — zero rows written`,
        );
      }
      const res = await db
        .prepare(
          `UPDATE review_targets SET review_trigger_mode = ?, updated_at = datetime('now')
           WHERE ${LIVE_TARGET}`,
        )
        .bind(mode, targetId, workspaceId)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Select the review depth. `null` is the "follow the operator default"
     * choice and writes the column back to NULL, so it is a successful write,
     * not a no-op. A non-null level must be on the shared `REVIEW_LEVELS`
     * vocabulary — anything else throws BEFORE any write. Returns whether a
     * row changed.
     */
    async setReviewLevel(
      workspaceId: string,
      targetId: string,
      level: ReviewLevel | null,
    ): Promise<boolean> {
      if (level !== null && !isReviewLevel(level)) {
        throw new Error(
          `targets-store: review level ${JSON.stringify(level)} is not on the vocabulary (${REVIEW_LEVELS.join(" | ")}) — zero rows written`,
        );
      }
      const res = await db
        .prepare(
          `UPDATE review_targets SET review_level = ?, updated_at = datetime('now')
           WHERE ${LIVE_TARGET}`,
        )
        .bind(level, targetId, workspaceId)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Save the Check gate. The score must be an integer in 0..100 and every
     * verdict must be on the engine `PR_VERDICTS` vocabulary — anything else
     * throws BEFORE any write (the settings route answers 400 first; the DDL
     * CHECK is the last line for the score). The verdict array is stored as
     * JSON, the form the DDL default uses. Returns whether a row changed.
     */
    async saveCheckGate(
      workspaceId: string,
      targetId: string,
      gate: CheckGate,
    ): Promise<boolean> {
      if (!Number.isInteger(gate.minScore) || gate.minScore < 0 || gate.minScore > 100) {
        throw new Error(
          `targets-store: check gate min score ${JSON.stringify(gate.minScore)} is outside 0..100 — zero rows written`,
        );
      }
      for (const verdict of gate.passVerdicts) {
        if (!PR_VERDICTS.includes(verdict)) {
          throw new Error(
            `targets-store: check gate verdict ${JSON.stringify(verdict)} is not on PR_VERDICTS (${PR_VERDICTS.join(" | ")}) — zero rows written`,
          );
        }
      }
      const res = await db
        .prepare(
          `UPDATE review_targets
           SET check_min_score = ?, check_pass_verdicts = ?, updated_at = datetime('now')
           WHERE ${LIVE_TARGET}`,
        )
        .bind(gate.minScore, JSON.stringify(gate.passVerdicts), targetId, workspaceId)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Save the owner allowlist: the switch plus the owner set, which is
     * REPLACED — delete-then-insert in ONE batch, so a removal is written by
     * the same operation that adds. Duplicate logins collapse
     * case-insensitively; an empty set is legal and, with the switch on,
     * refuses every owner (fail closed).
     *
     * Refuses a collapsed set larger than ALLOWLIST_MAX_OWNERS before any
     * read, and refuses an unknown, deleted or foreign target with no rows
     * written. Every statement repeats the liveness/tenant predicate, so a
     * delete or a workspace mix-up landing between the pre-read and the batch
     * writes NO owner rows and the UPDATE's change count reports `false`
     * instead of a save that never took effect.
     */
    async saveAllowlist(
      workspaceId: string,
      targetId: string,
      allowlist: OwnerAllowlist,
    ): Promise<boolean> {
      // Collapse first: the INSERT count is the deduped set, so duplicates
      // must not consume the budget.
      const owners = dedupeOwnerLogins(allowlist.owners);
      if (owners.length > ALLOWLIST_MAX_OWNERS) {
        throw new Error(
          `targets-store: owner allowlist holds ${owners.length} logins, above ALLOWLIST_MAX_OWNERS (${ALLOWLIST_MAX_OWNERS}) — zero rows written`,
        );
      }
      const live = await db
        .prepare(`SELECT id FROM review_targets WHERE ${LIVE_TARGET}`)
        .bind(targetId, workspaceId)
        .first<{ id: string }>();
      if (!live) return false;
      const liveTarget = `EXISTS (SELECT 1 FROM review_targets t
        WHERE t.id = ? AND t.workspace_id = ? AND t.deleted_at IS NULL)`;
      // ONE batch on purpose: chunking a replace is not atomic — a failed
      // later chunk would leave a partial owner set. The statement count
      // (ALLOWLIST_MAX_OWNERS + 2) stays below any observed D1 batch limit.
      const results = await db.batch([
        db
          .prepare(`DELETE FROM target_owner_allowlist WHERE target_id = ? AND ${liveTarget}`)
          .bind(targetId, targetId, workspaceId),
        ...owners.map((owner) =>
          db
            .prepare(
              `INSERT INTO target_owner_allowlist (target_id, owner_login, created_at)
               SELECT ?, ?, datetime('now') WHERE ${liveTarget}`,
            )
            .bind(targetId, owner, targetId, workspaceId),
        ),
        db
          .prepare(
            `UPDATE review_targets SET allowlist_enabled = ?, updated_at = datetime('now')
             WHERE ${LIVE_TARGET}`,
          )
          .bind(allowlist.enabled ? 1 : 0, targetId, workspaceId),
      ]);
      return (results.at(-1)?.meta.changes ?? 0) > 0;
    },

    /**
     * The target's gate, or `null` for an unknown, deleted or foreign target
     * as well as for a readable row whose stored verdicts are unreadable —
     * every consumer fails closed instead of inventing a permissive default.
     */
    async getCheckGate(workspaceId: string, targetId: string): Promise<CheckGate | null> {
      const row = await db
        .prepare(
          `SELECT check_min_score, check_pass_verdicts FROM review_targets
           WHERE ${LIVE_TARGET}`,
        )
        .bind(targetId, workspaceId)
        .first<{ check_min_score: number; check_pass_verdicts: string }>();
      return row === null ? null : targetCheckGate(row);
    },

    /**
     * The target's owner allowlist: the switch plus the owner logins sorted by
     * `owner_login` (SQLite's BINARY collation). ONE statement, so the switch
     * and the owner set come from the same snapshot — a save landing between
     * two reads could otherwise admit against a switch that no longer applies
     * to the list it was read with. An unknown, deleted or foreign target
     * reads null.
     */
    async getAllowlist(
      workspaceId: string,
      targetId: string,
    ): Promise<OwnerAllowlist | null> {
      const rows = await db
        .prepare(
          `SELECT t.allowlist_enabled AS enabled, a.owner_login
             FROM review_targets t
             LEFT JOIN target_owner_allowlist a ON a.target_id = t.id
            WHERE t.id = ? AND t.workspace_id = ? AND t.deleted_at IS NULL
            ORDER BY a.owner_login`,
        )
        .bind(targetId, workspaceId)
        .all<{ enabled: number; owner_login: string | null }>();
      const [first] = rows.results;
      if (first === undefined) return null;
      return {
        enabled: first.enabled !== 0,
        owners: rows.results.flatMap((row) => (row.owner_login === null ? [] : [row.owner_login])),
      };
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
