/**
 * Runtime parameters — the non-secret values an operator changes without a
 * redeploy (iteration spec §1.1, §2.4). Today that is one knob: the system
 * review-concurrency cap, which bounds every workspace cap.
 *
 * One save writes ONE `PATCH /api/runtime`; the server pairs the write with its
 * audit row, so this screen owns no ledger logic. The field is a local draft
 * over the loaded value, so a reload cannot leave a stale number on screen.
 */
import { useState, type FormEvent } from "react";
import { Button, CardContent, CardHeader, Input } from "@design-system";
import { t, type Locale } from "../../i18n";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { PageNotice } from "../pages/PageNotice";
import { concurrencySubmitBlocked } from "../pages/data";
import { AdminWriteError, readRuntime, setCheckBudgets, setSystemConcurrency, useLoaded, type CheckBudgetConfig } from "./api";
import { ConsolePath, Screen } from "./screen";

export function RuntimePage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readRuntime);
  /** Only what the operator typed is local; the display falls back to the stored value. */
  const [draft, setDraft] = useState<string | null>(null);
  const [terminalizeDraft, setTerminalizeDraft] = useState<string | null>(null);
  const [updateDraft, setUpdateDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

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
      setNotice({ kind: "success", message: t(locale, "admin.runtime.concurrencySaved") });
    } catch (error) {
      // Generic message primary, the server's own refusal text as secondary detail.
      const generic = t(locale, "admin.runtime.concurrencyFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
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
      setNotice({ kind: "success", message: t(locale, "admin.runtime.checkSaved") });
    } catch (error) {
      const generic = t(locale, "admin.runtime.checkFailed");
      setNotice({
        kind: "error",
        message:
          error instanceof AdminWriteError
            ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
            : generic,
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
          return (
          <div className="flex flex-col gap-4">
            {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
            <SectionCard tier="secondary">
              <CardHeader>
                <SectionCardTitle>{t(locale, "admin.runtime.concurrencyTitle")}</SectionCardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t(locale, "admin.runtime.concurrencyDescription")}
                </p>
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
          </div>
          );
        }}
      </Screen>
    </section>
  );
}
