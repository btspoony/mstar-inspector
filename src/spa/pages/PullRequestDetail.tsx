import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Copy, ExternalLink } from "lucide-react";
import { MUST_FIX_SEVERITY } from "../../contracts/finding-severity";
import { t } from "../../i18n";
import {
  Button,
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { apiBase } from "../workspace-base";
import { MetricBand, type Metric } from "../components/MetricBand";
import { ErrorState } from "../components/state/ErrorState";
import { ReviewingBadge } from "./ReviewingBadge";
import {
  appPullRequestDetailUrl,
  appPullRequestRecordsUrl,
  githubCommitUrl,
  githubPullRequestUrl,
  githubRepoUrl,
  parsePullRequestDetail,
  parseRecordPage,
  pullRequestStatePill,
  type PullRequestDetail,
  type PullRequestRef,
  type RecordPage,
  type RecordPageItems,
  type RecordSection,
} from "./data";
import {
  COPY_OUTCOME_MS,
  copyOutcomeLabel,
  defaultFamily,
  foldLabel,
  formatReviewDuration,
  recordId,
  reviewAttribution,
  SEVERITY_FILTER_OPTIONS,
  SEVERITY_GROUPS,
  severityGroups,
  timelineRows,
  verdictTone,
  type ActivityTone,
  type RecordFamily,
  type SeverityTone,
} from "./pullRequestDetailModel";

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
 * The page size every section read REQUESTS. The server clamps it and echoes
 * what it applied, and the pager strides on that; this constant is only the
 * request and the fallback for a payload that does not echo a limit back.
 */
const RECORD_PAGE_SIZE = 10;

/** The findings filter's "no filter" value; the other choices are `mergeClass` severities. */
const SEVERITY_ALL = "all";

type SectionStatus = "idle" | "loading" | "ok" | "error";

/** One section's read state: the requested window, the filter and the loaded page. */
export type SectionState<K extends RecordSection> = {
  offset: number;
  severity: string;
  status: SectionStatus;
  page: RecordPage<RecordPageItems[K]> | null;
  /**
   * The NEWEST window this face captured: the section's unfiltered first page,
   * kept from the first read and never overwritten by a later offset or a
   * severity filter. The aside timeline reads this rather than `page`, so
   * paging a family never rewrites the PR's activity into its oldest rows.
   */
  newest: RecordPage<RecordPageItems[K]> | null;
};

/** Every section's state, keyed by family. */
export type RecordSections = { [K in RecordSection]: SectionState<K> };

type PageRequest = { offset: number; severity: string };

/**
 * One record section's page reader. Each section owns its state and its own
 * request ticket: a page or filter the reader has already moved past must not
 * overwrite the page now on screen. `endpoint` is read at call time only, so a
 * parent re-render cannot refetch anything.
 *
 * The offset and the filter are committed WITH the page they name, never when
 * the read starts: the pager's range, its button bounds and the filter control
 * all describe the rows on screen, so a window still in flight cannot make
 * them report a page that has not landed. A failed read commits the request
 * too — its retry must re-read the window that failed, not the one still shown.
 */
function useRecordSection<K extends RecordSection>(
  section: K,
  endpoint: (page: { offset: number; limit: number; severity?: string }) => string,
): [SectionState<K>, (request: PageRequest) => void] {
  const [state, setState] = useState<SectionState<K>>({
    offset: 0,
    severity: "",
    status: "idle",
    page: null,
    newest: null,
  });
  const ticket = useRef(0);
  // The same read can be asked for twice before a re-render sees it (a tab's
  // pointer press and click both activate); an identical in-flight request is
  // the same read, not a second one.
  const inFlight = useRef<string | null>(null);
  const load = (request: PageRequest): void => {
    const key = `${request.offset}\u0000${request.severity}`;
    if (inFlight.current === key) return;
    inFlight.current = key;
    const mine = (ticket.current += 1);
    setState((previous) => ({ ...previous, status: "loading" }));
    fetchJson(endpoint({ offset: request.offset, limit: RECORD_PAGE_SIZE, severity: request.severity }))
      .then((raw) => {
        if (mine !== ticket.current) return;
        const page = parseRecordPage(section, raw);
        setState((previous) => ({
          ...previous,
          offset: request.offset,
          severity: request.severity,
          status: page === null ? "error" : "ok",
          page: page ?? previous.page,
          // The aside describes the PR's newest events, so only the FIRST
          // unfiltered first page is ever captured: a later offset or filter
          // must not move it.
          newest:
            previous.newest !== null || page === null || request.offset !== 0 || request.severity !== ""
              ? previous.newest
              : page,
        }));
      })
      .catch(() => {
        if (mine !== ticket.current) return;
        // The failed window is the one its retry must re-read, so the request
        // commits here even though no page arrived.
        setState((previous) => ({
          ...previous,
          offset: request.offset,
          severity: request.severity,
          status: "error",
        }));
      })
      .finally(() => {
        if (mine === ticket.current) inFlight.current = null;
      });
  };
  return [state, load];
}

/**
 * A record list's pager: prev/next disabled at the bounds, and the loaded
 * range over the section's total. A section with no rows renders nothing —
 * its empty copy belongs to the list, not to a pager over zero.
 */
function SectionPager<K extends RecordSection>({
  locale,
  section,
  state,
  onLoadPage,
}: {
  locale: SpaBoot["locale"];
  section: K;
  state: SectionState<K>;
  onLoadPage: (section: RecordSection, page: Partial<PageRequest>) => void;
}) {
  const page = state.page;
  if (page === null || page.total === 0) return null;
  // The label is derived from the page in hand, so a total that shrank between
  // reads cannot invert it: `from` never passes `total`, and `to` never falls
  // below `from`. Both bounds read the same page the rows come from, and the
  // buttons stay inert while a read is in flight — the next window is only a
  // move from the window on screen.
  // The stride is the limit the SERVER applied (it clamps the requested one),
  // so a page boundary can never overlap or skip: the constant is only the
  // fallback for a payload that does not echo it back.
  const loading = state.status === "loading";
  const stride = page.limit ?? RECORD_PAGE_SIZE;
  const from = Math.min(state.offset + 1, page.total);
  const to = Math.max(from, Math.min(state.offset + page.items.length, page.total));
  return (
    <div data-slot="pager" className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          data-slot="pager-range"
          // The range is the page transition's only non-visual report; it is the
          // live region for it, so nothing else announces the same text.
          aria-live="polite"
          className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tabular-nums text-(--text-faint)"
        >
          {t(locale, "pullRequests.pageRange", { from, to, total: page.total })}
        </span>
        {/* Rows the row parser refused still sit inside `total`, so the range
            would otherwise count rows this list can never show on any page. */}
        {page.dropped === 0 ? null : (
          <span
            data-slot="pager-dropped"
            className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) text-(--tone-danger-fg)"
          >
            {t(locale, "pullRequests.pageDropped", { count: page.dropped })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={loading || state.offset === 0}
          onClick={() =>
            onLoadPage(section, {
              offset: Math.max(0, state.offset - stride),
              severity: state.severity,
            })
          }
        >
          {t(locale, "pullRequests.pagePrev")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={loading || state.offset + stride >= page.total}
          onClick={() => onLoadPage(section, { offset: state.offset + stride, severity: state.severity })}
        >
          {t(locale, "pullRequests.pageNext")}
        </Button>
      </div>
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
 * The tab also keys this node on the App and the pr address, so switching
 * PRs or Apps is a remount rather than a stamp comparison and no retained
 * face — head or section page — survives a transition at all.
 */
export function PullRequestDetail({
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
  // The ref's fields, not the ref: `pullRequestRefOf` builds a fresh object on
  // every parent render, so an object dependency would re-run the read and
  // flash the loading face for a PR that never changed.
  const { owner, repo, number } = prRef;
  const [read, setRead] = useState<DetailRead | null>(null);
  const [nonce, setNonce] = useState(0);
  const current = currentDetailRead(read, prKey);
  // One reader per family, each with its own ticket; the object below is the
  // view's whole page state.
  const [findings, loadFindings] = useRecordSection("findings", (page) =>
    appPullRequestRecordsUrl(apiBase(), appId, prRef, "findings", page),
  );
  const [reviews, loadReviews] = useRecordSection("reviews", (page) =>
    appPullRequestRecordsUrl(apiBase(), appId, prRef, "reviews", page),
  );
  const [failures, loadFailures] = useRecordSection("failures", (page) =>
    appPullRequestRecordsUrl(apiBase(), appId, prRef, "failures", page),
  );
  const records: RecordSections = { findings, reviews, failures };

  /** Read one section page. Omitted fields keep the section's current window/filter. */
  const loadPage = (section: RecordSection, page: Partial<PageRequest>): void => {
    if (section === "findings") {
      loadFindings({ offset: page.offset ?? findings.offset, severity: page.severity ?? findings.severity });
    } else if (section === "reviews") {
      loadReviews({ offset: page.offset ?? reviews.offset, severity: page.severity ?? reviews.severity });
    } else {
      loadFailures({ offset: page.offset ?? failures.offset, severity: page.severity ?? failures.severity });
    }
  };

  // A tab's first selection loads it; a section that already has a page keeps
  // it, so switching back and forth never re-reads what is on screen.
  const ensureSection = (section: RecordSection): void => {
    const state = section === "findings" ? findings : section === "reviews" ? reviews : failures;
    if (state.page !== null || state.status === "loading") return;
    loadPage(section, { offset: state.offset, severity: state.severity });
  };

  useEffect(() => {
    let cancelled = false;
    setRead({ pr: prKey, kind: "loading" });
    fetchJson(appPullRequestDetailUrl(apiBase(), appId, { owner, repo, number }))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parsePullRequestDetail(raw);
        if (parsed === null) {
          setRead({ pr: prKey, kind: "error" });
          return;
        }
        setRead({ pr: prKey, kind: "ok", data: parsed });
        // The counts the head just landed decide the opening family — the same
        // derivation the view defaults to, so the visible section is loaded.
        ensureSection(defaultFamily(parsed.counts));
        // The aside describes the PR's newest reviews and failures whatever
        // family the operator opened, so both history first pages are read with
        // the head rather than on a tab selection. `ensureSection` skips a
        // section that already has a page, so this never re-reads a window the
        // operator has paged to.
        ensureSection("reviews");
        ensureSection("failures");
      })
      .catch(() => {
        if (!cancelled) setRead({ pr: prKey, kind: "error" });
      });
    return () => {
      cancelled = true;
    };
    // `ensureSection` closes over the sections only to skip loaded ones; it is
    // not a dependency, or the first landing would re-read on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, prKey, owner, repo, number, nonce]);

  // Retry resets the read in the click itself, so the loading face paints
  // first; bumping the nonce alone would leave the failed face up until the
  // effect ran.
  const retry = (): void => {
    setRead({ pr: prKey, kind: "loading" });
    setNonce((value) => value + 1);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Outside the busy region: a face that is still loading must leave its
          only escape control reachable. */}
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        {t(locale, "pullRequests.backToList")}
      </Button>
      <div aria-busy={current === null || current.kind === "loading"}>
        {current !== null && current.kind === "ok" ? (
          <PullRequestDetailView
            locale={locale}
            detail={current.data}
            records={records}
            onEnsureSection={ensureSection}
            onLoadPage={loadPage}
          />
        ) : current !== null && current.kind === "error" ? (
          <ErrorState locale={locale} onRetry={retry} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t(locale, "common.loading")}
          </p>
        )}
      </div>
    </div>
  );
}

/** The severity left rule per group. Literal class strings: Tailwind scans
 * source text, so a composed `border-l-(--tone-${tone}-fg)` never compiles. */
const SEVERITY_RULE: Record<SeverityTone, string> = {
  danger: "border-l-(--tone-danger-fg)",
  warn: "border-l-(--tone-warn-fg)",
  neutral: "border-l-(--border-strong)",
};

/** A timeline dot's fill, same rule: literal strings for the scanner. */
const TIMELINE_DOT: Record<ActivityTone, string> = {
  danger: "bg-(--tone-danger-fg)",
  success: "bg-(--tone-success-fg)",
  neutral: "bg-(--border-strong)",
};

/** The round chip: a review row's ordinal, reused by the finding row it first reported. An inset pill — no border, surface fill, label-12. */
const ROUND_CHIP =
  "rounded-(--radius-pill) bg-(--surface-inset) px-1.5 py-0.5 text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tabular-nums text-(--text-muted)";

/**
 * The detail face — pure `t()` + data rendering, no window/router access.
 *
 * One bounded first screen instead of one expanding column: the PR's address
 * and aggregates on top, one record family at a time behind the embedded
 * segmented pill, long text folded, and the PR's own facts and activity in the
 * aside. Everything shown is a payload field; `severity` is grouped as the free
 * string it is. Review summaries, finding bodies and failure output are
 * model/runtime text and render as TEXT, never as HTML.
 */
export function PullRequestDetailView({
  locale,
  detail,
  records,
  onEnsureSection,
  onLoadPage,
}: {
  locale: SpaBoot["locale"];
  detail: PullRequestDetail;
  /** The per-section page state the host owns. */
  records: RecordSections;
  onEnsureSection: (section: RecordSection) => void;
  onLoadPage: (section: RecordSection, page: Partial<PageRequest>) => void;
}) {
  const pr = detail.pull_request;
  const counts = detail.counts;
  const pill = pullRequestStatePill(locale, pr.state);
  const [family, setFamily] = useState<RecordFamily>(() => defaultFamily(counts));
  // Fold overrides only: an unset key keeps the entry's own default, so a
  // remount never has to seed state from props.
  const [openFindings, setOpenFindings] = useState<Readonly<Record<string, boolean>>>({});
  const baseId = useId();

  const findingsPage = records.findings.page;
  const reviewsPage = records.reviews.page;
  const failuresPage = records.failures.page;
  const groups = severityGroups(locale, findingsPage?.items ?? []);
  // A filtered window with no matches proves the FILTER is empty, not the PR:
  // the head still counts findings, so the unfiltered copy would contradict the
  // tab count. Name the severity the operator chose instead; an out-of-set
  // value names itself, as the severity buckets already do.
  const activeSeverity = records.findings.severity;
  const severityOption = SEVERITY_FILTER_OPTIONS.find((option) => option.key === activeSeverity);
  const emptyFindingsCopy =
    activeSeverity === ""
      ? t(locale, "pullRequests.noFindings")
      : t(locale, "pullRequests.noFindingsForSeverity", {
          severity: severityOption === undefined ? activeSeverity : t(locale, severityOption.labelKey),
        });
  // The PR's newest review comes from the head payload, never the loaded page:
  // paging the reviews list must not rewrite the headline verdict, its tone or
  // the model/provider attribution.
  const latestReview = detail.latest_review;
  const latestVerdict = latestReview?.verdict ?? "";
  // Both fields can be empty (a v1 payload records neither): the attribution is
  // then "", and an empty meta item or span would read as a missing value.
  const latestAttribution = latestReview === null ? "" : reviewAttribution(locale, latestReview);
  // A copy's outcome is transient and per failure block: the button flips to
  // the result, then reverts. Each block owns its timer, so copying block B
  // cannot cancel block A's revert and leave A's label standing. The button's
  // own label is the single channel — focus stays on the pressed control, whose
  // accessible-name change is announced once; no live region repeats it.
  const [copyOutcome, setCopyOutcome] = useState<Readonly<Record<string, "copied" | "failed">>>({});
  const copyTimers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});
  // A clipboard write can settle after the face is gone; by then the cleanup
  // below has already run, so a late outcome would schedule a timer nothing
  // would clear.
  const mounted = useRef(false);
  useEffect(() => {
    // StrictMode mounts, cleans up and mounts again: the body re-arms the flag
    // so the second mount is not stuck looking unmounted.
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const timer of Object.values(copyTimers.current)) clearTimeout(timer);
    };
  }, []);
  const announceCopy = (key: string, outcome: "copied" | "failed"): void => {
    if (!mounted.current) return;
    setCopyOutcome((previous) => ({ ...previous, [key]: outcome }));
    clearTimeout(copyTimers.current[key]);
    copyTimers.current[key] = setTimeout(() => {
      delete copyTimers.current[key];
      setCopyOutcome((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }, COPY_OUTCOME_MS);
  };
  // Radix hands the trigger's value back as a string; only our three triggers
  // can reach this, but the guard keeps the narrowing honest. Selecting a
  // family for the first time is what reads its page.
  const selectFamily = (next: string): void => {
    if (next !== "findings" && next !== "reviews" && next !== "failures") return;
    setFamily(next);
    onEnsureSection(next);
  };

  const metrics: Metric[] = [
    {
      key: t(locale, "pullRequests.columnVerdict"),
      // A PR with no review yet — or a review whose verdict the payload
      // coerced to "" — is not an alarm: the dash is announced, so the
      // figure never reads as a blank cell or as a verdict.
      value:
        latestVerdict === "" ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">{t(locale, "pullRequests.noVerdict")}</span>
          </>
        ) : (
          latestVerdict
        ),
      tone: verdictTone(latestVerdict) === "danger" ? "danger" : undefined,
    },
    { key: t(locale, "pullRequests.reviews"), value: counts.reviews },
    {
      key: t(locale, "pullRequests.failures"),
      value: counts.failures,
      tone: counts.failures > 0 ? "danger" : undefined,
    },
    {
      key: t(locale, "pullRequests.findings"),
      // The must-fix tally rides the head's counts, so the note describes the
      // PR rather than the loaded page or the active severity filter.
      value: (
        <>
          {counts.findings}
          {counts.must_fix > 0 ? (
            <span className="ml-1 text-(length:--typo-label-12-size) font-normal text-(--text-muted)">
              {t(locale, "pullRequests.mustFixNote", { count: counts.must_fix })}
            </span>
          ) : null}
        </>
      ),
    },
  ];

  const facts: { label: string; value: ReactNode }[] = [
    {
      label: t(locale, "pullRequests.factRepo"),
      value: (
        <a
          href={githubRepoUrl(pr.owner, pr.repo)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t(locale, "pullRequests.openRepoOnGithub", { owner: pr.owner, repo: pr.repo })}
          className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
        >
          {`${pr.owner}/${pr.repo}`}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ),
    },
    { label: t(locale, "pullRequests.factNumber"), value: `#${pr.number}` },
    { label: t(locale, "pullRequests.factState"), value: pill.label },
    // The payload coerces a nullable head_sha to "": an empty chip would read
    // as a fact, so the row disappears instead.
    ...(pr.head_sha === ""
      ? []
      : [
          {
            label: t(locale, "pullRequests.factHead"),
            value: <code className="font-mono">{pr.head_sha.slice(0, 7)}</code>,
          },
        ]),
    {
      label: t(locale, "pullRequests.firstSeen"),
      value: (
        <span title={pr.first_seen_at} className="tabular-nums">
          {formatRelativeTime(pr.first_seen_at, locale)}
        </span>
      ),
    },
    {
      label: t(locale, "pullRequests.lastSeen"),
      value: (
        <span title={pr.last_seen_at} className="tabular-nums">
          {formatRelativeTime(pr.last_seen_at, locale)}
        </span>
      ),
    },
  ];

  // The aside's one list: capped history, the truncation note (when the cap
  // dropped anything) directly above the PR's own first sighting, which always
  // closes it. The rows come from each family's FIRST unfiltered page — the
  // host reads both history first pages with the head, and captures them
  // before any paging — so the aside describes the newest events of the PR,
  // never the oldest page of whichever family is open. A section with no
  // captured window (its read failed) contributes neither rows nor a hidden
  // count: a note claiming "earlier events not shown" with no row above it
  // would describe events it has no window into.
  const reviewsNewest = records.reviews.newest;
  const failuresNewest = records.failures.newest;
  const timeline = timelineRows(
    locale,
    pr,
    reviewsNewest?.items ?? [],
    failuresNewest?.items ?? [],
    {
      ...counts,
      reviews: reviewsNewest === null ? 0 : counts.reviews,
      failures: failuresNewest === null ? 0 : counts.failures,
    },
  );

  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <a
            href={githubPullRequestUrl(pr.owner, pr.repo, pr.number)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(locale, "pullRequests.openOnGithub", {
              owner: pr.owner,
              repo: pr.repo,
              number: pr.number,
            })}
            className="inline-flex items-center gap-1 text-(--text-secondary) tabular-nums underline-offset-2 hover:underline"
          >
            {t(locale, "pullRequests.prNumber", { owner: pr.owner, repo: pr.repo, number: pr.number })}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
          <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>
          <ReviewingBadge locale={locale} reviewing={pr.reviewing} />
          {pr.head_sha === "" ? null : (
            <span
              data-slot="head-sha"
              className="rounded-(--radius-control) border border-(--border-default) px-1.5 py-0.5 font-mono text-xs text-(--text-muted)"
              title={t(locale, "pullRequests.headSha")}
            >
              {pr.head_sha.slice(0, 7)}
            </span>
          )}
        </div>
        <h2 className="text-(length:--typo-heading-20-size) leading-(--typo-heading-20-line) tracking-(--typo-heading-20-tracking) font-(weight:--typo-heading-20-weight) text-(--text-primary)">
          {pr.title}
        </h2>
        {/* The meta line carries what the aside does not: the latest review's
            attribution. First/last seen live in the aside facts — printing
            them twice on one screen made the header repeat the aside. An
            unattributed review leaves the line empty, so it disappears. */}
        {latestAttribution === "" ? null : (
          <div
            data-slot="pr-meta"
            className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-(length:--typo-label-12-size) leading-(--typo-label-12-line) text-(--text-faint)"
          >
            <span>
              {t(locale, "pullRequests.latestReview")}{" "}
              <span className="text-(--text-muted)">{latestAttribution}</span>
            </span>
          </div>
        )}
      </header>

      <div className="mt-(--spacing-6)">
        <MetricBand metrics={metrics} />
      </div>

      <Tabs value={family} onValueChange={selectFamily} className="mt-(--spacing-6)">
        {/* Embedded segmented pill (DESIGN.md ### Tabs). Counts are text so a
            family's size never depends on colour alone; the danger dot marks
            the one fact an operator must not miss. Each trigger's accessible
            name is the label and the count with a separator — the visible
            spans alone would announce "Findings3". */}
        {/* At xl the content region is two columns — column 1 stacks the
            record toolbar over the record list, column 2 is the 16rem aside —
            so the aside's first card tops out level with the toolbar row. The
            record pill hugs the left of the toolbar row, the filter (findings
            only, and only while the PR has findings to narrow) sits at the
            row's right edge; the grid row gap spaces toolbar from content. */}
        <div className="mt-(--spacing-6) grid grid-cols-1 gap-(--spacing-6) xl:grid-cols-[minmax(0,1fr)_16rem] xl:gap-(--spacing-8)">
        <div
          data-slot="record-toolbar"
          className="flex flex-wrap items-center justify-between gap-(--spacing-4)"
        >
          <TabsList variant="default" aria-label={t(locale, "pullRequests.recordsLabel")} className="min-w-0">
          <TabsTrigger
            value="findings"
            aria-label={t(locale, "pullRequests.familyTabName", {
              label: t(locale, "pullRequests.findings"),
              count: counts.findings,
            })}
          >
            {t(locale, "pullRequests.findings")}
            <span className="text-xs tabular-nums text-(--text-faint)">{counts.findings}</span>
            {/* The dot answers "does this PR have a must-fix row" from the
                head's own count, so a severity filter or a page-2 view cannot
                clear it — the count beside it describes the PR too. */}
            {counts.must_fix > 0 ? (
              <span
                data-slot="family-dot"
                data-tone="danger"
                aria-hidden="true"
                className="size-1.5 rounded-full bg-(--tone-danger-fg)"
              />
            ) : null}
          </TabsTrigger>
          <TabsTrigger
            value="reviews"
            aria-label={t(locale, "pullRequests.familyTabName", {
              label: t(locale, "pullRequests.reviews"),
              count: counts.reviews,
            })}
          >
            {t(locale, "pullRequests.reviews")}
            <span className="text-xs tabular-nums text-(--text-faint)">{counts.reviews}</span>
          </TabsTrigger>
          <TabsTrigger
            value="failures"
            aria-label={t(locale, "pullRequests.familyTabName", {
              label: t(locale, "pullRequests.failures"),
              count: counts.failures,
            })}
          >
            {t(locale, "pullRequests.failures")}
            <span className="text-xs tabular-nums text-(--text-faint)">{counts.failures}</span>
            {counts.failures > 0 ? (
              <span
                data-slot="family-dot"
                data-tone="danger"
                aria-hidden="true"
                className="size-1.5 rounded-full bg-(--tone-danger-fg)"
              />
            ) : null}
          </TabsTrigger>
        </TabsList>
          {/* Changing the filter reloads from page one and the pager then
              counts the filtered total. It reads the committed filter (the one
              the loaded rows answer to), so it stays inert while a new one is
              in flight. Rendered only for the findings family while the PR
              has findings — for the other families the row is the pill alone. */}
          {family === "findings" && counts.findings > 0 ? (
            <div data-slot="severity-filter" className="flex items-center gap-2">
              <Select
                value={records.findings.severity === "" ? SEVERITY_ALL : records.findings.severity}
                disabled={records.findings.status === "loading"}
                onValueChange={(next) =>
                  onLoadPage("findings", { offset: 0, severity: next === SEVERITY_ALL ? "" : next })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-40 shrink-0"
                  aria-label={t(locale, "pullRequests.filterSeverity")}
                >
                  <SelectValue placeholder={t(locale, "pullRequests.filterAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEVERITY_ALL}>{t(locale, "pullRequests.filterAll")}</SelectItem>
                  {SEVERITY_FILTER_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {t(locale, option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
          <div className="min-w-0 flex-1">
            <TabsContent value="findings">
              {records.findings.status === "error" ? (
                <ErrorState
                  locale={locale}
                  onRetry={() =>
                    onLoadPage("findings", {
                      offset: records.findings.offset,
                      severity: records.findings.severity,
                    })
                  }
                />
              ) : findingsPage === null ? (
                records.findings.status === "loading" ? (
                  <p role="status" className="text-sm text-(--text-muted)">
                    {t(locale, "common.loading")}
                  </p>
                ) : (
                  <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noFindings")}</p>
                )
              ) : findingsPage.total === 0 ? (
                <p className="text-sm text-(--text-muted)">{emptyFindingsCopy}</p>
              ) : (
                <div className="flex flex-col gap-(--spacing-6)">
                  {groups.map((group) => (
                    <section
                      key={group.key}
                      data-slot="severity-group"
                      data-severity={group.key}
                      className="flex flex-col gap-2"
                    >
                      <h3 className="flex items-baseline gap-2 text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) uppercase text-(--text-faint)">
                        <span>{group.label}</span>
                        {/* The groups are built from the loaded window, while
                            the tab's count is the head's PR-wide total — so the
                            header says which one it counts. */}
                        <span className="tabular-nums text-(--text-muted)">
                          {t(locale, "pullRequests.groupPageCount", { count: group.items.length })}
                        </span>
                        <span aria-hidden="true" className="h-px flex-1 self-center bg-(--border-subtle)" />
                      </h3>
                      <ul className="flex flex-col gap-2">
                        {group.items.map(({ finding, index }, position) => {
                          // One identity for the rendered row: a payload id
                          // two findings share would otherwise fold them
                          // together, so position joins it — and the fold
                          // state, the React key and the body id all read it.
                          // The announced position, unlike the identity, is
                          // the row's rendered order inside the group.
                          const findingKey = `${finding.finding_id || "finding"}-${index}`;
                          const open = openFindings[findingKey] ?? finding.severity === MUST_FIX_SEVERITY;
                          const location =
                            finding.file_path === ""
                              ? ""
                              : `${finding.file_path}${finding.line === null ? "" : `:${finding.line}`}`;
                          const id = recordId(baseId, findingKey);
                          return (
                            <li
                              key={findingKey}
                              data-slot="finding"
                              className={cn(
                                "flex flex-col gap-1.5 rounded-(--radius-container) border border-(--border-default) border-l-2 bg-(--surface-card) px-3.5 py-3",
                                SEVERITY_RULE[group.tone],
                              )}
                            >
                              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                                <span className="min-w-0 flex-1 text-sm font-medium">{finding.title}</span>
                                {/* A coerced-empty file_path (repo-wide finding)
                                    renders no location at all — never a bare `:line`. */}
                                {location === "" ? null : (
                                  <span
                                    className="max-w-56 overflow-hidden text-ellipsis whitespace-nowrap rounded-(--radius-control) border border-(--border-subtle) bg-(--surface-inset) px-1.5 py-0.5 font-mono text-xs text-(--text-muted)"
                                    title={location}
                                  >
                                    {location}
                                  </span>
                                )}
                              </div>
                              {/* Mounted whether folded or not: the
                                  toggle's aria-controls must always resolve. */}
                              <p
                                id={id}
                                hidden={!open}
                                className="whitespace-pre-wrap break-words text-sm text-(--text-secondary)"
                              >
                                {finding.body}
                              </p>
                              {/* The bottom row pairs the fold control with the
                                  round that FIRST reported this finding (as the
                                  lifecycle stored it), opposite it on the right. */}
                              <div data-slot="finding-actions" className="flex items-center gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  className="self-start text-(--text-muted)"
                                  aria-expanded={open}
                                  aria-controls={id}
                                  aria-label={foldLabel(locale, open, finding.title, position + 1)}
                                  onClick={() =>
                                    setOpenFindings((previous) => ({ ...previous, [findingKey]: !open }))
                                  }
                                >
                                  <ChevronRight
                                    aria-hidden="true"
                                    className={cn("transition-transform", open && "rotate-90")}
                                  />
                                  {t(locale, open ? "pullRequests.collapse" : "pullRequests.expand")}
                                </Button>
                                {finding.review_round === null ? null : (
                                  <span data-slot="finding-round" className={cn(ROUND_CHIP, "ml-auto")}>
                                    {t(locale, "pullRequests.reviewRound", { round: finding.review_round })}
                                  </span>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                  <SectionPager
                    locale={locale}
                    section="findings"
                    state={records.findings}
                    onLoadPage={onLoadPage}
                  />
                </div>
              )}
            </TabsContent>

            <TabsContent value="reviews">
              {records.reviews.status === "error" ? (
                <ErrorState
                  locale={locale}
                  onRetry={() =>
                    onLoadPage("reviews", { offset: records.reviews.offset, severity: records.reviews.severity })
                  }
                />
              ) : reviewsPage === null ? (
                records.reviews.status === "loading" ? (
                  <p role="status" className="text-sm text-(--text-muted)">
                    {t(locale, "common.loading")}
                  </p>
                ) : (
                  <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noReviews")}</p>
                )
              ) : reviewsPage.total === 0 ? (
                <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noReviews")}</p>
              ) : (
                <div className="flex flex-col gap-(--spacing-4)">
                  <ul className="flex flex-col gap-2">
                    {reviewsPage.items.map((review, index) => {
                      const attribution = reviewAttribution(locale, review);
                      const durationLabel = t(locale, "pullRequests.reviewDurationLabel");
                      // Line 2: the verdict, then one `label count` pair per
                      // non-zero severity class in vocabulary order. Classes
                      // outside the vocabulary are ignored; a round with no
                      // counts renders its verdict alone.
                      const countLine: ReactNode[] = [];
                      if (review.verdict !== "") {
                        countLine.push(
                          <StatusBadge key="verdict" tone={verdictTone(review.verdict)}>
                            {review.verdict}
                          </StatusBadge>,
                        );
                      }
                      for (const group of SEVERITY_GROUPS) {
                        const count = review.severity_counts[group.severity] ?? 0;
                        if (count === 0) continue;
                        countLine.push(
                          <span
                            key={group.severity}
                            data-slot="review-class-count"
                            data-severity={group.severity}
                            className="text-(--text-muted)"
                          >
                            {t(locale, group.labelKey)}{" "}
                            <span className="tabular-nums">{count}</span>
                          </span>,
                        );
                      }
                      return (
                        <li
                          key={`${review.reviewed_at}-${review.head_sha}-${index}`}
                          className={cn(
                            "flex items-center gap-(--spacing-4) rounded-(--radius-container) border border-(--border-default) bg-(--surface-card) px-4 py-3.5",
                            index === 0 ? "border-(--border-strong)" : "",
                          )}
                        >
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div
                              data-slot="review-head"
                              className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-(length:--typo-label-12-size) leading-(--typo-label-12-line)"
                            >
                              {/* The round's ordinal in the PR's history; a
                                  payload that predates it has no chip. */}
                              {review.round === null ? null : (
                                <span data-slot="review-round" className={ROUND_CHIP}>
                                  {t(locale, "pullRequests.reviewRound", { round: review.round })}
                                </span>
                              )}
                              {/* The short sha opens the round's commit on
                                  GitHub; the accessible name names the commit. */}
                              {review.head_sha === "" ? null : (
                                <a
                                  data-slot="head-sha"
                                  href={githubCommitUrl(pr.owner, pr.repo, review.head_sha)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={t(locale, "pullRequests.openCommitOnGithub", {
                                    sha: review.head_sha.slice(0, 7),
                                  })}
                                  className="inline-flex items-center gap-1 rounded-(--radius-control) border border-(--border-default) px-1.5 py-0.5 font-mono text-(--text-muted) underline-offset-2 hover:underline"
                                >
                                  {review.head_sha.slice(0, 7)}
                                  <ExternalLink aria-hidden="true" className="size-3" />
                                </a>
                              )}
                              {/* An unattributed review (v1 records no model) gets
                                  no empty span — the row starts at whatever it
                                  does carry. */}
                              {attribution === "" ? null : (
                                <span className="text-(--text-muted)">{attribution}</span>
                              )}
                              {/* Historical rows carry no measured clock: the
                                  row simply omits the time. The label is real
                                  text: the span carries no role, so a tooltip
                                  alone would leave the value announced bare. */}
                              {review.duration_ms === null ? null : (
                                <span
                                  data-slot="review-duration"
                                  className="tabular-nums text-(--text-muted)"
                                  title={durationLabel}
                                >
                                  <span className="sr-only">{durationLabel}</span>
                                  {formatReviewDuration(locale, review.duration_ms)}
                                </span>
                              )}
                            </div>
                            {countLine.length === 0 ? null : (
                              <div
                                data-slot="review-counts"
                                className="flex flex-wrap items-center text-(length:--typo-label-12-size) leading-(--typo-label-12-line)"
                              >
                                {countLine.map((node, position) => (
                                  <Fragment key={position}>
                                    {position === 0 ? null : (
                                      <span aria-hidden="true" className="text-(--text-faint)">
                                        {" · "}
                                      </span>
                                    )}
                                    {node}
                                  </Fragment>
                                ))}
                              </div>
                            )}
                          </div>
                          {/* The relative time owns the row's right block, centered
                              against the two lines. */}
                          <div
                            data-slot="review-time"
                            className="flex w-20 shrink-0 items-center justify-center self-stretch tabular-nums text-(length:--typo-label-12-size) leading-(--typo-label-12-line) text-(--text-faint)"
                            title={review.reviewed_at}
                          >
                            {formatRelativeTime(review.reviewed_at, locale)}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <SectionPager
                    locale={locale}
                    section="reviews"
                    state={records.reviews}
                    onLoadPage={onLoadPage}
                  />
                </div>
              )}
            </TabsContent>

            <TabsContent value="failures">
              {records.failures.status === "error" ? (
                <ErrorState
                  locale={locale}
                  onRetry={() =>
                    onLoadPage("failures", {
                      offset: records.failures.offset,
                      severity: records.failures.severity,
                    })
                  }
                />
              ) : failuresPage === null ? (
                records.failures.status === "loading" ? (
                  <p role="status" className="text-sm text-(--text-muted)">
                    {t(locale, "common.loading")}
                  </p>
                ) : (
                  <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noFailures")}</p>
                )
              ) : failuresPage.total === 0 ? (
                <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noFailures")}</p>
              ) : (
                <div className="flex flex-col gap-(--spacing-4)">
                  <ul className="flex flex-col gap-2">
                    {failuresPage.items.map((failure, index) => {
                      // The first line is the diagnosis; the rest is evidence.
                      // Trailing newlines are not another line: `"boom\n"` is
                      // one line of output, so it gets no disclosure.
                      const lines = failure.error.replace(/(\r?\n)+$/, "").split(/\r?\n/);
                      const firstLine = lines[0] ?? "";
                      // The row's identity is its key; the copy outcome rides the
                      // same key so the message names the block it belongs to.
                      const failureKey = `${failure.created_at}-${index}`;
                      const outcome = copyOutcome[failureKey];
                      return (
                        <li
                          key={failureKey}
                          data-tone="danger"
                          className="flex flex-col gap-2 rounded-(--radius-container) border border-(--tone-danger-border) bg-(--tone-danger-bg) px-3.5 py-3"
                        >
                          <div className="flex flex-wrap items-center gap-2 text-(length:--typo-label-12-size) leading-(--typo-label-12-line)">
                            {/* The payload can record no stage: an empty chip
                                would read as a fact, so it disappears. */}
                            {failure.stage === "" ? null : (
                              <span
                                data-slot="failure-stage"
                                className="rounded-(--radius-control) border border-(--tone-danger-border) px-1.5 py-0.5 font-mono text-(--tone-danger-fg)"
                              >
                                {failure.stage}
                              </span>
                            )}
                            <span className="ml-auto tabular-nums text-(--text-faint)" title={failure.created_at}>
                              {formatRelativeTime(failure.created_at, locale)}
                            </span>
                          </div>
                          {/* Model/runtime output — rendered as text, never as HTML. */}
                          {firstLine === "" ? null : (
                            <p className="whitespace-pre-wrap break-words font-mono text-(length:--typo-label-12-size) leading-(--typo-label-12-line) text-(--tone-danger-fg)">
                              {firstLine}
                            </p>
                          )}
                          {lines.length > 1 ? (
                            <details>
                              <summary className="cursor-pointer text-(length:--typo-label-12-size) text-(--text-secondary)">
                                {t(locale, "pullRequests.failureRemainingOutput")}
                              </summary>
                              {/* The diagnosis above already printed the first
                                  line; this block is the evidence BELOW it. The
                                  copy action still takes the whole error. */}
                              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre rounded-(--radius-control) border border-(--tone-danger-border) bg-(--surface-page) p-2.5 font-mono text-(length:--typo-label-12-size) leading-relaxed text-(--text-secondary)">
                                {lines.slice(1).join("\n")}
                              </pre>
                            </details>
                          ) : null}
                          <div className="flex items-center gap-2">
                            <Button
                              data-slot="copy-error"
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="self-start text-(--text-secondary)"
                              onClick={() => {
                                // Feature-detected per press: an insecure context
                                // or an old browser offers no Clipboard API, and
                                // that press must report the failure rather than
                                // leave the previous clipboard content silently in
                                // place. Both branches set the outcome — a
                                // rejected write (permission, insecure context)
                                // leaves the same stale content, so silence would
                                // let the operator paste the wrong text.
                                const clipboard: Clipboard | undefined =
                                  typeof navigator === "undefined" ? undefined : navigator.clipboard;
                                if (clipboard === undefined || typeof clipboard.writeText !== "function") {
                                  announceCopy(failureKey, "failed");
                                  return;
                                }
                                // A browser may throw from `writeText` instead of
                                // rejecting: same outcome, so the write is wrapped
                                // and both settle paths land on the one machine.
                                let write: Promise<void>;
                                try {
                                  write = clipboard.writeText(failure.error);
                                } catch {
                                  announceCopy(failureKey, "failed");
                                  return;
                                }
                                write.then(
                                  () => announceCopy(failureKey, "copied"),
                                  () => announceCopy(failureKey, "failed"),
                                );
                              }}
                            >
                              <Copy aria-hidden="true" />
                              {copyOutcomeLabel(locale, outcome)}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <SectionPager
                    locale={locale}
                    section="failures"
                    state={records.failures}
                    onLoadPage={onLoadPage}
                  />
                </div>
              )}
            </TabsContent>
          </div>

          <aside
            aria-label={t(locale, "pullRequests.asideFacts")}
            className="flex w-full flex-col gap-(--spacing-4) xl:col-start-2 xl:row-start-1"
          >
            <section className="flex flex-col gap-2.5 rounded-(--radius-container) border border-(--border-default) bg-(--surface-card) px-4 py-3.5">
              <h2 className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) uppercase text-(--text-faint)">
                {t(locale, "pullRequests.asideFacts")}
              </h2>
              <dl className="flex flex-col gap-1.5 text-(length:--typo-copy-14-size)">
                {facts.map((fact) => (
                  <div key={fact.label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-(--text-faint)">{fact.label}</dt>
                    <dd className="min-w-0 truncate text-right text-(--text-secondary)">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="flex flex-col gap-2.5 rounded-(--radius-container) border border-(--border-default) bg-(--surface-card) px-4 py-3.5">
              <h2 className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) uppercase text-(--text-faint)">
                {t(locale, "pullRequests.asideActivity")}
              </h2>
              <ol className="flex flex-col gap-(--spacing-3)">
                {timeline.map((row) =>
                  "hidden" in row ? (
                    <li
                      key={row.key}
                      data-slot="timeline-truncated"
                      className="pl-3.5 text-(length:--typo-label-12-size) text-(--text-faint)"
                    >
                      {t(locale, "pullRequests.timelineHidden", { count: row.hidden })}
                    </li>
                  ) : (
                    <li key={row.key} data-slot="activity-entry" data-tone={row.tone} className="flex gap-2">
                      <span
                        aria-hidden="true"
                        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", TIMELINE_DOT[row.tone])}
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="text-(length:--typo-copy-14-size) text-(--text-primary)">{row.label}</span>
                        <span className="text-(length:--typo-label-12-size) text-(--text-faint)">{row.meta}</span>
                      </div>
                    </li>
                  ),
                )}
              </ol>
            </section>
          </aside>
        </div>
      </Tabs>
    </div>
  );
}
