/**
 * The ONE Credits/ceiling presentation, shared by every bot and App surface
 * (`/bots`, the bot detail metric, the chain row, the Apps table): a month
 * figure is the used amount in Credits; where a ceiling exists it rides the
 * same cell as `已用 / 上限`; where none exists the cell says so — 不限（自有
 * 机器人）for an own bot, 无上限 otherwise. An unresolved ceiling is the error
 * marker (`bots.monthUnknown`), never "no ceiling" (F10).
 */
import { t, type Locale } from "../../i18n";
import { formatCredits } from "./data";

/** formatCredits without the unit — for dictionary strings that carry their own. */
export function creditAmount(rp: number, rpPerCredit?: number): string {
  return formatCredits(rp, rpPerCredit).slice(0, -" Credits".length);
}

/**
 * The effective multiplier as the surface presents it: a bot is priced only
 * for the workspaces that CONSUME it through sharing — the owner never pays
 * its own multiplier, and an unshared bot has no consumer at all, so both
 * read ×1 wherever an effective figure is stated. The stored value survives
 * in the owner's pricing editor as what it is: a stored value.
 */
export function effectiveMultiplier(owned: boolean, scope: "owned" | "shared", stored: number): number {
  return owned || scope !== "shared" ? 1 : stored;
}

/**
 * One month cell in Credits: `已用 / 上限` when a ceiling is known, the
 * unlimited spelling otherwise. `null` month means nothing is metered
 * (no chain mounted) and renders the bare dash.
 */
export function usageCeilingCell(
  locale: Locale,
  month: { used_rp: number } | null,
  options: {
    /** An own bot is never metered against a ceiling. */
    owned: boolean;
    /** F10: the ceiling could not be resolved — error, never "no ceiling". */
    quotaError: boolean;
    /** The ceiling in RP; `null` is a KNOWN unlimited state. */
    ceilingRp: number | null;
    rpPerCredit?: number;
  },
): string {
  if (month === null) return t(locale, "bots.monthNone");
  const used = creditAmount(month.used_rp, options.rpPerCredit);
  if (options.owned) return t(locale, "credits.unlimitedOwn", { used });
  if (options.quotaError) return t(locale, "bots.monthUnknown");
  if (options.ceilingRp === null) return t(locale, "credits.noCeiling", { used });
  return `${formatCredits(month.used_rp, options.rpPerCredit)} / ${formatCredits(options.ceilingRp, options.rpPerCredit)}`;
}
