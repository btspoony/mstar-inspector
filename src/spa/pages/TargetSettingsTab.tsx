import { useEffect, useState, type ReactNode } from "react";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import {
  Button,
  FlowSection,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@design-system";
import { AppInstallIdentity } from "../components/AppInstallIdentity";
import { postJson } from "../api";
import { apiBase } from "../workspace-base";
import {
  PR_VERDICTS,
  isReviewLevel,
  isReviewTriggerMode,
  type ReviewLevel,
  type ReviewTriggerMode,
} from "./data";
import {
  REVIEW_DEPTH_INHERIT,
  reviewDepthOptions,
  settingsOpOutcome,
  type ReviewDepthChoice,
} from "./SettingsPage";
import type { OpNotice } from "./PageNotice";

/**
 * The four policy answers as the server states them — `effective` and
 * `defaults` share this shape. `review_level: null` means "follow the operator
 * default", never "unset".
 */
export type TargetPolicySettings = {
  trigger_mode: ReviewTriggerMode;
  review_level: ReviewLevel | null;
  check_min_score: number;
  check_pass_verdicts: string[];
  check_pass_verdicts_readable: boolean;
};

/**
 * What the TARGET runs with: the four answers plus the draft switch, which is
 * a target-owned admission fact (D12). The workspace defaults answer no such
 * question, so the switch rides only this face.
 */
export type TargetPolicyEffective = TargetPolicySettings & { reviewDrafts: boolean };

/**
 * `GET /:ref/api/targets/:targetId`. Named apart from `data.ts`'s
 * `TargetSettingsPayload`, which is the App-settings payload's manage/blocked
 * union — a different wire face with a colliding name.
 */
export type TargetPolicyPayload = {
  target: {
    target_id: string;
    repo_owner: string | null;
    repo_name: string | null;
    app_name: string | null;
    app_id: number | null;
    app_avatar_url: string | null;
    review_enabled: number;
    follow_workspace_defaults: number;
    review_drafts: 0 | 1;
  };
  effective: TargetPolicyEffective;
  defaults: TargetPolicySettings;
};

function isPolicySettings(value: unknown): value is TargetPolicySettings {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    isReviewTriggerMode(row.trigger_mode) &&
    (row.review_level === null || isReviewLevel(row.review_level)) &&
    typeof row.check_min_score === "number" &&
    Array.isArray(row.check_pass_verdicts) &&
    row.check_pass_verdicts.every((verdict) => typeof verdict === "string") &&
    typeof row.check_pass_verdicts_readable === "boolean"
  );
}

function isEffectivePolicySettings(value: unknown): value is TargetPolicyEffective {
  if (!isPolicySettings(value)) return false;
  return "reviewDrafts" in value && typeof value.reviewDrafts === "boolean";
}

/**
 * The detail read, all-or-nothing: a payload missing `effective` or `defaults`
 * would render a policy nobody stored, so a drifted body is no payload (the
 * `parseTargets` rule). The read itself lives with the page.
 */
export function parseTargetPolicyPayload(data: unknown): TargetPolicyPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const { target, effective, defaults } = data as Record<string, unknown>;
  if (typeof target !== "object" || target === null) return null;
  const row = target as Record<string, unknown>;
  if (typeof row.target_id !== "string") return null;
  const repoOwner = row.repo_owner;
  const repoName = row.repo_name;
  const appName = row.app_name;
  if (repoOwner !== null && typeof repoOwner !== "string") return null;
  if (repoName !== null && typeof repoName !== "string") return null;
  if (appName !== null && typeof appName !== "string") return null;
  const appId = row.app_id;
  const appAvatarUrl = row.app_avatar_url;
  if (appId !== undefined && appId !== null && typeof appId !== "number") return null;
  if (appAvatarUrl !== undefined && appAvatarUrl !== null && typeof appAvatarUrl !== "string")
    return null;
  if (typeof row.review_enabled !== "number") return null;
  if (typeof row.follow_workspace_defaults !== "number") return null;
  const draftSwitch = row.review_drafts;
  if (draftSwitch !== 0 && draftSwitch !== 1) return null;
  if (!isEffectivePolicySettings(effective) || !isPolicySettings(defaults)) return null;
  return {
    target: {
      target_id: row.target_id,
      repo_owner: repoOwner,
      repo_name: repoName,
      app_name: appName,
      app_id: appId ?? null,
      app_avatar_url: appAvatarUrl ?? null,
      review_enabled: row.review_enabled,
      follow_workspace_defaults: row.follow_workspace_defaults,
      review_drafts: draftSwitch,
    },
    effective,
    defaults,
  };
}

const TRIGGER_LABEL_KEYS: Record<ReviewTriggerMode, DictionaryKey> = {
  open: "settings.triggerModeOpen",
  every_push: "settings.triggerModeEveryPush",
  manual: "settings.triggerModeManual",
};

const SWITCH_CLASS = "size-4 accent-(--tone-accent-solid)";

type ReviewPolicyProps = {
  locale: Locale;
  settings: TargetPolicySettings;
  levelDefault: ReviewLevel | null;
  readOnly: boolean;
  afterTrigger?: ReactNode;
  onSave: (fields: Record<string, unknown>) => Promise<void>;
};

export function ReviewTriggerField({
  locale,
  settings,
  readOnly,
  afterTrigger,
  onSave,
}: Pick<ReviewPolicyProps, "locale" | "settings" | "readOnly" | "afterTrigger" | "onSave">) {
  return (
    <>
      <div className="w-fit">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={settings.trigger_mode}
          disabled={readOnly}
          onValueChange={(value) => {
            if (value !== "") void onSave({ trigger_mode: value });
          }}
          aria-label={t(locale, "settings.triggerMode")}
        >
          {(Object.keys(TRIGGER_LABEL_KEYS) as ReviewTriggerMode[]).map((mode) => (
            <ToggleGroupItem key={mode} value={mode} title={mode}>
              {t(locale, TRIGGER_LABEL_KEYS[mode])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {afterTrigger}
    </>
  );
}

export function ReviewDepthField({
  locale,
  settings,
  levelDefault,
  readOnly,
  onSave,
}: Pick<ReviewPolicyProps, "locale" | "settings" | "levelDefault" | "readOnly" | "onSave">) {
  const level: ReviewDepthChoice = settings.review_level ?? REVIEW_DEPTH_INHERIT;
  const levelOptions = reviewDepthOptions(locale, levelDefault ?? "default");
  const levelLabel = t(locale, "settings.reviewDepth");
  return (
    <div className="w-fit max-w-xs">
      <Select
        value={level}
        disabled={readOnly}
        onValueChange={(value) => {
          void onSave({ review_level: value === REVIEW_DEPTH_INHERIT ? null : value });
        }}
      >
        <SelectTrigger aria-label={levelLabel}>
          <SelectValue>
            {levelOptions.find((option) => option.value === level)?.label ?? levelLabel}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {levelOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The gate is the one cluster with a draft (two fields, one button): the score
 * and the verdict set stage locally until the save. The fieldset's visible
 * title is the section heading, so `aria-label` names it instead of a legend.
 */
export function ReviewGateField({
  locale,
  settings,
  readOnly,
  onSave,
}: Pick<ReviewPolicyProps, "locale" | "settings" | "readOnly" | "onSave">) {
  const [score, setScore] = useState(String(settings.check_min_score));
  const [verdicts, setVerdicts] = useState<string[]>([...settings.check_pass_verdicts]);
  const storedVerdicts = settings.check_pass_verdicts.join(",");
  useEffect(() => {
    setScore(String(settings.check_min_score));
    setVerdicts([...settings.check_pass_verdicts]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // note: lint directive; the disabled rule is intentional at this call site.
  }, [settings.check_min_score, storedVerdicts]);

  function toggleVerdict(verdict: string): void {
    setVerdicts((current) =>
      current.includes(verdict)
        ? current.filter((entry) => entry !== verdict)
        : [...current, verdict],
    );
  }

  return (
    <fieldset className="flex flex-col gap-3" aria-label={t(locale, "settings.reviewGate")}>
      {settings.check_pass_verdicts_readable ? (
        <>
          <label className="flex w-fit flex-col gap-1.5 text-sm font-medium">
            {t(locale, "settings.reviewGateScore")}
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              className="w-28"
              value={score}
              disabled={readOnly}
              onChange={(event) => setScore(event.target.value)}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t(locale, "settings.reviewGateVerdicts")}</span>
            {PR_VERDICTS.map((verdict) => (
              <label key={verdict} className="flex w-fit items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className={SWITCH_CLASS}
                  checked={verdicts.includes(verdict)}
                  disabled={readOnly}
                  onChange={() => toggleVerdict(verdict)}
                />
                {verdict}
              </label>
            ))}
          </div>
          {verdicts.length === 0 ? (
            <p role="status" className="text-sm text-(--tone-warn-fg)">
              {t(locale, "settings.reviewGateFailClosed")}
            </p>
          ) : null}
          <div>
            <Button
              type="button"
              disabled={readOnly || score.trim() === "" || Number.isNaN(Number(score))}
              onClick={() =>
                void onSave({
                  check_min_score: Number(score),
                  check_pass_verdicts: PR_VERDICTS.filter((verdict) => verdicts.includes(verdict)),
                })
              }
            >
              {t(locale, "settings.reviewGateSave")}
            </Button>
          </div>
        </>
      ) : (
        <p role="status" className="text-sm text-(--tone-warn-fg)">
          {t(locale, "settings.reviewGateUnreadable")}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The three policy sections — trigger, depth, gate — assembled once for both
 * faces: the target tab and the workspace-defaults tab render the same titles
 * and controls and differ only in what a save says.
 */
export function ReviewPolicySections({
  locale,
  settings,
  levelDefault,
  readOnly,
  afterTrigger,
  onSave,
}: ReviewPolicyProps) {
  return (
    <>
      <FlowSection title={t(locale, "settings.triggerMode")}>
        <ReviewTriggerField
          locale={locale}
          settings={settings}
          readOnly={readOnly}
          afterTrigger={afterTrigger}
          onSave={onSave}
        />
      </FlowSection>
      <FlowSection title={t(locale, "settings.reviewDepth")}>
        <ReviewDepthField
          locale={locale}
          settings={settings}
          levelDefault={levelDefault}
          readOnly={readOnly}
          onSave={onSave}
        />
      </FlowSection>
      <FlowSection title={t(locale, "settings.reviewGate")}>
        <ReviewGateField locale={locale} settings={settings} readOnly={readOnly} onSave={onSave} />
      </FlowSection>
    </>
  );
}

export function TargetSettingsTab({
  locale,
  payload,
  onReload,
  onNotice,
}: {
  locale: Locale;
  payload: TargetPolicyPayload;
  onReload: (options?: { background?: boolean }) => Promise<boolean>;
  onNotice: (notice: OpNotice) => void;
}) {
  const { target, effective, defaults } = payload;
  const inheriting = target.follow_workspace_defaults === 1;
  const gateUnreadable = !effective.check_pass_verdicts_readable;
  const [busy, setBusy] = useState(false);
  const path = `${apiBase()}/api/targets/${encodeURIComponent(target.target_id)}`;

  async function save(fields: Record<string, unknown>): Promise<void> {
    setBusy(true);
    try {
      const { status, body } = await postJson(path, fields);
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

  const savePolicy = (fields: Record<string, unknown>): Promise<void> =>
    save({ ...fields, follow: 0 });

  const draftSwitch = (
    <label className="flex w-fit items-center gap-2 text-sm font-medium">
      <input
        type="checkbox"
        className={SWITCH_CLASS}
        checked={effective.reviewDrafts}
        disabled={busy}
        onChange={(event) => void save({ review_drafts: event.target.checked })}
      />
      {t(locale, "settings.reviewDrafts")}
    </label>
  );

  return (
    <div className="flex flex-col">
      <FlowSection title={t(locale, "targets.settings.boundApp")}>
        <AppInstallIdentity
          locale={locale}
          name={target.app_name ?? "—"}
          avatarSrc={target.app_avatar_url}
          appId={target.app_id ?? undefined}
          href={null}
        >
          <span className="text-sm text-muted-foreground">
            {t(locale, "targets.settings.boundAppPlanned")}
          </span>
        </AppInstallIdentity>
      </FlowSection>
      <ReviewPolicySections
        locale={locale}
        settings={effective}
        levelDefault={defaults.review_level}
        readOnly={busy || inheriting || gateUnreadable}
        afterTrigger={draftSwitch}
        onSave={savePolicy}
      />
      <FlowSection title={t(locale, "targets.settings.sectionState")}>
        <label className="flex w-fit items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className={SWITCH_CLASS}
            checked={inheriting}
            disabled={busy || gateUnreadable}
            onChange={(event) => void save({ follow: event.target.checked ? 1 : 0 })}
          />
          {t(locale, "targets.settings.follow")}
        </label>
        {inheriting ? (
          <p className="text-sm text-muted-foreground">{t(locale, "targets.settings.following")}</p>
        ) : null}

        <label className="flex w-fit items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className={SWITCH_CLASS}
            checked={target.review_enabled === 0}
            disabled={busy}
            onChange={(event) => void save({ review_enabled: event.target.checked ? 0 : 1 })}
          />
          {t(locale, target.review_enabled === 0 ? "settings.resumeReviews" : "settings.pauseReviews")}
        </label>
      </FlowSection>
    </div>
  );
}
