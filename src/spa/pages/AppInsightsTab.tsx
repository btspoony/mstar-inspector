import { useEffect, useState } from "react";
import { t } from "../../i18n";
import {
  FlowSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import {
  INSIGHTS_WINDOWS,
  INSIGHTS_REPO_ALL,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  insightsTrendPoints,
  parseInsights,
  readScopeKey,
  scopedInsightsSummaryUrl,
  verdictLine,
  type AppDetailSearch,
  type FindingsDistributionBucket,
  type InsightsSummary,
  type ReadScope,
} from "./data";
import { StackedBarChart, type StackedSeries } from "@/components/charts/StackedBarChart";
import type { ChartSlot } from "@/components/charts/chartSlots";
import type { FindingSeverity } from "../../contracts/finding-severity";
import { TrendChart } from "@/components/charts/TrendChart";

/**
 * The 洞察 tab of a repository detail page — one target's review health, or
 * the whole workspace's ("所有仓库"). It rides the helpers kept
 * (`parseInsights`, `INSIGHTS_WINDOWS` segments, repo-select helpers) and the
 * shared charts.
 *
 * Data plane: the scope's summary face — `GET …/api/targets/:targetId/
 * insights/summary` for one repository, `GET …/api/insights/summary` for the
 * whole workspace — with `include=repos` for the repo Select (QC F-001
 * semantics unchanged).
 * Filter state is CONTROLLED by the hosting page shell: the shell derives
 * `{ tab, window, repo }` from the location via `parseAppDetailSearch`
 * (the one []-mounted popstate listener lives there), and every in-page
 * edit flows back through `onSearch` → the shell's `replaceState` commit —
 * loop-free by contract (knowledge spa-url-state-resync-popstate). This
 * component therefore owns only the fetch + presentation; the window/repo
 * segments reuse the 7/30/90 semantics and the repo filter is scoped to the
 * scope's own repos.
 * Toolbar first, then the summary, the severity stacked bar time series
 * from `findings_distribution` (AD-652 face carried over verbatim) and the
 * trend card as the grouped bucket chart at the window's granularity
 * (window-bucketing contract 2026-09-20 — `insightsTrendPoints`: day
 * buckets via `daily_trend` on 7/30-day windows, week buckets via
 * `weekly_trend` zero-filled over the distribution grid on 90 days).
 * QC fix-1 legend filter is unchanged. No
 * h1: the tab rides the shell's identity header (the shell mounts this
 * only for managers — 403s cannot occur for an authorized viewer).
 */
export function AppInsightsTab({
  locale,
  scope,
  search,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  scope: ReadScope;
  search: AppDetailSearch;
  onSearch: (next: AppDetailSearch) => void;
}) {
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [reloadNonce, setReloadNonce] = useState(0);
  const scopeKey = readScopeKey(scope);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchJson(scopedInsightsSummaryUrl(apiBase(), scope, search.window, search.repo))
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, search.window, search.repo, reloadNonce]);

  function onWindowChange(next: string): void {
    if (!(INSIGHTS_WINDOWS as readonly string[]).includes(next)) return;
    onSearch({ ...search, window: next as AppDetailSearch["window"] });
  }

  function onRepoChange(next: string): void {
    if (next === "") return;
    onSearch({ ...search, repo: insightsRepoFromSelect(next) });
  }

  const repoChoices = insightsRepoOptions(data?.repos ?? [], search.repo);
  const repoSelectDisabled = state === "ok" && repoChoices.length === 0;

  return (
    <div className="flex flex-col gap-6" aria-busy={state === "loading"}>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={search.window}
          onValueChange={onWindowChange}
          aria-label={t(locale, "insights.windowSegment")}
        >
          {INSIGHTS_WINDOWS.map((days) => (
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
      {state === "loading" && data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(locale, "common.loading")}
        </p>
      ) : null}
      {state === "loading" && data !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(locale, "common.loading")}
        </p>
      ) : null}
      {state === "error" && data === null ? (
        <ErrorState locale={locale} onRetry={() => setReloadNonce((nonce) => nonce + 1)} />
      ) : null}
      {state === "error" && data !== null ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {t(locale, "common.loadFailed")}
        </p>
      ) : null}
      {data !== null ? <InsightsRecordsView locale={locale} data={data} /> : null}
    </div>
  );
}

/**
 * AD-561: severity → the D14 closed chart vocabulary, as slots — the page owns
 * the semantics, the chart owns the faces. Red/amber keep their hue families
 * (must-fix=4, should-fix=3); nit takes the blue family (5), the neutral
 * data-series tone the old gray-700 filled (gray is not in the palette), and
 * may-fix takes the purple family (6), the slot the three-class stack left
 * free. The API zero-fills exactly these four merge-class keys per bucket, so
 * unknown severity keys never enter the series. Labels stay the raw engine
 * slugs — the aggregate card's visible face carried them unlocalized already.
 */
export const SEVERITY_SLOTS: Record<FindingSeverity, ChartSlot> = {
  "must-fix": 4,
  "should-fix": 3,
  "may-fix": 6,
  nit: 5,
};

const SEVERITY_SERIES: StackedSeries[] = Object.entries(SEVERITY_SLOTS).map(([key, slot]) => ({
  key,
  label: key,
  slot,
}));

function seriesWithFindings(
  series: readonly StackedSeries[],
  buckets: readonly FindingsDistributionBucket[],
): StackedSeries[] {
  return series.filter((s) => buckets.some((bucket) => (bucket.by_severity[s.key] ?? 0) > 0));
}

/**
 * The insights body — pure `t()` + data rendering, no window/router access,
 * so tests can static-render it (the AppInfoSection idiom). One content plane
 * divided by hairlines: the window's review health, the severity chart and
 * the trend. The chart series stay the closed six-slot vocabulary (fill =
 * `--chart-{n}`, legend swatch = `--chart-{n}-mark`).
 */
export function InsightsRecordsView({ locale, data }: { locale: SpaBoot["locale"]; data: InsightsSummary }) {
  const windowLabel = t(locale, data.window_days === 1 ? "insights.lastDay" : "insights.lastDays", {
    count: data.window_days,
  });
  const repoLabel = data.repo ? ` · ${t(locale, "insights.repo", { repo: data.repo })}` : "";
  const empty = data.reviews_total === 0;
  const trendPoints = insightsTrendPoints(data);
  const trendTotals = trendPoints.reduce(
    (totals, row) => ({ reviews: totals.reviews + row.reviews, findings: totals.findings + row.findings }),
    { reviews: 0, findings: 0 },
  );
  const trendSummary = t(locale, "insights.trendSummary", {
    reviews: t(locale, trendTotals.reviews === 1 ? "insights.review" : "insights.reviews", {
      count: trendTotals.reviews,
    }),
    findings: t(locale, trendTotals.findings === 1 ? "insights.finding" : "insights.findings", {
      count: trendTotals.findings,
    }),
  });
  const distribution = data.findings_distribution;

  if (empty) {
    return (
      <EmptyState
        title={t(locale, "insights.emptyTitle")}
        description={t(locale, "insights.emptyDescription")}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <FlowSection
        title={t(locale, "insights.heading")}
        subtitle={t(locale, "insights.window", { label: `${windowLabel}${repoLabel}` })}
      >
        <div className="flex flex-col gap-1 text-sm">
          <p className="tabular-nums">{t(locale, "insights.reviewsTotal", { count: data.reviews_total })}</p>
          <p className="tabular-nums">{t(locale, "insights.verdicts", { line: verdictLine(data) })}</p>
        </div>
      </FlowSection>
      <FlowSection title={t(locale, "insights.findingsBySeverity")}>
        {data.findings_by_severity.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "insights.noFindings")}</p>
        ) : (
          <StackedBarChart
            ariaLabel={t(locale, "insights.findingsBySeverity")}
            buckets={distribution}
            series={seriesWithFindings(SEVERITY_SERIES, distribution)}
          />
        )}
      </FlowSection>
      <FlowSection title={t(locale, "insights.trend")}>
        {trendPoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "insights.noReviews")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{trendSummary}</p>
            <TrendChart
              ariaLabel={t(locale, "insights.trend")}
              seriesLabels={{
                reviews: t(locale, "insights.seriesReviews"),
                findings: t(locale, "insights.seriesFindings"),
              }}
              points={trendPoints.map((row) => ({
                week: row.bucket_start,
                reviews: row.reviews,
                findings: row.findings,
              }))}
            />
          </div>
        )}
      </FlowSection>
    </div>
  );
}
