import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { t } from "../../i18n";
import { Button, FlowSection, StatusBadge } from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { apiBase } from "../workspace-base";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import {
  appPullRequestDetailUrl,
  appPullRequestsUrl,
  parsePullRequestDetail,
  parsePullRequestList,
  pullRequestRefOf,
  pullRequestStatePill,
  type AppDetailSearch,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestRow,
} from "./data";

/**
 * One detail read, stamped with the pr it belongs to (S2/N1). A read whose
 * stamp mismatches the ACTIVE pr is a different PR's result — view, error
 * or loading — and derives to null, so a transition frame renders the
 * loading face, never the previous PR's data or its error.
 */
export type DetailRead =
  | { pr: string; kind: "ok"; data: PullRequestDetail }
  | { pr: string; kind: "error" }
  | { pr: string; kind: "loading" };

/** The read for the active pr — null when the stamp mismatches or nothing was read. */
export function currentDetailRead(read: DetailRead | null, pr: string): DetailRead | null {
  return read !== null && read.pr === pr ? read : null;
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
 * number on several repos). The component owns the fetch + presentation;
 * no h1: the tab rides the shell's identity header (the shell mounts this
 * only for managers — 403s cannot occur for an authorized viewer).
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
  const [rows, setRows] = useState<PullRequestRow[] | null>(null);
  const [listState, setListState] = useState<"loading" | "ok" | "error">("loading");
  // ErrorState retry: bumping the nonce re-runs the load effect below.
  const [reloadNonce, setReloadNonce] = useState(0);

  const ref = search.pr === "" ? null : pullRequestRefOf(search.pr);

  useEffect(() => {
    let cancelled = false;
    setListState("loading");
    fetchJson(appPullRequestsUrl(apiBase(), appId))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parsePullRequestList(raw);
        if (!parsed) {
          setListState("error");
          return;
        }
        setRows(parsed);
        setListState("ok");
      })
      .catch(() => {
        if (!cancelled) setListState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [appId, reloadNonce]);

  function openPr(row: PullRequestRow): void {
    onSearch({ ...search, pr: `${row.owner}/${row.repo}/${row.number}` });
  }

  function closePr(): void {
    onSearch({ ...search, pr: "" });
  }

  // A malformed pr param resolves to null: fall back to the list face.
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
    <div className="flex flex-col gap-6" aria-busy={listState === "loading"}>
      {listState === "loading" && rows === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(locale, "common.loading")}
        </p>
      ) : null}
      {listState === "error" && rows === null ? (
        <ErrorState locale={locale} onRetry={() => setReloadNonce((nonce) => nonce + 1)} />
      ) : null}
      {rows !== null ? (
        <PullRequestsListView locale={locale} rows={rows} onOpen={openPr} />
      ) : null}
    </div>
  );
}

/**
 * The in-place detail face. Its read state lives HERE rather than in the tab,
 * so unmounting discards it: the tab renders this node only while a pr is
 * open, which makes reopening a PR a remount with a clean read instead of a
 * repaint of the previous visit's error. An effect cannot do that job — it
 * runs after paint, and the retained frame IS the frame the operator sees.
 *
 * The tab also keys this node on the pr address, so switching PRs is a
 * remount rather than a stamp comparison and no retained face survives a
 * transition at all.
 */
function PullRequestDetail({
  locale,
  appId,
  prKey,
  prRef,
  onBack,
}: {
  locale: SpaBoot["locale"];
  appId: string;
  /** The `pr` search value this node belongs to — its own read stamp. */
  prKey: string;
  prRef: PullRequestRef;
  onBack: () => void;
}) {
  const [read, setRead] = useState<DetailRead | null>(null);
  const [nonce, setNonce] = useState(0);
  const current = currentDetailRead(read, prKey);

  useEffect(() => {
    let cancelled = false;
    setRead({ pr: prKey, kind: "loading" });
    fetchJson(appPullRequestDetailUrl(apiBase(), appId, prRef))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parsePullRequestDetail(raw);
        setRead(parsed ? { pr: prKey, kind: "ok", data: parsed } : { pr: prKey, kind: "error" });
      })
      .catch(() => {
        if (!cancelled) setRead({ pr: prKey, kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [appId, prKey, prRef, nonce]);

  // Retry resets the read in the click itself, so the loading face paints
  // first; bumping the nonce alone would leave the failed face up until the
  // effect ran.
  const retry = (): void => {
    setRead({ pr: prKey, kind: "loading" });
    setNonce((value) => value + 1);
  };

  return (
    <div className="flex flex-col gap-6" aria-busy={current === null || current.kind === "loading"}>
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        {t(locale, "pullRequests.backToList")}
      </Button>
      {current !== null && current.kind === "ok" ? (
        <PullRequestDetailView locale={locale} detail={current.data} />
      ) : current !== null && current.kind === "error" ? (
        <ErrorState locale={locale} onRetry={retry} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t(locale, "common.loading")}
        </p>
      )}
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
            onClick={() => onOpen(row)}
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
      cell: (row) =>
        row.latest_review ? (
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

/**
 * The detail face — pure `t()` + data rendering, no window/router access.
 * One content plane divided by hairlines (the FlowSection idiom): the
 * reviews, then the failures (stage + error — the diagnostic payload this
 * feature exists for; the error is model/runtime output and renders as
 * TEXT, never as HTML), then the findings. summary_md/body arrive as
 * markdown-ish plain text and render verbatim in whitespace-preserving
 * blocks.
 */
export function PullRequestDetailView({
  locale,
  detail,
}: {
  locale: SpaBoot["locale"];
  detail: PullRequestDetail;
}) {
  const pr = detail.pull_request;
  const pill = pullRequestStatePill(locale, pr.state);
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1.5 border-b border-(--border-subtle) pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground tabular-nums">
            {t(locale, "pullRequests.prNumber", { owner: pr.owner, repo: pr.repo, number: pr.number })}
          </span>
          <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>
          <span
            className="rounded border border-(--border-default) px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
            title={t(locale, "pullRequests.headSha")}
          >
            {pr.head_sha.slice(0, 7)}
          </span>
        </div>
        <h2 className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking) font-(weight:--typo-heading-16-weight) text-(--text-primary)">
          {pr.title}
        </h2>
      </div>
      <FlowSection
        title={t(locale, "pullRequests.reviews")}
        subtitle={t(locale, "pullRequests.reviewsCount", { count: detail.reviews.length })}
      >
        {detail.reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "pullRequests.noReviews")}</p>
        ) : (
          <ul className="flex flex-col">
            {detail.reviews.map((review, index) => (
              <li
                key={`${review.reviewed_at}-${review.head_sha}-${index}`}
                className="flex flex-col gap-1 border-b border-(--border-subtle) py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{review.verdict}</span>
                  <span className="text-muted-foreground">
                    {t(locale, "pullRequests.reviewMeta", {
                      model: review.model,
                      provider: review.provider,
                    })}
                  </span>
                  <span
                    className="text-muted-foreground tabular-nums"
                    title={review.reviewed_at}
                  >
                    {formatRelativeTime(review.reviewed_at, locale)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{review.summary_md}</p>
              </li>
            ))}
          </ul>
        )}
      </FlowSection>
      <FlowSection
        title={t(locale, "pullRequests.failures")}
        subtitle={t(locale, "pullRequests.failuresCount", { count: detail.failures.length })}
      >
        {detail.failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "pullRequests.noFailures")}</p>
        ) : (
          <ul className="flex flex-col">
            {detail.failures.map((failure, index) => (
              <li
                key={`${failure.created_at}-${index}`}
                className="flex flex-col gap-1 border-b border-(--border-subtle) py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{failure.stage}</span>
                  <span className="text-muted-foreground tabular-nums" title={failure.created_at}>
                    {formatRelativeTime(failure.created_at, locale)}
                  </span>
                </div>
                {/* Model/runtime output — rendered as text, never as HTML. */}
                <p className="whitespace-pre-wrap break-words font-mono text-xs text-(--tone-danger-fg)">
                  {failure.error}
                </p>
              </li>
            ))}
          </ul>
        )}
      </FlowSection>
      <FlowSection
        title={t(locale, "pullRequests.findings")}
        subtitle={t(locale, "pullRequests.findingsCount", { count: detail.findings.length })}
      >
        {detail.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "pullRequests.noFindings")}</p>
        ) : (
          <ul className="flex flex-col">
            {detail.findings.map((finding) => (
              <li
                key={finding.finding_id}
                className="flex flex-col gap-1 border-b border-(--border-subtle) py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{finding.title}</span>
                  <span className="text-muted-foreground">{finding.severity}</span>
                  <span className="text-muted-foreground">
                    {/* A coerced-empty file_path (repo-wide finding) renders
                        no location at all — never a bare `:line` (N12). */}
                    {finding.file_path === ""
                      ? ""
                      : `${finding.file_path}${finding.line === null ? "" : `:${finding.line}`}`}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{finding.body}</p>
              </li>
            ))}
          </ul>
        )}
      </FlowSection>
    </div>
  );
}
