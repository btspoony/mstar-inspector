/**
 * Unit tests: the pure workspace-creation cap (`workspace-limits.ts`).
 *
 * Boundary shape from plan 109 Design B: count 4 → allowed, 5 → refused,
 * 6 → refused. The refusal is the named error whose message is the layout's
 * 409 body, so both the class and the exact string are pinned.
 */
import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_LIMITS,
  WorkspaceCreationLimitError,
  assertWorkspaceCreationAllowed,
} from "../../src/dashboard/workspace-limits";

const MESSAGE =
  "You already have 5 live workspaces you created. Delete one of those before creating another.";

/** The value the predicate refuses with, or a guard failure when it lets one through. */
function refusal(liveWorkspaceCount: number): unknown {
  try {
    assertWorkspaceCreationAllowed({
      userId: "user-1",
      liveWorkspaceCount,
      limits: WORKSPACE_LIMITS,
    });
  } catch (err) {
    return err;
  }
  throw new Error(`expected a refusal at ${liveWorkspaceCount} live workspaces`);
}

describe("assertWorkspaceCreationAllowed (workspace creation cap)", () => {
  test("4 live workspaces: one more is allowed, synchronously (no promise)", () => {
    expect(
      assertWorkspaceCreationAllowed({
        userId: "user-1",
        liveWorkspaceCount: 4,
        limits: WORKSPACE_LIMITS,
      }),
    ).toBeUndefined();
  });

  test("5 live workspaces (the limit itself) is refused: instanceof + exact message", () => {
    const err = refusal(5);
    expect(err).toBeInstanceOf(WorkspaceCreationLimitError);
    expect((err as Error).message).toBe(MESSAGE);
  });

  test("6 live workspaces (over the limit) is refused identically", () => {
    const err = refusal(6);
    expect(err).toBeInstanceOf(WorkspaceCreationLimitError);
    expect((err as Error).message).toBe(MESSAGE);
  });

  test("the cap is read from the frozen constant", () => {
    expect(WORKSPACE_LIMITS.perLogin).toBe(5);
    expect(Object.isFrozen(WORKSPACE_LIMITS)).toBe(true);
  });
});
