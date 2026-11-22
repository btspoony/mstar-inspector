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
  terminalize_ms: number;
  update_ms: number;
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
