/**
 * The review gate's score floor — the closed value domain plus the platform
 * default, shared by the App store (the create-path seed), the workspace
 * settings store and the settings routes.
 *
 * A score is a percentage, so the domain is a protocol-level integer range and
 * not a tunable: only the DEFAULT is configuration (a workspace may set its
 * own for new Apps, and an App may override its own floor).
 */
export const CHECK_MIN_SCORE_MIN = 0;
export const CHECK_MIN_SCORE_MAX = 100;

/** The floor a new App starts at when its workspace has not chosen one. */
export const DEFAULT_CHECK_MIN_SCORE = 60;

/** Integer 0..100 — the one predicate the write faces and the reads share. */
export function isCheckMinScoreValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CHECK_MIN_SCORE_MIN &&
    value <= CHECK_MIN_SCORE_MAX
  );
}
