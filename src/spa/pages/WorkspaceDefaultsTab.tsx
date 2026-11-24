import { useState } from "react";
import { t, type Locale } from "../../i18n";
import { postJson } from "../api";
import { apiBase } from "../workspace-base";
import { isReviewLevel, isReviewTriggerMode, type ReviewLevel } from "./data";
import { settingsOpOutcome } from "./SettingsPage";
import type { OpNotice } from "./PageNotice";
import {
  ReviewAdmissionFields,
  ReviewPolicySections,
  type TargetPolicySettings,
} from "./TargetSettingsTab";

/** `GET /api/targets/all` — the workspace defaults the fixed list row opens. */
export type WorkspaceDefaultsPayload = {
  defaults: TargetPolicySettings;
  target_count: number;
};

/** All-or-nothing (the `parseTargets` rule): a drifted body is no payload. */
export function parseWorkspaceDefaults(data: unknown): WorkspaceDefaultsPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const { defaults, target_count } = data as Record<string, unknown>;
  if (typeof defaults !== "object" || defaults === null) return null;
  const row = defaults as Record<string, unknown>;
  if (
    !isReviewTriggerMode(row.trigger_mode) ||
    (row.review_level !== null && !isReviewLevel(row.review_level)) ||
    typeof row.check_min_score !== "number" ||
    !Array.isArray(row.check_pass_verdicts) ||
    !row.check_pass_verdicts.every((verdict) => typeof verdict === "string") ||
    typeof row.check_pass_verdicts_readable !== "boolean" ||
    typeof row.review_drafts !== "boolean" ||
    typeof row.review_enabled !== "boolean" ||
    typeof target_count !== "number"
  ) {
    return null;
  }
  return {
    defaults: {
      trigger_mode: row.trigger_mode,
      review_level: row.review_level as ReviewLevel | null,
      check_min_score: row.check_min_score,
      check_pass_verdicts: row.check_pass_verdicts as string[],
      check_pass_verdicts_readable: row.check_pass_verdicts_readable,
      review_drafts: row.review_drafts,
      review_enabled: row.review_enabled,
    },
    target_count,
  };
}

export function WorkspaceDefaultsTab({
  locale,
  payload,
  canManage,
  onReload,
  onNotice,
}: {
  locale: Locale;
  payload: WorkspaceDefaultsPayload;
  canManage: boolean;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
  onNotice: (notice: OpNotice) => void;
}) {
  const { defaults } = payload;
  const [busy, setBusy] = useState(false);

  async function save(fields: Record<string, unknown>): Promise<void> {
    setBusy(true);
    try {
      const { status, body } = await postJson(`${apiBase()}/api/targets/defaults`, fields);
      const outcome = settingsOpOutcome(locale, status, body);
      if (outcome.kind === "error") {
        onNotice(outcome);
        return;
      }
      await onReload({ background: true });
    } catch {
      onNotice({ kind: "error", message: t(locale, "common.saveFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col">
      <ReviewPolicySections
        locale={locale}
        settings={defaults}
        levelDefault={defaults.review_level}
        readOnly={busy || !canManage}
        afterTrigger={
          <ReviewAdmissionFields
            locale={locale}
            settings={defaults}
            readOnly={busy || !canManage}
            onSave={save}
          />
        }
        onSave={save}
      />
    </div>
  );
}
