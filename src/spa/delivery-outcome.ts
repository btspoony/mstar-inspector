import { t, type Locale } from "../i18n";

const OUTCOME_KEYS = {
  ok: "apps.health.outcome.ok",
  paused: "apps.health.outcome.paused",
  ignored: "apps.health.outcome.ignored",
  rejected: "apps.health.outcome.rejected",
  skipped: "apps.health.outcome.skipped",
  refused: "apps.health.outcome.refused",
} as const;

type OutcomeKey = (typeof OUTCOME_KEYS)[keyof typeof OUTCOME_KEYS];

export function deliveryOutcomeLabel(outcome: string, locale: Locale): string {
  const key: OutcomeKey | null = Object.hasOwn(OUTCOME_KEYS, outcome)
    ? OUTCOME_KEYS[outcome as keyof typeof OUTCOME_KEYS]
    : null;
  return key === null ? outcome : t(locale, key);
}
