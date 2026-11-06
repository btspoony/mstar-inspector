/**
 * Check budgets at the queue consumer's Check seam (spec §7.10).
 *
 * The runtime-config store (src/dashboard/runtime-config-store.ts) owns the
 * parse, the defaults and the degraded answer; this module is the ONE export
 * the pipeline consumes — `readCheckBudgets` — so the consumer never imports a
 * dashboard route surface. It adds exactly one thing: the structured warn a
 * degraded read owes the operator.
 *
 * Why the warn lives here: the store answers both budgets as the documented
 * defaults with `degraded: true` instead of throwing (a broken settings read
 * must not make a Check unbounded or block the review), and the consumer's log
 * channel is the one place these lines are read. Exactly one line per degraded
 * read — never per budget, never per retry.
 *
 * The budgets are global (no workspace column), so the log fields carry no PR
 * identity: a caller adapting its job log keeps its own fields and spreads
 * these.
 */
import {
  getCheckBudgets,
  type CheckBudgets,
  type DegradedReason,
} from "../dashboard/runtime-config-store";
import type { DashboardD1 } from "../dashboard/users";

export type { CheckBudgets };
export { CHECK_TERMINALIZE_DEFAULT, CHECK_UPDATE_DEFAULT } from "../dashboard/runtime-config-store";

/** The one warn payload this reader emits. */
export type CheckBudgetsLogFields = {
  event: "review_check_budgets_degraded";
  /** The budgets the reader answered with — always the documented defaults. */
  terminalize_ms: number;
  update_ms: number;
  /** Why the read degraded; the store's cause, never a re-derivation. Its own
   * key because the consumer channel's `reason` is the closed admission
   * vocabulary. */
  degraded_reason?: DegradedReason;
};

/** Warn-only view of the consumer's log channel; the fields are this module's payload (see the header). */
export type CheckBudgetsLog = {
  warn: (fields: CheckBudgetsLogFields, msg?: string) => void;
};

/**
 * Both budgets: ONE D1 read, no cache. An untrusted stored value or a read
 * failure answers the documented defaults with `degraded: true`, never throws,
 * and logs one structured warn; absent rows answer their defaults silently.
 */
export async function readCheckBudgets(
  db: DashboardD1,
  log: CheckBudgetsLog,
): Promise<CheckBudgets> {
  const budgets = await getCheckBudgets(db);
  if (budgets.degraded) {
    log.warn(
      {
        event: "review_check_budgets_degraded",
        terminalize_ms: budgets.terminalizeMs,
        update_ms: budgets.updateMs,
        degraded_reason: budgets.reason,
      },
      "check budgets read degraded — using the documented defaults",
    );
  }
  return budgets;
}
