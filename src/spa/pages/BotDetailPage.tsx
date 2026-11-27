/**
 * The bot detail page (`/dashboard/<ref>/bots/:botId`, D7/D23/D24): ONE route,
 * two faces. The owner — the bot's own workspace with manage rights — gets
 * 概览/配置 tabs: the overview is read-only, the config tab writes profile,
 * pricing, providers, chains, seats, runtime and the archive action. Every
 * other reader (a consumer workspace, or a member without manage) gets the
 * read-only face — usage, capability summary and mounts — with the owner's
 * provider/seat/chain/pricing machinery ABSENT, never disabled. An archived
 * bot shows its banner to both faces; only the owner restores it, and the
 * config tab locks behind that banner.
 *
 * Credits render via `formatCredits` at the payload's rate; the route omits
 * `rp_per_credit` when the operator profile is unreadable, and formatCredits'
 * ADR fallback (1 Credit = 1,000 RP) covers that case.
 */
import { useEffect, useRef, useState } from "react";
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
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@design-system";
import { t } from "../../i18n";
import { fetchJson, patchJson } from "../api";
import type { SpaBoot } from "../boot";
import { MetricBand, type Metric } from "../components/MetricBand";
import { PageHeader } from "../components/PageHeader";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { apiBase } from "../workspace-base";
import {
  formatCredits,
  parseBotSettings,
  parseModels,
  splitModelChain,
  type BotOverview,
  type BotSettingsPayload,
  type ModelOptionGroup,
} from "./data";
import { creditAmount, effectiveMultiplier, usageCeilingCell } from "./credits";
import { BotPricingSection, BotSettingsView } from "./BotSettingsPage";
import { NoticeRegion, PageNotice, type OpNotice } from "./PageNotice";

function botApiPath(botId: string): string {
  return `${apiBase()}/api/review-bots/${encodeURIComponent(botId)}`;
}

export function BotDetailPage({ boot, botId }: { boot: SpaBoot; botId: string }) {
  const { locale } = boot;
  const [payload, setPayload] = useState<BotSettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  // F14: a models failure is its OWN state. The page still renders; the owner
  // config tab shows the error and a retry, and retry re-reads both sources.
  const [modelsError, setModelsError] = useState(false);
  // A confirmed archive/restore whose follow-up read failed: the write stands,
  // so the face locks to the state it established instead of offering the
  // stale configuration the payload still describes.
  const [staleArchiveState, setStaleArchiveState] = useState<boolean | null>(null);

  const sequenceRef = useRef(0);
  const base = apiBase();

  const load = async (): Promise<boolean> => {
    const sequence = ++sequenceRef.current;
    setModelsError(false);
    // The two reads fail INDEPENDENTLY: a models failure must not take the bot
    // payload down with it, and must not be flattened into "no models".
    const [botRead, modelsRead] = await Promise.allSettled([
      fetchJson(`${base}/api/review-bots/${encodeURIComponent(botId)}/bot`),
      fetchJson(`${base}/api/models`),
    ]);
    if (sequence !== sequenceRef.current) return false;

    if (botRead.status === "rejected") {
      setState("error");
      return false;
    }
    const parsed = parseBotSettings(botRead.value);
    if (!parsed) {
      setState("error");
      return false;
    }
    setPayload(parsed);
    setStaleArchiveState(null);
    if (modelsRead.status === "rejected") {
      setModelsError(true);
      setGroups([]);
    } else {
      const models = parseModels(modelsRead.value);
      // A body that does not parse is a failure too — never an empty catalog.
      setModelsError(models === null);
      setGroups(models?.groups ?? []);
    }
    setState("ok");
    return true;
  };

  /**
   * The options retry: `/api/models` ONLY. It must never re-enter the page
   * load — that would discard unsaved identity/pricing drafts, re-render the
   * chain rows and reset the editor, and delay a consumer overview behind a
   * read it does not need. A failed retry keeps the error face; a successful
   * one swaps the groups in place.
   */
  const retryModels = async (): Promise<void> => {
    try {
      const models = parseModels(await fetchJson(`${base}/api/models`));
      // A body that does not parse is a failure too — never an empty catalog.
      if (models === null) {
        setModelsError(true);
        setGroups([]);
        return;
      }
      setModelsError(false);
      setGroups(models.groups);
    } catch {
      setModelsError(true);
      setGroups([]);
    }
  };

  /**
   * The editor's own re-read. It fetches ONLY the bot payload (the section the
   * editor mutates) and NEVER bumps `sequenceRef`, never flips `state` to
   * "loading", and never re-reads the models — so a write that succeeded cannot
   * be reported as a failed reload because it raced a second full load.
   * A failed re-read is `false`; the caller turns that into a stale-data notice.
   */
  const reloadSection = async (): Promise<boolean> => {
    try {
      const parsed = parseBotSettings(
        await fetchJson(`${base}/api/review-bots/${encodeURIComponent(botId)}/bot`),
      );
      if (parsed === null) return false;
      setPayload(parsed);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * A confirmed archive/restore followed by its re-read. The write stands even
   * when the read fails, so the face locks to the state the write established
   * and the page says the stored state could not be re-read — never leaves the
   * old actionable configuration on screen.
   */
  const archiveSettled = async (next: boolean): Promise<void> => {
    setStaleArchiveState(next);
    if (await reloadSection()) setStaleArchiveState(null);
  };

  // F15: keyed on BOTH the workspace base and the bot id — switching workspace
  // while keeping the bot id must reload, not retain the prior workspace's
  // provider, spend or permissions.
  useEffect(() => {
    setState("loading");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, botId]);

  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="forms" />;
  }
  if (state === "error" || payload === null) {
    return <ErrorState locale={locale} onRetry={() => void load()} />;
  }
  const { app, overview } = payload;
  // F5: ownership is the bot's workspace, NOT its publication scope — an
  // owner who publishes a bot still reads own-bot unlimited usage.
  const owned = payload.owned === true;
  // The owner face requires BOTH facts: whose bot it is, and this caller's
  // manage rights on that workspace. A plain member of the owning workspace
  // reads the consumer face.
  const isOwner = owned && payload.can_manage;
  // A confirmed write wins over the stale payload it could not re-read.
  const archived = staleArchiveState ?? payload.archived === true;
  // The lock tracks the re-read, not the direction of the write: a failed
  // re-read after EITHER archive or restore leaves archived-era values on
  // screen, so the config stays locked until a reload succeeds.
  const configLocked = archived || staleArchiveState !== null;
  const shared = app.scope === "shared";
  // Served by the route only when the operator profile is readable; absent ⇒
  // formatCredits' ADR fallback.
  const rawRate = payload.rp_per_credit;
  const rpPerCredit =
    typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate > 0 ? rawRate : undefined;
  // F4: the capability summary reads the NON-OWNER overview read, so a shared
  // bot's configured default chain is visible to its consumers; `model_chain`
  // stays owner-only configuration.
  const defaultChain = splitModelChain(overview?.default_chain ?? payload.model_chain);
  // Defence in depth: the route already narrows `model_chains` to [] for a
  // non-manager, but chain mechanics are owner-only on EVERY face, so a
  // regressed payload must still print nothing here.
  const namedChains = isOwner
    ? payload.model_chains
        .filter((entry) => entry.name !== "default")
        .map((entry) => ({ name: entry.name, chain: splitModelChain(entry.chain) }))
    : [];

  // One ceiling semantics everywhere (F3/13): a consumer's metric states the
  // enforced ceiling as `已用 / 上限`; the owner is never metered against one.
  const monthValue = usageCeilingCell(
    locale,
    overview ? { used_rp: overview.month_used_rp } : null,
    {
      owned: isOwner,
      quotaError: payload.quota_error === true,
      ceilingRp: overview?.effective_ceiling ?? null,
      rpPerCredit,
    },
  );
  // The multiplier is a consumer price: an unshared bot — and the owner of any
  // bot — is effectively ×1 everywhere it is presented as effective. The
  // stored value stays in the owner's pricing editor.
  const multiplierEffective = effectiveMultiplier(owned, app.scope, app.multiplier ?? 1);
  const metrics: Metric[] = [
    { key: t(locale, "bots.fieldMultiplier"), value: `×${multiplierEffective}` },
    { key: t(locale, "credits.usedThisMonth"), value: monthValue },
    { key: t(locale, "bots.fieldMounted"), value: String(overview?.mounted_apps.length ?? 0) },
  ];

  const header = (
    <PageHeader
      title={app.name ?? appDisplayNameOf(app)}
      description={
        <span className="flex flex-col gap-1.5">
          {app.description ? <span>{app.description}</span> : null}
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{app.id}</span>
            {archived ? (
              <StatusBadge tone="neutral">{t(locale, "bots.list.archived")}</StatusBadge>
            ) : (
              <StatusBadge tone={shared ? "accent" : "neutral"}>
                {t(locale, shared ? "bots.stateShared" : "bots.stateOwn")}
              </StatusBadge>
            )}
          </span>
        </span>
      }
      metrics={<MetricBand metrics={metrics} />}
    />
  );

  const readOnlySections = (
    <>
      <BotUsageSection locale={locale} payload={payload} owner={isOwner} rpPerCredit={rpPerCredit} />
      <BotCapabilitySection locale={locale} payload={payload} defaultChain={defaultChain} namedChains={namedChains} />
      <BotMountsSection locale={locale} overview={overview} />
    </>
  );

  // The consumer face: the SAME header and metric band, then a read-only
  // notice and the three read-only sections. No tab bar, and none of the
  // owner's machinery — absence, not disabled controls.
  if (!isOwner) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {archived ? <PageNotice kind="warn" message={t(locale, "botDetail.archive.consumerBanner")} /> : null}
        <p className="text-sm text-muted-foreground">{t(locale, "botDetail.consumer.readOnlyNotice")}</p>
        {readOnlySections}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      {archived ? (
        <ArchivedOwnerBanner
          locale={locale}
          botId={app.id}
          onSettled={archiveSettled}
          stale={staleArchiveState !== null}
        />
      ) : null}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t(locale, "botDetail.tab.overview")}</TabsTrigger>
          <TabsTrigger value="config">{t(locale, "botDetail.tab.config")}</TabsTrigger>
        </TabsList>
        {/* forceMount keeps both panels in the DOM (hidden when inactive) so a
            background reload never unmounts an editor mid-write. */}
        <TabsContent value="overview" forceMount className="flex flex-col gap-6 pt-4">
          {readOnlySections}
          <FlowSection title={t(locale, "bots.fieldSharing")}>
            <p>
              <StatusBadge tone={shared ? "accent" : "neutral"}>
                {t(locale, shared ? "bots.stateShared" : "bots.stateOwn")}
              </StatusBadge>
            </p>
          </FlowSection>
        </TabsContent>
        <TabsContent value="config" forceMount className="flex flex-col gap-6 pt-4">
          {configLocked ? <PageNotice kind="warn" message={t(locale, "botDetail.archive.lockedNotice")} /> : null}
          {/* The lock disables the WHOLE config face: a disabled fieldset turns
              every control read-only while the sections stay visible. */}
          <fieldset disabled={configLocked} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
            <BotProfileEditor locale={locale} payload={payload} onReload={reloadSection} />
            <BotPricingSection locale={locale} payload={payload} onReload={reloadSection} />
            {/* F14: a models failure surfaces WITH its retry; the stored chain
                rows below keep rendering from the bot payload. */}
            {modelsError ? (
              <ErrorState
                locale={locale}
                message={t(locale, "bots.modelsFailed")}
                onRetry={() => void retryModels()}
              />
            ) : null}
            <BotSettingsView
              locale={locale}
              payload={payload}
              groups={groups}
              modelsLoading={false}
              notice={null}
              onReload={reloadSection}
            />
          </fieldset>
          {archived ? null : (
            <BotArchiveSection
              locale={locale}
              botId={app.id}
              onSettled={archiveSettled}
              stale={staleArchiveState !== null}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** 使用情况: this workspace's month through this bot, against its ceiling. */
function BotUsageSection({
  locale,
  payload,
  owner,
  rpPerCredit,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
  owner: boolean;
  rpPerCredit?: number;
}) {
  const overview = payload.overview;
  const used = overview?.month_used_rp ?? 0;
  const cap = overview?.effective_ceiling ?? null;
  const quotaError = payload.quota_error === true;
  const none = t(locale, "bots.monthNone");
  // The owner's own bot has no enforced ceiling on this face; a consumer reads
  // the ceiling the relay enforces on THIS workspace (its override else the
  // bot default). An unresolvable ceiling is an error state (F10), never "no
  // ceiling".
  const capValue = owner
    ? none
    : quotaError
      ? t(locale, "bots.monthUnknown")
      : cap === null
        ? none
        : formatCredits(cap, rpPerCredit);
  const remainingValue =
    !owner && !quotaError && cap !== null ? formatCredits(Math.max(0, cap - used), rpPerCredit) : none;
  return (
    <FlowSection title={t(locale, "botDetail.usage.title")} subtitle={t(locale, "botDetail.usage.utcHint")}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t(locale, "botDetail.usage.used")}</dt>
        <dd className="tabular-nums">{overview ? formatCredits(used, rpPerCredit) : none}</dd>
        <dt className="text-muted-foreground">{t(locale, "botDetail.usage.cap")}</dt>
        <dd className="tabular-nums">{overview ? capValue : none}</dd>
        <dt className="text-muted-foreground">{t(locale, "botDetail.usage.remaining")}</dt>
        <dd className="tabular-nums">{overview ? remainingValue : none}</dd>
        <dt className="text-muted-foreground">{t(locale, "botDetail.usage.source")}</dt>
        <dd>{overview?.provider_workspace ?? none}</dd>
      </dl>
    </FlowSection>
  );
}

/** 能力摘要: what this bot can do, as text — chain, runtime, multiplier. */
function BotCapabilitySection({
  locale,
  payload,
  defaultChain,
  namedChains,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
  defaultChain: string[];
  namedChains: Array<{ name: string; chain: string[] }>;
}) {
  const capabilityDefault =
    defaultChain.length === 0
      ? t(locale, "bots.capabilityChainUnset")
      : t(locale, "bots.capabilityDefaultChain", { models: defaultChain.join(", ") });
  return (
    <FlowSection title={t(locale, "bots.fieldCapability")}>
      <ul className="flex flex-col gap-1 text-sm">
        <li>{capabilityDefault}</li>
        <li>{t(locale, "bots.capabilitySandbox", { id: payload.app.sandbox_image_id || "—" })}</li>
        <li>
          {t(locale, "bots.fieldMultiplier")}: ×
          {effectiveMultiplier(payload.owned === true, payload.app.scope, payload.app.multiplier ?? 1)}
        </li>
        {namedChains.map((row) => (
          <li key={row.name} className="text-muted-foreground">
            {row.name}: {row.chain.join(", ")}
          </li>
        ))}
      </ul>
    </FlowSection>
  );
}

/** 挂载于: the Apps whose bot chains mount this bot. */
function BotMountsSection({ locale, overview }: { locale: SpaBoot["locale"]; overview: BotOverview | undefined }) {
  return (
    <FlowSection title={t(locale, "bots.fieldMounted")}>
      {overview && overview.mounted_apps.length > 0 ? (
        <ul className="flex flex-wrap gap-2 text-sm">
          {overview.mounted_apps.map((mounted) => (
            <li key={mounted.id}>
              <a href={`${apiBase()}/apps/${mounted.github_app_id}`}>{mounted.name}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t(locale, "bots.mountedNone")}</p>
      )}
    </FlowSection>
  );
}

/** 基本信息: the bot's name (required) and description, written via PATCH profile. */
function BotProfileEditor({
  locale,
  payload,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: BotSettingsPayload;
  onReload: () => Promise<boolean>;
}) {
  const { app } = payload;
  const [name, setName] = useState(app.name ?? "");
  const [description, setDescription] = useState(app.description ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  // A landed write re-reads the payload; the stored values replace the draft.
  useEffect(() => {
    setName(app.name ?? "");
    setDescription(app.description ?? "");
  }, [app.name, app.description]);

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { status } = await patchJson(`${botApiPath(app.id)}/profile`, {
        name: trimmed,
        // An empty description CLEARS the column; the route keeps an omitted
        // field, so the editor always sends both.
        description: description.trim() === "" ? null : description,
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

  return (
    <FlowSection title={t(locale, "botDetail.identity.title")}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t(locale, "botDetail.identity.name")}</span>
          <Input
            aria-label={t(locale, "botDetail.identity.name")}
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t(locale, "botDetail.identity.description")}</span>
          <textarea
            aria-label={t(locale, "botDetail.identity.description")}
            className="min-h-20 w-full rounded-sm border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="flex items-center gap-3">
          <Button type="button" disabled={busy || name.trim().length === 0} onClick={() => void save()}>
            {t(locale, "common.save")}
          </Button>
          <NoticeRegion notice={notice} />
        </div>
      </div>
    </FlowSection>
  );
}

/** 危险区: archive this bot behind a confirmation that states the consequences. */
function BotArchiveSection({
  locale,
  botId,
  onSettled,
  stale,
}: {
  locale: SpaBoot["locale"];
  botId: string;
  onSettled: (next: boolean) => Promise<void>;
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function archive(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { status } = await patchJson(`${botApiPath(botId)}/archive`, { archived: true });
      if (status < 200 || status >= 300) {
        setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
        return;
      }
      setOpen(false);
      await onSettled(true);
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FlowSection title={t(locale, "botDetail.archive.dangerTitle")} subtitle={t(locale, "botDetail.archive.dangerHint")}>
        <div className="flex items-center gap-3">
          <Button type="button" variant="destructive-outline" onClick={() => setOpen(true)}>
            {t(locale, "botDetail.archive.open")}
          </Button>
          <NoticeRegion notice={notice} />
        </div>
        {stale ? <PageNotice kind="warn" message={t(locale, "botDetail.archive.staleAfterArchive")} /> : null}
      </FlowSection>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(locale, "botDetail.archive.dialogTitle")}</DialogTitle>
            <DialogDescription>{t(locale, "botDetail.archive.dangerHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                {t(locale, "common.cancel")}
              </Button>
            </DialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void archive()}>
              {t(locale, "botDetail.archive.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The owner's archived banner: the state fact plus the one write still allowed. */
function ArchivedOwnerBanner({
  locale,
  botId,
  onSettled,
  stale,
}: {
  locale: SpaBoot["locale"];
  botId: string;
  onSettled: (next: boolean) => Promise<void>;
  stale: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function restore(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { status } = await patchJson(`${botApiPath(botId)}/archive`, { archived: false });
      if (status < 200 || status >= 300) {
        setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
        return;
      }
      await onSettled(false);
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <PageNotice kind="warn" message={t(locale, "botDetail.archive.ownerBanner")} />
          <NoticeRegion notice={notice} />
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void restore()}>
          {t(locale, "botDetail.archive.restore")}
        </Button>
      </div>
      {stale ? <PageNotice kind="warn" message={t(locale, "botDetail.archive.staleAfterArchive")} /> : null}
    </div>
  );
}

/** The bot name is a bot column; the App display rule is the fallback only. */
function appDisplayNameOf(app: BotSettingsPayload["app"]): string {
  return app.github_name ?? app.github_slug ?? String(app.github_app_id ?? "");
}
