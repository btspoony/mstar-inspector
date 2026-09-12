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
 * Plan 65 (AD-652) adds the distribution bucket-grid generators here — the
 * single copy of the bucket-boundary math, imported by the store itself
 * (still zero imports from store/pipeline/review) and by its tests:
 *
 *   - `dayGrid`   — every UTC date the window predicate can return
 *   - `weekGrid`  — every Monday-anchored week intersecting the window
 *     (anchored via `mondayOf`, so the grid shares the weekly_trend week
 *     definition; never a second one)
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

/** Epoch ms of the current UTC date at midnight. */
function utcTodayMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** `YYYY-MM-DD` for an epoch-ms UTC midnight. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every UTC date the insights window predicate can return, ascending:
 * `today - windowDays` .. `today` (plan 65 distribution day grid). The
 * window cut is time-of-day (`datetime('now', '-' || N || ' days')`), so a
 * review on the first date only lands after the cut — the same partial-edge
 * convention as `weekGrid`'s first/last partial Mondays.
 */
export function dayGrid(windowDays: number): string[] {
  const today = utcTodayMs();
  const grid: string[] = [];
  for (let ms = today - windowDays * 86_400_000; ms <= today; ms += 86_400_000) {
    grid.push(isoDate(ms));
  }
  return grid;
}

/**
 * Every Monday-anchored UTC week intersecting the insights window, ascending
 * (plan 65 distribution week grid): `mondayOf(today - windowDays)` ..
 * `mondayOf(today)`. Anchored via `mondayOf` — the SAME week definition as
 * the store's weekly_trend SQL, never a second one. First and last weeks are
 * partial (the window cuts mid-week).
 */
export function weekGrid(windowDays: number): string[] {
  const today = utcTodayMs();
  const first = Date.parse(mondayOf(isoDate(today - windowDays * 86_400_000)));
  const last = Date.parse(mondayOf(isoDate(today)));
  const grid: string[] = [];
  for (let ms = first; ms <= last; ms += 7 * 86_400_000) {
    grid.push(isoDate(ms));
  }
  return grid;
}
