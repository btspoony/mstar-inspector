/**
 * Support access — the operator's time-boxed cross-workspace windows
 * (spec §3.4): the open list, a create form, and a revoke per row.
 *
 * Both writes are audited by the server (one `audit_events` row each, with the
 * grant's target workspace); this screen only states that in its copy. A
 * created grant is read back from the server rather than appended locally —
 * its id and expiry are the server's to mint.
 */
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { SectionCard, SectionCardTitle } from "../components/SectionCard";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import {
  AdminWriteError,
  createGrant,
  readGrants,
  readWorkspaces,
  revokeGrant,
  useLoaded,
  type GrantRow,
  type WorkspaceRow,
} from "./api";
import { ConsolePath, Screen } from "./screen";

/** The list and the form's workspace options come from one read. */
async function readSupportPage(): Promise<{ grants: GrantRow[]; workspaces: WorkspaceRow[] }> {
  const [grants, workspaces] = await Promise.all([readGrants(), readWorkspaces()]);
  return { grants, workspaces };
}

/** A grant's window, to the minute — the part of an ISO stamp an operator reads. */
function windowStamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function SupportGrantsPage() {
  const { state, reload, update } = useLoaded(readSupportPage);
  const [workspaceId, setWorkspaceId] = useState("");
  const [operatorLogin, setOperatorLogin] = useState("");
  const [reason, setReason] = useState("");
  const [ttlHours, setTtlHours] = useState("24");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      await createGrant({
        workspaceId,
        operatorLogin: operatorLogin.trim(),
        reason: reason.trim(),
        ttlHours: Number(ttlHours),
      });
      setOperatorLogin("");
      setReason("");
      reload();
    } catch (error) {
      setRefusal(error instanceof AdminWriteError ? error.message : "Could not create the support grant.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grant: GrantRow) {
    setBusy(true);
    setRefusal(null);
    try {
      await revokeGrant(grant.id);
      update((page) => ({ ...page, grants: page.grants.filter((item) => item.id !== grant.id) }));
    } catch (error) {
      setRefusal(error instanceof AdminWriteError ? error.message : "Could not revoke the support grant.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Support access"
        description="Time-boxed cross-workspace access. Creating and revoking a grant each append one audit row."
        actions={<ConsolePath page="support-grants" />}
      />
      <Screen state={state} failed="Could not load the support grants." onRetry={reload}>
        {({ grants, workspaces }) => {
          const workspaceName = (id: string) => workspaces.find((row) => row.id === id)?.name ?? id;
          const columns: DataTableColumn<GrantRow>[] = [
            { header: "Operator", cell: (row) => <code className="text-sm">{row.operator_login}</code> },
            { header: "Workspace", cell: (row) => <span className="text-sm">{workspaceName(row.workspace_id)}</span> },
            {
              header: "Reason",
              cell: (row) => <span className="text-sm text-muted-foreground">{row.reason}</span>,
            },
            { header: "Expires", cell: (row) => <span className="text-sm">{windowStamp(row.expires_at)}</span> },
            {
              header: "",
              cell: (row) => (
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke(row)}>
                  Revoke
                </Button>
              ),
            },
          ];
          return (
            <div className="flex flex-col gap-6">
              {refusal ? <PageNotice kind="error" message={refusal} /> : null}
              <SectionCard tier="secondary">
                <SectionCardTitle>New support window</SectionCardTitle>
                <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="grant-workspace">
                    Workspace
                    <Select value={workspaceId} onValueChange={setWorkspaceId}>
                      <SelectTrigger id="grant-workspace" aria-label="Workspace">
                        <SelectValue placeholder="Select a workspace" />
                      </SelectTrigger>
                      <SelectContent>
                        {workspaces.map((row) => (
                          <SelectItem key={row.id} value={row.id}>
                            {row.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="grant-operator">
                    Operator login
                    <Input
                      id="grant-operator"
                      value={operatorLogin}
                      onChange={(event) => setOperatorLogin(event.target.value)}
                      placeholder="octocat"
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="grant-reason">
                    Reason
                    <Input
                      id="grant-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="incident 42"
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="grant-ttl">
                    Hours
                    <Input
                      id="grant-ttl"
                      type="number"
                      min="1"
                      value={ttlHours}
                      onChange={(event) => setTtlHours(event.target.value)}
                      required
                    />
                  </label>
                  <div className="sm:col-span-2">
                    <Button type="submit" size="sm" disabled={busy || workspaceId === ""}>
                      Grant access
                    </Button>
                  </div>
                </form>
              </SectionCard>
              <DataTable
                columns={columns}
                rows={grants}
                rowKey={(row) => row.id}
                empty={
                  <EmptyState
                    title="No open support windows"
                    description="No operator holds cross-workspace access right now."
                  />
                }
              />
            </div>
          );
        }}
      </Screen>
    </section>
  );
}
