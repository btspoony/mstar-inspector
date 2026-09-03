/**
 * Pure helpers for the `/dashboard` insights home (plan 30 T1+T3 hrefs,
 * plan 36 T1 segmented model). Named `homeModel` so it does not collide
 * with `Home.tsx` on case-insensitive filesystems. Tested without a DOM
 * runner.
 */
import { parseInsightsSearch, type InsightsSearch, type InsightsSummary } from "./data";

/**
 * Segmented window options (days) for the home ToggleGroup — a legal subset
 * of the API window domain (`^\d+$`, store clamp ≤90), zero API extension.
 */
export const HOME_WINDOWS = ["7", "30", "90"] as const;
export type HomeWindow = (typeof HOME_WINDOWS)[number];

/** Findings breakdown dimensions switched by the home segmented control. */
export type HomeDimension = "severity" | "category";

/**
 * Home window from the URL: the `window` param when it is one of
 * HOME_WINDOWS, else the default 30. Arbitrary integer windows stay legal
 * on the API (and on `/dashboard/insights` deep links), but the home
 * surface only offers the segmented set, so off-set values resolve to the
 * default instead of leaving the control without an active segment.
 */
export function homeWindow(search: string): HomeWindow {
  const raw = parseInsightsSearch(search).window;
  return (HOME_WINDOWS as readonly string[]).includes(raw) ? (raw as HomeWindow) : "30";
}

export function searchHref(pathname: "/dashboard" | "/dashboard/insights", search: InsightsSearch): string {
  const params = new URLSearchParams();
  if (search.window !== "" && search.window !== "30") params.set("window", search.window);
  if (search.repo !== "") params.set("repo", search.repo);
  const query = params.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

export function verdictLine(data: InsightsSummary): string {
  return data.verdict_distribution.map((row) => `${row.verdict} ${row.count}`).join(" · ");
}
