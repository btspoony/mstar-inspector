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
import { PageSkeleton } from "../components/state/PageSkeleton";
import {
  INSIGHTS_WINDOWS,
  INSIGHTS_REPO_ALL,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  insightsSummaryUrl,
  insightsWindow,
  normalizeWindowSearch,
  parseInsights,
  parseInsightsSearch,
  searchHref,
  verdictLine,
  type InsightsSearch,
  type InsightsSummary,
} from "./data";
import { BarChart, type BarChartItem } from "@/components/charts/BarChart";
import { TrendChart } from "@/components/charts/TrendChart";

/**
 * The filter state as the location states it — the one derivation shared by
 * the mount initializer and the popstate re-sync (plan 49 F-15-02), built on
 * the pinned helpers (off-set windows resolve to the default segment).
 */
function insightsSearchFromLocation(): InsightsSearch {
  return {
    window: insightsWindow(window.location.search),
    repo: parseInsightsSearch(window.location.search).repo,
  };
}

/**
 * `/dashboard/insights` records page (plan 36 T2): review records with a
 * segmented window (INSIGHTS_WINDOWS 7/30/90) and a shadcn
 * Select repo filter (全部 + summary.repos). Free-text repo input retired.
 * Data plane: existing `/dashboard/api/insights/summary` plus the read-only
 * `repos` field (window-scoped distinct owner/repo, independent of `repo=`).
 * URL `repo=` shape is unchanged — out-of-set legal values stay applied.
 * Plan 49 F-15-02: after navigation the URL is the source of truth —
 * popstate re-derives the filter from the location (see the listener below);
 * in-page edits keep the reverse direction via commitSearch.
 * Plan 56 T2: the three stat sections (severity / category / weekly trend)
 * render as the hand-rolled SVG charts from components/charts; the
 * recurring-findings card stays a list.
 * Plan 60 T2 (A2-A5): the page joins the v0.3 language — heading-24 page
 * title, spacing-8 group rhythm, SectionCard tiers (overview = primary
 * surface, stat cards = secondary), and the plan-57 state trio
 * (PageSkeleton on the initial load, ErrorState with retry, EmptyState for
 * the zero-review window). Filter logic and the URL↔filter pins are
 * untouched.
 */
export function InsightsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [search, setSearch] = useState<InsightsSearch>(insightsSearchFromLocation);
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  // ErrorState retry (plan 60 A4): bumping the nonce re-runs the load
  // effect below for the current filter — the fetch body is unchanged.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Plan 36 QC F-002: an off-set legal window deep link (e.g. ?window=60)
  // resolves to the default segment 30 — rewrite the URL on mount so the
  // address bar reflects the applied filter.
  useEffect(() => {
    const normalized = normalizeWindowSearch(window.location.search);
    if (normalized !== window.location.search) {
      window.history.replaceState(null, "", `${window.location.pathname}${normalized}`);
    }
  }, []);

  // Plan 49 F-15-02: navigation re-sync. `navigate()` pushStates then
  // dispatches a synthetic popstate (router.tsx), so a same-route sidebar
  // click on a filtered view lands here with the now-bare location — the
  // filter resets along with the address bar. History back/forward fires a
  // native popstate carrying the entry's ?window=/?repo= — the filter is
  // restored to match. In-page edits go through commitSearch (replaceState —
  // never popstate), so this listener cannot loop against them; mount init
  // and the normalize rewrite above are untouched (registration only).
  useEffect(() => {
    const onPop = () => setSearch(insightsSearchFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
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
  }, [search.window, search.repo, reloadNonce]);

  function commitSearch(next: InsightsSearch): void {
    window.history.replaceState(null, "", searchHref("/dashboard/insights", next));
    setSearch(next);
  }

  function onWindowChange(next: string): void {
    // Radix fires "" when the active segment is re-clicked — keep the window.
    if (!(INSIGHTS_WINDOWS as readonly string[]).includes(next)) return;
    commitSearch({ window: next, repo: search.repo });
  }

  function onRepoChange(next: string): void {
    if (next === "") return;
    commitSearch({ window: search.window, repo: insightsRepoFromSelect(next) });
  }

  const repoChoices = insightsRepoOptions(data?.repos ?? [], search.repo);
  const repoSelectDisabled = state === "ok" && repoChoices.length === 0;

  // Loading rides the plan-57 skeleton as the page's full loading face —
  // the component's heading placeholder stands in for the real h1 (AD-582).
  // Initial load only: `data === null` gates it, so filter-change reloads
  // keep the page (and keyboard focus) mounted per the plan-38
  // background-reload contract; the refreshed data swaps in when it lands.
  if (state === "loading" && data === null) {
    return <PageSkeleton locale={locale} kind="cards" />;
  }

  return (
    <div className="flex flex-col gap-(--spacing-8)">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
          {t(locale, "insights.recordsHeading")}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
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
      </div>
      {state === "error" ? (
        <ErrorState locale={locale} onRetry={() => setReloadNonce((nonce) => nonce + 1)} />
      ) : null}
      {state === "ok" && data ? <InsightsRecordsView locale={locale} data={data} /> : null}
    </div>
  );
}

/**
 * AD-561 (plan 56): severity → DESIGN.md token series fills, applied as
 * `var(--token)` references (zero raw hex; dark/light both resolve through
 * the :root[data-theme] var chain). Unknown severity keys (future
 * vocabulary) fall through to the BarChart neutral series tone — the label
 * and count still render, color is never the only carrier.
 */
const SEVERITY_BAR_COLORS: Record<string, string> = {
  "must-fix": "var(--red-700)",
  "should-fix": "var(--amber-700)",
  nit: "var(--gray-700)",
};

/**
 * Exported for the SSR pins (plan 53 AppInfoCard idiom): pure `t()` + data
 * rendering, no window/router access, so tests can static-render it.
 */
export function InsightsRecordsView({ locale, data }: { locale: SpaBoot["locale"]; data: InsightsSummary }) {
  const windowLabel = t(locale, data.window_days === 1 ? "insights.lastDay" : "insights.lastDays", {
    count: data.window_days,
  });
  const repoLabel = data.repo ? ` · ${t(locale, "insights.repo", { repo: data.repo })}` : "";
  const empty = data.reviews_total === 0;
  // Window totals recomputed from the weekly buckets (plan 56 T2 summary
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
  // Plan 56 fix round 2 (PR 36 bugbot): the insights query groups NULL and
  // "" categories as separate rows, and both coalesce to the uncategorized
  // key below — per-row mapping emitted two identically keyed/labeled bars
  // (duplicate React keys, split counts). Aggregate by the coalesced key
  // first: one bar per key, counts summed, first-seen order preserved (Map
  // insertion order = the API row order). The falsy (not nullish) check
  // stays: "" is schema-permitted (review/schema.ts) and persists — same
  // face as NULL (plan 56 QC F-004).
  const categoryItems = [
    ...data.findings_by_category.reduce((merged, row) => {
      const key = row.category ? row.category : "uncategorized";
      const bar = merged.get(key);
      if (bar) {
        bar.value += row.count;
      } else {
        merged.set(key, {
          key,
          label: row.category ? row.category : t(locale, "insights.uncategorized"),
          value: row.count,
        });
      }
      return merged;
    }, new Map<string, BarChartItem>()).values(),
  ];

  return (
    <>
      {empty ? (
        // AD-601 presentation supersede (plan 60 A4): the plan-56
        // heading-card-only empty face is replaced by the composed
        // EmptyState. The judgment (`reviews_total === 0`) and the chart
        // layer contract are untouched, and no in-page action exists —
        // reviews arrive via installed Apps (no-action variant).
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
          {/* AD-591 rhythm: the four stat cards are one Tier 2 group —
              spacing-6 inside, spacing-8 to the rest of the page. */}
          <div className="flex flex-col gap-6">
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "insights.findingsBySeverity")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                {data.findings_by_severity.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t(locale, "insights.noFindings")}</p>
                ) : (
                  <BarChart
                    ariaLabel={t(locale, "insights.findingsBySeverity")}
                    items={data.findings_by_severity.map((row) => ({
                      key: row.severity,
                      label: row.severity,
                      value: row.count,
                      color: SEVERITY_BAR_COLORS[row.severity],
                    }))}
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
                  <BarChart
                    ariaLabel={t(locale, "insights.findingsByCategory")}
                    items={categoryItems}
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
                      locale={locale}
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
