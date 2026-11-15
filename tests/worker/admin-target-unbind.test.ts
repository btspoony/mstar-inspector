/**
 * The console's installation-unbind route (the repair path for a wrong bind).
 *
 * A binding is written by the claim batch and refused to every later
 * installation while it exists, so a wrong one is a dead end for the workspace:
 * the claim is consumed, and no member-facing route can clear the column. The
 * operator gets exactly that one write.
 *
 * Pinned here:
 *   - a non-operator sees the framework 404 with an empty body and changes no
 *     row; a self-hosted worker does not register the route at all;
 *   - an unknown or soft-deleted target is `404 target not found`;
 *   - a bound target answers `200 {targetId, unbound: true}` and both
 *     `installation_id` and `account_login` are cleared, while the
 *     `bot_installations` row the binding referenced is left alone (the bot
 *     still has that installation; it is only no target's binding);
 *   - a second call is idempotent (`unbound: false`), matching the store's
 *     `not_bound` outcome rather than reporting an error.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";

const SESSION_SECRET = ["test", "unbind", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const MEMBER = "regular-member";

function insertUser(db: TestD1, login: string): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), login, new Date().toISOString());
}

function envFor(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: "saas",
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: db,
    ...overrides,
  } as unknown as Env;
}

/** One bot, its workspace mapping, one target (bound unless asked otherwise) and the installation row. */
function seededTarget(
  db: TestD1,
  options: { bound?: boolean; deleted?: boolean } = {},
): { targetId: string } {
  const botId = "bot-unbind";
  const targetId = "target-unbind";
  const installationId = 4242;
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, created_at, updated_at)
       VALUES (?, 9501, ?, 'enc', 'enc', 'acme', 'active',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(botId, botId);
  db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, 'default')").run(botId);
  db.raw
    .prepare(
      `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
       VALUES ('install-unbind', ?, ?, 'acme', '2026-01-01T00:00:00.000Z')`,
    )
    .run(botId, installationId);
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, installation_id, account_login, created_by,
          created_at, updated_at, deleted_at)
       VALUES (?, 'default', ?, ?, ?, ?, 'acme',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(
      targetId,
      botId,
      targetId,
      options.bound === false ? null : installationId,
      options.bound === false ? null : "acme",
      options.deleted === true ? "2026-02-01T00:00:00.000Z" : null,
    );
  return { targetId };
}

async function postUnbind(
  db: TestD1,
  login: string,
  targetId: string,
  env: Env = envFor(db),
): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin/api/targets/${targetId}/unbind`, {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
      },
    }),
    env,
  );
}

/**
 * The framework's unknown-path answer, for the same method and caller. The
 * admin namespace must not distinguish its refusals from a path that does not
 * exist, so each non-operator case is compared against this.
 */
async function unknownPath(db: TestD1, login: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  return worker.fetch(
    new Request("https://worker.local/_internal_admin/api/not-a-route", { method: "POST", headers }),
    envFor(db),
  );
}

type Audit = {
  action: string;
  actor_login: string;
  target_type: string;
  target_id: string;
  detail: unknown;
};

/** The platform ledger, in write order — one row per accepted write. */
function auditRows(db: TestD1): Audit[] {
  return (
    db.raw
      .prepare(
        `SELECT action, actor_login, target_type, target_id, detail_json
           FROM platform_audit_events ORDER BY rowid`,
      )
      .all() as Array<{
      action: string;
      actor_login: string;
      target_type: string;
      target_id: string;
      detail_json: string | null;
    }>
  ).map((row) => ({
    action: row.action,
    actor_login: row.actor_login,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: JSON.parse(row.detail_json ?? "null"),
  }));
}

function binding(db: TestD1, targetId: string): { installation_id: number | null; account_login: string | null } {
  const row = db.raw
    .query("SELECT installation_id, account_login FROM review_targets WHERE id = ?")
    .get(targetId) as { installation_id: number | null; account_login: string | null } | null;
  if (row === null) throw new Error(`review target ${targetId} is missing`);
  return row;
}

function installationRow(db: TestD1): { account_login: string | null; removed_at: string | null } | null {
  return db.raw
    .query("SELECT account_login, removed_at FROM bot_installations WHERE installation_id = 4242")
    .get() as { account_login: string | null; removed_at: string | null } | null;
}

describe("POST /_internal_admin/api/targets/:targetId/unbind", () => {
  test("a non-operator sees the framework 404 and the binding survives", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    const { targetId } = seededTarget(db);

    const res = await postUnbind(db, MEMBER, targetId);
    const unknown = await unknownPath(db, MEMBER);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await unknown.text());
    expect(binding(db, targetId)).toEqual({ installation_id: 4242, account_login: "acme" });
  });

  test("a self-hosted worker does not register the route", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const { targetId } = seededTarget(db);

    const res = await postUnbind(db, OPERATOR, targetId, envFor(db, { DEPLOYMENT_MODE: "self-hosted" }));

    expect(res.status).toBe(404);
    expect(binding(db, targetId)).toEqual({ installation_id: 4242, account_login: "acme" });
  });

  test("an unknown or soft-deleted target answers 404 target not found", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const { targetId } = seededTarget(db, { deleted: true });

    const unknown = await postUnbind(db, OPERATOR, "no-such-target");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "target not found" });

    const deleted = await postUnbind(db, OPERATOR, targetId);
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual({ error: "target not found" });
    // Nothing was written for either refusal: the binding and the ledger agree.
    expect(binding(db, targetId)).toEqual({ installation_id: 4242, account_login: "acme" });
    expect(auditRows(db)).toEqual([]);
  });

  test("an operator clears the binding and the copied login, leaving the installation row", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const { targetId } = seededTarget(db);

    const res = await postUnbind(db, OPERATOR, targetId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ targetId, unbound: true });
    expect(binding(db, targetId)).toEqual({ installation_id: null, account_login: null });
    // The bot still has that installation; it is only no target's binding, so
    // a later claim of the same installation needs no webhook replay.
    expect(installationRow(db)).toEqual({ account_login: "acme", removed_at: null });
    // The repair audits in lockstep with the clear: the cleared binding is the
    // evidence, and it names the operator who removed it.
    expect(auditRows(db)).toEqual([
      {
        action: "bot.target_unbind",
        actor_login: OPERATOR,
        target_type: "target",
        target_id: targetId,
        detail: { before: { installation_id: 4242, account_login: "acme" }, after: null },
      },
    ]);
  });

  test("a second repair is idempotent and reports unbound: false", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const { targetId } = seededTarget(db);

    expect((await postUnbind(db, OPERATOR, targetId)).status).toBe(200);
    const again = await postUnbind(db, OPERATOR, targetId);

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ targetId, unbound: false });
    expect(binding(db, targetId)).toEqual({ installation_id: null, account_login: null });
    // A repair that changed nothing appends nothing: the ledger keeps exactly
    // the one row the accepted clear wrote.
    expect(auditRows(db)).toHaveLength(1);
  });

  test("a target that never held a binding answers unbound: false", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const { targetId } = seededTarget(db, { bound: false });

    const res = await postUnbind(db, OPERATOR, targetId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ targetId, unbound: false });
    expect(auditRows(db)).toEqual([]);
  });
});
