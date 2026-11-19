import { useState } from "react";
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
import { LoadingNotice, NoticeRegion, PageNotice, type NoticeKind, type OpNotice } from "./PageNotice";
import { patchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import {
  appDisplayName,
  configuredKeySlot,
  modelChainTabs,
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
 * The share route's refusals: its two recoverable causes have their own copy
 * (a stale page offering a share the designation no longer allows, and a
 * caller whose role changed under it); everything else reuses the settings
 * family's keyed resolver.
 */
function shareRefusalMessage(locale: SpaBoot["locale"], status: number, body: string): string {
  if (status === 409) return t(locale, "botSettings.shareOutsideOfficial");
  if (status === 403) return t(locale, "botSettings.shareForbidden");
  return settingsErrorMessage(locale, body);
}

/**
 * The bot-owned configuration: credentials health, provider keys, model
 * chains, seats, sandbox image. The App detail's 应用设置 tab composes it under
 * the App's identity header and its ops zone, so this module holds the
 * sections and their write pipeline and owns no page of its own (the retired
 * `/bot` page is a redirect to that tab).
 *
 * `payload.can_manage` is the BOT-scoped permission bit: a `shared` bot reads
 * as `false` whatever the caller's workspace role is, so the sections render
 * non-editable and the bot-scoped POST family refuses the write the face would
 * otherwise offer. Every write below rides that existing family.
 */
export function BotSettingsView({
  locale,
  payload,
  groups,
  modelsLoading = false,
  notice,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
  groups: ModelOptionGroup[];
  modelsLoading?: boolean;
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
  const [shareNotice, setShareNotice] = useState<OpNotice | null>(null);

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

  /**
   * The share transition: the server owns the guards and both audit rows, so
   * this only posts the target scope (a revoke always confirms) and turns the
   * refusal's named cause into the page's own copy.
   */
  async function submitScope(scope: "owned" | "shared"): Promise<OpNotice> {
    let status: number;
    let body: string;
    try {
      ({ status, body } = await patchJson(`${appPath}/bot/scope`, {
        scope,
        ...(scope === "owned" ? { confirm: true } : {}),
      }));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed") };
    }
    if (status < 200 || status >= 300) {
      return { kind: "error", message: shareRefusalMessage(locale, status, body) };
    }
    await onReload({ background: true });
    return {
      kind: "success",
      message: t(locale, scope === "shared" ? "botSettings.shareSaved" : "botSettings.unshareSaved"),
    };
  }

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    try {
      if (action.kind === "share") {
        setShareNotice(await submitScope("shared"));
      } else if (action.kind === "unshare") {
        setShareNotice(await submitScope("owned"));
      } else if (action.kind === "remove-chain") {
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
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {payload.can_manage ? null : (
        <div className="flex flex-col gap-2">
          <PageNotice kind="warn" message={t(locale, "botSettings.readOnly")} />
          <StatusBadge tone={app.scope === "shared" ? "neutral" : "success"}>
            {t(locale, app.scope === "shared" ? "botSettings.scopeShared" : "botSettings.scopeOwned")}
          </StatusBadge>
        </div>
      )}
      <div className="flex flex-col">
        {/* The share switch exists for exactly one caller: the official
            workspace's manager. Every other caller sees no section, no title
            and no copy — a non-official workspace has no share concept, and a
            consuming workspace's read-only face never mentions it. */}
        {payload.can_manage && payload.official_workspace === true ? (
          <FlowSection
            title={t(locale, "botSettings.shareTitle")}
            subtitle={t(locale, "botSettings.shareCopy")}
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant={app.scope === "shared" ? "destructive-outline" : "secondary"}
                  onClick={() => setPending({ kind: app.scope === "shared" ? "unshare" : "share" })}
                >
                  {t(
                    locale,
                    app.scope === "shared" ? "botSettings.unshareAction" : "botSettings.shareAction",
                  )}
                </Button>
              </div>
              <NoticeRegion notice={shareNotice} />
            </div>
          </FlowSection>
        ) : null}
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
              onReload={() => onReload({ background: true })}
            />
            {modelsLoading ? (
              <FlowSection title={t(locale, "settings.modelChains")} subtitle={t(locale, "settings.modelChainsCopy")}>
                <LoadingNotice locale={locale} />
              </FlowSection>
            ) : (
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
            )}
            <SeatsSection locale={locale} payload={payload} onSettings={submitSettings} />
          </>
        ) : (
          <>
            <BotProvidersSummary locale={locale} payload={payload} />
            <BotChainsSummary locale={locale} payload={payload} />
            <BotSeatsSummary locale={locale} payload={payload} />
          </>
        )}
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
