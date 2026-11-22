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
  scope: string;
  rows: PullRequestRow[] | null;
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
  onSearch: (next: AppDetailSearch) => void;
}) {
  const scopeKey = readScopeKey(scope);
  const [read, setRead] = useState<ListRead>({ scope: scopeKey, rows: null, repos: null, kind: "loading" });
  const current = currentListRead(read, scopeKey);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [repoFilter, setRepoFilter] = useState<{ scope: string; value: string }>({
    scope: scopeKey,
    value: "",
  });
  const repoFilterValue = repoFilter.scope === scopeKey ? repoFilter.value : "";
  const repoOptions = insightsRepoOptions(current.repos ?? [], repoFilterValue);

  const ref = search.pr === "" ? null : pullRequestRefOf(search.pr);
  const detailOpen = ref !== null;

  useEffect(() => {
    if (detailOpen) return;
    let cancelled = false;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, detailOpen, reloadNonce, repoFilterValue]);

  function openPr(row: PullRequestRow): void {
    onSearch({ ...search, pr: `${row.owner}/${row.repo}/${row.number}` });
  }

  function closePr(): void {
    onSearch({ ...search, pr: "" });
  }

  if (ref !== null) {
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
      <div className="flex flex-wrap items-center justify-end gap-3">
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
      cell: (row) => (
        <div className="flex max-w-64 items-baseline gap-1.5">
          <span className="shrink-0 font-medium tabular-nums">#{row.number}</span>
          <button
            type="button"
            className="min-w-0 truncate text-left font-medium hover:underline"
            onClick={(event) => {
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
