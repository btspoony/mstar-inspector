/**
 * ONE RP domain, shared by every writer, store and reader of a price.
 *
 * The ceiling and the multiplier meet in `ceil(base(level) × multiplier)`: a
 * ceiling is a whole number of RP a workspace may spend, a multiplier is the
 * bot's factor over the profile's level weight. Both are stored as numbers and
 * served back to the SPA, so a value one writer accepts and a parser refuses
 * turns a whole mounted App read into a load error. These are therefore the
 * bounds BOTH sides apply — not a validation detail of any single route.
 *
 * `RP_CEILING_MAX` is one billion RP (a million Credits at the ADR rate of
 * 1,000 RP per Credit): far above any real allowance, and a safe integer with
 * room to spare so a sum of ceilings never loses precision.
 *
 * `BOT_MULTIPLIER_MAX` keeps the PRICE representable at the largest level
 * weight a profile may carry (`QUOTA_BASE_MAX` = the shipped deep weight): a
 * review then costs at most 300 × 1,000 = 300,000 RP. A multiplier past it
 * would price a single review above any ceiling that can be stored, so no
 * consumer could ever afford it.
 */
export const RP_CEILING_MAX = 1_000_000_000;
export const QUOTA_BASE_MAX = 300;
export const BOT_MULTIPLIER_MAX = 1_000;

/** A spendable allowance: a positive whole number of RP inside the domain. */
export function isRpCeiling(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= RP_CEILING_MAX
  );
}

/** A bot's price factor: finite, > 0, and bounded so its price stays representable. */
export function isBotMultiplier(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= BOT_MULTIPLIER_MAX;
}

/** A computed price: a whole number of RP inside the same domain, at least 1. */
export function isRpPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= RP_CEILING_MAX;
}
