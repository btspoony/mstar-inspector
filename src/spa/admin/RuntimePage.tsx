/**
 * Runtime parameters — the non-secret values an operator changes without a
 * redeploy (iteration spec §1.1, §2.4): the system review-concurrency cap,
 * the §7.10 Check budgets, the recheck seat's assignment budget (UTF-8 bytes of
 * ask the prior-findings seat may receive) and the default review depth Apps
 * without their own depth inherit.
 *
 * One save writes ONE `PATCH /api/runtime`; the server pairs the write with its
 * audit row, so this screen owns no ledger logic. Each field is a local draft
 * over the loaded value, so a reload cannot leave a stale value on screen.
 */
import { useState, type FormEvent } from "react";
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
} from "@design-system";
import { t, type DictionaryKey, type Locale } from "../../i18n";
import { APP_VERSION } from "../../version";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { useSaveSignal, type SaveStatus } from "../components/save-signal";
import { PageNotice, SaveInFlight } from "../pages/PageNotice";
import { concurrencySubmitBlocked } from "../pages/data";
import { formatRelativeTime } from "../relative-time";
import {
  AdminWriteError,
  readRuntime,
  setCheckBudgets,
  setCommentClaimSettings,
  setDefaultReviewLevel,
  setRecheckAssignmentMaxBytes,
  setSystemConcurrency,
  useLoaded,
  type AdmissionDropCounts,
  type CheckBudgetConfig,
  type CommentClaimConfig,
  type QueueBacklog,
  type RecheckAssignmentConfig,
  type ReviewLevelConfig,
} from "./api";
import { ConsolePath, Screen } from "./screen";

/** The operator's label for a stored tier; an unknown id stays untranslated. */
function levelLabel(locale: Locale, level: string): string {
  if (level === "quick") return t(locale, "admin.runtime.reviewLevelQuick");
  if (level === "deep") return t(locale, "admin.runtime.reviewLevelDeep");
  if (level === "default") return t(locale, "admin.runtime.reviewLevelStandard");
  return level;
}

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

export function RuntimePage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readRuntime);
  /** Only what the operator typed is local; the display falls back to the stored value. */
  const [draft, setDraft] = useState<string | null>(null);
  const [terminalizeDraft, setTerminalizeDraft] = useState<string | null>(null);
  const [updateDraft, setUpdateDraft] = useState<string | null>(null);
  const [retryDraft, setRetryDraft] = useState<string | null>(null);
  const [attemptsDraft, setAttemptsDraft] = useState<string | null>(null);
  const [outboxDraft, setOutboxDraft] = useState<string | null>(null);
  const [levelDraft, setLevelDraft] = useState<string | null>(null);
  const [recheckDraft, setRecheckDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Every card's save rides its own button: the signal drives the spinner →
  // check → alert face; the shared notice state carries the copy (the
  // success copy as assistive text, the failure as the persistent box).
  const concurrencySignal = useSaveSignal();
  const checkBudgetsSignal = useSaveSignal();
  const commentClaimSignal = useSaveSignal();
  const reviewLevelSignal = useSaveSignal();
  const recheckAssignmentSignal = useSaveSignal();
  // A save's outcome is reported INSIDE the card it belongs to, so a refusal —
  // the terminalize/update relation included — reads as that field's error
  // instead of a page-wide banner.
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    message: string;
    source: "concurrency" | "checkBudgets" | "commentClaim" | "reviewLevel" | "recheckAssignment";
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

  async function onSaveLevel(
    event: FormEvent<HTMLFormElement>,
    stored: ReviewLevelConfig,
  ): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double submit
    setBusy(true);
    setNotice(null);
    reviewLevelSignal.start();
    try {
      const saved = await setDefaultReviewLevel(levelDraft ?? stored.value, stored);
      // A 2xx rewrote the row, so it reads as trusted again.
      update((data) => ({ ...data, reviewLevel: saved }));
      setLevelDraft(null);
      setNotice({
        kind: "success",
        message: t(locale, "admin.runtime.reviewLevelSaved"),
        source: "reviewLevel",
      });
      reviewLevelSignal.succeed();
    } catch (error) {
      const generic = t(locale, "admin.runtime.reviewLevelFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
        source: "reviewLevel",
      });
      reviewLevelSignal.fail();
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
          // Same older-Worker rule for the default review depth.
          const level = data.reviewLevel;
          // And for the recheck seat's ask budget.
          const recheck = data.recheckAssignment;
          // And for the admission-drop counts.
          const drops = data.admissionDrops24h;
          // The live queue gauge; `null` is "not readable", never an empty queue.
          const queue = data.queue;
          return (
          <div className="flex flex-col gap-4">
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

            {level === null ? null : (
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.reviewLevelTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.reviewLevelDescription")}
                </p>
                {notice?.source === "reviewLevel" ? (
                  <CardOutcome notice={notice} status={reviewLevelSignal.status} />
                ) : null}
                {level.degraded ? (
                  // The stored row is unreadable, so the tier shown is the
                  // documented default — the same tier a review already runs.
                  <div className="mt-4">
                    <PageNotice
                      kind="warn"
                      message={t(locale, "admin.runtime.reviewLevelUnreadable")}
                    />
                  </div>
                ) : null}
                <form
                  className="mt-4 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => void onSaveLevel(event, level)}
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium" htmlFor="default-review-level">
                      {t(locale, "admin.runtime.reviewLevelLabel")}
                    </label>
                    <div className="w-64">
                      <Select
                        value={levelDraft ?? level.value}
                        onValueChange={setLevelDraft}
                        disabled={busy}
                      >
                        <SelectTrigger id="default-review-level">
                          <SelectValue>{levelLabel(locale, levelDraft ?? level.value)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {level.levels.map((option) => (
                            <SelectItem key={option} value={option}>
                              {levelLabel(locale, option)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button
                    type="submit"
                    disabled={busy}
                    status={reviewLevelSignal.status === "idle" ? undefined : reviewLevelSignal.status}
                  >
                    {t(locale, "admin.runtime.reviewLevelSave")}
                  </Button>
                  <SaveInFlight show={reviewLevelSignal.status === "loading"} locale={locale} />
                  {level.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
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
