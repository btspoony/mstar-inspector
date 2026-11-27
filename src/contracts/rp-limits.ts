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
 *
 * `CHAIN_MULTIPLIER_MAX` is the same price rule for a CHAIN's aggregate factor
 * — the product the Apps list serves as `month.multiplier`. It is not one
 * stored value, so it legitimately exceeds the single-bot bound (two 100× bots
 * give 10,000); it bounds what a NEW mount may produce, so no chain an operator
 * builds prices a review above any storable ceiling.
 *
 * It is a WRITE bound only. A served product can leave that range without any
 * illegal write: a price edit on one mounted bot, or REMOVING a factor below 1,
 * raises the product of a chain the writer admitted. {@link isServedChainProduct}
 * is therefore the READ half — any positive finite product parses — because a
 * legal edit must never turn the whole Apps list into a load error. The price
 * itself stays guarded where it is spent: `rpFor` and `chargeUsage` refuse a
 * product they cannot price.
 *
 * `BOT_MULTIPLIER_MIN` is the same fact at the other end: a product of legal
 * factors must still be STRICTLY POSITIVE in floating point, or the chain it
 * describes is served as `0` and the Apps parser refuses it. `0.01` is chosen
 * so the floor costs no price anyone could mean — every base weight is a whole
 * number ≥ 1, so any smaller factor already prices every level at or below what
 * `0.01` prices (`rpFor` floors at 1 RP) — and it takes 162 such factors to
 * underflow a double, far past any chain an operator mounts one row at a time.
 * Readers keep the wider {@link isStoredBotMultiplier}, so a row priced before
 * this floor still renders.
 *
 * `RP_PER_CREDIT_MAX` is the profile's credit denominator. Every amount is
 * divided by it, so a rate past the ceiling domain would render every real
 * spend as `0.00` — and the column admits any positive integer, which is
 * exactly how a writer and a reader drift apart. WRITERS apply it; READERS
 * accept a stored row under {@link isStoredRpPerCredit}, because a rate
 * authored before this bound existed must not turn the page into a load error.
 */
export const RP_CEILING_MAX = 1_000_000_000;
export const QUOTA_BASE_MAX = 300;
export const BOT_MULTIPLIER_MAX = 1_000;
export const BOT_MULTIPLIER_MIN = 0.01;
export const CHAIN_MULTIPLIER_MAX = Math.floor(RP_CEILING_MAX / QUOTA_BASE_MAX);
export const RP_PER_CREDIT_MAX = RP_CEILING_MAX;

/** A spendable allowance: a positive whole number of RP inside the domain. */
export function isRpCeiling(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= RP_CEILING_MAX
  );
}

/**
 * A bot's price factor as a WRITER may enter it: finite, inside
 * [`BOT_MULTIPLIER_MIN`, `BOT_MULTIPLIER_MAX`] — bounded above so its price
 * stays representable, floored so a chain's product of legal factors stays
 * strictly positive.
 */
export function isBotMultiplier(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= BOT_MULTIPLIER_MIN &&
    value <= BOT_MULTIPLIER_MAX
  );
}

/**
 * A SERVED chain's factor: the product of the mounted bots' multipliers, as the
 * Apps list and the App detail serve it. Finite and strictly positive is the
 * whole READ domain — the writer's `CHAIN_MULTIPLIER_MAX` is not re-applied
 * here, because a legal price edit or a removal can lift an admitted product
 * past it, and refusing that would fail the entire list for data no rule
 * forbids. `0`, negatives, `Infinity`, `NaN` and non-numbers fail: they are
 * products no reader can render, and `rpFor` prices none of them anyway.
 */
export function isServedChainProduct(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The READ domain of a STORED multiplier: finite, > 0 and inside the price
 * bound, with NO floor.
 *
 * Deliberately wider than {@link isBotMultiplier}: the column only CHECKs
 * `multiplier > 0`, so a bot priced before the floor existed can hold a smaller
 * factor. Refusing it would turn the Apps list and the bot page into a load
 * error for data nobody migrated, and such a factor still prices every level at
 * the 1-RP floor `rpFor` applies. What it must NOT do is let two of them
 * multiply into `0` — that is why the chain write refuses a non-positive
 * product. `0`, negatives, `Infinity`, `NaN` and non-numbers fail.
 */
export function isStoredBotMultiplier(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= BOT_MULTIPLIER_MAX;
}

/** A computed price: a whole number of RP inside the same domain, at least 1. */
export function isRpPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= RP_CEILING_MAX;
}

/**
 * A recorded spend: a whole number of RP, zero allowed (nothing metered yet).
 * A reader that accepted a fraction or a NaN here would print a figure the
 * ledger can never hold.
 */
export function isRpAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The WRITE domain of the profile's credit denominator — what
 * `admin/quota-versions.ts` accepts when a version is authored. A rate above
 * it would scale every real spend to `0.00`, so no new version may carry one.
 */
export function isRpPerCredit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= RP_PER_CREDIT_MAX
  );
}

/**
 * The READ domain of a STORED rate: any positive whole number.
 *
 * Deliberately wider than {@link isRpPerCredit}: the column only CHECKs
 * `rp_per_credit > 0`, so a profile authored before this bound existed can hold
 * any positive integer, including one past `2^53`. Refusing it would turn every
 * face that divides by the rate into a load error for data nobody migrated —
 * and this round ships no migration. Consequence, stated on the faces that read
 * the rate: such a rate scales amounts towards `0.00` until the operator authors
 * a new version. `0`, negatives, fractions, `Infinity` and non-numbers fail.
 */
export function isStoredRpPerCredit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
