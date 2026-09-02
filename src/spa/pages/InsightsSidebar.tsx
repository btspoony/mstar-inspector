import { useEffect, useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import styles from "../pages.module.css";
import homeStyles from "../Home.module.css";
import { navigate } from "../router";
import { insightsSummaryUrl, parseInsights, parseInsightsSearch, type InsightsSearch, type InsightsSummary } from "./data";
import { latestWeek, searchHref, verdictLine } from "./homeModel";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

export function InsightsSidebar({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [search, setSearch] = useState(() => parseInsightsSearch(window.location.search));
  const [data, setData] = useState<InsightsSummary | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchJson(insightsSummaryUrl(search))
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

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next: InsightsSearch = {
      window: String(form.get("window") ?? "30"),
      repo: String(form.get("repo") ?? "").trim(),
    };
    window.history.replaceState(null, "", searchHref("/dashboard", next));
    setSearch(next);
  }

  const fullHref = searchHref("/dashboard/insights", search);

  return (
    <>
      <h2>{t(locale, "home.insightsHeading")}</h2>
      <form className={styles.filters} onSubmit={onSubmit}>
        <label className={styles.field}>
          {t(locale, "insights.filterWindow")}
          <select name="window" defaultValue={search.window}>
            <option value="7">7</option>
            <option value="30">30</option>
            <option value="90">90</option>
          </select>
        </label>
        <label className={styles.field}>
          {t(locale, "insights.filterRepo")}
          <input name="repo" defaultValue={search.repo} placeholder={t(locale, "insights.filterRepoPlaceholder")} />
        </label>
        <button className={styles.btnPrimary} type="submit">
          {t(locale, "insights.apply")}
        </button>
      </form>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {state === "ok" && data ? <InsightsSidebarView locale={locale} data={data} /> : null}
      <a
        className={homeStyles.textLink}
        href={fullHref}
        onClick={(event) => {
          if (event.defaultPrevented) return;
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(fullHref);
        }}
      >
        {t(locale, "home.viewFull")}
      </a>
    </>
  );
}

export function InsightsSidebarView({
  locale,
  data,
}: {
  locale: SpaBoot["locale"];
  data: InsightsSummary;
}) {
  const windowLabel = t(locale, data.window_days === 1 ? "insights.lastDay" : "insights.lastDays", {
    count: data.window_days,
  });
  const repoLabel = data.repo ? ` · ${t(locale, "insights.repo", { repo: data.repo })}` : "";
  const empty = data.reviews_total === 0;
  const maxSeverity = Math.max(1, ...data.findings_by_severity.map((row) => row.count));
  const trend = latestWeek(data);
  const line = verdictLine(data);

  return (
    <>
      <p className={styles.status}>{t(locale, "insights.window", { label: `${windowLabel}${repoLabel}` })}</p>
      <p className={styles.status}>{t(locale, "insights.reviewsTotal", { count: data.reviews_total })}</p>
      {empty ? (
        <p className={styles.note}>{t(locale, "insights.noReviews")}</p>
      ) : (
        <p className={styles.status}>{t(locale, "insights.verdicts", { line })}</p>
      )}
      {empty ? null : (
        <>
          <h2>{t(locale, "insights.findingsBySeverity")}</h2>
          {data.findings_by_severity.length === 0 ? (
            <p className={styles.status}>{t(locale, "insights.noFindings")}</p>
          ) : (
            <ul className={styles.list}>
              {data.findings_by_severity.map((row) => (
                <li key={row.severity}>
                  <strong>{row.severity}</strong>
                  <span className={styles.meta}>
                    {t(locale, row.count === 1 ? "insights.finding" : "insights.findings", { count: row.count })}
                  </span>
                  <span className={styles.bar} style={{ width: `${Math.round((row.count / maxSeverity) * 100)}%` }} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {trend ? (
        <p className={styles.status}>
          {t(locale, "home.trendHint", {
            week: trend.week_start,
            reviews: t(locale, trend.reviews === 1 ? "insights.review" : "insights.reviews", { count: trend.reviews }),
            findings: t(locale, trend.findings === 1 ? "insights.finding" : "insights.findings", {
              count: trend.findings,
            }),
          })}
        </p>
      ) : (
        <p className={styles.status}>{t(locale, "home.noTrend")}</p>
      )}
    </>
  );
}
