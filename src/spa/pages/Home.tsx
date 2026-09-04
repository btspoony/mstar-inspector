import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { insightsSummaryUrl, parseInsights, type InsightsSummary } from "./data";
import { HOME_WINDOWS, homeWindow, searchHref, verdictLine, type HomeDimension, type HomeWindow } from "./homeModel";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

/**
 * `/dashboard` home (plan 36 T1): the overall insights summary promoted to
 * the home surface — read-only, zero native select/input. Window (7/30/90,
 * a legal subset of the existing API window domain) and the findings
 * breakdown dimension switch via segmented ToggleGroup controls. Data plane
 * unchanged: the existing `/dashboard/api/insights/summary` JSON face.
 * The repo filter lives on the records page (`/dashboard/insights`, T2).
 */
export function HomePage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [windowDays, setWindowDays] = useState<HomeWindow>(() => homeWindow(window.location.search));
  const [dimension, setDimension] = useState<HomeDimension>("severity");
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchJson(insightsSummaryUrl({ window: windowDays, repo: "" }))
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
  }, [windowDays]);

  function onWindowChange(next: string): void {
    // Radix fires "" when the active segment is re-clicked — keep the window.
    if (!(HOME_WINDOWS as readonly string[]).includes(next)) return;
    window.history.replaceState(null, "", searchHref("/dashboard", { window: next, repo: "" }));
    setWindowDays(next as HomeWindow);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "home.insightsHeading")}</h1>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={windowDays}
          onValueChange={onWindowChange}
          aria-label={t(locale, "insights.windowSegment")}
        >
          {HOME_WINDOWS.map((days) => (
            <ToggleGroupItem key={days} value={days}>
              {t(locale, "insights.daysShort", { count: Number(days) })}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {state === "ok" && data ? (
        <InsightsHomeView locale={locale} data={data} dimension={dimension} onDimensionChange={setDimension} />
      ) : null}
    </div>
  );
}

function InsightsHomeView({
  locale,
  data,
  dimension,
  onDimensionChange,
}: {
  locale: SpaBoot["locale"];
  data: InsightsSummary;
  dimension: HomeDimension;
  onDimensionChange: (next: HomeDimension) => void;
}) {
  const windowLabel = t(locale, data.window_days === 1 ? "insights.lastDay" : "insights.lastDays", {
    count: data.window_days,
  });
  const empty = data.reviews_total === 0;
  const maxSeverity = Math.max(1, ...data.findings_by_severity.map((row) => row.count));

  function onDimensionValue(next: string): void {
    if (next === "severity" || next === "category") onDimensionChange(next);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t(locale, "insights.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p>{t(locale, "insights.window", { label: windowLabel })}</p>
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
              <CardTitle>
                {t(locale, dimension === "severity" ? "insights.findingsBySeverity" : "insights.findingsByCategory")}
              </CardTitle>
              <CardAction>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={dimension}
                  onValueChange={onDimensionValue}
                  aria-label={t(locale, "insights.dimension")}
                >
                  <ToggleGroupItem value="severity">{t(locale, "insights.dimSeverity")}</ToggleGroupItem>
                  <ToggleGroupItem value="category">{t(locale, "insights.dimCategory")}</ToggleGroupItem>
                </ToggleGroup>
              </CardAction>
            </CardHeader>
            <CardContent>
              {dimension === "severity" ? (
                data.findings_by_severity.length === 0 ? (
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
                )
              ) : data.findings_by_category.length === 0 ? (
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
