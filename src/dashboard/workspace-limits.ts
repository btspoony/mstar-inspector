/**
 * Workspace-creation limits — the pure cap the creation route calls before it
 * writes anything. No D1 handle, no environment read, no async: the caller
 * reads how many live workspaces the login CREATED (`workspaces.created_by`
 * with `deleted_at IS NULL`) and passes the count in.
 *
 * Replacement point: when the entitlement/plan limit replaces the constant,
 * the route passes a `WorkspaceLimits` resolved from the login's
 * entitlement/plan instead — the predicate, its call shape and its tests never
 * change.
 *
 * Known limit: this check is not an atomic reservation — two concurrent
 * creations can both read the same count and pass. Atomic enforcement is
 * required before the first paid plan.
 */

/** The cap for one login; the seam an entitlement lookup would fill. */
export type WorkspaceLimits = { perLogin: number };

/** The only edit point today. Frozen so no caller can widen it in place. */
export const WORKSPACE_LIMITS: WorkspaceLimits = Object.freeze({ perLogin: 5 });

/**
 * Refusal for a creation that would exceed the login's cap. Named (not a
 * plain Error) because the route tells 409 from 500 by class, never by
 * message-sniffing; the message is the user-visible 409 body.
 */
export class WorkspaceCreationLimitError extends Error {
  constructor(count: number, limit: number) {
    super(
      `You already have ${count} live workspaces you created; the limit is ${limit}. Creating another is not available, and nothing on this page frees a slot.`,
    );
    this.name = "WorkspaceCreationLimitError";
  }
}

/**
 * Refuse one more creation when the login already holds `limits.perLogin`
 * live workspaces it created. `userId` documents the keying of
 * `liveWorkspaceCount` — the predicate itself needs only the count.
 */
export function assertWorkspaceCreationAllowed(input: {
  userId: string;
  liveWorkspaceCount: number;
  limits: WorkspaceLimits;
}): void {
  if (input.liveWorkspaceCount >= input.limits.perLogin) {
    throw new WorkspaceCreationLimitError(input.liveWorkspaceCount, input.limits.perLogin);
  }
}
