import { Fragment, useState } from "react";
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
import { ProviderCombobox } from "../components/provider-combobox";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import {
  providerFormKind,
  providerKeyRows,
  selectedCatalogProvider,
  type CatalogProvider,
  type ConfiguredProvider,
  type ProviderKeyRow,
  type SettingsManagePayload,
} from "./data";
import { NoticeRegion, type OpNotice } from "./PageNotice";
import type { PendingAction } from "./SettingsPage";

/**
 * Providers: this card lists ONLY the App's configured providers —
 * a stored key (masked tail) or a saved custom-provider declaration. Catalog
 * entries are discovery metadata and appear solely inside the Add Provider
 * picker, whose selection determines the configuration form; the non-catalog
 * custom declaration path (CustomExpand) stays for ids outside the catalog.
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
  /** The add-flow (verify / template) outcomes — removes render row-local (below). */
  notice: OpNotice | null;
  /** (audit UI-45-05): the remove-key / remove-custom outcome, rendered at the removed row's position. */
  removeOutcome: { notice: OpNotice; slot: number } | null;
  /** Where the add-flow forms (verify / template) report their outcome. */
  onOutcome: (notice: OpNotice) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const catalogById: Record<string, CatalogProvider> = {};
  for (const provider of payload.provider_catalog) catalogById[provider.id] = provider;
  // (audit UI-45-05): where the remove outcome renders inside the
  // rows list. Success took the row away — the awaited reload has already
  // dropped it — so the outcome renders in its former slot; a failure OR the
  // tolerant no-op (warn: nothing was removed, the row is still there) renders
  // directly below it (the field-error position). Clamped so a removed last
  // row lands at the list's end, never out of bounds.
  const removeSlot =
    removeOutcome === null
      ? -1
      : Math.min(
          removeOutcome.notice.kind === "success" ? removeOutcome.slot : removeOutcome.slot + 1,
          payload.configured_providers.length,
        );

  return (
    <SectionCard tier="secondary">
      <CardHeader>
        <SectionCardTitle>{t(locale, "settings.providers")}</SectionCardTitle>
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
            The dialog-confirmed removes render row-locally below
            instead — this region keeps only the add-flow outcomes. */}
        <NoticeRegion notice={notice} />
        {payload.configured_providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.noConfiguredProviders")}</p>
        ) : (
          payload.configured_providers.map((row, index) => (
            <Fragment key={row.kind === "key" ? `${row.provider}:${row.key_id}` : row.provider_id}>
              {/* (audit UI-45-05): the remove outcome renders in
                  the removed row's position — at catalog scale the feedback
                  is visible without scrolling away from the Remove control
                  that produced it. The shared NoticeRegion inherits the
                  the alert/status roles and notice tokens. */}
              {index === removeSlot && removeOutcome ? <NoticeRegion notice={removeOutcome.notice} /> : null}
              {row.kind === "key" ? (
                <ConfiguredKeyRow
                  locale={locale}
                  row={row}
                  label={catalogById[row.provider]?.label ?? row.provider}
                  onPending={onPending}
                />
              ) : (
                <ConfiguredCustomRow
                  locale={locale}
                  row={row}
                  label={catalogById[row.provider_id]?.label ?? row.provider_id}
                  storedKeys={providerKeyRows(payload.keys, row.provider_id)}
                  onPending={onPending}
                  onSettings={onSettings}
                />
              )}
            </Fragment>
          ))
        )}
        {/* Trailing clamp: a removed last row's slot equals the list length. */}
        {removeOutcome && removeSlot >= payload.configured_providers.length ? (
          <NoticeRegion notice={removeOutcome.notice} />
        ) : null}
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

function ConfiguredKeyRow({
  locale,
  row,
  label,
  onPending,
}: {
  locale: SpaBoot["locale"];
  row: Extract<ConfiguredProvider, { kind: "key" }>;
  label: string;
  onPending: (action: PendingAction) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {row.provider} ·{" "}
          {row.last4 ? t(locale, "settings.keyEnding", { last4: row.last4 }) : t(locale, "settings.keyTooShort")}
          {row.updated_at
            ? ` · ${t(locale, "settings.updated", { time: formatRelativeTime(row.updated_at, locale) })}`
            : ""}
          {/* One row per stored key: the verification state is the row's own.
              `reachable` is deliberately NOT "verified" — the probe only
              proved the endpoint answered. */}
          {row.verified_status === "ok" && row.verified_at
            ? ` · ${t(locale, "settings.keyVerifiedAt", { time: formatRelativeTime(row.verified_at, locale) })}`
            : row.verified_status === "reachable" && row.verified_at
              ? ` · ${t(locale, "settings.keyReachableAt", { time: formatRelativeTime(row.verified_at, locale) })}`
              : row.verified_status === "failed"
                ? ` · ${t(locale, "settings.keyVerifyFailed")}`
                : ""}
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() =>
          onPending({ kind: "remove-key", provider: row.provider, keyId: row.key_id, last4: row.last4 })
        }
      >
        {t(locale, "settings.remove")}
      </Button>
    </div>
  );
}

function ConfiguredCustomRow({
  locale,
  row,
  label,
  storedKeys,
  onPending,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  row: Extract<ConfiguredProvider, { kind: "custom" }>;
  label: string;
  /** EVERY stored key of this declaration's pool — the same masked rows the
   *  built-in/template faces render, so a second key is visible before a third
   *  is added. */
  storedKeys: ProviderKeyRow[];
  onPending: (action: PendingAction) => void;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  /**
   * Append ANOTHER key to this declaration's pool (the built-in/template
   * faces' multi-key behaviour, which the custom row lacked): the declaration
   * itself is untouched — the route verifies against the STORED endpoint and
   * appends, so no endpoint field is offered here. A failed verify keeps the
   * typed key for correction.
   */
  async function submit(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await onSettings({
        op: "add-custom-provider-key",
        provider_id: row.provider_id,
        key,
      });
      setNotice(
        outcome.kind === "success" ? { kind: "success", message: t(locale, "settings.customKeyAdded") } : outcome,
      );
      if (outcome.kind === "success") setKey("");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Same shell as the key row (one compact dialect); the add-key form and the
    // notice are `w-full` children so they wrap onto their own line.
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {row.provider_id} · {row.base_url} · {row.api} · {row.model_ids.join(", ")}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={addOpen}
          onClick={() => setAddOpen(!addOpen)}
        >
          <Plus aria-hidden="true" />
          {t(locale, "settings.addKey")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => onPending({ kind: "remove-custom", providerId: row.provider_id })}
        >
          {t(locale, "settings.remove")}
        </Button>
      </div>
      {addOpen ? (
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
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
      ) : null}
      <div className="w-full">
        <NoticeRegion notice={notice} />
      </div>
    </div>
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
