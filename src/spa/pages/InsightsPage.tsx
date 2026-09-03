import { useEffect, useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import styles from "../pages.module.css";
import { insightsSummaryUrl, parseInsights, parseInsightsSearch, type InsightsSummary } from "./data";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

export function InsightsPage({ boot }: { boot: SpaBoot }) {
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
    const next = {
      window: String(form.get("window") ?? "30"),
      repo: String(form.get("repo") ?? "").trim(),
    };
    const params = new URLSearchParams();
    if (next.window !== "30") params.set("window", next.window);
    if (next.repo !== "") params.set("repo", next.repo);
    const query = params.toString();
    const href = query === "" ? "/dashboard/insights" : `/dashboard/insights?${query}`;
    window.history.replaceState(null, "", href);
    setSearch(next);
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t(locale, "insights.heading")}</h1>
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
      {state === "ok" && data ? <InsightsView locale={locale} data={data} /> : null}
    </div>
  );
}

function InsightsView({ locale, data }: { locale: SpaBoot["locale"]; data: InsightsSummary }) {
  const windowLabel = t(locale, data.window_days === 1 ? "insights.lastDay" : "insights.lastDays", {
    count: data.window_days,
  });
  const repoLabel = data.repo ? ` · ${t(locale, "insights.repo", { repo: data.repo })}` : "";
  const empty = data.reviews_total === 0;
  const maxSeverity = Math.max(1, ...data.findings_by_severity.map((s) => s.count));
  const verdictLine = data.verdict_distribution.map((v) => `${v.verdict} ${v.count}`).join(" · ");

  return (
    <>
      <section className={styles.card}>
        <h2>{t(locale, "insights.heading")}</h2>
        <p className={styles.status}>{t(locale, "insights.window", { label: `${windowLabel}${repoLabel}` })}</p>
        <p className={styles.status}>{t(locale, "insights.reviewsTotal", { count: data.reviews_total })}</p>
        {empty ? (
          <p className={styles.note}>{t(locale, "insights.noReviews")}</p>
        ) : (
          <p className={styles.status}>{t(locale, "insights.verdicts", { line: verdictLine })}</p>
        )}
      </section>
      {empty ? null : (
        <>
          <section className={styles.card}>
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
          </section>
          <section className={styles.card}>
            <h2>{t(locale, "insights.findingsByCategory")}</h2>
            {data.findings_by_category.length === 0 ? (
              <p className={styles.status}>{t(locale, "insights.noFindings")}</p>
            ) : (
              <ul className={styles.list}>
                {data.findings_by_category.map((row) => (
                  <li key={row.category ?? "uncategorized"}>
                    <strong>{row.category ?? t(locale, "insights.uncategorized")}</strong>
                    <span className={styles.meta}>
                      {t(locale, row.count === 1 ? "insights.finding" : "insights.findings", { count: row.count })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={styles.card}>
            <h2>{t(locale, "insights.weeklyTrend")}</h2>
            {data.weekly_trend.length === 0 ? (
              <p className={styles.status}>{t(locale, "insights.noReviews")}</p>
            ) : (
              <ul className={styles.list}>
                {data.weekly_trend.map((row) => (
                  <li key={row.week_start}>
                    <strong>{row.week_start}</strong>
                    <span className={styles.meta}>
                      {t(locale, row.reviews === 1 ? "insights.review" : "insights.reviews", { count: row.reviews })}
                      {" · "}
                      {t(locale, row.findings === 1 ? "insights.finding" : "insights.findings", { count: row.findings })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={styles.card}>
            <h2>{t(locale, "insights.recurringFindings")}</h2>
            {data.recurring_top.length === 0 ? (
              <p className={styles.status}>{t(locale, "insights.noRecurring")}</p>
            ) : (
              <ul className={styles.list}>
                {data.recurring_top.map((row) => (
                  <li key={row.fingerprint}>
                    <strong>{row.title_sample}</strong>
                    <span className={styles.meta}>
                      {t(locale, row.count === 1 ? "insights.review" : "insights.reviews", { count: row.count })}
                      {" · "}
                      {row.repos.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
