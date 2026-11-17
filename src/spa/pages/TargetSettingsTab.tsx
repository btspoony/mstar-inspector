/**
 * The repository detail's 评审配置 tab: one target's review policy, read as what
 * the target RUNS with (`effective`) and, while it inherits, as the workspace
 * defaults beside it (D16 / product spec J4).
 *
 * Two facts decide the whole face:
 * - `follow_workspace_defaults === 1` means the row's own policy columns are
 *   inert, so the four policy controls render read-only over the effective
 *   values; turning inheritance off is itself the save that snapshots them.
 * - every policy save names exactly ONE field and says `follow: 0` — the server
 *   snapshots the fields the body omits from the values the target runs with
 *   now, so this page never has to echo values back.
 */
import { useEffect, useState } from "react";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import {
  Button,
  CardContent,
  CardHeader,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@design-system";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
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
};

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
    review_enabled: number;
    follow_workspace_defaults: number;
  };
  effective: TargetPolicySettings;
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
    row.check_pass_verdicts.every((verdict) => typeof verdict === "string")
  );
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
  if (typeof row.review_enabled !== "number") return null;
  if (typeof row.follow_workspace_defaults !== "number") return null;
  if (!isPolicySettings(effective) || !isPolicySettings(defaults)) return null;
  return {
    target: {
      target_id: row.target_id,
      repo_owner: repoOwner,
      repo_name: repoName,
      app_name: appName,
      review_enabled: row.review_enabled,
      follow_workspace_defaults: row.follow_workspace_defaults,
    },
    effective,
    defaults,
  };
}

/**
 * The copy the 评审配置 tab introduces has no dictionary key yet — plan 371.5
 * owns the i18n pass, so these three strings live here in one block. The page's
 * tab label reads the same map, so the tab and its panel heading cannot drift.
 *
 * shortcut: the tab's own copy is outside `src/i18n`; plan 371.5 moves it into
 * `targets.*` and deletes this map.
 */
export const TARGET_SETTINGS_COPY: Record<Locale, { heading: string; inherit: string; following: string }> = {
  en: {
    heading: "Review settings",
    inherit: "Follow workspace defaults",
    following:
      "Following the workspace defaults; turn inheritance off to override them individually.",
  },
  zh_CN: {
    heading: "评审配置",
    inherit: "继承工作区默认",
    following: "跟随工作区默认；关闭继承后可单独覆盖。",
  },
};

const TRIGGER_LABEL_KEYS: Record<ReviewTriggerMode, DictionaryKey> = {
  open: "settings.triggerModeOpen",
  every_push: "settings.triggerModeEveryPush",
  manual: "settings.triggerModeManual",
};

/** The switches are native binary controls bound to their label (the house
 *  primitives carry no switch, and a bespoke widget would only duplicate the
 *  keyboard and state handling the platform already gets right). */
const SWITCH_CLASS = "size-4 accent-(--tone-accent-solid)";

/**
 * The four policy controls — trigger, depth, the gate score and its verdicts —
 * as ONE unit, because the target tab and the workspace-defaults tab render
 * exactly these four and differ only in what a save says. The gate is the one
 * cluster with a draft (two fields, one button); every other control saves on
 * selection and reads its value from `settings`, so a failed save simply leaves
 * the stored value on screen.
 */
export function ReviewPolicyFields({
  locale,
  settings,
  levelDefault,
  readOnly,
  onSave,
}: {
  locale: Locale;
  settings: TargetPolicySettings;
  /** The level the depth select's inherit face names as the current default. */
  levelDefault: ReviewLevel | null;
  readOnly: boolean;
  /** The caller's save: the one changed field, and only that field. */
  onSave: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const [score, setScore] = useState(String(settings.check_min_score));
  const [verdicts, setVerdicts] = useState<string[]>([...settings.check_pass_verdicts]);
  const storedVerdicts = settings.check_pass_verdicts.join(",");
  useEffect(() => {
    setScore(String(settings.check_min_score));
    setVerdicts([...settings.check_pass_verdicts]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.check_min_score, storedVerdicts]);

  const level: ReviewDepthChoice = settings.review_level ?? REVIEW_DEPTH_INHERIT;
  const levelOptions = reviewDepthOptions(locale, levelDefault ?? "default");
  const levelLabel = t(locale, "settings.reviewDepth");

  function toggleVerdict(verdict: string): void {
    setVerdicts((current) =>
      current.includes(verdict)
        ? current.filter((entry) => entry !== verdict)
        : [...current, verdict],
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t(locale, "settings.triggerMode")}</span>
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
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{levelLabel}</span>
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
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">{t(locale, "settings.reviewGate")}</legend>
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
                // One entry per checked box, in the vocabulary's order.
                check_pass_verdicts: PR_VERDICTS.filter((verdict) => verdicts.includes(verdict)),
              })
            }
          >
            {t(locale, "settings.reviewGateSave")}
          </Button>
        </div>
      </fieldset>
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
  const copy = TARGET_SETTINGS_COPY[locale];
  const inheriting = target.follow_workspace_defaults === 1;
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

  /** A policy save: the one changed field plus `follow: 0` (the snapshot rule). */
  const savePolicy = (fields: Record<string, unknown>): Promise<void> =>
    save({ ...fields, follow: 0 });

  return (
    <SectionCard tier="secondary">
      <CardHeader>
        <SectionCardTitle>{copy.heading}</SectionCardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ReviewPolicyFields
          locale={locale}
          settings={effective}
          levelDefault={defaults.review_level}
          readOnly={busy || inheriting}
          onSave={savePolicy}
        />

        <label className="flex w-fit items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className={SWITCH_CLASS}
            checked={inheriting}
            disabled={busy}
            onChange={(event) => void save({ follow: event.target.checked ? 1 : 0 })}
          />
          {copy.inherit}
        </label>
        {inheriting ? <p className="text-sm text-muted-foreground">{copy.following}</p> : null}

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
      </CardContent>
    </SectionCard>
  );
}
