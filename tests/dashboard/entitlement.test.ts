/**
 * The shared-bot capability decision — `assertSharedBotAllowed`, the ONE
 * function both surfaces consult (creating a target on a shared bot, and
 * enqueueing a review for one).
 *
 * Pinned here:
 *   - the decision table over both modes and the four resolvable plan shapes
 *     (no subscription → `free`, plus the three seeded catalogue rows);
 *   - `self-hosted` answers WITHOUT reading the catalogue — the mode decides
 *     first, so that deployment never touches the column;
 *   - a plan change reaches the next attempt with no restart and no cache;
 *   - the creation refusal's verbatim Product copy.
 *
 * The fixture is the fully-migrated D1 double, so the column comes from
 * migration `0061_plan_shared_bot_allowed.sql` rather than a hand-built table.
 */
import { describe, expect, test } from "bun:test";
import { assertSharedBotAllowed, SHARED_BOT_REFUSAL } from "../../src/dashboard/entitlement";
import type { DeploymentMode } from "../../src/worker/env";
import type { WorkspaceStoreD1 } from "../../src/dashboard/workspace-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const WS = "default";
const TS = "2026-10-24T00:00:00.000Z";

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
  { plan: null, planId: "free", allowed: false },
  { plan: "free", planId: "free", allowed: false },
  { plan: "pro", planId: "pro", allowed: true },
  { plan: "unlimited", planId: "unlimited", allowed: true },
] as const;

describe("assertSharedBotAllowed — the decision table", () => {
  for (const mode of ["saas", "self-hosted"] as const) {
    for (const shape of SHAPES) {
      // `self-hosted` resolves `unlimited` whatever the stored row says.
      const allowed = mode === "self-hosted" ? true : shape.allowed;
      const planId = mode === "self-hosted" ? "unlimited" : shape.planId;
      const verdict = allowed ? "allowed" : `refused (${planId})`;
      test(`${mode} + ${shape.plan ?? "no subscription"} → ${verdict}`, async () => {
        const db = createMigratedTestD1();
        if (shape.plan !== null) seedSubscription(db, shape.plan);

        const refusal = await assertSharedBotAllowed(db, WS, mode);

        expect(refusal).toEqual(allowed ? null : { kind: "shared-bot-not-included", planId });
        db.raw.close();
      });
    }
  }
});

describe("assertSharedBotAllowed — the mode and the plan are read per call", () => {
  test("self-hosted never reads the catalogue, so a missing free row cannot fail it", async () => {
    // A double that throws on ANY read: `self-hosted` must answer before it.
    let reads = 0;
    const neverRead: WorkspaceStoreD1 = {
      prepare() {
        reads += 1;
        throw new Error("self-hosted must not read the catalogue");
      },
    };

    expect(await assertSharedBotAllowed(neverRead, WS, "self-hosted")).toBeNull();
    expect(reads).toBe(0);
  });

  test("a plan change takes effect on the next attempt — no restart, no cache", async () => {
    const db = createMigratedTestD1();
    expect(await assertSharedBotAllowed(db, WS, "saas")).toEqual({
      kind: "shared-bot-not-included",
      planId: "free",
    });

    // The operator's move, through the same row Operator Admin writes.
    seedSubscription(db, "pro");
    expect(await assertSharedBotAllowed(db, WS, "saas")).toBeNull();

    // ...and back: the refusal returns without anything being restarted.
    db.raw.prepare("UPDATE workspace_subscriptions SET status = 'canceled' WHERE workspace_id = ?").run(WS);
    expect(await assertSharedBotAllowed(db, WS, "saas")).toEqual({
      kind: "shared-bot-not-included",
      planId: "free",
    });
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
