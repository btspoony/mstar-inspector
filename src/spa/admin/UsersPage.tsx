/**
 * Users — the read-only platform account list (spec §3.3).
 *
 * `isOperator` is the env allowlist's answer (the route derives it from the
 * same predicate the gate uses), and `activeGrantCount` is the database's.
 * The identity cell shows both, so "can enter the console" and "holds a live
 * support window" never read as one thing. Nothing here writes.
 *
 * The search input filters the already-loaded rows on the GitHub login,
 * client-side: no URL state, no request.
 */
import { useState } from "react";
import { t } from "../../i18n";
import type { Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/state/EmptyState";
import { readUsers, useLoaded, type UserRow } from "./api";
import { ConsolePath, Screen } from "./screen";
import { TableSearch } from "./TableSearch";

export function UsersPage({ locale }: { locale: Locale }) {
  const { state, reload } = useLoaded(readUsers);
  /** Client-side filter over the loaded rows — no URL state, no request. */
  const [search, setSearch] = useState("");

  const columns: DataTableColumn<UserRow>[] = [
    { header: t(locale, "admin.users.githubColumn"), cell: (row) => <code className="text-sm">{row.login}</code> },
    {
      header: t(locale, "admin.users.firstSeenColumn"),
      cell: (row) => <span className="text-sm">{row.createdAt.slice(0, 10)}</span>,
    },
    {
      header: t(locale, "admin.users.workspacesColumn"),
      cell: (row) => <span className="text-sm">{row.workspaceCount}</span>,
    },
    {
      header: t(locale, "admin.users.identityColumn"),
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          {row.isOperator ? <StatusBadge tone="brand">{t(locale, "admin.users.identityOperator")}</StatusBadge> : null}
          {row.activeGrantCount > 0 ? (
            <StatusBadge tone="neutral">
              {t(locale, "admin.users.identitySupport", { count: row.activeGrantCount })}
            </StatusBadge>
          ) : null}
          {!row.isOperator && row.activeGrantCount === 0 ? (
            <StatusBadge tone="neutral">{t(locale, "admin.users.identityUser")}</StatusBadge>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.users")}
        description={t(locale, "admin.users.description")}
        actions={<ConsolePath page="users" />}
      />
      <Screen state={state} failed={t(locale, "admin.users.loadFailed")} onRetry={reload} locale={locale}>
        {(users) => {
          const query = search.trim().toLowerCase();
          const filtered = query
            ? users.filter((row) => row.login.toLowerCase().includes(query))
            : users;
          return (
            <div className="flex flex-col gap-4">
              <TableSearch
                locale={locale}
                value={search}
                onChange={setSearch}
                shown={filtered.length}
                total={users.length}
                placeholderKey="admin.search.placeholder"
              />
              <DataTable
                columns={columns}
                rows={filtered}
                rowKey={(row) => row.login}
                empty={
                  query ? (
                    <EmptyState
                      title={t(locale, "admin.search.emptyTitle")}
                      description={t(locale, "admin.search.emptyDescription")}
                    />
                  ) : (
                    <EmptyState
                      title={t(locale, "admin.users.emptyTitle")}
                      description={t(locale, "admin.users.emptyDescription")}
                    />
                  )
                }
              />
            </div>
          );
        }}
      </Screen>
    </section>
  );
}
