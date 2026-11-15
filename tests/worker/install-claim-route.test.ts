/**
 * `POST /dashboard/:workspaceRef/api/apps/:appId/claim` — the claim entry the
 * target page's install action calls (contract § 8.5).
 *
 * Pinned here:
 *   - a shared bot with a synced slug answers the claim id, its expiry and the
 *     installation URL, and writes ONE live claim for the addressed target;
 *   - a second press refreshes that claim instead of stacking;
 *   - an owned bot is "nothing here" rather than "forbidden" (404
 *     `bot is not shared`), and a never-synced slug is 409
 *     `bot has no installation url` with nothing written;
 *   - a foreign or unknown App id is the same 404 as an unknown bot, and a
 *     non-manager is refused before any claim exists.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedDefaultMemberships, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const APP_ID = 9201;

function makeEnv(db: unknown): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
  } as Env;
}

/** The 200 face's three fields, read out of an untyped body. */
type ClaimAnswer = { claimId: string; expiresAt: string; installationUrl: string };

function claimAnswerOf(body: unknown): ClaimAnswer {
  if (body === null || typeof body !== "object") throw new Error("claim answer is not an object");
  if (!("claimId" in body) || !("expiresAt" in body) || !("installationUrl" in body)) {
    throw new Error("claim answer is missing a field");
  }
  const { claimId, expiresAt, installationUrl } = body;
  if (
    typeof claimId !== "string" ||
    typeof expiresAt !== "string" ||
    typeof installationUrl !== "string"
  ) {
    throw new Error("claim answer carries a non-string field");
  }
  return { claimId, expiresAt, installationUrl };
}

type World = { db: TestD1; botId: string; targetId: string };

/** One bot in the `default` workspace with its target, scope and slug as asked. */
async function seededWorld(opts: {
  scope?: "owned" | "shared";
  slug?: string | null;
  githubAppId?: number;
}): Promise<World> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "trudy", role: "member" });
  seedDefaultMemberships(db, { mallory: "owner", trudy: "member" });
  const botId = "bot-claim-route";
  await createReviewBotsStore(db).createApp({
    id: botId,
    githubAppId: opts.githubAppId ?? APP_ID,
    githubSlug: opts.slug === undefined ? "shared-bot" : opts.slug,
    name: botId,
    privateKeyEnc: "enc",
    webhookSecretEnc: "enc",
    createdBy: "mallory",
    workspaceId: "default",
  });
  db.raw.prepare("UPDATE review_bots SET scope = ? WHERE id = ?").run(opts.scope ?? "shared", botId);
  const targetRow = db.raw.query("SELECT id FROM review_targets WHERE bot_id = ?").get(botId);
  if (targetRow === null || typeof targetRow !== "object" || !("id" in targetRow) || typeof targetRow.id !== "string") {
    throw new Error(`createApp wrote no target for ${botId}`);
  }
  return { db, botId, targetId: targetRow.id };
}

async function postClaim(db: TestD1, login: string, appId = String(APP_ID)): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/default/api/apps/${appId}/claim`, {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
    }),
    makeEnv(db),
  );
}

function claimCount(db: TestD1): number {
  const row = db.raw.query("SELECT COUNT(*) AS n FROM install_claims").get();
  if (row === null || typeof row !== "object" || !("n" in row) || typeof row.n !== "number") {
    throw new Error("SELECT COUNT(*) on install_claims returned no count");
  }
  return row.n;
}

describe("POST /dashboard/:workspaceRef/api/apps/:appId/claim", () => {
  test("a shared bot answers the claim id, its expiry and the installation URL", async () => {
    const { db, targetId } = await seededWorld({});
    const res = await postClaim(db, "mallory");

    expect(res.status).toBe(200);
    const body = claimAnswerOf(await res.json());
    expect(Object.keys(body).sort()).toEqual(["claimId", "expiresAt", "installationUrl"]);
    expect(body.installationUrl).toBe("https://github.com/apps/shared-bot/installations/new");
    // No `state`: GitHub preserves none, so the claim row is the only carrier.
    expect(body.installationUrl).not.toContain("state");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const claim = db.raw
      .query("SELECT target_id, workspace_id, consumed_at FROM install_claims WHERE id = ?")
      .get(body.claimId);
    expect(claim).toEqual({ target_id: targetId, workspace_id: "default", consumed_at: null });
  });

  test("a second press refreshes the same live claim instead of stacking", async () => {
    const { db } = await seededWorld({});
    const first = claimAnswerOf(await (await postClaim(db, "mallory")).json());
    const second = claimAnswerOf(await (await postClaim(db, "mallory")).json());

    expect(second.claimId).toBe(first.claimId);
    expect(claimCount(db)).toBe(1);
  });

  test("an owned bot answers 404 bot is not shared and writes nothing", async () => {
    const { db } = await seededWorld({ scope: "owned" });
    const res = await postClaim(db, "mallory");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "bot is not shared" });
    expect(claimCount(db)).toBe(0);
  });

  test("an unsynced slug answers 409 bot has no installation url and writes nothing", async () => {
    const { db } = await seededWorld({ slug: null });
    const res = await postClaim(db, "mallory");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bot has no installation url" });
    expect(claimCount(db)).toBe(0);
  });

  test("a target that already holds a binding answers 409 target already bound and mints no claim", async () => {
    const { db, targetId } = await seededWorld({});
    db.raw
      .prepare("UPDATE review_targets SET installation_id = 4242, account_login = 'acme' WHERE id = ?")
      .run(targetId);

    const res = await postClaim(db, "mallory");

    // The bind batch refuses a different installation, so a claim here would
    // only send the user to GitHub to fail. The operator's unbind is the
    // repair path that makes this action available again.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "target already bound" });
    expect(claimCount(db)).toBe(0);
  });

  test("an unknown or non-numeric App id is the same 404 as an unknown bot", async () => {
    const { db } = await seededWorld({});
    for (const appId of ["999999", "not-a-number"]) {
      const res = await postClaim(db, "mallory", appId);
      expect(res.status, appId).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown app" });
    }
    expect(claimCount(db)).toBe(0);
  });

  test("a plain member is refused before any claim exists", async () => {
    const { db } = await seededWorld({});
    const res = await postClaim(db, "trudy");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(claimCount(db)).toBe(0);
  });
});

/**
 * `POST /dashboard/:workspaceRef/api/apps/:appId/bind-installation` — the
 * target page's second bind entry point. It composes the claim store's
 * create-then-consume call, so the ONLY writer of
 * `review_targets.installation_id` stays the setup callback's batch: the
 * unique index, the one-target-per-installation rule and the shared-bot guard
 * all still speak here.
 *
 * Pinned: one pending installation of the bot binds (and the claim it created
 * is consumed); an id the pending read does not answer is 404 with nothing
 * written; a bound target keeps its existing 409 vocabulary; a non-manager and
 * an unshared bot are refused before any write.
 */
describe("POST /dashboard/:workspaceRef/api/apps/:appId/bind-installation", () => {
  /** One live installation of the world's bot, optionally already removed. */
  function seedInstallation(db: TestD1, botId: string, installationId: number, removed = false): void {
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES (?, ?, ?, 'acme', '2026-01-01T00:00:00.000Z', ${removed ? "datetime('now')" : "NULL"})`,
      )
      .run(crypto.randomUUID(), botId, installationId);
  }

  async function postBind(
    db: TestD1,
    login: string,
    fields: Record<string, string>,
    appId = String(APP_ID),
  ): Promise<Response> {
    return worker.fetch(
      new Request(`https://worker.local/dashboard/default/api/apps/${appId}/bind-installation`, {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields),
      }),
      makeEnv(db),
    );
  }

  function targetBinding(db: TestD1, targetId: string): number | null {
    const row = db.raw
      .query("SELECT installation_id FROM review_targets WHERE id = ?")
      .get(targetId) as { installation_id: number | null } | null;
    return row?.installation_id ?? null;
  }

  test("binds one pending installation to the workspace's target in one action", async () => {
    const { db, botId, targetId } = await seededWorld({});
    seedInstallation(db, botId, 4321);

    const res = await postBind(db, "mallory", { installationId: "4321" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ targetId });
    expect(targetBinding(db, targetId)).toBe(4321);
    // The composed claim was consumed by the same call; the installation row
    // the batch upserted is the bot's live one.
    expect(claimCount(db)).toBe(1);
    const installation = db.raw
      .query("SELECT removed_at FROM bot_installations WHERE bot_id = ? AND installation_id = 4321")
      .get(botId) as { removed_at: string | null } | null;
    expect(installation).toEqual({ removed_at: null });
  });

  test("an installation the pending read does not answer is 404 and writes nothing", async () => {
    const { db, botId, targetId } = await seededWorld({});
    seedInstallation(db, botId, 1111);
    // Removed, and never seen at all: neither is the route's to bind.
    seedInstallation(db, botId, 2222, true);
    // 1111 is held by ANOTHER workspace's target: cross-workspace
    // installations are never listed, so it is not this target's to bind.
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('ws-other', 'ws-other', 'ws-other', NULL, datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, installation_id, created_by, created_at, updated_at)
         VALUES ('target-elsewhere', 'ws-other', ?, 'elsewhere', 1111, 'fixture', datetime('now'), datetime('now'))`,
      )
      .run(botId);

    for (const installationId of ["1111", "2222", "3333"]) {
      const res = await postBind(db, "mallory", { installationId });
      expect(res.status, installationId).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown installation" });
    }
    expect(claimCount(db)).toBe(0);
    expect(targetBinding(db, targetId)).toBeNull();
  });

  test("a malformed installation id is a 400 and writes nothing", async () => {
    const { db } = await seededWorld({});
    const malformed: Array<Record<string, string>> = [
      {},
      { installationId: "abc" },
      { installationId: "0" },
      { installationId: "-1" },
    ];
    for (const fields of malformed) {
      const res = await postBind(db, "mallory", fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
    }
    expect(claimCount(db)).toBe(0);
  });

  test("a target that already holds a binding keeps 409 target already bound", async () => {
    const { db, botId, targetId } = await seededWorld({});
    seedInstallation(db, botId, 4321);
    db.raw.prepare("UPDATE review_targets SET installation_id = 9999 WHERE id = ?").run(targetId);

    const res = await postBind(db, "mallory", { installationId: "4321" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "target already bound" });
    expect(claimCount(db)).toBe(0);
    expect(targetBinding(db, targetId)).toBe(9999);
  });

  test("an owned bot answers 404 bot is not shared and writes nothing", async () => {
    const { db, botId } = await seededWorld({ scope: "owned" });
    seedInstallation(db, botId, 4321);

    const res = await postBind(db, "mallory", { installationId: "4321" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "bot is not shared" });
    expect(claimCount(db)).toBe(0);
  });

  test("a plain member is refused before any claim exists", async () => {
    const { db, botId, targetId } = await seededWorld({});
    seedInstallation(db, botId, 4321);

    const res = await postBind(db, "trudy", { installationId: "4321" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(claimCount(db)).toBe(0);
    expect(targetBinding(db, targetId)).toBeNull();
  });

  test("an unknown or non-numeric App id stays the same 404", async () => {
    const { db } = await seededWorld({});
    for (const appId of ["999999", "not-a-number"]) {
      const res = await postBind(db, "mallory", { installationId: "4321" }, appId);
      expect(res.status, appId).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown app" });
    }
    expect(claimCount(db)).toBe(0);
  });
});
