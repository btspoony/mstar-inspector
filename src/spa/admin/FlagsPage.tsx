/**
 * Server flags — the three platform-wide switches (spec §3.1).
 *
 * A toggle asks first: clicking the state control opens an alertdialog that
 * names the flag, the ON → OFF (or reverse) change and the effect text, and
 * only the confirm button writes ONE `PATCH /api/flags`, applying the
 * accepted value without a second read. The server pairs the write with its
 * audit row, so this screen owns no ledger logic. `review_global` carries
 * the note the spec requires: turning it off stops new enqueues and does not
 * cancel queued work.
 */
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Toggle,
} from "@design-system";
import { t, type DictionaryKey } from "../../i18n";
import type { Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import { AdminWriteError, readFlags, setFlag, useLoaded, type FlagRow } from "./api";
import { ConsolePath, Screen } from "./screen";

/** What each flag governs while it is off (spec §3.1) — dictionary keys. */
const EFFECT_KEYS: Record<string, DictionaryKey> = {
  review_global: "admin.flags.effectReviewGlobal",
  signup_open: "admin.flags.effectSignupOpen",
  workspace_creation_open: "admin.flags.effectWorkspaceCreationOpen",
};

/** The write a pending confirmation dialog would commit on confirm. */
type PendingWrite = { key: string; enabled: boolean };

export function FlagsPage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readFlags);
  /** The row key currently being written — only that row disables. */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  /** The row that just saved, for the short inline confirmation. */
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  /** The "Saved." note is short-lived; the timer clears on change and unmount. */
  useEffect(() => {
    if (savedKey === null) return;
    const timer = setTimeout(() => setSavedKey(null), 3000);
    return () => clearTimeout(timer);
  }, [savedKey]);

  async function toggle({ key, enabled }: PendingWrite) {
    setBusyKey(key);
    setSavedKey(null);
    setRefusal(null);
    try {
      await setFlag(key, enabled);
      update((flags) => flags.map((flag) => (flag.key === key ? { ...flag, enabled } : flag)));
      setSavedKey(key);
    } catch (error) {
      // Generic message primary, the server's `{error}` text as secondary detail.
      const generic = t(locale, "admin.flags.toggleFailed", { flag: key });
      setRefusal(
        error instanceof AdminWriteError
          ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
          : generic,
      );
    } finally {
      setBusyKey(null);
    }
  }

  const columns: DataTableColumn<FlagRow>[] = [
    {
      header: t(locale, "admin.flags.flagColumn"),
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <code className="text-sm">{row.key}</code>
          {row.key === "review_global" ? (
            <span className="text-xs text-muted-foreground">{t(locale, "admin.flags.reviewGlobalNote")}</span>
          ) : null}
        </div>
      ),
    },
    {
      header: t(locale, "admin.flags.effectColumn"),
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {t(locale, EFFECT_KEYS[row.key] ?? "admin.flags.noDocumentedEffect")}
        </span>
      ),
    },
    {
      header: t(locale, "admin.flags.stateColumn"),
      cell: (row) => (
        <div className="flex items-center gap-2">
          <Toggle
            size="sm"
            variant="outline"
            pressed={row.enabled}
            disabled={busyKey === row.key}
            aria-label={t(locale, "admin.flags.stateAria", {
              flag: row.key,
              state: t(locale, row.enabled ? "admin.flags.stateOn" : "admin.flags.stateOff"),
            })}
            onPressedChange={(next) => setPending({ key: row.key, enabled: next })}
          >
            {t(locale, row.enabled ? "admin.flags.stateOn" : "admin.flags.stateOff")}
          </Toggle>
          {savedKey === row.key ? (
            <span className="text-xs text-muted-foreground">{t(locale, "admin.flags.saved")}</span>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.flags")}
        description={t(locale, "admin.flags.description")}
        actions={<ConsolePath page="flags" />}
      />
      <Screen
        state={state}
        failed={t(locale, "admin.flags.loadFailed")}
        onRetry={reload}
        locale={locale}
      >
        {(flags) => (
          <div className="flex flex-col gap-4">
            {refusal ? <PageNotice kind="error" message={refusal} /> : null}
            <DataTable
              columns={columns}
              rows={flags}
              rowKey={(row) => row.key}
              empty={
                <EmptyState
                  title={t(locale, "admin.flags.emptyTitle")}
                  description={t(locale, "admin.flags.emptyDescription")}
                />
              }
            />
          </div>
        )}
      </Screen>
      <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : setPending(null))}>
        {pending ? (
          <DialogContent role="alertdialog" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>
                {t(locale, "admin.flags.confirmTitle", {
                  flag: pending.key,
                  from: t(locale, pending.enabled ? "admin.flags.stateOff" : "admin.flags.stateOn"),
                  to: t(locale, pending.enabled ? "admin.flags.stateOn" : "admin.flags.stateOff"),
                })}
              </DialogTitle>
              <DialogDescription>
                {t(locale, EFFECT_KEYS[pending.key] ?? "admin.flags.noDocumentedEffect")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              {/* Cancel first: Radix focuses the first focusable node, so Escape-or-cancel stays the default. */}
              <Button type="button" variant="outline" size="sm" onClick={() => setPending(null)}>
                {t(locale, "admin.flags.cancelButton")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busyKey !== null}
                onClick={() => {
                  const write = pending;
                  setPending(null);
                  void toggle(write);
                }}
              >
                {t(locale, "admin.flags.confirmButton")}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}
