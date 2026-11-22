import {
  getEffectiveConcurrency,
  type DegradedReason,
  type EffectiveConcurrency,
} from "../dashboard/runtime-config-store";
import type { DashboardD1 } from "../dashboard/users";

/** The store's degraded cause, re-exported for the consumer's log schema. */
export type { DegradedReason };

/** The one warn payload this reader emits. */
export type ReviewConcurrencyLogFields = {
  event: "review_concurrency_degraded";
  workspace_id: string;
  effective: number;
  degraded_reason?: DegradedReason;
};

/** Warn-only view of the consumer's log channel; the fields are this module's payload (see the header). */
export type ReviewConcurrencyLog = {
  warn: (fields: ReviewConcurrencyLogFields, msg?: string) => void;
};

/**
 * Both caps for one workspace: ONE D1 read, no cache. A read failure or an
 * untrusted stored value answers the conservative cap (1, i.e. serial) for both
 * levels with `degraded: true`, never throws, and logs one structured warn; an
 * absent setting answers its documented default silently.
 *
 * The two caps stay separate through this boundary — the admission gate binds
 * `system` to the global count and `workspace` to the tenant's own, so neither
 * may be collapsed into `effective` here.
 */
export async function readReviewConcurrency(
  db: DashboardD1,
  workspaceId: string,
  log: ReviewConcurrencyLog,
): Promise<EffectiveConcurrency> {
  const caps = await getEffectiveConcurrency(db, workspaceId);
  if (caps.degraded) {
    log.warn(
      {
        event: "review_concurrency_degraded",
        workspace_id: workspaceId,
        effective: caps.effective,
        degraded_reason: caps.reason,
      },
      "review concurrency read degraded — admitting at the conservative cap (serial)",
    );
  }
  return caps;
}
