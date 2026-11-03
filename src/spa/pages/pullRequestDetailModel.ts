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
import type {
  PullRequestCounts,
  PullRequestFailure,
  PullRequestFinding,
  PullRequestReview,
  PullRequestRow,
} from "./data";

/** The three record families the detail face switches between. */
export type RecordFamily = "findings" | "reviews" | "failures";

/** The three severity words this face names; every other spelling is `other`. */
export const SEVERITY_KEYS = {
  mustFix: "must-fix",
  shouldFix: "should-fix",
  nit: "nit",
} as const;

/**
 * The one actionability rule: every severity but a nit asks the operator to
 * act. The payload's severity is a free string, so a spelling this face does
 * not name (the `other` bucket, which the UI keeps visible rather than
 * dropping) is a requested change too — only the one word `nit` reads as no
 * action. The family the face opens on, the trigger's dot and every severity
 * bucket all read this predicate, so no two of them can disagree.
 */
export function isActionable(severity: string): boolean {
  return severity !== SEVERITY_KEYS.nit;
}

/**
 * Severity buckets in the order an operator asks about them. `severity` is a
 * free string in the payload; the table names three spellings and the catch-all
 * bucket (`OTHER_BUCKET`) collects every other one.
 *
 * | bucket     | membership                                  | actionable |
 * |------------|---------------------------------------------|------------|
 * | must-fix   | `severity === "must-fix"`                   | yes        |
 * | should-fix | `severity === "should-fix"`                 | yes        |
 * | nit        | `severity === "nit"`                        | no         |
 * | other      | every spelling the three above do not name  | yes        |
 *
 * Every `actionable` cell is `isActionable` applied to that bucket's findings:
 * a bucket is actionable when any finding in it is, so the table is a reading
 * of the rule, not a second one.
 */
export const SEVERITY_GROUPS = [
  { severity: SEVERITY_KEYS.mustFix, labelKey: "pullRequests.severityMustFix", tone: "danger" },
  { severity: SEVERITY_KEYS.shouldFix, labelKey: "pullRequests.severityShouldFix", tone: "warn" },
  { severity: SEVERITY_KEYS.nit, labelKey: "pullRequests.severityNit", tone: "neutral" },
] as const;

/** The bucket every spelling outside the table lands in, rendered last. */
const OTHER_BUCKET = {
  key: "other",
  labelKey: "pullRequests.severityOther",
  tone: "neutral",
} as const;

export type SeverityTone = (typeof SEVERITY_GROUPS)[number]["tone"];

export type SeverityGroup = {
  key: string;
  label: string;
  tone: SeverityTone;
  /** Whether the bucket asks for action — the same `isActionable` the dot reads. */
  actionable: boolean;
  items: { finding: PullRequestFinding; index: number }[];
};

/**
 * The family the face opens on. The head carries only totals, so the order is
 * the one the counts can answer: records first, history last. The findings
 * family is ensured first when it has any row, so its dot and its buckets are
 * the face's opening read.
 */
export function defaultFamily(counts: PullRequestCounts): RecordFamily {
  if (counts.findings > 0) return "findings";
  if (counts.reviews > 0) return "reviews";
  return "failures";
}

/** Findings bucketed by severity, empty groups dropped, `other` last. */
export function severityGroups(
  locale: Locale,
  findings: readonly PullRequestFinding[],
): SeverityGroup[] {
  const indexed = findings.map((finding, index) => ({ finding, index }));
  // One actionability derivation for every bucket, the catch-all included: a
  // bucket is actionable when one of its findings is, by `isActionable`.
  const actionable = (items: SeverityGroup["items"]) =>
    items.some(({ finding }) => isActionable(finding.severity));
  const known = new Set<string>(SEVERITY_GROUPS.map((group) => group.severity));
  const groups: SeverityGroup[] = SEVERITY_GROUPS.map((group) => {
    const items = indexed.filter(({ finding }) => finding.severity === group.severity);
    return {
      key: group.severity,
      label: t(locale, group.labelKey),
      tone: group.tone,
      actionable: actionable(items),
      items,
    };
  });
  const other = indexed.filter(({ finding }) => !known.has(finding.severity));
  if (other.length > 0) {
    groups.push({
      key: OTHER_BUCKET.key,
      label: t(locale, OTHER_BUCKET.labelKey),
      tone: OTHER_BUCKET.tone,
      actionable: actionable(other),
      items: other,
    });
  }
  return groups.filter((group) => group.items.length > 0);
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

/** `model · provider`, the separator dropped when the payload records no provider. */
export function reviewAttribution(locale: Locale, review: PullRequestReview): string {
  if (review.provider === "") return review.model;
  if (review.model === "") return review.provider;
  return t(locale, "pullRequests.reviewMeta", { model: review.model, provider: review.provider });
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
 * A fold control's accessible name: the action, the record it folds, and the
 * record's position. The position is the one identity every record has — the
 * same one its fold state is keyed by — so two records that share a title (or
 * a verdict and sha) still read as two controls, and a record with no identity
 * text (a coerced-empty title or verdict) is named by its position alone.
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
 * not loaded yet contributes nothing — the aside describes the reads the face
 * actually made, never rows it never fetched.
 */
export function timelineRows(
  locale: Locale,
  pr: PullRequestRow,
  reviews: readonly PullRequestReview[],
  failures: readonly PullRequestFailure[],
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
