import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import styles from "../pages.module.css";
import { formatRelativeTime } from "../relative-time";
import {
  isPaused,
  parseModels,
  parseSettings,
  splitModelChain,
  type ModelOptionGroup,
  type SettingsPayload,
} from "./data";
import { LoadFailedNotice, LoadingNotice, PageNotice, type NoticeKind } from "./PageNotice";

export function SettingsPage({ boot, slug }: { boot: SpaBoot; slug: string }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);

  async function load(): Promise<void> {
    setState("loading");
    try {
      const [settingsRaw, modelsRaw] = await Promise.all([
        fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/settings`),
        fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/models`),
      ]);
      if (cancelledRef.current) return;
      const parsed = parseSettings(settingsRaw);
      const models = parseModels(modelsRaw) ?? { groups: [] };
      if (!parsed) {
        setState("error");
        return;
      }
      setPayload(parsed);
      setGroups(models.groups);
      setState("ok");
    } catch {
      if (!cancelledRef.current) setState("error");
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
    // slug is the load key; load is recreated per render on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t(locale, "settings.title")}</h1>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {state === "ok" && payload ? (
        <SettingsView
          locale={locale}
          payload={payload}
          groups={groups}
          onNotice={setNotice}
          onReload={load}
        />
      ) : null}
    </div>
  );
}

function verifyReasonMessage(locale: SpaBoot["locale"], reason: string): string {
  if (reason === "invalid_key") return t(locale, "settings.verify.invalid_key");
  if (reason === "unreachable") return t(locale, "settings.verify.unreachable");
  if (reason === "unsupported_provider") return t(locale, "settings.verify.unsupported_provider");
  return t(locale, "settings.verify.unexpected");
}

/** Membership 400s are JSON `{ code, message, selector }`; other settings 400s stay plaintext. */
function settingsErrorMessage(locale: SpaBoot["locale"], body: string): string {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown; selector?: unknown };
    if (parsed.code === "not_in_verified_models" && typeof parsed.selector === "string") {
      return t(locale, "settings.membership.not_in_verified_models", { selector: parsed.selector });
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    /* plaintext 400 — surface the server copy */
  }
  return body.trim() || t(locale, "common.loadFailed");
}

function SettingsView({
  locale,
  payload,
  groups,
  onNotice,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
  groups: ModelOptionGroup[];
  onNotice: (notice: { kind: NoticeKind; message: string } | null) => void;
  onReload: () => Promise<void>;
}) {
  const { app } = payload;
  const base = `/dashboard/apps/${app.slug}/settings`;
  const selectors = groups.flatMap((group) => group.selectors);
  const roleHint = (role: string) =>
    role === "mstar-review-seat" ? t(locale, "settings.roleHintReviewSeat") : t(locale, "settings.roleHintDeep");

  async function submitSettings(fields: Record<string, string>): Promise<void> {
    const { status, body } = await postForm(base, fields);
    if (status >= 400) {
      onNotice({ kind: "error", message: settingsErrorMessage(locale, body) });
      await onReload();
      return;
    }
    onNotice(null);
    await onReload();
  }

  async function submitVerify(fields: Record<string, string>): Promise<void> {
    const { status, body } = await postForm(
      `/dashboard/api/apps/${encodeURIComponent(app.slug)}/keys/verify`,
      fields,
    );
    if (status >= 400) {
      let reason = "unexpected";
      try {
        const parsed = JSON.parse(body) as { reason?: string };
        if (typeof parsed.reason === "string") reason = parsed.reason;
      } catch {
        /* body is not JSON — still a verify failure */
      }
      onNotice({ kind: "error", message: verifyReasonMessage(locale, reason) });
      await onReload();
      return;
    }
    onNotice({ kind: "success", message: t(locale, "settings.keyVerified") });
    await onReload();
  }

  async function submitPauseResume(path: string): Promise<void> {
    const { status } = await postForm(path, {});
    if (status >= 400) {
      onNotice({ kind: "error", message: t(locale, "common.loadFailed") });
      await onReload();
      return;
    }
    onNotice(null);
    await onReload();
  }

  return (
    <div className={styles.settingsLayout}>
      <div className={styles.settingsMain}>
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
                  <button
                    className={`${styles.btnDanger} ${styles.btnSmall}`}
                    type="button"
                    onClick={() =>
                      void postForm(`${base}/key/delete`, { provider: key.provider }).then(({ status, body }) => {
                        if (status >= 400) {
                          onNotice({ kind: "error", message: body.trim() || t(locale, "common.loadFailed") });
                        } else {
                          onNotice(null);
                        }
                        return onReload();
                      })
                    }
                  >
                    {t(locale, "settings.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <AddKeyForm locale={locale} providerIds={payload.provider_ids} onSubmit={submitVerify} />
          <p className={styles.note}>{t(locale, "settings.unsupportedProvidersHint")}</p>
        </section>

        <ModelChainCard
          locale={locale}
          groups={groups}
          stored={payload.model_chain}
          onSave={(chain) => void submitSettings({ op: "save-chain", model_chain: chain })}
        />

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
                  <button
                    className={`${styles.btnDanger} ${styles.btnSmall}`}
                    type="button"
                    onClick={() =>
                      void submitSettings({ op: "remove-custom-provider", provider_id: provider.provider_id })
                    }
                  >
                    {t(locale, "settings.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void submitSettings({
                op: "add-custom-provider",
                provider_id: String(data.get("provider_id") ?? ""),
                base_url: String(data.get("base_url") ?? ""),
                api: String(data.get("api") ?? ""),
                model_ids: String(data.get("model_ids") ?? ""),
                key: String(data.get("key") ?? ""),
              }).then(() => form.reset());
            }}
          >
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
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const fields: Record<string, string> = { op: "save-roles" };
              for (const role of payload.model_role_ids) {
                fields[`role_${role}`] = String(data.get(`role_${role}`) ?? "");
              }
              void submitSettings(fields);
            }}
          >
            {payload.model_role_ids.map((role) => {
              const stored = payload.model_roles[role] ?? "";
              return (
                <label className={styles.field} key={role}>
                  {role} — {roleHint(role)}
                  <select name={`role_${role}`} defaultValue={stored}>
                    <option value="">{t(locale, "settings.useAppChain")}</option>
                    {stored && !selectors.includes(stored) ? <option value={stored}>{stored}</option> : null}
                    {selectors.map((selector) => (
                      <option key={selector} value={selector}>
                        {selector}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            <button className={styles.btnPrimary} type="submit">
              {t(locale, "settings.saveRoleModels")}
            </button>
          </form>
        </section>
      </div>

      <aside className={styles.settingsSidebar} aria-label={t(locale, "settings.installHealth")}>
        <section>
          <h2>{t(locale, "settings.review")}</h2>
          <StatusBadge locale={locale} app={app} />
          {app.status !== "active" ? (
            <p className={styles.status}>{t(locale, "settings.disconnected")}</p>
          ) : app.review_enabled ? (
            <>
              <p className={styles.status}>{t(locale, "settings.reviewOn")}</p>
              <button className={styles.btnPrimary} type="button" onClick={() => void submitPauseResume(`/dashboard/apps/${app.slug}/pause`)}>
                {t(locale, "settings.pauseReviews")}
              </button>
            </>
          ) : (
            <>
              <p className={styles.status}>{t(locale, "settings.reviewPausedCopy")}</p>
              <button className={styles.btnPrimary} type="button" onClick={() => void submitPauseResume(`/dashboard/apps/${app.slug}/resume`)}>
                {t(locale, "settings.resumeReviews")}
              </button>
            </>
          )}
        </section>

        <section>
          <h2>{t(locale, "settings.installHealth")}</h2>
          <p className={styles.status}>
            {t(locale, "settings.lastWebhook", { time: formatRelativeTime(app.last_webhook_at, locale) })}
          </p>
          {payload.delivery_summary && payload.delivery_summary.rejected24h > 0 ? (
            <p className={styles.status}>
              {t(locale, "apps.health.rejected24h", { count: payload.delivery_summary.rejected24h })}
            </p>
          ) : null}
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

        <section>
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
      </aside>
    </div>
  );
}

function StatusBadge({
  locale,
  app,
}: {
  locale: SpaBoot["locale"];
  app: SettingsPayload["app"];
}) {
  const paused = isPaused({ status: app.status, review_enabled: app.review_enabled ? 1 : 0 });
  if (app.status === "disabled") {
    return <span className={`${styles.badge} ${styles.badgeWarn}`}>{t(locale, "apps.status.disabled")}</span>;
  }
  if (paused) {
    return <span className={`${styles.badge} ${styles.badgeWarn}`}>{t(locale, "apps.status.paused")}</span>;
  }
  return <span className={styles.badge}>{t(locale, "apps.status.active")}</span>;
}

function AddKeyForm({
  locale,
  providerIds,
  onSubmit,
}: {
  locale: SpaBoot["locale"];
  providerIds: readonly string[];
  onSubmit: (fields: Record<string, string>) => Promise<void>;
}) {
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        void onSubmit({
          provider: String(data.get("provider") ?? ""),
          key: String(data.get("key") ?? ""),
        }).then(() => form.reset());
      }}
    >
      <label className={styles.field}>
        {t(locale, "settings.provider")}
        <select name="provider" defaultValue="">
          <option value="" disabled>
            {t(locale, "settings.selectProvider")}
          </option>
          {providerIds.map((id) => (
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
  );
}

function ModelChainCard({
  locale,
  groups,
  stored,
  onSave,
}: {
  locale: SpaBoot["locale"];
  groups: ModelOptionGroup[];
  stored: string | null;
  onSave: (chain: string) => void;
}) {
  const [chain, setChain] = useState(() => splitModelChain(stored));
  const [pick, setPick] = useState("");

  useEffect(() => {
    setChain(splitModelChain(stored));
  }, [stored]);

  const options = groups.flatMap((group) => group.selectors);
  const probeProviders = groups.filter((group) => group.source === "probe");

  return (
    <section className={styles.card}>
      <h2>{t(locale, "settings.modelChain")}</h2>
      <p className={styles.lede}>{t(locale, "settings.modelChainCopy")}</p>
      <p className={styles.note}>{t(locale, "settings.modelChainNote")}</p>
      {options.length === 0 ? <p className={styles.status}>{t(locale, "settings.noVerifiedModels")}</p> : null}
      {probeProviders.map((group) => (
        <p className={styles.note} key={group.provider}>
          {group.provider}: {t(locale, "settings.noAutoDiscovery")}
        </p>
      ))}
      {chain.length === 0 ? (
        <p className={styles.status}>{t(locale, "settings.chainEmpty")}</p>
      ) : (
        <ul className={styles.chainList}>
          {chain.map((selector, index) => (
            <li className={styles.chainChip} key={`${selector}-${index}`}>
              <span className={styles.mono}>{selector}</span>
              <button
                className={`${styles.btnDanger} ${styles.btnSmall}`}
                type="button"
                onClick={() => setChain(chain.filter((_, i) => i !== index))}
              >
                {t(locale, "settings.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.addRow}>
        <label className={styles.field}>
          {t(locale, "settings.modelChainField")}
          <select value={pick} onChange={(event) => setPick(event.target.value)}>
            <option value="">{t(locale, "settings.pickModel")}</option>
            {groups.map((group) =>
              group.selectors.length === 0 ? null : (
                <optgroup key={group.provider} label={group.provider}>
                  {group.selectors.map((selector) => (
                    <option key={selector} value={selector}>
                      {selector}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>
        </label>
        <button
          className={styles.btnSecondary}
          type="button"
          onClick={() => {
            if (!pick) return;
            setChain([...chain, pick]);
            setPick("");
          }}
        >
          {t(locale, "settings.addToChain")}
        </button>
      </div>
      <button className={styles.btnPrimary} type="button" onClick={() => onSave(chain.join(", "))}>
        {t(locale, "settings.saveChain")}
      </button>
    </section>
  );
}
