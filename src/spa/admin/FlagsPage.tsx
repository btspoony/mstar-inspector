/**
 * Server flags — the three platform-wide switches (spec §3.1).
 *
 * A toggle writes ONE `PATCH /api/flags` and applies the accepted value without
 * a second read; the server pairs the write with its audit row, so this screen
 * owns no ledger logic. `review_global` carries the note the spec requires:
 * turning it off stops new enqueues and does not cancel queued work.
 */
import { useState } from "react";
import { Toggle } from "@/components/ui/toggle";
import type { Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import { AdminWriteError, readFlags, setFlag, useLoaded, type FlagRow } from "./api";
import { ConsolePath, Screen } from "./screen";

/** What each flag governs while it is off (spec §3.1). */
const EFFECTS: Record<string, string> = {
  review_global: "No new review is enqueued. The per-App pause switch is unchanged.",
  signup_open: "An unknown GitHub login cannot sign in for the first time. Existing accounts are unaffected.",
  workspace_creation_open: "No workspace can be created, the operator's own included.",
};

export function FlagsPage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readFlags);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function toggle(key: string, enabled: boolean) {
    setBusy(key);
    setRefusal(null);
    try {
      await setFlag(key, enabled);
      update((flags) => flags.map((flag) => (flag.key === key ? { ...flag, enabled } : flag)));
    } catch (error) {
      setRefusal(error instanceof AdminWriteError ? error.message : `Could not change ${key}.`);
    } finally {
      setBusy(null);
    }
  }

  const columns: DataTableColumn<FlagRow>[] = [
    {
      header: "Flag",
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <code className="text-sm">{row.key}</code>
          {row.key === "review_global" ? (
            <span className="text-xs text-muted-foreground">Queued work is not cancelled.</span>
          ) : null}
        </div>
      ),
    },
    {
      header: "Effect when off",
      cell: (row) => (
        <span className="text-sm text-muted-foreground">{EFFECTS[row.key] ?? "No documented effect."}</span>
      ),
    },
    {
      header: "State",
      cell: (row) => (
        <Toggle
          size="sm"
          variant="outline"
          pressed={row.enabled}
          disabled={busy !== null}
          aria-label={`${row.key} ${row.enabled ? "enabled" : "disabled"}`}
          onPressedChange={(next) => void toggle(row.key, next)}
        >
          {row.enabled ? "On" : "Off"}
        </Toggle>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Server flags"
        description="Platform-wide switches. A change applies to the next request and appends one audit row."
        actions={<ConsolePath page="flags" />}
      />
      <Screen state={state} failed="Could not load the server flags." onRetry={reload} locale={locale}>
        {(flags) => (
          <div className="flex flex-col gap-4">
            {refusal ? <PageNotice kind="error" message={refusal} /> : null}
            <DataTable
              columns={columns}
              rows={flags}
              rowKey={(row) => row.key}
              empty={<EmptyState title="No flags" description="This server exposes no platform switch." />}
            />
          </div>
        )}
      </Screen>
    </section>
  );
}
