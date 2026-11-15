/**
 * The workspace settings usage card: shared-bot vs own-bot reviews for the
 * current UTC month (spec bot-scope-and-claiming § Review usage).
 *
 * Read-only — the counts are what happened and the status row is why nothing
 * more can happen. The two unavailable states must not share copy: the plan
 * state is the reader's to change, while the designation state waits for a
 * platform operator and offers nothing to buy. `self-hosted` renders no status
 * row at all, because the console that designates a shared bot is not
 * registered in that mode — the own-bot count is the whole card there.
 *
 * This card counts PUBLISHED reviews (`reviews`). The members page's meter
 * counts review ATTEMPTS (`usage_events`), a different measure; the labels
 * here say `reviews` so the two numbers are never read as the same one.
 */
import { useEffect, useState } from "react";
import { FlowSection } from "@design-system";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import { fetchJson } from "../api";
import { apiBase } from "../workspace-base";
import { parseReviewUsage, type ReviewUsage } from "./data";
import { LoadFailedNotice, LoadingNotice } from "./PageNotice";

/** The shared-bot row's value and hint per state (the two states differ). */
const SHARED_BOT_COPY: Record<ReviewUsage["sharedBot"], { value: DictionaryKey; hint?: DictionaryKey }> = {
  available: { value: "workspace.usageAvailable" },
  "not-in-plan": { value: "workspace.usageNotInPlan", hint: "workspace.usageNotInPlanHint" },
  "not-designated": { value: "workspace.usageNotDesignated", hint: "workspace.usageNotDesignatedHint" },
};

export function ReviewUsageCard({
  locale,
  deploymentMode,
}: {
  locale: Locale;
  deploymentMode?: "self-hosted" | "saas";
}) {
  const [usage, setUsage] = useState<ReviewUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetchJson(`${apiBase()}/api/settings/review-usage`).then(
      (data) => {
        if (!live) return;
        const parsed = parseReviewUsage(data);
        if (parsed === null) setFailed(true);
        else {
          setFailed(false);
          setUsage(parsed);
        }
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const status = usage === null ? null : SHARED_BOT_COPY[usage.sharedBot];

  return (
    <FlowSection
      title={t(locale, "workspace.usageHeading")}
      subtitle={usage === null ? undefined : t(locale, "workspace.usageWindow", { month: usage.month })}
    >
      {failed ? (
        <LoadFailedNotice locale={locale} />
      ) : usage === null || status === null ? (
        <LoadingNotice locale={locale} />
      ) : (
        <div className="flex flex-col gap-2">
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t(locale, "workspace.usageSharedReviews")}</dt>
              <dd className="font-medium tabular-nums">{usage.sharedReviews}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t(locale, "workspace.usageOwnReviews")}</dt>
              <dd className="font-medium tabular-nums">{usage.ownReviews}</dd>
            </div>
            {deploymentMode === "self-hosted" ? null : (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t(locale, "workspace.usageSharedStatus")}</dt>
                <dd>{t(locale, status.value)}</dd>
              </div>
            )}
          </dl>
          {/* The hint explains the status row directly above it and is absent
              for `available`. */}
          {deploymentMode === "self-hosted" || status.hint === undefined ? null : (
            <p className="text-xs text-muted-foreground">{t(locale, status.hint)}</p>
          )}
        </div>
      )}
    </FlowSection>
  );
}
