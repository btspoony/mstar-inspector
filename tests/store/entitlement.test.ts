/**
 * Entitlement: plan resolution, the two slot predicates and the free-membership
 * count. The subject is resolved limits and admission boundaries, so the fixture
 * is the fully-migrated D1 double (plans seeded by 0031) plus raw rows for the
 * cases the schema permits: no subscription row, an active plan, a non-active
 * one, and a soft-deleted tenant.
 */
import { describe, expect, test } from "bun:test";
import {
  FreeWorkspaceSlotError,
  MEMBER_CAP_REFUSAL,
  MemberCapError,
  UNLIMITED_PLAN_ID,
  freeSlotAvailable,
  memberSlotAvailable,
  resolveWorkspacePlan,
} from "../../src/dashboard/entitlement";
import { countFreeMembershipsForLogin, createWorkspace } from "../../src/dashboard/workspace-store";
import { createInvite } from "../../src/dashboard/invite-store";
import { createMigratedTestD1, type TestD1 } from "./helpers";

const TS = "2026-10-24T00:00:00.000Z";

function seedUser(db: TestD1, id: string, login: string): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(id, login, TS);
}

function seedWorkspace(db: TestD1, id: string, deletedAt: string | null = null): void {
  db.raw
    .prepare(
      "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, ?)",
    )
    .run(id, id, id, TS, deletedAt);
}

function seedMembership(db: TestD1, workspaceId: string, userId: string): void {
  db.raw
    .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(workspaceId, userId, TS);
}

function seedSubscription(db: TestD1, workspaceId: string, planId: string, status = "active"): void {
  db.raw
    .prepare(
      "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(workspaceId, planId, status, TS, TS);
}

describe("resolveWorkspacePlan", () => {
  test("a workspace without a subscription row resolves to the seeded free limits", async () => {
    const db = createMigratedTestD1();
    expect(await resolveWorkspacePlan(db, "default")).toEqual({
      id: "free",
      name: "Free",
      includedMembers: 5,
    });
    db.raw.close();
  });

  test("an active pro subscription resolves to pro limits", async () => {
    const db = createMigratedTestD1();
    seedSubscription(db, "default", "pro");
    expect(await resolveWorkspacePlan(db, "default")).toEqual({
      id: "pro",
      name: "Pro",
      includedMembers: 5,
    });
    db.raw.close();
  });

  test("an active unlimited subscription resolves to a null seat limit, not a number", async () => {
    const db = createMigratedTestD1();
    seedSubscription(db, "default", UNLIMITED_PLAN_ID);
    expect(await resolveWorkspacePlan(db, "default")).toEqual({
      id: "unlimited",
      name: "Unlimited",
      includedMembers: null,
    });
    db.raw.close();
  });

  test("a non-active subscription resolves to free", async () => {
    const db = createMigratedTestD1();
    seedSubscription(db, "default", "pro", "canceled");
    expect((await resolveWorkspacePlan(db, "default")).id).toBe("free");
    db.raw.close();
  });

  test("a missing seeded free row is an error, not invented limits", async () => {
    const db = createMigratedTestD1();
    db.raw.prepare("DELETE FROM plans WHERE id = 'free'").run();
    await expect(resolveWorkspacePlan(db, "default")).rejects.toThrow(/seeded 'free' row/);
    db.raw.close();
  });
});

describe("slot predicates", () => {
  test("freeSlotAvailable admits an empty history only", () => {
    expect(freeSlotAvailable(0)).toBe(true);
    expect(freeSlotAvailable(1)).toBe(false);
    expect(freeSlotAvailable(2)).toBe(false);
  });

  test("memberSlotAvailable fills up to, not including, the included members", () => {
    expect(memberSlotAvailable(4, 5)).toBe(true);
    expect(memberSlotAvailable(5, 5)).toBe(false);
    expect(memberSlotAvailable(6, 5)).toBe(false);
  });

  test("a null limit is no cap, so any count fits", () => {
    expect(memberSlotAvailable(0, null)).toBe(true);
    expect(memberSlotAvailable(6, null)).toBe(true);
  });
});

describe("countFreeMembershipsForLogin", () => {
  test("counts live free memberships only, matching the login case-insensitively", async () => {
    const db = createMigratedTestD1();
    seedUser(db, "u1", "octocat");
    seedUser(db, "u2", "someone-else");
    seedWorkspace(db, "ws-absent");
    seedWorkspace(db, "ws-free");
    seedWorkspace(db, "ws-pro");
    seedWorkspace(db, "ws-gone", "2026-10-24T00:00:00.000Z");
    seedMembership(db, "ws-absent", "u1"); // no subscription row = free
    seedMembership(db, "ws-free", "u1");
    seedSubscription(db, "ws-free", "free");
    seedMembership(db, "ws-pro", "u1"); // paid plan does not consume a free slot
    seedSubscription(db, "ws-pro", "pro");
    seedMembership(db, "ws-gone", "u1"); // retired tenant is not a home
    seedMembership(db, "ws-absent", "u2"); // another login's membership

    expect(await countFreeMembershipsForLogin(db, "octocat")).toBe(2);
    expect(await countFreeMembershipsForLogin(db, "OCTOCAT")).toBe(2);
    db.raw.close();
  });

  test("a non-active subscription is free, so it consumes a free slot like the resolver says", async () => {
    const db = createMigratedTestD1();
    seedUser(db, "u1", "octocat");
    seedWorkspace(db, "ws-pro-inactive");
    seedMembership(db, "ws-pro-inactive", "u1");
    seedSubscription(db, "ws-pro-inactive", "pro", "canceled");
    seedWorkspace(db, "ws-free-inactive");
    seedMembership(db, "ws-free-inactive", "u1");
    seedSubscription(db, "ws-free-inactive", "free", "canceled");

    // The resolver and the count must agree: a non-active row is "no plan".
    expect((await resolveWorkspacePlan(db, "ws-pro-inactive")).id).toBe("free");
    expect(await countFreeMembershipsForLogin(db, "octocat")).toBe(2);
    db.raw.close();
  });
});

describe("in-write guards", () => {
  test("createWorkspace refuses a login already in a live free workspace and writes zero rows", async () => {
    const db = createMigratedTestD1();
    seedUser(db, "u1", "octocat");
    seedWorkspace(db, "ws-free");
    seedMembership(db, "ws-free", "u1");
    seedSubscription(db, "ws-free", "free");

    // No route read ran here: the guard inside the creation batch is what
    // refuses, and it must leave nothing behind (no orphan workspace,
    // membership or subscription row).
    await expect(
      createWorkspace(db, {
        id: "ws-new",
        name: "New",
        userId: "u1",
        githubLogin: "OCTOCAT",
        createdAt: TS,
      }),
    ).rejects.toThrow(FreeWorkspaceSlotError);

    const count = (sql: string): number => db.raw.query<{ n: number }, []>(sql).get()?.n ?? 0;
    expect(count("SELECT COUNT(*) AS n FROM workspaces WHERE id = 'ws-new'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = 'ws-new'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM workspace_subscriptions WHERE workspace_id = 'ws-new'")).toBe(0);
    db.raw.close();
  });

  test("createInvite refuses at the plan's cap and writes zero rows", async () => {
    const db = createMigratedTestD1();
    // Five members fill the seeded free plan's five seats, so only the
    // in-write predicate can refuse this insert.
    for (let i = 0; i < 5; i += 1) {
      seedUser(db, `u${i}`, `user${i}`);
      seedMembership(db, "default", `u${i}`);
    }

    await expect(
      createInvite(db, {
        workspaceId: "default",
        login: "newcomer",
        role: "member",
        invitedBy: "u0",
        now: TS,
        expiresAt: "2026-10-24T00:05:00.000Z",
      }),
    ).rejects.toThrow(MEMBER_CAP_REFUSAL(5));

    expect(
      db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM workspace_invites").get()?.n ?? 0,
    ).toBe(0);
    db.raw.close();
  });

  test("a null seat limit admits the invite a five-seat plan refuses", async () => {
    const db = createMigratedTestD1();
    // The same five filled seats that trip the free plan above.
    for (let i = 0; i < 5; i += 1) {
      seedUser(db, `u${i}`, `user${i}`);
      seedMembership(db, "default", `u${i}`);
    }
    seedSubscription(db, "default", UNLIMITED_PLAN_ID);

    const created = await createInvite(db, {
      workspaceId: "default",
      login: "newcomer",
      role: "member",
      invitedBy: "u0",
      now: TS,
      expiresAt: "2026-10-24T00:05:00.000Z",
    });

    expect(created.status).toBe("pending");
    expect(
      db.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM workspace_invites").get()?.n ?? 0,
    ).toBe(1);
    db.raw.close();
  });
});

describe("refusals", () => {
  test("each refusal keeps its class name and the exact 409 body", () => {
    const slot = new FreeWorkspaceSlotError("free slot body");
    expect(slot.name).toBe("FreeWorkspaceSlotError");
    expect(slot.message).toBe("free slot body");
    const cap = new MemberCapError("member cap body");
    expect(cap.name).toBe("MemberCapError");
    expect(cap.message).toBe("member cap body");
  });

  test("the member-cap copy names the plan's actual seat limit", () => {
    expect(MEMBER_CAP_REFUSAL(5)).toContain("already has 5 people");
    expect(MEMBER_CAP_REFUSAL(20)).toContain("already has 20 people");
  });
});

describe("migration 0032 (unlimited plan)", () => {
  test("the rebuilt plans table keeps both seeded rows, the FK and a nullable seat limit", () => {
    const db = createMigratedTestD1();
    const seeded = {
      monthly_price_cents: null,
      included_members: 5,
      extra_member_price_cents: null,
      platform_key_limit: null,
      reviews_included: null,
      apps_per_workspace: null,
      created_at: "2026-10-24T00:00:00.000Z",
    };

    // Both seeded rows survive the rebuild byte-identically.
    expect(db.raw.prepare("SELECT * FROM plans WHERE id <> 'unlimited' ORDER BY id").all()).toEqual([
      { ...seeded, id: "free", name: "Free", monthly_price_cents: 0 },
      { ...seeded, id: "pro", name: "Pro" },
    ]);

    // The column is relaxed — the reason the table was rebuilt at all ...
    expect(
      db.raw
        .prepare(
          `SELECT type, "notnull" FROM pragma_table_info('plans') WHERE name = 'included_members'`,
        )
        .get(),
    ).toEqual({ type: "INTEGER", notnull: 0 });
    // ... and the new tier is one real row with every quota NULL.
    expect(
      db.raw.prepare("SELECT included_members FROM plans WHERE id = 'unlimited'").get(),
    ).toEqual({ included_members: null });

    // The child FK survived the drop/re-create: declared, and still enforced.
    expect(
      db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM pragma_foreign_key_list('workspace_subscriptions')
            WHERE "table" = 'plans' AND "from" = 'plan_id' AND "to" = 'id'`,
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
           VALUES ('default', 'no-such-plan', 'active', ?, ?)`,
        )
        .run(TS, TS),
    ).toThrow(/FOREIGN KEY/);

    db.raw.close();
  });
});
