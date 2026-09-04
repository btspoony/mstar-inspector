import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import {
  activeChainTabId,
  DEFAULT_CHAIN_NAME,
  modelChainTabs,
  parseModels,
  parseSettings,
  providerFormKind,
  seatRoleValues,
  seatSelectValue,
  selectedCatalogProvider,
  splitModelChain,
  type CatalogProvider,
  type ConfiguredProvider,
  type ModelOptionGroup,
  type SettingsManagePayload,
  type SettingsPayload,
} from "./data";
import { spaClick, StatusBadge } from "./AppsPage";
import { LoadFailedNotice, LoadingNotice, PageNotice, type NoticeKind } from "./PageNotice";

type PendingAction =
  | { kind: "pause" | "resume" | "disable" | "enable" | "delete" }
  | { kind: "remove-chain"; name: string }
  | { kind: "remove-key"; provider: string }
  | { kind: "remove-custom"; providerId: string };

export function SettingsPage({ boot, slug }: { boot: SpaBoot; slug: string }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);

  // Background reloads (op-triggered refreshes) keep the loaded card tree
  // mounted: they must not flip state back to "loading" — that unmount would
  // destroy Add Provider's open/selection state and every form's typed input
  // (plan 38 QC fix wave 1, F-001). A failed background refresh surfaces the
  // error through the notice channel instead of the page-level error state.
  async function load({ background = false }: { background?: boolean } = {}): Promise<void> {
    if (!background) setState("loading");
    try {
      const settingsRaw = await fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/settings`);
      if (cancelledRef.current) return;
      const parsed = parseSettings(settingsRaw);
      if (!parsed) {
        if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
        return;
      }
      let nextGroups: ModelOptionGroup[] = [];
      if (parsed.can_manage) {
        try {
          const modelsRaw = await fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/models`);
          nextGroups = parseModels(modelsRaw)?.groups ?? [];
        } catch {
          nextGroups = [];
        }
      }
      if (cancelledRef.current) return;
      setPayload(parsed);
      setGroups(nextGroups);
      setState("ok");
    } catch {
      if (!cancelledRef.current) {
        if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
      }
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <div className="flex flex-col gap-6">
      {/* Wayfinding (plan 40 T2): the App settings page reads as one workflow
          with the Apps list — a visible path back to the list it came from. */}
      <div className="flex flex-col gap-1">
        <a
          className="text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
          href="/dashboard/apps"
          onClick={(event) => spaClick("/dashboard/apps", event)}
        >
          {t(locale, "settings.backToApps")}
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "settings.title")}</h1>
      </div>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {state === "ok" && payload ? (
        <SettingsView locale={locale} payload={payload} groups={groups} onNotice={setNotice} onReload={load} />
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
    /* plaintext 400 */
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
  onReload: (options?: { background?: boolean }) => Promise<void>;
}) {
  const { app } = payload;
  const base = `/dashboard/apps/${app.slug}/settings`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitSettings(fields: Record<string, string>): Promise<boolean> {
    const { status, body } = await postForm(base, fields);
    if (status >= 400) {
      onNotice({ kind: "error", message: settingsErrorMessage(locale, body) });
      await onReload({ background: true });
      return false;
    }
    onNotice({ kind: "success", message: t(locale, "settings.changesSaved") });
    await onReload({ background: true });
    return true;
  }

  // Plan 38: returns whether the key was verified AND stored. The refresh
  // after the POST is a background reload (the card tree stays mounted), so a
  // failed verify keeps the add panel open with the typed key for correction
  // while the provider stays unconfigured; only success resets/closes the
  // form via onDone.
  async function submitVerify(fields: Record<string, string>): Promise<boolean> {
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
        /* body is not JSON */
      }
      onNotice({ kind: "error", message: verifyReasonMessage(locale, reason) });
      await onReload({ background: true });
      return false;
    }
    onNotice({ kind: "success", message: t(locale, "settings.keyVerified") });
    await onReload({ background: true });
    return true;
  }

  async function runPinned(path: string): Promise<void> {
    await runPinnedWithBody(path, {});
  }

  /**
   * POST a pinned ops path and report the outcome through the notice channel.
   * Options: `successMessage` differentiates an outcome the generic
   * "Changes saved." would misrepresent; `reload: false` skips the background
   * refetch when the follow-up settings GET is guaranteed to fail — a
   * soft-deleted App is invisible to that route, so a delete's refetch would
   * 404 and overwrite the outcome with "Load failed."
   */
  async function runPinnedWithBody(
    path: string,
    fields: Record<string, string>,
    { successMessage, reload = true }: { successMessage?: string; reload?: boolean } = {},
  ): Promise<void> {
    const { status, body } = await postForm(path, fields);
    if (status >= 400) {
      onNotice({ kind: "error", message: body.trim() || t(locale, "common.loadFailed") });
      if (reload) await onReload({ background: true });
      return;
    }
    onNotice({ kind: "success", message: successMessage ?? t(locale, "settings.changesSaved") });
    if (reload) await onReload({ background: true });
  }

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    try {
      if (action.kind === "remove-chain") {
        await submitSettings({ op: "remove-chain", name: action.name });
      } else if (action.kind === "remove-custom") {
        await submitSettings({ op: "remove-custom-provider", provider_id: action.providerId });
      } else if (action.kind === "remove-key") {
        await runPinnedWithBody(`/dashboard/apps/${app.slug}/settings/key/delete`, {
          provider: action.provider,
        });
      } else if (action.kind === "delete") {
        // Irreversible outcome with its own copy: "Changes saved." reads wrong
        // after a delete, and the user stays on the deleted App's page.
        // reload: false — the deleted App's settings GET is a guaranteed 404.
        await runPinnedWithBody(
          `/dashboard/apps/${app.slug}/delete`,
          {},
          { successMessage: t(locale, "settings.deleteSuccess"), reload: false },
        );
      } else {
        await runPinned(`/dashboard/apps/${app.slug}/${action.kind}`);
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy = pendingConfirmCopy(locale, app.slug, pending);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{app.slug}</h2>
        <StatusBadge locale={locale} status={app.status} reviewEnabled={app.review_enabled} />
        <span className="text-sm text-muted-foreground">{t(locale, "apps.by", { login: app.created_by })}</span>
      </div>

      {payload.can_manage ? (
        <OpsCard locale={locale} payload={payload} onPending={setPending} />
      ) : (
        <HealthCard locale={locale} payload={payload} />
      )}

      <RuntimeImageCard locale={locale} payload={payload} onSettings={submitSettings} />

      {payload.can_manage ? (
        <>
          <ProvidersCard
            locale={locale}
            payload={payload}
            onVerify={submitVerify}
            onSettings={submitSettings}
            onPending={setPending}
          />
          <ChainsCard
            locale={locale}
            payload={payload}
            groups={groups}
            onSettings={submitSettings}
            onRemoveChain={(name) => setPending({ kind: "remove-chain", name })}
          />
          <SeatsCard locale={locale} payload={payload} onSettings={submitSettings} />
        </>
      ) : null}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent>
          {pending && confirmCopy ? (
            <>
              <DialogHeader>
                <DialogTitle>{confirmCopy.title}</DialogTitle>
                <DialogDescription>{confirmCopy.body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={busy}>
                    {t(locale, "common.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  variant={confirmCopy.destructive ? "destructive" : "default"}
                  disabled={busy}
                  onClick={() => void onConfirm()}
                >
                  {confirmCopy.action}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function pendingConfirmCopy(
  locale: SpaBoot["locale"],
  slug: string,
  pending: PendingAction | null,
): { title: string; body: string; action: string; destructive: boolean } | null {
  if (!pending) return null;
  if (pending.kind === "remove-chain") {
    return {
      title: t(locale, "settings.confirmRemoveChainTitle", { name: pending.name }),
      body: t(locale, "settings.confirmRemoveChainBody", { name: pending.name }),
      action: t(locale, "settings.remove"),
      destructive: true,
    };
  }
  if (pending.kind === "remove-key") {
    return {
      title: t(locale, "settings.confirmRemoveKeyTitle", { provider: pending.provider }),
      body: t(locale, "settings.confirmRemoveKeyBody", { provider: pending.provider }),
      action: t(locale, "settings.remove"),
      destructive: true,
    };
  }
  if (pending.kind === "remove-custom") {
    return {
      title: t(locale, "settings.confirmRemoveCustomTitle", { provider: pending.providerId }),
      body: t(locale, "settings.confirmRemoveCustomBody", { provider: pending.providerId }),
      action: t(locale, "settings.remove"),
      destructive: true,
    };
  }
  const map = {
    pause: {
      title: t(locale, "settings.confirmPauseTitle", { slug }),
      body: t(locale, "settings.confirmPauseBody"),
      action: t(locale, "apps.actions.pause"),
      destructive: false,
    },
    resume: {
      title: t(locale, "settings.confirmResumeTitle", { slug }),
      body: t(locale, "settings.confirmResumeBody"),
      action: t(locale, "apps.actions.resume"),
      destructive: false,
    },
    disable: {
      title: t(locale, "settings.confirmDisableTitle", { slug }),
      body: t(locale, "settings.confirmDisableBody"),
      action: t(locale, "settings.confirmDisableAction"),
      destructive: true,
    },
    enable: {
      title: t(locale, "settings.confirmEnableTitle", { slug }),
      body: t(locale, "settings.confirmEnableBody"),
      action: t(locale, "apps.actions.enable"),
      destructive: false,
    },
    delete: {
      title: t(locale, "settings.confirmDeleteTitle", { slug }),
      body: t(locale, "settings.confirmDeleteBody"),
      action: t(locale, "settings.confirmDeleteButton"),
      destructive: true,
    },
  } as const;
  return map[pending.kind];
}

function HealthBody({ locale, payload }: { locale: SpaBoot["locale"]; payload: SettingsPayload }) {
  const { app } = payload;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t(locale, "settings.lastWebhook", { time: formatRelativeTime(app.last_webhook_at, locale) })}
        {payload.delivery_summary && payload.delivery_summary.rejected24h > 0
          ? ` · ${t(locale, "apps.health.rejected24h", { count: payload.delivery_summary.rejected24h })}`
          : ""}
      </p>
      {payload.installations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, "settings.noInstallations")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {payload.installations.map((inst) => (
            <li key={inst.installation_id} className="text-sm">
              <span className="font-medium">{inst.account_login ?? t(locale, "common.time.unknown")}</span>
              <span className="text-muted-foreground">
                {" "}
                · {t(locale, "settings.installation", { id: inst.installation_id })} ·{" "}
                {t(locale, "settings.lastSeen", { time: formatRelativeTime(inst.seen_at, locale) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <h3 className="text-sm font-medium">{t(locale, "settings.recentDeliveries")}</h3>
        <p className="text-sm text-muted-foreground">{t(locale, "settings.recentDeliveriesCopy")}</p>
        {payload.deliveries.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t(locale, "settings.noDeliveries")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {payload.deliveries.map((delivery, index) => (
              <li key={`${delivery.created_at}-${index}`} className="text-sm">
                <span className="font-medium">{delivery.event_name ?? t(locale, "settings.unknownEvent")}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {formatRelativeTime(delivery.created_at, locale)} · {delivery.outcome} ·{" "}
                  {t(locale, "settings.status", {
                    code: delivery.status_code === null ? "—" : String(delivery.status_code),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HealthCard({ locale, payload }: { locale: SpaBoot["locale"]; payload: SettingsPayload }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.installHealth")}</CardTitle>
        <CardDescription>{t(locale, "settings.installHealthCopy")}</CardDescription>
      </CardHeader>
      <CardContent>
        <HealthBody locale={locale} payload={payload} />
      </CardContent>
    </Card>
  );
}

/**
 * Runtime image (plan 37): the App's sandbox runtime-image selection.
 * Managers get the shadcn selector over the enabled registry entries (one
 * `omp` option this iteration) and save through op=save-sandbox-image;
 * other members get the read-only selected id. The payload carries registry
 * ids only — never image-local configuration or secrets.
 */
function RuntimeImageCard({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.runtimeImage")}</CardTitle>
        <CardDescription>{t(locale, "settings.runtimeImageCopy")}</CardDescription>
      </CardHeader>
      <CardContent>
        {payload.can_manage ? (
          <RuntimeImageEditor locale={locale} payload={payload} onSettings={onSettings} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(locale, "settings.runtimeImageValue", { id: payload.app.sandbox_image_id })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeImageEditor({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState(payload.app.sandbox_image_id);

  useEffect(() => {
    setSelected(payload.app.sandbox_image_id);
  }, [payload.app.sandbox_image_id]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-64 max-w-xs">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger aria-label={t(locale, "settings.runtimeImage")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {payload.sandbox_images.map((image) => (
              <SelectItem key={image.id} value={image.id}>
                {image.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        onClick={() => void onSettings({ op: "save-sandbox-image", sandbox_image_id: selected })}
      >
        {t(locale, "settings.saveRuntimeImage")}
      </Button>
    </div>
  );
}

function OpsCard({
  locale,
  payload,
  onPending,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsPayload;
  onPending: (action: PendingAction) => void;
}) {
  const { app } = payload;
  const paused = app.status === "active" && !app.review_enabled;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.ops")}</CardTitle>
        <CardDescription>{t(locale, "settings.opsCopy")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-2">
          {app.status === "active" ? (
            paused ? (
              <Button type="button" onClick={() => onPending({ kind: "resume" })}>
                {t(locale, "settings.resumeReviews")}
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={() => onPending({ kind: "pause" })}>
                {t(locale, "settings.pauseReviews")}
              </Button>
            )
          ) : (
            <p className="text-sm text-muted-foreground">{t(locale, "settings.disconnected")}</p>
          )}
          {app.status === "active" ? (
            <Button type="button" variant="destructive-outline" onClick={() => onPending({ kind: "disable" })}>
              {t(locale, "apps.actions.disable")}
            </Button>
          ) : (
            <Button type="button" variant="secondary" onClick={() => onPending({ kind: "enable" })}>
              {t(locale, "apps.actions.enable")}
            </Button>
          )}
          <Button type="button" variant="destructive" onClick={() => onPending({ kind: "delete" })}>
            {t(locale, "apps.actions.delete")}
          </Button>
        </div>
        <HealthBody locale={locale} payload={payload} />
      </CardContent>
    </Card>
  );
}

/**
 * Providers (plan 38): this card lists ONLY the App's configured providers —
 * a stored key (masked tail) or a saved custom-provider declaration. Catalog
 * entries are discovery metadata and appear solely inside the Add Provider
 * picker, whose selection determines the configuration form; the non-catalog
 * custom declaration path (CustomExpand) stays for ids outside the catalog.
 *
 * Plan 42: the Add Provider entry is a labeled, bordered button in the card
 * header (CardAction slot) — the catalog breadth made discoverability the
 * point, so the flow opens from a control that reads as a control. The open
 * panel is the card content's first row.
 */
function ProvidersCard({
  locale,
  payload,
  onVerify,
  onSettings,
  onPending,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<boolean>;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  onPending: (action: PendingAction) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const catalogById: Record<string, CatalogProvider> = {};
  for (const provider of payload.provider_catalog) catalogById[provider.id] = provider;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.providers")}</CardTitle>
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
          open={addOpen}
          onOpenChange={setAddOpen}
        />
        {payload.configured_providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.noConfiguredProviders")}</p>
        ) : (
          payload.configured_providers.map((row) =>
            row.kind === "key" ? (
              <ConfiguredKeyRow
                key={row.provider}
                locale={locale}
                row={row}
                label={catalogById[row.provider]?.label ?? row.provider}
                onPending={onPending}
              />
            ) : (
              <ConfiguredCustomRow
                key={row.provider_id}
                locale={locale}
                row={row}
                label={catalogById[row.provider_id]?.label ?? row.provider_id}
                onPending={onPending}
              />
            ),
          )
        )}
        <CustomExpand
          locale={locale}
          payload={payload}
          expanded={customOpen}
          onToggle={() => setCustomOpen(!customOpen)}
          onSettings={onSettings}
        />
      </CardContent>
    </Card>
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
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {row.provider} ·{" "}
          {row.last4 ? t(locale, "settings.keyEnding", { last4: row.last4 }) : t(locale, "settings.keyTooShort")}
          {row.updated_at
            ? ` · ${t(locale, "settings.updated", { time: formatRelativeTime(row.updated_at, locale) })}`
            : ""}
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => onPending({ kind: "remove-key", provider: row.provider })}
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
  onPending,
}: {
  locale: SpaBoot["locale"];
  row: Extract<ConfiguredProvider, { kind: "custom" }>;
  label: string;
  onPending: (action: PendingAction) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-sm text-muted-foreground">
          {row.provider_id} · {row.base_url} · {row.api} · {row.model_ids.join(", ")}
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => onPending({ kind: "remove-custom", providerId: row.provider_id })}
      >
        {t(locale, "settings.remove")}
      </Button>
    </div>
  );
}

/**
 * Add Provider (plan 38): the open panel beneath the card header's labeled
 * disclosure button (plan 42 moved the button to the CardAction slot; the
 * panel renders as the content's first row). The selected entry's id
 * determines the configuration form rendered beneath the picker. Catalog
 * provenance (the committed models.dev snapshot, static code) and per-entry
 * runtime eligibility (builtin / template / unavailable vs the App's selected
 * image) are disclosed in copy; an unavailable entry renders its explanation
 * with no submit path. The picker groups builtin tier first, then template,
 * and height-caps the list to an internal scroll so the snapshot breadth
 * stays usable. Only a successful submit closes the flow — a failed
 * verify/add keeps the selection and typed input while the provider stays
 * unconfigured.
 */
function AddProviderSection({
  locale,
  payload,
  onVerify,
  onSettings,
  open,
  onOpenChange,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<boolean>;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = selectedCatalogProvider(payload.provider_catalog, selectedId);
  const imageId = payload.app.sandbox_image_id;
  const keyByProvider: Record<string, SettingsManagePayload["keys"][number]> = {};
  for (const key of payload.keys) keyByProvider[key.provider] = key;
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
        <Select value={selectedId} onValueChange={setSelectedId}>
          <SelectTrigger aria-labelledby="settings-catalog-provider-label">
            <SelectValue placeholder={t(locale, "settings.selectProvider")} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectGroup>
              <SelectLabel>{t(locale, "settings.catalogBuiltin")}</SelectLabel>
              {payload.provider_catalog
                .filter((provider) => provider.tier === "builtin")
                .map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                    {provider.eligibility === "unavailable"
                      ? ` — ${t(locale, "settings.eligibilityUnavailableShort", { image: imageId })}`
                      : ""}
                  </SelectItem>
                ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>{t(locale, "settings.catalogTemplate")}</SelectLabel>
              {payload.provider_catalog
                .filter((provider) => provider.tier === "template")
                .map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                    {provider.eligibility === "unavailable"
                      ? ` — ${t(locale, "settings.eligibilityUnavailableShort", { image: imageId })}`
                      : ""}
                  </SelectItem>
                ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {selected ? (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-medium">
            {t(locale, "settings.configureProvider", { label: selected.label })}
          </h4>
          {selected.eligibility === "unavailable" ? (
            // Runtime-ineligible rows stay selectable for discovery but get
            // an explanation instead of a form — no submit path, so an
            // unusable provider can never be saved silently (plan 38 T3).
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
                storedKey={keyByProvider[selected.id]}
                custom={customById[selected.id]}
                onVerify={onVerify}
                onSettings={onSettings}
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
 * The selected catalog entry's configuration requirements (plan 38): template
 * entries materialize through op=add-template-provider, verifiable builtins
 * use the verify-first /keys/verify path, and console-only providers have no
 * in-app form. Every form clears and closes only on success — a rejected
 * submit surfaces the structured error and keeps the typed input.
 *
 * Plan 42: the template form carries the base URL explicitly — prefilled from
 * the catalog entry, editable as an override (required only when the entry's
 * catalog base URL is null) — and the account-id field appears only when the
 * effective base URL carries the {account_id} placeholder, mirroring the
 * save flow's conditional demand (breadth rows are not all Workers-AI-shaped).
 */
function ProviderConfigForm({
  locale,
  provider,
  storedKey,
  custom,
  onVerify,
  onSettings,
  onDone,
}: {
  locale: SpaBoot["locale"];
  provider: CatalogProvider;
  storedKey: SettingsManagePayload["keys"][number] | undefined;
  custom: SettingsManagePayload["custom_providers"][number] | undefined;
  onVerify: (fields: Record<string, string>) => Promise<boolean>;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const formKind = providerFormKind(provider);

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
          void onSettings({
            op: "add-template-provider",
            template_id: provider.id,
            base_url: baseUrl,
            account_id: accountId,
            key,
          }).then((ok) => {
            // A rejected save (400 keeps the notice) must NOT wipe the typed
            // account id / key the user needs to fix (QC wave, seat3).
            if (ok) {
              setKey("");
              setAccountId("");
              setBaseUrl("");
              onDone();
            }
          });
        }}
      >
        {custom ? (
          <p className="text-sm text-muted-foreground">
            {custom.base_url} · {custom.api} · {custom.model_ids.join(", ")}
          </p>
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
        <Button type="submit">{t(locale, "settings.addTemplate", { label: provider.label })}</Button>
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
        void onVerify({ provider: provider.id, key }).then((ok) => {
          // The post-submit reload is background (the tree stays mounted), so
          // a failed verify keeps the typed key for correction — the provider
          // stays unconfigured and the structured reason is shown. Success
          // closes/resets deliberately via onDone.
          if (ok) {
            setKey("");
            onDone();
          }
        });
      }}
    >
      {storedKey ? (
        <p className="text-sm text-muted-foreground">
          {t(locale, "settings.keyEnding", { last4: storedKey.last4 })}
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
      <Button type="submit">{t(locale, "settings.addKey")}</Button>
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
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
}) {
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState(payload.custom_provider_api_ids[0] ?? "");
  const [modelIds, setModelIds] = useState("");
  const [key, setKey] = useState("");

  return (
    <div className="rounded-md border p-3">
      <button type="button" className="flex w-full flex-col items-start text-left" onClick={onToggle}>
        <span className="font-medium">{t(locale, "settings.customEntry")}</span>
        <span className="text-xs text-muted-foreground">{t(locale, "settings.customEntryCopy")}</span>
      </button>
      {expanded ? (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onSettings({
              op: "add-custom-provider",
              provider_id: providerId,
              base_url: baseUrl,
              api,
              model_ids: modelIds,
              key,
            }).then((ok) => {
              // QC wave (seat3): a rejected save keeps the typed input for
              // correction — only a successful save clears the form.
              if (ok) {
                setProviderId("");
                setBaseUrl("");
                setModelIds("");
                setKey("");
              }
            });
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
          <Button type="submit">{t(locale, "settings.addCustomProvider")}</Button>
        </form>
      ) : null}
    </div>
  );
}

function ChainsCard({
  locale,
  payload,
  groups,
  onSettings,
  onRemoveChain,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  groups: ModelOptionGroup[];
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  onRemoveChain: (name: string) => void;
}) {
  const [newName, setNewName] = useState("");
  // Plan 43: the add-chain entry is a strip-level disclosure — the toggle
  // opens the create form directly beneath the tab strip.
  const [createOpen, setCreateOpen] = useState(false);
  // Plan 39: Default and named chains are peer tabs. The selection coerces
  // through activeChainTabId so a delete or a stale payload lands on the
  // non-removable Default tab instead of pointing at a removed chain.
  const [selectedTab, setSelectedTab] = useState<string>(DEFAULT_CHAIN_NAME);
  const tabs = modelChainTabs(payload.model_chains);
  const namedTabs = tabs.filter((tab) => !tab.isDefault);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.modelChains")}</CardTitle>
        <CardDescription>{t(locale, "settings.modelChainsCopy")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Tabs value={activeChainTabId(tabs, selectedTab)} onValueChange={setSelectedTab}>
          {/* Plan 43: the add-chain entry lives in the tab-strip row, so
              adding a chain reads as a tab action instead of a detached form
              below the card. The button is a TabsList SIBLING (never inside
              the role=tablist) mirroring the plan-42 providers header entry:
              outline control, plus glyph, localized label. */}
          <div className="flex items-center gap-2">
            <TabsList aria-label={t(locale, "settings.modelChains")}>
              {tabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id}>
                  {tab.isDefault ? t(locale, "settings.defaultChain") : tab.id}
                </TabsTrigger>
              ))}
            </TabsList>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={createOpen}
              onClick={() => setCreateOpen(!createOpen)}
            >
              <Plus aria-hidden="true" />
              {t(locale, "settings.addChain")}
            </Button>
          </div>
          {/* The create form discloses beneath the strip with the plan-39
              flow verbatim: op=add-chain, a 400 keeps the typed input, and a
              successful create selects the new tab after the reload lands. */}
          {createOpen ? (
            <NamedChainCreate
              locale={locale}
              groups={groups}
              name={newName}
              onName={setNewName}
              onSettings={onSettings}
              onCreated={(created) => setSelectedTab(created)}
            />
          ) : null}
          {/* forceMount keeps every editor mounted (as the pre-tab list did),
              so switching tabs never silently drops in-progress edits. Radix
              itself hides nothing once forceMount pins every panel to
              present — inactive panels are hidden by the local TabsContent
              wrapper's data-[state=inactive]:hidden class. */}
          <TabsContent forceMount value={DEFAULT_CHAIN_NAME}>
            <ChainEditor
              locale={locale}
              groups={groups}
              stored={payload.model_chain}
              onSave={(chain) => void onSettings({ op: "save-chain", model_chain: chain })}
            />
          </TabsContent>
          {namedTabs.map((tab) => (
            <TabsContent key={tab.id} forceMount value={tab.id}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium">{tab.id}</span>
                <Button type="button" variant="destructive" size="sm" onClick={() => onRemoveChain(tab.id)}>
                  {t(locale, "settings.remove")}
                </Button>
              </div>
              <ChainEditor
                locale={locale}
                groups={groups}
                stored={tab.chain}
                onSave={(value) => void onSettings({ op: "add-chain", name: tab.id, chain: value })}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

/**
 * Seats (plan 39 T2): the role → chain mapping is its own card below chain
 * management, independent of the chain tabs. Every select offers Default
 * first, then the current named chains from the same plan-39 tab model; a
 * stored name that no longer resolves (deleted chain, stale payload) renders
 * and saves as Default, so op=save-roles never submits an invalid reference.
 * The save stays the route's full-map contract: one role_<role> field per
 * audit seat, always all seats.
 */
function SeatsCard({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
}) {
  const tabs = modelChainTabs(payload.model_chains);
  const namedTabs = tabs.filter((tab) => !tab.isDefault);
  const roleHint = (role: string) =>
    role === "mstar-review-seat" ? t(locale, "settings.roleHintReviewSeat") : t(locale, "settings.roleHintDeep");
  // Stable id-set key over the offered chain tabs: the re-derivation effect
  // below keys on it so payload object identity churn alone never fires it.
  const tabIdSetKey = tabs.map((tab) => tab.id).join();
  const [seats, setSeats] = useState<Record<string, string>>(() =>
    seatRoleValues(payload.model_role_ids, payload.model_roles, tabs),
  );

  // The seat state re-derives from the payload ONLY when the offered
  // chain-tab set changes (tabIdSetKey dep — a chain delete cascade or
  // create); unrelated-op background reloads keep unsaved seat picks. Stale
  // references the offered set no longer contains still coerce to the safe
  // Default value at render and save via seatSelectValue.
  useEffect(() => {
    setSeats(seatRoleValues(payload.model_role_ids, payload.model_roles, tabs));
  }, [tabIdSetKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.seats")}</CardTitle>
        <CardDescription>{t(locale, "settings.seatsCopy")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const fields: Record<string, string> = { op: "save-roles" };
            for (const role of payload.model_role_ids) {
              fields[`role_${role}`] = seatSelectValue(tabs, seats[role]);
            }
            void onSettings(fields);
          }}
        >
          {payload.model_role_ids.map((role) => (
            <label key={role} className="flex flex-col gap-1.5 text-sm font-medium">
              {role} — {roleHint(role)}
              <Select
                value={seatSelectValue(tabs, seats[role])}
                onValueChange={(value) => setSeats((current) => ({ ...current, [role]: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_CHAIN_NAME}>{t(locale, "settings.useDefaultChain")}</SelectItem>
                  {namedTabs.map((tab) => (
                    <SelectItem key={tab.id} value={tab.id}>
                      {tab.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ))}
          <Button type="submit">{t(locale, "settings.saveRoleModels")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function NamedChainCreate({
  locale,
  groups,
  name,
  onName,
  onSettings,
  onCreated,
}: {
  locale: SpaBoot["locale"];
  groups: ModelOptionGroup[];
  name: string;
  onName: (name: string) => void;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  /** Fired after a successful create (the reload has landed) so the new tab is selected. */
  onCreated: (name: string) => void;
}) {
  const [chain, setChain] = useState<string[]>([]);
  return (
    <div className="rounded-md border p-3">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t(locale, "settings.chainName")}
        <Input
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder={t(locale, "settings.chainNamePlaceholder")}
          autoComplete="off"
        />
      </label>
      <div className="mt-3">
        <ChainEditor
          locale={locale}
          groups={groups}
          stored={chain.join(", ")}
          onChainChange={setChain}
          onSave={(value) => {
            void onSettings({ op: "add-chain", name, chain: value }).then((ok) => {
              // QC wave (seat3): a 400 keeps the typed name/chain for
              // correction — only a successful save clears the form.
              if (ok) {
                onName("");
                setChain([]);
                // Plan 39: the successful reload has landed, so the created
                // chain's tab exists — select it.
                onCreated(name);
              }
            });
          }}
          saveLabel={t(locale, "settings.addNamedChain")}
        />
      </div>
    </div>
  );
}

function ChainEditor({
  locale,
  groups,
  stored,
  onSave,
  onChainChange,
  saveLabel,
}: {
  locale: SpaBoot["locale"];
  groups: ModelOptionGroup[];
  stored: string | null;
  onSave: (chain: string) => void;
  onChainChange?: (chain: string[]) => void;
  saveLabel?: string;
}) {
  const [chain, setChain] = useState(() => splitModelChain(stored));
  const [pick, setPick] = useState<string | undefined>(undefined);
  const probeProviders = groups.filter((group) => group.source === "probe");

  useEffect(() => {
    setChain(splitModelChain(stored));
  }, [stored]);

  function update(next: string[]): void {
    setChain(next);
    onChainChange?.(next);
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.length === 0 ? <p className="text-sm text-muted-foreground">{t(locale, "settings.noVerifiedModels")}</p> : null}
      {probeProviders.map((group) => (
        <p className="text-sm text-muted-foreground" key={group.provider}>
          {group.provider}: {t(locale, "settings.noAutoDiscovery")}
        </p>
      ))}
      {chain.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, "settings.chainEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {chain.map((selector, index) => (
            <li key={`${selector}-${index}`} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <span className="font-mono text-sm">{selector}</span>
              <Button type="button" variant="destructive" size="sm" onClick={() => update(chain.filter((_, i) => i !== index))}>
                {t(locale, "settings.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <span className="text-sm font-medium">{t(locale, "settings.modelChainField")}</span>
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger aria-label={t(locale, "settings.modelChainField")}>
              <SelectValue placeholder={t(locale, "settings.pickModel")} />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) =>
                group.selectors.length === 0 ? null : (
                  <SelectGroup key={group.provider}>
                    <SelectLabel>{group.provider}</SelectLabel>
                    {group.selectors.map((selector) => (
                      <SelectItem key={selector} value={selector}>
                        {selector}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            if (!pick) return;
            update([...chain, pick]);
            setPick(undefined);
          }}
        >
          {t(locale, "settings.addToChain")}
        </Button>
      </div>
      <Button type="button" onClick={() => onSave(chain.join(", "))}>
        {saveLabel ?? t(locale, "settings.saveChain")}
      </Button>
    </div>
  );
}
