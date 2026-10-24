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
  MemberCapError,
  freeSlotAvailable,
  memberSlotAvailable,
  resolveWorkspacePlan,
} from "../../src/dashboard/entitlement";
import { countFreeMembershipsForLogin } from "../../src/dashboard/workspace-store";
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

describe("refusals", () => {
  test("each refusal keeps its class name and the exact 409 body", () => {
    const slot = new FreeWorkspaceSlotError("free slot body");
    expect(slot.name).toBe("FreeWorkspaceSlotError");
    expect(slot.message).toBe("free slot body");
    const cap = new MemberCapError("member cap body");
    expect(cap.name).toBe("MemberCapError");
    expect(cap.message).toBe("member cap body");
  });
});
