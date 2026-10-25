/**
 * Users — the read-only platform account list (spec §3.3).
 *
 * `isOperator` is the env allowlist's answer (the route derives it from the
 * same predicate the gate uses), and `activeGrantCount` is the database's.
 * The identity cell shows both, so "can enter the console" and "holds a live
 * support window" never read as one thing. Nothing here writes.
 */
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/state/EmptyState";
import { readUsers, useLoaded, type UserRow } from "./api";
import { ConsolePath, Screen } from "./screen";

const columns: DataTableColumn<UserRow>[] = [
  { header: "GitHub", cell: (row) => <code className="text-sm">{row.login}</code> },
  { header: "First seen", cell: (row) => <span className="text-sm">{row.createdAt.slice(0, 10)}</span> },
  { header: "Workspaces", cell: (row) => <span className="text-sm">{row.workspaceCount}</span> },
  {
    header: "Identity",
    cell: (row) => (
      <div className="flex flex-wrap items-center gap-2">
        {row.isOperator ? <StatusBadge tone="brand">Operator</StatusBadge> : null}
        {row.activeGrantCount > 0 ? (
          <StatusBadge tone="neutral">Support ({row.activeGrantCount})</StatusBadge>
        ) : null}
        {!row.isOperator && row.activeGrantCount === 0 ? <StatusBadge tone="neutral">User</StatusBadge> : null}
      </div>
    ),
  },
];

export function UsersPage() {
  const { state, reload } = useLoaded(readUsers);

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Every account on this platform. Read-only: operator status comes from the allowlist, support access from the grant list."
        actions={<ConsolePath page="users" />}
      />
      <Screen state={state} failed="Could not load the user list." onRetry={reload}>
        {(users) => (
          <DataTable
            columns={columns}
            rows={users}
            rowKey={(row) => row.login}
            empty={<EmptyState title="No users" description="Nobody has signed in to this platform yet." />}
          />
        )}
      </Screen>
    </section>
  );
}
