import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { StatusBadge } from "./AppsPage";
import { SettingsView } from "./SettingsPage";
import { AppInsightsTab } from "./AppInsightsTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
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

  // Mount-time URL state, re-derived on every popstate. `navigate()`
  // pushStates then dispatches a synthetic popstate (router.tsx), and
  // history traversal fires the native event, so push and history both
  // land here. `canManage` gates the insights tab: a non-manager's
  // `?tab=insights` deep link resolves to the settings tab (the listener
  // below re-reads canManage at call time; registration is once).
  const [search, setSearch] = useState<AppDetailSearch>(() =>
    parseAppDetailSearch(window.location.search, false),
  );

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
    // A slug push re-derives the URL state too (the address bar moved).
    setSearch(parseAppDetailSearch(window.location.search, payload?.can_manage ?? false));
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    const onPop = () => setSearch(parseAppDetailSearch(window.location.search, payload?.can_manage ?? false));
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

  return (
    <div className="flex flex-col gap-6">
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
 * serves BOTH tabs; the settings tab body keeps its own wayfinding
 * (back link) and version footer.
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
        <TabsList>
          <TabsTrigger value="settings">{t(locale, "appDetail.tabSettings")}</TabsTrigger>
          {/* The 洞察 tab exists ONLY on the manage face — absence is the
              non-manager contract, pinned by test. */}
          {canManage ? <TabsTrigger value="insights">{t(locale, "appDetail.tabInsights")}</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="settings">
          <SettingsView locale={locale} payload={payload} groups={groups} onReload={onReload} />
        </TabsContent>
        {canManage ? (
          <TabsContent value="insights">
            <AppInsightsTab locale={locale} slug={slug} search={search} onSearch={onSearch} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
