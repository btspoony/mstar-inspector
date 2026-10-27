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
import { CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t, type Locale } from "../../i18n";
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

/**
 * A grant's window, to the minute — the part of an ISO stamp an operator reads.
 * The stamp is UTC (`toISOString`), and the console renders no other
 * time-converted stamp, so the marker is spelled out (I-000164): a bare
 * `2026-11-01 09:00` reads as local time to an operator outside UTC.
 */
function windowStamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function SupportGrantsPage({ locale }: { locale: Locale }) {
  const { state, reload, update } = useLoaded(readSupportPage);
  const [workspaceId, setWorkspaceId] = useState("");
  const [operatorLogin, setOperatorLogin] = useState("");
  const [reason, setReason] = useState("");
  const [ttlHours, setTtlHours] = useState("24");
  // The grant currently being revoked — creation and revocation stay
  // independent, so only this row's button disables while its write flies.
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setRefusal(error instanceof AdminWriteError ? error.message : t(locale, "admin.supportGrants.createFailed"));
    }
  }

  async function revoke(grant: GrantRow) {
    setRevokingId(grant.id);
    setRefusal(null);
    try {
      await revokeGrant(grant.id);
      update((page) => ({ ...page, grants: page.grants.filter((item) => item.id !== grant.id) }));
    } catch (error) {
      setRefusal(error instanceof AdminWriteError ? error.message : t(locale, "admin.supportGrants.revokeFailed"));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.supportGrants")}
        description={t(locale, "admin.supportGrants.description")}
        actions={<ConsolePath page="support-grants" />}
      />
      <Screen state={state} failed={t(locale, "admin.supportGrants.loadFailed")} onRetry={reload} locale={locale}>
        {({ grants, workspaces }) => {
          const workspaceName = (id: string) => workspaces.find((row) => row.id === id)?.name ?? id;
          const columns: DataTableColumn<GrantRow>[] = [
            {
              header: t(locale, "admin.supportGrants.operatorColumn"),
              cell: (row) => <code className="text-sm">{row.operator_login}</code>,
            },
            {
              header: t(locale, "admin.supportGrants.workspaceColumn"),
              cell: (row) => <span className="text-sm">{workspaceName(row.workspace_id)}</span>,
            },
            {
              header: t(locale, "admin.supportGrants.reasonColumn"),
              cell: (row) => <span className="text-sm text-muted-foreground">{row.reason}</span>,
            },
            {
              header: t(locale, "admin.supportGrants.expiresColumn"),
              cell: (row) => <span className="text-sm">{windowStamp(row.expires_at)}</span>,
            },
            {
              header: "",
              cell: (row) => (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={revokingId === row.id}
                  onClick={() => void revoke(row)}
                >
                  {t(locale, "admin.supportGrants.revokeAction")}
                </Button>
              ),
            },
          ];
          return (
            <div className="flex flex-col gap-6">
              {refusal ? <PageNotice kind="error" message={refusal} /> : null}
              <SectionCard tier="secondary">
                <CardHeader>
                  <SectionCardTitle>{t(locale, "admin.supportGrants.newWindowTitle")}</SectionCardTitle>
                </CardHeader>
                <CardContent>
                  <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
                    <label className="flex flex-col gap-1.5 text-sm" htmlFor="grant-workspace">
                      {t(locale, "admin.supportGrants.workspaceLabel")}
                      <Select value={workspaceId} onValueChange={setWorkspaceId}>
                        <SelectTrigger id="grant-workspace" aria-label={t(locale, "admin.supportGrants.workspaceLabel")}>
                          <SelectValue placeholder={t(locale, "admin.supportGrants.workspacePlaceholder")} />
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
                      {t(locale, "admin.supportGrants.operatorLabel")}
                      <Input
                        id="grant-operator"
                        value={operatorLogin}
                        onChange={(event) => setOperatorLogin(event.target.value)}
                        placeholder={t(locale, "admin.supportGrants.operatorPlaceholder")}
                        required
                      />
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm" htmlFor="grant-reason">
                      {t(locale, "admin.supportGrants.reasonLabel")}
                      <Input
                        id="grant-reason"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder={t(locale, "admin.supportGrants.reasonPlaceholder")}
                        required
                      />
                    </label>
                    <label className="flex flex-col gap-1.5 text-sm" htmlFor="grant-ttl">
                      {t(locale, "admin.supportGrants.hoursLabel")}
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
                      <Button type="submit" size="sm" disabled={workspaceId === ""}>
                        {t(locale, "admin.supportGrants.submit")}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </SectionCard>
              <DataTable
                columns={columns}
                rows={grants}
                rowKey={(row) => row.id}
                empty={
                  <EmptyState
                    title={t(locale, "admin.supportGrants.emptyTitle")}
                    description={t(locale, "admin.supportGrants.emptyDescription")}
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
