/**
 * The PR detail face's pure model.
 *
 * Everything here is data-in / text-out: severity grouping and order, the
 * family the face opens on, the timeline and its cap, attribution, verdict
 * tone, and the fold/copy labels. No React import — the component module owns
 * state, effects and JSX, and these rules are pinnable without a DOM.
 */
import { FINDING_SEVERITIES, isFindingSeverity } from "../../contracts/finding-severity";
import { t, type Locale } from "../../i18n";
import { formatRelativeTime } from "../relative-time";
import { CATCH_ALL_SEVERITY } from "./data";
import type {
  PullRequestCounts,
  PullRequestFailure,
  PullRequestFinding,
  PullRequestHead,
  PullRequestReview,
} from "./data";

/** The three record families the detail face switches between. */
export type RecordFamily = "findings" | "reviews" | "failures";

/**
 * The severity buckets in the order an operator asks about them, built from
 * the shared merge-class vocabulary (`FINDING_SEVERITIES`) so a filter chip is
 * always a spelling the record route accepts. `severity` is a free string in
 * the payload; this table names the contract's classes and the catch-all
 * bucket (`OTHER_BUCKET`) collects every other one.
 */
const SEVERITY_PRESENTATION = {
  "must-fix": { labelKey: "pullRequests.severityMustFix", tone: "danger" },
  "should-fix": { labelKey: "pullRequests.severityShouldFix", tone: "warn" },
  "may-fix": { labelKey: "pullRequests.severityMayFix", tone: "warn" },
  nit: { labelKey: "pullRequests.severityNit", tone: "neutral" },
} as const;

export const SEVERITY_GROUPS = FINDING_SEVERITIES.map((severity) => ({
  severity,
  ...SEVERITY_PRESENTATION[severity],
}));

/** The bucket every spelling outside the table lands in, rendered last. */
const OTHER_BUCKET = {
  key: CATCH_ALL_SEVERITY,
  labelKey: "pullRequests.severityOther",
  tone: "neutral",
} as const;

/**
 * The findings filter's choices: the merge-class vocabulary, then the
 * catch-all bucket. The catch-all is a filter mode of its own (the route's
 * `unclassified` flag), so offering it here never asks the route to accept a
 * fifth severity spelling.
 */
export const SEVERITY_FILTER_OPTIONS = [
  ...SEVERITY_GROUPS.map(({ severity, labelKey }) => ({ key: severity, labelKey })),
  { key: OTHER_BUCKET.key, labelKey: OTHER_BUCKET.labelKey },
];

/** A tone a severity bucket can wear. */
export type SeverityTone = "danger" | "warn" | "neutral";

export type SeverityGroup = {
  key: string;
  label: string;
  tone: SeverityTone;
  items: { finding: PullRequestFinding; index: number }[];
};

/**
 * The family the face opens on. The head carries only totals, so the order is
 * the one the counts can answer: records first, history last. The findings
 * family is ensured first when it has any row, failures next, and reviews —
 * the history — only when the PR has nothing else.
 */
export function defaultFamily(counts: PullRequestCounts): RecordFamily {
  if (counts.findings > 0) return "findings";
  if (counts.failures > 0) return "failures";
  return "reviews";
}

/** Findings bucketed by severity, empty groups dropped, `other` last. */
export function severityGroups(
  locale: Locale,
  findings: readonly PullRequestFinding[],
): SeverityGroup[] {
  const indexed = findings.map((finding, index) => ({ finding, index }));
  const groups: SeverityGroup[] = SEVERITY_GROUPS.map((group) => ({
    key: group.severity,
    label: t(locale, group.labelKey),
    tone: group.tone,
    items: indexed.filter(({ finding }) => finding.severity === group.severity),
  }));
  const other = indexed.filter(({ finding }) => !isFindingSeverity(finding.severity));
  if (other.length > 0) {
    groups.push({
      key: OTHER_BUCKET.key,
      label: t(locale, OTHER_BUCKET.labelKey),
      tone: OTHER_BUCKET.tone,
      items: other,
    });
  }
  return groups.filter((group) => group.items.length > 0);
}

/** One rendered `label count` pair on a review row's second line. */
export type ReviewClassCount = { key: string; label: string; count: number };

/**
 * A review round's tally as the row's second line reads it: the merge-class
 * vocabulary in `SEVERITY_GROUPS` order (non-zero only), then one `other`
 * entry summing every spelling outside the vocabulary. M1-era rounds tallied
 * `critical | warning | suggestion | info`; those keys are not in the
 * vocabulary, so without this bucket they would render no breakdown at all.
 */
export function reviewClassCounts(
  locale: Locale,
  counts: Record<string, number>,
): ReviewClassCount[] {
  const rows: ReviewClassCount[] = SEVERITY_GROUPS.map((group) => ({
    key: group.severity,
    label: t(locale, group.labelKey),
    count: counts[group.severity] ?? 0,
  })).filter(({ count }) => count > 0);
  let other = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (!isFindingSeverity(key)) other += count;
  }
  if (other > 0) {
    rows.push({ key: OTHER_BUCKET.key, label: t(locale, OTHER_BUCKET.labelKey), count: other });
  }
  return rows;
}

/** A tone the timeline and the verdict surfaces can wear. */
export type ActivityTone = "danger" | "success" | "neutral";

/**
 * The one verdict-tone rule — the band, the review badge and the timeline dot
 * all read this table, so a verdict cannot be an alarm on one surface and
 * quiet on another. It names the whole known vocabulary: the current schema's
 * `ship it` / `needs fixes` / `blocked` / `incomplete` and the pre-v1 rows
 * that kept GitHub's review words. Anything outside the table — including
 * `""`, the payload's coercion of a missing verdict — is unknown, and an
 * unknown word is not an alarm.
 */
const VERDICT_TONES: Record<string, ActivityTone> = {
  "ship it": "success",
  approve: "success",
  "needs fixes": "danger",
  request_changes: "danger",
  blocked: "danger",
  incomplete: "danger",
  comment: "neutral",
  info: "neutral",
};

export function verdictTone(verdict: string): ActivityTone {
  return VERDICT_TONES[verdict] ?? "neutral";
}

/**
 * `model · provider`, the separator dropped when the payload records no
 * provider. Takes the attribution fields alone: the paged rows and the head's
 * newest review share them, and nothing else here.
 */
export function reviewAttribution(
  locale: Locale,
  review: { model: string; provider: string },
): string {
  if (review.provider === "") return review.model;
  if (review.model === "") return review.provider;
  // The configured head IS the serving provider when the round never switched:
  // rendering "provider/model" then prints the same name twice ("ark/ark/…").
  // Repairing it HERE also fixes rows already persisted with both values, and
  // leaves the stored `reviews.provider` contract untouched.
  if (review.provider === review.model) return review.model;
  return t(locale, "pullRequests.reviewMeta", { model: review.model, provider: review.provider });
}

/**
 * A round's wall clock as the row prints it: whole seconds under a minute,
 * otherwise `m`/`s`. Rounds run for minutes, not days, so no date library (and
 * no hour form) earns its place here; a sub-second run rounds to 0s.
 */
export function formatReviewDuration(locale: Locale, durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return t(locale, "pullRequests.reviewDurationSeconds", { seconds: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  return t(locale, "pullRequests.reviewDurationMinutes", { minutes, seconds: totalSeconds % 60 });
}

/** Characters an id may carry literally; anything else is escaped. */
const ID_LITERAL = /^[A-Za-z0-9-]$/;

/**
 * A record body's element id. The key is ENCODED rather than sanitized:
 * folding every run of other characters to one dash maps distinct keys
 * (`2026-11-01 08:00:00` and `2026-11-01-08:00:00`) onto one id, which
 * duplicates the DOM id and points `aria-controls` at another record's body.
 * An escape starts with `_`, which is never literal, so the encoding is
 * injective.
 */
export function recordId(baseId: string, key: string): string {
  let encoded = "";
  for (const char of key) {
    encoded += ID_LITERAL.test(char) ? char : `_${(char.codePointAt(0) ?? 0).toString(16)}_`;
  }
  return `${baseId}-${encoded}`;
}

/**
 * A fold control's accessible name: the action, the record it folds, and
 * the record's position. The position is the row's rendered order in its
 * group, so two records that share a title (or a verdict and sha) still read
 * as two controls, and a record with no identity text (a coerced-empty title
 * or verdict) is named by its position alone. It need not be the identity
 * the fold state is keyed by — findings key folding on the payload index
 * while announcing the rendered position.
 * The sentence's punctuation belongs to the locale keys, not to this function.
 */
export function foldLabel(
  locale: Locale,
  open: boolean,
  record: string,
  position: number,
): string {
  const action = t(locale, open ? "pullRequests.collapse" : "pullRequests.expand");
  return record === ""
    ? t(locale, "pullRequests.foldLabelBare", { action, position })
    : t(locale, "pullRequests.foldLabel", { action, record, position });
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
 * Derive the aside timeline from the LOADED pages: the merged review/failure
 * history capped at `TIMELINE_LIMIT`, the truncation note when the cap dropped
 * anything, then the PR's own first sighting as the anchor. A section that is
 * not loaded yet contributes no rows — the aside describes the reads the face
 * actually made — but the truncation count reads the per-section TOTALS, so it
 * reports the PR's real remaining history rather than the loaded window's.
 */
export function timelineRows(
  locale: Locale,
  pr: PullRequestHead,
  reviews: readonly PullRequestReview[],
  failures: readonly PullRequestFailure[],
  totals: PullRequestCounts,
): TimelineRow[] {
  // Both tables stamp `datetime('now')` (UTC), so the raw text orders
  // chronologically.
  const history: ActivityEntry[] = [
    ...reviews.map((review, index) => {
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
    ...failures.map((failure, index) => ({
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
  // `history` is the loaded window only (one page per family), so the events
  // beyond it are the sections' TOTALS minus the rows the window handed over.
  const hidden = totals.reviews + totals.failures - shown.length;
  const truncated: TimelineRow[] =
    hidden > 0 ? [{ key: "timeline-truncated", hidden }] : [];
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
