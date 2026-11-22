import { useEffect, useState } from "react";
import { FlowSection } from "@design-system";
import { quotaSpent } from "../../store/quota-store";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import { fetchJson } from "../api";
import { apiBase } from "../workspace-base";
import { parseReviewUsage, type ReviewUsage } from "./data";
import { LoadFailedNotice, LoadingNotice, PageNotice } from "./PageNotice";

const SHARED_BOT_COPY: Record<ReviewUsage["sharedBot"], { value: DictionaryKey; hint?: DictionaryKey }> = {
  available: { value: "workspace.usageAvailable" },
  "not-in-plan": { value: "workspace.usageNotInPlan", hint: "workspace.usageNotInPlanHint" },
  "not-designated": { value: "workspace.usageNotDesignated", hint: "workspace.usageNotDesignatedHint" },
};

function credits(rp: number, rpPerCredit: number): string {
  return (rp / rpPerCredit).toFixed(2);
}

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
  const quota = usage?.quota ?? null;

  return (
    <FlowSection
      title={t(locale, quota === null ? "workspace.usageHeading" : "workspace.quotaHeading")}
      subtitle={
        usage === null
          ? undefined
          : t(locale, quota === null ? "workspace.usageWindow" : "workspace.quotaWindow", {
              month: usage.month,
            })
      }
    >
      {failed ? (
        <LoadFailedNotice locale={locale} />
      ) : usage === null || status === null ? (
        <LoadingNotice locale={locale} />
      ) : (
        <div className="flex flex-col gap-3">
          {quota === null ? null : (
            <>
              {quotaSpent(quota.usedRp, quota.limitRp) ? (
                <PageNotice
                  kind="warn"
                  message={t(locale, "workspace.quotaOverCeiling", {
                    month: usage.month,
                    reset: quota.resetOn,
                  })}
                />
              ) : null}
              <dl className="flex flex-col gap-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{t(locale, "workspace.quotaCreditsLabel")}</dt>
                  <dd className="font-medium tabular-nums">
                    {quota.limitRp === null
                      ? t(locale, "workspace.quotaNoLimit")
                      : t(locale, "workspace.quotaCredits", {
                          used: credits(quota.usedRp, quota.rpPerCredit),
                          limit: credits(quota.limitRp, quota.rpPerCredit),
                        })}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">{t(locale, "workspace.quotaSplitLabel")}</p>
                <dl className="flex flex-col gap-1 text-xs">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t(locale, "workspace.quotaSharedBot")}</dt>
                    <dd className="tabular-nums">{credits(quota.sharedRp, quota.rpPerCredit)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t(locale, "workspace.quotaByok")}</dt>
                    <dd className="tabular-nums">{credits(quota.byokRp, quota.rpPerCredit)}</dd>
                  </div>
                </dl>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(locale, "workspace.quotaVersion", {
                  version: `v${quota.profileVersion}`,
                  date: quota.profileFrom,
                })}
              </p>
            </>
          )}
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
          {quota === null ? null : (
            <p className="text-xs text-muted-foreground">{t(locale, "workspace.quotaBasis")}</p>
          )}
          {deploymentMode === "self-hosted" || status.hint === undefined ? null : (
            <p className="text-xs text-muted-foreground">{t(locale, status.hint)}</p>
          )}
        </div>
      )}
    </FlowSection>
  );
}
