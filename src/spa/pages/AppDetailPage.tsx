import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import { StatusBadge } from "./AppsPage";
import { SettingsView } from "./SettingsPage";
import { AppInsightsTab } from "./AppInsightsTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { spaClick } from "../spa-click";
import { PageNotice, type NoticeKind } from "./PageNotice";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import {
  appDetailSearchQuery,
  parseAppDetailSearch,
  parseModels,
  parseSettings,
  type AppDetailSearch,
  type ModelOptionGroup,
  type SettingsPayload,
} from "./data";

/**
 * The App detail page (App detail IA): `/dashboard/apps/:slug` —
 * and the legacy `/dashboard/apps/:slug/settings` deep link (a permanent
 * settings-tab target: the settings POST family's HTML-nav 302s pin it) —
 * render this ONE two-tab shell. Default tab 应用设置 (the existing
 * settings capability, {@link SettingsView}); the 洞察 tab
 * ({@link AppInsightsTab}, per-App insights) renders ONLY when the payload
 * says `can_manage` — a non-manager never sees the tab at all.
 *
 * Page wayfinding (the back link to the Apps list) is the shell's —
 * rendered as the first element on the error and ok faces; the settings
 * tab body keeps only the version footer.
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
export function AppDetailPage({ boot, slug }: { boot: SpaBoot; slug: string }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<ModelOptionGroup[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const cancelledRef = useRef(false);
  // The can_manage gate as the payload states it, mirrored into a ref so
  // the (registered-once) popstate listener and the mount/slug
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
  async function load({ background = false }: { background?: boolean } = {}): Promise<boolean> {
    if (!background) setState("loading");
    try {
      const settingsRaw = await fetchJson(`/dashboard/api/apps/${encodeURIComponent(slug)}/settings`);
      if (cancelledRef.current) return false;
      const parsed = parseSettings(settingsRaw);
      if (!parsed) {
        if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
        return false;
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
      if (cancelledRef.current) return false;
      setPayload(parsed);
      setGroups(nextGroups);
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
  }

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    // A slug push re-derives the URL state too (the address bar moved);
    // the gate comes from the ref mirror, never a stale payload closure.
    setSearch(parseAppDetailSearch(window.location.search, canManageRef.current));
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // When the payload lands (can_manage becomes known), mirror the gate and
  // re-derive the URL state once: a manager's `?tab=insights` deep link —
  // or a history entry carrying it — activates the insights tab only now
  // that the payload confirms can_manage. Registered-once listeners keep
  // reading the ref, so this re-derivation also covers every later
  // popstate while the gate stays stable.
  useEffect(() => {
    canManageRef.current = payload?.can_manage ?? false;
    if (payload) {
      // Mid-session demotion: a URL still carrying ?tab=insights while the
      // landed payload says non-manager is rewritten to the bare path
      // (replaceState — loop-free), so the stale param cannot silently
      // auto-reactivate the insights face on a later re-promotion.
      if (
        !canManageRef.current &&
        parseAppDetailSearch(window.location.search, true).tab === "insights"
      ) {
        commitSearch({ tab: "settings", window: "30", repo: "" });
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

  // Loading rides the shared skeleton as the page's full loading face —
  // the skeleton's heading placeholder stands in for the real h1 (AD-582),
  // matching the Apps/Members idiom. Foreground only, so op-triggered
  // background reloads never flash it (the background-reload contract).
  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="forms" />;
  }

  // Deep-link withhold (bugbot fix): once the payload lands, `state` is
  // "ok" but the URL-requested tab has not been committed yet (the
  // payload-landing effect runs after this render) — `search` still
  // carries the mount-time gate. Rendering the tab face now would flash
  // 应用设置 before 洞察 on a manager's `?tab=insights` deep link, so the
  // shell withholds it behind the loading skeleton for exactly that one
  // paint. Background reloads are unaffected: searchReady stays true.
  if (state === "ok" && payload && !searchReady) {
    return <PageSkeleton locale={locale} kind="forms" />;
  }

  // Page wayfinding: the back link is the shell's first element on both
  // faces (error + ok — it serves both roles), moved here from the
  // settings tab body. The decorative ArrowLeft rides the link
  // aria-hidden, so the accessible name stays the backToApps text alone.
  const wayfinding = (
    <a
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline"
      href="/dashboard/apps"
      onClick={(event) => spaClick("/dashboard/apps", event)}
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
      {t(locale, "appDetail.backToApps")}
    </a>
  );

  return (
    <div className="flex flex-col gap-6">
      {wayfinding}
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        <AppDetailView
          locale={locale}
          slug={slug}
          payload={payload}
          groups={groups}
          notice={notice}
          search={search}
          onReload={load}
          onSearch={commitSearch}
        />
      ) : null}
    </div>
  );
}

/**
 * The tabbed face — pure `t()` + data rendering, no window/router
 * access, so tests can static-render it (the AppInfoCard idiom). The
 * identity header (slug h1 + status + creator) belongs to the shell and
 * serves BOTH tabs; the settings tab body keeps only the version footer
 * (page wayfinding — the back link — moved to the shell).
 */
export function AppDetailView({
  locale,
  slug,
  payload,
  groups,
  notice,
  search,
  onReload,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  slug: string;
  payload: SettingsPayload;
  groups: ModelOptionGroup[];
  notice: { kind: NoticeKind; message: string } | null;
  search: AppDetailSearch;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
  onSearch: (next: AppDetailSearch) => void;
}) {
  const canManage = payload.can_manage;
  // A stale `?tab=insights` URL after a demotion resolves to settings —
  // the view never renders an insights face for a non-manager.
  const tab = canManage ? search.tab : "settings";

  function onTabChange(next: string): void {
    if (next !== "settings" && next !== "insights") return;
    onSearch({ ...search, tab: next });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Identity header — serves both tabs. */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">{slug}</h1>
        <StatusBadge locale={locale} status={payload.app.status} reviewEnabled={payload.app.review_enabled} />
        <span className="text-sm text-muted-foreground">{t(locale, "apps.by", { login: payload.app.created_by })}</span>
      </div>
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      <Tabs value={tab} onValueChange={onTabChange}>
        {/* Page-level tab face (DESIGN.md ### Tabs, line-tab idiom): the
            shell's bar is full-width over a bottom hairline (border-border
            → gray-alpha-400) with left-aligned, sized-up triggers — 16px
            heading-16 token step on a 40px bar. The component defaults stay
            generic: the chains-panel segmented pill keeps variant="default";
            the face lives at this consumption site only. */}
        <TabsList
          variant="line"
          className="h-10 w-full justify-start gap-4 border-b border-border p-0"
        >
          <TabsTrigger
            value="settings"
            className="flex-none px-3 text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking) group-data-[orientation=horizontal]/tabs:after:bottom-[-2px]"
          >
            {t(locale, "appDetail.tabSettings")}
          </TabsTrigger>
          {/* The 洞察 tab exists ONLY on the manage face — absence is the
              non-manager contract, pinned by test. */}
          {canManage ? (
            <TabsTrigger
              value="insights"
              className="flex-none px-3 text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking) group-data-[orientation=horizontal]/tabs:after:bottom-[-2px]"
            >
              {t(locale, "appDetail.tabInsights")}
            </TabsTrigger>
          ) : null}
        </TabsList>
        {/* forceMount on BOTH panels (mount-once tab switching): the
            settings form state (typed inputs, Add Provider panel, op
            notices) and the loaded insights data survive 应用设置 ↔ 洞察
            switches — no unmount, no refetch. Radix does NOT hide
            forced-mounted inactive panels itself; the wrapper's
            `data-[state=inactive]:hidden` carries the one-visible-panel
            invariant (ui-bugs knowledge pin, source-tested below). */}
        <TabsContent value="settings" forceMount>
          <SettingsView locale={locale} payload={payload} groups={groups} onReload={onReload} />
        </TabsContent>
        {canManage ? (
          <TabsContent value="insights" forceMount>
            <AppInsightsTab locale={locale} slug={slug} search={search} onSearch={onSearch} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
