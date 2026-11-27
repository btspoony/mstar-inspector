import type { BotScope } from "../dashboard/apps-store";
import type { DashboardD1 } from "../dashboard/users";
import type { ReviewTargetRow } from "../dashboard/targets-store";
import { checkEntitlement } from "../dashboard/entitlement";
import {
  quotaMonth,
  readBotMultiplier,
  resolveWorkspaceQuotaProfile,
  rpFor,
} from "../store/quota-store";
import { sumMonthlyRp } from "../store/usage-store";

/** One row of the install's chain, as the relay walks it. */
export type ChainBot = {
  botId: string;
  position: number;
  /** The bot's owner workspace; equal to the consuming workspace for an own bot. */
  workspaceId: string;
  scope: BotScope;
  /** The bot's default ceiling, or NULL for none. An override may replace it. */
  monthlyRp: number | null;
};

/** Why a delivery was refused. One value per delivery (D30). */
export type RelayRefusal =
  | { kind: "quota-plan" }
  | { kind: "quota-bot"; botId: string }
  | { kind: "shared-bot-not-included" }
  | { kind: "no-review-bot" }
  | { kind: "entitlement-unreadable" };

/** What the relay decided: the bot to execute as, or the one reason it refused. */
export type RelayOutcome =
  | { kind: "selected"; botId: string }
  | { kind: "refused"; refusal: RelayRefusal };

/** Everything the walk needs that is not a chain row. */
export type RelayInput = {
  db: DashboardD1;
  mode: "saas" | "self-hosted";
  target: ReviewTargetRow;
  /** The INSTANT the delivery is being admitted — one value for the whole walk. */
  now: Date;
  /** The review level's weight, resolved once by the caller. */
  level: "quick" | "default" | "deep";
};

const CHAIN_SQL = `
  SELECT ib.bot_id AS bot_id, ib.position AS position, r.workspace_id AS workspace_id,
         r.scope AS scope, r.monthly_rp AS monthly_rp
    FROM app_install_bots ib
    JOIN review_bots r ON r.id = ib.bot_id AND r.deleted_at IS NULL AND r.archived_at IS NULL
   WHERE ib.github_app_id = ?1 AND ib.workspace_id = ?2
   ORDER BY ib.position ASC`;

/** The install's ordered chain. One statement; no per-row read. */
export async function readChain(
  db: DashboardD1,
  appId: string,
  workspaceId: string,
): Promise<ChainBot[]> {
  const res = await db
    // shortcut: tenant-bypass — the chain statement scopes by the install's own
    // (app, workspace) key; the projection carries no tenant-visible name.
    .prepare(CHAIN_SQL)
    .bind(appId, workspaceId)
    .all<{ bot_id: string; position: number; workspace_id: string; scope: BotScope; monthly_rp: number | null }>();
  return res.results.map((row) => ({
    botId: row.bot_id,
    position: row.position,
    workspaceId: row.workspace_id,
    scope: row.scope,
    monthlyRp: row.monthly_rp,
  }));
}

/** This workspace's ceiling for one bot: the override, else the bot's default. */
export async function readBotCeiling(
  db: DashboardD1,
  botId: string,
  workspaceId: string,
): Promise<number | null> {
  const override = await db
    .prepare(`SELECT monthly_rp AS monthlyRp FROM bot_quota_overrides WHERE bot_id = ?1 AND workspace_id = ?2`)
    .bind(botId, workspaceId)
    .first<{ monthlyRp: number }>();
  if (override !== null) return override.monthlyRp;
  const row = await db
    // shortcut: tenant-bypass — addressed by the bot's own id; the projection is
    // one price column, no identity or ownership.
    .prepare(`SELECT monthly_rp AS monthlyRp FROM review_bots WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(botId)
    .first<{ monthlyRp: number | null }>();
  return row?.monthlyRp ?? null;
}

/**
 * The relay (Task 5): walk the install's chain in position order and take the
 * first bot that passes. One refusal per delivery, and `scope` says which
 * ceiling produced it.
 *
 * THE OWN-BOT SHORTCUT (D15) is a ZERO-READ path, not a passing branch: an own
 * bot returns before the profile read, the month sum, the ceiling read and the
 * entitlement call. A test asserts that by statement counting — "it happened to
 * pass because the workspace had room" is not the shortcut.
 *
 * A shared bot runs plan capability → plan month (shared RP only) → this bot's
 * month. A bot whose owner stopped sharing is SKIPPED, not refused: it stays in
 * the chain as an unavailable row (D29), and skip-on-unavailable is what makes
 * an own bot further down reachable.
 */
export async function selectReviewBot(input: RelayInput): Promise<RelayOutcome> {
  const { db, mode, target, now, level } = input;
  const chain = await readChain(db, target.app_id, target.workspace_id);
  if (chain.length === 0) return { kind: "refused", refusal: { kind: "no-review-bot" } };

  let planBlocked = false;
  let capabilityBlocked = false;
  let botBlocked: string | null = null;

  for (const bot of chain) {
    // A bot the owner stopped sharing is skipped BEFORE any read, own or not:
    // the chain row stays mounted as unavailable (D29), and neither the plan
    // allowance nor the bot's own ceiling may spend a query on it.
    if (bot.scope !== "shared" && bot.workspaceId !== target.workspace_id) {
      // Not shared and not ours: the owner stopped sharing. Skip, never refuse.
      continue;
    }
    if (bot.workspaceId === target.workspace_id) {
      // ZERO quota reads from here to the return: an own bot is admitted by
      // ownership alone (D15). Its stored price is enforced at the CHARGE
      // (`chargeUsage` refuses an out-of-domain multiplier for every path), so
      // selection here needs no read and cannot admit an unpriceable charge.
      return { kind: "selected", botId: bot.botId };
    }
    if (mode === "self-hosted") {
      // Self-hosted has no plan and no quota: the plan is unlimited by
      // definition, so a shared bot is selected without touching a profile or a
      // ceiling. Resolving one there would refuse on an absent profile row for a
      // deployment that never needed quota at all. The price domain is enforced
      // at the charge for this path too.
      return { kind: "selected", botId: bot.botId };
    }

    const capability = await checkEntitlement({
      db,
      mode,
      workspaceId: target.workspace_id,
      kind: "shared-bot",
      botScope: "shared",
    });
    if (!capability.ok && capability.refusal.kind === "shared-bot") {
      // The plan does not INCLUDE a shared bot: a capability fact, never a
      // quota one, so it maps to `shared-bot-not-included` (D30 rule 3).
      capabilityBlocked = true;
      continue;
    }

    const month = quotaMonth(now);
    const profile = await resolveWorkspaceQuotaProfile(db, target.workspace_id, month.month, now.toISOString());
    const multiplier = await readBotMultiplier(db, bot.botId);
    if (multiplier === null) return { kind: "refused", refusal: { kind: "entitlement-unreadable" } };
    const cost = rpFor(level, multiplier, profile);
    // An unrepresentable price is refused, never metered: the writers bound both
    // factors, so only a row from elsewhere reaches this.
    if (cost === null) return { kind: "refused", refusal: { kind: "entitlement-unreadable" } };

    // Plan month: SHARED RP ONLY — an own bot's spend never counts here.
    const sharedUsed = await sharedMonthlyRp(db, target.workspace_id, month);
    const planMonth = await checkEntitlement({
      db,
      mode,
      workspaceId: target.workspace_id,
      kind: "review-quota",
      now,
      usedRp: sharedUsed,
      costRp: cost,
    });
    if (!planMonth.ok && planMonth.refusal.kind === "review-quota") {
      planBlocked = true;
      continue;
    }

    // This bot's month, for THIS workspace.
    const ceiling = await readBotCeiling(db, bot.botId, target.workspace_id);
    const botUsed = await sumMonthlyRp(db, target.workspace_id, month.startIso, month.endIso, bot.botId);
    if (ceiling !== null && botUsed + cost > ceiling) {
      botBlocked = botBlocked ?? bot.botId;
      continue;
    }

    return { kind: "selected", botId: bot.botId };
  }

  // One refusal, in the order the product round fixed (D30): a plan month that
  // blocked any shared bot outranks a per-bot ceiling.
  if (planBlocked) return { kind: "refused", refusal: { kind: "quota-plan" } };
  if (botBlocked !== null) return { kind: "refused", refusal: { kind: "quota-bot", botId: botBlocked } };
  if (capabilityBlocked) return { kind: "refused", refusal: { kind: "shared-bot-not-included" } };
  return { kind: "refused", refusal: { kind: "no-review-bot" } };
}

/** The month's SHARED RP for one workspace — the plan month's own sum. */
async function sharedMonthlyRp(
  db: DashboardD1,
  workspaceId: string,
  month: { startIso: string; endIso: string },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(rp), 0) AS total FROM usage_events
        WHERE workspace_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND source = 'shared'`,
    )
    .bind(workspaceId, month.startIso, month.endIso)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

