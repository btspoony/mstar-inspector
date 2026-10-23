import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { deliveryOutcomeLabel } from "../delivery-outcome";
import { formatRelativeTime } from "../relative-time";
import { spaClick } from "../spa-click";
import { isPaused, parseApps, type AppsPayload } from "./data";
import { GitHubMark } from "./LoginPage";
import { apiBase } from "../workspace-base";

/** DESIGN.md Table: header band on background-200, headers at label-12
    (12px; the primitive's font-medium supplies the 500 weight). */
const TABLE_HEADER = "bg-(--background-200)";
const TABLE_HEAD_LABEL = "text-xs tracking-(--typo-label-12-tracking)";

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
          {t(locale, "apps.heading")}
        </h1>
        {/* One create-form instance on the page: while the empty state
            carries the action, the header yields its slot to it. */}
        {!appsEmpty ? createAction : null}
      </div>
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
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader className={TABLE_HEADER}>
          <TableRow className="hover:bg-inherit">
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableName")}</TableHead>
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableStatus")}</TableHead>
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableHealth")}</TableHead>
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableCreator")}</TableHead>
            <TableHead className={`text-right ${TABLE_HEAD_LABEL}`}>{t(locale, "apps.detail")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payload.apps.map((app) => {
            const href = `${apiBase()}/apps/${app.slug}`;
            const latest = app.health.latest;
            return (
              <TableRow
                key={app.slug}
                className="cursor-pointer"
                onClick={(event) => spaClick(href, event)}
              >
                {/* AD-581 identity cell: the App's brand surface. The list
                    payload carries no GitHub profile fields, so the block is
                    slug (primary line) + App id (meta line) — no avatar. */}
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <a
                      className="text-sm font-semibold text-foreground no-underline hover:underline"
                      href={href}
                      aria-label={t(locale, "apps.openAria", { slug: app.slug })}
                      onClick={(event) => spaClick(href, event)}
                    >
                      {app.slug}
                    </a>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t(locale, "apps.appId", { id: app.github_app_id })}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge locale={locale} status={app.status} reviewEnabled={app.review_enabled} />
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {latest
                    ? t(locale, "apps.health.delivery", { time: formatRelativeTime(latest.created_at, locale) })
                    : t(locale, "apps.health.deliveryNever")}
                  {latest ? ` · ${deliveryOutcomeLabel(latest.outcome, locale)}` : ""}
                  {app.health.rejected24h > 0
                    ? ` · ${t(locale, "apps.health.rejected24h", { count: app.health.rejected24h })}`
                    : ""}
                </TableCell>
                <TableCell className="text-muted-foreground">{app.created_by}</TableCell>
                <TableCell className="text-right">
                  {/* Visible destination: the row (and this link) open the
                      App's detail page — one workflow from list to detail. */}
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={href}
                    onClick={(event) => spaClick(href, event)}
                  >
                    {t(locale, "apps.detail")}
                  </a>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({
  locale,
  status,
  reviewEnabled,
}: {
  locale: SpaBoot["locale"];
  status: string;
  reviewEnabled: number | boolean;
}) {
  const paused = isPaused({ status, review_enabled: reviewEnabled });
  const kind = status === "disabled" ? "warn" : paused ? "warn" : "success";
  const label =
    status === "disabled"
      ? t(locale, "apps.status.disabled")
      : paused
        ? t(locale, "apps.status.paused")
        : t(locale, "apps.status.active");
  const tone =
    kind === "success"
      ? "bg-(--badge-success-bg) text-(--badge-success-fg)"
      : "bg-(--badge-warn-bg) text-(--badge-warn-fg)";
  return (
    <span className={`inline-flex h-(--badge-height) items-center rounded-(--badge-radius) px-2 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

export { StatusBadge };
