/**
 * i18n relative time for store-generated SQLite UTC stamps
 * (`YYYY-MM-DD HH:MM:SS`) — same buckets as `views.ts` relativeTime.
 */
import { t, type Locale } from "../i18n";

export function formatRelativeTime(value: string | null, locale: Locale, nowMs = Date.now()): string {
  if (value === null) return t(locale, "common.time.never");
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) return t(locale, "common.time.unknown");
  const then = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  const diffMs = nowMs - then;
  if (diffMs < 60_000) return t(locale, "common.time.justNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return t(locale, minutes === 1 ? "common.time.minuteAgo" : "common.time.minutesAgo", { count: minutes });
  }
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) {
    return t(locale, hours === 1 ? "common.time.hourAgo" : "common.time.hoursAgo", { count: hours });
  }
  const days = Math.floor(diffMs / 86_400_000);
  return t(locale, days === 1 ? "common.time.dayAgo" : "common.time.daysAgo", { count: days });
}
