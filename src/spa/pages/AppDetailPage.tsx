import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import { MetricBand, type Metric } from "@/components/MetricBand";
import { AllowlistSection, AppInstallSection, SettingsView } from "./SettingsPage";
import { AppInsightsTab } from "./AppInsightsTab";
import { AppPullRequestsTab } from "./AppPullRequestsTab";
import { StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { spaClick } from "../spa-click";
import { apiBase } from "../workspace-base";
import { PageNotice, type NoticeKind } from "./PageNotice";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import {
  appDetailSearchQuery,
  appDisplayName,
  appStatusPill,
  parseAppDetailSearch,
  parseSettings,
  type AppDetailSearch,
  type BlockedReason,
  type ReadScope,
  type SettingsPayload,
} from "./data";

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
 * One App detail read: the settings payload (the manage face carries the
 * model options) under the page's own base. `base` is a parameter, not
 * `apiBase()` inside, so the caller decides which workspace is being read —
 * and a test can drive the same read under two pathnames.
 * `can_manage` gates the second request: a non-manager sees no model editor.
 */
export async function loadAppDetail(base: string, appId: string): Promise<SettingsPayload | null> {
  return parseSettings(await fetchJson(`${base}/api/apps/${encodeURIComponent(appId)}/settings`));
}

/**
 * The App detail page: `/dashboard/apps/:appId` and its workspace twin. The
 * target-owned review policy no longer lives here — it is the review-target
 * surface's detail body ({@link SettingsView} there) — so this page renders
 * the App's own faces: 洞察 ({@link AppInsightsTab}, the default tab), 已安装
 * and Pull requests, each ONLY when the payload says `can_manage`. A
 * non-manager keeps the D4 identity card it has always been served.
 *
 * Page wayfinding (the back link to the Apps list) is the shell's —
 * rendered as the first element on the error and ok faces.
 *
 * Data plane: the shell owns the settings fetch (both faces — the
 * identity-only `can_manage: false` shape parses through the D4 identity
 * set; the manager face keeps the full contract) and the background-reload
 * machinery (unchanged contract: background reloads keep the card tree
 * mounted, failures ride the page notice). Tab + insights-filter state is
 * URL-derived per the spa-url-state-resync contract: one []-mounted
 * popstate listener re-derives through the shared pure helper
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
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);
  // The can_manage gate as the payload states it, mirrored into a ref so
  // the (registered-once) popstate listener and the mount/appId
  // re-derivations read the CURRENT gate instead of a stale `false`
  // closure — a manager's `?tab=insights` deep link and history
  // back/forward must activate the insights tab. The mirror is written
  // when the payload lands (the re-derivation effect below); until then
  // `false` is the honest gate (nothing but settings can render anyway).
  const canManageRef = useRef(false);

  // Mount-time URL state, re-derived on every popstate. `navigate()`
  // pushStates then dispatches a synthetic popstate (router.tsx), and
  // history traversal fires the native event, so push and history both
  // land here. `canManage` gates the insights tab: a non-manager's
  // `?tab=insights` deep link resolves to the settings tab (the listener
  // below re-reads the canManageRef mirror at call time; registration is
  // once).
  const [search, setSearch] = useState<AppDetailSearch>(() =>
    parseAppDetailSearch(window.location.search, canManageRef.current),
  );
  // Whether the URL-requested tab has been committed against a landed
  // payload. Until the payload effect below re-derives (or rewrites) the
  // location, `search` still carries the mount-time gate (`false`) — a
  // manager's `?tab=insights` deep link would first-paint the settings
  // tab. The shell withholds the tab face (renders the loading skeleton)
  // until this flips true; the demotion rewrite and the re-derivation
  // both commit it.
  const [searchReady, setSearchReady] = useState(false);

  // Background reloads (op-triggered refreshes) keep the loaded card tree
  // mounted: they must not flip state back to "loading" — that unmount would
  // destroy Add Provider's open/selection state and every form's typed input
  // (QC fix wave 1, F-001). A failed background refresh surfaces the
  // error through the notice channel instead of the page-level error state.
  // Resolves whether a fresh payload landed, so callers can tell a completed
  // refresh from a failed one (the draft create must not close on failure).
  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<boolean> => {
      if (!background) setState("loading");
      try {
        const loaded = await loadAppDetail(base, appId);
        if (cancelledRef.current) return false;
        if (!loaded) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return false;
        }
        setPayload(loaded);
        setState("ok");
        // A healthy page has no page-level failure: any successful load —
        // foreground or background — clears the banner a failed background
        // reload left behind (the bugbot fix).
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
    // An appId or workspace push re-derives the URL state too (the address bar
    // moved); the gate comes from the ref mirror, never a stale payload
    // closure.
    setSearch(parseAppDetailSearch(window.location.search, canManageRef.current));
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  // When the payload lands (can_manage becomes known), mirror the gate and
  // re-derive the URL state once: a manager's `?tab=insights` deep link —
  // or a history entry carrying it — activates the insights tab only now
  // that the payload confirms can_manage. Registered-once listeners keep
  // reading the ref, so this re-derivation also covers every later
  // popstate while the gate stays stable.
  useEffect(() => {
    canManageRef.current = payload?.can_manage ?? false;
    if (payload) {
      // Mid-session demotion: a URL still carrying a manager tab
      // (?tab=installations / ?tab=insights / ?tab=pull-requests) while the
      // landed payload says non-manager is rewritten to the bare path
      // (replaceState — loop-free), so the stale param cannot silently
      // auto-reactivate a manager face on a later re-promotion.
      if (
        !canManageRef.current &&
        parseAppDetailSearch(window.location.search, true).tab !== "insights"
      ) {
        commitSearch({ tab: "insights", window: "30", repo: "", pr: "" });
        setSearchReady(true);
        return;
      }
      setSearch(parseAppDetailSearch(window.location.search, canManageRef.current));
      setSearchReady(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.can_manage]);

  useEffect(() => {
    const onPop = () => setSearch(parseAppDetailSearch(window.location.search, canManageRef.current));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Deep-link withhold (bugbot fix): once the payload lands, `state` is
  // "ok" but the URL-requested tab has not been committed yet (the
  // payload-landing effect runs after this render) — `search` still
  // carries the mount-time gate. Rendering the tab face now would flash
  // 应用设置 before 洞察 on a manager's `?tab=insights` deep link, so the
  // shell withholds it behind the loading skeleton for exactly that one
  // paint. Background reloads are unaffected: searchReady stays true.
  if (state === "ok" && payload && !searchReady) {
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
 * The link from the target detail to the bot's own settings page. The href is
 * derived from the page's own API base, so it is the real target on both the
 * legacy and the workspace-scoped path.
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
  // D13): the four figures `SettingsManagePayload` carries — installations,
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
            {/* The bot's own configuration has its own page: the target keeps
                the workspace's review policy and links across for the rest. A
                Blocked target's bot page is not readable from here (the bot
                serves another workspace now), so the dead link is not offered. */}
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
 * The App detail face — pure `t()` + data rendering, no window/router access,
 * so tests can static-render it. A non-manager gets the D4 identity card; a
 * manager gets the App's own tabs, 洞察 first.
 */
export function AppDetailView({
  locale,
  appId,
  payload,
  notice,
  search,
  onReload,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  payload: SettingsPayload;
  notice: { kind: NoticeKind; message: string } | null;
  search: AppDetailSearch;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
  onSearch: (next: AppDetailSearch) => void;
}) {
  const canManage = payload.can_manage;
  // A stale manager-tab URL after a demotion resolves to the default tab —
  // the view never renders a manager face for a non-manager.
  const tab = canManage ? search.tab : "insights";
  // The App's own read scope: its settings face names the ONE target this page
  // is about, so its insights and ledger read that target — never the whole
  // workspace and never another target's rows.
  const scope: ReadScope = { kind: "target", targetId: payload.target_id };

  function onTabChange(next: string): void {
    if (next !== "installations" && next !== "insights" && next !== "pull-requests") {
      return;
    }
    onSearch({ ...search, tab: next });
  }

  // D4: a non-manager's whole face is the identity card — the review policy
  // is not theirs to read, and it lives on the review-target surface.
  if (!canManage) {
    return (
      <div className="flex flex-col gap-6">
        <TargetHeader locale={locale} appId={appId} payload={payload} />
        {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
        <SettingsView locale={locale} payload={payload} onReload={onReload} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <TargetHeader locale={locale} appId={appId} payload={payload} />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      <Tabs value={tab} onValueChange={onTabChange}>
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
          <TabsTrigger value="insights">{t(locale, "appDetail.tabInsights")}</TabsTrigger>
          <TabsTrigger value="installations">{t(locale, "appDetail.tabInstallations")}</TabsTrigger>
          <TabsTrigger value="pull-requests">{t(locale, "appDetail.tabPullRequests")}</TabsTrigger>
        </TabsList>
        {/* forceMount on EVERY panel (mount-once tab switching): the loaded
            insights data and the install block's typed state survive
            洞察 ↔ 已安装 ↔ Pull requests switches — no unmount, no refetch.
            Radix does NOT hide forced-mounted inactive panels itself; the
            wrapper's `data-[state=inactive]:hidden` carries the
            one-visible-panel invariant (ui-bugs knowledge pin,
            source-tested below). */}
        <TabsContent value="insights" forceMount>
          <AppInsightsTab locale={locale} scope={scope} search={search} onSearch={onSearch} />
        </TabsContent>
        <TabsContent value="installations" forceMount>
          {/* Installed tab: the shareable install link leads, the owner
              allowlist follows it (owners arrive through installations),
              then the installation table and its delivery health. The
              allowlist renders for EVERY visibility: admission enforces a
              stored list whatever the App's visibility, so a hidden control
              would leave a live filter unmanageable. A private App instead
              carries a line saying the control stays visible for that
              reason. */}
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
            <AllowlistSection
              locale={locale}
              appId={appId}
              allowlist={payload.allowlist}
              privateApp={payload.app.github_visibility === "private"}
              installations={payload.blocked ? null : payload.installations}
              onReload={onReload}
            />
          </div>
        </TabsContent>
        <TabsContent value="pull-requests" forceMount>
          <AppPullRequestsTab locale={locale} scope={scope} search={search} onSearch={onSearch} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
