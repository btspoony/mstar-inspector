import { useEffect, useState } from "react";
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
  Input,
} from "@design-system";
import { creditAmount } from "./credits";
import { LoadingNotice, NoticeRegion, PageNotice, type NoticeKind, type OpNotice } from "./PageNotice";
import { isBotMultiplier, isRpCeiling } from "../../contracts/rp-limits";
import { patchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import { apiBase } from "../workspace-base";
import {
  appDisplayName,
  configuredKeySlot,
  formatCredits,
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

function shareRefusalMessage(locale: SpaBoot["locale"], status: number, body: string): string {
  if (status === 409) return t(locale, "botSettings.shareOutsideOfficial");
  if (status === 403) return t(locale, "botSettings.shareForbidden");
  return settingsErrorMessage(locale, body);
}

/**
 * Credits text → RP for the pricing writes: blank clears the ceiling, a
 * positive amount converts at the payload's rate (the ADR fallback when the
 * route omitted it — see formatCredits). Anything else is refused before a
 * request leaves the page.
 */
function parseCreditsInput(value: string, rate: number): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const credits = Number(trimmed);
  if (!Number.isFinite(credits) || credits <= 0) return "invalid";
  const rp = Math.round(credits * rate);
  // Over the shared ceiling domain the server would refuse it; refusing here
  // saves the round trip and states the same bound.
  return isRpCeiling(rp) ? rp : "invalid";
}

/**
 * 共享与定价: the share switch plus the price columns (multiplier, monthly
 * ceiling) and the per-workspace override list. Owner face only — the
 * consumer face never renders this section.
 *
 * The multiplier is inert while the bot is unshared, so its control is
 * disabled with the shared-only note; the ceiling and the overrides stay
 * editable as preconfiguration (they take effect once sharing is on).
 */
export function BotPricingSection({
  locale,
  payload,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
  onReload: () => Promise<boolean>;
}) {
  const { app } = payload;
  // Bot-scoped writes address the bot row id — a shared bot carries no App
  // identity (`github_app_id` is null on the bot payload), so every path keys
  // `review_bots.id`, never the numeric App id space.
  const botApiPath = `${apiBase()}/api/review-bots/${encodeURIComponent(app.id)}`;
  const shared = app.scope === "shared";
  // Absent when the operator profile is unreadable ⇒ formatCredits' ADR
  // fallback (1 Credit = 1,000 RP).
  const rawRate = payload.rp_per_credit;
  const rpPerCredit =
    typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate > 0 ? rawRate : undefined;
  const rate = rpPerCredit ?? 1000;
  const monthlyRp = isRpCeiling(app.monthly_rp) ? app.monthly_rp : null;

  const [multiplier, setMultiplier] = useState(String(app.multiplier ?? 1));
  const [cap, setCap] = useState(monthlyRp === null ? "" : creditAmount(monthlyRp, rpPerCredit));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);
  const [shareNotice, setShareNotice] = useState<OpNotice | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // A landed write re-reads the payload; the stored values replace the draft.
  useEffect(() => {
    setMultiplier(String(app.multiplier ?? 1));
    // The same two-decimal quantum the read faces render: 1,234 RP reads
    // 1.23 here exactly as it does in `1.23 Credits` there.
    setCap(monthlyRp === null ? "" : creditAmount(monthlyRp, rpPerCredit));
  }, [app.multiplier, monthlyRp, rpPerCredit]);

  async function submitScope(scope: "owned" | "shared"): Promise<OpNotice> {
    let status: number;
    let body: string;
    try {
      ({ status, body } = await patchJson(`${botApiPath}/scope`, {
        scope,
        ...(scope === "owned" ? { confirm: true } : {}),
      }));
    } catch {
      return { kind: "error", message: t(locale, "common.saveFailed") };
    }
    if (status < 200 || status >= 300) {
      return { kind: "error", message: shareRefusalMessage(locale, status, body) };
    }
    await onReload();
    return {
      kind: "success",
      message: t(locale, scope === "shared" ? "botSettings.shareSaved" : "botSettings.unshareSaved"),
    };
  }

  async function savePricing(): Promise<void> {
    if (busy) return;
    const capValue = parseCreditsInput(cap, rate);
    if (capValue === "invalid") {
      setNotice({ kind: "error", message: t(locale, "bots.overrideInvalid") });
      return;
    }
    // The multiplier is inert (and its control disabled) while unshared, so
    // an unshared save omits it — the route keeps the stored value.
    let nextMultiplier: number | undefined;
    if (shared) {
      nextMultiplier = Number(multiplier);
      if (!isBotMultiplier(nextMultiplier)) {
        setNotice({ kind: "error", message: t(locale, "botDetail.share.multiplierInvalid") });
        return;
      }
    }
    setBusy(true);
    setNotice(null);
    try {
      const { status } = await patchJson(`${botApiPath}/pricing`, {
        ...(nextMultiplier === undefined ? {} : { multiplier: nextMultiplier }),
        monthly_rp: capValue,
      });
      if (status < 200 || status >= 300) {
        setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
        return;
      }
      const reloaded = await onReload();
      setNotice(
        reloaded
          ? { kind: "success", message: t(locale, "settings.changesSaved") }
          : { kind: "warn", message: `${t(locale, "settings.changesSaved")} ${t(locale, "bots.staleAfterSave")}` },
      );
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (pending.kind === "share") {
        setShareNotice(await submitScope("shared"));
      } else if (pending.kind === "unshare") {
        setShareNotice(await submitScope("owned"));
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy = pendingConfirmCopy(locale, appDisplayName(app), pending);

  return (
    <>
      <FlowSection title={t(locale, "botDetail.share.title")}>
        <div className="flex flex-col gap-3">
          {payload.can_manage && payload.official_workspace === true ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{t(locale, "botDetail.share.switch")}</span>
              <Button
                type="button"
                role="switch"
                aria-checked={shared}
                variant={shared ? "destructive-outline" : "secondary"}
                onClick={() => setPending({ kind: shared ? "unshare" : "share" })}
              >
                {t(locale, shared ? "botSettings.unshareAction" : "botSettings.shareAction")}
              </Button>
            </div>
          ) : null}
          <NoticeRegion notice={shareNotice} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t(locale, "botDetail.share.multiplier")}</span>
            <Input
              aria-label={t(locale, "botDetail.share.multiplier")}
              inputMode="decimal"
              className="w-32"
              disabled={!shared}
              // Unshared the input is disabled and reads the EFFECTIVE value
              // (×1, as every effective presentation does); the stored draft
              // stays in state untouched, so re-sharing restores it as-is.
              value={shared ? multiplier : "1"}
              onChange={(event) => setMultiplier(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t(locale, "botDetail.share.monthlyCap")}</span>
            <Input
              aria-label={t(locale, "botDetail.share.monthlyCap")}
              inputMode="decimal"
              className="w-32"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">{t(locale, "botDetail.share.monthlyCapHint")}</span>
          </label>
          {shared ? null : (
            <p className="text-sm text-muted-foreground">{t(locale, "botDetail.share.inactiveHint")}</p>
          )}
          <div className="flex items-center gap-3">
            <Button type="button" disabled={busy} onClick={() => void savePricing()}>
              {t(locale, "common.save")}
            </Button>
            <NoticeRegion notice={notice} />
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t(locale, "botDetail.overrides.title")}</h3>
            <BotQuotaOverridesEditor
              locale={locale}
              botId={app.id}
              initial={payload.quota_overrides ?? []}
              rpPerCredit={rpPerCredit}
            />
          </div>
        </div>
      </FlowSection>
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
    </>
  );
}

/**
 * The bot-owned configuration sections for the owner config tab: sandbox
 * runtime, provider keys, model chains and seats. The consumer face never
 * renders this view — its sections are ABSENT there, not read-only — so this
 * view holds no non-manager branch. `payload.can_manage` still gates the
 * store's writes; hiding is never the guard.
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
  const botApiPath = `${apiBase()}/api/review-bots/${encodeURIComponent(app.id)}`;
  const base = `${apiBase()}/review-bots/${encodeURIComponent(app.id)}/settings`;
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
    // A write that LANDED stays a success even when the follow-up read fails:
    // the failure is a stale-data notice, never a failed save.
    if (outcome.kind !== "success" || reloaded) return { ...outcome, reloaded };
    return {
      kind: "warn",
      message: `${outcome.message} ${t(locale, "bots.staleAfterSave")}`,
      reloaded,
    };
  }

  async function createDraftChain(fields: Record<string, string>): Promise<OpNotice> {
    return await submitSettings(fields);
  }

  async function submitVerify(fields: Record<string, string>): Promise<OpNotice> {
    let status: number;
    let body: string;
    try {
      ({ status, body } = await postForm(
        `${botApiPath}/keys/verify`,
        fields,
      ));
    } catch {
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
      <div className="flex flex-col">
        <SandboxSection locale={locale} payload={payload} onSettings={submitSettings} />
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
 * The owner's per-workspace ceiling editor (F8). `bot_quota_overrides` is the
 * exception layer over the bot's DEFAULT ceiling, and this is the only surface
 * that writes it.
 *
 * Ceilings are entered and listed in Credits; the store keeps RP, so a save
 * converts at the payload's rate (the ADR fallback when the route omitted
 * it). Every write goes through `PATCH /api/review-bots/:botId/quota-overrides`;
 * an empty ceiling clears the row, returning that workspace to the default.
 * The list is re-read from the response, so the table always shows what the
 * store holds — never an optimistic guess.
 */
export function BotQuotaOverridesEditor({
  locale,
  botId,
  initial,
  rpPerCredit,
}: {
  locale: SpaBoot["locale"];
  botId: string;
  initial: ReadonlyArray<{ workspaceId: string; monthlyRp: number }>;
  rpPerCredit?: number;
}) {
  const rate = rpPerCredit ?? 1000;
  const [rows, setRows] = useState(initial);
  const [workspaceId, setWorkspaceId] = useState("");
  const [ceiling, setCeiling] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function write(target: string, monthlyRp: number | null): Promise<void> {
    setBusy(true);
    try {
      const { status, body } = await patchJson(
        `${apiBase()}/api/review-bots/${encodeURIComponent(botId)}/quota-overrides`,
        { workspaceId: target, monthlyRp },
      );
      if (status < 200 || status >= 300) {
        setNotice(t(locale, "bots.overridesFailed"));
        return;
      }
      const parsed = JSON.parse(body) as { overrides?: Array<{ workspaceId: string; monthlyRp: number }> };
      setRows(parsed.overrides ?? []);
      setNotice(null);
      setWorkspaceId("");
      setCeiling("");
    } catch {
      setNotice(t(locale, "bots.overridesFailed"));
    } finally {
      setBusy(false);
    }
  }

  function submit(): void {
    const target = workspaceId.trim();
    if (target.length === 0) return;
    const parsed = parseCreditsInput(ceiling, rate);
    if (parsed === "invalid") {
      setNotice(t(locale, "bots.overrideInvalid"));
      return;
    }
    void write(target, parsed);
  }

  return (
    <div className="flex flex-col gap-3" data-slot="bot-quota-overrides">
      <p className="text-sm text-muted-foreground">{t(locale, "bots.overridesHint")}</p>
      {notice === null ? null : <p className="text-sm text-(--tone-warn-fg)">{notice}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(locale, "bots.overridesEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.workspaceId} className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-xs">{row.workspaceId}</span>
              <span className="tabular-nums">{formatCredits(row.monthlyRp, rpPerCredit)}</span>
              <button
                type="button"
                className="text-xs underline"
                disabled={busy}
                aria-label={t(locale, "bots.overrideClear", { workspace: row.workspaceId })}
                onClick={() => void write(row.workspaceId, null)}
              >
                {t(locale, "bots.overrideClearLabel")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <input
          className="w-56 rounded-md border border-(--border-default) px-2 py-1 text-sm"
          aria-label={t(locale, "bots.overrideWorkspace")}
          placeholder={t(locale, "bots.overrideWorkspace")}
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
        />
        <input
          className="w-32 rounded-md border border-(--border-default) px-2 py-1 text-sm tabular-nums"
          aria-label={`${t(locale, "botDetail.share.monthlyCap")} (${t(locale, "credits.unit")})`}
          placeholder={`${t(locale, "botDetail.share.monthlyCap")} (${t(locale, "credits.unit")})`}
          value={ceiling}
          onChange={(event) => setCeiling(event.target.value)}
        />
        <button type="button" className="rounded-md border border-(--border-default) px-3 py-1 text-sm" disabled={busy} onClick={submit}>
          {t(locale, "bots.overrideSave")}
        </button>
      </div>
    </div>
  );
}
