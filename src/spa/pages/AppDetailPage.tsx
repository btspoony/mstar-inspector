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
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@design-system";
import {
  AppInstallationsSection,
  AppInstallSection,
  OpsSection,
  SettingsView,
  pendingConfirmCopy,
  postPinnedOutcome,
} from "./SettingsPage";
import { AppDeliveryTab } from "./AppDeliveryTab";
import { BotSettingsView } from "./BotSettingsPage";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { spaClick } from "../spa-click";
import { apiBase } from "../workspace-base";
import { PageNotice, type NoticeKind, type OpNotice } from "./PageNotice";
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
  return parseSettings(await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}/settings`));
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

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    setSearch(parseAppDetailSearch(window.location.search));
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

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
 * The link from a target detail to the App's own settings face. The href is
 * derived from the page's own API base, so it is the real target on both the
 * legacy and the workspace-scoped path; `/bot` answers one redirect to the
 * settings tab.
 */
export function BotSettingsLink({ locale, appId }: { locale: SpaBoot["locale"]; appId: string }) {
  const href = `${apiBase()}/apps/${encodeURIComponent(appId)}/bot`;
  return (
    <a
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
      href={href}
      onClick={(event) => spaClick(href, event)}
    >
      {t(locale, "appDetail.botSettingsLink")}
    </a>
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

  const metrics: Metric[] = payload.can_manage && !payload.blocked
    ? [
        { key: t(locale, "settings.installations"), value: payload.installations.length },
        { key: t(locale, "settings.metricKeys"), value: payload.keys.length },
        { key: t(locale, "settings.modelChains"), value: payload.model_chains.length },
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
        description={t(locale, "apps.by", { login: payload.app.created_by })}
        actions={
          <>
            {blockedMessage ? null : <BotSettingsLink locale={locale} appId={appId} />}
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
    if (next !== "settings" && next !== "delivery" && next !== "installations") return;
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
          <TabsTrigger value="delivery">{t(locale, "appDetail.tabDelivery")}</TabsTrigger>
          <TabsTrigger value="installations">{t(locale, "appDetail.tabInstallations")}</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" forceMount>
          <div className="flex flex-col">
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
            {bot === null ? null : (
              <BotSettingsView
                locale={locale}
                payload={{ ...bot, can_manage: bot.can_configure_bot === true }}
                groups={groups}
                modelsLoading={modelsLoading}
                notice={null}
                onReload={onReload}
              />
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
