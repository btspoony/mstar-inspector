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
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import { AdminWriteError, readWorkspaces, setPlan, useLoaded, type WorkspaceRow } from "./api";
import { ConsolePath, Screen } from "./screen";

/**
 * The plan ids the picker offers, in tier order.
 * shortcut: mirrored from `plans` (migrations 0031/0032) — no admin read
 * exposes the catalogue. A row whose stored plan is not listed still renders
 * and keeps it (see `planOptions`); add a `GET /api/plans` read when a tier
 * ships without a UI change.
 */
const PLAN_IDS = ["free", "pro", "unlimited"];

export function WorkspacesPage() {
  const { state, reload, update } = useLoaded(readWorkspaces);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function changePlan(row: WorkspaceRow, planId: string) {
    if (planId === row.planId) return;
    const previous = row.planId;
    setBusy(row.id);
    setRefusal(null);
    // Optimistic: a controlled picker has to show the choice while the one
    // PATCH is in flight; a refusal below puts the stored plan back.
    const apply = (id: string) =>
      update((workspaces) => workspaces.map((item) => (item.id === row.id ? { ...item, planId: id } : item)));
    apply(planId);
    try {
      await setPlan(row.id, planId);
    } catch (error) {
      apply(previous);
      setRefusal(error instanceof AdminWriteError ? error.message : `Could not change the plan for ${row.name}.`);
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
      header: "Plan",
      cell: (row) => (
        <Select value={row.planId} disabled={busy !== null} onValueChange={(planId) => void changePlan(row, planId)}>
          <SelectTrigger size="sm" aria-label={`Plan for ${row.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* The row's own plan leads, so a stored plan outside PLAN_IDS
                still has an option and the picker never misreports it. */}
            {[row.planId, ...PLAN_IDS.filter((id) => id !== row.planId)].map((id) => (
              <SelectItem key={id} value={id}>
                {id}
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
      <Screen state={state} failed="Could not load the workspace list." onRetry={reload}>
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
