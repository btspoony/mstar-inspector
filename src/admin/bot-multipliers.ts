/**
 * The operator's per-Bot multiplier distribution: every live Review Bot's
 * `multiplier`, grouped by value, with the Bots at each value. A price change or
 * rollback is a per-Bot `multiplier` edit, so this view answers "what is the
 * platform currently priced at, and which Bot settings would a rollback need to
 * touch?"
 *
 * The read itself lives in the App store. `tests/store/tenant-read-face.test.ts`
 * allows `review_bots` to be read only from `dashboard/apps-store.ts` plus a
 * short maintenance allowlist, and a maintenance read may not project a name or
 * an owning workspace — both of which this view needs to be useful. So this
 * module holds the operator gate and the response, nothing else.
 *
 * Read-only by construction: no write, no audit action, no key.
 */
import { createReviewBotsStore } from "../dashboard/apps-store";
import type { BotMultipliersReport } from "../contracts/bot-multipliers";
import type { DashboardD1 } from "../dashboard/users";
import { operatorLogin, type AdminContext } from "./gate";

/**
 * Read the distribution. Grouping happens in SQL — the count and the Bot list of
 * each value come out of the same group, so they can never disagree.
 */
export async function readBotMultiplierDistribution(db: DashboardD1): Promise<BotMultipliersReport> {
  const groups = await createReviewBotsStore(db).readMultiplierDistribution();
  return { groups: groups.map((group) => ({ ...group, count: group.bots.length })) };
}

/** `GET /api/runtime/bot-multipliers` — the read-only operator view. */
export async function readBotMultipliers(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json(await readBotMultiplierDistribution(db));
}
