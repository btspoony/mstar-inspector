/**
 * Unit tests: migration 0029 + the `support_grants` / `audit_events` store.
 *
 * The bun:sqlite double applies the REAL migration list (tests/store/helpers),
 * so the collation and the FK parents under test are the same DDL
 * `wrangler d1 migrations apply` produces. Cases pin the semantics the gate
 * (T2) maps to status codes:
 *   - a live grant validates, case-insensitively, including a longer window
 *     behind a lapsed one;
 *   - an expired grant is exactly like no grant;
 *   - a grant on W1 answers false on W2 (the lookup is workspace-keyed);
 *   - the notice read lists only unexpired rows of that one workspace;
 *   - audit inserts come back newest first, bounded by `limit`;
 *   - the module exports no update/delete path at all (append-only).
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import * as operatorStore from "../../src/dashboard/operator-store";
import {
  hasValidGrant,
  insertAuditEvent,
  insertSupportGrant,
  listActiveSupportGrants,
  listAuditEvents,
} from "../../src/dashboard/operator-store";

const W1 = "default";
const W2 = "other-workspace";
const OPERATOR = "Support-Bot";
const NOW = "2026-10-22T00:00:00.000Z";
const LATER = "2026-10-29T00:00:00.000Z";
const PAST = "2026-10-21T00:00:00.000Z";

/** The migrated DB plus a second workspace (0026 seeds only `default`). */
function createFixture(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
       VALUES (?, ?, ?, NULL, ?, NULL)`,
    )
    .run(W2, W2, "Other", NOW);
  return db;
}

function grant(db: TestD1, workspaceId: string, expiresAt: string, login = OPERATOR): Promise<unknown> {
  return insertSupportGrant(db, {
    workspaceId,
    operatorLogin: login,
    reason: "investigating webhook delivery",
    grantedBy: "deploy-operator",
    now: NOW,
    expiresAt,
  });
}

describe("migration 0029 DDL", () => {
  test("a workspace holding grants and audit rows cannot be hard-deleted (NO ACTION, never cascade)", () => {
    const db = createFixture();
    db.raw.prepare("PRAGMA foreign_keys = ON").run();
    void grant(db, W1, LATER);
    void insertAuditEvent(db, {
      workspaceId: W1,
      actorLogin: OPERATOR,
      action: "support.read",
      now: NOW,
    });
    expect(() => db.raw.prepare("DELETE FROM workspaces WHERE id = ?").run(W1)).toThrow();
  });
});

describe("hasValidGrant", () => {
  test("a live grant validates, case-insensitively", async () => {
    const db = createFixture();
    await grant(db, W1, LATER);
    expect(await hasValidGrant(db, W1, OPERATOR, NOW)).toBe(true);
    expect(await hasValidGrant(db, W1, OPERATOR.toUpperCase(), NOW)).toBe(true);
    expect(await hasValidGrant(db, W1, OPERATOR.toLowerCase(), NOW)).toBe(true);
  });

  test("an expired grant answers false — expiry is read from expires_at, not flipped", async () => {
    const db = createFixture();
    await grant(db, W1, PAST);
    expect(await hasValidGrant(db, W1, OPERATOR, NOW)).toBe(false);
    // The row is still there: nothing deleted or rewrote it.
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM support_grants").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("a second grant outliving a lapsed one still validates", async () => {
    const db = createFixture();
    await grant(db, W1, PAST);
    await grant(db, W1, LATER);
    expect(await hasValidGrant(db, W1, OPERATOR, NOW)).toBe(true);
  });

  test("a grant on W1 grants nothing on W2", async () => {
    const db = createFixture();
    await grant(db, W1, LATER);
    expect(await hasValidGrant(db, W1, OPERATOR, NOW)).toBe(true);
    expect(await hasValidGrant(db, W2, OPERATOR, NOW)).toBe(false);
  });

  test("no grant at all, or a grant for another login, answers false", async () => {
    const db = createFixture();
    expect(await hasValidGrant(db, W1, OPERATOR, NOW)).toBe(false);
    await grant(db, W1, LATER, "someone-else");
    expect(await hasValidGrant(db, W1, OPERATOR, NOW)).toBe(false);
  });
});

describe("listActiveSupportGrants", () => {
  test("lists only unexpired rows of that workspace, longest-lived first", async () => {
    const db = createFixture();
    await grant(db, W1, PAST);
    await grant(db, W1, LATER, "second-bot");
    await grant(db, W2, LATER, "third-bot");

    const rows = await listActiveSupportGrants(db, W1, NOW);
    expect(rows.map((row) => row.operator_login)).toEqual(["second-bot"]);
    expect(rows[0]?.expires_at).toBe(LATER);
    expect(rows[0]?.reason).toBe("investigating webhook delivery");
    expect(rows[0]?.granted_by).toBe("deploy-operator");
    expect((await listActiveSupportGrants(db, W2, NOW)).map((row) => row.operator_login)).toEqual([
      "third-bot",
    ]);
  });

  test("the notice is gone once the window closes", async () => {
    const db = createFixture();
    await grant(db, W1, LATER);
    expect(await listActiveSupportGrants(db, W1, NOW)).toHaveLength(1);
    expect(await listActiveSupportGrants(db, W1, LATER)).toHaveLength(0);
  });
});

describe("audit events", () => {
  test("newest first, workspace-scoped, bounded by limit", async () => {
    const db = createFixture();
    await insertAuditEvent(db, {
      workspaceId: W1,
      actorLogin: "Support-Bot",
      action: "support.read",
      now: "2026-10-22T00:00:01.000Z",
    });
    await insertAuditEvent(db, {
      workspaceId: W1,
      actorLogin: "Support-Bot",
      action: "support.forbidden",
      now: "2026-10-22T00:00:02.000Z",
    });
    await insertAuditEvent(db, {
      workspaceId: W1,
      actorLogin: "unknown-bot",
      action: "support.denied",
      now: "2026-10-22T00:00:03.000Z",
    });
    await insertAuditEvent(db, {
      workspaceId: W2,
      actorLogin: "Support-Bot",
      action: "support.read",
      now: "2026-10-22T00:00:04.000Z",
    });

    const rows = await listAuditEvents(db, W1, 10);
    expect(rows.map((row) => row.action)).toEqual([
      "support.denied",
      "support.forbidden",
      "support.read",
    ]);
    expect(rows.map((row) => row.actor_login)).toEqual(["unknown-bot", "Support-Bot", "Support-Bot"]);
    expect(rows.every((row) => row.workspace_id === W1)).toBe(true);

    // The bound is the read's, not the table's: older rows stay stored.
    expect((await listAuditEvents(db, W1, 1)).map((row) => row.action)).toEqual(["support.denied"]);
    expect((await listAuditEvents(db, W2, 10)).map((row) => row.action)).toEqual(["support.read"]);
  });
});

describe("append-only store shape", () => {
  test("the module exports exactly five functions — no update or delete path", () => {
    const exported = Object.keys(operatorStore).sort();
    expect(exported).toEqual([
      "hasValidGrant",
      "insertAuditEvent",
      "insertSupportGrant",
      "listActiveSupportGrants",
      "listAuditEvents",
    ]);
    expect(exported.filter((name) => /update|delete|remove|revoke/i.test(name))).toEqual([]);
  });
});
