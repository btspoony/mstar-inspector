import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { StatusBadge } from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { apiBase } from "../workspace-base";
import { PullRequestDetail } from "./PullRequestDetail";
import {
  appPullRequestsUrl,
  parsePullRequestList,
  pullRequestRefOf,
  pullRequestStatePill,
  type AppDetailSearch,
  type PullRequestRow,
} from "./data";

/**
 * One list read, stamped with the App it answers for. The tab instance survives
 * an App switch (`/dashboard/apps/:appId` keeps the same route family), so an
 * unstamped read would paint the previous App's rows or error under the new
 * one until the new read landed.
 */
export type ListRead = { app: string; rows: PullRequestRow[] | null; kind: "loading" | "ok" | "error" };

/**
 * The read for the ACTIVE App — the loading face when the stamp names another
 * one. Deriving at render (not resetting in an effect) is what removes the
 * stale frame: an effect runs after paint, so the previous App's rows would
 * still be the frame the operator saw.
 */
export function currentListRead(read: ListRead, appId: string): ListRead {
  return read.app === appId ? read : { app: appId, rows: null, kind: "loading" };
}

/**
 * The Pull requests tab of the App detail page — the per-App ledger of
 * every PR the App received. Two faces in one tab: the list (`pr` empty)
 * and the in-place detail (a valid `pr` search param). The detail address
 * rides the URL as `pr=owner/repo/number` through the SAME shell-owned
 * search state as the insights filters (replaceState commit + the one
 * popstate re-sync in AppDetailPage), so a deep link, a reload and
 * history back/forward all restore the open PR; the browser Back button
 * stays page-level exactly like every other in-page state in this SPA. A
 * nested path route was rejected: `matchSpaRoute` is shared with the
 * Worker's HTML dispatcher, so a new path family would couple this track
 * to the backend's route gate.
 *
 * Data plane: `GET …/api/apps/:appId/pull-requests` (list) and
 * `GET …/api/apps/:appId/pull-requests/:owner/:repo/:number` (detail —
 * the row's owner/repo, never the number alone; one App can see the same
 * number on several repos). The tab owns the list read and the list face;
 * the detail face and its read live in `PullRequestDetail.tsx`. No h1: the
 * tab rides the shell's identity header (the shell mounts this only for
 * managers — 403s cannot occur for an authorized viewer).
 */
export function AppPullRequestsTab({
  locale,
  appId,
  search,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  search: AppDetailSearch;
  /** Shell-owned commit: replaceState + state update (never popstate). */
  onSearch: (next: AppDetailSearch) => void;
}) {
  // One list read, stamped with the App it belongs to: switching Apps reuses
  // this tab instance, so an unstamped ledger would paint the previous App's
  // rows (or its error) until the new read landed. A read for another App
  // derives to `loading` with no rows.
  const [read, setRead] = useState<ListRead>({ app: appId, rows: null, kind: "loading" });
  const current = currentListRead(read, appId);
  // ErrorState retry: bumping the nonce re-runs the load effect below.
  const [reloadNonce, setReloadNonce] = useState(0);

  // A malformed pr param resolves to null and falls back to the list face, so
  // "the detail owns the face" is the parsed ref, not the raw search value.
  const ref = search.pr === "" ? null : pullRequestRefOf(search.pr);
  const detailOpen = ref !== null;

  useEffect(() => {
    // A deep link's only face is the detail: its read is the request the
    // operator came for. The list waits for the close, when this effect
    // re-runs on the emptied search value.
    if (detailOpen) return;
    let cancelled = false;
    // Rows survive a re-read of the SAME App, so a retry does not blank the
    // ledger; an App switch drops them with the stamp.
    const carry = (previous: ListRead): PullRequestRow[] | null =>
      previous.app === appId ? previous.rows : null;
    setRead((previous) => ({ app: appId, rows: carry(previous), kind: "loading" }));
    fetchJson(appPullRequestsUrl(apiBase(), appId))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parsePullRequestList(raw);
        if (!parsed) {
          setRead((previous) => ({ app: appId, rows: carry(previous), kind: "error" }));
          return;
        }
        setRead({ app: appId, rows: parsed, kind: "ok" });
      })
      .catch(() => {
        if (!cancelled) setRead((previous) => ({ app: appId, rows: carry(previous), kind: "error" }));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, detailOpen, reloadNonce]);

  function openPr(row: PullRequestRow): void {
    onSearch({ ...search, pr: `${row.owner}/${row.repo}/${row.number}` });
  }

  function closePr(): void {
    onSearch({ ...search, pr: "" });
  }

  if (ref !== null) {
    // The key is the pr address: switching PRs remounts instead of reusing a
    // retained read, and closing the PR unmounts so reopening starts clean.
    return (
      <PullRequestDetail
        key={search.pr}
        locale={locale}
        appId={appId}
        prKey={search.pr}
        prRef={ref}
        onBack={closePr}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6" aria-busy={current.kind === "loading"}>
      {current.kind === "loading" && current.rows === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(locale, "common.loading")}
        </p>
      ) : null}
      {/* A failed read replaces the ledger rather than sitting above it: rows
          from an earlier read would read as the current list. Covers the close
          of a detail, whose list read is this tab's own. */}
      {current.kind === "error" ? (
        <ErrorState locale={locale} onRetry={() => setReloadNonce((nonce) => nonce + 1)} />
      ) : current.rows !== null ? (
        <PullRequestsListView locale={locale} rows={current.rows} onOpen={openPr} />
      ) : null}
    </div>
  );
}

/**
 * The list face — pure `t()` + data rendering, no window/router access, so
 * tests can static-render it. The table is the shared `DataTable`; a row
 * click opens the detail (the PR cell keeps a real button so keyboard
 * users reach the same destination).
 */
export function PullRequestsListView({
  locale,
  rows,
  onOpen,
}: {
  locale: SpaBoot["locale"];
  rows: readonly PullRequestRow[];
  onOpen: (row: PullRequestRow) => void;
}) {
  const columns: DataTableColumn<PullRequestRow>[] = [
    {
      header: t(locale, "pullRequests.columnPr"),
      // `#number` + title on the primary line — the title truncates at the
      // named max-width step so long titles cannot grow the row at narrow
      // widths; owner/repo rides the quiet meta line.
      cell: (row) => (
        <div className="flex max-w-64 items-baseline gap-1.5">
          <span className="shrink-0 font-medium tabular-nums">#{row.number}</span>
          <button
            type="button"
            className="min-w-0 truncate text-left font-medium hover:underline"
            onClick={(event) => {
              // The row is the click target for the rest of the row; without
              // this the button's click bubbles and opens the same PR twice.
              event.stopPropagation();
              onOpen(row);
            }}
          >
            {row.title}
          </button>
        </div>
      ),
      meta: (row) => `${row.owner}/${row.repo}`,
    },
    {
      header: t(locale, "pullRequests.columnState"),
      cell: (row) => {
        const pill = pullRequestStatePill(locale, row.state);
        return <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>;
      },
    },
    {
      header: t(locale, "pullRequests.columnVerdict"),
      // The parser coerces a nullable verdict to "": an empty one is no
      // verdict, so the cell takes the same dash the null case does.
      cell: (row) =>
        row.latest_review !== null && row.latest_review.verdict !== "" ? (
          <span className="text-muted-foreground">{row.latest_review.verdict}</span>
        ) : (
          <span aria-hidden="true" className="text-muted-foreground">
            —
          </span>
        ),
    },
    {
      header: t(locale, "pullRequests.columnLastSeen"),
      // The raw SQLite UTC stamp stays reachable as the native tooltip
      // (the MembersPage / SettingsPage idiom).
      cell: (row) => (
        <span className="text-muted-foreground tabular-nums" title={row.last_seen_at}>
          {formatRelativeTime(row.last_seen_at, locale)}
        </span>
      ),
    },
    {
      header: t(locale, "pullRequests.columnFailures"),
      align: "right",
      cell: (row) =>
        row.failure_count > 0 ? (
          // The count IS the failure signal, so it wears the alert token
          // the Apps list health column uses; a zero stays plain.
          <span className="text-(--tone-danger-fg) tabular-nums">{row.failure_count}</span>
        ) : (
          <span className="tabular-nums">{row.failure_count}</span>
        ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.owner}/${row.repo}/${row.number}`}
      rowProps={(row) => ({
        className: "cursor-pointer",
        onClick: () => onOpen(row),
      })}
      empty={<EmptyState title={t(locale, "pullRequests.emptyTitle")} description={t(locale, "pullRequests.emptyDescription")} />}
    />
  );
}
