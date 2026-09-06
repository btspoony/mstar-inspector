/**
 * Localized delivery-outcome label (plan 45 T2 / F-05). The producer-side
 * vocabulary is DELIVERY_OUTCOMES in src/dashboard/apps-store.ts (enforced
 * there before any row is written): `ok` = job enqueued, `paused` = the
 * App's review switch is off (2xx ignore), `ignored` = verified but not a
 * reviewable event, `rejected` = the classifier refused the delivery. Both
 * health surfaces (AppsPage latest-delivery cell, SettingsPage recent
 * deliveries) label the outcome through this one map; an off-vocabulary
 * value falls back to the raw string — fail-visible, never blank.
 */
import { t, type Locale } from "../i18n";

const OUTCOME_KEYS = {
  ok: "apps.health.outcome.ok",
  paused: "apps.health.outcome.paused",
  ignored: "apps.health.outcome.ignored",
  rejected: "apps.health.outcome.rejected",
} as const;

type OutcomeKey = (typeof OUTCOME_KEYS)[keyof typeof OUTCOME_KEYS];

export function deliveryOutcomeLabel(outcome: string, locale: Locale): string {
  const key: OutcomeKey | null = Object.hasOwn(OUTCOME_KEYS, outcome)
    ? OUTCOME_KEYS[outcome as keyof typeof OUTCOME_KEYS]
    : null;
  return key === null ? outcome : t(locale, key);
}
