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

/**
 * The App's model options, which the chain editors name. A manager's read only
 * — a member never reaches those editors — and a failed read leaves the
 * editors' selectors empty rather than failing the whole page.
 */
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
  // Read per render (the AppsPage precedent): the switcher navigates with
  // pushState + popstate, so no new document re-injects the boot — the page
  // base must track the URL it is actually on. `/dashboard/acme/apps/demo` →
  // `/dashboard/beta/apps/12345` keeps the appId, so a base pinned at mount
  // would leave the previous workspace's settings and model chain on screen.
  const base = apiBase();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const loadSequence = useRef(0);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);
  // Mount-time URL state, re-derived on every popstate. `navigate()`
  // pushStates then dispatches a synthetic popstate (router.tsx), and
  // history traversal fires the native event, so push and history both land
  // here.
  const [search, setSearch] = useState<AppDetailSearch>(() =>
    parseAppDetailSearch(window.location.search),
  );

  // Background reloads (op-triggered refreshes) keep the loaded card tree
  // mounted: they must not flip state back to "loading" — that unmount would
  // destroy Add Provider's open/selection state and every form's typed input
  // (QC fix wave 1, F-001). A failed background refresh surfaces the
  // error through the notice channel instead of the page-level error state.
  // Resolves whether a fresh payload landed, so callers can tell a completed
  // refresh from a failed one (the draft create must not close on failure).
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
        // A healthy page has no page-level failure: any successful load —
        // foreground or background — clears the banner a failed background
        // reload left behind (the bugbot fix).
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
    // An appId or workspace push re-derives the URL state too (the address bar
    // moved).
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

  /** URL := state (replaceState — never fires popstate, loop-free). */
  function commitSearch(next: AppDetailSearch): void {
    window.history.replaceState(null, "", `${window.location.pathname}${appDetailSearchQuery(next)}`);
    setSearch(next);
  }

  // Every face keeps the wayfinding link — loading included, so a slow read
  // never strands the operator on a page with no exit.
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

/**
 * The derived Blocked state's copy: the server names the one cause it can
 * derive, and the banner prints that name. A closed map, so a new reason
 * cannot render silently as nothing.
 */
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
  // Why this target reviews nothing, if it does. The server derives it on
  // every read (no stored status), so the banner cannot go stale.
  const blockedMessage =
    payload.blocked && payload.blocked_reason
      ? t(locale, BLOCKED_REASON_KEYS[payload.blocked_reason])
      : null;

  // Header band metrics — only what the landed payload proves (compass
  // D13): the four figures the manager payload carries — installations,
  // provider keys, model chains, and refused webhooks in the last 24h. The
  // refusal count is the one figure here that reports a failure, so it — and
  // only it — wears the alert face, and only when non-zero, exactly as the
  // Apps list face (`AppsPage`) already rules it. A Blocked face carries none
  // of the four (they are the bot's), so the band renders nothing rather than
  // four fabricated zeros.
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
            {/* The settings face is this page's own now, but a target detail
                still reaches it from here — and a Blocked target's bot page is
                not readable (the bot serves another workspace now), so the dead
                link is not offered. */}
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

/**
 * The App's repository-count states — no repository at all, or several — both
 * state the fact. No link: the repository surface is not reachable backwards
 * from here, and a dead reference would be worse than the sentence alone.
 */
function RepositoriesNotice({
  locale,
  copy,
}: {
  locale: SpaBoot["locale"];
  copy: DictionaryKey;
}) {
  return <p className="py-3 text-sm text-muted-foreground">{t(locale, copy)}</p>;
}

/**
 * The ops zone (pause/resume, disable/enable, delete) with the confirm dialog
 * that guards it: the section renders the rows and this wrapper owns the one
 * pending action and its outcome. Bot-scoped lifecycle rows render only for
 * the workspace that owns an `owned` bot — the server refuses them otherwise.
 * The review pause is the repository's own (target policy): this App-scoped
 * surface never renders it.
 */
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
          // Irreversible outcome with its own copy: "Changes saved." reads
          // wrong after a delete, and refetching the deleted App's settings GET
          // is a guaranteed 404, so it would overwrite the outcome.
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
  /** The chain editors' model options — empty for a member. */
  groups: ModelOptionGroup[];
  modelsLoading?: boolean;
  notice: { kind: NoticeKind; message: string } | null;
  search: AppDetailSearch;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
  onSearch: (next: AppDetailSearch) => void;
}) {
  // D4: a non-manager's whole face is the identity card — the review policy
  // is not theirs to read, and it lives on the review-target surface.
  if (!payload.can_manage) {
    return (
      <div className="flex flex-col gap-6">
        <TargetHeader locale={locale} appId={appId} payload={payload} />
        {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
        <SettingsView locale={locale} payload={payload} />
      </div>
    );
  }

  // A Blocked read carries no bot-owned section at all — those belong to the
  // owning workspace — and a target-less one has no review policy: the ops
  // zone and the bot's own configuration are each conditional on their facts.
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
        {/* Page-level tab face (DESIGN.md ### Tabs, line-tab idiom): the
            shell's bar is full-width over a bottom hairline (border-border
            → gray-alpha-400) with left-aligned, sized-up triggers — 16px
            heading-16 token step on a 40px bar. The trigger face is the
            primitive's line variant, so a change to that variant reaches this
            page like every other; only the bar itself — full width, hairline,
            40px — is the page's choice. The chains-panel segmented pill keeps
            variant="default". */}
        <TabsList
          variant="line"
          className="group-data-[orientation=horizontal]/tabs:h-10 w-full justify-start gap-4 border-b border-border p-0"
        >
          <TabsTrigger value="settings">{t(locale, "appDetail.tabSettings")}</TabsTrigger>
          <TabsTrigger value="delivery">{t(locale, "appDetail.tabDelivery")}</TabsTrigger>
          <TabsTrigger value="installations">{t(locale, "appDetail.tabInstallations")}</TabsTrigger>
        </TabsList>
        {/* forceMount on the two STATEFUL panels (mount-once tab switching):
            the settings tab's typed input and the install block's state
            survive a switch — no unmount, no refetch. Radix does NOT hide
            forced-mounted inactive panels itself; the panel's
            `data-[state=inactive]:hidden` carries the one-visible-panel
            invariant (ui-bugs knowledge pin). The delivery panel has no typed
            state and reads on open, so it deliberately does not forceMount. */}
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
        {/* NOT forceMount: this panel holds no typed state, and mounting it
            eagerly would fire its read on every App settings visit. It reads
            when opened, which is when its data is wanted. */}
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
            {/* The roster reads `bot`'s own array — the same one the header
                band counts — and a Blocked face carries no installation rows at
                all (they belong to the owning workspace), so it renders no
                table rather than a false "none". */}
            {bot === null ? null : (
              <AppInstallationsSection locale={locale} installations={bot.installations} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
