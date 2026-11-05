import { StatusBadge } from "@design-system";
import { t } from "../../i18n";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import type { PullRequestReviewing } from "./data";

/**
 * The reviewing-now marker both PR faces share (list row + detail header).
 *
 * ONE rule, per compass D11: only a `live` projection paints the badge, and it
 * carries the holding attempt's head sha — or, for a comment-triggered review
 * that carries none, its acquisition time. `none` paints NOTHING: a successful
 * read with no live lock is an ordinary idle PR and gets no queued,
 * superseded, or abandoned label of its own. `unknown` paints a quiet neutral
 * note so a failed inflight read can never be read as idle.
 *
 * Both strengths are `quiet` (edge + label, no tint): the filled soft face is
 * reserved for the PR's own state pill it sits beside.
 */
export function ReviewingBadge({
  locale,
  reviewing,
}: {
  locale: SpaBoot["locale"];
  reviewing: PullRequestReviewing;
}) {
  if (reviewing.state === "none") return null;
  if (reviewing.state === "unknown") {
    return (
      <StatusBadge
        tone="neutral"
        strength="quiet"
        title={t(locale, "pullRequests.reviewingUnknownHint")}
      >
        {t(locale, "pullRequests.reviewingUnknown")}
      </StatusBadge>
    );
  }
  const head = reviewing.head_sha.slice(0, 7);
  return (
    <StatusBadge tone="accent" strength="quiet">
      {head === ""
        ? t(locale, "pullRequests.reviewingSince", {
            time: formatRelativeTime(reviewing.acquired_at, locale),
          })
        : t(locale, "pullRequests.reviewingHead", { head })}
    </StatusBadge>
  );
}
