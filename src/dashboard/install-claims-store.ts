/**
 * D1 store for `install_claims` (migration 0059): a signed-in workspace
 * manager's short-lived intent to bind ONE installation to ONE review target.
 *
 * Why a claim exists at all: GitHub's setup redirect carries no `state`, so the
 * installation id arriving at the callback cannot name the target it was
 * started from. The target page records the intent instead, and the callback
 * treats the signed-in session as the identity. Three rules follow and are
 * enforced here rather than at the call sites:
 *
 *   - A claim belongs to the user who created it. Every read and the consume
 *     predicate bind `user_id`, so another session's claim is indistinguishable
 *     from a missing one.
 *   - One live claim per (user, target) — enforced by the partial unique index
 *     `install_claims_live_target` and by the upsert below, so a second press of
 *     the install button refreshes the same row instead of stacking. "N claims"
 *     therefore always means N different targets.
 *   - `consumeAndBind` is ONE batch: consume, upsert the installation, bind the
 *     target. A bind that cannot complete rolls back, so a refusal never burns
 *     the claim. It is the only production writer of
 *     `review_targets.installation_id`; no webhook writes a binding.
 *
 * Expiry is a text comparison on ISO instants and there is no sweeper: the live
 * predicate (`consumed_at IS NULL AND expires_at > :now`) makes a lapsed row
 * inert, and a lapsed row is still the upsert's conflict target so the next
 * attempt rewrites it in place.
 *
 * `workspace_id` is the target's workspace at claim time: a later per-tenant
 * claim list reads it without a join, and it is the only row that remembers an
 * intent that predates the binding.
 */
import type { DashboardD1, DashboardD1BatchResult } from "./users";

/**
 * How long a claim stays live. Fifteen minutes covers GitHub's install page
 * (org choice, permission review, a second factor) and is short enough that a
 * claim created for one attempt cannot bind an install started much later in
 * another tab. Exported so tests build expired rows from the same constant.
 */
export const INSTALL_CLAIM_TTL_MS = 15 * 60 * 1000;

/** One live claim as the setup page lists it (contract § 9.2). */
export type InstallClaim = {
  id: string;
  workspace_id: string;
  target_id: string;
  created_at: string;
};

/**
 * Why a claim could not be bound. Refusals are VALUES, not thrown strings: the
 * setup route maps each one to its frozen status/body pair and never parses a
 * message.
 */
export type InstallBindOutcome =
  | { outcome: "bound"; targetId: string }
  | { outcome: "claim_not_found" }
  | { outcome: "target_not_bindable" }
  | { outcome: "bot_not_shared" }
  | { outcome: "installation_already_bound" };

export type InstallClaimsStore = {
  createOrRefreshClaim(input: {
    userId: string;
    workspaceId: string;
    targetId: string;
    now: string;
  }): Promise<{ id: string; expiresAt: string }>;
  listLiveClaims(userId: string, now: string): Promise<InstallClaim[]>;
  consumeAndBind(input: {
    claimId: string;
    userId: string;
    installationId: number;
    now: string;
  }): Promise<InstallBindOutcome>;
};

/** Insert, or refresh the live row the partial unique index already holds. */
const CREATE_CLAIM_SQL = `
  INSERT INTO install_claims
    (id, user_id, workspace_id, target_id, created_at, expires_at, consumed_at, consumed_token)
  VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  ON CONFLICT (user_id, target_id) WHERE consumed_at IS NULL DO UPDATE SET
    created_at = excluded.created_at,
    expires_at = excluded.expires_at
  RETURNING id`;

const LIST_LIVE_CLAIMS_SQL = `
  SELECT id, workspace_id, target_id, created_at
    FROM install_claims
   WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?
   ORDER BY created_at, id`;

/**
 * The pre-read that NAMES a refusal. It authorizes nothing: the consume's own
 * predicates decide whether the bind happens, so a race that unshares the bot
 * between this read and the batch still binds nothing (contract § 9.4).
 */
const CLAIM_STATE_SQL = `
  SELECT c.user_id, c.consumed_at, c.expires_at, c.target_id,
         t.deleted_at AS target_deleted_at, t.installation_id AS target_installation_id,
         b.deleted_at AS bot_deleted_at, b.scope AS bot_scope
    FROM install_claims c
    JOIN review_targets t ON t.id = c.target_id
    JOIN review_bots b ON b.id = t.bot_id
   WHERE c.id = ?`;

/**
 * Statement 1 of the batch: the consume, with every predicate inside it. The
 * request's own token is written with the instant because the INSTANT is not an
 * identity — two requests in the same millisecond capture the same ISO `now`,
 * and statements 2–3 must not accept the loser's claim on that coincidence.
 */
const CONSUME_SQL = `
  UPDATE install_claims SET consumed_at = ?, consumed_token = ?
   WHERE id = ? AND user_id = ?
     AND consumed_at IS NULL AND expires_at > ?
     AND EXISTS (
       SELECT 1 FROM review_targets t JOIN review_bots b ON b.id = t.bot_id
        WHERE t.id = install_claims.target_id
          AND t.deleted_at IS NULL AND b.deleted_at IS NULL AND b.scope = 'shared'
          AND (t.installation_id IS NULL OR t.installation_id = ?))`;

/**
 * Statement 2: the installation row, keyed by the target's bot and the
 * delivery's installation, gated on THIS request's token. `DO UPDATE` touches
 * neither `account_login` (the webhook may already hold the authoritative
 * login) nor `id`, and clearing `removed_at` makes a reinstall visible again.
 */
const UPSERT_INSTALLATION_SQL = `
  INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
  SELECT ?, t.bot_id, ?, NULL, ?, NULL
    FROM install_claims c JOIN review_targets t ON t.id = c.target_id
   WHERE c.id = ? AND c.consumed_token = ? AND c.user_id = ?
  ON CONFLICT (bot_id, installation_id) DO UPDATE SET
    seen_at = excluded.seen_at, removed_at = NULL`;

/**
 * Statement 3: the binding, gated on the same token. `account_login` is copied
 * from `bot_installations` — the value the webhook recorded — because the setup
 * redirect carries no login; it is NULL until the webhook arrives.
 */
const BIND_TARGET_SQL = `
  UPDATE review_targets SET
    installation_id = ?,
    account_login = (SELECT account_login FROM bot_installations
                      WHERE bot_id = review_targets.bot_id AND installation_id = ?),
    updated_at = ?
   WHERE id = ? AND deleted_at IS NULL
     AND (installation_id IS NULL OR installation_id = ?)
     AND EXISTS (SELECT 1 FROM install_claims
                  WHERE id = ? AND consumed_token = ? AND user_id = ?)`;

type ClaimState = {
  user_id: string;
  consumed_at: string | null;
  expires_at: string;
  target_id: string;
  target_deleted_at: string | null;
  target_installation_id: number | null;
  bot_deleted_at: string | null;
  bot_scope: string;
};

/** One UNIQUE-violation message, wherever D1/bun:sqlite prefixed it. */
function isTargetInstallationCollision(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("UNIQUE constraint failed") && message.includes("review_targets");
}

/** Create the install_claims store over one D1 handle. */
export function createInstallClaimsStore(db: DashboardD1): InstallClaimsStore {
  /** The reason a claim cannot be bound, or null when the batch should decide. */
  function refusalOf(
    state: ClaimState,
    userId: string,
    installationId: number,
    now: string,
  ): Exclude<InstallBindOutcome, { outcome: "bound" }> | null {
    if (state.user_id !== userId || state.consumed_at !== null || state.expires_at <= now) {
      return { outcome: "claim_not_found" };
    }
    if (
      state.target_deleted_at !== null ||
      (state.target_installation_id !== null && state.target_installation_id !== installationId)
    ) {
      return { outcome: "target_not_bindable" };
    }
    if (state.bot_deleted_at !== null || state.bot_scope !== "shared") {
      return { outcome: "bot_not_shared" };
    }
    return null;
  }

  return {
    async createOrRefreshClaim({ userId, workspaceId, targetId, now }) {
      const expiresAt = new Date(Date.parse(now) + INSTALL_CLAIM_TTL_MS).toISOString();
      const row = await db
        .prepare(CREATE_CLAIM_SQL)
        .bind(crypto.randomUUID(), userId, workspaceId, targetId, now, expiresAt)
        .first<{ id: string }>();
      if (row === null) throw new Error("install-claims-store: the claim upsert returned no id");
      return { id: row.id, expiresAt };
    },

    async listLiveClaims(userId, now) {
      // The list never shows another user's claim: the user id is the first
      // bound value of the only read.
      const res = await db.prepare(LIST_LIVE_CLAIMS_SQL).bind(userId, now).all<InstallClaim>();
      return res.results;
    },

    async consumeAndBind({ claimId, userId, installationId, now }) {
      const state = await db.prepare(CLAIM_STATE_SQL).bind(claimId).first<ClaimState>();
      if (state === null) return { outcome: "claim_not_found" };
      const refusal = refusalOf(state, userId, installationId, now);
      if (refusal !== null) return refusal;
      const targetId = state.target_id;
      // The ownership proof for statements 2–3. `now` cannot serve: two
      // requests in the same millisecond capture the same instant, and the
      // loser's writes would then match the winner's consumed row.
      const token = crypto.randomUUID();

      let results: DashboardD1BatchResult[];
      try {
        // ONE batch on purpose: a failed bind must not leave a consumed claim,
        // and D1 rolls the whole batch back on a thrown statement.
        results = await db.batch([
          db.prepare(CONSUME_SQL).bind(now, token, claimId, userId, now, installationId),
          db
            .prepare(UPSERT_INSTALLATION_SQL)
            .bind(crypto.randomUUID(), installationId, now, claimId, token, userId),
          db
            .prepare(BIND_TARGET_SQL)
            .bind(installationId, installationId, now, targetId, installationId, claimId, token, userId),
        ]);
      } catch (err) {
        // The target partial unique index refused a second target of this
        // installation; the batch rolled back, so the claim stays live.
        if (isTargetInstallationCollision(err)) return { outcome: "installation_already_bound" };
        throw err;
      }

      if ((results[0]?.meta.changes ?? 0) === 0) {
        // The consume lost: re-read to say why (the state may have changed
        // under this request — consumed elsewhere, target bound, bot unshared).
        const after = await db.prepare(CLAIM_STATE_SQL).bind(claimId).first<ClaimState>();
        if (after === null) return { outcome: "claim_not_found" };
        return refusalOf(after, userId, installationId, now) ?? { outcome: "claim_not_found" };
      }
      if ((results[2]?.meta.changes ?? 0) === 0) {
        // Unreachable while the consume's predicates mirror this statement's:
        // the target predicate that admitted the consume is the one bound here.
        // Reported rather than thrown, because the claim is already consumed.
        return { outcome: "target_not_bindable" };
      }
      return { outcome: "bound", targetId };
    },
  };
}
