/**
 * The bot detail page (`/dashboard/<ref>/bots/:botId`, D7/D23/D24): ONE page,
 * two blocks. The read-only overview renders for every member of a workspace
 * that can use the bot (own or shared); the editable region renders only when
 * `can_manage` says this caller owns the workspace that provides it — and the
 * store refuses the write regardless, so hiding is never the guard.
 *
 * The overview proves only what the API served: name, description, provider
 * workspace, sharing state, mounting Apps, multiplier, this month's spend and
 * the capability summary built from the model's default chain plus its
 * sandbox image (D21) — never a client-derived guess.
 */
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { apiBase } from "../workspace-base";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import {
  parseBotSettings,
  parseModels,
  splitModelChain,
  type BotOverview,
  type BotSettingsPayload,
  type ModelOptionGroup,
} from "./data";
import { BotSettingsView } from "./BotSettingsPage";
import type { NoticeKind } from "./PageNotice";

/** The month cell: a shared bot's ceiling, an own bot's freedom, or a dash. */
export function BotMonthLabel({
  locale,
  overview,
  owned,
}: {
  locale: SpaBoot["locale"];
  overview: BotOverview | undefined;
  owned: boolean;
}) {
  if (!overview) return <>{t(locale, "apps.bots.monthNone")}</>;
  const used = overview.month_used_rp;
  if (owned) return <>{t(locale, "bots.monthOwn", { used })}</>;
  return overview.plan_monthly_rp === null ? (
    <>{t(locale, "bots.monthNoCeiling", { used })}</>
  ) : (
    <>{t(locale, "bots.monthLimit", { used, limit: overview.plan_monthly_rp })}</>
  );
}

export function BotDetailPage({ boot, botId }: { boot: SpaBoot; botId: string }) {
  const { locale } = boot;
  const [payload, setPayload] = useState<BotSettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice] = useState<{ kind: NoticeKind; message: string } | null>(null);

  const load = async (): Promise<boolean> => {
    try {
      const [botData, modelsData] = await Promise.all([
        fetchJson(`${apiBase()}/api/review-bots/${encodeURIComponent(botId)}/bot`),
        fetchJson(`${apiBase()}/api/models`).catch(() => null),
      ]);
      const parsed = parseBotSettings(botData);
      if (!parsed) {
        setState("error");
        return false;
      }
      setPayload(parsed);
      setGroups(modelsData ? (parseModels(modelsData)?.groups ?? []) : []);
      setState("ok");
      return true;
    } catch {
      setState("error");
      return false;
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="forms" />;
  }
  if (state === "error" || payload === null) {
    return <ErrorState locale={locale} onRetry={() => void load()} />;
  }
  const { app, overview } = payload;
  const owned = app.scope === "owned";
  const defaultChain = splitModelChain(payload.model_chain);
  const namedChains = payload.model_chains
    .filter((entry) => entry.name !== "default")
    .map((entry) => ({ name: entry.name, chain: splitModelChain(entry.chain) }));
  const capabilityDefault =
    defaultChain.length === 0
      ? t(locale, "bots.capabilityChainUnset")
      : t(locale, "bots.capabilityDefaultChain", { models: defaultChain.join(", ") });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={app.name ?? appDisplayNameOf(app)} description={app.description ?? undefined} />

      <SectionCard tier="secondary" title={t(locale, "bots.overviewTitle")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t(locale, "bots.fieldProvider")}</dt>
          <dd>{overview?.provider_workspace ?? "—"}</dd>

          <dt className="text-muted-foreground">{t(locale, "bots.fieldSharing")}</dt>
          <dd>{t(locale, app.scope === "shared" ? "bots.stateShared" : "bots.stateOwn")}</dd>

          <dt className="text-muted-foreground">{t(locale, "bots.fieldMounted")}</dt>
          <dd>
            {overview && overview.mounted_apps.length > 0 ? (
              <span className="flex flex-wrap gap-2">
                {overview.mounted_apps.map((mounted) => (
                  <a key={mounted.id} href={`${apiBase()}/apps/${encodeURIComponent(mounted.id)}`}>
                    {mounted.name}
                  </a>
                ))}
              </span>
            ) : (
              t(locale, "bots.mountedNone")
            )}
          </dd>

          <dt className="text-muted-foreground">{t(locale, "bots.fieldMultiplier")}</dt>
          <dd>×{app.multiplier ?? 1}</dd>

          <dt className="text-muted-foreground">
            {t(locale, "bots.monthLabel")}
            <span className="sr-only">{t(locale, "bots.monthHint")}</span>
          </dt>
          <dd>
            <BotMonthLabel locale={locale} overview={overview} owned={owned} />
          </dd>

          <dt className="text-muted-foreground">{t(locale, "bots.fieldCapability")}</dt>
          <dd className="flex flex-col gap-0.5">
            <span>{capabilityDefault}</span>
            <span>{t(locale, "bots.capabilitySandbox", { id: app.sandbox_image_id || "—" })}</span>
            {namedChains.length > 0 ? (
              <span className="text-muted-foreground">
                {namedChains.map((row) => `${row.name}: ${row.chain.join(", ")}`).join(" · ")}
              </span>
            ) : null}
          </dd>
        </dl>
      </SectionCard>

      {payload.can_manage ? (
        <SectionCard tier="secondary" title={t(locale, "bots.editableTitle")}>
          <BotSettingsView
            locale={locale}
            payload={payload}
            groups={groups}
            notice={notice}
            onReload={async () => await load()}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}

/** The bot name is a bot column; the App display rule is the fallback only. */
function appDisplayNameOf(app: BotSettingsPayload["app"]): string {
  return app.github_name ?? app.github_slug ?? String(app.github_app_id ?? "");
}
