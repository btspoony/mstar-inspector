/**
 * Unit tests for `src/dashboard/install-claims-store.ts` — the short-lived
 * per-user installation claim and the ONE batch that records it.
 *
 * Pinned here (migration 0067 / D19 — a claim names an APP, never a target):
 *   - the TTL is built from the exported constant, and a lapsed claim is not
 *     live for either the read or the consume (no sweeper: lapsing is inert);
 *   - a second press refreshes the same live claim instead of stacking;
 *   - the bind writes `bot_installations` in the same batch that consumes the
 *     claim, and writes NOTHING to `review_targets` (which no longer has an
 *     installation column);
 *   - a pre-existing `account_login` survives the upsert and `removed_at` is
 *     cleared (a reinstall is visible again);
 *   - a second consume, and a consume under another user's session, refuse
 *     without writing;
 *   - the refusal names its reason: only an unshared / deleted bot can refuse
 *     a bot-level claim.
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
  /** The session user the claim belongs to. */
  userId: string;
  /** A second signed-in user — a claim must be invisible to them. */
  otherUserId: string;
  store: InstallClaimsStore;
};

/** One live bot plus two users. */
async function seedWorld(opts: { scope?: "owned" | "shared"; botId?: string } = {}): Promise<World> {
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
  db.raw.prepare("UPDATE review_bots SET scope = ? WHERE id = ?").run(opts.scope ?? "shared", botId);
  const userId = (await createUser(db, { login: "mallory", role: "member" })).id;
  const otherUserId = (await createUser(db, { login: "trudy", role: "member" })).id;
  return { db, botId, userId, otherUserId, store: createInstallClaimsStore(db) };
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

describe("claim lifecycle and TTL", () => {
  test("INSTALL_CLAIM_TTL_MS is the contract's fifteen minutes", () => {
    expect(INSTALL_CLAIM_TTL_MS).toBe(15 * 60 * 1000);
  });

  test("a claim lives until expires_at and a lapsed one is inert for read and consume", async () => {
    const { db, botId, userId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });

    expect(claim.expiresAt).toBe(at(INSTALL_CLAIM_TTL_MS));
    expect(claimRow(db, claim.id)?.expires_at).toBe(at(INSTALL_CLAIM_TTL_MS));

    // Live strictly inside the window...
    expect((await store.listLiveClaims(userId, at(INSTALL_CLAIM_TTL_MS - 1))).map((row) => row.id)).toEqual([
      claim.id,
    ]);
    // ...and the boundary itself is already expired (expires_at > now).
    expect(await store.listLiveClaims(userId, claim.expiresAt)).toEqual([]);

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: claim.expiresAt }),
    ).toEqual({ outcome: "claim_not_found" });
    // Nothing was written by the refused consume.
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(count(db, "bot_installations")).toBe(0);
  });

  test("a second press refreshes the same live claim instead of stacking", async () => {
    const { db, botId, userId, store } = await seedWorld();
    const first = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
    const second = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: at(60_000) });

    expect(second.id).toBe(first.id);
    expect(second.expiresAt).toBe(at(60_000 + INSTALL_CLAIM_TTL_MS));
    expect(count(db, "install_claims")).toBe(1);
    expect(claimRow(db, first.id)?.expires_at).toBe(at(60_000 + INSTALL_CLAIM_TTL_MS));
  });

  test("a re-claim from another workspace moves the live row's tenant", async () => {
    const { db, botId, userId, store } = await seedWorld();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'ws-other', 'acme', datetime('now'))`,
      )
      .run();
    const first = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });

    const second = await store.createOrRefreshClaim({ userId, workspaceId: "ws-other", botId, now: at(1_000) });

    // The same live row, now naming the workspace the user pressed install for.
    expect(second.id).toBe(first.id);
    expect(count(db, "install_claims")).toBe(1);
    expect(db.raw.query("SELECT workspace_id FROM install_claims WHERE id = ?").get(first.id)).toEqual({
      workspace_id: "ws-other",
    });
  });

  test("listLiveClaims answers only this user's live rows, naming the app", async () => {
    const { botId, userId, otherUserId, store } = await seedWorld();
    const first = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
    // The other user claims the SAME bot: the partial unique index is per
    // (user, bot), so both rows are live and only the user id separates them.
    const otherClaim = await store.createOrRefreshClaim({
      userId: otherUserId,
      workspaceId: WS,
      botId,
      now: at(2_000),
    });

    const live = await store.listLiveClaims(userId, NOW);
    expect(live.map((row) => row.id)).toEqual([first.id]);
    // The setup page shows the APP it installs, not a target.
    expect(live[0]).toMatchObject({ bot_id: botId, bot_name: botId, workspace_id: WS });
    expect(live.map((row) => row.id)).not.toContain(otherClaim.id);
    expect(await store.listLiveClaims(otherUserId, NOW)).toMatchObject([{ id: otherClaim.id }]);
  });
});

describe("consumeAndBind (the one batch)", () => {
  test("the bind writes bot_installations and consumes the claim, and touches no target", async () => {
    const { db, botId, userId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });

    const outcome = await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW });

    expect(outcome).toEqual({ outcome: "bound", botId });
    expect(claimRow(db, claim.id)?.consumed_at).toBe(NOW);
    expect(installationRow(db, botId, 4242)).toEqual({ account_login: null, seen_at: NOW, removed_at: null });
    // An installation belongs to the App: adding a repository later is a
    // separate, explicit action, so the claim writes no target at all.
    expect(count(db, "review_targets")).toBe(0);
  });

  test("a stored account_login survives the upsert and a removed stamp clears", async () => {
    const { db, botId, userId, store } = await seedWorld();
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('install-1', ?, 4242, 'acme', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`,
      )
      .run(botId);
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });

    expect(await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW })).toEqual({
      outcome: "bound",
      botId,
    });

    // The claim path never invents a login (the redirect carries none); the
    // reinstall makes the row visible again.
    expect(installationRow(db, botId, 4242)).toEqual({
      account_login: "acme",
      seen_at: NOW,
      removed_at: null,
    });
  });

  test("a second consume returns claim_not_found and writes nothing", async () => {
    const { db, userId, botId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
    await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW });
    const installations = count(db, "bot_installations");

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: at(1_000) }),
    ).toEqual({ outcome: "claim_not_found" });
    expect(count(db, "bot_installations")).toBe(installations);
    expect(claimRow(db, claim.id)?.consumed_at).toBe(NOW);
  });

  test("another user's consume returns claim_not_found and leaves the claim live", async () => {
    const { db, userId, otherUserId, botId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });

    expect(
      await store.consumeAndBind({ claimId: claim.id, userId: otherUserId, installationId: 4242, now: NOW }),
    ).toEqual({ outcome: "claim_not_found" });
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(count(db, "bot_installations")).toBe(0);
  });

  test("a bot that is not shared returns bot_not_shared", async () => {
    const { db, userId, botId, store } = await seedWorld({ scope: "owned" });
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });

    expect(await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW })).toEqual({
      outcome: "bot_not_shared",
    });
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(count(db, "bot_installations")).toBe(0);
  });

  test("a soft-deleted bot returns bot_not_shared", async () => {
    const { db, userId, botId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
    db.raw.prepare("UPDATE review_bots SET deleted_at = ? WHERE id = ?").run(NOW, botId);

    expect(await store.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW })).toEqual({
      outcome: "bot_not_shared",
    });
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
  });
});

/** The row shape the read face returns — pinned so a column rename fails loudly. */
const LIVE_CLAIM_COLUMNS: Array<keyof InstallClaim> = [
  "id",
  "workspace_id",
  "bot_id",
  "bot_name",
  "created_at",
];

test("listLiveClaims returns exactly the live-claim columns", async () => {
  const { userId, botId, store } = await seedWorld();
  await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
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
 * therefore cannot authorize statement 2: if it did, the losing request would
 * still upsert `bot_installations` — and clear a `removed_at` stamp — and only
 * then report `claim_not_found`. The interleaving below is deterministic:
 * `Promise.all` lets both calls run their pre-read before either batch, which
 * is exactly the window the defect needs.
 */
describe("concurrent consumes of one claim", () => {
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
    const { db, botId, userId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
    const concurrent = createInstallClaimsStore(serializedBatches(db));

    const [winner, loser] = await Promise.all([
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 5555, now: NOW }),
    ]);

    expect(winner).toEqual({ outcome: "bound", botId });
    expect(loser).toEqual({ outcome: "claim_not_found" });
    expect(botInstallations(db)).toEqual([
      { installation_id: 4242, account_login: null, seen_at: NOW, removed_at: null },
    ]);
    expect(installationRow(db, botId, 5555)).toBeNull();
  });

  test("the loser cannot revive a removed installation stamp under the shared instant", async () => {
    const { db, botId, userId, store } = await seedWorld();
    // The losing request's installation is already known and stamped removed;
    // its upsert would clear the stamp, which is the visible damage.
    await db
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('install-loser', ?, 5555, 'acme', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`,
      )
      .bind(botId)
      .run();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
    const concurrent = createInstallClaimsStore(serializedBatches(db));

    const [winner, loser] = await Promise.all([
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 5555, now: NOW }),
    ]);

    expect(winner).toEqual({ outcome: "bound", botId });
    expect(loser).toEqual({ outcome: "claim_not_found" });
    // The removed row is exactly as it was: no `seen_at` touch, no cleared stamp.
    expect(installationRow(db, botId, 5555)).toEqual({
      account_login: "acme",
      seen_at: "2026-02-01T00:00:00.000Z",
      removed_at: "2026-02-02T00:00:00.000Z",
    });
    expect(botInstallations(db).find((row) => row.installation_id === 4242)?.removed_at).toBeNull();
  });

  test("the loser binds nothing when both requests name the same installation", async () => {
    const { db, userId, botId, store } = await seedWorld();
    const claim = await store.createOrRefreshClaim({ userId, workspaceId: WS, botId, now: NOW });
    const concurrent = createInstallClaimsStore(serializedBatches(db));

    const [winner, loser] = await Promise.all([
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
      concurrent.consumeAndBind({ claimId: claim.id, userId, installationId: 4242, now: NOW }),
    ]);

    expect(winner).toEqual({ outcome: "bound", botId });
    expect(loser).toEqual({ outcome: "claim_not_found" });
    // One installation row: the duplicate request is harmless.
    expect(botInstallations(db)).toHaveLength(1);
  });
});
