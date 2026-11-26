/**
 * The Apps page (D6/D8/D22/D25): ONE list surface split into three
 * URL-addressable tabs.
 *
 * - `installed` — Apps this workspace holds an INSTALLATION RELATION to, plus
 *   one "Waiting to be bound" row per pending physical installation. Under D43
 *   the membership is derived from relations that exist today (a live
 *   `review_targets.app_id` row, or a bound `github_app_installations` row) —
 *   never from `app_installations`, which install-state-chain fills.
 * - `created` — the Apps the workspace owns, installed or not.
 * - `bots` — "Bots I can use": one server-ordered read, client-side filters, no
 *   App column.
 *
 * The tab rides `?tab=`; only the tab equal to the REAL default is omitted, an
 * unknown value is corrected once the payload lands, and tab changes push
 * history entries so Back/Forward walk them.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
  DialogTrigger,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@design-system";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { MetricBand, type Metric } from "@/components/MetricBand";
import { PageHeader } from "@/components/PageHeader";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { AppAvatar } from "../components/AppAvatar";
import { appInstallHref } from "../components/AppInstallIdentity";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { deliveryOutcomeLabel } from "../delivery-outcome";
import { formatRelativeTime } from "../relative-time";
import { spaClick } from "../spa-click";
import {
  appDisplayName,
  appStatusPill,
  parseApps,
  parseUsableBots,
  reviewEnabled,
  type AppsPayload,
  type SharedAppCard,
  type SharedBotRow,
  type UsableBotsPayload,
} from "./data";
import { GitHubMark } from "./LoginPage";
import { apiBase } from "../workspace-base";

/**
 * Create eligibility for the workspace the PATH addresses, recomputed per
 * render — the once-injected `boot.canCreateApp` snapshot goes stale on the
 * first switcher navigation (pushState, no new document). The addressed ref
 * matches a membership on either identifier (id or slug); a page with no
 * ref (the legacy single-workspace mount) keeps trusting the snapshot, as
 * does a ref no membership names (nothing better is known client-side).
 * `workspaceRequired` (multi-workspace, no target) disables creation
 * regardless — the deployment cannot say which workspace an App would join.
 */
export function canCreateAppFor(boot: SpaBoot, addressedRef: string | null): boolean {
  if (boot.workspaceRequired === true) return false;
  if (addressedRef === null) return boot.canCreateApp !== false;
  const membership = boot.memberships?.find((m) => m.id === addressedRef || m.slug === addressedRef);
  return membership === undefined ? boot.canCreateApp !== false : membership.role !== "member";
}

/**
 * One Apps list read under the given base. The base is a parameter, not
 * `apiBase()` inside, so the caller decides which workspace is read — the
 * page derives it per render and a test can drive both pathnames.
 */
export async function loadApps(base: string): Promise<AppsPayload | null> {
  return parseApps(await fetchJson(`${base}/api/apps`));
}

/** One "Bots I can use" read — the server already serves the D18 ordering. */
export async function loadUsableBots(base: string): Promise<UsableBotsPayload> {
  const parsed = parseUsableBots(await fetchJson(`${base}/api/review-bots`));
  if (parsed === null) throw new Error("unreadable bot list");
  return parsed;
}

export type AppsTab = "installed" | "created" | "bots";

const APP_TABS: readonly AppsTab[] = ["installed", "created", "bots"];

/**
 * F1/D8: an App is INSTALLED when this workspace holds an installation
 * relation to it — a live target, or a bound physical installation. Ownership
 * alone is not membership; an owned-but-uninstalled App is created-only.
 */
export function installedAppsOf(payload: AppsPayload): AppsPayload["apps"] {
  return payload.apps.filter((app) => app.installed === true);
}

/** The tab the URL names, or the D8 default once membership is known. */
export function appsTabOf(search: string, hasInstalled: boolean): AppsTab {
  const value = new URLSearchParams(search).get("tab");
  if (value === "installed" || value === "created" || value === "bots") return value;
  return hasInstalled ? "installed" : "created";
}

/** F2: the real default is omitted; every other tab is spelled out. */
export function appsTabQuery(tab: AppsTab, defaultTab: AppsTab): string {
  return tab === defaultTab ? "" : `?tab=${tab}`;
}

export type AppsReadState =
  | { kind: "loading" }
  | { kind: "ok"; payload: AppsPayload }
  | { kind: "error"; message: string };

export type BotsReadState =
  | { kind: "loading" }
  | { kind: "ok"; payload: UsableBotsPayload }
  | { kind: "error"; message: string };

export function AppsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [apps, setApps] = useState<AppsReadState>({ kind: "loading" });
  // F3: a failed bot read is its OWN state — never an empty list.
  const [bots, setBots] = useState<BotsReadState>({ kind: "loading" });
  const [tab, setTab] = useState<AppsTab>(() => appsTabOf(window.location.search, false));
  const base = apiBase();
  const canCreate = canCreateAppFor(boot, base === "/dashboard" ? null : base.slice("/dashboard/".length));
  const unavailableReason =
    boot.workspaceRequired === true
      ? t(locale, "apps.createUnavailable.workspace")
      : t(locale, "apps.createUnavailable.role");

  const load = useCallback(async (): Promise<void> => {
    setApps({ kind: "loading" });
    setBots({ kind: "loading" });
    // The two reads fail independently: an Apps failure must not hide the bot
    // list, and a bot failure must never read as "no bot is available".
    try {
      const parsed = await loadApps(base);
      setApps(
        parsed === null
          ? { kind: "error", message: t(locale, "common.loadFailed") }
          : { kind: "ok", payload: parsed },
      );
    } catch (err) {
      setApps({
        kind: "error",
        message: err instanceof Error && err.message !== "" ? err.message : t(locale, "common.loadFailed"),
      });
    }
    try {
      setBots({ kind: "ok", payload: await loadUsableBots(base) });
    } catch {
      setBots({ kind: "error", message: t(locale, "common.loadFailed") });
    }
  }, [base, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultTab: AppsTab | null =
    apps.kind === "ok" ? (installedAppsOf(apps.payload).length > 0 ? "installed" : "created") : null;

  // F2: an unknown / stale `?tab=` resolves to the REAL default once the
  // payload lands, and the URL is corrected to the canonical
  // (default-omitted) spelling. A known tab is the reader's choice — kept.
  useEffect(() => {
    if (defaultTab === null) return;
    const raw = new URLSearchParams(window.location.search).get("tab");
    if (raw !== null && APP_TABS.includes(raw as AppsTab)) {
      setTab(raw as AppsTab);
      return;
    }
    setTab(defaultTab);
    if (raw !== null) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${appsTabQuery(defaultTab, defaultTab)}`,
      );
    }
  }, [defaultTab]);

  useEffect(() => {
    const onPop = () => {
      if (defaultTab === null) return;
      setTab(appsTabOf(window.location.search, defaultTab === "installed"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [defaultTab]);

  if (apps.kind === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }

  function onTabChange(next: string): void {
    if (!APP_TABS.includes(next as AppsTab)) return;
    const target = next as AppsTab;
    // F2: tab changes are HISTORY entries, so Back/Forward walk them; only the
    // real default stays out of the URL.
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${appsTabQuery(target, defaultTab ?? "created")}`,
    );
    setTab(target);
  }

  return (
    <AppsView
      locale={locale}
      apps={apps}
      bots={bots}
      canCreate={canCreate}
      unavailableReason={unavailableReason}
      tab={tab}
      onTabChange={onTabChange}
      onRetry={() => void load()}
    />
  );
}

/**
 * The loaded face of the Apps page, split out of the stateful page so the
 * rendered markup — the Create action included — is assertable without a DOM
 * runner (the AppDetailShell precedent).
 */
export function AppsView({
  locale,
  state,
  payload,
  apps,
  bots,
  canCreate,
  unavailableReason,
  tab,
  onTabChange,
  onRetry,
}: {
  locale: SpaBoot["locale"];
  /** Static-SSR form: a loaded face plus its payload. */
  state?: "ok" | "error";
  payload?: AppsPayload | null;
  /** Mounted form: the page's own read states, which distinguish loading from
   * a failed read from an empty result (F3). */
  apps?: AppsReadState;
  bots?: BotsReadState;
  canCreate: boolean;
  unavailableReason: string;
  tab?: AppsTab;
  onTabChange?: (tab: string) => void;
  onRetry: () => void;
}) {
  const appsState: AppsReadState =
    apps ?? (state === "error" ? { kind: "error", message: t(locale, "common.loadFailed") } : state === "ok" && payload ? { kind: "ok", payload } : { kind: "error", message: t(locale, "common.loadFailed") });
  const botsState: BotsReadState = bots ?? { kind: "loading" };
  const loaded = appsState.kind === "ok" ? appsState.payload : null;
  const installed = loaded ? installedAppsOf(loaded) : [];
  const ownedApps = loaded?.apps.filter((app) => app.owned !== false) ?? [];
  const hasCreated = ownedApps.length > 0;
  const activeTab: AppsTab = tab ?? (installed.length > 0 ? "installed" : "created");
  const createAction = (
    <CreateAppChooser
      locale={locale}
      canCreate={canCreate}
      reason={unavailableReason}
      sharedBots={loaded?.shared_bots ?? []}
      monthPlanRp={loaded?.month_plan_rp ?? null}
    />
  );

  const rejected24h = loaded?.apps.reduce((total, app) => total + app.health.rejected24h, 0) ?? 0;
  const metrics: Metric[] = loaded
    ? [
        { key: t(locale, "apps.metricApps"), value: loaded.apps.length },
        {
          key: t(locale, "apps.metricEnabled"),
          value: loaded.apps.filter((app) => app.status !== "disabled").length,
        },
        {
          key: t(locale, "apps.metricReviewOff"),
          value: loaded.apps.filter((app) => !reviewEnabled(app)).length,
        },
        {
          key: t(locale, "apps.metricRejected24h"),
          value: rejected24h,
          tone: rejected24h > 0 ? "danger" : undefined,
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "apps.heading")}
        description={t(locale, "apps.headingDescription")}
        actions={hasCreated ? createAction : null}
        metrics={<MetricBand metrics={metrics} />}
      />
      {appsState.kind === "error" ? (
        // F3: a read failure is an error carrying the server message plus a
        // retry — never an empty list.
        <ErrorState locale={locale} message={appsState.message} onRetry={onRetry} />
      ) : null}
      {appsState.kind === "ok" && loaded ? (
        <Tabs value={activeTab} onValueChange={(next) => onTabChange?.(next)}>
          <TabsList
            variant="line"
            className="group-data-[orientation=horizontal]/tabs:h-10 w-full justify-start gap-4 border-b border-border p-0"
          >
            <TabsTrigger value="installed">{t(locale, "apps.tabInstalled")}</TabsTrigger>
            <TabsTrigger value="created">{t(locale, "apps.tabCreated")}</TabsTrigger>
            <TabsTrigger value="bots">{t(locale, "apps.tabBots")}</TabsTrigger>
          </TabsList>
          <TabsContent value="installed">
            <InstalledTab
              locale={locale}
              payload={loaded}
              installed={installed}
              quotaError={loaded.quota_error === true}
              canCreate={canCreate}
              createAction={createAction}
            />
          </TabsContent>
          <TabsContent value="created">
            {hasCreated ? (
              <AppsList locale={locale} payload={{ ...loaded, apps: ownedApps }} />
            ) : (
              <EmptyState
                icon={<GitHubMark />}
                title={t(locale, "apps.emptyTitle")}
                description={canCreate ? t(locale, "apps.emptyDescription") : t(locale, "apps.installed.emptyTitle")}
                action={createAction}
              />
            )}
          </TabsContent>
          <TabsContent value="bots">
            <UsableBotsList
              locale={locale}
              bots={botsState}
              onOpenInstalled={() => onTabChange?.("installed")}
              onRetry={onRetry}
            />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}

/**
 * F1/F9: the installed tab — ONLY Apps this workspace holds an installation
 * relation to, with the plan's per-install month cell, plus one "Waiting to be
 * bound" row per pending physical installation. The empty state carries the
 * documented actions: browse the shared Apps and create one.
 */
function InstalledTab({
  locale,
  payload,
  installed,
  quotaError,
  canCreate,
  createAction,
}: {
  locale: SpaBoot["locale"];
  payload: AppsPayload;
  installed: AppsPayload["apps"];
  quotaError: boolean;
  canCreate: boolean;
  createAction: ReactNode;
}) {
  const pending = payload.pending_installations ?? [];
  const planRp = payload.month_plan_rp ?? null;
  if (installed.length === 0 && pending.length === 0) {
    return (
      <EmptyState
        icon={<GitHubMark />}
        title={t(locale, "apps.installed.emptyTitle")}
        description={t(locale, "apps.installed.emptyDescription")}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {createAction}
            {/* F9: browsing shared Apps opens the shared-APP chooser, whose
                cards are GitHub Apps selected by `scope = 'shared'`. The Bots
                tab lists bots, which is a different surface. */}
            {canCreate ? (
              <SharedAppsDialog
                locale={locale}
                sharedApps={payload.shared_apps ?? []}
                trigger={<Button variant="secondary">{t(locale, "apps.installed.browseShared")}</Button>}
              />
            ) : null}
          </div>
        }
      />
    );
  }
  const hrefOf = (appId: number): string => `${apiBase()}/apps/${appId}`;
  const columns: DataTableColumn<AppsPayload["apps"][number]>[] = [
    {
      header: t(locale, "apps.tableName"),
      cell: (app) => (
        <span className="flex items-center gap-3">
          <AppAvatar
            src={app.github_avatar_url}
            appId={app.github_app_id}
            className="h-9 w-9 shrink-0 rounded-full border border-(--border-default) object-cover"
          />
          <a
            className="text-sm font-semibold text-foreground no-underline hover:underline"
            href={hrefOf(app.github_app_id)}
            onClick={(event) => spaClick(hrefOf(app.github_app_id), event)}
          >
            {appDisplayName(app)}
          </a>
        </span>
      ),
    },
    {
      header: t(locale, "apps.tableStatus"),
      cell: (app) => {
        const pill = appStatusPill(locale, app);
        return <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>;
      },
    },
    {
      header: t(locale, "apps.tableCreator"),
      cell: (app) => <span className="text-muted-foreground">{app.created_by}</span>,
    },
    {
      header: t(locale, "bots.monthLabel"),
      cell: (app) => (
        <span className="text-muted-foreground tabular-nums" title={t(locale, "bots.monthHint")}>
          {/* F1: no chain mounted means nothing is metered — a dash, never 0. */}
          {app.month === null || app.month === undefined
            ? t(locale, "bots.monthNone")
            : app.month.owned
              ? t(locale, "bots.monthOwn", { used: app.month.used_rp })
              : quotaError
                ? t(locale, "bots.monthUnknown")
                : planRp === null
                  ? t(locale, "bots.monthNoCeiling", { used: app.month.used_rp })
                  : t(locale, "bots.monthLimit", { used: app.month.used_rp, limit: planRp })}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      {installed.length > 0 ? (
        <DataTable
          columns={columns}
          rows={installed}
          rowKey={(app) => String(app.github_app_id)}
          rowProps={(app) => ({
            className: "cursor-pointer",
            onClick: (event) => spaClick(hrefOf(app.github_app_id), event),
          })}
        />
      ) : null}
      {pending.length > 0 ? (
        <ul className="flex flex-col gap-2" data-slot="pending-installations">
          {pending.map((row) => (
            <li key={row.installation_id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {row.account_login ??
                  t(locale, "settings.installPendingUnknownAccount", { id: row.installation_id })}
                {" · "}
                <span className="text-muted-foreground">{t(locale, "settings.installPending")}</span>
              </span>
              {/* F16: the server joins the App's own display name. */}
              <span className="text-muted-foreground">{row.app_name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * "Bots I can use" (D6/D18): ONE server-ordered list — own before shared, name
 * case-insensitively, id as tie-break; a filter only HIDES rows and never
 * reorders them. Membership is exclusive, the filter is in-memory only (a
 * reload or tab switch returns to All), and F5 keys the access word on this
 * viewer's MANAGE permission, not the bot's publication scope.
 */
export type BotsFilter = "all" | "mine" | "shared";

export function UsableBotsList({
  locale,
  bots,
  onOpenInstalled,
  onRetry,
}: {
  locale: SpaBoot["locale"];
  bots: BotsReadState;
  onOpenInstalled?: () => void;
  onRetry?: () => void;
}) {
  const [filter, setFilter] = useState<BotsFilter>("all");
  if (bots.kind === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }
  // F3: a failed read is an error with a retry — never "no bot available".
  if (bots.kind === "error") {
    return <ErrorState locale={locale} message={bots.message} onRetry={onRetry} />;
  }
  const payload = bots.payload;
  if (payload.bots.length === 0) {
    return (
      <EmptyState
        icon={<GitHubMark />}
        title={t(locale, "apps.bots.emptyTitle")}
        description={t(locale, "apps.bots.emptyDescription")}
        action={
          onOpenInstalled ? (
            <Button variant="secondary" onClick={onOpenInstalled}>
              {t(locale, "apps.bots.goInstalled")}
            </Button>
          ) : undefined
        }
      />
    );
  }
  const rows = payload.bots.filter((bot) => {
    if (filter === "mine") return bot.owned;
    if (filter === "shared") return !bot.owned;
    return true;
  });
  const hrefOf = (botId: string): string => `${apiBase()}/bots/${encodeURIComponent(botId)}`;
  const columns: DataTableColumn<(typeof payload.bots)[number]>[] = [
    {
      header: t(locale, "apps.bots.columnName"),
      cell: (bot) => (
        <span className="flex items-center gap-2">
          <a
            className="text-sm font-semibold text-foreground no-underline hover:underline"
            href={hrefOf(bot.id)}
            onClick={(event) => spaClick(hrefOf(bot.id), event)}
          >
            {bot.name}
          </a>
          <span className="text-xs text-muted-foreground">
            {t(locale, bot.owned ? "apps.bots.tagMine" : "apps.bots.tagShared")}
          </span>
        </span>
      ),
    },
    {
      header: t(locale, "apps.bots.columnOwner"),
      cell: (bot) => <span className="text-muted-foreground">{bot.workspace_name}</span>,
    },
    {
      header: t(locale, "apps.bots.columnMultiplier"),
      cell: (bot) => <span className="tabular-nums">×{bot.multiplier}</span>,
    },
    {
      header: t(locale, "bots.monthLabel"),
      cell: (bot) => (
        <span className="text-muted-foreground tabular-nums" title={t(locale, "bots.monthHint")}>
          {bot.owned
            ? t(locale, "bots.monthOwn", { used: bot.month_used_rp })
            : payload.plan_monthly_rp === null
              ? t(locale, "bots.monthNoCeiling", { used: bot.month_used_rp })
              : t(locale, "bots.monthLimit", { used: bot.month_used_rp, limit: payload.plan_monthly_rp })}
        </span>
      ),
    },
    {
      header: t(locale, "apps.bots.columnAccess"),
      cell: (bot) => (
        <span className="text-muted-foreground">
          {t(locale, bot.can_manage ? "apps.bots.editable" : "apps.bots.readOnly")}
        </span>
      ),
    },
  ];
  const filters: Array<{
    id: BotsFilter;
    key: "apps.bots.filterAll" | "apps.bots.filterMine" | "apps.bots.filterShared";
  }> = [
    { id: "all", key: "apps.bots.filterAll" },
    { id: "mine", key: "apps.bots.filterMine" },
    { id: "shared", key: "apps.bots.filterShared" },
  ];
  const empty =
    filter !== "all" && rows.length === 0
      ? filter === "mine"
        ? {
            title: t(locale, "apps.bots.emptyMineTitle"),
            description: t(locale, "apps.bots.emptyMineDescription"),
          }
        : {
            title: t(locale, "apps.bots.emptySharedTitle"),
            description: t(locale, "apps.bots.emptySharedDescription"),
          }
      : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2" data-slot="bots-filter">
        {filters.map((entry) => (
          <Button
            key={entry.id}
            variant={filter === entry.id ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilter(entry.id)}
          >
            {t(locale, entry.key)}
          </Button>
        ))}
      </div>
      {empty ? (
        <EmptyState
          icon={<GitHubMark />}
          title={empty.title}
          description={empty.description}
          action={
            <Button variant="secondary" onClick={() => setFilter("all")}>
              {t(locale, "apps.bots.clearFilter")}
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(bot) => bot.id}
          rowProps={(bot) => ({
            className: "cursor-pointer",
            onClick: (event) => spaClick(hrefOf(bot.id), event),
          })}
        />
      )}
    </div>
  );
}

/**
 * F9: the Create dialog's shared-App cards (D22) carry the App's name,
 * description, owner and its capability summary, plus a GitHub Install action
 * that opens in a new tab — the dialog stays open so the reader can come back
 * and bind.
 */
/**
 * F9: the shared-APP chooser. Its cards are **GitHub Apps** with
 * `scope = 'shared'`, each showing the App's own name, description and owner
 * plus one capability line per bot its chain mounts at the owner. It never
 * selects by bot id, so a shared App without a bot still appears and a private
 * App with a same-id bot does not.
 */
export function SharedAppsDialog({
  locale,
  sharedApps,
  trigger,
}: {
  locale: SpaBoot["locale"];
  sharedApps: SharedAppCard[];
  trigger: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(locale, "apps.sharedApps.title")}</DialogTitle>
          <DialogDescription>{t(locale, "apps.sharedApps.copy")}</DialogDescription>
        </DialogHeader>
        {sharedApps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "apps.sharedApps.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-slot="shared-apps">
            {sharedApps.map((app) => {
              const installHref = appInstallHref(app.github_slug);
              return (
                <li key={app.id} className="flex flex-col gap-1 rounded-md border border-border p-3">
                  <span className="text-sm font-semibold">{app.name}</span>
                  {app.github_description ? (
                    <span className="text-sm text-muted-foreground">{app.github_description}</span>
                  ) : null}
                  {app.owner_workspace_name ? (
                    <span className="text-xs text-muted-foreground">
                      {t(locale, "apps.cardOwner", { workspace: app.owner_workspace_name })}
                    </span>
                  ) : null}
                  {app.capability ? (
                    <span className="text-xs text-muted-foreground">{app.capability}</span>
                  ) : null}
                  <span className="flex flex-wrap items-center gap-2 pt-1">
                    {installHref === null ? (
                      <span className="text-xs text-muted-foreground">{t(locale, "settings.installNoSlug")}</span>
                    ) : (
                      <Button asChild variant="secondary" size="sm">
                        <a href={installHref} target="_blank" rel="noreferrer noopener">
                          {t(locale, "apps.cardInstall")}
                        </a>
                      </Button>
                    )}
                    <span className="text-xs text-muted-foreground">{t(locale, "apps.installReturnHint")}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t(locale, "common.cancel")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function CreateAppChooser({
  locale,
  canCreate,
  reason,
  sharedBots,
  monthPlanRp,
}: {
  locale: SpaBoot["locale"];
  canCreate: boolean;
  reason: string;
  sharedBots: SharedBotRow[];
  monthPlanRp: number | null;
}) {
  const addHref = `${apiBase()}/repos`;
  void monthPlanRp;
  return (
    <div className="flex flex-wrap items-center gap-2" data-slot="create-app-chooser">
      <Dialog>
        <DialogTrigger asChild>
          <Button disabled={!canCreate}>{t(locale, "apps.create")}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(locale, "apps.createDialog.title")}</DialogTitle>
            <DialogDescription>{t(locale, "apps.createDialog.description")}</DialogDescription>
          </DialogHeader>
          {sharedBots.length > 0 ? (
            <ul className="flex flex-col gap-3" data-slot="shared-bots">
              {sharedBots.map((bot) => {
                const installHref = appInstallHref(bot.github_slug);
                return (
                  <li key={bot.id} className="flex flex-col gap-1 rounded-md border border-border p-3">
                    <span className="text-sm font-semibold">{bot.name}</span>
                    {bot.github_description ? (
                      <span className="text-sm text-muted-foreground">{bot.github_description}</span>
                    ) : null}
                    {bot.owner_workspace_name ? (
                      <span className="text-xs text-muted-foreground">
                        {t(locale, "apps.cardOwner", { workspace: bot.owner_workspace_name })}
                      </span>
                    ) : null}
                    {bot.capability ? (
                      <span className="text-xs text-muted-foreground">
                        {t(locale, "bots.capabilityDefaultChain", { models: bot.capability })}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-2 pt-1">
                      {installHref === null ? (
                        <span className="text-xs text-muted-foreground">{t(locale, "settings.installNoSlug")}</span>
                      ) : (
                        <Button asChild variant="secondary" size="sm">
                          <a href={installHref} target="_blank" rel="noreferrer noopener">
                            {t(locale, "apps.cardInstall")}
                          </a>
                        </Button>
                      )}
                      <span className="text-xs text-muted-foreground">{t(locale, "apps.installReturnHint")}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t(locale, "apps.createDialog.noSharedBots")}</p>
          )}
          <DialogFooter>
            <form method="post" action={`${apiBase()}/manifest/start`}>
              <Button type="submit" variant="outline">
                {t(locale, "apps.createDialog.selfHostedSubmit")}
              </Button>
            </form>
            <Button asChild>
              <a href={addHref} onClick={(event) => spaClick(addHref, event)}>
                {t(locale, "targets.add")}
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {canCreate ? null : <p className="text-sm text-muted-foreground">{reason}</p>}
    </div>
  );
}

/**
 * One App row — exported so its links are asserted on rendered markup.
 * `detailSegment` picks the surface a row opens: the App detail (`apps`) on
 * the Apps page, the target detail (`targets`) on the review-target surface.
 */
export function AppsList({
  locale,
  payload,
  detailSegment = "apps",
}: {
  locale: SpaBoot["locale"];
  payload: AppsPayload;
  detailSegment?: "apps" | "targets";
}) {
  const hrefOf = (appId: number): string => `${apiBase()}/${detailSegment}/${appId}`;

  const columns: DataTableColumn<AppsPayload["apps"][number]>[] = [
    {
      header: t(locale, "apps.tableName"),
      cell: (app) => (
        <div className="flex items-center gap-3">
          <AppAvatar
            src={app.github_avatar_url}
            appId={app.github_app_id}
            className="h-9 w-9 shrink-0 rounded-full border border-(--border-default) object-cover"
          />
          <div className="flex flex-col gap-0.5">
            <a
              className="text-sm font-semibold text-foreground no-underline hover:underline"
              href={hrefOf(app.github_app_id)}
              aria-label={t(locale, "apps.openAria", { name: appDisplayName(app) })}
              onClick={(event) => spaClick(hrefOf(app.github_app_id), event)}
            >
              {appDisplayName(app)}
            </a>
            <span className="text-xs text-muted-foreground tabular-nums">
              {t(locale, "apps.appId", { id: app.github_app_id })}
            </span>
          </div>
        </div>
      ),
    },
    {
      header: t(locale, "apps.tableStatus"),
      cell: (app) => {
        const pill = appStatusPill(locale, app);
        return <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>;
      },
    },
    {
      header: t(locale, "apps.tableHealth"),
      cell: (app) => {
        const latest = app.health.latest;
        return (
          <span className="text-muted-foreground tabular-nums">
            {latest
              ? t(locale, "apps.health.delivery", { time: formatRelativeTime(latest.created_at, locale) })
              : t(locale, "apps.health.deliveryNever")}
            {latest ? ` · ${deliveryOutcomeLabel(latest.outcome, locale)}` : ""}
            {app.health.rejected24h > 0 ? (
              <>
                {" · "}
                <span className="text-(--tone-danger-fg)">
                  {t(locale, "apps.health.rejected24h", { count: app.health.rejected24h })}
                </span>
              </>
            ) : null}
          </span>
        );
      },
    },
    {
      header: t(locale, "apps.tableCreator"),
      cell: (app) => <span className="text-muted-foreground">{app.created_by}</span>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={payload.apps}
      rowKey={(app) => String(app.github_app_id)}
      rowProps={(app) => ({
        className: "cursor-pointer",
        onClick: (event) => spaClick(hrefOf(app.github_app_id), event),
      })}
    />
  );
}
