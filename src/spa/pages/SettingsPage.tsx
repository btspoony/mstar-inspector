import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import styles from "../pages.module.css";
import { formatRelativeTime } from "../relative-time";
import { parseSettings, type SettingsPayload } from "./data";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

export function SettingsPage({ boot, slug }: { boot: SpaBoot; slug: string }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/settings`)
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseSettings(raw);
        if (!parsed) {
          setState("error");
          return;
        }
        setPayload(parsed);
        setState("ok");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t(locale, "settings.title")}</h1>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {state === "ok" && payload ? <SettingsView locale={locale} payload={payload} /> : null}
    </div>
  );
}

function SettingsView({ locale, payload }: { locale: SpaBoot["locale"]; payload: SettingsPayload }) {
  const { app } = payload;
  const base = `/dashboard/apps/${app.slug}/settings`;
  const roleHint = (role: string) =>
    role === "mstar-review-seat" ? t(locale, "settings.roleHintReviewSeat") : t(locale, "settings.roleHintDeep");

  return (
    <>
      <section className={styles.card}>
        <h2>{t(locale, "settings.providerKeys")}</h2>
        <p className={styles.status}>{t(locale, "settings.providerKeysCopy", { slug: app.slug })}</p>
        {payload.keys.length === 0 ? (
          <p className={styles.status}>{t(locale, "settings.noKeys")}</p>
        ) : (
          <ul className={styles.list}>
            {payload.keys.map((key) => (
              <li key={key.provider}>
                <strong>{key.provider}</strong>
                <span className={styles.meta}>
                  {key.last4
                    ? t(locale, "settings.keyEnding", { last4: key.last4 })
                    : t(locale, "settings.keyTooShort")}
                  {" · "}
                  {key.updated_at
                    ? t(locale, "settings.updated", { time: formatRelativeTime(key.updated_at, locale) })
                    : "—"}
                </span>
                <form method="post" action={`${base}/key/delete`}>
                  <input type="hidden" name="provider" value={key.provider} />
                  <button className={`${styles.btnDanger} ${styles.btnSmall}`} type="submit">
                    {t(locale, "settings.remove")}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form className={styles.form} method="post" action={base}>
          <input type="hidden" name="op" value="add-key" />
          <label className={styles.field}>
            {t(locale, "settings.provider")}
            <select name="provider" defaultValue="">
              <option value="" disabled>
                {t(locale, "settings.selectProvider")}
              </option>
              {payload.provider_ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            {t(locale, "settings.apiKey")}
            <input
              type="password"
              name="key"
              autoComplete="new-password"
              placeholder={t(locale, "settings.apiKeyPlaceholder")}
            />
          </label>
          <button className={styles.btnPrimary} type="submit">
            {t(locale, "settings.addKey")}
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <h2>{t(locale, "settings.modelChain")}</h2>
        <p className={styles.lede}>{t(locale, "settings.modelChainCopy")}</p>
        <p className={styles.note}>{t(locale, "settings.modelChainNote")}</p>
        <form className={styles.form} method="post" action={base}>
          <input type="hidden" name="op" value="save-chain" />
          <label className={styles.field}>
            {t(locale, "settings.modelChainField")}
            <input type="text" name="model_chain" defaultValue={payload.model_chain ?? ""} />
          </label>
          <button className={styles.btnPrimary} type="submit">
            {t(locale, "settings.saveChain")}
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <h2>{t(locale, "settings.customProviders")}</h2>
        <p className={styles.lede}>{t(locale, "settings.customProvidersCopy")}</p>
        {payload.custom_providers.length === 0 ? (
          <p className={styles.status}>{t(locale, "settings.noCustomProviders")}</p>
        ) : (
          <ul className={styles.list}>
            {payload.custom_providers.map((provider) => (
              <li key={provider.provider_id}>
                <strong>{provider.provider_id}</strong>
                <span className={styles.meta}>
                  {provider.base_url} · {provider.api} · {provider.model_ids.join(", ")}
                </span>
                <form method="post" action={base}>
                  <input type="hidden" name="op" value="remove-custom-provider" />
                  <input type="hidden" name="provider_id" value={provider.provider_id} />
                  <button className={`${styles.btnDanger} ${styles.btnSmall}`} type="submit">
                    {t(locale, "settings.remove")}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form className={styles.form} method="post" action={base}>
          <input type="hidden" name="op" value="add-custom-provider" />
          <label className={styles.field}>
            {t(locale, "settings.providerId")}
            <input type="text" name="provider_id" pattern="[a-z0-9][a-z0-9-]{0,63}" />
          </label>
          <label className={styles.field}>
            {t(locale, "settings.baseUrl")}
            <input type="text" name="base_url" placeholder="https://api.example.com/v1" />
          </label>
          <label className={styles.field}>
            {t(locale, "settings.api")}
            <select name="api" defaultValue="">
              <option value="" disabled>
                {t(locale, "settings.selectApi")}
              </option>
              {payload.custom_provider_api_ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            {t(locale, "settings.modelIds")}
            <input type="text" name="model_ids" />
          </label>
          <label className={styles.field}>
            {t(locale, "settings.apiKey")}
            <input
              type="password"
              name="key"
              autoComplete="new-password"
              placeholder={t(locale, "settings.apiKeyPlaceholder")}
            />
          </label>
          <button className={styles.btnPrimary} type="submit">
            {t(locale, "settings.addCustomProvider")}
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <h2>{t(locale, "settings.roleModels")}</h2>
        <p className={styles.lede}>{t(locale, "settings.roleModelsCopy")}</p>
        <p className={styles.note}>{t(locale, "settings.emptyUsesAppChain")}</p>
        <form className={styles.form} method="post" action={base}>
          <input type="hidden" name="op" value="save-roles" />
          {payload.model_role_ids.map((role) => (
            <label className={styles.field} key={role}>
              {role} — {roleHint(role)}
              <input type="text" name={`role_${role}`} defaultValue={payload.model_roles[role] ?? ""} />
            </label>
          ))}
          <button className={styles.btnPrimary} type="submit">
            {t(locale, "settings.saveRoleModels")}
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <h2>{t(locale, "settings.review")}</h2>
        {app.status !== "active" ? (
          <p className={styles.status}>{t(locale, "settings.disconnected")}</p>
        ) : app.review_enabled ? (
          <>
            <p className={styles.status}>{t(locale, "settings.reviewOn")}</p>
            <form method="post" action={`/dashboard/apps/${app.slug}/pause`}>
              <button className={styles.btnPrimary} type="submit">
                {t(locale, "settings.pauseReviews")}
              </button>
            </form>
          </>
        ) : (
          <>
            <p>
              <span className={`${styles.badge} ${styles.badgeWarn}`}>{t(locale, "settings.reviewPaused")}</span>
            </p>
            <p className={styles.status}>{t(locale, "settings.reviewPausedCopy")}</p>
            <form method="post" action={`/dashboard/apps/${app.slug}/resume`}>
              <button className={styles.btnPrimary} type="submit">
                {t(locale, "settings.resumeReviews")}
              </button>
            </form>
          </>
        )}
      </section>

      <section className={styles.card}>
        <h2>{t(locale, "settings.installHealth")}</h2>
        <p className={styles.status}>
          {t(locale, "settings.lastWebhook", { time: formatRelativeTime(app.last_webhook_at, locale) })}
        </p>
        {payload.installations.length === 0 ? (
          <p className={styles.status}>{t(locale, "settings.noInstallations")}</p>
        ) : (
          <ul className={styles.list}>
            {payload.installations.map((inst) => (
              <li key={inst.installation_id}>
                <strong>{inst.account_login ?? t(locale, "common.time.unknown")}</strong>
                <span className={styles.meta}>
                  {t(locale, "settings.installation", { id: inst.installation_id })} ·{" "}
                  {t(locale, "settings.lastSeen", { time: formatRelativeTime(inst.seen_at, locale) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card}>
        <h2>{t(locale, "settings.recentDeliveries")}</h2>
        <p className={styles.status}>{t(locale, "settings.recentDeliveriesCopy")}</p>
        {payload.deliveries.length === 0 ? (
          <p className={styles.status}>{t(locale, "settings.noDeliveries")}</p>
        ) : (
          <ul className={styles.list}>
            {payload.deliveries.map((delivery, index) => (
              <li key={`${delivery.created_at}-${index}`}>
                <strong>{delivery.event_name ?? t(locale, "settings.unknownEvent")}</strong>
                <span className={styles.meta}>
                  {formatRelativeTime(delivery.created_at, locale)} · {delivery.outcome} ·{" "}
                  {t(locale, "settings.status", {
                    code: delivery.status_code === null ? "—" : String(delivery.status_code),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
