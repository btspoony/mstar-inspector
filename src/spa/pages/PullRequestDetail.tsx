import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Copy } from "lucide-react";
import { t } from "../../i18n";
import { Button, cn, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from "@design-system";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { apiBase } from "../workspace-base";
import { MetricBand, type Metric } from "../components/MetricBand";
import { ErrorState } from "../components/state/ErrorState";
import {
  appPullRequestDetailUrl,
  parsePullRequestDetail,
  pullRequestStatePill,
  type PullRequestDetail,
  type PullRequestRef,
} from "./data";
import {
  COPY_OUTCOME_MS,
  copyOutcomeLabel,
  defaultFamily,
  foldLabel,
  recordId,
  reviewAttribution,
  SEVERITY_KEYS,
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

  useEffect(() => {
    let cancelled = false;
    setRead({ pr: prKey, kind: "loading" });
    fetchJson(appPullRequestDetailUrl(apiBase(), appId, { owner, repo, number }))
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
          <PullRequestDetailView locale={locale} detail={current.data} />
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
}: {
  locale: SpaBoot["locale"];
  detail: PullRequestDetail;
}) {
  const pr = detail.pull_request;
  const pill = pullRequestStatePill(locale, pr.state);
  const [family, setFamily] = useState<RecordFamily>(() => defaultFamily(detail));
  // Fold overrides only: an unset key keeps the entry's own default, so a
  // remount never has to seed state from props.
  const [openFindings, setOpenFindings] = useState<Readonly<Record<string, boolean>>>({});
  const [openReviews, setOpenReviews] = useState<Readonly<Record<string, boolean>>>({});
  const baseId = useId();

  const mustFix = detail.findings.filter((finding) => finding.severity === SEVERITY_KEYS.mustFix).length;
  const groups = severityGroups(locale, detail.findings);
  // The dot reads the buckets the list below renders — one rule, so a legacy
  // spelling that lands in `other` cannot be actionable here and quiet there.
  const findingsActionable = groups.some((group) => group.actionable);
  // The detail's own review list is the record for "latest": its first row is
  // the newest review and carries the attribution. The PR row's summary is the
  // fallback for a detail read that carried no review rows — the band, the
  // header meta and the review list all read this one value.
  const latestReview = detail.reviews[0] ?? null;
  const latestVerdict = latestReview?.verdict ?? pr.latest_review?.verdict ?? "";
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
  // can reach this, but the guard keeps the narrowing honest.
  const selectFamily = (next: string): void => {
    if (next === "findings" || next === "reviews" || next === "failures") setFamily(next);
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
    { key: t(locale, "pullRequests.reviews"), value: detail.reviews.length },
    {
      key: t(locale, "pullRequests.failures"),
      value: detail.failures.length,
      tone: detail.failures.length > 0 ? "danger" : undefined,
    },
    {
      key: t(locale, "pullRequests.findings"),
      value: (
        <>
          {detail.findings.length}
          {mustFix > 0 ? (
            <span className="ml-1 text-(length:--typo-label-12-size) font-normal text-(--text-muted)">
              {t(locale, "pullRequests.mustFixNote", { count: mustFix })}
            </span>
          ) : null}
        </>
      ),
    },
  ];

  const facts: { label: string; value: ReactNode }[] = [
    { label: t(locale, "pullRequests.factRepo"), value: `${pr.owner}/${pr.repo}` },
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
  // closes it.
  const timeline = timelineRows(locale, detail);

  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-(--text-secondary) tabular-nums">
            {t(locale, "pullRequests.prNumber", { owner: pr.owner, repo: pr.repo, number: pr.number })}
          </span>
          <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>
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
        <TabsList variant="default" aria-label={t(locale, "pullRequests.recordsLabel")}>
          <TabsTrigger
            value="findings"
            aria-label={t(locale, "pullRequests.familyTabName", {
              label: t(locale, "pullRequests.findings"),
              count: detail.findings.length,
            })}
          >
            {t(locale, "pullRequests.findings")}
            <span className="text-xs tabular-nums text-(--text-faint)">{detail.findings.length}</span>
            {findingsActionable ? (
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
              count: detail.reviews.length,
            })}
          >
            {t(locale, "pullRequests.reviews")}
            <span className="text-xs tabular-nums text-(--text-faint)">{detail.reviews.length}</span>
          </TabsTrigger>
          <TabsTrigger
            value="failures"
            aria-label={t(locale, "pullRequests.familyTabName", {
              label: t(locale, "pullRequests.failures"),
              count: detail.failures.length,
            })}
          >
            {t(locale, "pullRequests.failures")}
            <span className="text-xs tabular-nums text-(--text-faint)">{detail.failures.length}</span>
            {detail.failures.length > 0 ? (
              <span
                data-slot="family-dot"
                data-tone="danger"
                aria-hidden="true"
                className="size-1.5 rounded-full bg-(--tone-danger-fg)"
              />
            ) : null}
          </TabsTrigger>
        </TabsList>

        <div className="mt-(--spacing-5) flex flex-col gap-(--spacing-6) xl:flex-row xl:items-start xl:gap-(--spacing-8)">
          <div className="min-w-0 flex-1">
            <TabsContent value="findings">
              {detail.findings.length === 0 ? (
                <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noFindings")}</p>
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
                        <span className="tabular-nums text-(--text-muted)">{group.items.length}</span>
                        <span aria-hidden="true" className="h-px flex-1 self-center bg-(--border-subtle)" />
                      </h3>
                      <ul className="flex flex-col gap-2">
                        {group.items.map(({ finding, index }) => {
                          // One identity for the rendered row: a payload id
                          // two findings share would otherwise fold them
                          // together, so position joins it — and the fold
                          // state, the React key and the body id all read it.
                          const findingKey = `${finding.finding_id || "finding"}-${index}`;
                          const open = openFindings[findingKey] ?? finding.severity === SEVERITY_KEYS.mustFix;
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
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="self-start text-(--text-muted)"
                                aria-expanded={open}
                                aria-controls={id}
                                aria-label={foldLabel(locale, open, finding.title, index + 1)}
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
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="reviews">
              {detail.reviews.length === 0 ? (
                <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noReviews")}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {detail.reviews.map((review, index) => {
                    // Position in the key keeps it unique; the identity claim
                    // is the remount — this tree is keyed on the PR, so a
                    // refetch's positional drift cannot survive into another
                    // mount and the fold state never crosses PRs.
                    const reviewKey = `${review.reviewed_at}-${review.head_sha}-${index}`;
                    const open = openReviews[reviewKey] ?? index === 0;
                    const id = recordId(baseId, reviewKey);
                    const attribution = reviewAttribution(locale, review);
                    return (
                      <li
                        key={reviewKey}
                        className={cn(
                          "flex flex-col gap-2 rounded-(--radius-container) border border-(--border-default) bg-(--surface-card) px-4 py-3.5",
                          index === 0 ? "border-(--border-strong)" : "",
                        )}
                      >
                        <div
                          data-slot="review-head"
                          className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-(length:--typo-label-12-size) leading-(--typo-label-12-line)"
                        >
                          {/* A coerced-empty verdict is no verdict: no pill,
                              and the row starts at its attribution. */}
                          {review.verdict === "" ? null : (
                            <StatusBadge tone={verdictTone(review.verdict)}>{review.verdict}</StatusBadge>
                          )}
                          {/* An unattributed review (v1 records no model) gets
                              no empty span — the row starts at whatever it
                              does carry. */}
                          {attribution === "" ? null : (
                            <span className="text-(--text-muted)">{attribution}</span>
                          )}
                          <span className="ml-auto tabular-nums text-(--text-faint)" title={review.reviewed_at}>
                            {formatRelativeTime(review.reviewed_at, locale)}
                          </span>
                          {review.head_sha === "" ? null : (
                            <span
                              data-slot="head-sha"
                              className="rounded-(--radius-control) border border-(--border-default) px-1.5 py-0.5 font-mono text-(--text-muted)"
                              title={t(locale, "pullRequests.headSha")}
                            >
                              {review.head_sha.slice(0, 7)}
                            </span>
                          )}
                        </div>
                        <p
                          id={id}
                          hidden={!open}
                          className="whitespace-pre-wrap break-words text-sm text-(--text-secondary)"
                        >
                          {review.summary_md}
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="self-start text-(--text-muted)"
                          aria-expanded={open}
                          aria-controls={id}
                          aria-label={foldLabel(
                            locale,
                            open,
                            [review.verdict, review.head_sha.slice(0, 7)].filter((part) => part !== "").join(" · "),
                            index + 1,
                          )}
                          onClick={() => setOpenReviews((previous) => ({ ...previous, [reviewKey]: !open }))}
                        >
                          <ChevronRight aria-hidden="true" className={cn("transition-transform", open && "rotate-90")} />
                          {t(locale, open ? "pullRequests.collapse" : "pullRequests.expand")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="failures">
              {detail.failures.length === 0 ? (
                <p className="text-sm text-(--text-muted)">{t(locale, "pullRequests.noFailures")}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {detail.failures.map((failure, index) => {
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
              )}
            </TabsContent>
          </div>

          <aside
            aria-label={t(locale, "pullRequests.asideFacts")}
            className="flex w-full shrink-0 flex-col gap-(--spacing-4) xl:w-64"
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
