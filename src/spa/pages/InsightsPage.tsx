import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import {
  HOME_WINDOWS,
  INSIGHTS_REPO_ALL,
  homeWindow,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  insightsSummaryUrl,
  normalizeWindowSearch,
  parseInsights,
  parseInsightsSearch,
  searchHref,
  verdictLine,
  type InsightsSearch,
  type InsightsSummary,
} from "./data";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

/**
 * `/dashboard/insights` records page (plan 36 T2): review records with a
 * segmented window (HOME_WINDOWS 7/30/90) and a shadcn
 * Select repo filter (全部 + summary.repos). Free-text repo input retired.
 * Data plane: existing `/dashboard/api/insights/summary` plus the read-only
 * `repos` field (window-scoped distinct owner/repo, independent of `repo=`).
 * URL `repo=` shape is unchanged — out-of-set legal values stay applied.
 */
export function InsightsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [search, setSearch] = useState<InsightsSearch>(() => ({
    window: homeWindow(window.location.search),
    repo: parseInsightsSearch(window.location.search).repo,
  }));
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  // Plan 36 QC F-002: an off-set legal window deep link (e.g. ?window=60)
  // resolves to the default segment 30 — rewrite the URL on mount so the
  // address bar reflects the applied filter.
  useEffect(() => {
    const normalized = normalizeWindowSearch(window.location.search);
    if (normalized !== window.location.search) {
      window.history.replaceState(null, "", `${window.location.pathname}${normalized}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    // include=repos: the records Select needs the window-scoped distinct
    // repo set (plan 36 QC F-001); default summary reads stay cheap.
    fetchJson(insightsSummaryUrl(search, true))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseInsights(raw);
        if (!parsed) {
          setState("error");
          return;
        }
        setData(parsed);
        setState("ok");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [search.window, search.repo]);

  function commitSearch(next: InsightsSearch): void {
    window.history.replaceState(null, "", searchHref("/dashboard/insights", next));
    setSearch(next);
  }

  function onWindowChange(next: string): void {
    // Radix fires "" when the active segment is re-clicked — keep the window.
    if (!(HOME_WINDOWS as readonly string[]).includes(next)) return;
    commitSearch({ window: next, repo: search.repo });
  }

  function onRepoChange(next: string): void {
    if (next === "") return;
    commitSearch({ window: search.window, repo: insightsRepoFromSelect(next) });
  }

  const repoChoices = insightsRepoOptions(data?.repos ?? [], search.repo);
  const repoSelectDisabled = state === "ok" && repoChoices.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "insights.recordsHeading")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={search.window}
            onValueChange={onWindowChange}
            aria-label={t(locale, "insights.windowSegment")}
          >
            {HOME_WINDOWS.map((days) => (
              <ToggleGroupItem key={days} value={days}>
                {t(locale, "insights.daysShort", { count: Number(days) })}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select
            value={insightsRepoSelectValue(search.repo)}
            onValueChange={onRepoChange}
            disabled={repoSelectDisabled}
          >
            <SelectTrigger className="min-w-48" size="sm" aria-label={t(locale, "insights.filterRepo")}>
              <SelectValue placeholder={t(locale, "insights.filterRepoAll")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INSIGHTS_REPO_ALL}>{t(locale, "insights.filterRepoAll")}</SelectItem>
              {repoChoices.map((repo) => (
                <SelectItem key={repo} value={repo}>
                  {repo}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {state === "ok" && data ? <InsightsRecordsView locale={locale} data={data} /> : null}
    </div>
  );
}

function InsightsRecordsView({ locale, data }: { locale: SpaBoot["locale"]; data: InsightsSummary }) {
  const windowLabel = t(locale, data.window_days === 1 ? "insights.lastDay" : "insights.lastDays", {
    count: data.window_days,
  });
  const repoLabel = data.repo ? ` · ${t(locale, "insights.repo", { repo: data.repo })}` : "";
  const empty = data.reviews_total === 0;
  const maxSeverity = Math.max(1, ...data.findings_by_severity.map((row) => row.count));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "insights.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p>{t(locale, "insights.window", { label: `${windowLabel}${repoLabel}` })}</p>
          <p>{t(locale, "insights.reviewsTotal", { count: data.reviews_total })}</p>
          {empty ? (
            <p className="text-muted-foreground">{t(locale, "insights.noReviews")}</p>
          ) : (
            <p>{t(locale, "insights.verdicts", { line: verdictLine(data) })}</p>
          )}
        </CardContent>
      </Card>
      {empty ? null : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t(locale, "insights.findingsBySeverity")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.findings_by_severity.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(locale, "insights.noFindings")}</p>
              ) : (
                <ul className="flex flex-col">
                  {data.findings_by_severity.map((row) => (
                    <li
                      key={row.severity}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-3 last:border-b-0 last:pb-0"
                    >
                      <strong className="text-sm font-medium">{row.severity}</strong>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {t(locale, row.count === 1 ? "insights.finding" : "insights.findings", { count: row.count })}
                      </span>
                      <span
                        className="h-2 basis-full rounded-sm bg-primary"
                        style={{ width: `${Math.round((row.count / maxSeverity) * 100)}%` }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t(locale, "insights.findingsByCategory")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.findings_by_category.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(locale, "insights.noFindings")}</p>
              ) : (
                <ul className="flex flex-col">
                  {data.findings_by_category.map((row) => (
                    <li
                      key={row.category ?? "uncategorized"}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-3 last:border-b-0 last:pb-0"
                    >
                      <strong className="text-sm font-medium">
                        {row.category ?? t(locale, "insights.uncategorized")}
                      </strong>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {t(locale, row.count === 1 ? "insights.finding" : "insights.findings", { count: row.count })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t(locale, "insights.weeklyTrend")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.weekly_trend.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(locale, "insights.noReviews")}</p>
              ) : (
                <ul className="flex flex-col">
                  {data.weekly_trend.map((row) => (
                    <li
                      key={row.week_start}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-3 last:border-b-0 last:pb-0"
                    >
                      <strong className="text-sm font-medium tabular-nums">{row.week_start}</strong>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {t(locale, row.reviews === 1 ? "insights.review" : "insights.reviews", { count: row.reviews })}
                        {" · "}
                        {t(locale, row.findings === 1 ? "insights.finding" : "insights.findings", {
                          count: row.findings,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t(locale, "insights.recurringFindings")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.recurring_top.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(locale, "insights.noRecurring")}</p>
              ) : (
                <ul className="flex flex-col">
                  {data.recurring_top.map((row) => (
                    <li
                      key={row.fingerprint}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-3 last:border-b-0 last:pb-0"
                    >
                      <strong className="text-sm font-medium">{row.title_sample}</strong>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {t(locale, row.count === 1 ? "insights.review" : "insights.reviews", { count: row.count })}
                        {" · "}
                        {row.repos.join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
