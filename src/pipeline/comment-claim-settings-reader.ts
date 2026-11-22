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
