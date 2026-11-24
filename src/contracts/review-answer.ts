/**
 * why: the ONE vocabulary of "are reviews running" — shared by the queue
 * batch's derivation (`reviewRunState`), the operator card's payload and the
 * SPA's answer map, so all three enumerate the same states structurally
 * instead of agreeing by string literal.
 *
 * A closed maintenance window mints its own answer rather than borrowing the
 * platform pause's: `paused-maintenance` names the window, `paused-platform`
 * the switch — two different operator actions.
 */
export const REVIEW_ANSWERS = Object.freeze([
  "running",
  "paused-platform",
  "blocked-deployment-gate",
  "paused-maintenance",
  "unreadable-state",
] as const);

export type ReviewsRunAnswer = (typeof REVIEW_ANSWERS)[number];
