import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
import { Button, StatusBadge } from "@design-system";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { MetricBand } from "@/components/MetricBand";
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
import { appDisplayName, appStatusPill, parseApps, reviewEnabled, type AppsPayload } from "./data";
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

export function AppsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<AppsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  // Read per render (the MembersPage precedent): the switcher navigates with
  // pushState + popstate, so no new document re-injects the boot — the page
  // base must track the URL it is actually on.
  const base = apiBase();
  const canCreate = canCreateAppFor(boot, base === "/dashboard" ? null : base.slice("/dashboard/".length));
  const unavailableReason =
    boot.workspaceRequired === true
      ? t(locale, "apps.createUnavailable.workspace")
      : t(locale, "apps.createUnavailable.role");

  const load = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const parsed = await loadApps(base);
      if (!parsed) {
        setState("error");
        return;
      }
      setPayload(parsed);
      setState("ok");
    } catch {
      setState("error");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // Loading rides the shared skeleton as the page's full loading face —
  // the component's heading placeholder stands in for the real h1 (AD-582).
  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }

  return (
    <AppsView
      locale={locale}
      state={state}
      payload={payload}
      canCreate={canCreate}
      unavailableReason={unavailableReason}
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
  canCreate,
  unavailableReason,
  onRetry,
}: {
  locale: SpaBoot["locale"];
  state: "ok" | "error";
  payload: AppsPayload | null;
  canCreate: boolean;
  unavailableReason: string;
  onRetry: () => void;
}) {
  const appsEmpty = state === "ok" && payload !== null && payload.apps.length === 0;
  const createAction = <CreateAppButton locale={locale} canCreate={canCreate} reason={unavailableReason} />;

  // The metric band is payload arithmetic only — four figures `AppsPayload`
  // can prove. An installation or repository count is not on that payload, so
  // it can never join them (compass D13). "Enabled" is the status axis the
  // App's own enable/disable actions name; a paused App is enabled but not
  // reviewing, so the pause axis gets its own count instead of joining it.
  // Both axes read the payload through `data.ts`'s normalization, never a
  // second copy of the wire rule.
  const metrics =
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
            value: payload.apps.reduce((total, app) => total + app.health.rejected24h, 0),
          },
        ]
      : [];

  return (
    <div className="flex flex-col gap-6">
      {/* One create-form instance on the page: while the empty state
          carries the action, the header yields its slot to it. */}
      <PageHeader
        title={t(locale, "apps.heading")}
        description={t(locale, "apps.headingDescription")}
        actions={appsEmpty ? null : createAction}
        metrics={<MetricBand metrics={metrics} />}
      />
      {state === "error" ? <ErrorState locale={locale} onRetry={onRetry} /> : null}
      {state === "ok" && payload ? (
        appsEmpty ? (
          // Composed first-App guidance: the action reuses the exact
          // CreateAppButton form — creation is still the only path. The card
          // keeps the honest "no Apps yet" line and lets the button carry the
          // unavailable reason when this caller cannot run the flow.
          <EmptyState
            icon={<GitHubMark />}
            title={t(locale, "apps.emptyTitle")}
            description={canCreate ? t(locale, "apps.emptyDescription") : undefined}
            action={createAction}
          />
        ) : (
          <AppsList locale={locale} payload={payload} />
        )
      ) : null}
    </div>
  );
}

/**
 * The Create control. It posts under the page's own workspace prefix
 * (`apiBase()`), so the flow lands the App in the workspace the user is
 * looking at — the deployment-level path is only for a single-workspace
 * deployment whose page has no ref. Unavailable creation keeps the button
 * visible but disabled, with the reason beside it: hiding the action left the
 * user with no explanation at all (QC high).
 */
function CreateAppButton({
  locale,
  canCreate,
  reason,
}: {
  locale: SpaBoot["locale"];
  canCreate: boolean;
  reason: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form method="post" action={`${apiBase()}/manifest/start`}>
        <Button type="submit" disabled={!canCreate}>
          {t(locale, "apps.create")}
        </Button>
      </form>
      {canCreate ? null : <p className="text-sm text-muted-foreground">{reason}</p>}
    </div>
  );
}

/** One App row — exported so its links are asserted on rendered markup. */
export function AppsList({ locale, payload }: { locale: SpaBoot["locale"]; payload: AppsPayload }) {
  const hrefOf = (appId: number): string => `${apiBase()}/apps/${appId}`;

  const columns: DataTableColumn<AppsPayload["apps"][number]>[] = [
    {
      header: t(locale, "apps.tableName"),
      // AD-581 identity cell: the App's brand surface. The list row links
      // and keys by the immutable App id; the block is the App's GitHub
      // avatar + display name (primary line) + App id (meta line) — the
      // D6 fallback chain github_name ?? github_slug ?? String(github_app_id).
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
            {app.health.rejected24h > 0
              ? ` · ${t(locale, "apps.health.rejected24h", { count: app.health.rejected24h })}`
              : ""}
          </span>
        );
      },
    },
    {
      header: t(locale, "apps.tableCreator"),
      cell: (app) => <span className="text-muted-foreground">{app.created_by}</span>,
    },
    {
      header: t(locale, "apps.detail"),
      align: "right",
      // Visible destination: the row (and this link) open the App's detail
      // page — one workflow from list to detail.
      cell: (app) => (
        <a
          className="text-primary underline-offset-4 hover:underline"
          href={hrefOf(app.github_app_id)}
          onClick={(event) => spaClick(hrefOf(app.github_app_id), event)}
        >
          {t(locale, "apps.detail")}
        </a>
      ),
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
