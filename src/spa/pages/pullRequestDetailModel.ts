/**
 * The PR detail face's pure model.
 *
 * Everything here is data-in / text-out: severity grouping and order, the
 * family the face opens on, the timeline and its cap, attribution, verdict
 * tone, and the fold/copy labels. No React import — the component module owns
 * state, effects and JSX, and these rules are pinnable without a DOM.
 */
import { t, type Locale } from "../../i18n";
import { formatRelativeTime } from "../relative-time";
import type { PullRequestDetail, PullRequestFinding, PullRequestReview } from "./data";

/** The three record families the detail face switches between. */
export type RecordFamily = "findings" | "reviews" | "failures";

/**
 * Severity buckets in the order an operator asks about them. `severity` is a
 * free string in the payload, so the last bucket catches every spelling these
 * three do not name.
 */
export const SEVERITY_GROUPS = [
  { severity: "must-fix", labelKey: "pullRequests.severityMustFix", tone: "danger" },
  { severity: "should-fix", labelKey: "pullRequests.severityShouldFix", tone: "warn" },
  { severity: "nit", labelKey: "pullRequests.severityNit", tone: "neutral" },
] as const;

export type SeverityTone = (typeof SEVERITY_GROUPS)[number]["tone"];

export type SeverityGroup = {
  key: string;
  label: string;
  tone: SeverityTone;
  items: { finding: PullRequestFinding; index: number }[];
};

/**
 * True when a finding asks the operator to act: a must-fix or a should-fix.
 * A nit is not a requested change, so it neither opens the findings family nor
 * earns the trigger's danger dot.
 */
export function hasActionableFinding(detail: PullRequestDetail): boolean {
  return detail.findings.some(
    (finding) => finding.severity === "must-fix" || finding.severity === "should-fix",
  );
}

/** The family the face opens on: the actionable record first, history last. */
export function defaultFamily(detail: PullRequestDetail): RecordFamily {
  if (hasActionableFinding(detail)) return "findings";
  if (detail.failures.length > 0) return "failures";
  return "reviews";
}

/** Findings bucketed by severity, empty groups dropped, `other` last. */
export function severityGroups(
  locale: Locale,
  findings: readonly PullRequestFinding[],
): SeverityGroup[] {
  const indexed = findings.map((finding, index) => ({ finding, index }));
  const known = new Set(SEVERITY_GROUPS.map((group) => group.severity as string));
  const groups: SeverityGroup[] = SEVERITY_GROUPS.map((group) => ({
    key: group.severity as string,
    label: t(locale, group.labelKey),
    tone: group.tone,
    items: indexed.filter(({ finding }) => finding.severity === group.severity),
  }));
  const other = indexed.filter(({ finding }) => !known.has(finding.severity));
  if (other.length > 0) {
    groups.push({
      key: "other",
      label: t(locale, "pullRequests.severityOther"),
      tone: "neutral",
      items: other,
    });
  }
  return groups.filter((group) => group.items.length > 0);
}

/** A tone the timeline and the verdict surfaces can wear. */
export type ActivityTone = "danger" | "success" | "neutral";

/**
 * The one verdict-tone rule, for the band, the review row and the timeline
 * alike: `ship it` is success, any other non-empty verdict is danger — a
 * review that asked for changes is an alarm wherever its verdict is painted.
 * No verdict (`""`, the payload's coercion of a missing one) is neutral.
 */
export function verdictTone(verdict: string): ActivityTone {
  if (verdict === "") return "neutral";
  return verdict === "ship it" ? "success" : "danger";
}

/** `model · provider`, the separator dropped when the payload records no provider. */
export function reviewAttribution(locale: Locale, review: PullRequestReview): string {
  if (review.provider === "") return review.model;
  if (review.model === "") return review.provider;
  return t(locale, "pullRequests.reviewMeta", { model: review.model, provider: review.provider });
}

/**
 * A fold control's accessible name: the action plus the record it folds, so
 * the nine toggles on this face are told apart by what they open rather than
 * by nine identical "Expand"s. A record with no identity text (a coerced-empty
 * title or verdict) falls back to its position, which still keeps the name
 * distinct.
 */
export function foldLabel(
  locale: Locale,
  open: boolean,
  record: string,
  position: number,
): string {
  const action = t(locale, open ? "pullRequests.collapse" : "pullRequests.expand");
  return `${action} — ${record === "" ? `#${position}` : record}`;
}

/** The copy action's label: its action while idle, its transient outcome after a press. */
export function copyOutcomeLabel(
  locale: Locale,
  outcome: "copied" | "failed" | undefined,
): string {
  if (outcome === "copied") return t(locale, "pullRequests.copyCopied");
  if (outcome === "failed") return t(locale, "pullRequests.copyFailed");
  return t(locale, "pullRequests.copyError");
}

/**
 * The event-row cap: at most this many merged review/failure rows render, then
 * the PR's first-sighting row. The "earlier events not shown" note is one row
 * more, rendered only when the cap actually dropped an event — so the aside
 * renders `TIMELINE_LIMIT + 1` rows when the history fits the cap and
 * `TIMELINE_LIMIT + 2` at most, which is the DOM the cap tests pin.
 */
export const TIMELINE_LIMIT = 7;

/** How long the copy action's outcome stays on the button before it reverts. */
export const COPY_OUTCOME_MS = 2000;

/** One merged activity row: a review, a failure, or the PR's first sighting. */
export type ActivityEntry = {
  at: string;
  key: string;
  tone: ActivityTone;
  label: string;
  meta: string;
};

/**
 * The aside's one list, newest first. A truncation note says what the cap
 * dropped; it describes events NEWER than the first sighting, so it sits
 * directly above that row rather than under it.
 */
export type TimelineRow = ActivityEntry | { key: "timeline-truncated"; hidden: number };

/**
 * Derive the aside timeline: the merged review/failure history capped at
 * `TIMELINE_LIMIT`, the truncation note when the cap dropped anything, then the
 * PR's own first sighting as the anchor.
 */
export function timelineRows(locale: Locale, detail: PullRequestDetail): TimelineRow[] {
  const pr = detail.pull_request;
  // Both tables stamp `datetime('now')` (UTC), so the raw text orders
  // chronologically.
  const history: ActivityEntry[] = [
    ...detail.reviews.map((review, index) => {
      // The payload coerces an absent verdict to ""; a label of "Review · "
      // would paint a separator with nothing after it.
      const label =
        review.verdict === ""
          ? t(locale, "pullRequests.timelineReviewNoVerdict")
          : t(locale, "pullRequests.timelineReview", { verdict: review.verdict });
      // The same attribution the review head wears, so a provider-only review
      // names its provider here instead of an empty model.
      const attribution = reviewAttribution(locale, review);
      const when = formatRelativeTime(review.reviewed_at, locale);
      return {
        at: review.reviewed_at,
        key: `review-${index}`,
        tone: verdictTone(review.verdict),
        label,
        meta: attribution === "" ? when : `${when} · ${attribution}`,
      };
    }),
    ...detail.failures.map((failure, index) => ({
      at: failure.created_at,
      key: `failure-${index}`,
      tone: "danger" as const,
      label:
        failure.stage === ""
          ? t(locale, "pullRequests.timelineFailureNoStage")
          : t(locale, "pullRequests.timelineFailure", { stage: failure.stage }),
      meta: formatRelativeTime(failure.created_at, locale),
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const shown = history.slice(0, TIMELINE_LIMIT);
  const truncated: TimelineRow[] =
    history.length > shown.length
      ? [{ key: "timeline-truncated", hidden: history.length - shown.length }]
      : [];
  return [
    ...shown,
    ...truncated,
    {
      at: pr.first_seen_at,
      key: "first-seen",
      tone: "neutral",
      label: t(locale, "pullRequests.timelineFirstSeen"),
      meta: formatRelativeTime(pr.first_seen_at, locale),
    },
  ];
}
