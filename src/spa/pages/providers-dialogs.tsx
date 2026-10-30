/**
 * The three provider dialogs (plan 103 task 4) — the entry points that
 * replaced the inline panels, so the providers list never grows a form
 * (AC-4) and configuring a provider never leaves the settings tab (AC-5).
 *
 * `StepDialog` owns only the shell; every dialog owns its busy state and its
 * failure contract: a rejected submit keeps the dialog open with every typed
 * value and renders the structured reason inline, and only a success dismisses
 * the flow (AC-6/7/8/9). The outcome reaches the card's region on success —
 * the flow has already closed and its local state is gone.
 *
 * One request per submit: the trigger disables while its POST is in flight,
 * and a synchronous ref swallows the second click/Enter that lands before
 * React re-renders the disabled button (I-000207).
 */
import { useRef, useState } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SpaBoot } from "../boot";
import { ProviderCombobox } from "../components/provider-combobox";
import { StepDialog } from "../components/StepDialog";
import {
  providerFormKind,
  providerKeyRows,
  selectedCatalogProvider,
  type CatalogProvider,
  type ProviderKeyRow,
  type SettingsManagePayload,
} from "./data";
import { NoticeRegion, type OpNotice } from "./PageNotice";

/** Mirrors `MAX_KEYS_PER_PROVIDER`; the store stays the enforcement point. */
const KEY_LIMIT = 8;

/**
 * Add provider: step 1 picks a catalog entry (grouped common / catalog in the
 * combobox panel; an `unavailable` entry stays selectable for discovery),
 * step 2 renders that entry's requirements. The unavailable step states the
 * reason and renders no form, so it has no submit path at all.
 */
export function AddProviderDialog({
  locale,
  open,
  onOpenChange,
  payload,
  onVerify,
  onSettings,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const selected = selectedCatalogProvider(payload.provider_catalog, selectedId);
  const imageId = payload.app.sandbox_image_id;
  const customById: Record<string, SettingsManagePayload["custom_providers"][number]> = {};
  for (const row of payload.custom_providers) customById[row.provider_id] = row;

  function close(): void {
    setSelectedId(undefined);
    setNotice(null);
    onOpenChange(false);
  }

  function back(): void {
    setSelectedId(undefined);
    setNotice(null);
  }

  // A failure stays in the dialog (the card's region is behind the overlay);
  // a success closes the flow and reports to the card, where it survives.
  function report(outcome: OpNotice): void {
    if (outcome.kind === "success") onOutcome(outcome);
    else setNotice(outcome);
  }

  return (
    <>
      <StepDialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : close())}
        title={
          selected
            ? t(locale, "settings.configureProvider", { label: selected.label })
            : t(locale, "settings.addProvider")
        }
        description={t(locale, "settings.addProviderCopy")}
        steps={[t(locale, "settings.providers.stepPick"), t(locale, "settings.providers.stepConfigure")]}
        currentStep={selected ? 1 : 0}
        footer={
          <>
            {selected ? (
              <Button type="button" variant="outline" onClick={back}>
                {t(locale, "settings.providers.back")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={close}>
              {t(locale, "common.cancel")}
            </Button>
          </>
        }
      >
        {selected ? (
          <div className="flex flex-col gap-3">
            <NoticeRegion notice={notice} />
            {selected.eligibility === "unavailable" ? (
              // Selectable for discovery, unsaveable by construction: no form,
              // so no submit path exists to reach the store.
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
                  onOutcome={report}
                  onDone={close}
                />
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t(locale, "settings.catalogProvenance", { count: payload.provider_catalog.length })}
            </p>
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  // The prototype's secondary entry: the catalog cannot declare
                  // an id it has never heard of, so the custom flow takes over
                  // from here with the same payload.
                  close();
                  setCustomOpen(true);
                }}
              >
                {t(locale, "settings.customEntry")}
              </Button>
              <p className="text-xs text-muted-foreground">{t(locale, "settings.customEntryCopy")}</p>
            </div>
          </div>
        )}
      </StepDialog>
      <CustomProviderDialog
        locale={locale}
        open={customOpen}
        onOpenChange={setCustomOpen}
        payload={payload}
        onSettings={onSettings}
        onOutcome={onOutcome}
      />
    </>
  );
}

/**
 * Add key to an existing provider group: one key field, the pool usage and the
 * 8-key ceiling. At the ceiling the submit is unavailable and the limit is
 * stated, so the store's own refusal is never the first the user hears of it.
 */
export function AddKeyDialog({
  locale,
  open,
  onOpenChange,
  provider,
  label,
  keyCount,
  onVerify,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider id the verify POST names. */
  provider: string;
  /** The group's display label — the dialog title's subject. */
  label: string;
  /** Keys the provider's pool already holds. */
  keyCount: number;
  onVerify: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const inFlight = useRef(false);
  const atLimit = keyCount >= KEY_LIMIT;

  function close(): void {
    setKey("");
    setNotice(null);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await onVerify({ provider, key });
      if (outcome.kind !== "success") {
        setNotice(outcome);
        return;
      }
      setNotice(null);
      setKey("");
      onOutcome(outcome);
      onOpenChange(false);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <StepDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={t(locale, "settings.providers.addKeyTo", { label })}
      description={t(locale, "settings.providers.keyUsage", { count: keyCount, limit: KEY_LIMIT })}
      footer={
        <Button type="button" variant="outline" onClick={close}>
          {t(locale, "common.cancel")}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <NoticeRegion notice={notice} />
        {atLimit ? (
          <p className="text-sm text-muted-foreground">
            {t(locale, "settings.providers.keyLimitReached", { limit: KEY_LIMIT })}
          </p>
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
        <Button type="submit" disabled={busy || atLimit}>
          {busy ? t(locale, "settings.providers.verifying") : t(locale, "settings.addKey")}
        </Button>
      </form>
    </StepDialog>
  );
}

/**
 * The custom declaration: an id the catalog does not know, its endpoint, the
 * API style, the model ids and the first key. Same contract as the two above —
 * no close on failure, and the typed declaration survives for correction.
 */
export function CustomProviderDialog({
  locale,
  open,
  onOpenChange,
  payload,
  onSettings,
  onOutcome,
}: {
  locale: SpaBoot["locale"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: SettingsManagePayload;
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome: (notice: OpNotice) => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState(payload.custom_provider_api_ids[0] ?? "");
  const [modelIds, setModelIds] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const inFlight = useRef(false);

  function close(): void {
    setProviderId("");
    setBaseUrl("");
    setModelIds("");
    setKey("");
    setNotice(null);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
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
      if (outcome.kind !== "success") {
        setNotice(outcome);
        return;
      }
      setNotice(null);
      onOutcome(outcome);
      close();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <StepDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={t(locale, "settings.addCustomProvider")}
      description={t(locale, "settings.customEntryCopy")}
      footer={
        <Button type="button" variant="outline" onClick={close}>
          {t(locale, "common.cancel")}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <NoticeRegion notice={notice} />
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
        <Button type="submit" disabled={busy}>
          {busy ? t(locale, "settings.providers.saving") : t(locale, "settings.addCustomProvider")}
        </Button>
      </form>
    </StepDialog>
  );
}

/**
 * The selected catalog entry's configuration requirements: template entries
 * materialize through op=add-template-provider, verifiable builtins use the
 * verify-first path, and console-only providers have no in-app form. A rejected
 * submit surfaces the structured reason and keeps the typed input; the caller
 * (the add-provider dialog) decides where that reason renders and closes the
 * flow on the success callback only.
 *
 * The template form carries the base URL explicitly — prefilled from the
 * catalog entry, editable as an override (required only when the entry's
 * catalog base URL is null) — and the account-id field appears only when the
 * effective base URL carries the {account_id} placeholder, mirroring the save
 * flow's conditional demand (breadth rows are not all Workers-AI-shaped).
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
  const inFlight = useRef(false);
  const formKind = providerFormKind(provider);

  // Both add-flow forms report through the dialog that owns them; a rejected
  // submit keeps the typed input for correction.
  async function submitTemplate(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function submitKey(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await onVerify({ provider: provider.id, key });
      onOutcome(outcome);
      if (outcome.kind === "success") {
        setKey("");
        onDone();
      }
    } finally {
      inFlight.current = false;
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
        <Button type="submit" disabled={busy}>
          {busy
            ? t(locale, "settings.providers.verifying")
            : t(locale, "settings.addTemplate", { label: provider.label })}
        </Button>
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
      <Button type="submit" disabled={busy}>
        {busy ? t(locale, "settings.providers.verifying") : t(locale, "settings.addKey")}
      </Button>
    </form>
  );
}
