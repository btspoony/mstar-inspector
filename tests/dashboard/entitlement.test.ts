/**
 * `checkEntitlement` — the ONE plan decision, pinned as a table over
 * kind × plan × mode. Every row asserts the verdict a caller maps onto its own
 * surface, so a rule change has to change a row here first.
 *
 * The fixture is the fully-migrated D1 double, so the plan columns and the
 * quota profile's ceilings come from the real migrations (`0031`, `0061`,
 * `0063`) rather than a hand-built table.
 *
 * Also pinned:
 *   - `self-hosted` answers WITHOUT reading the catalogue, for every kind that
 *     can refuse;
 *   - every verdict carries `plan`, allowed or refused, and the `seats: null`
 *     branch never refuses while still carrying the limit;
 *   - a plan change reaches the next call with no restart and no cache;
 *   - the shared-bot creation refusal's verbatim Product copy.
 */
import { describe, expect, test } from "bun:test";
import { checkEntitlement, SHARED_BOT_REFUSAL } from "../../src/dashboard/entitlement";
import type { DeploymentMode } from "../../src/worker/env";
import type { WorkspaceStoreD1 } from "../../src/dashboard/workspace-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const WS = "default";
const TS = "2026-10-24T00:00:00.000Z";
/** The month `quota-v1` judges: any instant on or after its `effective_from`. */
const MONTH_START = "2026-11-01T00:00:00.000Z";

/** The workspace's active subscription; no row resolves the seeded `free`. */
function seedSubscription(db: TestD1, planId: string): void {
  db.raw
    .prepare(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(WS, planId, TS, TS);
}

/** The four shapes a workspace resolves to: absent row → `free`, else the catalogue. */
const SHAPES = [
  { plan: null, planId: "free", includedMembers: 5, sharedBotAllowed: false, appsPerWorkspace: 1 },
  { plan: "free", planId: "free", includedMembers: 5, sharedBotAllowed: false, appsPerWorkspace: 1 },
  { plan: "pro", planId: "pro", includedMembers: 5, sharedBotAllowed: true, appsPerWorkspace: 10 },
  {
    plan: "unlimited",
    planId: "unlimited",
    includedMembers: null,
    sharedBotAllowed: true,
    appsPerWorkspace: null,
  },
] as const;

/** Migration 0063's ceiling per plan, in RP. */
const CEILING = { free: 2000, pro: 20000, unlimited: null } as const;

function migrated(shape: (typeof SHAPES)[number] | null): TestD1 {
  const db = createMigratedTestD1();
  if (shape?.plan != null) seedSubscription(db, shape.plan);
  return db;
}

/** `self-hosted` resolves the unlimited constant whatever the stored row says. */
const SELF_HOSTED = { planId: "unlimited", includedMembers: null, sharedBotAllowed: true, appsPerWorkspace: null };

describe("checkEntitlement — shared-bot, the decision table", () => {
  for (const mode of ["saas", "self-hosted"] as const) {
    for (const shape of SHAPES) {
      const expected = mode === "self-hosted" ? SELF_HOSTED : shape;
      const allowed = expected.sharedBotAllowed;
      test(`${mode} + ${shape.plan ?? "no subscription"} → ${allowed ? "allowed" : `refused (${expected.planId})`}`, async () => {
        const db = migrated(shape);
        const verdict = await checkEntitlement({ db, mode, workspaceId: WS, kind: "shared-bot", botScope: "shared" });
        expect(verdict.plan.id).toBe(expected.planId);
        expect(verdict.ok).toBe(allowed);
        if (!verdict.ok) expect(verdict.refusal).toEqual({ kind: "shared-bot", planId: expected.planId });
        db.raw.close();
      });
    }
  }

  test("an own bot is never a plan question, though the verdict still carries the plan", async () => {
    const db = migrated(SHAPES[0]!);
    const verdict = await checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "shared-bot", botScope: "own" });
    expect(verdict.ok).toBe(true);
    expect(verdict.plan.id).toBe("free");
    db.raw.close();
  });
});

describe("checkEntitlement — member-slot", () => {
  test("fills up to, not including, the plan's included members", async () => {
    const db = migrated(SHAPES[0]!);
    for (const seats of [0, 4]) {
      const verdict = await checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "member-slot", seats });
      expect(verdict.ok).toBe(true);
      expect(verdict.plan.includedMembers).toBe(5);
    }
    for (const seats of [5, 6]) {
      const verdict = await checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "member-slot", seats });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.refusal).toEqual({ kind: "member-slot", limit: 5, seats });
    }
    db.raw.close();
  });

  test("a null limit is no cap, and an unlimited plan carries no refusal to mint", async () => {
    const db = migrated({ ...SHAPES[3]! });
    const verdict = await checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "member-slot", seats: 600 });
    expect(verdict.ok).toBe(true);
    expect(verdict.plan.includedMembers).toBeNull();
    db.raw.close();
  });

  test("`seats: null` never refuses: the caller's guarded SQL is the authority", async () => {
    const db = migrated(SHAPES[0]!);
    // The count that WOULD refuse the route's fast-fail, deliberately absent.
    const verdict = await checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "member-slot", seats: null });
    expect(verdict.ok).toBe(true);
    // ...and the limit the guarded insert binds comes off the same verdict.
    expect(verdict.plan.includedMembers).toBe(5);
    db.raw.close();
  });
});

describe("checkEntitlement — free-workspace-slot", () => {
  test("one free workspace per login: the first is allowed, the second is not", async () => {
    const db = migrated(null);
    expect(
      (await checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "free-workspace-slot", freeMembershipCount: 0 }))
        .ok,
    ).toBe(true);
    for (const freeMembershipCount of [1, 2]) {
      const verdict = await checkEntitlement({
        db,
        mode: "saas",
        workspaceId: WS,
        kind: "free-workspace-slot",
        freeMembershipCount,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.refusal).toEqual({ kind: "free-workspace-slot" });
    }
    db.raw.close();
  });
});

describe("checkEntitlement — app-count", () => {
  test("the plan's App cap admits below it and refuses at it", async () => {
    const db = migrated(SHAPES[0]!);
    const count = (n: number) => async () => n;
    expect((await checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "app-count", liveAppCount: count(0) })).ok).toBe(
      true,
    );
    const verdict = await checkEntitlement({
      db,
      mode: "saas",
      workspaceId: WS,
      kind: "app-count",
      liveAppCount: count(1),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toEqual({ kind: "app-count", limit: 1, count: 1 });
    db.raw.close();
  });

  test("a null cap admits any count without reading it — absence is never 'zero Apps'", async () => {
    const db = migrated({ ...SHAPES[3]! });
    let reads = 0;
    const verdict = await checkEntitlement({
      db,
      mode: "saas",
      workspaceId: WS,
      kind: "app-count",
      liveAppCount: async () => {
        reads += 1;
        return 500;
      },
    });
    expect(verdict.ok).toBe(true);
    expect(reads).toBe(0);
    db.raw.close();
  });
});

describe("checkEntitlement — review-quota", () => {
  test("a month exactly at its ceiling admits the review that lands on it", async () => {
    const db = migrated(SHAPES[0]!);
    for (const [usedRp, costRp, allowed] of [
      [1999, 1, true],
      [1999, 2, false],
      [2000, 1, false],
    ] as const) {
      const verdict = await checkEntitlement({
        db,
        mode: "saas",
        workspaceId: WS,
        kind: "review-quota",
        monthStart: MONTH_START,
        usedRp,
        costRp,
      });
      expect(verdict.ok).toBe(allowed);
      if (!verdict.ok) {
        expect(verdict.refusal).toEqual({ kind: "review-quota", limit: CEILING.free, used: usedRp, cost: costRp });
      }
    }
    db.raw.close();
  });

  test("the ceiling follows the plan the same verdict resolved", async () => {
    const db = migrated(SHAPES[2]!);
    const verdict = await checkEntitlement({
      db,
      mode: "saas",
      workspaceId: WS,
      kind: "review-quota",
      monthStart: MONTH_START,
      usedRp: 5000,
      costRp: 100,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.plan.id).toBe("pro");
    db.raw.close();
  });

  test("a null ceiling is unlimited", async () => {
    const db = migrated({ ...SHAPES[3]! });
    const verdict = await checkEntitlement({
      db,
      mode: "saas",
      workspaceId: WS,
      kind: "review-quota",
      monthStart: MONTH_START,
      usedRp: 10_000_000,
      costRp: 1000,
    });
    expect(verdict.ok).toBe(true);
    db.raw.close();
  });
});

describe("checkEntitlement — self-hosted answers before any read", () => {
  // A double that throws on ANY read: the mode must answer without touching it.
  const neverRead: WorkspaceStoreD1 = {
    prepare() {
      throw new Error("self-hosted must not read the catalogue");
    },
  };

  for (const ctx of [
    { kind: "shared-bot", botScope: "shared" },
    { kind: "member-slot", seats: 1000 },
    { kind: "app-count", liveAppCount: async () => 1000 },
  ] as const) {
    test(`${ctx.kind} is allowed with zero reads`, async () => {
      const verdict = await checkEntitlement({ db: neverRead, mode: "self-hosted", workspaceId: WS, ...ctx });
      expect(verdict.ok).toBe(true);
      expect(verdict.plan.id).toBe("unlimited");
    });
  }

  test("free-workspace-slot is a per-login rule, so the mode does not change it", async () => {
    // Every caller gates it on `saas` itself; the branch never consults the mode
    // (nor the plan it carries), which is why a self-hosted call pays no read
    // and still refuses the second free membership.
    const verdict = await checkEntitlement({
      db: neverRead,
      mode: "self-hosted",
      workspaceId: WS,
      kind: "free-workspace-slot",
      freeMembershipCount: 5,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("checkEntitlement — the plan is read per call", () => {
  test("a plan change takes effect on the next attempt — no restart, no cache", async () => {
    const db = migrated(null);
    const sharedBot = async () =>
      checkEntitlement({ db, mode: "saas", workspaceId: WS, kind: "shared-bot", botScope: "shared" });

    expect((await sharedBot()).ok).toBe(false);

    // The operator's move, through the same row Operator Admin writes.
    seedSubscription(db, "pro");
    expect((await sharedBot()).ok).toBe(true);

    // ...and back: the refusal returns without anything being restarted.
    db.raw.prepare("UPDATE workspace_subscriptions SET status = 'canceled' WHERE workspace_id = ?").run(WS);
    expect((await sharedBot()).ok).toBe(false);
    db.raw.close();
  });
});

describe("SHARED_BOT_REFUSAL", () => {
  test("names the plan this reader can change, verbatim", () => {
    expect(SHARED_BOT_REFUSAL("free")).toBe(
      "This target was not created on the shared bot. The shared bot is not included in this workspace's plan (free). Use a GitHub App this workspace owns, or move the workspace to a plan that includes the shared bot.",
    );
  });
});
