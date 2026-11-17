/**
 * The 所有仓库 detail's 评审配置 tab: the workspace's OWN defaults, which is what
 * every inheriting repository runs with. Two differences from the per-target
 * tab decide this face:
 * - this page IS the default, so there is no inheritance switch — and no
 *   pause, which is a per-repository fact;
 * - a save names exactly one changed field on `POST /api/targets/defaults`,
 *   with no `follow` companion (nothing here inherits).
 *
 * Read-only for a caller who cannot manage the workspace: the route answers
 * 403, and the form is disabled from the boot membership role so that refusal
 * is not the only feedback.
 */
import { useState } from "react";
import { t, type Locale } from "../../i18n";
import { CardContent, CardHeader } from "@design-system";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { postJson } from "../api";
import { apiBase } from "../workspace-base";
import { isReviewLevel, isReviewTriggerMode, type ReviewLevel } from "./data";
import { settingsOpOutcome } from "./SettingsPage";
import type { OpNotice } from "./PageNotice";
import {
  ReviewPolicyFields,
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
    <SectionCard tier="secondary">
      <CardHeader>
        <SectionCardTitle>{t(locale, "targets.settings.heading")}</SectionCardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ReviewPolicyFields
          locale={locale}
          settings={defaults}
          levelDefault={defaults.review_level}
          readOnly={busy || !canManage}
          onSave={save}
        />
      </CardContent>
    </SectionCard>
  );
}
