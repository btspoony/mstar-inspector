import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button, FlowSection, StatusBadge, type StatusTone } from "@design-system";
import { GroupCard, GroupCardBody, GroupCardHeader } from "../components/GroupCard";
import { ListRow, ListRowGroup } from "../components/ListRow";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { modelsForProtocol, type CatalogProvider, type BotConfigSections, type ProviderManagementPayload } from "./data";
import { LoadingNotice, NoticeRegion, type OpNotice } from "./PageNotice";
import { ErrorState } from "../components/state/ErrorState";
import { loadProviderCatalog } from "../provider-catalog";
import { apiBase } from "../workspace-base";
import type { StaticProviderCatalog } from "./data";
import { AddKeyDialog, AddProviderDialog } from "./providers-dialogs";
import { ProviderModelsDialog } from "./provider-models-dialog";
import { ProviderSyncDialog } from "./provider-sync-dialog";
import { providerGroups, type ProviderGroup } from "./providers-groups";
import type { PendingAction } from "./SettingsPage";
import { UsagePanel } from "./usage-panel";

const KEY_STATUS = {
  ok: { tone: "success", label: "settings.providers.status.ok" },
  reachable: { tone: "accent", label: "settings.providers.status.reachable" },
  failed: { tone: "danger", label: "settings.providers.status.failed" },
  unverified: { tone: "neutral", label: "settings.providers.status.unverified" },
} as const satisfies Record<string, { tone: StatusTone; label: string }>;

const TIER_FACE = {
  builtin: { tone: "neutral", label: "settings.providers.tier.builtin" },
  template: { tone: "warn", label: "settings.providers.tier.template" },
  custom: { tone: "neutral", label: "settings.providers.tier.custom" },
} as const satisfies Record<string, { tone: StatusTone; label: string }>;

/**
 * Providers: grouped by provider id (the providers settings area) — one group card per
 * configured provider id, holding that provider's key rows. The group set is
 * the key pool ∪ the custom declarations (`providerGroups`); a catalog entry
 * with neither a key nor a declaration forms no group, because the catalog is
 * the discovery surface of the Add Provider flow, not configured state.
 *
 * The three configuration flows are dialogs: the card header
 * opens Add Provider, each group header opens Add key for that group, and the
 * custom declaration opens from the Add Provider dialog's own secondary entry.
 * Opening any of them inserts nothing into this list (AC-4) and changes no
 * route (AC-5); the per-row removes keep their confirmation dialog.
 */
export function ProvidersSection(props: Omit<Parameters<typeof LoadedProvidersSection>[0], "payload"> & { payload: BotConfigSections }) {
  const { payload, locale } = props;
  const base = apiBase();
  const version = payload.provider_catalog_version;
  const [loaded, setLoaded] = useState<{ version: string; catalog: StaticProviderCatalog } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(null);
    void loadProviderCatalog(base, version).then((catalog) => {
      if (!cancelled) setLoaded({ version, catalog });
    }).catch(() => { if (!cancelled) setFailed(version); });
    return () => { cancelled = true; };
  }, [base, version, retry]);
  const catalog = loaded?.version === version ? loaded.catalog : null;
  return catalog ? <LoadedProvidersSection {...props} payload={{
    ...payload,
    ...catalog,
    provider_catalog: catalog.provider_catalog.map((row) => ({
      ...row, eligibility: payload.provider_eligibility[row.id] ?? "unavailable",
    })),
  }} /> : (
    <FlowSection title={t(locale, "settings.providers.title")} subtitle={t(locale, "settings.providersCopy")}>
      {failed === version ? (
        <ErrorState locale={locale} onRetry={() => setRetry((value) => value + 1)} />
      ) : <LoadingNotice locale={locale} />}
    </FlowSection>
  );
}

export function LoadedProvidersSection({
  locale,
  payload,
  onVerify,
  onSettings,
  onPending,
  notice,
  removeOutcome,
  onOutcome,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: ProviderManagementPayload;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onPending: (action: PendingAction) => void;
  notice: OpNotice | null;
  removeOutcome: { notice: OpNotice; slot: number } | null;
  onOutcome: (notice: OpNotice) => void;
  onReload: () => Promise<unknown>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addKeyTarget, setAddKeyTarget] = useState<{ provider: string; label: string; count: number } | null>(null);
  const catalogById: Record<string, CatalogProvider> = {};
  for (const provider of payload.provider_catalog) catalogById[provider.id] = provider;
  const groups = providerGroups(payload);
  const removedRow =
    removeOutcome === null || removeOutcome.notice.kind === "success"
      ? null
      : (payload.configured_providers[removeOutcome.slot] ?? null);
  const removedProviderId =
    removedRow === null ? null : removedRow.kind === "key" ? removedRow.provider : removedRow.provider_id;
  const orphanRemoveNotice =
    removeOutcome === null || groups.some((group) => group.providerId === removedProviderId)
      ? null
      : removeOutcome.notice;

  return (
    <FlowSection
      title={t(locale, "settings.providers.title")}
      subtitle={t(locale, "settings.providersCopy")}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            onClick={() => setAddOpen(true)}
          >
            <Plus aria-hidden="true" />
            {t(locale, "settings.addProvider")}
          </Button>
        </div>
        <NoticeRegion notice={notice} />
        <NoticeRegion notice={orphanRemoveNotice} />
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.noConfiguredProviders")}</p>
        ) : (
          groups.map((group) => (
            <ProviderGroupCard
              key={group.providerId}
              locale={locale}
              appId={payload.app.github_app_id}
              group={group}
              catalog={catalogById[group.catalogId]}
              limitsSnapshot={payload.model_limits_snapshot}
              removeNotice={
                removeOutcome !== null && removedProviderId === group.providerId ? removeOutcome.notice : null
              }
              onPending={onPending}
              onAddKey={() =>
                setAddKeyTarget({ provider: group.providerId, label: group.label, count: group.keys.length })
              }
              onSettings={onSettings}
              onOutcome={onOutcome}
              onReload={onReload}
            />
          ))
        )}
      </div>
      <AddProviderDialog
        locale={locale}
        open={addOpen}
        onOpenChange={setAddOpen}
        payload={payload}
        onVerify={onVerify}
        onSettings={onSettings}
        onOutcome={onOutcome}
      />
      <AddKeyDialog
        locale={locale}
        open={addKeyTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAddKeyTarget(null);
        }}
        provider={addKeyTarget?.provider ?? ""}
        label={addKeyTarget?.label ?? ""}
        keyCount={addKeyTarget?.count ?? 0}
        onVerify={onVerify}
        onOutcome={onOutcome}
      />
    </FlowSection>
  );
}

function groupMeta(
  group: ProviderGroup,
  catalog: CatalogProvider | undefined,
): {
  api: string;
  baseUrl: string;
  modelIds: readonly string[];
  source: "declaration" | "catalog";
} | null {
  if (group.kind === "builtin") return null;
  const api = group.declaration?.api ?? catalog?.api ?? null;
  const baseUrl = group.declaration?.base_url ?? catalog?.base_url ?? null;
  if (api === null || baseUrl === null) return null;
  if (group.declaration !== null) {
    return { api, baseUrl, modelIds: group.declaration.model_ids, source: "declaration" };
  }
  return { api, baseUrl, modelIds: modelsForProtocol(catalog, api), source: "catalog" };
}

function ProviderGroupCard({
  locale,
  appId,
  group,
  catalog,
  limitsSnapshot,
  removeNotice,
  onPending,
  onAddKey,
  onSettings,
  onOutcome,
  onReload,
}: {
  locale: SpaBoot["locale"];
  appId: number;
  group: ProviderGroup;
  catalog: CatalogProvider | undefined;
  limitsSnapshot: string;
  removeNotice: OpNotice | null;
  onPending: (action: PendingAction) => void;
  onAddKey: () => void;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
  onReload: () => Promise<unknown>;
}) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsEditOpen, setModelsEditOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [usageFor, setUsageFor] = useState<{ keyId: string; nonce: number } | null>(null);
  const meta = groupMeta(group, catalog);
  const modelsId = `provider-models-${group.providerId}`;
  const tier = TIER_FACE[group.kind];

  return (
    <GroupCard>
      <GroupCardHeader
        title={group.label}
        badge={<StatusBadge tone={tier.tone}>{t(locale, tier.label)}</StatusBadge>}
        summary={t(
          locale,
          group.summary.total === 1 ? "settings.providers.summaryOne" : "settings.providers.summary",
          group.summary,
        )}
        actions={
          <div className="flex items-center gap-(--spacing-2)">
            <Button type="button" variant="outline" size="sm" aria-haspopup="dialog" onClick={onAddKey}>
              {t(locale, "settings.addKey")}
            </Button>
            {group.declaration === null ? null : (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => onPending({ kind: "remove-custom", providerId: group.providerId })}
              >
                {t(locale, "settings.remove")}
              </Button>
            )}
          </div>
        }
      />
      <GroupCardBody>
        <NoticeRegion notice={removeNotice} />
        {group.keys.length === 0 ? (
          <p className="rounded-(--radius-control) border border-(--border-default) bg-(--surface-inset) px-3 py-3.5 text-sm text-muted-foreground">
            {t(locale, "settings.providers.empty")}
          </p>
        ) : (
          <ListRowGroup>
            {group.keys.map((key) => {
              const status = KEY_STATUS[key.verifiedStatus ?? "unverified"];
              const usage = usageFor !== null && usageFor.keyId === key.keyId ? usageFor : null;
              const usagePanelId = `usage-panel-${key.keyId}`;
              return (
                <div key={key.keyId}>
                  <ListRow
                    identity={
                      key.last4
                        ? t(locale, "settings.keyEnding", { last4: key.last4 })
                        : t(locale, "settings.keyTooShort")
                    }
                    status={<StatusBadge tone={status.tone}>{t(locale, status.label)}</StatusBadge>}
                    meta={
                      key.verifiedStatus === "ok" && key.verifiedAt
                        ? t(locale, "settings.providers.verifiedAt", {
                            time: formatRelativeTime(key.verifiedAt, locale),
                          })
                        : key.updatedAt
                          ? t(locale, "settings.updated", { time: formatRelativeTime(key.updatedAt, locale) })
                          : null
                    }
                    actions={
                      <>
                        {catalog?.usage_probe === true ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-expanded={usage !== null}
                            aria-controls={usage !== null ? usagePanelId : undefined}
                            onClick={() =>
                              setUsageFor((current) =>
                                current !== null && current.keyId === key.keyId
                                  ? { keyId: key.keyId, nonce: current.nonce + 1 }
                                  : { keyId: key.keyId, nonce: 0 },
                              )
                            }
                          >
                            {t(locale, "settings.providers.usage.action")}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() =>
                            onPending({
                              kind: "remove-key",
                              provider: key.provider,
                              keyId: key.keyId,
                              last4: key.last4,
                            })
                          }
                        >
                          {t(locale, "settings.remove")}
                        </Button>
                      </>
                    }
                  />
                  {usage === null ? null : (
                    <div id={usagePanelId}>
                      <UsagePanel
                        key={`${key.keyId}:${usage.nonce}`}
                        locale={locale}
                        appId={appId}
                        provider={group.providerId}
                        keyId={key.keyId}
                        open
                        onClose={() => setUsageFor(null)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </ListRowGroup>
        )}
        {meta ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-(--border-subtle) pt-3 text-xs text-muted-foreground">
            <span className="font-mono">{meta.api}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{meta.baseUrl}</span>
            <span aria-hidden="true">·</span>
            <span>
              {t(
                locale,
                meta.modelIds.length === 1 ? "settings.providers.modelCountOne" : "settings.providers.modelCount",
                { count: meta.modelIds.length },
              )}
              {meta.source === "catalog" ? ` (${t(locale, "settings.providers.catalogVocabulary")})` : null}
            </span>
            <button
              type="button"
              className="text-(--tone-accent-fg)"
              aria-expanded={modelsOpen}
              aria-controls={modelsOpen ? modelsId : undefined}
              onClick={() => setModelsOpen(!modelsOpen)}
            >
              {t(locale, modelsOpen ? "settings.providers.collapse" : "settings.providers.expand")}
            </button>
            {group.declaration !== null ? (
              <button
                type="button"
                className="text-(--tone-accent-fg)"
                aria-haspopup="dialog"
                onClick={() => setModelsEditOpen(true)}
              >
                {t(locale, "settings.providers.models.trigger")}
              </button>
            ) : null}
            {group.declaration !== null ? (
              <button
                type="button"
                className="text-(--tone-accent-fg)"
                aria-haspopup="dialog"
                onClick={() => setSyncOpen(true)}
              >
                {t(locale, "settings.providers.sync.trigger")}
              </button>
            ) : null}
          </div>
        ) : null}
        {meta && modelsOpen ? (
          <ul
            id={modelsId}
            className="mt-2 flex max-h-72 flex-wrap gap-x-3 gap-y-1 overflow-y-auto rounded-(--radius-control) border border-(--border-default) bg-(--surface-page) px-3 py-2 font-mono text-xs text-muted-foreground"
          >
            {meta.modelIds.map((modelId) => (
              <li key={modelId}>{modelId}</li>
            ))}
          </ul>
        ) : null}
      </GroupCardBody>
      {group.declaration === null ? null : (
        <ProviderModelsDialog
          locale={locale}
          open={modelsEditOpen}
          onOpenChange={setModelsEditOpen}
          provider={group.providerId}
          label={group.label}
          storedModelIds={group.declaration.model_ids}
          storedModelsMeta={group.declaration.models_meta}
          catalogModelIds={modelsForProtocol(catalog, group.declaration.api)}
          catalogLimits={catalog?.model_limits ?? {}}
          limitsSnapshot={limitsSnapshot}
          onSettings={onSettings}
          onOutcome={onOutcome}
        />
      )}
      {group.declaration === null ? null : (
        <ProviderSyncDialog
          locale={locale}
          open={syncOpen}
          onOpenChange={setSyncOpen}
          appId={appId}
          provider={group.providerId}
          label={group.label}
          onOutcome={onOutcome}
          onReload={onReload}
        />
      )}
    </GroupCard>
  );
}
