import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import { StatusBadge } from "@design-system";
import { PageHeader } from "@/components/PageHeader";
import { PageNotice, type NoticeKind } from "./PageNotice";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { FlowSection } from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import { formatRelativeTime } from "../relative-time";
import { appDisplayName, modelChainTabs, parseBotSettings, splitModelChain, type BotSettingsPayload } from "./data";

/**
 * The bot settings page (`/dashboard/apps/:appId/bot`): the bot-owned
 * configuration — credentials health, provider keys, model chains, sandbox
 * image, installations. The workspace-owned review policy (identity, trigger,
 * depth, gate, allowlist, pause) stays on the target detail, which links here.
 *
 * `can_manage` is the page's ONLY permission bit, and the server computes it
 * for BOT-scoped writes: a `shared` bot reads as `false` whatever the caller's
 * workspace role is, so the sections render non-editable and the bot-scoped
 * POST family refuses the write the page would otherwise offer.
 */
export function BotSettingsPage({ boot, appId }: { boot: SpaBoot; appId: string }) {
  const locale = boot.locale;
  const base = apiBase();
  const [payload, setPayload] = useState<BotSettingsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<boolean> => {
      if (!background) setState("loading");
      try {
        const parsed = parseBotSettings(
          await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}/bot`),
        );
        if (!parsed) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return false;
        }
        if (cancelledRef.current) return false;
        setPayload(parsed);
        setState("ok");
        setNotice(null);
        return true;
      } catch {
        if (!cancelledRef.current) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
        }
        return false;
      }
    },
    [base, appId, locale],
  );

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  const detailHref = `${base}/apps/${encodeURIComponent(appId)}`;
  return (
    <BotSettingsShell locale={locale} detailHref={detailHref}>
      {state === "loading" ? <PageSkeleton locale={locale} kind="forms" /> : null}
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        <BotSettingsView locale={locale} payload={payload} notice={notice} />
      ) : null}
    </BotSettingsShell>
  );
}

/**
 * Wayfinding back to the target detail plus the page face. A separate
 * component so the rendered shell — link target included — is assertable
 * without a DOM runner.
 */
export function BotSettingsShell({
  locale,
  detailHref,
  children,
}: {
  locale: SpaBoot["locale"];
  detailHref: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <a
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
        href={detailHref}
      >
        <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
        {t(locale, "botSettings.backToDetail")}
      </a>
      {children}
    </div>
  );
}

/**
 * The page face — pure `t()` + data rendering, no window/router access, so the
 * tests can static-render it. Every section reports what the bot holds; the
 * manager's controls sit on the same sections, and a shared bot's page renders
 * the read-only faces.
 */
export function BotSettingsView({
  locale,
  payload,
  notice,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
  notice: { kind: NoticeKind; message: string } | null;
}) {
  const { app } = payload;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={appDisplayName(app)}
        description={t(locale, "botSettings.subtitle")}
        actions={
          <StatusBadge tone={app.scope === "shared" ? "neutral" : "success"}>
            {t(locale, app.scope === "shared" ? "botSettings.scopeShared" : "botSettings.scopeOwned")}
          </StatusBadge>
        }
      />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {payload.can_manage ? null : <PageNotice kind="warn" message={t(locale, "botSettings.readOnly")} />}
      <div className="flex flex-col">
        <BotHealthSection locale={locale} payload={payload} />
        <SandboxImageSection locale={locale} payload={payload} />
        <BotProvidersSection locale={locale} payload={payload} />
        <BotChainsSection locale={locale} payload={payload} />
        <BotInstallationsSection locale={locale} payload={payload} />
      </div>
    </div>
  );
}

/**
 * Credentials health: the bot's last verified delivery and its refused count.
 * Bot-scoped — deliveries arrive on the bot's webhook whatever target a review
 * lands on.
 */
export function BotHealthSection({ locale, payload }: { locale: SpaBoot["locale"]; payload: BotSettingsPayload }) {
  const rejected = payload.delivery_summary?.rejected24h ?? 0;
  return (
    <FlowSection title={t(locale, "botSettings.health")} subtitle={t(locale, "botSettings.healthCopy")}>
      <p className="text-sm text-muted-foreground">
        {t(locale, "settings.lastWebhook", {
          time: formatRelativeTime(payload.app.last_webhook_at, locale),
        })}
        {rejected > 0 ? (
          <>
            {" · "}
            <span className="text-(--tone-danger-fg)">
              {t(locale, "apps.health.rejected24h", { count: rejected })}
            </span>
          </>
        ) : null}
      </p>
    </FlowSection>
  );
}

/**
 * The bot's selected sandbox runtime image (registry id only — never
 * image-local configuration or secrets).
 */
export function SandboxImageSection({
  locale,
  payload,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
}) {
  return (
    <FlowSection title={t(locale, "settings.runtimeHarness")} subtitle={t(locale, "botSettings.sandboxCopy")}>
      <p className="text-sm text-muted-foreground">
        {t(locale, "settings.runtimeHarnessValue", { id: payload.app.sandbox_image_id })}
      </p>
    </FlowSection>
  );
}

/**
 * The configured providers: a built-in key renders its masked tail, a
 * custom/template provider its declaration.
 */
export function BotProvidersSection({ locale, payload }: { locale: SpaBoot["locale"]; payload: BotSettingsPayload }) {
  return (
    <FlowSection title={t(locale, "settings.providers.title")} subtitle={t(locale, "settings.providersCopy")}>
      {payload.configured_providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, "botSettings.providersNone")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {payload.configured_providers.map((row) =>
            row.kind === "key" ? (
              <li key={`key-${row.provider}-${row.key_id}`} className="text-sm">
                <span className="font-medium">{row.provider}</span>
                <span className="text-muted-foreground"> · ••••{row.last4}</span>
              </li>
            ) : (
              <li key={`custom-${row.provider_id}`} className="text-sm">
                <span className="font-medium">{row.provider_id}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {row.base_url} · {row.model_ids.join(", ")}
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </FlowSection>
  );
}

/** The stored model chains: the Default chain plus every named one. */
export function BotChainsSection({ locale, payload }: { locale: SpaBoot["locale"]; payload: BotSettingsPayload }) {
  return (
    <FlowSection title={t(locale, "settings.modelChains")} subtitle={t(locale, "botSettings.chainsCopy")}>
      <ul className="flex flex-col gap-2">
        {modelChainTabs(payload.model_chains).map((tab) => {
          const chain = splitModelChain(tab.isDefault ? payload.model_chain : tab.chain);
          return (
            <li key={tab.id} className="text-sm">
              <span className="font-medium">{tab.id}</span>
              <span className="text-muted-foreground"> · {chain.length === 0 ? "—" : chain.join(", ")}</span>
            </li>
          );
        })}
      </ul>
    </FlowSection>
  );
}

/**
 * The bot's GitHub installations. The availability judgement against an owner
 * allowlist belongs to the target, whose allowlist section renders it.
 */
export function BotInstallationsSection({
  locale,
  payload,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
}) {
  return (
    <FlowSection
      title={t(locale, "settings.installations")}
      subtitle={t(
        locale,
        payload.installations.length === 1 ? "settings.installationsCountOne" : "settings.installationsCount",
        { count: payload.installations.length },
      )}
    >
      {payload.installations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, "settings.noInstallations")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {payload.installations.map((installation) => (
            <li key={installation.installation_id} className="text-sm">
              <span className="font-medium">
                {installation.account_login ?? t(locale, "common.time.unknown")}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · <span className="font-mono tabular-nums">{installation.installation_id}</span> ·{" "}
                {formatRelativeTime(installation.seen_at, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </FlowSection>
  );
}
