import { useMemo, useState, type SubmitEvent } from "react";
import {
  Button,
  CardContent,
  CardHeader,
  Input,
  Toggle,
} from "@design-system";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import { RECONCILE_FIELDS, type ReconcileField, type ReconcileConfig, type ReconcileValues } from "../../contracts/reconcile-settings";
import { SWEEP_FIELDS, type SweepField, type SweepConfig, type SweepValues } from "../../contracts/sweep-settings";
import { DURATION_REPORT_CAP_MAX_MS, DURATION_REPORT_CAP_MIN_MS } from "../../contracts/duration-report";
import { APP_VERSION } from "../../version";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { useSaveSignal, type SaveStatus } from "../components/save-signal";
import { PageNotice, SaveInFlight } from "../pages/PageNotice";
import { concurrencySubmitBlocked } from "../pages/data";
import { formatRelativeTime } from "../relative-time";
import {
  AdminWriteError,
  readDurationReport,
  readRuntime,
  saveSweepSettings,
  setAttemptCap,
  saveReconcileSettings,
  setCheckBudgets,
  setCommentClaimSettings,
  setLostReplySettleMs,
  setMaintenance,
  setRecheckAssignmentMaxBytes,
  setSystemConcurrency,
  useLoaded,
  type AdmissionDropCounts,
  type AttemptCapConfig,
  type CheckBudgetConfig,
  type CommentClaimConfig,
  type DurationPercentiles,
  type LostReplySettleConfig,
  type MaintenanceConfig,
  type QueueBacklog,
  type RecheckAssignmentConfig,
  type ReviewsRunningAnswer,
  type ReviewsRunningConfig,
  type RouteWorkflowConfig,
} from "./api";
import { ConsolePath, Screen } from "./screen";

const ADMISSION_DROP_FIELDS = [
  { reason: "pr-held", label: "admin.runtime.admissionDropsPrHeld" },
  { reason: "system-cap", label: "admin.runtime.admissionDropsSystemCap" },
  { reason: "workspace-cap", label: "admin.runtime.admissionDropsWorkspaceCap" },
  { reason: "error", label: "admin.runtime.admissionDropsError" },
] as const satisfies ReadonlyArray<{ reason: keyof AdmissionDropCounts; label: DictionaryKey }>;

function oldestWait(locale: Locale, queue: QueueBacklog | null): string {
  if (queue === null) return t(locale, "admin.runtime.queueUnreadable");
  if (queue.oldestMessageTimestamp === null) return t(locale, "admin.runtime.queueEmpty");
  return formatRelativeTime(queue.oldestMessageTimestamp, locale);
}

function routeWorkflowStored(locale: Locale, gate: RouteWorkflowConfig): string {
  if (gate.reason === "untrusted") {
    return t(locale, "admin.runtime.routeWorkflowStoredUntrusted", { value: gate.rejected ?? "" });
  }
  if (gate.degraded) return t(locale, "admin.runtime.routeWorkflowStoredUnreadable");
  return gate.saved
    ? t(locale, "admin.runtime.routeWorkflowStoredSaved", { value: gate.mode })
    : t(locale, "admin.runtime.routeWorkflowStoredAbsent");
}

function routeWorkflowEffective(locale: Locale, gate: RouteWorkflowConfig): string {
  return t(
    locale,
    gate.mode === "on"
      ? "admin.runtime.routeWorkflowEffectiveOn"
      : "admin.runtime.routeWorkflowEffectiveOff",
  );
}

/** A failed read trusts no stored value; an invalid row distrusts only its own field. */
function sweepFieldUnreadable(sweep: SweepConfig, field: SweepField): boolean {
  return sweep.degraded && (sweep.invalid.length === 0 || sweep.invalid.includes(field));
}

const REVIEWS_ANSWER_KEYS: Record<ReviewsRunningAnswer, DictionaryKey> = {
  running: "admin.runtime.reviewsAnswerRunning",
  "paused-platform": "admin.runtime.reviewsAnswerPausedPlatform",
  "blocked-deployment-gate": "admin.runtime.reviewsAnswerBlockedDeploymentGate",
};

function reviewsPlatform(locale: Locale, platform: ReviewsRunningConfig["platform"]): string {
  if (platform.unreadable) return t(locale, "admin.runtime.reviewsPlatformUnreadable");
  return t(
    locale,
    platform.enabled ? "admin.runtime.reviewsPlatformOn" : "admin.runtime.reviewsPlatformOff",
  );
}

/**
 * The one answer to "are reviews running": the derived sentence plus the three
 * gate facts behind it. The paused-App count links to the App list instead of
 * repeating its per-App toggles here.
 */
function ReviewsRunningCard({
  locale,
  data,
  routeWorkflow,
}: {
  locale: Locale;
  data: ReviewsRunningConfig;
  routeWorkflow: RouteWorkflowConfig | null;
}) {
  return (
    <SectionCard tier="primary">
      <CardHeader>
        <SectionCardTitle>{t(locale, "admin.runtime.reviewsTitle")}</SectionCardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t(locale, "admin.runtime.reviewsDescription")}</p>
        <p className="mt-4 text-base font-medium" data-reviews-running="answer">
          {t(locale, REVIEWS_ANSWER_KEYS[data.answer])}
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t(locale, "admin.runtime.reviewsPlatformLabel")}</dt>
            <dd className="font-medium" data-reviews-running="platform">
              {reviewsPlatform(locale, data.platform)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t(locale, "admin.runtime.reviewsRouteLabel")}</dt>
            <dd className="font-medium" data-reviews-running="route">
              {t(locale, routeWorkflow === null
                ? "admin.runtime.reviewsRouteUnreadable"
                : routeWorkflow.mode === "on" && !routeWorkflow.degraded
                  ? "admin.runtime.reviewsRouteOn"
                  : "admin.runtime.reviewsRouteOff")}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">{t(locale, "admin.runtime.reviewsPausedAppsLabel")}</dt>
            <dd className="font-medium" data-reviews-running="paused-apps">
              {data.pausedApps === null
                ? t(locale, "admin.runtime.reviewsPausedAppsUnreadable")
                : data.pausedApps}
            </dd>
          </div>
        </dl>
        <a
          className="mt-4 inline-flex w-fit text-sm text-primary hover:underline"
          href="/_internal_admin/bots"
        >
          {t(locale, "admin.runtime.reviewsPausedAppsLink")}
        </a>
      </CardContent>
    </SectionCard>
  );
}

function CardOutcome({
  notice,
  status,
}: {
  notice: { kind: "success" | "error"; message: string } | null;
  status: SaveStatus;
}) {
  if (notice === null) return null;
  if (notice.kind === "success") {
    return status === "success" ? (
      <span role="status" className="sr-only">
        {notice.message}
      </span>
    ) : null;
  }
  return (
    <div className="mt-4">
      <PageNotice kind={notice.kind} message={notice.message} />
    </div>
  );
}

function DurationReportCard({ locale }: { locale: Locale }) {
  const [candidate, setCandidate] = useState("");
  const [capMs, setCapMs] = useState<number | null>(null);
  const read = useMemo(() => () => readDurationReport(capMs), [capMs]);
  const { state, reload } = useLoaded(read);
  const candidateValue = Number(candidate);
  const candidateValid =
    candidate.trim() !== "" &&
    Number.isInteger(candidateValue) &&
    candidateValue >= DURATION_REPORT_CAP_MIN_MS &&
    candidateValue <= DURATION_REPORT_CAP_MAX_MS;
  const formatMs = (value: number | null): string => (value === null ? "—" : `${Math.round(value)} ms`);

  return (
    <SectionCard tier="secondary">
      <CardHeader>
        <SectionCardTitle>{t(locale, "admin.runtime.durationTitle")}</SectionCardTitle>
      </CardHeader>
      <CardContent>
        {state.status === "loading" ? (
          <p className="text-sm text-muted-foreground">{t(locale, "common.loading")}</p>
        ) : state.status === "error" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">{t(locale, "common.loadFailed")}</p>
            <Button type="button" variant="secondary" onClick={reload}>
              {t(locale, "common.retry")}
            </Button>
          </div>
        ) : (
          (() => {
            const report = state.data;
            const rows: ReadonlyArray<{ key: string; label: DictionaryKey; value: DurationPercentiles | null }> = [
              { key: "total", label: "admin.runtime.durationTotal", value: report.total },
              { key: "queue-wait", label: "admin.runtime.durationQueueWait", value: report.phases.queueWait },
              { key: "execution", label: "admin.runtime.durationExecution", value: report.phases.execution },
              { key: "publication", label: "admin.runtime.durationPublication", value: report.phases.publication },
            ];
            const cutoff = report.cutoff;
            const excluded = report.excluded;
            const excludedTotal =
              excluded["check-open-at-settle"] +
              excluded["no-settlement-record"] +
              excluded["no-boundary"] +
              excluded.unsettled +
              excluded["pre-prepare"];
            const excludedParams = {
              checkOpen: excluded["check-open-at-settle"],
              recordMissing: excluded["no-settlement-record"],
              noBoundary: excluded["no-boundary"],
              unsettled: excluded.unsettled,
              prePrepare: excluded["pre-prepare"],
            };
            return (
              <>
                <p className="text-sm text-muted-foreground" data-duration="description">
                  {t(locale, "admin.runtime.durationDescription", { days: report.window.days })}
                </p>
                {report.sampleSize === 0 ? (
                  <p className="mt-4 text-sm font-medium" data-duration="empty">
                    {excludedTotal === 0
                      ? t(locale, "admin.runtime.durationEmpty")
                      : t(locale, "admin.runtime.durationEmptyExcluded", {
                          n: excludedTotal,
                          ...excludedParams,
                        })}
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-muted-foreground" data-duration="sample">
                      {t(locale, "admin.runtime.durationSample", { n: report.sampleSize })}
                    </p>
                    <table className="mt-3 w-full text-sm">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="py-1 font-normal" />
                          <th className="py-1 font-normal">{t(locale, "admin.runtime.durationP50")}</th>
                          <th className="py-1 font-normal">{t(locale, "admin.runtime.durationP90")}</th>
                          <th className="py-1 font-normal">{t(locale, "admin.runtime.durationMax")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.key} className="border-t border-(--border-subtle)">
                            <td className="py-1 text-muted-foreground">{t(locale, row.label)}</td>
                            <td className="py-1 font-medium" data-duration={`${row.key}-p50`}>
                              {formatMs(row.value?.p50Ms ?? null)}
                            </td>
                            <td className="py-1 font-medium" data-duration={`${row.key}-p90`}>
                              {formatMs(row.value?.p90Ms ?? null)}
                            </td>
                            <td className="py-1 font-medium" data-duration={`${row.key}-max`}>
                              {formatMs(row.value?.maxMs ?? null)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(locale, "admin.runtime.durationBuckets")}
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground" data-duration="excluded">
                      {t(locale, "admin.runtime.durationExcluded", excludedParams)}
                    </p>
                  </>
                )}
                <p className="mt-2 text-xs text-muted-foreground" data-duration="failure-tail">
                  {t(locale, "admin.runtime.durationFailureTail")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground" data-duration="settlement-basis">
                  {t(locale, "admin.runtime.durationSettlementBasis")}
                </p>
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (candidateValid) setCapMs(candidateValue);
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="duration-candidate-cap">
                      {t(locale, "admin.runtime.durationCandidateLabel")}
                    </label>
                    <Input
                      id="duration-candidate-cap"
                      className="w-48"
                      inputMode="numeric"
                      autoComplete="off"
                      value={candidate}
                      onChange={(event) => setCandidate(event.target.value)}
                    />
                    {candidate.trim() !== "" && !candidateValid ? (
                      <p className="text-xs text-(--tone-warn-fg)" data-duration="candidate-range">
                        {t(locale, "admin.runtime.durationCandidateRange", {
                          min: DURATION_REPORT_CAP_MIN_MS,
                          max: DURATION_REPORT_CAP_MAX_MS,
                        })}
                      </p>
                    ) : null}
                  </div>
                  <Button type="submit" variant="secondary" disabled={!candidateValid}>
                    {t(locale, "admin.runtime.durationCandidateApply")}
                  </Button>
                </form>
                {cutoff === null ? null : (
                  <div className="mt-3 text-sm" data-duration="cutoff">
                    {report.sampleSize === 0 ? (
                      <p>{t(locale, "admin.runtime.durationCutoffEmpty")}</p>
                    ) : cutoff.over === 0 ? (
                      <p>{t(locale, "admin.runtime.durationCutoffNone", { cap: cutoff.capMs })}</p>
                    ) : (
                      <p>
                        {t(locale, "admin.runtime.durationCutoff", {
                          cap: cutoff.capMs,
                          over: cutoff.over,
                          n: report.sampleSize,
                          share: cutoff.share === null ? "—" : `${(cutoff.share * 100).toFixed(1)}%`,
                        })}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(locale, "admin.runtime.durationCrossed", {
                        queueWait: cutoff.crossed.queueWait,
                        execution: cutoff.crossed.execution,
                        publication: cutoff.crossed.publication,
                      })}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(locale, "admin.runtime.durationCaveat")}
                    </p>
                  </div>
                )}
              </>
            );
          })()
        )}
      </CardContent>
    </SectionCard>
  );
}

export function RuntimePage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readRuntime);
  const [draft, setDraft] = useState<string | null>(null);
  const [terminalizeDraft, setTerminalizeDraft] = useState<string | null>(null);
  const [updateDraft, setUpdateDraft] = useState<string | null>(null);
  const [retryDraft, setRetryDraft] = useState<string | null>(null);
  const [attemptsDraft, setAttemptsDraft] = useState<string | null>(null);
  const [outboxDraft, setOutboxDraft] = useState<string | null>(null);
  const [reconcileDraft, setReconcileDraft] = useState<Partial<Record<ReconcileField, string>>>({});
  const [sweepDraft, setSweepDraft] = useState<Partial<Record<SweepField, string>>>({});
  const [recheckDraft, setRecheckDraft] = useState<string | null>(null);
  const [lostReplyDraft, setLostReplyDraft] = useState<string | null>(null);
  const [attemptCapDraft, setAttemptCapDraft] = useState<string | null>(null);
  const [attemptCapConfirming, setAttemptCapConfirming] = useState(false);
  const [attemptCapSaveUnknown, setAttemptCapSaveUnknown] = useState(false);
  const [attemptCapEcho, setAttemptCapEcho] = useState<number | null>(null);
  const [attemptCapChangedElsewhere, setAttemptCapChangedElsewhere] = useState<number | null>(null);
  const [maintenanceTarget, setMaintenanceTarget] = useState<boolean | null>(null);
  const [reasonDraft, setReasonDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const concurrencySignal = useSaveSignal();
  const checkBudgetsSignal = useSaveSignal();
  const commentClaimSignal = useSaveSignal();
  const reconcileSignal = useSaveSignal();
  const sweepSignal = useSaveSignal();
  const recheckAssignmentSignal = useSaveSignal();
  const lostReplySignal = useSaveSignal();
  const attemptCapSignal = useSaveSignal();
  const maintenanceSignal = useSaveSignal();
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    message: string;
    source:
      | "concurrency"
      | "checkBudgets"
      | "commentClaim"
      | "sweep"
      | "reconcile"
      | "recheckAssignment"
      | "lostReplySettle"
      | "attemptCap"
      | "maintenance";
  } | null>(null);

  async function onSubmit(
    event: SubmitEvent<HTMLFormElement>,
    stored: number,
    degraded: boolean,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (concurrencySubmitBlocked(degraded, draft)) return;
    const next = Number((draft ?? String(stored)).trim());
    setBusy(true);
    setNotice(null);
    concurrencySignal.start();
    try {
      const saved = await setSystemConcurrency(next);
      update((data) => ({ ...data, concurrency: saved, degraded: false }));
      setDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.concurrencySaved"),
        source: "concurrency",
      });
      concurrencySignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.concurrencyFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "concurrency",
      });
      concurrencySignal.fail();
    } finally {
      setBusy(false);
    }
  }

  async function onSaveBudgets(
    event: SubmitEvent<HTMLFormElement>,
    stored: CheckBudgetConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (
      concurrencySubmitBlocked(stored.degraded, terminalizeDraft) ||
      concurrencySubmitBlocked(stored.degraded, updateDraft)
    ) {
      return;
    }
    const terminalizeMs = Number((terminalizeDraft ?? String(stored.terminalizeMs)).trim());
    const updateMs = Number((updateDraft ?? String(stored.updateMs)).trim());
    setBusy(true);
    setNotice(null);
    checkBudgetsSignal.start();
    try {
      const saved = await setCheckBudgets({ terminalizeMs, updateMs }, stored);
      update((data) => ({ ...data, checkBudgets: saved }));
      setTerminalizeDraft(null);
      setUpdateDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.checkSaved"),
        source: "checkBudgets",
      });
      checkBudgetsSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.checkFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "checkBudgets",
      });
      checkBudgetsSignal.fail();
    } finally {
      setBusy(false);
    }
  }

  async function onSaveClaim(
    event: SubmitEvent<HTMLFormElement>,
    stored: CommentClaimConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (
      concurrencySubmitBlocked(stored.degraded, retryDraft) ||
      concurrencySubmitBlocked(stored.degraded, attemptsDraft) ||
      concurrencySubmitBlocked(stored.degraded, outboxDraft)
    ) {
      return;
    }
    const retryMs = Number((retryDraft ?? String(stored.retryMs)).trim());
    const maxAttempts = Number((attemptsDraft ?? String(stored.maxAttempts)).trim());
    const outboxCap = Number((outboxDraft ?? String(stored.outboxCap)).trim());
    setBusy(true);
    setNotice(null);
    commentClaimSignal.start();
    try {
      const saved = await setCommentClaimSettings({ retryMs, maxAttempts, outboxCap }, stored);
      update((data) => ({ ...data, commentClaim: saved }));
      setRetryDraft(null);
      setAttemptsDraft(null);
      setOutboxDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.claimSaved"),
        source: "commentClaim",
      });
      commentClaimSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.claimFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "commentClaim",
      });
      commentClaimSignal.fail();
    } finally {
      setBusy(false);
    }
  }

  async function onSaveReconcile(event: SubmitEvent<HTMLFormElement>, stored: ReconcileConfig): Promise<void> {
    event.preventDefault();
    if (busy || RECONCILE_FIELDS.some((field) => concurrencySubmitBlocked(stored.degraded, reconcileDraft[field] ?? null))) {
      return;
    }
    const values = {} as ReconcileValues;
    for (const field of RECONCILE_FIELDS) {
      values[field] = Number(reconcileDraft[field] ?? stored.values[field]);
    }
    setBusy(true);
    setNotice(null);
    reconcileSignal.start();
    try {
      await saveReconcileSettings(values);
      update((data) => ({ ...data, reconcile: { ...stored, values, degraded: false } }));
      setReconcileDraft({});
      setNotice({ kind: "success", message: t(locale, "admin.runtime.reconcileSaved"), source: "reconcile" });
      reconcileSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.reconcileFailed");
      setNotice({
        kind: "error",
        message: error instanceof AdminWriteError
          ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
          : generic,
        source: "reconcile",
      });
      reconcileSignal.fail();
    } finally {
      setBusy(false);
    }
  }

  async function onSaveSweep(event: SubmitEvent<HTMLFormElement>, stored: SweepConfig): Promise<void> {
    event.preventDefault();
    if (busy || SWEEP_FIELDS.some((field) => concurrencySubmitBlocked(sweepFieldUnreadable(stored, field), sweepDraft[field] ?? null))) {
      return;
    }
    const values = {} as SweepValues;
    for (const field of SWEEP_FIELDS) {
      values[field] = Number(sweepDraft[field] ?? stored.values[field]);
    }
    setBusy(true);
    setNotice(null);
    sweepSignal.start();
    try {
      await saveSweepSettings(values);
      update((data) => ({ ...data, sweep: { ...stored, values, degraded: false, invalid: [] } }));
      setSweepDraft({});
      setNotice({ kind: "success", message: t(locale, "admin.runtime.sweepSaved"), source: "sweep" });
      sweepSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.sweepFailed");
      setNotice({
        kind: "error",
        message: error instanceof AdminWriteError
          ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
          : generic,
        source: "sweep",
      });
      sweepSignal.fail();
    } finally {
      setBusy(false);
    }
  }

  async function onSaveRecheck(
    event: SubmitEvent<HTMLFormElement>,
    stored: RecheckAssignmentConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (concurrencySubmitBlocked(stored.degraded, recheckDraft)) return;
    const maxBytes = Number((recheckDraft ?? String(stored.maxBytes)).trim());
    setBusy(true);
    setNotice(null);
    recheckAssignmentSignal.start();
    try {
      const saved = await setRecheckAssignmentMaxBytes(maxBytes, stored);
      update((data) => ({ ...data, recheckAssignment: saved }));
      setRecheckDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.recheckSaved"),
        source: "recheckAssignment",
      });
      recheckAssignmentSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.recheckFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "recheckAssignment",
      });
      recheckAssignmentSignal.fail();
    } finally {
      setBusy(false);
    }
  }

  async function onSaveLostReply(
    event: SubmitEvent<HTMLFormElement>,
    stored: LostReplySettleConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (concurrencySubmitBlocked(stored.degraded, lostReplyDraft)) return;
    const settleMs = Number((lostReplyDraft ?? String(stored.settleMs)).trim());
    setBusy(true);
    setNotice(null);
    lostReplySignal.start();
    try {
      const saved = await setLostReplySettleMs(settleMs, stored);
      update((data) => ({ ...data, lostReplySettle: saved }));
      setLostReplyDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.lostReplySaved"),
        source: "lostReplySettle",
      });
      lostReplySignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.lostReplyFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "lostReplySettle",
      });
      lostReplySignal.fail();
    } finally {
      setBusy(false);
    }
  }

  async function confirmAttemptCap(echo: number | null): Promise<boolean> {
    const fresh = await readRuntime().catch(() => null);
    if (!fresh?.attemptCap) return false;
    update(() => fresh);
    setAttemptCapConfirming(false);
    setAttemptCapSaveUnknown(false);
    setAttemptCapEcho(null);
    setAttemptCapChangedElsewhere(
      echo === null || fresh.attemptCap.degraded || fresh.attemptCap.capMs === echo
        ? null
        : fresh.attemptCap.capMs,
    );
    return true;
  }

  async function onRetryAttemptCap(): Promise<void> {
    if (busy || !attemptCapConfirming) return;
    setBusy(true);
    try {
      await confirmAttemptCap(attemptCapEcho);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveAttemptCap(
    event: SubmitEvent<HTMLFormElement>,
    stored: AttemptCapConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (concurrencySubmitBlocked(stored.degraded, attemptCapDraft)) return;
    const capMs = Number((attemptCapDraft ?? String(stored.capMs)).trim());
    setBusy(true);
    setNotice(null);
    attemptCapSignal.start();
    setAttemptCapConfirming(true);
    setAttemptCapSaveUnknown(false);
    try {
      const saved = await setAttemptCap(capMs, stored);
      setAttemptCapDraft(null);
      setAttemptCapEcho(saved.capMs);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.attemptCapSaved"),
        source: "attemptCap",
      });
      attemptCapSignal.succeed();
      await confirmAttemptCap(saved.capMs);
    } catch (error) {
      if (error instanceof AdminWriteError && error.status >= 400 && error.status < 500) {
        setAttemptCapSaveUnknown(false);
        setAttemptCapEcho(null);
        const generic = t(locale, "admin.runtime.attemptCapFailed");
        setNotice({
          kind: "error",
          message: `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`,
          source: "attemptCap",
        });
        attemptCapSignal.fail();
        await confirmAttemptCap(null);
      } else {
        setAttemptCapSaveUnknown(true);
        setAttemptCapEcho(null);
        attemptCapSignal.fail();
      }
    } finally {
      setBusy(false);
    }
  }
  async function onSaveMaintenance(stored: MaintenanceConfig, enabled: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    maintenanceSignal.start();
    try {
      const saved = await setMaintenance(
        enabled ? { enabled, reason: (reasonDraft ?? "").trim() || undefined } : { enabled },
        stored,
      );
      update((data) => ({ ...data, maintenance: saved }));
      setMaintenanceTarget(null);
      setReasonDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.maintenanceSaved"),
        source: "maintenance",
      });
      maintenanceSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.maintenanceFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "maintenance",
      });
      maintenanceSignal.fail();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.runtime")}
        description={t(locale, "admin.runtime.description")}
        actions={<ConsolePath page="runtime" />}
      />
      <Screen
        state={state}
        failed={t(locale, "admin.runtime.loadFailed")}
        onRetry={reload}
        locale={locale}
      >
        {(data) => {
          const budgets = data.checkBudgets;
          const claim = data.commentClaim;
          const sweep = data.sweep;
          const reconcile = data.reconcile;
          const recheck = data.recheckAssignment;
          const attemptCap = data.attemptCap;
          const lostReplySettle = data.lostReplySettle;
          const routeWorkflow = data.routeWorkflow;
          const drops = data.admissionDrops24h;
          const queue = data.queue;
          const reviewsRunning = data.reviewsRunning;
          const maintenance = data.maintenance;
          const maintenanceOn = maintenanceTarget ?? maintenance?.enabled ?? false;
          return (
          <div className="flex flex-col gap-4">
            {reviewsRunning === null ? null : (
              <ReviewsRunningCard locale={locale} data={reviewsRunning} routeWorkflow={routeWorkflow} />
            )}
            {maintenance === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.maintenanceTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.maintenanceDescription")}
                </p>
                {notice?.source === "maintenance" ? (
                  <CardOutcome notice={notice} status={maintenanceSignal.status} />
                ) : null}
                <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">{t(locale, "admin.flags.stateColumn")}</dt>
                    <dd className="font-medium" data-maintenance="state">
                      {t(
                        locale,
                        maintenance.unreadable
                          ? "admin.runtime.maintenanceStateUnreadable"
                          : maintenance.enabled
                            ? "admin.runtime.maintenanceStateOn"
                            : "admin.runtime.maintenanceStateOff",
                      )}
                    </dd>
                  </div>
                  {maintenance.enabled && maintenance.since !== null ? (
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">
                        {t(locale, "admin.runtime.maintenanceSinceLabel")}
                      </dt>
                      <dd className="font-medium" data-maintenance="since">
                        {formatRelativeTime(maintenance.since, locale)}
                      </dd>
                    </div>
                  ) : null}
                  {maintenance.enabled && maintenance.reason !== null ? (
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">
                        {t(locale, "admin.runtime.maintenanceReasonLabel")}
                      </dt>
                      <dd className="font-medium" data-maintenance="reason">
                        {maintenance.reason}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onSaveMaintenance(maintenance, maintenanceOn);
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="maintenance-reason">
                      {t(locale, "admin.runtime.maintenanceReasonLabel")}
                    </label>
                    <Input
                      id="maintenance-reason"
                      className="w-64"
                      autoComplete="off"
                      disabled={busy || !maintenanceOn}
                      value={reasonDraft ?? ""}
                      onChange={(event) => setReasonDraft(event.target.value)}
                    />
                  </div>
                  <Toggle
                    variant="outline"
                    pressed={maintenanceOn}
                    disabled={busy}
                    aria-label={t(locale, "admin.flags.stateAria", {
                      flag: t(locale, "admin.runtime.maintenanceTitle"),
                      state: t(
                        locale,
                        maintenanceOn ? "admin.runtime.maintenanceStateOn" : "admin.runtime.maintenanceStateOff",
                      ),
                    })}
                    onPressedChange={(next) => setMaintenanceTarget(next)}
                  >
                    {t(locale, maintenanceOn ? "admin.flags.stateOn" : "admin.flags.stateOff")}
                  </Toggle>
                  <Button
                    type="submit"
                    disabled={busy}
                    status={maintenanceSignal.status === "idle" ? undefined : maintenanceSignal.status}
                  >
                    {t(
                      locale,
                      maintenanceOn ? "admin.runtime.maintenanceOn" : "admin.runtime.maintenanceOff",
                    )}
                  </Button>
                  <SaveInFlight show={maintenanceSignal.status === "loading"} locale={locale} />
                </form>
              </CardContent>
            </SectionCard>
            )}

            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.concurrencyTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.concurrencyDescription")}
                </p>
                {notice?.source === "concurrency" ? (
                  <CardOutcome notice={notice} status={concurrencySignal.status} />
                ) : null}
                {data.degraded ? (
                  <div className="mt-4">
                    <PageNotice kind="warn" message={t(locale, "admin.runtime.concurrencyUnreadable")} />
                  </div>
                ) : null}
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => void onSubmit(event, data.concurrency, data.degraded)}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="system-concurrency">
                      {t(locale, "admin.runtime.concurrencyLabel")}
                    </label>
                    <Input
                      id="system-concurrency"
                      type="number"
                      min={data.min}
                      max={data.max}
                      className="w-32"
                      autoComplete="off"
                      required
                      value={draft ?? (data.degraded ? "" : String(data.concurrency))}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy}
                    status={concurrencySignal.status === "idle" ? undefined : concurrencySignal.status}
                  >
                    {t(locale, "admin.runtime.concurrencySave")}
                  </Button>
                  <SaveInFlight show={concurrencySignal.status === "loading"} locale={locale} />
                  {data.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
                </form>
                {data.degraded ? null : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(locale, "admin.runtime.concurrencyCurrent", { value: data.concurrency })}
                  </p>
                )}
              </CardContent>
            </SectionCard>
            {attemptCap === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.attemptCapTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.attemptCapDescription")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground" data-attempt-cap="range">
                  {t(locale, "admin.runtime.attemptCapRange", {
                    min: attemptCap.min,
                    max: attemptCap.max,
                    minMinutes: Math.round(attemptCap.min / 60_000),
                    maxMinutes: Math.round(attemptCap.max / 60_000),
                  })}
                </p>
                {notice?.source === "attemptCap" ? (
                  <CardOutcome notice={notice} status={attemptCapSignal.status} />
                ) : null}
                {attemptCap.degraded ? (
                  <div className="mt-4">
                    <PageNotice kind="warn" message={t(locale, "admin.runtime.attemptCapUnreadable")} />
                  </div>
                ) : attemptCapConfirming ? (
                  <div className="mt-4" data-attempt-cap="confirming">
                    {attemptCapSaveUnknown ? (
                      <p className="text-sm text-(--tone-warn-fg)" data-attempt-cap="unknown">
                        {t(locale, "admin.runtime.attemptCapUnknown")}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t(locale, "admin.runtime.attemptCapConfirming")}
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      className="mt-2"
                      data-attempt-cap="retry"
                      disabled={busy}
                      onClick={() => void onRetryAttemptCap()}
                    >
                      {t(locale, "common.retry")}
                    </Button>
                  </div>
                ) : null}
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => void onSaveAttemptCap(event, attemptCap)}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="attempt-cap-ms">
                      {t(locale, "admin.runtime.attemptCapLabel")}
                    </label>
                    <Input
                      id="attempt-cap-ms"
                      type="number"
                      min={attemptCap.min}
                      max={attemptCap.max}
                      className="w-40"
                      autoComplete="off"
                      required
                      disabled={busy || attemptCapConfirming}
                      value={
                        attemptCapConfirming
                          ? ""
                          : (attemptCapDraft ?? (attemptCap.degraded ? "" : String(attemptCap.capMs)))
                      }
                      onChange={(event) => setAttemptCapDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy || attemptCapConfirming}
                    status={attemptCapSignal.status === "idle" ? undefined : attemptCapSignal.status}
                  >
                    {t(locale, "admin.runtime.attemptCapSave")}
                  </Button>
                  <SaveInFlight show={attemptCapSignal.status === "loading"} locale={locale} />
                  {attemptCap.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
                </form>
                {attemptCap.degraded || attemptCapConfirming ? null : (
                  <>
                    <p className="mt-2 text-xs text-muted-foreground" data-attempt-cap="effective">
                      {t(
                        locale,
                        attemptCap.saved
                          ? "admin.runtime.attemptCapCurrentSaved"
                          : "admin.runtime.attemptCapCurrentDefault",
                        { value: attemptCap.capMs },
                      )}
                    </p>
                    {attemptCapChangedElsewhere === null ? null : (
                      <p className="mt-1 text-xs text-(--tone-warn-fg)" data-attempt-cap="changed-elsewhere">
                        {t(locale, "admin.runtime.attemptCapChangedElsewhere", {
                          value: attemptCapChangedElsewhere,
                        })}
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </SectionCard>
            )}
            {lostReplySettle === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.lostReplyTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.lostReplyDescription")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground" data-lost-reply="range">
                  {t(locale, "admin.runtime.lostReplyRange", {
                    min: lostReplySettle.min,
                    max: lostReplySettle.max,
                    minMinutes: Math.round(lostReplySettle.min / 60_000),
                    maxMinutes: Math.round(lostReplySettle.max / 60_000),
                  })}
                </p>
                {notice?.source === "lostReplySettle" ? (
                  <CardOutcome notice={notice} status={lostReplySignal.status} />
                ) : null}
                {lostReplySettle.degraded ? (
                  <div className="mt-4">
                    <PageNotice kind="warn" message={t(locale, "admin.runtime.lostReplyUnreadable")} />
                  </div>
                ) : null}
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => void onSaveLostReply(event, lostReplySettle)}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="lost-reply-settle-ms">
                      {t(locale, "admin.runtime.lostReplyLabel")}
                    </label>
                    <Input
                      id="lost-reply-settle-ms"
                      type="number"
                      min={lostReplySettle.min}
                      max={lostReplySettle.max}
                      className="w-40"
                      autoComplete="off"
                      required
                      value={lostReplyDraft ?? (lostReplySettle.degraded ? "" : String(lostReplySettle.settleMs))}
                      onChange={(event) => setLostReplyDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy}
                    status={lostReplySignal.status === "idle" ? undefined : lostReplySignal.status}
                  >
                    {t(locale, "admin.runtime.lostReplySave")}
                  </Button>
                  <SaveInFlight show={lostReplySignal.status === "loading"} locale={locale} />
                  {lostReplySettle.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
                </form>
                {lostReplySettle.degraded ? null : (
                  <p className="mt-2 text-xs text-muted-foreground" data-lost-reply="current">
                    {t(locale, "admin.runtime.lostReplyCurrent", { value: lostReplySettle.settleMs })}
                  </p>
                )}
              </CardContent>
            </SectionCard>
            )}
            {routeWorkflow === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.routeWorkflowTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.routeWorkflowDescription")}
                </p>
                <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {t(locale, "admin.runtime.routeWorkflowStoredLabel")}
                    </dt>
                    <dd className="font-medium" data-route-workflow="stored">
                      {routeWorkflowStored(locale, routeWorkflow)}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {t(locale, "admin.runtime.routeWorkflowEffectiveLabel")}
                    </dt>
                    <dd className="font-medium" data-route-workflow="effective">
                      {routeWorkflowEffective(locale, routeWorkflow)}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </SectionCard>
            )}
            {budgets === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.checkTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.checkDescription")}
                </p>
                {notice?.source === "checkBudgets" ? (
                  <CardOutcome notice={notice} status={checkBudgetsSignal.status} />
                ) : null}
                {budgets.degraded ? (
                  <div className="mt-4">
                    <PageNotice kind="warn" message={t(locale, "admin.runtime.checkUnreadable")} />
                  </div>
                ) : null}
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => void onSaveBudgets(event, budgets)}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="check-terminalize-budget">
                      {t(locale, "admin.runtime.terminalizeLabel")}
                    </label>
                    <Input
                      id="check-terminalize-budget"
                      type="number"
                      min={budgets.terminalizeMin}
                      max={budgets.terminalizeMax}
                      className="w-32"
                      autoComplete="off"
                      required
                      value={
                        terminalizeDraft ??
                        (budgets.degraded ? "" : String(budgets.terminalizeMs))
                      }
                      onChange={(event) => setTerminalizeDraft(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="check-update-budget">
                      {t(locale, "admin.runtime.updateLabel")}
                    </label>
                    <Input
                      id="check-update-budget"
                      type="number"
                      min={budgets.updateMin}
                      max={budgets.updateMax}
                      className="w-32"
                      autoComplete="off"
                      required
                      value={
                        updateDraft ??
                        (budgets.degraded ? "" : String(budgets.updateMs))
                      }
                      onChange={(event) => setUpdateDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy}
                    status={checkBudgetsSignal.status === "idle" ? undefined : checkBudgetsSignal.status}
                  >
                    {t(locale, "admin.runtime.checkSave")}
                  </Button>
                  <SaveInFlight show={checkBudgetsSignal.status === "loading"} locale={locale} />
                  {budgets.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
                </form>
                {budgets.degraded ? null : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(locale, "admin.runtime.checkCurrent", {
                      terminalize: budgets.terminalizeMs,
                      update: budgets.updateMs,
                    })}
                  </p>
                )}
              </CardContent>
            </SectionCard>
            )}
            {claim === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.claimTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.claimDescription")}
                </p>
                {notice?.source === "commentClaim" ? (
                  <CardOutcome notice={notice} status={commentClaimSignal.status} />
                ) : null}
                {claim.degraded ? (
                  <div className="mt-4">
                    <PageNotice kind="warn" message={t(locale, "admin.runtime.claimUnreadable")} />
                  </div>
                ) : null}
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => void onSaveClaim(event, claim)}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="claim-retry-budget">
                      {t(locale, "admin.runtime.retryLabel")}
                    </label>
                    <Input
                      id="claim-retry-budget"
                      type="number"
                      min={claim.retryMin}
                      max={claim.retryMax}
                      className="w-36"
                      autoComplete="off"
                      required
                      value={retryDraft ?? (claim.degraded ? "" : String(claim.retryMs))}
                      onChange={(event) => setRetryDraft(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="claim-attempts-budget">
                      {t(locale, "admin.runtime.attemptsLabel")}
                    </label>
                    <Input
                      id="claim-attempts-budget"
                      type="number"
                      min={claim.attemptsMin}
                      max={claim.attemptsMax}
                      className="w-24"
                      autoComplete="off"
                      required
                      value={attemptsDraft ?? (claim.degraded ? "" : String(claim.maxAttempts))}
                      onChange={(event) => setAttemptsDraft(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="claim-outbox-budget">
                      {t(locale, "admin.runtime.outboxLabel")}
                    </label>
                    <Input
                      id="claim-outbox-budget"
                      type="number"
                      min={claim.outboxMin}
                      max={claim.outboxMax}
                      className="w-24"
                      autoComplete="off"
                      required
                      value={outboxDraft ?? (claim.degraded ? "" : String(claim.outboxCap))}
                      onChange={(event) => setOutboxDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy}
                    status={commentClaimSignal.status === "idle" ? undefined : commentClaimSignal.status}
                  >
                    {t(locale, "admin.runtime.claimSave")}
                  </Button>
                  <SaveInFlight show={commentClaimSignal.status === "loading"} locale={locale} />
                  {claim.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
                </form>
                {claim.degraded ? null : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(locale, "admin.runtime.claimCurrent", {
                      retry: claim.retryMs,
                      attempts: claim.maxAttempts,
                      outbox: claim.outboxCap,
                    })}
                  </p>
                )}
              </CardContent>
            </SectionCard>
            )}

            {reconcile === null ? null : (
              <SectionCard tier="secondary">
                <CardHeader>
                  <SectionCardTitle>{t(locale, "admin.runtime.reconcileTitle")}</SectionCardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{t(locale, "admin.runtime.reconcileDescription")}</p>
                  {notice?.source === "reconcile" ? <CardOutcome notice={notice} status={reconcileSignal.status} /> : null}
                  {reconcile.degraded ? (
                    <div className="mt-4">
                      <PageNotice kind="warn" message={t(locale, "admin.runtime.reconcileUnreadable")} />
                    </div>
                  ) : null}
                  <form className="mt-4 space-y-4" onSubmit={(event) => void onSaveReconcile(event, reconcile)}>
                    <div className="grid max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {RECONCILE_FIELDS.map((field) => (
                        <div className="flex flex-col gap-1.5" key={field}>
                          <label className="text-sm font-medium" htmlFor={`reconcile-${field}`}>
                            {t(locale, `admin.runtime.reconcileFields.${field}`)}
                          </label>
                          <Input
                            id={`reconcile-${field}`}
                            type="number"
                            min={reconcile.limits[field].min}
                            max={reconcile.limits[field].max}
                            autoComplete="off"
                            required
                            disabled={busy}
                            value={reconcileDraft[field] ?? (reconcile.degraded ? "" : String(reconcile.values[field]))}
                            onChange={(event) => {
                              const value = event.target.value;
                              setReconcileDraft((drafts) => ({ ...drafts, [field]: value }));
                            }}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="submit"
                        disabled={busy}
                        status={reconcileSignal.status === "idle" ? undefined : reconcileSignal.status}
                      >
                        {t(locale, "admin.runtime.reconcileSave")}
                      </Button>
                      <SaveInFlight show={reconcileSignal.status === "loading"} locale={locale} />
                      {reconcile.degraded ? (
                        <Button type="button" variant="secondary" onClick={reload}>
                          {t(locale, "common.retry")}
                        </Button>
                      ) : null}
                    </div>
                  </form>
                </CardContent>
              </SectionCard>
            )}

            {sweep === null ? null : (
              <SectionCard tier="secondary">
                <CardHeader>
                  <SectionCardTitle>{t(locale, "admin.runtime.sweepTitle")}</SectionCardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{t(locale, "admin.runtime.sweepDescription")}</p>
                  {notice?.source === "sweep" ? <CardOutcome notice={notice} status={sweepSignal.status} /> : null}
                  {sweep.degraded ? (
                    <div className="mt-4">
                      <PageNotice
                        kind="warn"
                        message={
                          sweep.invalid.length > 0
                            ? t(locale, "admin.runtime.sweepInvalidRows", {
                                fields: new Intl.ListFormat(locale === "zh_CN" ? "zh-CN" : "en").format(
                                  sweep.invalid.map((field) => t(locale, `admin.runtime.sweepFields.${field}`)),
                                ),
                              })
                            : t(locale, "admin.runtime.sweepUnreadable")
                        }
                      />
                    </div>
                  ) : null}
                  <form className="mt-4 space-y-4" onSubmit={(event) => void onSaveSweep(event, sweep)}>
                    <div className="grid max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {SWEEP_FIELDS.map((field) => {
                        const invalid = sweep.degraded && sweep.invalid.includes(field);
                        return (
                          <div className="flex flex-col gap-1.5" key={field}>
                            <label className="text-sm font-medium" htmlFor={`sweep-${field}`}>
                              {t(locale, `admin.runtime.sweepFields.${field}`)}
                            </label>
                            <Input
                              id={`sweep-${field}`}
                              type="number"
                              min={sweep.limits[field].min}
                              max={sweep.limits[field].max}
                              autoComplete="off"
                              required
                              disabled={busy}
                              aria-invalid={invalid || undefined}
                              aria-describedby={invalid ? `sweep-${field}-invalid` : undefined}
                              value={sweepDraft[field] ?? (sweepFieldUnreadable(sweep, field) ? "" : String(sweep.values[field]))}
                              onChange={(event) => {
                                const value = event.target.value;
                                setSweepDraft((drafts) => ({ ...drafts, [field]: value }));
                              }}
                            />
                            {invalid ? (
                              <p className="text-xs text-destructive" id={`sweep-${field}-invalid`}>
                                {t(locale, "admin.runtime.sweepInvalidField")}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="submit"
                        disabled={busy}
                        status={sweepSignal.status === "idle" ? undefined : sweepSignal.status}
                      >
                        {t(locale, "admin.runtime.sweepSave")}
                      </Button>
                      <SaveInFlight show={sweepSignal.status === "loading"} locale={locale} />
                      {sweep.degraded && sweep.invalid.length === 0 ? (
                        <Button type="button" variant="secondary" onClick={reload}>
                          {t(locale, "common.retry")}
                        </Button>
                      ) : null}
                    </div>
                  </form>
                </CardContent>
              </SectionCard>
            )}

            {recheck === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.recheckTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.recheckDescription")}
                </p>
                {notice?.source === "recheckAssignment" ? (
                  <CardOutcome notice={notice} status={recheckAssignmentSignal.status} />
                ) : null}
                {recheck.degraded ? (
                  <div className="mt-4">
                    <PageNotice kind="warn" message={t(locale, "admin.runtime.recheckUnreadable")} />
                  </div>
                ) : null}
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => void onSaveRecheck(event, recheck)}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="recheck-assignment-bytes">
                      {t(locale, "admin.runtime.recheckLabel")}
                    </label>
                    <Input
                      id="recheck-assignment-bytes"
                      type="number"
                      min={recheck.min}
                      max={recheck.max}
                      className="w-40"
                      autoComplete="off"
                      required
                      value={recheckDraft ?? (recheck.degraded ? "" : String(recheck.maxBytes))}
                      onChange={(event) => setRecheckDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy}
                    status={recheckAssignmentSignal.status === "idle" ? undefined : recheckAssignmentSignal.status}
                  >
                    {t(locale, "admin.runtime.recheckSave")}
                  </Button>
                  <SaveInFlight show={recheckAssignmentSignal.status === "loading"} locale={locale} />
                  {recheck.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
                </form>
                {recheck.degraded ? null : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(locale, "admin.runtime.recheckCurrent", { value: recheck.maxBytes })}
                  </p>
                )}
              </CardContent>
            </SectionCard>
            )}
            {drops === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.admissionDropsTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.admissionDropsDescription")}
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  {ADMISSION_DROP_FIELDS.map(({ reason, label }) => (
                    <div key={reason} className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">{t(locale, label)}</dt>
                      <dd className="text-lg font-medium" data-admission-drops={reason}>
                        {drops[reason]}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </SectionCard>
            )}
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.queueTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.queueDescription")}
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {t(locale, "admin.runtime.queueBacklogLabel")}
                    </dt>
                    <dd className="text-lg font-medium" data-queue="backlog">
                      {queue === null
                        ? t(locale, "admin.runtime.queueUnreadable")
                        : queue.backlogCount}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {t(locale, "admin.runtime.queueOldestLabel")}
                    </dt>
                    <dd className="text-lg font-medium" data-queue="oldest">
                      {oldestWait(locale, queue)}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {t(locale, "admin.runtime.githubRateLimitedLabel")}
                    </dt>
                    <dd className="text-lg font-medium" data-queue="rate-limited">
                      {data.githubRateLimited24h}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </SectionCard>
            <DurationReportCard locale={locale} />
          </div>
          );
        }}
      </Screen>
      <p className="text-xs text-muted-foreground">
        {t(locale, "admin.runtime.version", { version: `v${APP_VERSION}` })}
      </p>
    </section>
  );
}
