/**
 * Comment-claim outbox settings at the cron sweep (migration 0048).
 *
 * The runtime-config store (src/dashboard/runtime-config-store.ts) owns the
 * parse, the absent-row defaults, the ranges and the degraded answer; this
 * module is the ONE export the pipeline consumes — `readCommentClaimSettings` —
 * so the sweep never imports a dashboard route surface. It adds exactly one
 * thing: the structured warn a degraded read owes the operator.
 *
 * Why the warn lives here: the store answers the trio as the documented
 * defaults with `degraded: true` instead of throwing (a broken settings read
 * must not stop the outbox from recovering a claim), and the sweep's log
 * channel is where these lines are read. Exactly one line per degraded read.
 *
 * The settings are global (no workspace column), so the fields carry no PR
 * identity: a caller adapting its job log keeps its own fields and spreads
 * these.
 */
import {
  getCommentClaimSettings,
  type CommentClaimSettings,
} from "../dashboard/runtime-config-store";
import type { DashboardD1 } from "../dashboard/users";

export type { CommentClaimSettings };
export {
  COMMENT_CLAIM_ATTEMPTS_DEFAULT,
  COMMENT_CLAIM_OUTBOX_DEFAULT,
  COMMENT_CLAIM_RETRY_DEFAULT,
} from "../dashboard/runtime-config-store";

/** The one warn payload this reader emits. */
export type CommentClaimSettingsLogFields = {
  event: "review_comment_claim_settings_degraded";
  /** The settings the reader answered with — always the documented defaults. */
  retry_ms: number;
  max_attempts: number;
  outbox_cap: number;
};

/** Warn-only view of the sweep's log channel; the fields are this module's payload (see the header). */
export type CommentClaimSettingsLog = {
  warn: (fields: CommentClaimSettingsLogFields, msg?: string) => void;
};

/**
 * All three settings: ONE D1 read, no cache. An untrusted stored value or a
 * read failure answers the documented defaults with `degraded: true`, never
 * throws, and logs one structured warn; absent rows answer their defaults
 * silently.
 */
export async function readCommentClaimSettings(
  db: DashboardD1,
  log: CommentClaimSettingsLog,
): Promise<CommentClaimSettings> {
  const settings = await getCommentClaimSettings(db);
  if (settings.degraded) {
    log.warn(
      {
        event: "review_comment_claim_settings_degraded",
        retry_ms: settings.retryMs,
        max_attempts: settings.maxAttempts,
        outbox_cap: settings.outboxCap,
      },
      "comment claim settings read degraded — using the documented defaults",
    );
  }
  return settings;
}
