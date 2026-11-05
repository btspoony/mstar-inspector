/**
 * Runtime parameters — the non-secret values an operator changes without a
 * redeploy (iteration spec §1.1, §2.4): the system review-concurrency cap,
 * the §7.10 Check budgets and the default review depth Apps without their own
 * depth inherit (plan 036a).
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
import { t, type Locale } from "../../i18n";
import { APP_VERSION } from "../../version";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { PageNotice } from "../pages/PageNotice";
import { concurrencySubmitBlocked } from "../pages/data";
import {
  AdminWriteError,
  readRuntime,
  setCheckBudgets,
  setDefaultReviewLevel,
  setSystemConcurrency,
  useLoaded,
  type CheckBudgetConfig,
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

export function RuntimePage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readRuntime);
  /** Only what the operator typed is local; the display falls back to the stored value. */
  const [draft, setDraft] = useState<string | null>(null);
  const [terminalizeDraft, setTerminalizeDraft] = useState<string | null>(null);
  const [updateDraft, setUpdateDraft] = useState<string | null>(null);
  const [levelDraft, setLevelDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A save's outcome is reported INSIDE the card it belongs to, so a refusal —
  // the terminalize/update relation included — reads as that field's error
  // instead of a page-wide banner.
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    message: string;
    source: "concurrency" | "checkBudgets" | "reviewLevel";
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
          // Same older-Worker rule for the default review depth.
          const level = data.reviewLevel;
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
                  <div className="mt-4">
                    <PageNotice kind={notice.kind} message={notice.message} />
                  </div>
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
                  <Button type="submit" disabled={busy}>
                    {t(locale, "admin.runtime.concurrencySave")}
                  </Button>
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
                  <div className="mt-4">
                    <PageNotice kind={notice.kind} message={notice.message} />
                  </div>
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
                  <Button type="submit" disabled={busy}>
                    {t(locale, "admin.runtime.checkSave")}
                  </Button>
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
                  <div className="mt-4">
                    <PageNotice kind={notice.kind} message={notice.message} />
                  </div>
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
                  <Button type="submit" disabled={busy}>
                    {t(locale, "admin.runtime.reviewLevelSave")}
                  </Button>
                  {level.degraded ? (
                    <Button type="button" variant="secondary" onClick={reload}>
                      {t(locale, "common.retry")}
                    </Button>
                  ) : null}
                </form>
              </CardContent>
            </SectionCard>
            )}
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
