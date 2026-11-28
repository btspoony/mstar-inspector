/**
 * QC F2-7 (relay half): the price calculation fails closed.
 *
 * A multiplier past the accounting bound prices a review into a number no
 * stored ceiling can bound. The writers refuse it (see `rp-domain.test.ts`), so
 * a row like this only arrives from somewhere else — and the relay is the last
 * line before a charge: it refuses the delivery instead of metering an
 * unrepresentable amount.
 */
import { describe, expect, test } from "bun:test";
import { selectReviewBot, type RelayInput } from "../../src/worker/select-review-bot";
import { BOT_MULTIPLIER_MAX, isRpCeiling } from "../../src/contracts/rp-limits";
import { rpFor, type QuotaProfile } from "../../src/store/quota-store";
import { createMigratedTestD1, seedBot, type TestD1 } from "../store/helpers";

const TS = "2026-10-24T00:00:00.000Z";
const CONSUMER = "default";
const PROVIDER = "provider";
const APP_ID = "app-relay";

const PROFILE: QuotaProfile = {
  id: "quota-v2-large-base",
  version: 2,
  effectiveFrom: TS,
  base: { quick: 50, default: 100, deep: 300 },
  rpPerCredit: 1000,
};

/**
 * One shared bot of a provider workspace, mounted on the consumer's install and
 * backed by a plan that INCLUDES shared bots — so the only thing standing
 * between the delivery and a charge is the price itself. The consumer holds no
 * own bot, so the walk cannot fall through to one.
 */
function world(multiplier: number): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(PROVIDER, PROVIDER, PROVIDER, TS);
  // The App row (the installation's FK target) plus its split-pair bot row.
  seedBot(db, APP_ID, 9201, { workspaceId: PROVIDER });
  db.raw
    .prepare("UPDATE review_bots SET scope = 'shared', shared_at = ?, multiplier = ?, monthly_rp = NULL WHERE id = ?")
    .run(TS, multiplier, APP_ID);
  db.raw
    .prepare("INSERT INTO app_installations (github_app_id, workspace_id, created_at) VALUES (?, ?, ?)")
    .run(APP_ID, CONSUMER, TS);
  db.raw
    .prepare("INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES (?, ?, 1, ?)")
    .run(APP_ID, CONSUMER, APP_ID);
  db.raw
    .prepare(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
       VALUES (?, 'pro', 'active', ?, ?)`,
    )
    .run(CONSUMER, TS, TS);
  return db;
}

const relayInput = (db: TestD1): RelayInput => ({
  db,
  mode: "saas",
  target: {
    id: "target-relay",
    workspace_id: CONSUMER,
    app_id: APP_ID,
    name: "target-relay",
    repo_id: null,
    repo_owner: "acme",
    repo_name: "widgets",
    review_level: "deep",
    check_min_score: 70,
    review_enabled: 1,
    review_drafts: 1,
    review_trigger_mode: "every_push",
    created_by: "tester",
    created_at: TS,
    updated_at: TS,
  } as RelayInput["target"],
  now: new Date(),
  level: "deep",
});

describe("rpFor stays inside the shared domain", () => {
  test("a max-valid multiplier prices representably", () => {
    const rp = rpFor("deep", BOT_MULTIPLIER_MAX, PROFILE);
    expect(rp).toBe(300 * BOT_MULTIPLIER_MAX);
    expect(isRpCeiling(rp!)).toBe(true);
  });

  test("an unrepresentable product answers null", () => {
    expect(rpFor("deep", Number.POSITIVE_INFINITY, PROFILE)).toBeNull();
    // Finite, and still past the shared ceiling domain: 1e10 × 300.
    expect(rpFor("deep", 1e10, PROFILE)).toBeNull();
  });
});

describe("the relay refuses an unpriceable bot instead of metering it", () => {
  test("a multiplier past the bound is entitlement-unreadable, not a charge", async () => {
    expect(await selectReviewBot(relayInput(world(1e300)))).toEqual({
      kind: "refused",
      refusal: { kind: "entitlement-unreadable" },
    });
  });

  test("a max-valid multiplier selects the bot", async () => {
    expect(await selectReviewBot(relayInput(world(BOT_MULTIPLIER_MAX)))).toEqual({
      kind: "selected",
      botId: APP_ID,
    });
  });
});
