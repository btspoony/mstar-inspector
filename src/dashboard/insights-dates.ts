/**
 * Shared date helpers for the plan 22 insights surface (QC W-C): the ONE
 * copy of the UTC date math used by the insights store test, the T2 JSON
 * route test, and the T3 HTML panel test — previously duplicated verbatim
 * in all three files.
 *
 * `mondayOf` is a JS mirror of the store's Monday-anchored bucketing
 * expression (`date(reviewed_at, '-' || ((strftime('%w', reviewed_at)+6)%7)
 * || ' days')` in src/dashboard/insights-store.ts) — expected week values
 * are computed from the SAME seeded timestamps, so no clock race. Keep the
 * mirror and the SQL in lockstep; the concrete-date pin test
 * (tests/dashboard/insights-store.test.ts, S-1) anchors both to real
 * calendar dates.
 *
 * Dashboard leaf: zero imports from store/pipeline/review (AL-22-1
 * candidate A boundary — tests may import these helpers).
 */

/**
 * UTC datetime string N days before now, hour forced to 12:00 UTC — the
 * same `YYYY-MM-DD HH:MM:SS` format SQLite datetime('now') writes. The
 * fixed hour keeps the date part stable across the test's runtime.
 */
export function reviewedAt(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Monday-anchored week start (UTC, YYYY-MM-DD) for a SQLite datetime
 * string — a JS mirror of the store's bucketing expression, so expected
 * values are computed from the SAME seeded timestamps (no clock race).
 */
export function mondayOf(dt: string): string {
  const [y, m, d] = dt.split(" ")[0]!.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  const daysToMonday = (dow + 6) % 7;
  return new Date(Date.UTC(y!, m! - 1, d! - daysToMonday)).toISOString().slice(0, 10);
}
