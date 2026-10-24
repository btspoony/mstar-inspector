/**
 * Unit tests: the pure workspace-creation cap (`workspace-limits.ts`).
 *
 * Boundary shape: count 4 → allowed, 5 → refused, 6 → refused. The refusal is
 * the named error whose message is the layout's 409 body, so both the class and
 * the exact string are pinned.
 */
import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_LIMITS,
  WorkspaceCreationLimitError,
  assertWorkspaceCreationAllowed,
} from "../../src/dashboard/workspace-limits";

const MESSAGE_AT_5_OF_5 =
  "You already have 5 live workspaces you created; the limit is 5. Creating another is not available, and nothing on this page frees a slot.";
const MESSAGE_AT_6_OF_5 =
  "You already have 6 live workspaces you created; the limit is 5. Creating another is not available, and nothing on this page frees a slot.";

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
    expect((err as Error).message).toBe(MESSAGE_AT_5_OF_5);
  });

  test("6 live workspaces (over the limit) is refused: the body states the observed count", () => {
    const err = refusal(6);
    expect(err).toBeInstanceOf(WorkspaceCreationLimitError);
    expect((err as Error).message).toBe(MESSAGE_AT_6_OF_5);
  });

  test("the cap is read from the frozen constant", () => {
    expect(WORKSPACE_LIMITS.perLogin).toBe(5);
    expect(Object.isFrozen(WORKSPACE_LIMITS)).toBe(true);
  });
});
