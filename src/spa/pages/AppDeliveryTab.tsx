import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { t } from "../../i18n";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { deliveryOutcomeLabel } from "../delivery-outcome";
import { formatRelativeTime } from "../relative-time";
import { apiBase } from "../workspace-base";
import {
  DELIVERY_PAGE_SIZE,
  appDeliveriesUrl,
  parseDeliveryPage,
  type DeliveryFilters,
  type DeliveryStatusPage,
  type DeliveryStatusRow,
} from "./data";

/**
 * note: The 投递状态 tab of an App detail page: the bot's webhook deliveries — what
 * arrived, from which repository, of which type, what happened, and why it was
 * refused.
 *
 * Two faces in one module: the stateful tab (filters, paging, the read) and the
 * pure view it paints, so the table and the filter row are assertable without a
 * DOM runner. Filters and paging are REQUEST parameters — the server narrows
 * and pages before answering — so no frame hides rows it already holds (the PR
 * ledger's own rule).
 */

/** The window segments the tab offers, in whole days; "all" is the whole history. */
export const DELIVERY_WINDOWS = ["1", "7", "30", "90"] as const;

const EMPTY_FILTERS: DeliveryFilters = { repo: "", since: "", type: "" };

/** note: The "no filter" sentinel: the Select primitive refuses "" as an item value. */
const ALL = "all";

/** The last-verified line the credentials panel used to carry, now this tab's. */
export type DeliverySummaryLine = {
  last_webhook_at: string | null;
  rejected24h: number;
};

export function AppDeliveryTab({
  locale,
  appId,
  summary,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  summary: DeliverySummaryLine;
}) {
  const [filters, setFilters] = useState<DeliveryFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<DeliveryStatusPage | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchJson(appDeliveriesUrl(apiBase(), appId, filters, offset))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseDeliveryPage(raw);
        if (parsed === null) {
          setState("error");
          return;
        }
        setPage(parsed);
        setState("ok");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [appId, filters, offset, reloadNonce]);

  /** why: A filter change resets to the first page: page 3 of the old filter addresses nothing. */
  function applyFilter(next: Partial<DeliveryFilters>): void {
    setFilters((previous) => ({ ...previous, ...next }));
    setOffset(0);
  }

  return (
    <div aria-busy={state === "loading"}>
      {state === "error" ? (
        <ErrorState locale={locale} onRetry={() => setReloadNonce((nonce) => nonce + 1)} />
      ) : (
        <DeliveryStatusView
          locale={locale}
          summary={summary}
          page={page}
          filters={filters}
          offset={offset}
          loading={state === "loading"}
          onFilter={applyFilter}
          onPage={setOffset}
          onReload={() => setReloadNonce((nonce) => nonce + 1)}
        />
      )}
    </div>
  );
}

/**
 * The tab's face — pure `t()` + data rendering, no window/router access. The
 * filter row rides every read state: an errored or first read must not strand
 * the operator without the controls that fix it.
 */
export function DeliveryStatusView({
  locale,
  summary,
  page,
  filters,
  offset,
  loading,
  onFilter,
  onPage,
  onReload,
}: {
  locale: SpaBoot["locale"];
  summary: DeliverySummaryLine;
  page: DeliveryStatusPage | null;
  filters: DeliveryFilters;
  offset: number;
  loading: boolean;
  onFilter: (next: Partial<DeliveryFilters>) => void;
  onPage: (offset: number) => void;
  onReload: () => void;
}) {
  const columns: DataTableColumn<DeliveryStatusRow>[] = [
    {
      header: t(locale, "appDetail.delivery.columnRepo"),
      cell: (row) =>
        row.repository_full_name ?? (
          <span className="text-muted-foreground">{t(locale, "appDetail.delivery.unknownRepo")}</span>
        ),
    },
    {
      header: t(locale, "appDetail.delivery.columnType"),
      cell: (row) =>
        row.event_name ?? (
          <span className="text-muted-foreground">{t(locale, "appDetail.delivery.unknownType")}</span>
        ),
    },
    {
      header: t(locale, "appDetail.delivery.columnTime"),
      // note: The raw SQLite UTC stamp stays reachable as the native tooltip.
      cell: (row) => (
        <span className="text-muted-foreground tabular-nums" title={row.created_at}>
          {formatRelativeTime(row.created_at, locale)}
        </span>
      ),
    },
    {
      header: t(locale, "appDetail.delivery.columnOutcome"),
      cell: (row) => (
        <StatusBadge
          tone={row.outcome === "rejected" ? "danger" : row.outcome === "ok" ? "success" : "neutral"}
        >
          {deliveryOutcomeLabel(row.outcome, locale)}
        </StatusBadge>
      ),
    },
    {
      header: t(locale, "appDetail.delivery.columnReason"),
      // why: A refusal's reason is the one cell that explains a failure; every other
      // outcome has none, so the cell stays empty rather than inventing copy.
      cell: (row) =>
        row.reason === null ? null : <span className="text-muted-foreground">{row.reason}</span>,
    },
  ];

  const repoOptions = page?.repos ?? [];
  const typeOptions = page?.types ?? [];
  // note: I-000649: nothing is known until the first read RESOLVES. Reading a null
  // page as "zero rows" painted the empty state under the in-flight line, so
  // the operator was told the bot never received a webhook mid-request. The
  // table and its pager therefore render only once a page is in hand; the
  // in-flight line above is the first read's face.
  const resolved = page !== null;
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : Math.min(offset + 1, total);
  const to = Math.min(offset + DELIVERY_PAGE_SIZE, total);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{t(locale, "appDetail.delivery.copy")}</p>
        <p className="text-sm text-muted-foreground">
          {t(locale, "settings.lastWebhook", {
            time: formatRelativeTime(summary.last_webhook_at, locale),
          })}
          {summary.rejected24h > 0 ? (
            <>
              {" · "}
              <span className="text-(--tone-danger-fg)">
                {t(locale, "apps.health.rejected24h", { count: summary.rejected24h })}
              </span>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={filters.repo === "" ? ALL : filters.repo}
          onValueChange={(next) => onFilter({ repo: next === ALL ? "" : next })}
        >
          <SelectTrigger
            className="min-w-48"
            size="sm"
            aria-label={t(locale, "appDetail.delivery.filterRepo")}
          >
            <SelectValue placeholder={t(locale, "appDetail.delivery.filterAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t(locale, "appDetail.delivery.filterAll")}</SelectItem>
            {repoOptions.map((repo) => (
              <SelectItem key={repo} value={repo}>
                {repo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.since === "" ? ALL : filters.since}
          onValueChange={(next) => onFilter({ since: next === ALL ? "" : next })}
        >
          <SelectTrigger
            className="min-w-36"
            size="sm"
            aria-label={t(locale, "appDetail.delivery.filterWindow")}
          >
            <SelectValue placeholder={t(locale, "appDetail.delivery.filterWindowAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t(locale, "appDetail.delivery.filterWindowAll")}</SelectItem>
            {DELIVERY_WINDOWS.map((days) => (
              <SelectItem key={days} value={days}>
                {t(locale, "insights.daysShort", { count: Number(days) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.type === "" ? ALL : filters.type}
          onValueChange={(next) => onFilter({ type: next === ALL ? "" : next })}
        >
          <SelectTrigger
            className="min-w-44"
            size="sm"
            aria-label={t(locale, "appDetail.delivery.filterType")}
          >
            <SelectValue placeholder={t(locale, "appDetail.delivery.filterAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t(locale, "appDetail.delivery.filterAll")}</SelectItem>
            {typeOptions.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {loading ? (
          <span role="status" className="text-sm text-muted-foreground">
            {t(locale, "common.loading")}
          </span>
        ) : null}
      </div>
      {resolved ? (
        <>
          <DataTable
            columns={columns}
            rows={page.rows}
            rowKey={(row) => `${row.created_at}-${row.event_name ?? ""}-${row.repository_full_name ?? ""}`}
            empty={
              <EmptyState
                title={t(locale, "appDetail.delivery.emptyTitle")}
                description={t(locale, "appDetail.delivery.emptyDescription")}
              />
            }
          />
          <div data-slot="pager" className="flex flex-wrap items-center justify-between gap-2">
            <span
              data-slot="pager-range"
              aria-live="polite"
              className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tabular-nums text-(--text-faint)"
            >
              {t(locale, "appDetail.delivery.pageRange", { from, to, total })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={loading || offset === 0}
                onClick={() => onPage(Math.max(0, offset - DELIVERY_PAGE_SIZE))}
              >
                {t(locale, "appDetail.delivery.pagePrev")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={loading || to >= total}
                onClick={() => onPage(offset + DELIVERY_PAGE_SIZE)}
              >
                {t(locale, "appDetail.delivery.pageNext")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t(locale, "appDetail.delivery.refreshAria")}
                disabled={loading}
                onClick={onReload}
              >
                <RefreshCw aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
