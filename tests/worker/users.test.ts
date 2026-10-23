/**
 * Sign-in decision (`src/dashboard/users.ts`).
 *
 * Sign-in is the only thing a `users` row depends on: there is no deployment
 * allowlist, so any GitHub login is admitted, and admission joins nobody to a
 * workspace. A recorded removal is the ONE refusal, and it is enforced at the
 * write boundary so an in-flight sign-in cannot resurrect a removed login.
 */
import { describe, expect, test } from "bun:test";
import {
  createUser,
  deleteUser,
  getUserByLogin,
  isLoginRemoved,
  signInDashboardUser,
} from "../../src/dashboard/users";
import { createWorkspace } from "../../src/dashboard/workspace-store";
import { createInvite } from "../../src/dashboard/invite-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

/** bun:sqlite's `.get()` is untyped — name the row shape once per query. */
type CountRow = { n: number };

function count(db: TestD1, table: "users" | "workspace_members"): number {
  const row = db.raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as CountRow;
  return row.n;
}

function userRows(db: TestD1): number {
  return count(db, "users");
}

function membershipRows(db: TestD1): number {
  return count(db, "workspace_members");
}

describe("signInDashboardUser", () => {
  test("an empty users table admits any login and creates a member row (no allowlist)", async () => {
    const db = createMigratedTestD1();
    expect(userRows(db)).toBe(0);

    const decision = await signInDashboardUser(db, "octocat");

    expect(decision.outcome).toBe("allow");
    if (decision.outcome === "allow") {
      expect(decision.created).toBe(true);
      expect(decision.user.role).toBe("member");
    }
    expect((await getUserByLogin(db, "octocat"))?.role).toBe("member");
    // Sign-in joins nobody: membership comes from workspace creation or an
    // accepted invite, so this row exists with no workspace at all.
    expect(membershipRows(db)).toBe(0);
  });

  test("a second login is admitted too — a populated table is not a gate", async () => {
    const db = createMigratedTestD1();
    await signInDashboardUser(db, "octocat");
    const decision = await signInDashboardUser(db, "hubot");
    expect(decision.outcome).toBe("allow");
    expect(userRows(db)).toBe(2);
  });

  test("an existing row is reused (no second row, no promotion)", async () => {
    const db = createMigratedTestD1();
    const existing = await createUser(db, { login: "octocat", role: "admin" });
    const decision = await signInDashboardUser(db, "OCTOCAT");
    expect(decision).toEqual({ outcome: "allow", user: existing, created: false });
    expect(userRows(db)).toBe(1);
  });

  test("a removal record still denies, case-insensitively, with zero writes", async () => {
    const db = createMigratedTestD1();
    const removed = await createUser(db, { login: "mallory", role: "member" });
    expect(await deleteUser(db, removed.id, "octocat")).toBe(true);
    expect(await signInDashboardUser(db, "mallory")).toEqual({ outcome: "deny" });
    expect(await signInDashboardUser(db, "MALLORY")).toEqual({ outcome: "deny" });
    expect(await getUserByLogin(db, "mallory")).toBeNull();
    expect(userRows(db)).toBe(0);
    expect(await isLoginRemoved(db, "mallory")).toBe(true);
  });

  test("operator removal deletes an invite author: the invite survives with invited_by NULL", async () => {
    const db = createMigratedTestD1();
    const inviter = await createUser(db, { login: "mallory", role: "admin" });
    const invite = await createInvite(db, {
      workspaceId: "default",
      login: "hubot",
      role: "member",
      invitedBy: inviter.id,
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // The operator path is a hard DELETE of the users row; a NOT NULL
    // invited_by would fail the FK here and 500 the operator action.
    expect(await deleteUser(db, inviter.id, "octocat")).toBe(true);
    expect(await getUserByLogin(db, "mallory")).toBeNull();
    expect(await isLoginRemoved(db, "mallory")).toBe(true);
    // The invite outlives its author as anonymous history.
    expect(
      db.raw.query("SELECT invited_by, status FROM workspace_invites WHERE id = ?").get(invite.id),
    ).toEqual({ invited_by: null, status: "pending" });
  });

  test("a deliberate re-admission clears the record and the login signs in again", async () => {
    const db = createMigratedTestD1();
    const removed = await createUser(db, { login: "mallory", role: "member" });
    await deleteUser(db, removed.id, "octocat");
    expect(await signInDashboardUser(db, "mallory")).toEqual({ outcome: "deny" });

    const readmitted = await createUser(db, { login: "mallory", role: "member", invitedBy: "octocat" });

    expect(await isLoginRemoved(db, "mallory")).toBe(false);
    expect(await signInDashboardUser(db, "mallory")).toEqual({
      outcome: "allow",
      user: readmitted,
      created: false,
    });
  });
});

describe("createWorkspace (workspace-store)", () => {
  test("a taken id returns false and leaves no orphan membership", async () => {
    const db = createMigratedTestD1();
    const user = await createUser(db, { login: "deployer", role: "member" });
    const createdAt = new Date().toISOString();
    // 0026's seed owns `default`; a second insert under the same id trips the
    // UNIQUE slug index, and the batch aborts as a unit.
    expect(await createWorkspace(db, { id: "default", name: "Dup", userId: user.id, createdAt })).toBe(false);
    const members = db.raw
      .query("SELECT * FROM workspace_members WHERE workspace_id = 'default'")
      .all();
    expect(members).toEqual([]);
    expect(
      (db.raw.query("SELECT COUNT(*) AS n FROM workspaces WHERE slug = 'default'").get() as { n: number }).n,
    ).toBe(1);
  });
});
