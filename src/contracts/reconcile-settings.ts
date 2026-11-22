import { CHECK_UPDATE_MIN } from "./check-budgets";

export const RECONCILE_FIELDS = [
  "lifecycleMaxRequests",
  "lifecycleRunBudgetMs",
  "lifecyclePerRequestMs",
  "lifecycleThreadOperationRequests",
  "lifecyclePublicationLaneMaxRequests",
  "lifecycleSelectLimit",
  "lifecycleMaxAttempts",
  "checkMaxRequests",
  "checkRunBudgetMs",
  "checkPerRequestMs",
  "checkRowMaxRequests",
  "checkSelectLimit",
  "checkMaxAttempts",
] as const;

export type ReconcileField = (typeof RECONCILE_FIELDS)[number];
export type ReconcileValues = Record<ReconcileField, number>;
export type ReconcileLimits = Record<ReconcileField, { min: number; max: number }>;
export type ReconcileConfig = {
  values: ReconcileValues;
  limits: ReconcileLimits;
  degraded: boolean;
};

const RECONCILE_REQUEST_HARD_MAX = 100;
const RECONCILE_RUN_HARD_MAX_MS = 60_000;
const RECONCILE_REQUEST_HARD_MAX_MS = 15_000;
const RECONCILE_SELECT_HARD_MAX = 100;
const RECONCILE_ATTEMPTS_HARD_MAX = 10;

/** Non-mutating preflight estimates; only actual dispatches spend requests. */
export const RECONCILE_REQUEST_ESTIMATES = {
  plan: 1,
  send: 2,
  discovery: 2,
  identity: 1,
  credentials: 2,
} as const;

const { plan, send, discovery, credentials } = RECONCILE_REQUEST_ESTIMATES;
const CHECK_ROW_MIN_REQUESTS = credentials + discovery + send;
const PUBLICATION_MIN_REQUESTS = credentials + plan + send;
const THREAD_MIN_REQUESTS = credentials + discovery + discovery + plan + discovery;
const LIFECYCLE_MIN_REQUESTS = PUBLICATION_MIN_REQUESTS + THREAD_MIN_REQUESTS;
const REQUEST_MIN_MS = CHECK_UPDATE_MIN;
const LIFECYCLE_RUN_MIN_MS = LIFECYCLE_MIN_REQUESTS * REQUEST_MIN_MS;
const CHECK_RUN_MIN_MS = CHECK_ROW_MIN_REQUESTS * REQUEST_MIN_MS;

export const RECONCILE_RULES = {
  lifecycleMaxRequests: { key: "platform.reconcile.lifecycle.max_requests", fallback: 80, min: LIFECYCLE_MIN_REQUESTS, max: RECONCILE_REQUEST_HARD_MAX },
  lifecycleRunBudgetMs: { key: "platform.reconcile.lifecycle.run_budget_ms", fallback: 45_000, min: LIFECYCLE_RUN_MIN_MS, max: RECONCILE_RUN_HARD_MAX_MS },
  lifecyclePerRequestMs: { key: "platform.reconcile.lifecycle.per_request_ms", fallback: 5_000, min: REQUEST_MIN_MS, max: RECONCILE_REQUEST_HARD_MAX_MS },
  lifecycleThreadOperationRequests: { key: "platform.reconcile.lifecycle.thread_operation_requests", fallback: 15, min: THREAD_MIN_REQUESTS, max: RECONCILE_REQUEST_HARD_MAX },
  lifecyclePublicationLaneMaxRequests: { key: "platform.reconcile.lifecycle.publication_lane_max_requests", fallback: 40, min: PUBLICATION_MIN_REQUESTS, max: RECONCILE_REQUEST_HARD_MAX },
  lifecycleSelectLimit: { key: "platform.reconcile.lifecycle.select_limit", fallback: 10, min: 1, max: RECONCILE_SELECT_HARD_MAX },
  lifecycleMaxAttempts: { key: "platform.reconcile.lifecycle.max_attempts", fallback: 5, min: 1, max: RECONCILE_ATTEMPTS_HARD_MAX },
  checkMaxRequests: { key: "platform.reconcile.check.max_requests", fallback: 100, min: CHECK_ROW_MIN_REQUESTS, max: RECONCILE_REQUEST_HARD_MAX },
  checkRunBudgetMs: { key: "platform.reconcile.check.run_budget_ms", fallback: 60_000, min: CHECK_RUN_MIN_MS, max: RECONCILE_RUN_HARD_MAX_MS },
  checkPerRequestMs: { key: "platform.reconcile.check.per_request_ms", fallback: 5_000, min: REQUEST_MIN_MS, max: RECONCILE_REQUEST_HARD_MAX_MS },
  checkRowMaxRequests: { key: "platform.reconcile.check.row_max_requests", fallback: 6, min: CHECK_ROW_MIN_REQUESTS, max: RECONCILE_REQUEST_HARD_MAX },
  checkSelectLimit: { key: "platform.reconcile.check.select_limit", fallback: 25, min: 1, max: RECONCILE_SELECT_HARD_MAX },
  checkMaxAttempts: { key: "platform.reconcile.check.max_attempts", fallback: 5, min: 1, max: RECONCILE_ATTEMPTS_HARD_MAX },
} satisfies Record<ReconcileField, { key: string; fallback: number; min: number; max: number }>;

export const RECONCILE_LIMITS = Object.fromEntries(RECONCILE_FIELDS.map((field) => {
  const { min, max } = RECONCILE_RULES[field];
  return [field, { min, max }];
})) as ReconcileLimits;

export const RECONCILE_DEFAULTS = Object.fromEntries(RECONCILE_FIELDS.map((field) => [field, RECONCILE_RULES[field].fallback])) as ReconcileValues;

export function invalidReconcileRelations(values: ReconcileValues): ReconcileField[] {
  const invalid: ReconcileField[] = [];
  if (values.lifecyclePerRequestMs > values.lifecycleRunBudgetMs) invalid.push("lifecyclePerRequestMs", "lifecycleRunBudgetMs");
  if (values.checkPerRequestMs > values.checkRunBudgetMs) invalid.push("checkPerRequestMs", "checkRunBudgetMs");
  if (values.lifecyclePublicationLaneMaxRequests > values.lifecycleMaxRequests) invalid.push("lifecyclePublicationLaneMaxRequests", "lifecycleMaxRequests");
  if (values.lifecycleThreadOperationRequests > values.lifecycleMaxRequests) invalid.push("lifecycleThreadOperationRequests", "lifecycleMaxRequests");
  if (values.lifecyclePublicationLaneMaxRequests + values.lifecycleThreadOperationRequests > values.lifecycleMaxRequests) invalid.push("lifecyclePublicationLaneMaxRequests", "lifecycleThreadOperationRequests");
  if (values.checkRowMaxRequests > values.checkMaxRequests) invalid.push("checkRowMaxRequests", "checkMaxRequests");
  return [...new Set(invalid)];
}
