/**
 * The Apps page (D6/D8/D22/D25): ONE list surface split into three
 * URL-addressable tabs.
 *
 * - `installed` — Apps this workspace holds an INSTALL STATE for (D43), plus one
 *   "Waiting to be bound" row per pending physical installation. Membership is
 *   the state, never a target or a physical installation: those are what the
 *   state is an aggregate over.
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
import { fetchJson, postForm } from "../api";
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
  formatCredits,
  parseApps,
  parseUsableBots,
  reviewEnabled,
  type AppsPayload,
  type PendingBindRow,
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

/**
 * One 本月已用 figure in Credits (ADR: RP never renders). The ceiling state
 * rides the same string: 不限（自有机器人）for an all-own chain, 不限 for a
 * known-unlimited plan, `已用 / 上限` otherwise. An unknown ceiling is the
 * error marker, never "no ceiling" (F10).
 *
 * `rpPerCredit` is the payload's own rate. The 1,000 fallback inside
 * {@link formatCredits} applies ONLY when the profile was unreadable and the
 * server omitted the field — never because this surface forgot to pass it.
 */
function monthSpendCell(
  locale: SpaBoot["locale"],
  month: { used_rp: number; owned: boolean } | null,
  quotaError: boolean,
  planRp: number | null,
  rpPerCredit?: number,
): string {
  if (month === null) return t(locale, "bots.monthNone");
  // The bare two-decimal figure, for dictionary strings that carry their own unit.
  const used = formatCredits(month.used_rp, rpPerCredit).slice(0, -" Credits".length);
  if (month.owned) return t(locale, "credits.unlimitedOwn", { used });
  if (quotaError) return t(locale, "bots.monthUnknown");
  if (planRp === null) return t(locale, "credits.noCeiling", { used });
  return `${formatCredits(month.used_rp, rpPerCredit)} / ${formatCredits(planRp, rpPerCredit)}`;
}

/** The list's pending-bind flow, threaded from the stateful page. */
export type PendingBindFlow = {
  binding: boolean;
  failed: boolean;
  onBind: (row: PendingBindRow) => void;
};

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

  // The pending row's bind action — the same flow the App settings install
  // block runs: POST the bind, follow the authorize redirect when GitHub must
  // verify the installer, else reload the list.
  const [binding, setBinding] = useState<number | null>(null);
  const [bindFailed, setBindFailed] = useState(false);
  const bindPendingInstallation = useCallback(
    async (row: PendingBindRow): Promise<void> => {
      setBinding(row.installation_id);
      setBindFailed(false);
      try {
        const res = await postForm(`${base}/api/apps/${row.app_github_app_id}/bind-installation`, {
          installationId: String(row.installation_id),
        });
        if (res.status !== 200) {
          setBindFailed(true);
          return;
        }
        const body = JSON.parse(res.body) as { authorize_url?: unknown };
        if (typeof body.authorize_url === "string") {
          window.location.assign(body.authorize_url);
          return;
        }
        await load();
      } catch {
        setBindFailed(true);
      } finally {
        setBinding(null);
      }
    },
    [base, load],
  );

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
      pendingBind={{
        binding: binding !== null,
        failed: bindFailed,
        onBind: (row) => void bindPendingInstallation(row),
      }}
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
  pendingBind,
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
  /** The pending rows' bind flow; absent in static renders. */
  pendingBind?: PendingBindFlow;
}) {
  const appsState: AppsReadState =
    apps ?? (state === "error" ? { kind: "error", message: t(locale, "common.loadFailed") } : state === "ok" && payload ? { kind: "ok", payload } : { kind: "error", message: t(locale, "common.loadFailed") });
  const botsState: BotsReadState = bots ?? { kind: "loading" };
  const loaded = appsState.kind === "ok" ? appsState.payload : null;
  const installed = loaded ? installedAppsOf(loaded) : [];
  const ownedApps = loaded?.apps.filter((app) => app.owned !== false) ?? [];
  const hasCreated = ownedApps.length > 0;
  const activeTab: AppsTab = tab ?? (installed.length > 0 ? "installed" : "created");
  // Apps this workspace already installed are never offered for install again.
  const installedAppIds: ReadonlySet<string> = new Set(
    installed.map((app) => app.bot_id).filter((id): id is string => id !== undefined),
  );
  const createAction = (
    <CreateAppChooser
      locale={locale}
      canCreate={canCreate}
      reason={unavailableReason}
      /* F9: the chooser's ONE source is `shared_apps` — scope-filtered GitHub
         Apps. `shared_bots` is the bot face (review-usage) and no App chooser
         may read it. */
      sharedApps={loaded?.shared_apps ?? []}
      installedAppIds={installedAppIds}
    />
  );

  // The ADR bans a 24h rejection figure on every surface — the band carries
  // the three remaining payload-proved facts.
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
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "apps.heading")}
        description={t(locale, "apps.headingDescription")}
        actions={createAction}
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
              pendingBind={pendingBind}
            />
          </TabsContent>
          <TabsContent value="created">
            {hasCreated ? (
              <AppsList locale={locale} payload={{ ...loaded, apps: ownedApps }} origin="created" />
            ) : (
              // The header carries the ONE create control; the guidance only
              // explains it.
              <EmptyState
                icon={<GitHubMark />}
                title={t(locale, "apps.emptyTitle")}
                description={canCreate ? t(locale, "apps.emptyDescription") : t(locale, "apps.installed.emptyTitle")}
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
 * relation to. A pending physical installation renders INSIDE its App's row
 * (never a detached list under the table): the account, the 等待绑定 state and
 * the bind action. A pending row whose App has no installed row yet (a shared
 * App installed on GitHub but never bound) gets its own row in the same
 * table, named by the server-joined App name (F16). The empty state carries
 * only the shared-App browse action: the create control lives in the header.
 */
function InstalledTab({
  locale,
  payload,
  installed,
  quotaError,
  canCreate,
  pendingBind,
}: {
  locale: SpaBoot["locale"];
  payload: AppsPayload;
  installed: AppsPayload["apps"];
  quotaError: boolean;
  canCreate: boolean;
  pendingBind?: PendingBindFlow;
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
          canCreate ? (
            // F9: browsing shared Apps opens the shared-APP chooser, whose
            // cards are GitHub Apps selected by `scope = 'shared'`. The Bots
            // tab lists bots, which is a different surface. The create control
            // itself lives in the page header only — one entry per state.
            <SharedAppsDialog
              locale={locale}
              sharedApps={payload.shared_apps ?? []}
              trigger={<Button variant="secondary">{t(locale, "apps.installed.browseShared")}</Button>}
            />
          ) : undefined
        }
      />
    );
  }
  // The origin rides every detail link: the App detail reads `from` to pick
  // the installed face (ADR: two origins, two faces).
  const hrefOf = (appId: number): string => `${apiBase()}/apps/${appId}?from=installed`;
  const installedIds = new Set(installed.map((app) => app.github_app_id));
  const rows: InstalledRow[] = [
    ...installed.map((app) => ({
      kind: "app" as const,
      app,
      pending: pending.filter((row) => row.app_github_app_id === app.github_app_id),
    })),
    ...pending
      .filter((row) => !installedIds.has(row.app_github_app_id))
      .map((row) => ({ kind: "pending" as const, pending: row })),
  ];
  const dash = <span className="text-muted-foreground">{t(locale, "bots.monthNone")}</span>;
  const columns: DataTableColumn<InstalledRow>[] = [
    {
      header: t(locale, "apps.tableName"),
      cell: (row) => (
        <div className="flex flex-col gap-2">
          {row.kind === "app" ? (
            <span className="flex items-center gap-3">
              <AppAvatar
                src={row.app.github_avatar_url}
                appId={row.app.github_app_id}
                className="h-9 w-9 shrink-0 rounded-full border border-(--border-default) object-cover"
              />
              <a
                className="text-sm font-semibold text-foreground no-underline hover:underline"
                href={hrefOf(row.app.github_app_id)}
                onClick={(event) => spaClick(hrefOf(row.app.github_app_id), event)}
              >
                {appDisplayName(row.app)}
              </a>
            </span>
          ) : (
            <span className="text-sm font-semibold">{row.pending.app_name}</span>
          )}
          {(row.kind === "app" ? row.pending : [row.pending]).map((entry) => (
            <PendingInstallationLine key={entry.installation_id} locale={locale} pending={entry} pendingBind={pendingBind} />
          ))}
        </div>
      ),
    },
    {
      header: t(locale, "apps.tableStatus"),
      cell: (row) => {
        if (row.kind === "pending") return dash;
        const pill = appStatusPill(locale, row.app);
        return <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>;
      },
    },
    {
      header: t(locale, "apps.tableCreator"),
      cell: (row) =>
        row.kind === "app" ? <span className="text-muted-foreground">{row.app.created_by}</span> : dash,
    },
    {
      header: t(locale, "credits.usedThisMonth"),
      cell: (row) =>
        row.kind === "pending" ? (
          dash
        ) : (
          <span className="text-muted-foreground tabular-nums">
            {/* F1: no chain mounted means nothing is metered — a dash, never 0. */}
            {monthSpendCell(locale, row.app.month ?? null, quotaError, planRp, payload.rp_per_credit)}
          </span>
        ),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => (row.kind === "app" ? `app-${row.app.github_app_id}` : `pending-${row.pending.installation_id}`)}
        rowProps={(row) =>
          row.kind === "app"
            ? {
                className: "cursor-pointer",
                onClick: (event) => spaClick(hrefOf(row.app.github_app_id), event),
              }
            : {}
        }
      />
      {pendingBind?.failed ? (
        <p role="status" className="text-sm text-(--tone-warn-fg)">
          {t(locale, "settings.installBindFailed")}
        </p>
      ) : null}
    </div>
  );
}

/** One table row of the installed tab: an installed App, or a pending installation whose App has no row yet. */
type InstalledRow =
  | { kind: "app"; app: AppsPayload["apps"][number]; pending: PendingBindRow[] }
  | { kind: "pending"; pending: PendingBindRow };

/**
 * One pending installation attached to its App's row: the account GitHub
 * reported (or the unknown-account stand-in), the 等待绑定 state, and the bind
 * action that starts the authorize flow.
 */
function PendingInstallationLine({
  locale,
  pending,
  pendingBind,
}: {
  locale: SpaBoot["locale"];
  pending: PendingBindRow;
  pendingBind?: PendingBindFlow;
}) {
  return (
    <span
      data-slot="pending-installation"
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>
        {pending.account_login ??
          t(locale, "settings.installPendingUnknownAccount", { id: pending.installation_id })}
      </span>
      <StatusBadge tone="warn">{t(locale, "settings.installPending")}</StatusBadge>
      <span>{t(locale, "apps.installReturnHint")}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pendingBind?.binding === true}
        onClick={(event) => {
          // The row around this control opens the App detail; a bind click must
          // start the authorize flow, not navigate away while it is in flight.
          event.stopPropagation();
          pendingBind?.onBind(pending);
        }}
      >
        {t(locale, "settings.installPendingBind")}
      </Button>
    </span>
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
      header: t(locale, "credits.usedThisMonth"),
      cell: (bot) => (
        <span className="text-muted-foreground tabular-nums">
          {/* F10: an unknown ceiling is an error, never "no ceiling". */}
          {monthSpendCell(
            locale,
            { used_rp: bot.month_used_rp, owned: bot.owned },
            payload.quota_error === true,
            payload.plan_monthly_rp,
            payload.rp_per_credit,
          )}
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


/**
 * The ONE create action (ADR + prototype): the dialog is titled 创建 GitHub App
 * and its primary action is the manifest `POST {base}/manifest/start`; 使用平台
 * 共享的 App is the secondary path below it. An App this workspace already
 * installed is never offered for install again — no install action, no
 * bind-after-install hint.
 */
function CreateAppChooser({
  locale,
  canCreate,
  reason,
  sharedApps,
  installedAppIds,
}: {
  locale: SpaBoot["locale"];
  canCreate: boolean;
  reason: string;
  sharedApps: SharedAppCard[];
  /** Local ids of the Apps this workspace already installed. */
  installedAppIds: ReadonlySet<string>;
}) {
  const choices = sharedApps.filter((app) => !installedAppIds.has(app.id));
  return (
    <div className="flex flex-wrap items-center gap-2" data-slot="create-app-chooser">
      <Dialog>
        <DialogTrigger asChild>
          <Button disabled={!canCreate}>{t(locale, "apps.create")}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(locale, "apps.createDialog.githubTitle")}</DialogTitle>
            <DialogDescription>{t(locale, "apps.createDialog.description")}</DialogDescription>
          </DialogHeader>
          <form method="post" action={`${apiBase()}/manifest/start`}>
            <Button type="submit">{t(locale, "apps.createDialog.selfHostedSubmit")}</Button>
          </form>
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <h3 className="text-sm font-semibold">{t(locale, "apps.createDialog.shared")}</h3>
            {choices.length > 0 ? (
              <ul className="flex flex-col gap-3" data-slot="shared-apps">
                {choices.map((app) => {
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
            ) : (
              <p className="text-sm text-muted-foreground">{t(locale, "apps.createDialog.noSharedBots")}</p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t(locale, "common.cancel")}</Button>
            </DialogClose>
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
  origin,
}: {
  locale: SpaBoot["locale"];
  payload: AppsPayload;
  detailSegment?: "apps" | "targets";
  /** The list the reader came from — recorded on the detail link so the App
   * detail opens the matching face (ADR: two origins, two faces). */
  origin?: "installed" | "created";
}) {
  const hrefOf = (appId: number): string =>
    `${apiBase()}/${detailSegment}/${appId}${origin === undefined ? "" : `?from=${origin}`}`;

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
        // The ADR bans a 24h rejection figure on every list.
        return (
          <span className="text-muted-foreground tabular-nums">
            {latest
              ? t(locale, "apps.health.delivery", { time: formatRelativeTime(latest.created_at, locale) })
              : t(locale, "apps.health.deliveryNever")}
            {latest ? ` · ${deliveryOutcomeLabel(latest.outcome, locale)}` : ""}
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
