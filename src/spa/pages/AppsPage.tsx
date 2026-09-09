import { useEffect, useRef, useState } from "react";
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

/** DESIGN.md Table: header band on background-200, headers at label-12
    (12px; the primitive's font-medium supplies the 500 weight). */
const TABLE_HEADER = "bg-(--background-200)";
const TABLE_HEAD_LABEL = "text-xs tracking-(--typo-label-12-tracking)";

export function AppsPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [payload, setPayload] = useState<AppsPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const cancelledRef = useRef(false);

  async function load(): Promise<void> {
    setState("loading");
    try {
      const parsed = parseApps(await fetchJson("/dashboard/api/apps"));
      if (cancelledRef.current) return;
      if (!parsed) {
        setState("error");
        return;
      }
      setPayload(parsed);
      setState("ok");
    } catch {
      if (!cancelledRef.current) setState("error");
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Loading rides the plan-57 skeleton as the page's full loading face —
  // the component's heading placeholder stands in for the real h1 (AD-582).
  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }

  const appsEmpty = state === "ok" && payload !== null && payload.apps.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
          {t(locale, "apps.heading")}
        </h1>
        {/* One create-form instance on the page: while the empty state
            carries the action, the header yields its slot to it. */}
        {!appsEmpty ? <CreateAppButton locale={locale} /> : null}
      </div>
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && payload ? (
        appsEmpty ? (
          // Composed first-App guidance: the action reuses the exact
          // CreateAppButton form — creation is still the only path.
          <EmptyState
            icon={<GitHubMark />}
            title={t(locale, "apps.emptyTitle")}
            description={t(locale, "apps.emptyDescription")}
            action={<CreateAppButton locale={locale} />}
          />
        ) : (
          <AppsList locale={locale} payload={payload} />
        )
      ) : null}
    </div>
  );
}

function CreateAppButton({ locale }: { locale: SpaBoot["locale"] }) {
  return (
    <form method="post" action="/dashboard/manifest/start">
      <Button type="submit">{t(locale, "apps.create")}</Button>
    </form>
  );
}

function AppsList({ locale, payload }: { locale: SpaBoot["locale"]; payload: AppsPayload }) {
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader className={TABLE_HEADER}>
          <TableRow className="hover:bg-inherit">
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableName")}</TableHead>
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableStatus")}</TableHead>
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableHealth")}</TableHead>
            <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "apps.tableCreator")}</TableHead>
            <TableHead className={`text-right ${TABLE_HEAD_LABEL}`}>{t(locale, "apps.settings")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payload.apps.map((app) => {
            const href = `/dashboard/apps/${app.slug}/settings`;
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
                      App's settings — one workflow from list to detail. */}
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={href}
                    onClick={(event) => spaClick(href, event)}
                  >
                    {t(locale, "apps.settings")}
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
