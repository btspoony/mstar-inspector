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
