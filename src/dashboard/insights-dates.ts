
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

function utcTodayMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every UTC date the insights window predicate can return, ascending:
 * `today - windowDays` .. `today` (the distribution day grid). The
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
 * (the distribution week grid): `mondayOf(today - windowDays)` ..
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
