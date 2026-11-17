import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { t } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
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
import { formatRelativeTime } from "../relative-time";
import { apiBase } from "../workspace-base";
import { PullRequestDetail } from "./PullRequestDetail";
import { ReviewingBadge } from "./ReviewingBadge";
import {
  INSIGHTS_REPO_ALL,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  parsePullRequestList,
  pullRequestRefOf,
  pullRequestStatePill,
  readScopeKey,
  scopedPullRequestsUrl,
  type AppDetailSearch,
  type PullRequestRow,
  type ReadScope,
} from "./data";

/**
 * One list read, stamped with the SCOPE it answers for. The tab instance
 * survives a scope switch (the repository page re-renders it under the same
 * route family), so an unstamped read would paint the previous scope's rows or
 * error under the new one until the new read landed.
 */
export type ListRead = {
  /** {@link readScopeKey} of the scope this read answers for. */
  scope: string;
  rows: PullRequestRow[] | null;
  /** The payload's repository option set — kept across an in-flight re-read. */
  repos: string[] | null;
  kind: "loading" | "ok" | "error";
};

/**
 * The read for the ACTIVE scope — the loading face when the stamp names
 * another one. Deriving at render (not resetting in an effect) is what removes
 * the stale frame: an effect runs after paint, so the previous scope's rows
 * would still be the frame the operator saw.
 */
export function currentListRead(read: ListRead, scope: string): ListRead {
  return read.scope === scope ? read : { scope, rows: null, repos: null, kind: "loading" };
}

/**
 * The Pull requests tab of a repository detail page — the ledger of every PR
 * the SCOPE received (one target, or the whole workspace). Two faces in one
 * tab: the list (`pr` empty)
 * and the in-place detail (a valid `pr` search param). The detail address
 * rides the URL as `pr=owner/repo/number` through the SAME shell-owned
 * search state as the insights filters (the shell's replaceState commit plus
 * its one popstate re-sync), so a deep link, a reload and
 * history back/forward all restore the open PR; the browser Back button
 * stays page-level exactly like every other in-page state in this SPA. A
 * nested path route was rejected: `matchSpaRoute` is shared with the
 * Worker's HTML dispatcher, so a new path family would couple this track
 * to the backend's route gate.
 *
 * Data plane: `GET …/api/targets/:targetId/pull-requests` (one repository) or
 * `GET …/api/pull-requests` (the workspace), and the same family's
 * `…/pull-requests/:owner/:repo/:number` for the detail — the row's owner/repo,
 * never the number alone; one App can see the same number on several repos.
 * The tab owns the list read and the list face;
 * the detail face and its read live in `PullRequestDetail.tsx`. No h1: the
 * tab rides the shell's identity header (the shell mounts this only for
 * managers — 403s cannot occur for an authorized viewer).
 */
export function AppPullRequestsTab({
  locale,
  scope,
  search,
  onSearch,
}: {
  locale: SpaBoot["locale"];
  scope: ReadScope;
  search: AppDetailSearch;
  /** Shell-owned commit: replaceState + state update (never popstate). */
  onSearch: (next: AppDetailSearch) => void;
}) {
  // One list read, stamped with the scope it belongs to: switching scopes
  // reuses this tab instance, so an unstamped ledger would paint the previous
  // scope's rows (or its error) until the new read landed. A read for another
  // scope derives to `loading` with no rows.
  const scopeKey = readScopeKey(scope);
  const [read, setRead] = useState<ListRead>({ scope: scopeKey, rows: null, repos: null, kind: "loading" });
  const current = currentListRead(read, scopeKey);
  // ErrorState retry: bumping the nonce re-runs the load effect below.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Local state, not URL state: `search.repo` belongs to the insights tab,
  // and sharing one search param would leak each tab's filter into the other.
  // The choice is a REQUEST parameter now: the selection re-reads the ledger
  // through `?repo=owner/name`, so the server filters BEFORE its row cap
  // instead of the tab hiding rows it already holds.
  //
  // The filter is scoped to one read scope: the tab instance survives a scope
  // switch, so the choice is stamped with the scope it was made for — another
  // scope derives to "all" instead of inheriting a value that names none of
  // its rows (a coincidental name match would silently filter the new ledger).
  const [repoFilter, setRepoFilter] = useState<{ scope: string; value: string }>({
    scope: scopeKey,
    value: "",
  });
  const repoFilterValue = repoFilter.scope === scopeKey ? repoFilter.value : "";
  // The option set is the payload's `repos` — the scope's whole repository set,
  // including repositories whose rows sit behind the server's row cap. It is
  // NOT derived from the loaded rows: a capped window would silently drop
  // repositories from the toolbar. The current filter rides along even when
  // the errored payload carried no option list, so the select never shows a
  // dead entry; the "all" sentinel is always rendered (data.ts helper, the
  // AppInsightsTab pattern).
  const repoOptions = insightsRepoOptions(current.repos ?? [], repoFilterValue);

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
    // Rows and the option list survive a re-read of the SAME scope (a retry, a
    // filter switch), so the frame keeps its content while the new read is in
    // flight; a scope switch drops them with the stamp.
    const carry = (previous: ListRead): Pick<ListRead, "rows" | "repos"> =>
      previous.scope === scopeKey
        ? { rows: previous.rows, repos: previous.repos }
        : { rows: null, repos: null };
    setRead((previous) => ({ scope: scopeKey, ...carry(previous), kind: "loading" }));
    fetchJson(scopedPullRequestsUrl(apiBase(), scope, repoFilterValue === "" ? undefined : repoFilterValue))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parsePullRequestList(raw);
        if (!parsed) {
          setRead((previous) => ({ scope: scopeKey, ...carry(previous), kind: "error" }));
          return;
        }
        setRead({ scope: scopeKey, rows: parsed.rows, repos: parsed.repos, kind: "ok" });
      })
      .catch(() => {
        if (!cancelled) setRead((previous) => ({ scope: scopeKey, ...carry(previous), kind: "error" }));
      });
    return () => {
      cancelled = true;
    };
    // The scope's KEY, not the object: a caller rebuilding `{kind, targetId}`
    // on every render must not re-run the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, detailOpen, reloadNonce, repoFilterValue]);

  function openPr(row: PullRequestRow): void {
    onSearch({ ...search, pr: `${row.owner}/${row.repo}/${row.number}` });
  }

  function closePr(): void {
    onSearch({ ...search, pr: "" });
  }

  if (ref !== null) {
    // The key is the scope plus the pr address: switching PRs remounts instead
    // of reusing a retained read, closing the PR unmounts so reopening starts
    // clean, and a scope switch in place discards the previous scope's head and
    // its section pages before the next frame can paint them.
    return (
      <PullRequestDetail
        key={`${scopeKey}\u0000${search.pr}`}
        locale={locale}
        scope={scope}
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
      {/* The toolbar rides the list face regardless of the read state: an
          errored read (or the first load) must not strand the operator
          without the repository filter or the refresh — the content area
          below owns the loading / error / rows ternary. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {/* The Select primitive rejects "" as an item value, so the "all"
            choice reuses the shared insights sentinel (data.ts). */}
        <Select
          value={insightsRepoSelectValue(repoFilterValue)}
          onValueChange={(next) => setRepoFilter({ scope: scopeKey, value: insightsRepoFromSelect(next) })}
        >
          <SelectTrigger
            className="min-w-48"
            size="sm"
            aria-label={t(locale, "pullRequests.filterRepo")}
          >
            <SelectValue placeholder={t(locale, "pullRequests.filterRepoAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INSIGHTS_REPO_ALL}>
              {t(locale, "pullRequests.filterRepoAll")}
            </SelectItem>
            {repoOptions.map((repo) => (
              <SelectItem key={repo} value={repo}>
                {repo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t(locale, "pullRequests.refreshAria")}
          disabled={current.kind === "loading"}
          onClick={() => setReloadNonce((nonce) => nonce + 1)}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
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
      // The row's state and its D11 reviewing marker share one cell: the badge
      // is a live-lock fact about this PR, not a second state column (its
      // quiet face sits beside the filled state pill).
      cell: (row) => {
        const pill = pullRequestStatePill(locale, row.state);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>
            <ReviewingBadge locale={locale} reviewing={row.reviewing} />
          </div>
        );
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
