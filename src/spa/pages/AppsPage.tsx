/**
 * The Apps page (D6/D8): ONE list surface split into three URL-addressable
 * tabs — `installed` (the workspace's live install rows plus the pending
 * binds a shared App leaves before binding), `created` (the Apps the
 * workspace owns, whose create dialog keeps this tab's action), and `bots`
 * ("Bots I can use", one server-ordered read with client-side owner filters).
 * The tab rides `?tab=` with the workspace's OWN default omitted, so a
 * shared/reload link lands on the same tab the reader left.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
import {
  Button,
  Dialog,
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
export async function loadUsableBots(base: string): Promise<UsableBotsPayload | null> {
  try {
    return parseUsableBots(await fetchJson(`${base}/api/review-bots`));
  } catch {
    return null;
  }
}

export type AppsTab = "installed" | "created" | "bots";

/**
 * The tab the URL names, or the workspace's own default (D8): `created` when
 * the workspace has created no App (nothing COULD be installed yet),
 * `installed` otherwise. An unknown value falls back to the same default —
 * it is never rendered as a selected tab that has no panel.
 */
export function appsTabOf(search: string, hasCreated: boolean): AppsTab {
  const value = new URLSearchParams(search).get("tab");
  if (value === "installed" || value === "created" || value === "bots") return value;
  return hasCreated ? "installed" : "created";
}

/** `?tab` omitted when the tab IS the default — sharing the URL reproduces the default either way. */
export function appsTabQuery(tab: AppsTab, defaultTab: AppsTab): string {
  return tab === defaultTab ? "" : `?tab=${tab}`;
}

export function AppsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<AppsPayload | null>(null);
  const [bots, setBots] = useState<UsableBotsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [tab, setTab] = useState<AppsTab>(() => appsTabOf(window.location.search, true));
  const base = apiBase();
  const canCreate = canCreateAppFor(boot, base === "/dashboard" ? null : base.slice("/dashboard/".length));
  const unavailableReason =
    boot.workspaceRequired === true
      ? t(locale, "apps.createUnavailable.workspace")
      : t(locale, "apps.createUnavailable.role");

  const load = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const [parsed, usable] = await Promise.all([loadApps(base), loadUsableBots(base)]);
      if (!parsed) {
        setState("error");
        return;
      }
      setPayload(parsed);
      setBots(usable);
      setState("ok");
      // The first read is what learns the workspace's OWN default (D8) —
      // before it, nothing can say whether a bare path means `installed` or
      // `created` — so an un-named tab settles here, once.
      if (!new URLSearchParams(window.location.search).get("tab")) {
        setTab(appsTabOf("", parsed.apps.some((app) => app.owned !== false)));
      }
    } catch {
      setState("error");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // URL-derived per the spa-url-state-resync contract: one []-mounted
  // popstate listener, writes replaceState — never popstate, so no loop.
  useEffect(() => {
    const onPop = () =>
      setTab(appsTabOf(window.location.search, payload?.apps.some((app) => app.owned !== false) ?? true));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [payload]);

  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }

  const hasCreated = payload?.apps.some((app) => app.owned !== false) ?? false;
  const defaultTab: AppsTab = hasCreated ? "installed" : "created";

  function onTabChange(next: string): void {
    if (next !== "installed" && next !== "created" && next !== "bots") return;
    window.history.replaceState(null, "", `${window.location.pathname}${appsTabQuery(next as AppsTab, defaultTab)}`);
    setTab(next as AppsTab);
  }

  return (
    <AppsView
      locale={locale}
      state={state}
      payload={payload}
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
  bots,
  canCreate,
  unavailableReason,
  tab,
  onTabChange,
  onRetry,
}: {
  locale: SpaBoot["locale"];
  state: "ok" | "error";
  payload: AppsPayload | null;
  bots?: UsableBotsPayload | null;
  canCreate: boolean;
  unavailableReason: string;
  tab?: AppsTab;
  onTabChange?: (tab: string) => void;
  onRetry: () => void;
}) {
  const ownedApps = payload?.apps.filter((app) => app.owned !== false) ?? [];
  const hasCreated = ownedApps.length > 0;
  // The view's tab follows the page's own default when the caller passes
  // none: `created` before the workspace owns an App, `installed` after.
  const activeTab: AppsTab = tab ?? (hasCreated ? "installed" : "created");
  const createAction = (
    <CreateAppChooser
      locale={locale}
      canCreate={canCreate}
      reason={unavailableReason}
      sharedBots={payload?.shared_bots ?? []}
    />
  );

  const rejected24h =
    state === "ok" && payload
      ? payload.apps.reduce((total, app) => total + app.health.rejected24h, 0)
      : 0;
  const metrics: Metric[] =
    state === "ok" && payload
      ? [
          { key: t(locale, "apps.metricApps"), value: payload.apps.length },
          {
            key: t(locale, "apps.metricEnabled"),
            value: payload.apps.filter((app) => app.status !== "disabled").length,
          },
          {
            key: t(locale, "apps.metricReviewOff"),
            value: payload.apps.filter((app) => !reviewEnabled(app)).length,
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
      {state === "error" ? <ErrorState locale={locale} onRetry={onRetry} /> : null}
      {state === "ok" && payload ? (
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
            <InstalledTab locale={locale} payload={payload} />
          </TabsContent>
          <TabsContent value="created">
            {hasCreated ? (
              <AppsList locale={locale} payload={{ ...payload, apps: ownedApps }} />
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
              bots={bots ?? null}
              onOpenInstalled={() => onTabChange?.("installed")}
            />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}

/**
 * The installed tab: ONE list of the workspace's live install rows — today
 * every consumable App row, merged with the pending binds the server reads
 * off the physical installation table (D8). The install-state rows the chain
 * tables will hold join here when install-state-chain's writers land; until
 * then the read honestly answers what exists.
 */
function InstalledTab({ locale, payload }: { locale: SpaBoot["locale"]; payload: AppsPayload }) {
  const pending = payload.pending_installations ?? [];
  const appNameOf = (appId: string): string => {
    const numeric = /^[0-9]+$/.test(appId) ? Number(appId) : null;
    const row = numeric === null ? undefined : payload.apps.find((app) => app.github_app_id === numeric);
    return row ? appDisplayName(row) : appId;
  };
  if (payload.apps.length === 0 && pending.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">{t(locale, "apps.installed.emptyTitle")}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {payload.apps.length > 0 ? <AppsList locale={locale} payload={payload} /> : null}
      {pending.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {pending.map((row) => (
            <li key={row.installation_id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {row.account_login ?? t(locale, "settings.installPendingUnknownAccount", { id: row.installation_id })}
                {" · "}
                <span className="text-muted-foreground">{t(locale, "settings.installPending")}</span>
              </span>
              <span className="text-muted-foreground">{appNameOf(row.app_id)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * "Bots I can use" (D6/D18): ONE server-ordered list — the server answers
 * own-before-shared, name-insensitive, id as tie-break; a filter only HIDES
 * rows and never reorders them. Membership is exclusive (own wins when the
 * bot's workspace is the caller's), and the filter is in-memory only — a
 * reload or a tab switch returns to All. No App column: the bot list is the
 * universe of usable bots, not a per-App chain.
 */
export type BotsFilter = "all" | "mine" | "shared";

export function UsableBotsList({
  locale,
  bots,
  onOpenInstalled,
}: {
  locale: SpaBoot["locale"];
  bots: UsableBotsPayload | null;
  onOpenInstalled?: () => void;
}) {
  const [filter, setFilter] = useState<BotsFilter>("all");
  if (bots === null || bots.bots.length === 0) {
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
  const rows = bots.bots.filter((bot) => {
    if (filter === "mine") return bot.owned;
    if (filter === "shared") return !bot.owned;
    return true;
  });
  const hrefOf = (botId: string): string => `${apiBase()}/bots/${encodeURIComponent(botId)}`;
  const columns: DataTableColumn<(typeof bots.bots)[number]>[] = [
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
            : bots.plan_monthly_rp === null
              ? t(locale, "bots.monthNoCeiling", { used: bot.month_used_rp })
              : t(locale, "bots.monthLimit", { used: bot.month_used_rp, limit: bots.plan_monthly_rp })}
        </span>
      ),
    },
    {
      header: t(locale, "apps.bots.columnAccess"),
      cell: (bot) => (
        <span className="text-muted-foreground">
          {t(locale, bot.owned ? "apps.bots.editable" : "apps.bots.readOnly")}
        </span>
      ),
    },
  ];
  const filters: Array<{ id: BotsFilter; key: "apps.bots.filterAll" | "apps.bots.filterMine" | "apps.bots.filterShared" }> = [
    { id: "all", key: "apps.bots.filterAll" },
    { id: "mine", key: "apps.bots.filterMine" },
    { id: "shared", key: "apps.bots.filterShared" },
  ];
  const emptyFor = (): { title: string; description: string } =>
    filter === "mine"
      ? {
          title: t(locale, "apps.bots.emptyMineTitle"),
          description: t(locale, "apps.bots.emptyMineDescription"),
        }
      : {
          title: t(locale, "apps.bots.emptySharedTitle"),
          description: t(locale, "apps.bots.emptySharedDescription"),
        };
  const empty = filter !== "all" && rows.length === 0 ? emptyFor() : null;
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

function CreateAppChooser({
  locale,
  canCreate,
  reason,
  sharedBots,
}: {
  locale: SpaBoot["locale"];
  canCreate: boolean;
  reason: string;
  sharedBots: SharedBotRow[];
}) {
  const addHref = `${apiBase()}/repos`;
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
          <p className="text-sm text-muted-foreground">{t(locale, "targets.addDialog.description")}</p>
          {sharedBots.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground" data-slot="shared-bots">
              {sharedBots.map((bot) => (
                <li key={bot.id}>
                  {t(locale, "apps.createDialog.botTargets", {
                    name: bot.name === "" ? bot.id : bot.name,
                    count: bot.target_count,
                  })}
                </li>
              ))}
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
