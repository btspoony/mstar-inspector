import { useState } from "react";
import { Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button, FlowSection, StatusBadge, type StatusTone } from "@design-system";
import { GroupCard, GroupCardBody, GroupCardHeader } from "../components/GroupCard";
import { ListRow, ListRowGroup } from "../components/ListRow";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import type { CatalogProvider, SettingsManagePayload } from "./data";
import { NoticeRegion, type OpNotice } from "./PageNotice";
import { AddKeyDialog, AddProviderDialog } from "./providers-dialogs";
import { providerGroups, type ProviderGroup } from "./providers-groups";
import type { PendingAction } from "./SettingsPage";

/**
 * AC-10: exactly one verification label per key row, from the four store
 * states. `reachable` is the weaker "the endpoint answered" claim and takes the
 * accent tone; `unverified` is the NULL column.
 */
const KEY_STATUS = {
  ok: { tone: "success", label: "settings.providers.status.ok" },
  // The probe could not reject the key: the accent tone, not success.
  reachable: { tone: "accent", label: "settings.providers.status.reachable" },
  failed: { tone: "danger", label: "settings.providers.status.failed" },
  unverified: { tone: "neutral", label: "settings.providers.status.unverified" },
} as const satisfies Record<string, { tone: StatusTone; label: string }>;

/** Tier badge faces: the template tier is the one gold surface. */
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
export function ProvidersSection({
  locale,
  payload,
  onVerify,
  onSettings,
  onPending,
  notice,
  removeOutcome,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onPending: (action: PendingAction) => void;
  /** The add-flow (verify / template) outcomes — removes render group-locally (below). */
  notice: OpNotice | null;
  /** (audit UI-45-05): the remove-key / remove-custom outcome, rendered beside the group the removed row belonged to. */
  removeOutcome: { notice: OpNotice; slot: number } | null;
  /** Where the dialogs' completed flow reports its outcome. */
  onOutcome: (notice: OpNotice) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // The group whose Add key dialog is open; null = no add-key flow.
  const [addKeyTarget, setAddKeyTarget] = useState<{ provider: string; label: string; count: number } | null>(null);
  const catalogById: Record<string, CatalogProvider> = {};
  for (const provider of payload.provider_catalog) catalogById[provider.id] = provider;
  const groups = providerGroups(payload);
  // (audit UI-45-05, regrouped): the captured slot indexes the PRE-POST
  // configured rows. A failure or the tolerant no-op leaves the row in place,
  // so its provider names the group that renders the notice. A success took the
  // row away and may have taken the whole group, so the notice renders under
  // the add-flow region instead of pointing at a group that no longer exists.
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
        {/* A dialog trigger, not a disclosure: aria-haspopup names the
            overlay, and no region of this section is expanded by it. The
            flow section owns no action slot, so the trigger heads the body. */}
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
        {/* The section's region sits under the title: a completed flow's
            outcome survives the dialog's success-close (dialog-local state
            does not). A failed submit stays inside the dialog that produced
            it. */}
        <NoticeRegion notice={notice} />
        {/* A removal whose group is gone has no row to sit beside; the notice
            stays in the section so the outcome is never dropped. */}
        <NoticeRegion notice={orphanRemoveNotice} />
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.noConfiguredProviders")}</p>
        ) : (
          groups.map((group) => (
            <ProviderGroupCard
              key={group.providerId}
              locale={locale}
              group={group}
              catalog={catalogById[group.providerId]}
              removeNotice={
                removeOutcome !== null && removedProviderId === group.providerId ? removeOutcome.notice : null
              }
              onPending={onPending}
              onAddKey={() =>
                setAddKeyTarget({ provider: group.providerId, label: group.label, count: group.keys.length })
              }
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

/**
 * The endpoint summary a template / custom group can state: the stored
 * declaration first (it is what the pool is actually bound to), the catalog
 * entry as the prefill otherwise. A provider with no declaration and no
 * catalog endpoint (a key-only fallback id) has nothing to state.
 */
function groupMeta(
  group: ProviderGroup,
  catalog: CatalogProvider | undefined,
): { api: string; baseUrl: string; modelIds: string[] } | null {
  if (group.kind === "builtin") return null;
  const api = group.declaration?.api ?? catalog?.api ?? null;
  const baseUrl = group.declaration?.base_url ?? catalog?.base_url ?? null;
  if (api === null || baseUrl === null) return null;
  return { api, baseUrl, modelIds: group.declaration?.model_ids ?? catalog?.models ?? [] };
}

/**
 * One provider group: header identity (label + tier badge + aggregate counts +
 * the add-key and declaration-remove actions), the key rows, the empty state of
 * a declaration with no key yet, and the endpoint meta-line with its model-id
 * disclosure (AC-20 / I-000208).
 */
function ProviderGroupCard({
  locale,
  group,
  catalog,
  removeNotice,
  onPending,
  onAddKey,
}: {
  locale: SpaBoot["locale"];
  group: ProviderGroup;
  /** The catalog entry of this id, when the catalog knows it. */
  catalog: CatalogProvider | undefined;
  /** The remove outcome this group owns, or null. */
  removeNotice: OpNotice | null;
  onPending: (action: PendingAction) => void;
  /** Opens this group's add-key dialog — the second key no longer detours through the catalog. */
  onAddKey: () => void;
}) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const meta = groupMeta(group, catalog);
  // The disclosure region's id uses the provider id verbatim. Custom provider
  // ids are stored under the slug grammar (`[a-z0-9][a-z0-9-]{0,63}`), so no
  // character needs escaping; folding would only merge two distinct ids into
  // one DOM id.
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
              return (
                <ListRow
                  key={key.keyId}
                  identity={
                    key.last4
                      ? t(locale, "settings.keyEnding", { last4: key.last4 })
                      : t(locale, "settings.keyTooShort")
                  }
                  status={<StatusBadge tone={status.tone}>{t(locale, status.label)}</StatusBadge>}
                  // AC-11: the timestamp is this secondary slot, never the label.
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
                  }
                />
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
            </span>
            <button
              type="button"
              className="text-(--tone-accent-fg)"
              aria-expanded={modelsOpen}
              // The region mounts only while open, so the control never names
              // a missing element (the combobox precedent).
              aria-controls={modelsOpen ? modelsId : undefined}
              onClick={() => setModelsOpen(!modelsOpen)}
            >
              {t(locale, modelsOpen ? "settings.providers.collapse" : "settings.providers.expand")}
            </button>
          </div>
        ) : null}
        {meta && modelsOpen ? (
          // Light: `--surface-page` resolves to the same value as the card's own
          // surface, so this fill is dead there and the border carries the well.
          // The knowledge base's surface-tokens-can-collapse-across-themes.md
          // records the token arithmetic.
          <ul
            id={modelsId}
            className="mt-2 flex flex-wrap gap-x-3 gap-y-1 rounded-(--radius-control) border border-(--border-default) bg-(--surface-page) px-3 py-2 font-mono text-xs text-muted-foreground"
          >
            {meta.modelIds.map((modelId) => (
              <li key={modelId}>{modelId}</li>
            ))}
          </ul>
        ) : null}
      </GroupCardBody>
    </GroupCard>
  );
}
