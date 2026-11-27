/**
 * The operator's per-Bot multiplier distribution — the typed contract of
 * `GET /api/runtime/bot-multipliers`. Read-only: the view answers which live
 * Bots currently charge each multiplier, so the operator can see what the
 * platform is priced at and which Bot settings a price change or rollback
 * would need to touch. It carries no write path and owns no configuration key.
 *
 * One live Bot is a `review_bots` row with `deleted_at IS NULL`. Bots sharing
 * a multiplier are one group; `count` is always the length of `bots`.
 */

/** One Bot the operator may need to edit: the settings row's own identity. */
export type BotMultiplierBot = {
  botId: string;
  name: string;
  workspaceId: string;
};

/** Every live Bot charging one multiplier value. */
export type BotMultiplierGroup = {
  multiplier: number;
  count: number;
  bots: BotMultiplierBot[];
};

export type BotMultipliersReport = {
  /** Ascending by multiplier; empty when no live Bot exists. */
  groups: BotMultiplierGroup[];
};
