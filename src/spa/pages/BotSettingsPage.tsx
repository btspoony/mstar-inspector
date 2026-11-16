import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FlowSection,
  StatusBadge,
} from "@design-system";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageNotice, type NoticeKind, type OpNotice } from "./PageNotice";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { deliveryOutcomeLabel } from "../delivery-outcome";
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import { formatRelativeTime } from "../relative-time";
import {
  appDisplayName,
  configuredKeySlot,
  modelChainTabs,
  parseBotSettings,
  parseModels,
  splitModelChain,
  type BotConfigSections,
  type BotSettingsPayload,
  type ModelOptionGroup,
} from "./data";
import {
  ChainsSection,
  RuntimeHarnessEditor,
  SeatsSection,
  pendingConfirmCopy,
  settingsErrorMessage,
  settingsOpOutcome,
  verifyRefusalMessage,
  type PendingAction,
} from "./SettingsPage";
import { ProvidersSection } from "./settings-providers";

/**
 * The bot settings page (`/dashboard/apps/:appId/bot`): the bot-owned
 * configuration — credentials health, provider keys, model chains, seats,
 * sandbox image, installations. The workspace-owned review policy (identity,
 * trigger, depth, gate, allowlist, pause) stays on the target detail, which
 * links here.
 *
 * `can_manage` is the page's ONLY permission bit, and the server computes it
 * for BOT-scoped writes: a `shared` bot reads as `false` whatever the caller's
 * workspace role is, so the sections render non-editable and the bot-scoped
 * POST family refuses the write the page would otherwise offer. Every write
 * below rides that existing family — this page adds no route of its own.
 */
export function BotSettingsPage({ boot, appId }: { boot: SpaBoot; appId: string }) {
  const locale = boot.locale;
  const base = apiBase();
  const [payload, setPayload] = useState<BotSettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
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
        let modelGroups: ModelOptionGroup[] = [];
        if (parsed.can_manage) {
          try {
            modelGroups =
              parseModels(await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}/models`))?.groups ?? [];
          } catch {
            modelGroups = [];
          }
        }
        if (cancelledRef.current) return false;
        setPayload(parsed);
        setGroups(modelGroups);
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

  // Wayfinding returns to the target detail the bot page was opened from —
  // that page owns everything this page does not configure.
  const detailHref = `${base}/targets/${encodeURIComponent(appId)}`;
  return (
    <BotSettingsShell locale={locale} detailHref={detailHref}>
      {state === "loading" ? <PageSkeleton locale={locale} kind="forms" /> : null}
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        <BotSettingsView
          locale={locale}
          payload={payload}
          groups={groups}
          notice={notice}
          onReload={load}
        />
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
 * tests can static-render it. A manager gets the editable sections; every other
 * caller (and every caller of a shared bot) gets the same values read-only.
 */
export function BotSettingsView({
  locale,
  payload,
  groups,
  notice,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
  groups: ModelOptionGroup[];
  notice: { kind: NoticeKind; message: string } | null;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const { app } = payload;
  // Every write below is the settings family's: the ops ride
  // `POST /apps/:appId/settings` (and its key/delete sibling), so this page
  // adds no second save path and the server's `can_manage` rule is the gate.
  const appPath = `${apiBase()}/apps/${app.github_app_id}`;
  const base = `${appPath}/settings`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [providersNotice, setProvidersNotice] = useState<OpNotice | null>(null);
  const [chainsNotice, setChainsNotice] = useState<OpNotice | null>(null);
  const [providersRemoveOutcome, setProvidersRemoveOutcome] = useState<{
    notice: OpNotice;
    slot: number;
  } | null>(null);

  async function submitSettings(
    fields: Record<string, string> | URLSearchParams,
  ): Promise<OpNotice & { reloaded: boolean }> {
    let status: number;
    let body: string;
    try {
      ({ status, body } = await postForm(base, fields));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed"), reloaded: false };
    }
    const outcome: OpNotice = settingsOpOutcome(locale, status, body);
    const reloaded = await onReload({ background: true });
    return { ...outcome, reloaded };
  }

  /**
   * The draft create's completion check: POST success alone is not done — the
   * chain is usable only once the awaited reload lands it in the payload, so a
   * failed reload keeps the draft open instead of claiming success.
   */
  async function createDraftChain(fields: Record<string, string>): Promise<OpNotice> {
    const outcome = await submitSettings(fields);
    if (outcome.kind === "success" && !outcome.reloaded) {
      return { kind: "error", message: t(locale, "common.loadFailed") };
    }
    return outcome;
  }

  /** Verify-then-store: the refresh keeps a failed verify's typed key on screen. */
  async function submitVerify(fields: Record<string, string>): Promise<OpNotice> {
    let status: number;
    let body: string;
    try {
      ({ status, body } = await postForm(
        `${apiBase()}/api/apps/${encodeURIComponent(String(app.github_app_id))}/keys/verify`,
        fields,
      ));
    } catch {
      // A fetch that never reached the server: the dialog's own face for it,
      // which also says nothing was stored.
      return { kind: "error", message: t(locale, "settings.providers.submitFailed") };
    }
    if (status >= 400) {
      const outcome: OpNotice = { kind: "error", message: verifyRefusalMessage(locale, status, body) };
      await onReload({ background: true });
      return outcome;
    }
    const outcome: OpNotice = { kind: "success", message: t(locale, "settings.keyVerified") };
    await onReload({ background: true });
    return outcome;
  }

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    try {
      if (action.kind === "remove-chain") {
        setChainsNotice(await submitSettings({ op: "remove-chain", name: action.name }));
      } else if (action.kind === "remove-custom") {
        // The remove outcome renders row-locally with the pre-POST row slot:
        // the awaited reload drops the row before the outcome resolves.
        const slot = payload.configured_providers.findIndex(
          (row) => row.kind === "custom" && row.provider_id === action.providerId,
        );
        setProvidersRemoveOutcome({
          notice: await submitSettings({ op: "remove-custom-provider", provider_id: action.providerId }),
          slot: slot >= 0 ? slot : payload.configured_providers.length,
        });
      } else if (action.kind === "remove-key") {
        const slot = configuredKeySlot(payload.configured_providers, action.provider, action.keyId);
        let outcome: OpNotice;
        try {
          const res = await postForm(`${base}/key/delete`, {
            provider: action.provider,
            key_id: action.keyId,
          });
          outcome = settingsOpOutcome(locale, res.status, res.body);
        } catch {
          outcome = { kind: "error", message: t(locale, "common.saveFailed") };
        }
        setProvidersRemoveOutcome({
          notice: outcome,
          slot: slot >= 0 ? slot : payload.configured_providers.length,
        });
        await onReload({ background: true });
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy = pendingConfirmCopy(locale, appDisplayName(app), pending);

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
        <SandboxSection locale={locale} payload={payload} onSettings={submitSettings} />
        {payload.can_manage ? (
          <>
            <ProvidersSection
              locale={locale}
              payload={payload}
              onVerify={submitVerify}
              onSettings={submitSettings}
              onPending={setPending}
              notice={providersNotice}
              removeOutcome={providersRemoveOutcome}
              onOutcome={setProvidersNotice}
            />
            <ChainsSection
              locale={locale}
              payload={payload}
              groups={groups}
              onSettings={submitSettings}
              onCreateDraft={createDraftChain}
              onRemoveChain={(name) => setPending({ kind: "remove-chain", name })}
              notice={chainsNotice}
              onOutcome={setChainsNotice}
            />
            <SeatsSection locale={locale} payload={payload} onSettings={submitSettings} />
          </>
        ) : (
          <>
            <BotProvidersSummary locale={locale} payload={payload} />
            <BotChainsSummary locale={locale} payload={payload} />
            <BotSeatsSummary locale={locale} payload={payload} />
          </>
        )}
        <BotInstallationsSection locale={locale} payload={payload} />
      </div>
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

/**
 * The bot's sandbox runtime image: a manager edits the registry selection, a
 * read-only face names the stored id. Bot-scoped — every review of this bot
 * runs under it, whatever target it serves.
 */
export function SandboxSection({
  locale,
  payload,
  onSettings,
}: {
  locale: SpaBoot["locale"];
  payload: BotConfigSections & { can_manage: boolean };
  onSettings: (fields: Record<string, string>) => Promise<OpNotice>;
}) {
  return (
    <FlowSection title={t(locale, "settings.runtimeHarness")} subtitle={t(locale, "botSettings.sandboxCopy")}>
      {payload.can_manage ? (
        <RuntimeHarnessEditor locale={locale} payload={payload} onSettings={onSettings} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(locale, "settings.runtimeHarnessValue", { id: payload.app.sandbox_image_id })}
        </p>
      )}
    </FlowSection>
  );
}

/**
 * Credentials health: the bot's last verified delivery, its refused count and
 * the recent deliveries. Bot-scoped — deliveries arrive on the bot's webhook
 * whatever target a review lands on.
 */
export function BotHealthSection({ locale, payload }: { locale: SpaBoot["locale"]; payload: BotConfigSections }) {
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
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t(locale, "settings.recentDeliveries")}</h3>
        <p className="text-sm text-muted-foreground">{t(locale, "settings.recentDeliveriesCopy")}</p>
        {payload.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "settings.noDeliveries")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {payload.deliveries.map((delivery, index) => (
              <li key={`${delivery.created_at}-${index}`} className="text-sm">
                <span className="font-medium">
                  {delivery.repository_full_name ?? t(locale, "settings.unknownSource")}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {delivery.event_name ?? t(locale, "settings.unknownEvent")} ·{" "}
                  {formatRelativeTime(delivery.created_at, locale)} ·{" "}
                  {deliveryOutcomeLabel(delivery.outcome, locale)} ·{" "}
                  {t(locale, "settings.status", {
                    code: delivery.status_code === null ? "—" : String(delivery.status_code),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </FlowSection>
  );
}

/** The configured providers, read-only: masked key tails and custom declarations. */
export function BotProvidersSummary({
  locale,
  payload,
}: {
  locale: SpaBoot["locale"];
  payload: BotConfigSections;
}) {
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

/** The stored model chains, read-only: the Default chain plus every named one. */
export function BotChainsSummary({
  locale,
  payload,
}: {
  locale: SpaBoot["locale"];
  payload: BotConfigSections;
}) {
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

/** The seat → chain assignment, read-only. */
export function BotSeatsSummary({ locale, payload }: { locale: SpaBoot["locale"]; payload: BotConfigSections }) {
  return (
    <FlowSection title={t(locale, "settings.seats")} subtitle={t(locale, "settings.seatsCopy")}>
      <ul className="flex flex-col gap-2">
        {payload.model_role_ids.map((role) => (
          <li key={role} className="text-sm">
            <span className="font-medium">{role}</span>
            <span className="text-muted-foreground">
              {" "}
              · {payload.model_roles[role]?.trim() || t(locale, "settings.useDefaultChain")}
            </span>
          </li>
        ))}
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
  payload: BotConfigSections;
}) {
  const columns: DataTableColumn<BotConfigSections["installations"][number]>[] = [
    {
      header: t(locale, "settings.installationsAccount"),
      cell: (inst) => inst.account_login ?? t(locale, "common.time.unknown"),
    },
    {
      header: t(locale, "settings.installationsId"),
      cell: (inst) => <span className="font-mono tabular-nums">{inst.installation_id}</span>,
    },
    {
      header: t(locale, "settings.installationsLastSync"),
      cell: (inst) => (
        <span className="text-muted-foreground tabular-nums">
          {formatRelativeTime(inst.seen_at, locale)}
        </span>
      ),
    },
  ];

  return (
    <FlowSection
      title={t(locale, "settings.installations")}
      subtitle={t(
        locale,
        payload.installations.length === 1 ? "settings.installationsCountOne" : "settings.installationsCount",
        { count: payload.installations.length },
      )}
    >
      <DataTable
        columns={columns}
        rows={payload.installations}
        rowKey={(inst) => String(inst.installation_id)}
        empty={<p className="text-sm text-muted-foreground">{t(locale, "settings.noInstallations")}</p>}
      />
    </FlowSection>
  );
}
