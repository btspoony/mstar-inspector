/**
 * Runtime parameters — the non-secret values an operator changes without a
 * redeploy (iteration spec §1.1, §2.4): the system review-concurrency cap,
 * the §7.10 Check budgets and the recheck seat's assignment budget (UTF-8
 * bytes of ask the prior-findings seat may receive).
 *
 * One save writes ONE `PATCH /api/runtime`; the server pairs the write with its
 * audit row, so this screen owns no ledger logic. Each field is a local draft
 * over the loaded value, so a reload cannot leave a stale value on screen.
 */
import { useMemo, useState, type FormEvent } from "react";
import {
  Button,
  CardContent,
  CardHeader,
  Input,
  Toggle,
} from "@design-system";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import { SWEEP_FIELDS, type SweepField, type SweepConfig, type SweepValues } from "../../contracts/sweep-settings";
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
  setCheckBudgets,
  setCommentClaimSettings,
  setMaintenance,
  setRecheckAssignmentMaxBytes,
  setSystemConcurrency,
  useLoaded,
  type AdmissionDropCounts,
  type AttemptCapConfig,
  type CheckBudgetConfig,
  type CommentClaimConfig,
  type DurationPercentiles,
  type MaintenanceConfig,
  type QueueBacklog,
  type RecheckAssignmentConfig,
} from "./api";
import { ConsolePath, Screen } from "./screen";

/** The admission-drop card's fixed reason order and its label per reason. */
const ADMISSION_DROP_FIELDS = [
  { reason: "pr-held", label: "admin.runtime.admissionDropsPrHeld" },
  { reason: "system-cap", label: "admin.runtime.admissionDropsSystemCap" },
  { reason: "workspace-cap", label: "admin.runtime.admissionDropsWorkspaceCap" },
  { reason: "error", label: "admin.runtime.admissionDropsError" },
] as const satisfies ReadonlyArray<{ reason: keyof AdmissionDropCounts; label: DictionaryKey }>;

/**
 * How long the oldest queued message has waited. An unreadable gauge and an
 * empty queue are different states, so neither renders as a bare absence.
 */
function oldestWait(locale: Locale, queue: QueueBacklog | null): string {
  if (queue === null) return t(locale, "admin.runtime.queueUnreadable");
  if (queue.oldestMessageTimestamp === null) return t(locale, "admin.runtime.queueEmpty");
  return formatRelativeTime(queue.oldestMessageTimestamp, locale);
}

/**
 * A runtime card's outcome face: errors keep the persistent notice box; a
 * success rides the save button (spinner → check) and its copy survives as
 * assistive text in a live region — never as a notice box.
 */
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

/**
 * The duration analysis card — the evidence for choosing the attempt cap.
 *
 * It renders what the server measured and nothing more: percentiles are `null`
 * when the window completed nothing (an empty sample, never zeros), and the
 * candidate read is an observation about the same sample, not a prediction.
 */
function DurationReportCard({ locale }: { locale: Locale }) {
  const [candidate, setCandidate] = useState("");
  const [capMs, setCapMs] = useState<number | null>(null);
  const read = useMemo(() => () => readDurationReport(capMs), [capMs]);
  const { state, reload } = useLoaded(read);
  const candidateValue = Number(candidate);
  const candidateValid = Number.isInteger(candidateValue) && candidateValue > 0;
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
                <p className="text-sm text-muted-foreground">
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
  /** Only what the operator typed is local; the display falls back to the stored value. */
  const [draft, setDraft] = useState<string | null>(null);
  const [terminalizeDraft, setTerminalizeDraft] = useState<string | null>(null);
  const [updateDraft, setUpdateDraft] = useState<string | null>(null);
  const [retryDraft, setRetryDraft] = useState<string | null>(null);
  const [attemptsDraft, setAttemptsDraft] = useState<string | null>(null);
  const [outboxDraft, setOutboxDraft] = useState<string | null>(null);
  const [sweepDraft, setSweepDraft] = useState<Partial<Record<SweepField, string>>>({});
  const [recheckDraft, setRecheckDraft] = useState<string | null>(null);
  const [attemptCapDraft, setAttemptCapDraft] = useState<string | null>(null);
  /**
   * The store's value when a save's re-read disagreed with the save's own echo:
   * another operator wrote the row while this page was open. The card keeps
   * showing the store's number and says so until the next save.
   */
  const [attemptCapChangedElsewhere, setAttemptCapChangedElsewhere] = useState<number | null>(null);
  /** The window's pending state: `null` = untouched, so the stored one shows. */
  const [maintenanceTarget, setMaintenanceTarget] = useState<boolean | null>(null);
  const [reasonDraft, setReasonDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Every card's save rides its own button: the signal drives the spinner →
  // check → alert face; the shared notice state carries the copy (the
  // success copy as assistive text, the failure as the persistent box).
  const concurrencySignal = useSaveSignal();
  const checkBudgetsSignal = useSaveSignal();
  const commentClaimSignal = useSaveSignal();
  const sweepSignal = useSaveSignal();
  const recheckAssignmentSignal = useSaveSignal();
  const attemptCapSignal = useSaveSignal();
  const maintenanceSignal = useSaveSignal();
  // A save's outcome is reported INSIDE the card it belongs to, so a refusal —
  // the terminalize/update relation included — reads as that field's error
  // instead of a page-wide banner.
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    message: string;
    source:
      | "concurrency"
      | "checkBudgets"
      | "commentClaim"
      | "sweep"
      | "recheckAssignment"
      | "attemptCap"
      | "maintenance";
  } | null>(null);

  async function onSubmit(
    event: FormEvent<HTMLFormElement>,
    stored: number,
    degraded: boolean,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    if (concurrencySubmitBlocked(degraded, draft)) return;
    // `Number("")` is 0 and `Number("8abc")` is NaN — both fail the server's
    // accepted-range gate, so the browser's own parsing needs no second validator.
    const next = Number((draft ?? String(stored)).trim());
    setBusy(true);
    setNotice(null);
    concurrencySignal.start();
    try {
      const saved = await setSystemConcurrency(next);
      // A 2xx rewrote exactly the level this page reports, so the row is
      // readable again: the server's answer replaces the value and clears the
      // flag that made the field start empty.
      update((data) => ({ ...data, concurrency: saved, degraded: false }));
      setDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.concurrencySaved"),
        source: "concurrency",
      });
      concurrencySignal.succeed();
    } catch (error) {
      // Generic message primary, the server's own refusal text as secondary detail.
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
    event: FormEvent<HTMLFormElement>,
    stored: CheckBudgetConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    if (
      concurrencySubmitBlocked(stored.degraded, terminalizeDraft) ||
      concurrencySubmitBlocked(stored.degraded, updateDraft)
    ) {
      return;
    }
    // Same browser-side parsing as the concurrency field: the server's range
    // gate is the only validator.
    const terminalizeMs = Number((terminalizeDraft ?? String(stored.terminalizeMs)).trim());
    const updateMs = Number((updateDraft ?? String(stored.updateMs)).trim());
    setBusy(true);
    setNotice(null);
    checkBudgetsSignal.start();
    try {
      const saved = await setCheckBudgets({ terminalizeMs, updateMs }, stored);
      // A 2xx rewrote both rows, so the card reads as trusted again.
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
    event: FormEvent<HTMLFormElement>,
    stored: CommentClaimConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    if (
      concurrencySubmitBlocked(stored.degraded, retryDraft) ||
      concurrencySubmitBlocked(stored.degraded, attemptsDraft) ||
      concurrencySubmitBlocked(stored.degraded, outboxDraft)
    ) {
      return;
    }
    // Same browser-side parsing as the sibling cards: the server's range gate
    // is the only validator.
    const retryMs = Number((retryDraft ?? String(stored.retryMs)).trim());
    const maxAttempts = Number((attemptsDraft ?? String(stored.maxAttempts)).trim());
    const outboxCap = Number((outboxDraft ?? String(stored.outboxCap)).trim());
    setBusy(true);
    setNotice(null);
    commentClaimSignal.start();
    try {
      const saved = await setCommentClaimSettings({ retryMs, maxAttempts, outboxCap }, stored);
      // A 2xx rewrote all three rows, so the card reads as trusted again.
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

  async function onSaveSweep(event: FormEvent<HTMLFormElement>, stored: SweepConfig): Promise<void> {
    event.preventDefault();
    if (busy || SWEEP_FIELDS.some((field) => concurrencySubmitBlocked(stored.degraded, sweepDraft[field] ?? null))) {
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
      update((data) => ({ ...data, sweep: { ...stored, values, degraded: false } }));
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
    event: FormEvent<HTMLFormElement>,
    stored: RecheckAssignmentConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    if (concurrencySubmitBlocked(stored.degraded, recheckDraft)) return;
    // Same browser-side parsing as the concurrency field: the server's range
    // gate is the only validator.
    const maxBytes = Number((recheckDraft ?? String(stored.maxBytes)).trim());
    setBusy(true);
    setNotice(null);
    recheckAssignmentSignal.start();
    try {
      const saved = await setRecheckAssignmentMaxBytes(maxBytes, stored);
      // A 2xx rewrote the row, so it reads as trusted again.
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

  async function onSaveAttemptCap(
    event: FormEvent<HTMLFormElement>,
    stored: AttemptCapConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    if (concurrencySubmitBlocked(stored.degraded, attemptCapDraft)) return;
    // Same browser-side parsing as the sibling fields: the server's range gate
    // is the only validator.
    const capMs = Number((attemptCapDraft ?? String(stored.capMs)).trim());
    setBusy(true);
    setNotice(null);
    attemptCapSignal.start();
    try {
      const saved = await setAttemptCap(capMs, stored);
      // The echo is what THIS request wrote; it is not what the row holds now.
      // Another operator may have written the cap since this page loaded, so the
      // card shows the store's answer and keeps a line when it differs.
      const fresh = await readRuntime().catch(() => null);
      if (fresh?.attemptCap) {
        update(() => fresh);
        setAttemptCapChangedElsewhere(
          fresh.attemptCap.degraded || fresh.attemptCap.capMs === saved.capMs
            ? null
            : fresh.attemptCap.capMs,
        );
      } else {
        // The write landed but the re-read did not: keep the accepted echo and
        // stop claiming a disagreement the card can no longer verify.
        setAttemptCapChangedElsewhere(null);
        update((data) => ({ ...data, attemptCap: saved }));
      }
      setAttemptCapDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.attemptCapSaved"),
        source: "attemptCap",
      });
      attemptCapSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.attemptCapFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "attemptCap",
      });
      attemptCapSignal.fail();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Close or reopen the platform. `enabled` is the state the operator asked
   * for; the reason rides only a close (the store drops it on reopen, so
   * sending it then would be dead input).
   */
  async function onSaveMaintenance(stored: MaintenanceConfig, enabled: boolean): Promise<void> {
    if (busy) return; // in-flight guard — no double submit
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
          // `null` = the server does not report the Check budgets (an older
          // Worker behind a newer SPA bundle): the budget card is absent, the
          // concurrency card is exactly as before, and nothing renders a bare
          // `undefined`.
          const budgets = data.checkBudgets;
          // Same absence rule for the migration-0048 card: an older Worker
          // behind this bundle reports no group, so the card is hidden.
          const claim = data.commentClaim;
          const sweep = data.sweep;
          // And for the recheck seat's ask budget.
          const recheck = data.recheckAssignment;
          // And the platform's one end-to-end attempt cap.
          const attemptCap = data.attemptCap;
          // And for the admission-drop counts.
          const drops = data.admissionDrops24h;
          // The live queue gauge; `null` is "not readable", never an empty queue.
          const queue = data.queue;
          // And for the maintenance window (older Worker → no card).
          const maintenance = data.maintenance;
          // The state the toggle shows: what the operator picked, else stored.
          const maintenanceOn = maintenanceTarget ?? maintenance?.enabled ?? false;
          return (
          <div className="flex flex-col gap-4">
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
                {/* The stored window as the gates read it: state, the operator's
                    own reason and when it opened — never the pending target. */}
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
                      // A reopen writes no reason (the store deletes it), so the
                      // field is inert until the operator is closing again.
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
                  // The stored cap could not be trusted, so `data.concurrency` is
                  // the conservative fallback: showing it as the current value
                  // would invite saving a number nobody stored. The form starts
                  // empty and withholds the "effective" line; a typed value or
                  // Retry both repair the state.
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
                  // While the row is unreadable admission refuses every
                  // delivery, so no effective value is claimed and the form
                  // starts empty; a typed value or Retry repairs the state.
                  <div className="mt-4">
                    <PageNotice kind="warn" message={t(locale, "admin.runtime.attemptCapUnreadable")} />
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
                      value={attemptCapDraft ?? (attemptCap.degraded ? "" : String(attemptCap.capMs))}
                      onChange={(event) => setAttemptCapDraft(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy}
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
                {attemptCap.degraded ? null : (
                  // The two copies are the whole point: a stored value says so,
                  // and an absent row says "default — nothing saved".
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
                      // Persistent, not a notice that disappears: the operator
                      // must know the number they just sent is not the one in force.
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
                  // Both numbers are the documented defaults, not the stored
                  // setting: the form starts empty so a save cannot pin them.
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
                  // Every number is the documented default, not the stored
                  // setting: the form starts empty so a save cannot pin them.
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
                      <PageNotice kind="warn" message={t(locale, "admin.runtime.sweepUnreadable")} />
                    </div>
                  ) : null}
                  <form className="mt-4 space-y-4" onSubmit={(event) => void onSaveSweep(event, sweep)}>
                    <div className="grid max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {SWEEP_FIELDS.map((field) => (
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
                            value={sweepDraft[field] ?? (sweep.degraded ? "" : String(sweep.values[field]))}
                            onChange={(event) => {
                              const value = event.target.value;
                              setSweepDraft((drafts) => ({ ...drafts, [field]: value }));
                            }}
                          />
                        </div>
                      ))}
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
                      {sweep.degraded ? (
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
                  // The number shown is the documented default, not the stored
                  // setting: the form starts empty so a save cannot pin it.
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
      {/* The deployment's release, from the generated src/version.ts surface:
          the same `vX.Y.Z` form as /healthz and the release tags. Build-time
          constant, so it renders in every read state. */}
      <p className="text-xs text-muted-foreground">
        {t(locale, "admin.runtime.version", { version: `v${APP_VERSION}` })}
      </p>
    </section>
  );
}
