/**
 * Workspaces — every live tenant with its SQL-side counts, owner and resolved
 * plan (spec §3.3), and a plan picker per row that writes one `PATCH
 * /api/workspaces/:id/plan` (spec §3.2).
 *
 * A downgrade below the live member count is legal and this screen never
 * touches a membership: the server's seat guard only blocks NEW invites, which
 * is what the page description says.
 */
import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import { AdminWriteError, readWorkspaces, setPlan, useLoaded, type WorkspaceRow } from "./api";
import { ConsolePath, Screen } from "./screen";

/**
 * The plans the picker offers, in tier order, with the catalogue's display
 * names.
 * shortcut: mirrored from `plans` (migrations 0031/0032) — no admin read
 * exposes the catalogue. The row's own plan leads with the server's `planName`
 * (see `planOptions`), so a stored plan outside this list still renders and
 * keeps it. Add a `GET /api/plans` read when a tier ships without a UI change.
 */
const PLANS: readonly { id: string; name: string }[] = [
  { id: "free", name: "Free" },
  { id: "pro", name: "Pro" },
  { id: "unlimited", name: "Unlimited" },
];

/**
 * The options the picker shows: the row's own plan first (carrying the name the
 * server resolved, so a stored plan outside `PLANS` is never mislabelled), then
 * the rest of the catalogue.
 */
function planOptions(row: WorkspaceRow): readonly { id: string; name: string }[] {
  return [
    { id: row.planId, name: row.planName },
    ...PLANS.filter((plan) => plan.id !== row.planId),
  ];
}

/**
 * `<used> / <cap>` seat headroom. A NULL cap is unlimited, which is `—`; it
 * must never render as `0` (migration 0031: NULL means no limit).
 */
function seatHeadroom(row: WorkspaceRow): string {
  return row.includedMembers === null ? "—" : `${row.memberCount} / ${row.includedMembers}`;
}

export function WorkspacesPage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readWorkspaces);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function changePlan(target: WorkspaceRow, planId: string) {
    if (planId === target.planId) return;
    const previousId = target.planId;
    const previousName = target.planName;
    setBusy(target.id);
    setRefusal(null);
    // Optimistic: a controlled picker has to show the choice while the one
    // PATCH is in flight, and the label has to move with the id or the row's
    // own option would keep the old name. The seat cap is the server's answer,
    // so the accepted write re-reads instead of guessing it; a refusal puts
    // the stored pair back.
    const apply = (id: string, name: string) =>
      update((workspaces) =>
        workspaces.map((item) => (item.id === target.id ? { ...item, planId: id, planName: name } : item)),
      );
    apply(planId, PLANS.find((plan) => plan.id === planId)?.name ?? planId);
    try {
      await setPlan(target.id, planId);
      reload();
    } catch (error) {
      apply(previousId, previousName);
      setRefusal(
        error instanceof AdminWriteError ? error.message : `Could not change the plan for ${target.name}.`,
      );
    } finally {
      setBusy(null);
    }
  }

  const columns: DataTableColumn<WorkspaceRow>[] = [
    {
      header: "Workspace",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{row.name}</span>
          <code className="text-xs text-muted-foreground">{row.id}</code>
        </div>
      ),
    },
    { header: "Owner", cell: (row) => <span className="text-sm">{row.ownerLogin ?? "—"}</span> },
    {
      header: "Members",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">{row.memberCount}</span>
          {row.pendingInviteCount > 0 ? (
            <span className="text-xs text-muted-foreground">{row.pendingInviteCount} pending</span>
          ) : null}
        </div>
      ),
    },
    {
      header: "Seats",
      align: "right",
      cell: (row) => <span className="text-sm tabular-nums">{seatHeadroom(row)}</span>,
    },
    {
      header: "Plan",
      cell: (row) => (
        <Select
          value={row.planId}
          disabled={busy !== null}
          onValueChange={(planId) => void changePlan(row, planId)}
        >
          <SelectTrigger size="sm" aria-label={`Plan for ${row.name}`}>
            <SelectValue>{row.planName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* The row's own plan leads with the server's name, so a stored
                plan outside PLANS still has a labelled option. */}
            {planOptions(row).map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {plan.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    { header: "Created", cell: (row) => <span className="text-sm">{row.createdAt.slice(0, 10)}</span> },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Workspaces"
        description="Every live workspace. A plan change never removes a member; a downgrade only blocks new invites."
        actions={<ConsolePath page="workspaces" />}
      />
      <Screen state={state} failed="Could not load the workspace list." onRetry={reload} locale={locale}>
        {(workspaces) => (
          <div className="flex flex-col gap-4">
            {refusal ? <PageNotice kind="error" message={refusal} /> : null}
            <DataTable
              columns={columns}
              rows={workspaces}
              rowKey={(row) => row.id}
              empty={<EmptyState title="No workspaces" description="This deployment has no live workspace yet." />}
            />
          </div>
        )}
      </Screen>
    </section>
  );
}
