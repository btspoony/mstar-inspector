import { useState } from "react";
import { Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { CardAction, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GroupCard, GroupCardBody, GroupCardHeader } from "../components/GroupCard";
import { ListRow, ListRowGroup } from "../components/ListRow";
import { ProviderCombobox } from "../components/provider-combobox";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { StatusBadge, type StatusTone } from "../components/StatusBadge";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import {
  providerFormKind,
  providerKeyRows,
  selectedCatalogProvider,
  type CatalogProvider,
  type ProviderKeyRow,
  type SettingsManagePayload,
} from "./data";
import { NoticeRegion, type OpNotice } from "./PageNotice";
import { providerGroups, type ProviderGroup } from "./providers-groups";
import type { PendingAction } from "./SettingsPage";

/**
 * AC-10: exactly one verification label per key row, from the four store
 * states. `reachable` is the weaker "the endpoint answered" claim and takes the
 * accent tone; `unverified` is the NULL column.
 */
const KEY_STATUS = {
  ok: { tone: "success", label: "settings.providers.status.ok" },
  reachable: { tone: "brand", label: "settings.providers.status.reachable" },
  failed: { tone: "error", label: "settings.providers.status.failed" },
  unverified: { tone: "neutral", label: "settings.providers.status.unverified" },
} as const satisfies Record<string, { tone: StatusTone; label: string }>;

/** Tier badge faces: the template tier is the one gold surface. */
const TIER_FACE = {
  builtin: { tone: "neutral", label: "settings.providers.tier.builtin" },
  template: { tone: "warning", label: "settings.providers.tier.template" },
  custom: { tone: "neutral", label: "settings.providers.tier.custom" },
} as const satisfies Record<string, { tone: StatusTone; label: string }>;

/**
 * Providers: grouped by provider id (plan 103 task 3) — one group card per
 * configured provider id, holding that provider's key rows. The group set is
 * the key pool ∪ the custom declarations (`providerGroups`); a catalog entry
 * with neither a key nor a declaration forms no group, because the catalog is
 * the discovery surface of the Add Provider panel, not configured state.
 *
 * The Add Provider entry is a labeled, bordered button in the card
 * header (CardAction slot) — the catalog breadth made discoverability the
 * point, so the flow opens from a control that reads as a control. The open
 * panel is the card content's first row.
 */
export function ProvidersCard({
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
  /** Where the add-flow forms (verify / template) report their outcome. */
  onOutcome: (notice: OpNotice) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
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
    <SectionCard tier="secondary">
      <CardHeader>
        <SectionCardTitle>{t(locale, "settings.providers.title")}</SectionCardTitle>
        <CardDescription>{t(locale, "settings.providersCopy")}</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" aria-expanded={addOpen} onClick={() => setAddOpen(!addOpen)}>
            <Plus aria-hidden="true" />
            {t(locale, "settings.addProvider")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AddProviderSection
          locale={locale}
          payload={payload}
          onVerify={onVerify}
          onSettings={onSettings}
          onOutcome={onOutcome}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
        {/* The card's region sits directly under the add panel: verify /
            template outcomes stay next to their submit button while the panel
            is open, and survive its success-close (unlike panel-local state).
            The dialog-confirmed removes render beside their group below —
            this region keeps only the add-flow outcomes. */}
        <NoticeRegion notice={notice} />
        {/* A removal whose group is gone has no row to sit beside; the notice
            stays in the card so the outcome is never dropped. */}
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
            />
          ))
        )}
        <CustomExpand
          locale={locale}
          payload={payload}
          expanded={customOpen}
          onToggle={() => setCustomOpen(!customOpen)}
          onSettings={onSettings}
        />
      </CardContent>
    </SectionCard>
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
 * the declaration's remove action), the key rows, the empty state of a
 * declaration with no key yet, and the endpoint meta-line with its model-id
 * disclosure (AC-20 / I-000208).
 */
function ProviderGroupCard({
  locale,
  group,
  catalog,
  removeNotice,
  onPending,
}: {
  locale: SpaBoot["locale"];
  group: ProviderGroup;
  /** The catalog entry of this id, when the catalog knows it. */
  catalog: CatalogProvider | undefined;
  /** The remove outcome this group owns, or null. */
  removeNotice: OpNotice | null;
  onPending: (action: PendingAction) => void;
}) {
  const [modelsOpen, setModelsOpen] = useState(false);
  const meta = groupMeta(group, catalog);
  // The disclosure region's id: provider ids are slugs, but a custom id is
  // caller-supplied, so anything outside the id-safe set is folded to a dash.
  const modelsId = `provider-models-${group.providerId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const tier = TIER_FACE[group.kind];

  return (
    <GroupCard>
      <GroupCardHeader
        title={group.label}
        badge={<StatusBadge tone={tier.tone}>{t(locale, tier.label)}</StatusBadge>}
        summary={t(locale, "settings.providers.summary", group.summary)}
        actions={
          group.declaration === null ? null : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => onPending({ kind: "remove-custom", providerId: group.providerId })}
            >
              {t(locale, "settings.remove")}
            </Button>
          )
        }
      />
      <GroupCardBody>
        <NoticeRegion notice={removeNotice} />
        {group.keys.length === 0 ? (
          <p className="rounded-(--rounded-sm) border border-(--gray-alpha-400) bg-(--gray-200) px-3 py-3.5 text-sm text-muted-foreground">
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
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{meta.api}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{meta.baseUrl}</span>
            <span aria-hidden="true">·</span>
            <span>{t(locale, "settings.providers.modelCount", { count: meta.modelIds.length })}</span>
            <button
              type="button"
              className="text-(--brand-700)"
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
          <ul
            id={modelsId}
            className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground"
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

/**
 * Add Provider: the open panel beneath the card header's labeled
 * disclosure button (the button moved to the CardAction slot; the
 * panel renders as the content's first row). The selected entry's id
 * determines the configuration form rendered beneath the picker. Catalog
 * provenance (the committed models.dev snapshot, static code) and per-entry
 * runtime eligibility (builtin / template / unavailable vs the App's selected
 * image) are disclosed in copy; an unavailable entry renders its explanation
 * with no submit path. The picker is the filterable combobox
 * (provider-combobox.tsx) showing the common tier first, then the catalog
 * tier (display-only grouping inside the combobox: the form below keeps
 * branching on tier/eligibility, AD-547) — with the list height-capped to an
 * internal scroll so the snapshot breadth stays usable. Only a successful
 * submit closes the flow — a failed verify/add keeps the selection and typed
 * input while the provider stays unconfigured.
 */
function AddProviderSection({
  locale,
  payload,
  onVerify,
  onSettings,
  onOutcome,
  open,
  onOpenChange,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = selectedCatalogProvider(payload.provider_catalog, selectedId);
  const imageId = payload.app.sandbox_image_id;
  const customById: Record<string, SettingsManagePayload["custom_providers"][number]> = {};
  for (const row of payload.custom_providers) customById[row.provider_id] = row;

  if (!open) return null;
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">{t(locale, "settings.addProviderCopy")}</p>
      <p className="text-xs text-muted-foreground">
        {t(locale, "settings.catalogProvenance", { count: payload.provider_catalog.length })}
      </p>
      <div className="flex max-w-xs flex-col gap-1.5">
        <span className="text-sm font-medium" id="settings-catalog-provider-label">
          {t(locale, "settings.provider")}
        </span>
        <ProviderCombobox
          locale={locale}
          labelledby="settings-catalog-provider-label"
          providers={payload.provider_catalog}
          value={selectedId}
          onValueChange={setSelectedId}
          imageId={imageId}
        />
      </div>
      {selected ? (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-medium">
            {t(locale, "settings.configureProvider", { label: selected.label })}
          </h4>
          {selected.eligibility === "unavailable" ? (
            // Runtime-ineligible rows stay selectable for discovery but get
            // an explanation instead of a form — no submit path, so an
            // unusable provider can never be saved silently.
            <p className="text-sm text-muted-foreground">
              {t(locale, "settings.eligibilityUnavailable", { image: imageId })}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {selected.eligibility === "template"
                  ? t(locale, "settings.eligibilityTemplate", { image: imageId })
                  : t(locale, "settings.eligibilityBuiltin", { image: imageId })}
              </p>
              <ProviderConfigForm
                key={selected.id}
                locale={locale}
                provider={selected}
                storedKeys={providerKeyRows(payload.keys, selected.id)}
                custom={customById[selected.id]}
                onVerify={onVerify}
                onSettings={onSettings}
                onOutcome={onOutcome}
                onDone={() => {
                  setSelectedId(undefined);
                  onOpenChange(false);
                }}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The selected catalog entry's configuration requirements: template
 * entries materialize through op=add-template-provider, verifiable builtins
 * use the verify-first /keys/verify path, and console-only providers have no
 * in-app form. Every form clears and closes only on success — a rejected
 * submit surfaces the structured error and keeps the typed input.
 *
 * The template form carries the base URL explicitly — prefilled from
 * the catalog entry, editable as an override (required only when the entry's
 * catalog base URL is null) — and the account-id field appears only when the
 * effective base URL carries the {account_id} placeholder, mirroring the
 * save flow's conditional demand (breadth rows are not all Workers-AI-shaped).
 */
export function ProviderConfigForm({
  locale,
  provider,
  storedKeys,
  custom,
  onVerify,
  onSettings,
  onOutcome,
  onDone,
}: {
  locale: SpaBoot["locale"];
  provider: CatalogProvider;
  /** EVERY stored key of the selected provider — one masked line per row. */
  storedKeys: ProviderKeyRow[];
  custom: SettingsManagePayload["custom_providers"][number] | undefined;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [accountId, setAccountId] = useState("");
  // Seeded from the STORED declaration when the provider already has one: the
  // pool is bound to that endpoint, and re-submitting the catalog default
  // while adding a key would only trip the store's endpoint lock (the
  // backstop for a hand-typed override). Catalog prefill covers the first key.
  const [baseUrl, setBaseUrl] = useState(custom?.base_url ?? provider.base_url ?? "");
  const [busy, setBusy] = useState(false);
  const formKind = providerFormKind(provider);

  // Both add-flow forms report through the providers card's
  // region (directly beneath this panel), so the outcome survives the
  // success-close; a rejected submit keeps the typed input for correction.
  async function submitTemplate(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await onSettings({
        op: "add-template-provider",
        template_id: provider.id,
        base_url: baseUrl,
        account_id: accountId,
        key,
      });
      onOutcome(outcome);
      if (outcome.kind === "success") {
        setKey("");
        setAccountId("");
        setBaseUrl("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitKey(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await onVerify({ provider: provider.id, key });
      onOutcome(outcome);
      if (outcome.kind === "success") {
        setKey("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  if (formKind === "template") {
    // The effective base URL mirrors the save flow: the typed override when
    // present, else the catalog prefill. The account-id field tracks its
    // {account_id} placeholder, so an override can add or remove the demand.
    const effectiveBaseUrl = baseUrl.trim() !== "" ? baseUrl.trim() : provider.base_url;
    const needsAccountId = effectiveBaseUrl !== null && effectiveBaseUrl.includes("{account_id}");
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTemplate();
        }}
      >
        {custom || storedKeys.length > 0 ? (
          <div className="flex flex-col gap-1">
            {custom ? (
              <p className="text-sm text-muted-foreground">
                {custom.base_url} · {custom.api} · {custom.model_ids.join(", ")}
              </p>
            ) : null}
            {/* The pool's existing rows, one line per stored key: submitting
                below APPENDS (re-submitting a listed key updates its row in
                place), so the pool a template already holds is visible before
                another key is added. */}
            {storedKeys.map((stored) => (
              <p key={stored.keyId} className="text-sm text-muted-foreground">
                {stored.last4
                  ? t(locale, "settings.keyEnding", { last4: stored.last4 })
                  : t(locale, "settings.keyTooShort")}
              </p>
            ))}
          </div>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t(locale, "settings.baseUrl")}
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            required={provider.base_url === null}
          />
        </label>
        {needsAccountId ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.accountId")}
            <Input
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder={t(locale, "settings.accountIdPlaceholder")}
              autoComplete="off"
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t(locale, "settings.apiKey")}
          <Input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="new-password"
            placeholder={t(locale, "settings.apiKeyPlaceholder")}
          />
        </label>
        <Button type="submit" disabled={busy}>{t(locale, "settings.addTemplate", { label: provider.label })}</Button>
      </form>
    );
  }

  if (formKind === "console") {
    return <p className="text-sm text-muted-foreground">{t(locale, "settings.consoleOnly")}</p>;
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submitKey();
      }}
    >
      {/* The pool's rows, one line per stored key: submitting the field below
          APPENDS to this pool (re-submitting a listed key updates its row in
          place) — no client-side fold, so a second key stays visible. */}
      {storedKeys.map((stored) => (
        <p key={stored.keyId} className="text-sm text-muted-foreground">
          {stored.last4
            ? t(locale, "settings.keyEnding", { last4: stored.last4 })
            : t(locale, "settings.keyTooShort")}
        </p>
      ))}
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t(locale, "settings.apiKey")}
        <Input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="new-password"
          placeholder={t(locale, "settings.apiKeyPlaceholder")}
        />
      </label>
      <Button type="submit" disabled={busy}>{t(locale, "settings.addKey")}</Button>
    </form>
  );
}

function CustomExpand({
  locale,
  payload,
  expanded,
  onToggle,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  expanded: boolean;
  onToggle: () => void;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState(payload.custom_provider_api_ids[0] ?? "");
  const [modelIds, setModelIds] = useState("");
  const [key, setKey] = useState("");
  // The custom declaration's outcome renders inside its own form
  // (this container stays mounted, unlike the add panel) — the card's region
  // above the configured rows is too far from this form's submit button.
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await onSettings({
        op: "add-custom-provider",
        provider_id: providerId,
        base_url: baseUrl,
        api,
        model_ids: modelIds,
        key,
      });
      setNotice(outcome);
      // QC wave (seat3): a rejected save keeps the typed input for
      // correction — only a successful save clears the form.
      if (outcome.kind === "success") {
        setProviderId("");
        setBaseUrl("");
        setModelIds("");
        setKey("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border p-3">
      <button type="button" className="flex w-full flex-col items-start text-left" onClick={onToggle} aria-expanded={expanded}>
        <span className="font-medium">{t(locale, "settings.customEntry")}</span>
        <span className="text-xs text-muted-foreground">{t(locale, "settings.customEntryCopy")}</span>
      </button>
      {expanded ? (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.providerId")}
            <Input value={providerId} onChange={(event) => setProviderId(event.target.value)} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.baseUrl")}
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.api")}
            <Select value={api} onValueChange={setApi}>
              <SelectTrigger>
                <SelectValue placeholder={t(locale, "settings.selectApi")} />
              </SelectTrigger>
              <SelectContent>
                {payload.custom_provider_api_ids.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.modelIds")}
            <Input value={modelIds} onChange={(event) => setModelIds(event.target.value)} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.apiKey")}
            <Input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="new-password"
              placeholder={t(locale, "settings.apiKeyPlaceholder")}
            />
          </label>
          <Button type="submit" disabled={busy}>{t(locale, "settings.addCustomProvider")}</Button>
          <NoticeRegion notice={notice} />
        </form>
      ) : null}
    </div>
  );
}
