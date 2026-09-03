import { useEffect, useRef, useState, type MouseEvent } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { matchSpaRoute } from "../routes";
import { navigate } from "../router";
import { parseApps, type AppsPayload } from "./data";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "apps.heading")}</h1>
        <CreateAppButton locale={locale} />
      </div>
      {state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {state === "error" ? <LoadFailedNotice locale={locale} /> : null}
      {state === "ok" && payload ? <AppsList locale={locale} payload={payload} /> : null}
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

function spaClick(href: string, event: MouseEvent): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!matchSpaRoute(href)) return;
  event.preventDefault();
  navigate(href);
}

function AppsList({ locale, payload }: { locale: SpaBoot["locale"]; payload: AppsPayload }) {
  if (payload.apps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t(locale, "apps.empty")}</p>
    );
  }
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(locale, "apps.tableName")}</TableHead>
            <TableHead>{t(locale, "apps.tableStatus")}</TableHead>
            <TableHead>{t(locale, "apps.tableHealth")}</TableHead>
            <TableHead>{t(locale, "apps.tableCreator")}</TableHead>
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
                <TableCell className="font-medium">
                  <a
                    className="text-foreground no-underline hover:underline"
                    href={href}
                    aria-label={t(locale, "apps.openAria", { slug: app.slug })}
                    onClick={(event) => spaClick(href, event)}
                  >
                    {app.slug}
                  </a>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {t(locale, "apps.appId", { id: app.github_app_id })}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge locale={locale} status={app.status} reviewEnabled={app.review_enabled} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {latest
                    ? t(locale, "apps.health.delivery", { time: formatRelativeTime(latest.created_at, locale) })
                    : t(locale, "apps.health.deliveryNever")}
                  {latest ? ` · ${latest.outcome}` : ""}
                  {app.health.rejected24h > 0
                    ? ` · ${t(locale, "apps.health.rejected24h", { count: app.health.rejected24h })}`
                    : ""}
                </TableCell>
                <TableCell className="text-muted-foreground">{app.created_by}</TableCell>
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
  const enabled = typeof reviewEnabled === "boolean" ? reviewEnabled : reviewEnabled !== 0;
  const paused = status === "active" && !enabled;
  const kind = status === "disabled" ? "warn" : paused ? "warn" : "success";
  const label =
    status === "disabled"
      ? t(locale, "apps.status.disabled")
      : paused
        ? t(locale, "apps.status.paused")
        : t(locale, "apps.status.active");
  const tone =
    kind === "success"
      ? "bg-[var(--badge-success-bg)] text-[var(--badge-success-fg)]"
      : "bg-[var(--badge-warn-bg)] text-[var(--badge-warn-fg)]";
  return (
    <span className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ${tone}`}>{label}</span>
  );
}

export { StatusBadge };
