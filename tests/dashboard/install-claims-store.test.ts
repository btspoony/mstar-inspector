/**
 * Unit tests for `src/dashboard/install-claims-store.ts` — the short-lived
 * per-user installation claim and the ONE batch that binds it.
 *
 * Pinned here:
 *   - the TTL is built from the exported constant, and a lapsed claim is not
 *     live for either the read or the consume (no sweeper: lapsing is inert);
 *   - a second press refreshes the same live claim instead of stacking, so
 *     "N claims" always means N different targets;
 *   - the bind writes `bot_installations` + `review_targets` in one batch and
 *     consumes the claim with them;
 *   - a pre-existing `account_login` survives the upsert and `removed_at` is
 *     cleared (a reinstall is visible again);
 *   - a second consume, and a consume under another user's session, refuse
 *     without writing;
 *   - the refusals name their reason: a target bound to a different
 *     installation, a second target of the same installation, an unshared bot.
 *
 * The fixture is the fully migrated schema (tests/store/helpers), so the
 * assertions run against the real DDL.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import type { TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createUser } from "../../src/dashboard/users";
import {
  createInstallClaimsStore,
  INSTALL_CLAIM_TTL_MS,
  type InstallClaim,
  type InstallClaimsStore,
} from "../../src/dashboard/install-claims-store";

const WS = "default";
const NOW = "2026-03-01T12:00:00.000Z";

/** An instant `offsetMs` after `NOW` — the TTL arithmetic tests are built on. */
function at(offsetMs: number): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

type World = {
  db: TestD1;
  botId: string;
  targetId: string;
  /** The session user the claim belongs to. */
  userId: string;
  /** A second signed-in user — a claim must be invisible to them. */
  otherUserId: string;
  store: InstallClaimsStore;
};

/**
 * One live bot with one unbound target plus two users. `boundInstallation`
 * pre-binds the target (the "already bound elsewhere" fixture).
 */
async function seedWorld(
  opts: { scope?: "owned" | "shared"; botId?: string; boundInstallation?: number } = {},
): Promise<World> {
  const db = createMigratedTestD1();
  const botId = opts.botId ?? "bot-claims";
  await createReviewBotsStore(db).createApp({
    id: botId,
    githubAppId: 7001,
    githubSlug: "claims-bot",
    name: botId,
    privateKeyEnc: "enc",
    webhookSecretEnc: "enc",
    createdBy: "acme",
    workspaceId: WS,
  });
  // createApp mints the target's id; the claim names that row.
  const targetRow = db.raw.query("SELECT id FROM review_targets WHERE bot_id = ?").get(botId);
  if (targetRow === null || typeof targetRow !== "object" || !("id" in targetRow) || typeof targetRow.id !== "string") {
    throw new Error(`createApp wrote no target for ${botId}`);
  }
  const targetId = targetRow.id;
  db.raw.prepare("UPDATE review_bots SET scope = ? WHERE id = ?").run(opts.scope ?? "shared", botId);
  if (opts.boundInstallation !== undefined) {
    db.raw
      .prepare("UPDATE review_targets SET installation_id = ? WHERE id = ?")
      .run(opts.boundInstallation, targetId);
  }
  const userId = (await createUser(db, { login: "mallory", role: "member" })).id;
  const otherUserId = (await createUser(db, { login: "trudy", role: "member" })).id;
  return { db, botId, targetId, userId, otherUserId, store: createInstallClaimsStore(db) };
}

/** A second live target of the same bot — the "one installation, two targets" fixture. */
function addSecondTarget(db: TestD1, botId: string, targetId: string): string {
  db.raw
    .prepare(
      `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'acme', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(targetId, WS, botId, targetId);
  return targetId;
}

function claimRow(db: TestD1, claimId: string): { consumed_at: string | null; expires_at: string } | null {
  return db.raw
    .query("SELECT consumed_at, expires_at FROM install_claims WHERE id = ?")
    .get(claimId) as { consumed_at: string | null; expires_at: string } | null;
}

function count(db: TestD1, table: string): number {
  const row = db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get();
  if (row === null || typeof row !== "object" || !("n" in row) || typeof row.n !== "number") {
    throw new Error(`SELECT COUNT(*) on ${table} returned no count`);
  }
  return row.n;
}

function installationRow(
  db: TestD1,
  botId: string,
  installationId: number,
): { account_login: string | null; seen_at: string; removed_at: string | null } | null {
  return db.raw
    .query(
      `SELECT account_login, seen_at, removed_at FROM bot_installations
        WHERE bot_id = ? AND installation_id = ?`,
    )
    .get(botId, installationId) as {
    account_login: string | null;
    seen_at: string;
    removed_at: string | null;
  } | null;
}

function targetBinding(
  db: TestD1,
  targetId: string,
): { installation_id: number | null; account_login: string | null; updated_at: string } {
  const row = db.raw
    .query("SELECT installation_id, account_login, updated_at FROM review_targets WHERE id = ?")
    .get(targetId) as {
    installation_id: number | null;
    account_login: string | null;
    updated_at: string;
  } | null;
  if (row === null) throw new Error(`review target ${targetId} is missing`);
  return row;
}

describe("claim lifecycle and TTL", () => {
  test("INSTALL_CLAIM_TTL_MS is the contract's fifteen minutes", () => {
    expect(INSTALL_CLAIM_TTL_MS).toBe(15 * 60 * 1000);
  });

  test("a claim lives until expires_at and a lapsed one is inert for read and consume", async () => {
    const { db, userId, targetId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });

    expect(claim.expiresAt).toBe(at(INSTALL_CLAIM_TTL_MS));
    expect(claimRow(db, claim.id)?.expires_at).toBe(at(INSTALL_CLAIM_TTL_MS));

    // Live strictly inside the window...
    expect((await store.listLiveClaims(userId, at(INSTALL_CLAIM_TTL_MS - 1))).map((row) => row.id)).toEqual([
      claim.id,
    ]);
    // ...and the boundary itself is already expired (expires_at > now).
    expect(await store.listLiveClaims(userId, claim.expiresAt)).toEqual([]);

    const outcome = await store.consumeAndBind({
      claimId: claim.id,
      userId,
      installationId: 4242,
      now: claim.expiresAt,
    });
    expect(outcome).toEqual({ outcome: "claim_not_found" });
    // Nothing was written by the refused consume.
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(count(db, "bot_installations")).toBe(0);
    expect(targetBinding(db, targetId).installation_id).toBeNull();
  });

  test("a second press refreshes the same live claim instead of stacking", async () => {
    const { db, userId, targetId, store } = await seedWorld();
    const first = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
    const second = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      targetId,
      now: at(60_000),
    });

    expect(second.id).toBe(first.id);
    expect(second.expiresAt).toBe(at(60_000 + INSTALL_CLAIM_TTL_MS));
    expect(count(db, "install_claims")).toBe(1);
    // The refreshed row carries the later instants, not the first press's.
    expect(claimRow(db, first.id)?.expires_at).toBe(at(60_000 + INSTALL_CLAIM_TTL_MS));
  });

  test("listLiveClaims answers only this user's live rows, ordered by created_at then id", async () => {
    const { db, botId, userId, otherUserId, targetId, store } = await seedWorld();
    const secondTarget = addSecondTarget(db, botId, "bot-claims-second-target");

    const first = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
    const second = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      targetId: secondTarget,
      now: at(1_000),
    });
    await store.createOrRefreshClaim({ userId: otherUserId, workspaceId: WS, targetId, now: at(2_000) });

    const live = await store.listLiveClaims(userId, NOW);
    expect(live.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(live.map((row) => row.target_id)).toEqual([targetId, secondTarget]);
    expect(live.every((row) => row.workspace_id === WS)).toBe(true);
    // The other user's claim is not this session's.
    expect((await store.listLiveClaims(userId, NOW)).some((row) => row.workspace_id !== WS)).toBe(false);
  });
});

describe("consumeAndBind (the one batch)", () => {
  test("binding writes bot_installations and review_targets together and consumes the claim", async () => {
    const { db, botId, userId, targetId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });

    const outcome = await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW });

    expect(outcome).toEqual({ outcome: "bound", targetId });
    expect(claimRow(db, claim.id)?.consumed_at).toBe(NOW);
    expect(installationRow(db, botId, 4242)).toEqual({
      account_login: null,
      seen_at: NOW,
      removed_at: null,
    });
    // The bind is a user action: the target's operator timestamp moves with it.
    expect(targetBinding(db, targetId)).toEqual({
      installation_id: 4242,
      account_login: null,
      updated_at: NOW,
    });
  });

  test("a stored account_login survives the upsert, removed_at clears and the target copies it", async () => {
    const { db, botId, userId, targetId, store } = await seedWorld();
    // The webhook got there first: it knows the account and once saw the
    // installation removed.
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('install-1', ?, 4242, 'acme', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`,
      )
      .run(botId);
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
    ).toEqual({ outcome: "bound", targetId });

    // The claim path never invents a login (the redirect carries none), so the
    // webhook's value stands; the reinstall makes the row visible again.
    expect(installationRow(db, botId, 4242)).toEqual({
      account_login: "acme",
      seen_at: NOW,
      removed_at: null,
    });
    expect(targetBinding(db, targetId)).toEqual({
      installation_id: 4242,
      account_login: "acme",
      updated_at: NOW,
    });
  });

  test("a second consume returns claim_not_found and writes nothing", async () => {
    const { db, userId, targetId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
    await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW });
    const installations = count(db, "bot_installations");

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: at(1_000) }),
    ).toEqual({ outcome: "claim_not_found" });
    expect(count(db, "bot_installations")).toBe(installations);
    expect(claimRow(db, claim.id)?.consumed_at).toBe(NOW);
    expect(targetBinding(db, targetId).updated_at).toBe(NOW);
  });

  test("another user's consume returns claim_not_found and leaves the claim live", async () => {
    const { db, userId, otherUserId, targetId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });

    expect(
      await store.consumeAndBind({
        claimId: claim.id,
        userId: otherUserId,
        installationId: 4242,
        now: NOW,
      }),
    ).toEqual({ outcome: "claim_not_found" });
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(count(db, "bot_installations")).toBe(0);
    expect(targetBinding(db, targetId).installation_id).toBeNull();
  });

  test("a target already bound to a different installation returns target_not_bindable", async () => {
    const { db, userId, targetId, store } = await seedWorld({ boundInstallation: 5555 });
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
    ).toEqual({ outcome: "target_not_bindable" });
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(targetBinding(db, targetId).installation_id).toBe(5555);
  });

  test("a second target of the same installation returns installation_already_bound with the claim live", async () => {
    const { db, botId, userId, targetId, store } = await seedWorld({ boundInstallation: 4242 });
    const secondTarget = addSecondTarget(db, botId, "bot-claims-second-target");
    const claim = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      targetId: secondTarget,
      now: NOW,
    });

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
    ).toEqual({ outcome: "installation_already_bound" });
    // The batch rolled back: no consumed claim, no rebinding.
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(targetBinding(db, targetId).installation_id).toBe(4242);
    expect(targetBinding(db, secondTarget).installation_id).toBeNull();
  });

  test("a bot that is not shared returns bot_not_shared", async () => {
    const { db, userId, targetId, store } = await seedWorld({ scope: "owned" });
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
    ).toEqual({ outcome: "bot_not_shared" });
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(count(db, "bot_installations")).toBe(0);
  });

  test("a soft-deleted target returns target_not_bindable", async () => {
    const { db, userId, targetId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
    db.raw.prepare("UPDATE review_targets SET deleted_at = ? WHERE id = ?").run(NOW, targetId);

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
    ).toEqual({ outcome: "target_not_bindable" });
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
  });
});

/** The row shape the read face returns — pinned so a column rename fails loudly. */
const LIVE_CLAIM_COLUMNS: Array<keyof InstallClaim> = ["id", "workspace_id", "target_id", "created_at"];

test("listLiveClaims returns exactly the live-claim columns", async () => {
  const { userId, targetId, store } = await seedWorld();
  await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
  const [row] = await store.listLiveClaims(userId, NOW);
  expect(Object.keys(row!).sort()).toEqual([...LIVE_CLAIM_COLUMNS].sort());
});

/**
 * Two batches in flight cannot share one connection here: the double brackets
 * each batch's transaction by hand, and nested `BEGIN`s are an error. This
 * wrapper queues them FIFO — one connection, one batch at a time — which is how
 * D1 serializes batches per database, so the concurrent calls below model two
 * requests instead of a harness artifact. Rollback stays the underlying
 * `db.batch` semantics; the wrapper adds no transaction control of its own.
 */
function serializedBatches(db: TestD1): TestD1 {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    ...db,
    batch(statements) {
      const run = tail.then(() => db.batch(statements));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * The consume's proof of ownership.
 *
 * Two callbacks can capture the same ISO `now` (same millisecond). The instant
 * therefore cannot authorize statements 2–3: if it did, the losing request
 * would still upsert `bot_installations` — and clear a `removed_at` stamp — and
 * only then report `claim_not_found`. The interleaving below is deterministic:
 * `Promise.all` lets both calls run their pre-read before either batch, which
 * is exactly the window the defect needs.
 */
describe("concurrent consumes of one claim", () => {
  /** Same returned row on both paths — the fixture only reads it back. */
  function botInstallations(db: TestD1): Array<{
    installation_id: number;
    account_login: string | null;
    seen_at: string;
    removed_at: string | null;
  }> {
    return db.raw
      .query(
        `SELECT installation_id, account_login, seen_at, removed_at FROM bot_installations
          ORDER BY installation_id`,
      )
      .all() as Array<{
      installation_id: number;
      account_login: string | null;
      seen_at: string;
      removed_at: string | null;
    }>;
  }

  test("the loser binds nothing when both requests share the instant and name different installations", async () => {
    const { db, botId, userId, targetId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
    const concurrent = createInstallClaimsStore(serializedBatches(db));

    // Both requests pass their pre-read before either batch runs; the batches
    // themselves serialize, the way D1 serializes them.
    const [winner, loser] = await Promise.all([
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 5555, now: NOW }),
    ]);

    expect(winner).toEqual({ outcome: "bound", targetId });
    expect(loser).toEqual({ outcome: "claim_not_found" });
    // The loser wrote no installation row of its own...
    expect(botInstallations(db)).toEqual([
      { installation_id: 4242, account_login: null, seen_at: NOW, removed_at: null },
    ]);
    expect(botInstallations(db).some((row) => row.installation_id === 5555)).toBe(false);
    expect(targetBinding(db, targetId).installation_id).toBe(4242);
    expect(installationRow(db, botId, 5555)).toBeNull();
  });

  test("the loser cannot revive a removed installation stamp under the shared instant", async () => {
    const { db, botId, userId, targetId, store } = await seedWorld();
    // The losing request's installation is already known and stamped removed;
    // its upsert would clear the stamp, which is the visible damage.
    await db
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('install-loser', ?, 5555, 'acme', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`,
      )
      .bind(botId)
      .run();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
    const concurrent = createInstallClaimsStore(serializedBatches(db));

    const [winner, loser] = await Promise.all([
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 5555, now: NOW }),
    ]);

    expect(winner).toEqual({ outcome: "bound", targetId });
    expect(loser).toEqual({ outcome: "claim_not_found" });
    // The removed row is exactly as it was: no `seen_at` touch, no cleared stamp.
    expect(installationRow(db, botId, 5555)).toEqual({
      account_login: "acme",
      seen_at: "2026-02-01T00:00:00.000Z",
      removed_at: "2026-02-02T00:00:00.000Z",
    });
    expect(targetBinding(db, targetId).installation_id).toBe(4242);
  });

  test("the loser binds nothing when both requests name the same installation", async () => {
    const { db, userId, targetId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, targetId, now: NOW });
    const concurrent = createInstallClaimsStore(serializedBatches(db));

    const [winner, loser] = await Promise.all([
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
    ]);

    expect(winner).toEqual({ outcome: "bound", targetId });
    expect(loser).toEqual({ outcome: "claim_not_found" });
    // One installation row, one binding: the duplicate request is harmless.
    expect(botInstallations(db)).toHaveLength(1);
    expect(targetBinding(db, targetId).installation_id).toBe(4242);
  });
});
