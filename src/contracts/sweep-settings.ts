export const SWEEP_FIELDS = [
  "failureThreshold",
  "windowHours",
  "webhookTimeoutMs",
  "retentionDays",
  "retentionCap",
  "inviteLapseCap",
] as const;

export type SweepField = (typeof SWEEP_FIELDS)[number];
export type SweepValues = Record<SweepField, number>;
export type SweepLimits = Record<SweepField, { min: number; max: number }>;

export type SweepConfig = {
  values: SweepValues;
  limits: SweepLimits;
  degraded: boolean;
};
