/**
 * Pure helpers for the `/dashboard` workbench (plan 30 T1+T3).
 * Named `homeModel` so it does not collide with `Home.tsx` on
 * case-insensitive filesystems. Tested without a DOM runner.
 */
import type { InsightsSearch, InsightsSummary } from "./data";

export function searchHref(pathname: "/dashboard" | "/dashboard/insights", search: InsightsSearch): string {
  const params = new URLSearchParams();
  if (search.window !== "" && search.window !== "30") params.set("window", search.window);
  if (search.repo !== "") params.set("repo", search.repo);
  const query = params.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

export function latestWeek(
  data: InsightsSummary,
): { week_start: string; reviews: number; findings: number } | null {
  return data.weekly_trend[data.weekly_trend.length - 1] ?? null;
}

export function verdictLine(data: InsightsSummary): string {
  return data.verdict_distribution.map((row) => `${row.verdict} ${row.count}`).join(" · ");
}
