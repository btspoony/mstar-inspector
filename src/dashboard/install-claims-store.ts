/**
 * D1 store for `install_claims` (migration 0067): a signed-in workspace
 * manager's short-lived intent to install ONE bot (App).
 *
 * Why a claim exists at all: GitHub's setup redirect carries no `state`, so the
 * installation id arriving at the callback cannot name the App it was started
 * for. The App page records the intent instead, and the callback treats the
 * signed-in session as the identity. Three rules follow and are enforced here
 * rather than at the call sites:
 *
 *   - A claim belongs to the user who created it. Every read and the consume
 *     predicate bind `user_id`, so another session's claim is indistinguishable
 *     from a missing one.
 *   - One live claim per (user, bot) — enforced by the partial unique index
 *     `install_claims_live_bot` and by the upsert below, so a second press of
 *     the install button refreshes the same row instead of stacking.
 *   - `consumeAndBind` is ONE batch: consume, upsert the installation. It
 *     writes `bot_installations` ONLY — never `review_targets`: an installation
 *     is the bot's, and which repositories it reviews is decided by the
 *     repositories a manager adds as targets (D19).
 *
 * Expiry is a text comparison on ISO instants and there is no sweeper: the live
 * predicate (`consumed_at IS NULL AND expires_at > :now`) makes a lapsed row
 * inert, and a lapsed row is still the upsert's conflict target so the next
 * attempt rewrites it in place.
 *
 * `workspace_id` is the workspace the claim was made in: a later per-tenant
 * claim list reads it without a join, and it is the only row that remembers an
 * intent that predates the installation.
 */
import type { DashboardD1, DashboardD1BatchResult } from "./users";

/**
 * How long a claim stays live. Fifteen minutes covers GitHub's install page
 * (org choice, permission review, a second factor) and is short enough that a
 * claim created for one attempt cannot bind an install started much later in
 * another tab. Exported so tests build expired rows from the same constant.
 */
export const INSTALL_CLAIM_TTL_MS = 15 * 60 * 1000;

/** One live claim as the setup page lists it: the App to install, not a target. */
export type InstallClaim = {
  id: string;
  workspace_id: string;
  bot_id: string;
  bot_name: string;
  created_at: string;
};

/**
 * Why a claim could not be bound. Refusals are VALUES, not thrown strings: the
 * setup route maps each one to its frozen status/body pair and never parses a
 * message. A bot-level claim has only two faces — it exists and the bot is
 * installable, or it does not.
 */
export type InstallBindOutcome =
  | { outcome: "bound"; botId: string }
  | { outcome: "claim_not_found" }
  | { outcome: "bot_not_shared" };

export type InstallClaimsStore = {
  createOrRefreshClaim(input: {
    userId: string;
    workspaceId: string;
    botId: string;
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

/**
 * Insert, or refresh the live row the partial unique index already holds. The
 * refresh carries `workspace_id`: the claim is what the signed-in user pressed
 * install FOR, so a re-claim from another workspace moves the live row there
 * instead of leaving a stale tenant behind the same user/bot pair.
 */
const CREATE_CLAIM_SQL = `
  INSERT INTO install_claims
    (id, user_id, workspace_id, bot_id, created_at, expires_at, consumed_at, consumed_token)
  VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  ON CONFLICT (user_id, bot_id) WHERE consumed_at IS NULL DO UPDATE SET
    workspace_id = excluded.workspace_id,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at
  RETURNING id`;

const LIST_LIVE_CLAIMS_SQL = `
  SELECT c.id, c.workspace_id, c.bot_id, b.name AS bot_name, c.created_at
    FROM install_claims c
    JOIN review_bots b ON b.id = c.bot_id
   WHERE c.user_id = ? AND c.consumed_at IS NULL AND c.expires_at > ?
   ORDER BY c.created_at, c.id`;

/**
 * The pre-read that NAMES a refusal. It authorizes nothing: the consume's own
 * predicates decide whether the bind happens, so a race that unshares the bot
 * between this read and the batch still binds nothing.
 */
const CLAIM_STATE_SQL = `
  SELECT c.user_id, c.consumed_at, c.expires_at, c.bot_id,
         b.deleted_at AS bot_deleted_at, b.scope AS bot_scope
    FROM install_claims c
    JOIN review_bots b ON b.id = c.bot_id
   WHERE c.id = ?`;

/**
 * Statement 1 of the batch: the consume, with every predicate inside it. The
 * request's own token is written with the instant because the INSTANT is not an
 * identity — two requests in the same millisecond capture the same ISO `now`,
 * and statement 2 must not accept the loser's claim on that coincidence.
 */
const CONSUME_SQL = `
  UPDATE install_claims SET consumed_at = ?, consumed_token = ?
   WHERE id = ? AND user_id = ?
     AND consumed_at IS NULL AND expires_at > ?
     AND EXISTS (
       SELECT 1 FROM review_bots b
        WHERE b.id = install_claims.bot_id
          AND b.deleted_at IS NULL AND b.scope = 'shared')`;

/**
 * Statement 2: the installation row, keyed on the claim's bot, gated on THIS
 * request's token. `DO UPDATE` touches neither `account_login` (the webhook may
 * already hold the authoritative login) nor `id`, and clearing `removed_at`
 * makes a reinstall visible again. No target is written — an installation is
 * the bot's, and the repositories it reviews are targets a manager adds.
 */
const UPSERT_INSTALLATION_SQL = `
  INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
  SELECT ?, c.bot_id, ?, NULL, ?, NULL
    FROM install_claims c
   WHERE c.id = ? AND c.consumed_token = ? AND c.user_id = ?
  ON CONFLICT (bot_id, installation_id) DO UPDATE SET
    seen_at = excluded.seen_at, removed_at = NULL`;

type ClaimState = {
  user_id: string;
  consumed_at: string | null;
  expires_at: string;
  bot_id: string;
  bot_deleted_at: string | null;
  bot_scope: string;
};

/** Create the install_claims store over one D1 handle. */
export function createInstallClaimsStore(db: DashboardD1): InstallClaimsStore {
  /** The reason a claim cannot be bound, or null when the batch should decide. */
  function refusalOf(
    state: ClaimState,
    userId: string,
    now: string,
  ): Exclude<InstallBindOutcome, { outcome: "bound" }> | null {
    if (state.user_id !== userId || state.consumed_at !== null || state.expires_at <= now) {
      return { outcome: "claim_not_found" };
    }
    if (state.bot_deleted_at !== null || state.bot_scope !== "shared") {
      return { outcome: "bot_not_shared" };
    }
    return null;
  }

  const store: InstallClaimsStore = {
    async createOrRefreshClaim({ userId, workspaceId, botId, now }) {
      const expiresAt = new Date(Date.parse(now) + INSTALL_CLAIM_TTL_MS).toISOString();
      const row = await db
        .prepare(CREATE_CLAIM_SQL)
        .bind(crypto.randomUUID(), userId, workspaceId, botId, now, expiresAt)
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
      const refusal = refusalOf(state, userId, now);
      if (refusal !== null) return refusal;
      // The ownership proof for statement 2. `now` cannot serve: two requests
      // in the same millisecond capture the same instant, and the loser's write
      // would then match the winner's consumed row.
      const token = crypto.randomUUID();

      // ONE batch on purpose: a failed install write must not leave a consumed
      // claim, and D1 rolls the whole batch back on a thrown statement.
      const results: DashboardD1BatchResult[] = await db.batch([
        db.prepare(CONSUME_SQL).bind(now, token, claimId, userId, now),
        db
          .prepare(UPSERT_INSTALLATION_SQL)
          .bind(crypto.randomUUID(), installationId, now, claimId, token, userId),
      ]);

      if ((results[0]?.meta.changes ?? 0) === 0) {
        // The consume lost: re-read to say why (the state may have changed
        // under this request — consumed elsewhere, bot unshared or deleted).
        const after = await db.prepare(CLAIM_STATE_SQL).bind(claimId).first<ClaimState>();
        if (after === null) return { outcome: "claim_not_found" };
        return refusalOf(after, userId, now) ?? { outcome: "claim_not_found" };
      }
      if ((results[1]?.meta.changes ?? 0) === 0) {
        // Unreachable while the consume's predicates mirror this statement's:
        // the bot predicate that admitted the consume is the one written here.
        // Reported rather than thrown, because the claim is already consumed.
        return { outcome: "claim_not_found" };
      }
      return { outcome: "bound", botId: state.bot_id };
    },
  };
  return store;
}
