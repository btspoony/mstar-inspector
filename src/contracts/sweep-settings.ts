export const SWEEP_FIELDS = [
  "failureThreshold",
  "windowHours",
  "webhookTimeoutMs",
  "retentionDays",
  "retentionCap",
  "inviteLapseCap",
  "pullRequestRetentionDays",
  "pullRequestRetentionCap",
] as const;

export type SweepField = (typeof SWEEP_FIELDS)[number];
export type SweepValues = Record<SweepField, number>;
export type SweepLimits = Record<SweepField, { min: number; max: number }>;

export type SweepConfig = {
  values: SweepValues;
  limits: SweepLimits;
  degraded: boolean;
  /** Fields whose stored row is invalid; empty when the read itself failed. */
  invalid: SweepField[];
};
