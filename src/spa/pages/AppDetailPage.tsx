import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { t, type DictionaryKey } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import { MetricBand, type Metric } from "@/components/MetricBand";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  FlowSection,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@design-system";
import {
  AppInfoSection,
  AppInstallationsSection,
  AppInstallSection,
  OpsSection,
  SettingsView,
  pendingConfirmCopy,
  postPinnedOutcome,
} from "./SettingsPage";
import { AppDeliveryTab } from "./AppDeliveryTab";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { fetchJson, patchJson } from "../api";
import type { SpaBoot } from "../boot";
import { spaClick } from "../spa-click";
import { apiBase, currentOrigin } from "../workspace-base";
import { NoticeRegion, PageNotice, type NoticeKind, type OpNotice } from "./PageNotice";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import {
  appDetailSearchQuery,
  appDisplayName,
  appStatusPill,
  hasTargetFacts,
  parseAppDetailSearch,
  parseModels,
  parseSettings,
  type AppDetailSearch,
  type AppChainEntry,
  type BlockedReason,
  type ModelOptionGroup,
  type SettingsPayload,
  type TargetSettingsPayload,
} from "./data";
import type { PendingAction } from "./SettingsPage";

/**
 * Page wayfinding link back to the Apps list. The href is the page's own API
 * base, derived here so the rendered link is the real target on both the
 * legacy and the workspace-scoped path.
 */
export function BackToApps({ locale }: { locale: SpaBoot["locale"] }) {
  const href = `${apiBase()}/apps`;
  return (
    <a
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
      href={href}
      onClick={(event) => spaClick(href, event)}
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
      {t(locale, "appDetail.backToApps")}
    </a>
  );
}

/**
 * The shell's own fragment: the page wayfinding link plus the face below it.
 * A separate component (rather than inline JSX in the stateful page) so the
 * rendered shell — link target included — is assertable without a DOM runner.
 */
export function AppDetailShell({
  locale,
  children,
}: {
  locale: SpaBoot["locale"];
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <BackToApps locale={locale} />
      {children}
    </div>
  );
}

/**
 * One App detail read: the settings payload under the page's own base. `base`
 * is a parameter, not `apiBase()` inside, so the caller decides which
 * workspace is being read — and a test can drive the same read under two
 * pathnames.
 */
export async function loadAppDetail(base: string, appId: string): Promise<SettingsPayload | null> {
  return parseSettings(await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}`));
}

async function loadModelGroups(base: string, appId: string): Promise<ModelOptionGroup[]> {
  try {
    return (
      parseModels(await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}/models`))?.groups ?? []
    );
  } catch {
    return [];
  }
}

/**
 * The App detail page: `/dashboard/apps/:appId` and its workspace twin, with
 * exactly two faces — 应用设置 (the App's own configuration, the default) and
 * 已安装. The data faces (洞察, Pull requests) and the target-owned review
 * policy belong to the repository surface's detail page, so this page neither
 * renders them nor reads their payload sections.
 *
 * A non-manager keeps the D4 identity card it has always been served.
 *
 * Page wayfinding (the back link to the Apps list) is the shell's —
 * rendered as the first element on the error and ok faces.
 *
 * Data plane: the shell owns the settings read (both faces — the
 * identity-only `can_manage: false` shape parses through the D4 identity set;
 * the manager face keeps the full contract) plus the chain editors' model
 * options, and the background-reload machinery (background reloads keep the
 * card tree mounted, failures ride the page notice). The active tab is
 * URL-derived per the spa-url-state-resync contract: one []-mounted popstate
 * listener re-derives through the shared pure helper
 * (`parseAppDetailSearch`), and every in-page edit commits with
 * `replaceState` (`appDetailSearchQuery`) — never popstate, so no loop.
 */
export function AppDetailPage({ boot, appId }: { boot: SpaBoot; appId: string }) {
  const locale = boot.locale;
  const base = apiBase();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const loadSequence = useRef(0);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);
  const [search, setSearch] = useState<AppDetailSearch>(() =>
    parseAppDetailSearch(window.location.search),
  );

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<boolean> => {
      const sequence = ++loadSequence.current;
      if (!background) setState("loading");
      try {
        const loaded = await loadAppDetail(base, appId);
        if (cancelledRef.current || sequence !== loadSequence.current) return false;
        if (!loaded) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return false;
        }
        setPayload(loaded);
        setState("ok");
        if (loaded.can_manage && !loaded.blocked) {
          if (!background) {
            setGroups([]);
            setModelsLoading(true);
          }
          void loadModelGroups(base, appId).then((modelGroups) => {
            if (cancelledRef.current || sequence !== loadSequence.current) return;
            setGroups(modelGroups);
            setModelsLoading(false);
          });
        } else {
          setGroups([]);
          setModelsLoading(false);
        }
        setNotice(null);
        return true;
      } catch {
        if (!cancelledRef.current && sequence === loadSequence.current) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
        }
        return false;
      }
    },
    [base, appId, locale],
  );

  // F10/D45: an App whose cached GitHub metadata was never synced gets ONE
  // first-load refresh — a POST to `/api/apps/:appId/refresh-metadata`, the
  // only sanctioned refresh. The GET stays a pure read.
  const refreshedRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    setSearch(parseAppDetailSearch(window.location.search));
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  useEffect(() => {
    if (refreshedRef.current) return;
    if (payload === null || payload.can_manage !== true || payload.blocked) return;
    const meta = payload.app as { github_metadata_synced_at?: string | null };
    if (meta.github_metadata_synced_at !== null && meta.github_metadata_synced_at !== undefined) return;
    if (payload.app.github_app_id === null) return;
    refreshedRef.current = true;
    void refreshAppMetadata(apiBase(), payload.app.github_app_id);
  }, [payload]);

  useEffect(() => {
    const onPop = () => setSearch(parseAppDetailSearch(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function commitSearch(next: AppDetailSearch): void {
    window.history.replaceState(null, "", `${window.location.pathname}${appDetailSearchQuery(next)}`);
    setSearch(next);
  }

  if (state === "loading") {
    return (
      <AppDetailShell locale={locale}>
        <PageSkeleton locale={locale} kind="forms" />
      </AppDetailShell>
    );
  }

  return (
    <AppDetailShell locale={locale}>
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        <AppDetailView
          locale={locale}
          appId={appId}
          payload={payload}
          groups={groups}
          modelsLoading={modelsLoading}
          notice={notice}
          search={search}
          onReload={load}
          onSearch={commitSearch}
        />
      ) : null}
    </AppDetailShell>
  );
}

/**
 * F7: the way from App detail to the bot configuration. There is NO App→bot
 * relation to infer (the split keeps them independent), so this links the bots
 * the App's chain actually mounts in this workspace — and, when the chain is
 * still empty, the workspace's usable-bot list. It never derives a bot id from
 * the App id.
 */
export function BotSettingsLink({
  locale,
  mountedBotIds,
}: {
  locale: SpaBoot["locale"];
  mountedBotIds: readonly string[];
}) {
  const bots = [...mountedBotIds];
  if (bots.length === 0) {
    const listHref = `${apiBase()}/apps?tab=bots`;
    return (
      <a
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
        href={listHref}
        onClick={(event) => spaClick(listHref, event)}
      >
        {t(locale, "appDetail.botSettingsLink")}
      </a>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-3">
      {bots.map((botId) => {
        const href = `${apiBase()}/bots/${encodeURIComponent(botId)}`;
        return (
          <a
            key={botId}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
            href={href}
            onClick={(event) => spaClick(href, event)}
          >
            {t(locale, "appDetail.botSettingsLink")}
          </a>
        );
      })}
    </span>
  );
}

/**
 * F10/D45: the single first-load metadata refresh. It is a POST so the GET
 * stays pure; a failure is silent here — the App metadata controls carry the
 * retry affordance.
 */
export async function refreshAppMetadata(base: string, githubAppId: number): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/apps/${githubAppId}/refresh-metadata`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** F11: the chain is the only App→bot relation; its row count is an App fact. */
function mountedBotCount(chain: readonly AppChainEntry[]): number {
  return chain.length;
}

/**
 * F7 (D29/D35): the App's ordered chain, read-only. Position, bot name, the
 * shared/mine tag, the multiplier and this month's spend through that bot —
 * no add, remove or reorder control: the editable order ships with the relay
 * that reads it. An empty chain names the next step instead of rendering a
 * blank table.
 */
export function AppChainSection({
  locale,
  chain,
}: {
  locale: SpaBoot["locale"];
  chain: readonly AppChainEntry[];
}) {
  if (chain.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">{t(locale, "apps.chain.empty")}</p>;
  }
  const columns: DataTableColumn<AppChainEntry>[] = [
    {
      header: t(locale, "apps.chain.columnPosition"),
      cell: (row) => <span className="tabular-nums text-muted-foreground">{row.position}</span>,
    },
    {
      header: t(locale, "apps.chain.columnBot"),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-foreground">{row.name}</span>
          <span className="text-muted-foreground">
            {t(locale, row.owned ? "apps.chain.tagMine" : "apps.chain.tagShared")}
          </span>
          {/* A bot its owner stopped sharing stays mounted as a skipped row. */}
          {row.available ? null : (
            <span className="text-(--tone-warn-fg)">{t(locale, "apps.chain.rowUnavailable")}</span>
          )}
        </span>
      ),
      meta: (row) => (row.description === null || row.description === "" ? null : <span>{row.description}</span>),
    },
    {
      header: t(locale, "apps.chain.columnProvider"),
      cell: (row) => <span className="text-muted-foreground">{row.provider_workspace}</span>,
    },
    {
      header: t(locale, "apps.chain.columnMultiplier"),
      cell: (row) => <span className="tabular-nums">×{row.multiplier}</span>,
    },
    {
      header: t(locale, "apps.chain.columnMonth"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums text-muted-foreground" title={t(locale, "bots.monthHint")}>
          {t(locale, "bots.monthNoCeiling", { used: row.month_used_rp })}
        </span>
      ),
    },
  ];
  return (
    <div data-slot="app-chain">
      <FlowSection title={t(locale, "apps.chain.title")} subtitle={t(locale, "apps.chain.copy")}>
        <DataTable columns={columns} rows={chain} rowKey={(row) => `${row.position}:${row.bot_id}`} />
      </FlowSection>
    </div>
  );
}

const BLOCKED_REASON_KEYS = {
  bot_not_shared: "appDetail.blockedBotNotShared",
} as const satisfies Record<BlockedReason, string>;

/**
 * The identity header both detail pages render: the GitHub display name (D6
 * fallback chain), the creator, the bot-configuration link, the status pill
 * and the four figures the manager payload proves. The route `appId` stays the
 * address, never the visible identity.
 */
export function TargetHeader({
  locale,
  appId,
  payload,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  payload: SettingsPayload;
}) {
  const pill = appStatusPill(locale, payload.app);
  const blockedMessage =
    payload.blocked && payload.blocked_reason
      ? t(locale, BLOCKED_REASON_KEYS[payload.blocked_reason])
      : null;

  // F11: App-scoped facts ONLY. `keys.length` and `model_chains.length` were
  // BOT configuration reached through an equal id — a different entity after
  // the split — so the band carries installations, Apps mounted through the
  // chain, the delivery refusal count and the App's scope, nothing else.
  const chain = payload.chain ?? [];
  const metrics: Metric[] = payload.can_manage && !payload.blocked
    ? [
        { key: t(locale, "settings.installations"), value: payload.installations.length },
        { key: t(locale, "appDetail.metricMountedBots"), value: mountedBotCount(chain) },
        {
          key: t(locale, "apps.metricRejected24h"),
          value: payload.delivery_summary?.rejected24h ?? 0,
          tone: (payload.delivery_summary?.rejected24h ?? 0) > 0 ? "danger" : undefined,
        },
      ]
    : [];

  return (
    <>
      <PageHeader
        title={appDisplayName(payload.app)}
        description={t(locale, "apps.by", { login: payload.app.created_by ?? "—" })}
        actions={
          <>
            {blockedMessage ? null : (
              <BotSettingsLink locale={locale} mountedBotIds={(payload.chain ?? []).map((row) => row.bot_id)} />
            )}
            <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>
          </>
        }
        metrics={<MetricBand metrics={metrics} />}
      />
      {blockedMessage ? <PageNotice kind="warn" message={blockedMessage} /> : null}
    </>
  );
}

function RepositoriesNotice({
  locale,
  copy,
}: {
  locale: SpaBoot["locale"];
  copy: DictionaryKey;
}) {
  return <p className="py-3 text-sm text-muted-foreground">{t(locale, copy)}</p>;
}

function TargetOpsZone({
  locale,
  payload,
  onReload,
}: {
  locale: SpaBoot["locale"];
  payload: TargetSettingsPayload;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
}) {
  const appPath = `${apiBase()}/apps/${payload.app.github_app_id}`;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function onConfirm(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    try {
      setNotice(
        action.kind === "delete"
          ? await postPinnedOutcome(`${appPath}/delete`, {}, locale, () => onReload({ background: true }), {
              successMessage: t(locale, "settings.deleteSuccess"),
              refetch: false,
            })
          : await postPinnedOutcome(`${appPath}/${action.kind}`, {}, locale, () =>
              onReload({ background: true }),
            ),
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const confirmCopy = pendingConfirmCopy(locale, appDisplayName(payload.app), pending);

  return (
    <>
      <OpsSection
        locale={locale}
        payload={payload}
        onPending={setPending}
        notice={notice}
        botWritable={!payload.blocked && payload.can_configure_bot === true}
        targetOwned={false}
      />
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
 * F11: the credential controls the plan keeps on the App face for managers.
 * They are APP facts — the webhook endpoint the App receives on, its numeric
 * id, and where its stored private key and webhook secret live. The secrets
 * themselves are never in the payload; this block names them and links the
 * place they are rotated.
 */
export function AppCredentialsSection({
  locale,
  workspaceId,
  app,
}: {
  locale: SpaBoot["locale"];
  workspaceId: string;
  app: SettingsPayload["app"];
}) {
  const webhookUrl = `${currentOrigin()}/webhook/${workspaceId}/${app.id}`;
  return (
    <section className="flex flex-col gap-2 py-3" data-slot="app-credentials">
      <h3 className="text-sm font-semibold">{t(locale, "appDetail.credentialsTitle")}</h3>
      <p className="text-sm text-muted-foreground">{t(locale, "appDetail.credentialsCopy")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t(locale, "appDetail.credentialsWebhook")}</dt>
        <dd>
          <code className="select-all rounded bg-muted px-1 py-0.5 font-mono text-foreground">{webhookUrl}</code>
        </dd>
        {app.github_app_id === null ? null : (
          <>
            <dt className="text-muted-foreground">{t(locale, "appDetail.credentialsAppId")}</dt>
            <dd className="tabular-nums">{app.github_app_id}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t(locale, "appDetail.credentialsStored")}</dt>
        <dd>{t(locale, "appDetail.credentialsStoredValue")}</dd>
      </dl>
    </section>
  );
}

/**
 * The App detail face — pure `t()` + data rendering, no window/router access,
 * so tests can static-render it. A non-manager gets the D4 identity card; a
 * manager gets 应用设置 (identity header, ops, the bot's sections) and 已安装.
 */
export function AppDetailView({
  locale,
  appId,
  payload,
  groups,
  modelsLoading = false,
  notice,
  search,
  onReload,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  payload: SettingsPayload;
  groups: ModelOptionGroup[];
  modelsLoading?: boolean;
  notice: { kind: NoticeKind; message: string } | null;
  search: AppDetailSearch;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
  onSearch: (next: AppDetailSearch) => void;
}) {
  if (!payload.can_manage) {
    return (
      <div className="flex flex-col gap-6">
        <TargetHeader locale={locale} appId={appId} payload={payload} />
        {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
        <SettingsView locale={locale} payload={payload} />
      </div>
    );
  }

  const target = hasTargetFacts(payload) ? payload : null;
  const bot = payload.blocked ? null : payload;

  function onTabChange(next: string): void {
    if (next !== "settings" && next !== "bots" && next !== "delivery" && next !== "installations") return;
    onSearch({ ...search, tab: next });
  }

  return (
    <div className="flex flex-col gap-6">
      <TargetHeader locale={locale} appId={appId} payload={payload} />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      <Tabs value={search.tab} onValueChange={onTabChange}>
        <TabsList
          variant="line"
          className="group-data-[orientation=horizontal]/tabs:h-10 w-full justify-start gap-4 border-b border-border p-0"
        >
          <TabsTrigger value="settings">{t(locale, "appDetail.tabSettings")}</TabsTrigger>
          {/* D40: this plan registers the `bots` tab — the chain is the plan's
              own subject, and no other plan edits this tab set. */}
          <TabsTrigger value="bots">{t(locale, "appDetail.tabBots")}</TabsTrigger>
          <TabsTrigger value="delivery">{t(locale, "appDetail.tabDelivery")}</TabsTrigger>
          <TabsTrigger value="installations">{t(locale, "appDetail.tabInstallations")}</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" forceMount>
          <div className="flex flex-col">
            {/* F11: the App's own identity and credentials stay on the App
                face — the bot configuration moved, the App metadata did not.
                A Blocked App (its bot is no longer shared) renders neither:
                the payload carries no App-side facts for it. */}
            {payload.blocked ? null : (
              <AppInfoSection
                locale={locale}
                app={payload.app}
                workspaceId={payload.workspace_id}
                canManage={true}
                onReload={onReload}
              />
            )}
            {target === null ? (
              payload.targets_many ? (
                <RepositoriesNotice locale={locale} copy="appDetail.targetsMany" />
              ) : (
                <RepositoriesNotice locale={locale} copy="appDetail.noRepository" />
              )
            ) : null}
            {target === null ? null : (
              <TargetOpsZone locale={locale} payload={target} onReload={onReload} />
            )}
            {payload.blocked ? null : (
              <AppCredentialsSection locale={locale} workspaceId={payload.workspace_id} app={payload.app} />
            )}
            {bot === null || payload.can_manage !== true ? null : (
              <AppShareSection locale={locale} appId={appId} app={payload.app} onReload={onReload} />
            )}
          </div>
        </TabsContent>
        <TabsContent value="bots">
          <div className="flex flex-col">
            {bot === null ? (
              <p className="py-3 text-sm text-muted-foreground">{t(locale, "apps.chain.pendingBind")}</p>
            ) : (
              <AppChainSection locale={locale} chain={bot.chain ?? []} />
            )}
          </div>
        </TabsContent>
        <TabsContent value="delivery">
          <div className="flex flex-col">
            {bot === null ? (
              <p className="py-3 text-sm text-muted-foreground">{t(locale, "appDetail.delivery.unavailable")}</p>
            ) : (
              <AppDeliveryTab
                locale={locale}
                appId={appId}
                summary={{
                  last_webhook_at: bot.app.last_webhook_at,
                  rejected24h: bot.delivery_summary?.rejected24h ?? 0,
                }}
              />
            )}
          </div>
        </TabsContent>
        <TabsContent value="installations" forceMount>
          <div className="flex flex-col">
            <AppInstallSection
              locale={locale}
              appId={appId}
              app={payload.app}
              installation={payload.installation}
              pendingInstallations={payload.blocked ? [] : payload.pending_installations}
              blocked={payload.blocked}
              onReload={onReload}
            />
            {bot === null ? null : (
              <AppInstallationsSection locale={locale} installations={bot.installations} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * "Share this app" (Task 5's second block): the one App-owned mutating
 * control the detail keeps, PATCHing `/api/apps/:appId/scope` behind the
 * same confirm-then-write shape the bot's share switch uses. Sharing is an
 * App property — a shared App is installable by any workspace — never a bot
 * property, so the control lives here and nowhere on the bot page.
 */
export function AppShareSection({
  locale,
  appId,
  app,
  onReload,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  app: { scope: "owned" | "shared" };
  onReload: (options?: { background?: boolean }) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<OpNotice | null>(null);

  async function submitScope(scope: "owned" | "shared"): Promise<void> {
    setBusy(true);
    try {
      const { status } = await patchJson(
        `${apiBase()}/api/apps/${encodeURIComponent(appId)}/scope`,
        { scope, ...(scope === "owned" ? { confirm: true } : {}) },
      );
      if (status < 200 || status >= 300) {
        setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
      } else {
        await onReload({ background: true });
        setNotice({
          kind: "success",
          message: t(locale, scope === "shared" ? "apps.shareAppSaved" : "apps.unshareAppSaved"),
        });
      }
    } catch {
      setNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
      setPending(false);
    }
  }

  const sharing = app.scope === "shared";
  return (
    <div className="flex flex-col gap-2 py-3" data-slot="app-share">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t(locale, sharing ? "apps.shareAppOn" : "apps.shareAppOff")}
        </p>
        <Button type="button" variant={sharing ? "destructive-outline" : "secondary"} onClick={() => setPending(true)}>
          {t(locale, "apps.shareAppSwitch")}
        </Button>
      </div>
      <NoticeRegion notice={notice} />
      {pending ? (
        <Dialog open onOpenChange={(open) => { if (!open) setPending(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(locale, "apps.shareAppSwitch")}</DialogTitle>
              <DialogDescription>
                {t(locale, sharing ? "apps.shareAppConfirmOff" : "apps.shareAppConfirm")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t(locale, "common.cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant={sharing ? "destructive" : "default"}
                disabled={busy}
                onClick={() => void submitScope(sharing ? "owned" : "shared")}
              >
                {t(locale, "apps.shareAppSwitch")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
