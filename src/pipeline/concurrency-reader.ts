/**
 * Review concurrency at the queue consumer's admission decision
 * (iteration spec review-concurrency §1.1/§2.2).
 *
 * The runtime-config store (src/dashboard/runtime-config-store.ts) owns the
 * parse, the defaults and the conservative answer; this module is the ONE
 * export the pipeline consumes — `readReviewConcurrency` — so the consumer
 * never imports a dashboard route surface. It adds exactly one thing: the
 * structured warn a degraded read owes the operator.
 *
 * Why the warn lives here: the store answers `degraded: true` instead of
 * throwing (a broken settings read must not admit unlimited reviews), and the
 * consumer's log channel is the one place these lines are read. Exactly one
 * line per degraded read — never per level, never per retry.
 *
 * The log fields are workspace-scoped: the caps read carries no PR identity,
 * so it cannot ride `ConsumerLogFields` (the same reason `SweepLog` exists).
 * A caller adapting its job log keeps its own fields and spreads these.
 */
import { getEffectiveConcurrency, type EffectiveConcurrency } from "../dashboard/runtime-config-store";
import type { DashboardD1 } from "../dashboard/users";

/** The one warn payload this reader emits. */
export type ReviewConcurrencyLogFields = {
  event: "review_concurrency_degraded";
  workspace_id: string;
  /** The cap the reader answered with — always the conservative 1 when degraded. */
  effective: number;
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
      { event: "review_concurrency_degraded", workspace_id: workspaceId, effective: caps.effective },
      "review concurrency read degraded — admitting at the conservative cap (serial)",
    );
  }
  return caps;
}
