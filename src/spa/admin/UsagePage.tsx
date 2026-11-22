import { useState } from "react";
import { t } from "../../i18n";
import type { Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { readUsage, useLoaded, type UsageRow } from "./api";
import { ConsolePath, Screen } from "./screen";
import { TableSearch } from "./TableSearch";

export function UsagePage({ locale }: { locale: Locale }) {
  const { state, reload } = useLoaded(readUsage);
  const [search, setSearch] = useState("");

  const columns: DataTableColumn<UsageRow>[] = [
    {
      header: t(locale, "admin.usage.workspaceColumn"),
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{row.workspaceName}</span>
          <code className="text-xs text-muted-foreground">{row.workspaceSlug}</code>
        </div>
      ),
    },
    {
      header: t(locale, "admin.usage.sharedColumn"),
      align: "right",
      cell: (row) => <span className="text-sm tabular-nums">{row.sharedReviews}</span>,
    },
    {
      header: t(locale, "admin.usage.ownColumn"),
      align: "right",
      cell: (row) => <span className="text-sm tabular-nums">{row.ownReviews}</span>,
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.usage")}
        description={state.status === "ready" ? t(locale, "admin.usage.window", { month: state.data.month }) : undefined}
        actions={<ConsolePath page="usage" />}
      />
      <Screen state={state} failed={t(locale, "admin.usage.loadFailed")} onRetry={reload} locale={locale}>
        {(data) => {
          const query = search.trim().toLowerCase();
          const filtered = query
            ? data.rows.filter((row) =>
                [row.workspaceName, row.workspaceSlug].some((field) => field.toLowerCase().includes(query)),
              )
            : data.rows;
          return (
            <div className="flex flex-col gap-4">
              <TableSearch
                locale={locale}
                value={search}
                onChange={setSearch}
                shown={filtered.length}
                total={data.rows.length}
                placeholderKey="admin.search.placeholder"
              />
              <DataTable
                columns={columns}
                rows={filtered}
                rowKey={(row) => row.workspaceId}
                empty={
                  query && data.rows.length > 0 ? (
                    <EmptyState
                      title={t(locale, "admin.search.emptyTitle")}
                      description={t(locale, "admin.search.emptyDescription")}
                    />
                  ) : (
                    <EmptyState
                      title={t(locale, "admin.workspaces.emptyTitle")}
                      description={t(locale, "admin.workspaces.emptyDescription")}
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
