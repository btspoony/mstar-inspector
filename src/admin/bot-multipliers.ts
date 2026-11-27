/**
 * The operator's per-Bot multiplier distribution: every live Review Bot's
 * `multiplier`, grouped by value, with a count per value and the Bots at each
 * value. A price change or rollback is a per-Bot `multiplier` edit, so this
 * view is the operator's answer to "what is the platform currently priced at,
 * and which Bot settings would a rollback need to touch?"
 *
 * Read-only by construction: one SELECT over the live rows
 * (`deleted_at IS NULL`), grouped in SQL — the count and the Bot list of each
 * value come out of the same group, so they can never disagree. The module
 * never writes configuration, runs no audit action and owns no key.
 */
import type {
  BotMultiplierBot,
  BotMultipliersReport,
  BotMultiplierGroup,
} from "../contracts/bot-multipliers";
import type { D1Like } from "../store/types";
import { operatorLogin, type AdminContext } from "./gate";

type MultiplierRow = {
  multiplier: number;
  count: number;
  /** The group's Bots as a JSON array, aggregated by the same statement. */
  bots_json: string;
};

/**
 * Read the distribution. One statement: SQLite's `json_group_array` aggregates
 * the Bots of each group in the database, `count(*)` counts them, and only the
 * in-memory walk parses the JSON the statement already produced — grouping
 * itself never happens here.
 */
export async function readBotMultiplierDistribution(db: D1Like): Promise<BotMultipliersReport> {
  const rows = await db
    .prepare(
      `SELECT multiplier, count(*) AS count,
              json_group_array(json_object('botId', id, 'name', name, 'workspaceId', workspace_id)) AS bots_json
         FROM review_bots
        WHERE deleted_at IS NULL
        GROUP BY multiplier
        ORDER BY multiplier ASC`,
    )
    .all<MultiplierRow>();

  const groups: BotMultiplierGroup[] = rows.results.map((row) => ({
    multiplier: row.multiplier,
    count: row.count,
    bots: JSON.parse(row.bots_json) as BotMultiplierBot[],
  }));
  return { groups };
}

/** `GET /api/runtime/bot-multipliers` — the read-only operator view. */
export async function readBotMultipliers(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json(await readBotMultiplierDistribution(db));
}
