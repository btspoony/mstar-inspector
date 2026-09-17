import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import {
  INSIGHTS_WINDOWS,
  INSIGHTS_REPO_ALL,
  appInsightsSummaryUrl,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  parseInsights,
  verdictLine,
  type AppDetailSearch,
  type FindingsDistributionBucket,
  type InsightsSummary,
} from "./data";
import { StackedBarChart, type StackedSeries } from "@/components/charts/StackedBarChart";
import { TrendChart } from "@/components/charts/TrendChart";

/**
 * The 洞察 tab of the App detail page (App detail IA) — the per-App
 * successor of the retired global insights page, rebuilt on the helpers
 * kept (`parseInsights`, `INSIGHTS_WINDOWS` segments, repo-select
 * helpers) and the shared charts. Closes the kept-helper consumer residual.
 *
 * Data plane: `GET /dashboard/api/apps/:slug/insights/summary`
 * with `include=repos` for the repo Select (QC F-001 semantics unchanged).
 * Filter state is CONTROLLED by the AppDetailPage shell: the shell derives
 * `{ tab, window, repo }` from the location via `parseAppDetailSearch`
 * (the one []-mounted popstate listener lives there), and every in-page
 * edit flows back through `onSearch` → the shell's `replaceState` commit —
 * loop-free by contract (knowledge spa-url-state-resync-popstate). This
 * component therefore owns only the fetch + presentation; the window/repo
 * segments reuse the 7/30/90 semantics and the repo filter is scoped to
 * this App's repos.
 * Toolbar first, then the four stat sections: severity / category as
 * stacked bar time series from `findings_distribution` (AD-652/653 faces
 * carried over verbatim), weekly trend as the grouped week-bucket chart,
 * recurring findings as a list. QC fix-1 legend filter and the QC F-004
 * ""→uncategorized merge are unchanged. No h1: the tab rides the shell's
 * identity header (the shell mounts this only for managers — 403s cannot
 * occur for an authorized viewer).
 */
export function AppInsightsTab({
  locale,
  slug,
  search,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  slug: string;
  search: AppDetailSearch;
  /** Shell-owned commit: replaceState + state update (never popstate). */
  onSearch: (next: AppDetailSearch) => void;
}) {
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  // ErrorState retry: bumping the nonce re-runs the load effect below
  // for the current filter — the fetch body is unchanged.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    // include=repos: the records Select needs the window-scoped distinct
    // repo set (QC F-001); default summary reads stay cheap.
    fetchJson(appInsightsSummaryUrl(slug, search.window, search.repo, true))
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
  }, [slug, search.window, search.repo, reloadNonce]);

  function onWindowChange(next: string): void {
    // Radix fires "" when the active segment is re-clicked — keep the window.
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
      {state === "loading" && data !== null ? (
        // Filter refetch over retained data (background reload): a
        // one-line polite hint; the toolbar above stays mounted and
        // interactive (the no-flash contract).
        <p role="status" className="text-sm text-muted-foreground">
          {t(locale, "common.loading")}
        </p>
      ) : null}
      {state === "error" ? <ErrorState locale={locale} onRetry={() => setReloadNonce((nonce) => nonce + 1)} /> : null}
      {state === "ok" && data ? <InsightsRecordsView locale={locale} data={data} /> : null}
    </div>
  );
}

/**
 * AD-561/AD-601: severity → DESIGN.md token series fills as
 * charts.css fill classes consumed by StackedBarChart — the AD-601-frozen
 * semantic family (must-fix=red-700 / should-fix=amber-700 / nit=gray-700);
 * colors ride class rules into the token layer (never presentation
 * attributes, never raw hex). The API zero-fills exactly these three
 * merge-class keys per bucket, so unknown severity keys never enter the
 * series. Labels stay the raw engine slugs — the aggregate card's visible
 * face carried them unlocalized already (same product ruling as the
 * category slugs below).
 */
export const SEVERITY_BAR_COLORS: Record<string, string> = {
  "must-fix": "chart-fill-red-700",
  "should-fix": "chart-fill-amber-700",
  nit: "chart-fill-gray-700",
};

/** The fixed severity stack, bottom → top: must-fix, should-fix, nit. */
const SEVERITY_SERIES: StackedSeries[] = Object.entries(SEVERITY_BAR_COLORS).map(([key, fillClass]) => ({
  key,
  label: key,
  fillClass,
}));

/**
 * AD-653 category palette: the known engine slugs take Δhue-distinct
 * families from the 700-step {teal, purple, pink} candidates (red/amber
 * stay severity-owned; blue-700 keeps its neutral data-series duty and is
 * deliberately NOT assigned to a single known category). Slugs outside this
 * map (long-tail vocabulary) ride the neutral blue-700 tone; the
 * "uncategorized" fallback (NULL/unknown) is the gray-700 series, stacked
 * last.
 */
export const CATEGORY_FILL_CLASSES: Record<string, string> = {
  DEBT: "chart-fill-teal-700",
  DOCS: "chart-fill-purple-700",
  SEC: "chart-fill-pink-700",
};
/** Neutral data-series default (the retired BarChart's fallback tone). */
const CATEGORY_TAIL_FILL_CLASS = "chart-fill-blue-700";
/** Store-merged fallback key for NULL/unknown categories. */
export const UNCATEGORIZED_KEY = "uncategorized";
const UNCATEGORIZED_FILL_CLASS = "chart-fill-gray-700";

/**
 * Category series from the window-level union key set of the
 * `findings_distribution` grids — the legend lists exactly the categories
 * present somewhere in the window, in stack order: known slugs (palette
 * order), remaining slugs (payload ASC order) on the neutral tone, the
 * gray fallback last (topmost segment). Key presence is the derivation
 * face; seriesWithFindings applies the zero-count legend filter on top.
 */
function categorySeries(buckets: readonly FindingsDistributionBucket[], locale: SpaBoot["locale"]): StackedSeries[] {
  const observed = new Set<string>();
  for (const bucket of buckets) {
    for (const key of Object.keys(bucket.by_category)) observed.add(key);
  }
  const series: StackedSeries[] = [];
  for (const [key, fillClass] of Object.entries(CATEGORY_FILL_CLASSES)) {
    if (observed.has(key)) series.push({ key, label: key, fillClass });
  }
  for (const key of observed) {
    // "" never labels a series (schema-permitted, QC F-004) — it
    // merges into the fallback key below.
    if (key === "" || key === UNCATEGORIZED_KEY || key in CATEGORY_FILL_CLASSES) continue;
    series.push({ key, label: key, fillClass: CATEGORY_TAIL_FILL_CLASS });
  }
  if (observed.has(UNCATEGORIZED_KEY) || observed.has("")) {
    series.push({
      key: UNCATEGORIZED_KEY,
      label: t(locale, "insights.uncategorized"),
      fillClass: UNCATEGORIZED_FILL_CLASS,
    });
  }
  return series;
}

/**
 * The chart buckets: the payload grid with the schema-permitted ""
 * category key merged into "uncategorized" per bucket (counts summed) so
 * the gray fallback series reads the honest total — the same
 * QC F-004 merge the aggregate card performed, one layer down.
 */
function chartBuckets(buckets: readonly FindingsDistributionBucket[]): FindingsDistributionBucket[] {
  return buckets.map((bucket) => {
    if (bucket.by_category[""] === undefined) return bucket;
    const { "": emptyCount, ...rest } = bucket.by_category;
    return {
      ...bucket,
      by_category: {
        ...rest,
        [UNCATEGORIZED_KEY]: (bucket.by_category[UNCATEGORIZED_KEY] ?? 0) + (emptyCount ?? 0),
      },
    };
  });
}

/**
 * QC fix-1 (QC F-004 ×3 seats): legend entries only for series
 * with findings in the window — a series whose window total is 0 drops
 * from the legend instead of rendering a zero-count swatch. Legend-only
 * filtering: every bucket stays on the axis/stack (time continuity) and
 * zero-height segments render no geometry either way.
 */
function seriesWithFindings(
  series: readonly StackedSeries[],
  buckets: readonly FindingsDistributionBucket[],
): StackedSeries[] {
  return series.filter((s) =>
    buckets.some((bucket) => (bucket.by_severity[s.key] ?? bucket.by_category[s.key] ?? 0) > 0),
  );
}

/**
 * The four insights stat sections — pure `t()` + data rendering, no
 * window/router access, so tests can static-render it (the AppInfoCard
 * idiom). Faces carried over verbatim from the retired global page.
 */
export function InsightsRecordsView({ locale, data }: { locale: SpaBoot["locale"]; data: InsightsSummary }) {
  const windowLabel = t(locale, data.window_days === 1 ? "insights.lastDay" : "insights.lastDays", {
    count: data.window_days,
  });
  const repoLabel = data.repo ? ` · ${t(locale, "insights.repo", { repo: data.repo })}` : "";
  const empty = data.reviews_total === 0;
  // Window totals recomputed from the weekly buckets (the summary
  // line — text counts coexisting with the trend chart).
  const trendTotals = data.weekly_trend.reduce(
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
  // The merged distribution grid both cards consume ("" merged into the
  // uncategorized key); the zero-count legend filter reads the same grid
  // the charts render.
  const distribution = chartBuckets(data.findings_distribution);

  return (
    <>
      {empty ? (
        // The composed zero-review empty state — no-action variant
        // (reviews arrive via installed Apps).
        <EmptyState
          title={t(locale, "insights.emptyTitle")}
          description={t(locale, "insights.emptyDescription")}
        />
      ) : (
        <>
          <SectionCard tier="primary">
            <CardHeader>
              <SectionCardTitle>{t(locale, "insights.heading")}</SectionCardTitle>
              <CardDescription>
                {t(locale, "insights.window", { label: `${windowLabel}${repoLabel}` })}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-sm">
              <p className="tabular-nums">{t(locale, "insights.reviewsTotal", { count: data.reviews_total })}</p>
              <p className="tabular-nums">{t(locale, "insights.verdicts", { line: verdictLine(data) })}</p>
            </CardContent>
          </SectionCard>
          {/* AD-591 rhythm: the four stat cards are one Tier 2 group. */}
          <div className="flex flex-col gap-6">
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "insights.findingsBySeverity")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                {data.findings_by_severity.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t(locale, "insights.noFindings")}</p>
                ) : (
                  <StackedBarChart
                    ariaLabel={t(locale, "insights.findingsBySeverity")}
                    buckets={distribution}
                    series={seriesWithFindings(SEVERITY_SERIES, distribution)}
                  />
                )}
              </CardContent>
            </SectionCard>
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "insights.findingsByCategory")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                {data.findings_by_category.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t(locale, "insights.noFindings")}</p>
                ) : (
                  <StackedBarChart
                    ariaLabel={t(locale, "insights.findingsByCategory")}
                    buckets={distribution}
                    series={seriesWithFindings(categorySeries(data.findings_distribution, locale), distribution)}
                  />
                )}
              </CardContent>
            </SectionCard>
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "insights.weeklyTrend")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                {data.weekly_trend.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t(locale, "insights.noReviews")}</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">{trendSummary}</p>
                    <TrendChart
                      ariaLabel={t(locale, "insights.weeklyTrend")}
                      seriesLabels={{
                        reviews: t(locale, "insights.seriesReviews"),
                        findings: t(locale, "insights.seriesFindings"),
                      }}
                      points={data.weekly_trend.map((row) => ({
                        week: row.week_start,
                        reviews: row.reviews,
                        findings: row.findings,
                      }))}
                    />
                  </div>
                )}
              </CardContent>
            </SectionCard>
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "insights.recurringFindings")}</SectionCardTitle>
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
            </SectionCard>
          </div>
        </>
      )}
    </>
  );
}
