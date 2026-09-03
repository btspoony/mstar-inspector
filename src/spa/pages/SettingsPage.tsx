import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import {
  parseModels,
  parseSettings,
  splitModelChain,
  type CatalogProvider,
  type ModelOptionGroup,
  type SettingsManagePayload,
  type SettingsPayload,
} from "./data";
import { StatusBadge } from "./AppsPage";
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

  async function load(): Promise<void> {
    setState("loading");
    try {
      const settingsRaw = await fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/settings`);
      if (cancelledRef.current) return;
      const parsed = parseSettings(settingsRaw);
      if (!parsed) {
        setState("error");
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
      if (!cancelledRef.current) setState("error");
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
      <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "settings.title")}</h1>
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
  onReload: () => Promise<void>;
}) {
  const { app } = payload;
  const base = `/dashboard/apps/${app.slug}/settings`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitSettings(fields: Record<string, string>): Promise<boolean> {
    const { status, body } = await postForm(base, fields);
    if (status >= 400) {
      onNotice({ kind: "error", message: settingsErrorMessage(locale, body) });
      await onReload();
      return false;
    }
    onNotice(null);
    await onReload();
    return true;
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
        /* body is not JSON */
      }
      onNotice({ kind: "error", message: verifyReasonMessage(locale, reason) });
      await onReload();
      return;
    }
    onNotice({ kind: "success", message: t(locale, "settings.keyVerified") });
    await onReload();
  }

  async function runPinned(path: string): Promise<void> {
    await runPinnedWithBody(path, {});
  }

  async function runPinnedWithBody(path: string, fields: Record<string, string>): Promise<void> {
    const { status, body } = await postForm(path, fields);
    if (status >= 400) {
      onNotice({ kind: "error", message: body.trim() || t(locale, "common.loadFailed") });
      await onReload();
      return;
    }
    onNotice(null);
    await onReload();
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
      action: t(locale, "apps.actions.disable"),
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
      </CardHeader>
      <CardContent>
        <HealthBody locale={locale} payload={payload} />
      </CardContent>
    </Card>
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
            <Button type="button" variant="secondary" onClick={() => onPending({ kind: "disable" })}>
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

function ProvidersCard({
  locale,
  payload,
  onVerify,
  onSettings,
  onPending,
}: {
  locale: SpaBoot["locale"];
  payload: SettingsManagePayload;
  onVerify: (fields: Record<string, string>) => Promise<void>;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  onPending: (action: PendingAction) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const keyByProvider: Record<string, SettingsManagePayload["keys"][number]> = {};
  for (const key of payload.keys) keyByProvider[key.provider] = key;
  const customById: Record<string, SettingsManagePayload["custom_providers"][number]> = {};
  for (const row of payload.custom_providers) customById[row.provider_id] = row;
  const catalogIds: Record<string, true> = {};
  for (const provider of payload.providers) catalogIds[provider.id] = true;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.providers")}</CardTitle>
        <CardDescription>{t(locale, "settings.providersCopy")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {payload.providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            locale={locale}
            provider={provider}
            storedKey={keyByProvider[provider.id]}
            custom={customById[provider.id]}
            expanded={expanded === provider.id}
            onToggle={() => setExpanded(expanded === provider.id ? null : provider.id)}
            onVerify={onVerify}
            onSettings={onSettings}
            onRemoveKey={() => onPending({ kind: "remove-key", provider: provider.id })}
            onPending={onPending}
          />
        ))}
        <CustomExpand
          locale={locale}
          payload={payload}
          expanded={expanded === "__custom__"}
          onToggle={() => setExpanded(expanded === "__custom__" ? null : "__custom__")}
          onSettings={onSettings}
        />
        {payload.custom_providers
          .filter((row) => catalogIds[row.provider_id] === undefined)
          .map((row) => (
            <div key={row.provider_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
              <div>
                <div className="font-medium">{row.provider_id}</div>
                <div className="text-sm text-muted-foreground">
                  {row.base_url} · {row.api} · {row.model_ids.join(", ")}
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
          ))}
      </CardContent>
    </Card>
  );
}

function ProviderRow({
  locale,
  provider,
  storedKey,
  custom,
  expanded,
  onToggle,
  onVerify,
  onSettings,
  onRemoveKey,
  onPending,
}: {
  locale: SpaBoot["locale"];
  provider: CatalogProvider;
  storedKey: SettingsManagePayload["keys"][number] | undefined;
  custom: SettingsManagePayload["custom_providers"][number] | undefined;
  expanded: boolean;
  onToggle: () => void;
  onVerify: (fields: Record<string, string>) => Promise<void>;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  onRemoveKey: () => void;
  onPending: (action: PendingAction) => void;
}) {
  const tierLabel = t(locale, provider.tier === "template" ? "settings.tierTemplate" : "settings.tierBuiltin");
  return (
    <div className="rounded-md border p-3">
      <button type="button" className="flex w-full flex-col items-start text-left" onClick={onToggle}>
        <span className="font-medium">{provider.label}</span>
        <span className="text-xs text-muted-foreground">
          {provider.id} · {tierLabel}
          {storedKey
            ? ` · ${storedKey.last4 ? t(locale, "settings.keyEnding", { last4: storedKey.last4 }) : t(locale, "settings.keyTooShort")}`
            : ""}
          {custom ? ` · ${custom.base_url}` : ""}
        </span>
      </button>
      {expanded ? (
        <ProviderExpand
          locale={locale}
          provider={provider}
          storedKey={storedKey}
          custom={custom}
          onVerify={onVerify}
          onSettings={onSettings}
          onRemoveKey={onRemoveKey}
          onPending={onPending}
        />
      ) : null}
    </div>
  );
}

function ProviderExpand({
  locale,
  provider,
  storedKey,
  custom,
  onVerify,
  onSettings,
  onRemoveKey,
  onPending,
}: {
  locale: SpaBoot["locale"];
  provider: CatalogProvider;
  storedKey: SettingsManagePayload["keys"][number] | undefined;
  custom: SettingsManagePayload["custom_providers"][number] | undefined;
  onVerify: (fields: Record<string, string>) => Promise<void>;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
  onRemoveKey: () => void;
  onPending: (action: PendingAction) => void;
}) {
  const [key, setKey] = useState("");
  const [accountId, setAccountId] = useState("");

  if (provider.tier === "template") {
    return (
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onSettings({
            op: "add-template-provider",
            template_id: provider.id,
            account_id: accountId,
            key,
          }).then((ok) => {
            // QC wave (seat3): a rejected save (400 keeps the notice) must
            // NOT wipe the typed account id / key the user needs to fix.
            if (ok) {
              setKey("");
              setAccountId("");
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
          {t(locale, "settings.accountId")}
          <Input
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            placeholder={t(locale, "settings.accountIdPlaceholder")}
            autoComplete="off"
          />
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
        <div className="flex flex-wrap gap-2">
          <Button type="submit">{t(locale, "settings.addTemplate", { label: provider.label })}</Button>
          {custom ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => onPending({ kind: "remove-custom", providerId: provider.id })}
            >
              {t(locale, "settings.remove")}
            </Button>
          ) : null}
        </div>
      </form>
    );
  }

  if (!provider.verifiable) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{t(locale, "settings.consoleOnly")}</p>
        {storedKey ? (
          <Button type="button" variant="destructive" size="sm" onClick={onRemoveKey}>
            {t(locale, "settings.remove")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onVerify({ provider: provider.id, key }).then(() => setKey(""));
      }}
    >
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
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{t(locale, "settings.addKey")}</Button>
        {storedKey ? (
          <Button type="button" variant="destructive" onClick={onRemoveKey}>
            {t(locale, "settings.remove")}
          </Button>
        ) : null}
      </div>
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
  const named = payload.model_chains.filter((chain) => !chain.is_default);
  const roleHint = (role: string) =>
    role === "mstar-review-seat" ? t(locale, "settings.roleHintReviewSeat") : t(locale, "settings.roleHintDeep");
  const [seats, setSeats] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const role of payload.model_role_ids) {
      const stored = payload.model_roles[role] ?? "";
      next[role] = stored === "" ? "default" : stored;
    }
    return next;
  });
  const [newName, setNewName] = useState("");

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const role of payload.model_role_ids) {
      const stored = payload.model_roles[role] ?? "";
      next[role] = stored === "" ? "default" : stored;
    }
    setSeats(next);
  }, [payload.model_role_ids, payload.model_roles]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(locale, "settings.namedChains")}</CardTitle>
        <CardDescription>{t(locale, "settings.namedChainsCopy")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">{t(locale, "settings.defaultChain")}</h3>
          <ChainEditor
            locale={locale}
            groups={groups}
            stored={payload.model_chain}
            onSave={(chain) => void onSettings({ op: "save-chain", model_chain: chain })}
          />
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">{t(locale, "settings.namedChains")}</h3>
          {named.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(locale, "settings.noNamedChains")}</p>
          ) : (
            named.map((chain) => (
              <div key={chain.name} className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-medium">{chain.name}</span>
                  <Button type="button" variant="destructive" size="sm" onClick={() => onRemoveChain(chain.name)}>
                    {t(locale, "settings.remove")}
                  </Button>
                </div>
                <ChainEditor
                  locale={locale}
                  groups={groups}
                  stored={chain.chain}
                  onSave={(value) => void onSettings({ op: "add-chain", name: chain.name, chain: value })}
                />
              </div>
            ))
          )}
          <NamedChainCreate locale={locale} groups={groups} name={newName} onName={setNewName} onSettings={onSettings} />
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">{t(locale, "settings.seats")}</h3>
          <p className="text-sm text-muted-foreground">{t(locale, "settings.seatsCopy")}</p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const fields: Record<string, string> = { op: "save-roles" };
              for (const role of payload.model_role_ids) {
                fields[`role_${role}`] = seats[role] ?? "default";
              }
              void onSettings(fields);
            }}
          >
            {payload.model_role_ids.map((role) => (
              <label key={role} className="flex flex-col gap-1.5 text-sm font-medium">
                {role} — {roleHint(role)}
                <Select
                  value={seats[role] ?? "default"}
                  onValueChange={(value) => setSeats((current) => ({ ...current, [role]: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t(locale, "settings.useDefaultChain")}</SelectItem>
                    {named.map((chain) => (
                      <SelectItem key={chain.name} value={chain.name}>
                        {chain.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
            <Button type="submit">{t(locale, "settings.saveRoleModels")}</Button>
          </form>
        </section>
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
}: {
  locale: SpaBoot["locale"];
  groups: ModelOptionGroup[];
  name: string;
  onName: (name: string) => void;
  onSettings: (fields: Record<string, string>) => Promise<boolean>;
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
            <SelectTrigger>
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
