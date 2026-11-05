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
  getRecheckBacklogFill,
  type CheckBudgets,
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
      },
      "check budgets read degraded — using the documented defaults",
    );
  }
  return budgets;
}

/** The one warn payload a degraded backlog-fill read emits. */
export type BacklogFillLogFields = {
  event: "review_recheck_backlog_fill_degraded";
  /** The refill the reader answered with — the documented default. */
  rows: number;
};

/** Warn-only view of the consumer's log channel (same shape as `CheckBudgetsLog`). */
export type BacklogFillLog = {
  warn: (fields: BacklogFillLogFields, msg?: string) => void;
};

/**
 * The §7.2 recheck backlog refill: ONE D1 read, no cache. An untrusted stored
 * value or a read failure answers the documented default with one structured
 * warn; an absent row answers its default silently.
 */
export async function readRecheckBacklogFill(db: DashboardD1, log: BacklogFillLog): Promise<number> {
  const fill = await getRecheckBacklogFill(db);
  if (fill.degraded) {
    log.warn(
      { event: "review_recheck_backlog_fill_degraded", rows: fill.rows },
      "recheck backlog refill read degraded — using the documented default",
    );
  }
  return fill.rows;
}
