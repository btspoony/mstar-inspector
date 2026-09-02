import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import styles from "../pages.module.css";
import { formatRelativeTime } from "../relative-time";
import { canManageApp, isPaused, parseApps, type AppsPayload } from "./data";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

export function AppsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<AppsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  async function load(): Promise<void> {
    setState("loading");
    try {
      const parsed = parseApps(await fetchJson("/dashboard/api/apps"));
      if (!parsed) {
        setState("error");
        return;
      }
      setPayload(parsed);
      setState("ok");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    void load();
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t(locale, "apps.heading")}</h1>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {state === "ok" && payload ? <AppsList boot={boot} payload={payload} onAction={load} /> : null}
    </div>
  );
}

async function runAppAction(path: string, reload: () => Promise<void>): Promise<void> {
  await postForm(path, {});
  await reload();
}

function AppsList({
  boot,
  payload,
  onAction,
}: {
  boot: SpaBoot;
  payload: AppsPayload;
  onAction: () => Promise<void>;
}) {
  const locale = boot.locale;
  return (
    <section className={styles.card}>
      {payload.apps.length === 0 ? <p className={styles.status}>{t(locale, "apps.empty")}</p> : null}
      <ul className={styles.list}>
        {payload.apps.map((app) => {
          const manageable = canManageApp(payload.viewer, app);
          const paused = isPaused(app);
          const badge =
            app.status === "disabled" ? (
              <span className={`${styles.badge} ${styles.badgeWarn}`}>{t(locale, "apps.status.disabled")}</span>
            ) : paused ? (
              <span className={`${styles.badge} ${styles.badgeWarn}`}>{t(locale, "apps.status.paused")}</span>
            ) : (
              <span className={styles.badge}>{t(locale, "apps.status.active")}</span>
            );
          const latest = app.health.latest;
          return (
            <li key={app.slug}>
              <strong>{app.slug}</strong>
              <span className={styles.meta}>
                {t(locale, "apps.appId", { id: app.github_app_id })} · {t(locale, "apps.by", { login: app.created_by })}
              </span>
              {badge}
              <span className={styles.meta}>
                {latest
                  ? t(locale, "apps.health.delivery", { time: formatRelativeTime(latest.created_at, locale) })
                  : t(locale, "apps.health.deliveryNever")}
                {latest ? ` ${latest.outcome}` : ""}
                {app.health.rejected24h > 0
                  ? ` · ${t(locale, "apps.health.rejected24h", { count: app.health.rejected24h })}`
                  : ""}
              </span>
              {manageable ? (
                <span className={styles.controls}>
                  <a className={`${styles.btnSecondary} ${styles.btnSmall}`} href={`/dashboard/apps/${app.slug}/settings`}>
                    {t(locale, "apps.settings")}
                  </a>
                  {app.status === "active" ? (
                    paused ? (
                      <button
                        className={`${styles.btnSecondary} ${styles.btnSmall}`}
                        type="button"
                        onClick={() => void runAppAction(`/dashboard/apps/${app.slug}/resume`, onAction)}
                      >
                        {t(locale, "apps.actions.resume")}
                      </button>
                    ) : (
                      <button
                        className={`${styles.btnSecondary} ${styles.btnSmall}`}
                        type="button"
                        onClick={() => void runAppAction(`/dashboard/apps/${app.slug}/pause`, onAction)}
                      >
                        {t(locale, "apps.actions.pause")}
                      </button>
                    )
                  ) : null}
                  {app.status === "active" ? (
                    <button
                      className={`${styles.btnSecondary} ${styles.btnSmall}`}
                      type="button"
                      onClick={() => void runAppAction(`/dashboard/apps/${app.slug}/disable`, onAction)}
                    >
                      {t(locale, "apps.actions.disable")}
                    </button>
                  ) : (
                    <button
                      className={`${styles.btnSecondary} ${styles.btnSmall}`}
                      type="button"
                      onClick={() => void runAppAction(`/dashboard/apps/${app.slug}/enable`, onAction)}
                    >
                      {t(locale, "apps.actions.enable")}
                    </button>
                  )}
                  <button
                    className={`${styles.btnDanger} ${styles.btnSmall}`}
                    type="button"
                    onClick={() => void runAppAction(`/dashboard/apps/${app.slug}/delete`, onAction)}
                  >
                    {t(locale, "apps.actions.delete")}
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <form method="post" action="/dashboard/manifest/start">
        <button className={styles.btnPrimary} type="submit">
          {t(locale, "apps.create")}
        </button>
      </form>
    </section>
  );
}
