import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StatusBadge,
} from "@design-system";
import { t } from "../../i18n";
import type { Locale } from "../../i18n";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/state/EmptyState";
import { PageNotice } from "../pages/PageNotice";
import { AdminWriteError, readBots, setBotScope, useLoaded, type BotRow } from "./api";
import { ConsolePath, Screen } from "./screen";
import { TableSearch } from "./TableSearch";

function opposite(scope: BotRow["scope"]): BotRow["scope"] {
  return scope === "shared" ? "owned" : "shared";
}

function sharedStamp(value: string | null): string {
  return value === null ? "—" : value.slice(0, 16).replace("T", " ");
}

export function BotsPage({ locale }: { locale: Locale }) {
  const { state, reload } = useLoaded(readBots);
  const [pending, setPending] = useState<BotRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function commit(row: BotRow): Promise<void> {
    setBusyId(row.botId);
    setRefusal(null);
    try {
      await setBotScope(row.botId, opposite(row.scope));
      reload();
    } catch (error) {
      const generic = t(locale, "admin.bots.scopeChangeFailed", { name: row.name });
      setRefusal(
        error instanceof AdminWriteError
          ? `${generic} ${t(locale, "admin.refusalDetail", { detail: error.message })}`
          : generic,
      );
    } finally {
      setBusyId(null);
    }
  }

  const columns: DataTableColumn<BotRow>[] = [
    {
      header: t(locale, "admin.bots.botColumn"),
      cell: (row) => <span className="text-sm font-medium">{row.name}</span>,
      meta: (row) => t(locale, "admin.bots.appMeta", { id: row.githubAppId }),
    },
    {
      header: t(locale, "admin.bots.workspaceColumn"),
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{row.workspaceName ?? row.workspaceId ?? "—"}</span>
          {row.isOfficial ? (
            <StatusBadge tone="success">{t(locale, "admin.bots.workspaceOfficial")}</StatusBadge>
          ) : null}
        </div>
      ),
    },
    {
      header: t(locale, "admin.bots.scopeColumn"),
      cell: (row) => (
        <StatusBadge tone={row.scope === "shared" ? "success" : "neutral"}>{row.scope}</StatusBadge>
      ),
    },
    {
      header: t(locale, "admin.bots.sharedColumn"),
      cell: (row) => <span className="text-sm tabular-nums">{sharedStamp(row.sharedAt)}</span>,
    },
    {
      header: t(locale, "admin.bots.installationsColumn"),
      align: "right",
      cell: (row) => <span className="text-sm tabular-nums">{row.installationCount}</span>,
    },
    {
      header: t(locale, "admin.bots.targetsColumn"),
      align: "right",
      cell: (row) => <span className="text-sm tabular-nums">{row.liveTargetCount}</span>,
    },
    {
      header: "",
      cell: (row) => {
        if (row.scope === "owned" && !row.isOfficial) {
          return (
            <div className="flex flex-col gap-1">
              <Button type="button" variant="outline" size="sm" disabled>
                {t(locale, "admin.bots.shareUnavailable")}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t(locale, "admin.bots.notOfficialReason")}
              </span>
            </div>
          );
        }
        return (
          <Button
            type="button"
            variant={row.scope === "shared" ? "outline" : "default"}
            size="sm"
            disabled={busyId === row.botId}
            onClick={() => {
              setRefusal(null);
              setPending(row);
            }}
          >
            {t(locale, row.scope === "shared" ? "admin.bots.unshareAction" : "admin.bots.shareAction")}
          </Button>
        );
      },
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "admin.nav.bots")}
        description={t(locale, "admin.bots.description")}
        actions={<ConsolePath page="bots" />}
      />
      <Screen state={state} failed={t(locale, "admin.bots.loadFailed")} onRetry={reload} locale={locale}>
        {(bots) => {
          const query = search.trim().toLowerCase();
          const filtered = query
            ? bots.filter((row) => row.name.toLowerCase().includes(query))
            : bots;
          return (
            <div className="flex flex-col gap-4">
              <TableSearch
                locale={locale}
                value={search}
                onChange={setSearch}
                shown={filtered.length}
                total={bots.length}
                placeholderKey="admin.search.placeholder"
              />
              {refusal ? <PageNotice kind="error" message={refusal} /> : null}
              <DataTable
                columns={columns}
                rows={filtered}
                rowKey={(row) => row.botId}
                empty={
                  query && bots.length > 0 ? (
                    <EmptyState
                      title={t(locale, "admin.search.emptyTitle")}
                      description={t(locale, "admin.search.emptyDescription")}
                    />
                  ) : (
                    <EmptyState
                      title={t(locale, "admin.bots.emptyTitle")}
                      description={t(locale, "admin.bots.emptyDescription")}
                    />
                  )
                }
              />
            </div>
          );
        }}
      </Screen>
      <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : setPending(null))}>
        {pending ? (
          <DialogContent role="alertdialog" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>
                {t(
                  locale,
                  pending.scope === "shared"
                    ? "admin.bots.unshareConfirmTitle"
                    : "admin.bots.shareConfirmTitle",
                  { name: pending.name },
                )}
              </DialogTitle>
              <DialogDescription>
                {t(
                  locale,
                  pending.scope === "shared"
                    ? "admin.bots.unshareConsequence"
                    : "admin.bots.shareConsequence",
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setPending(null)}>
                {t(locale, "admin.bots.cancelAction")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busyId !== null}
                onClick={() => {
                  const row = pending;
                  setPending(null);
                  void commit(row);
                }}
              >
                {t(locale, "admin.bots.confirmAction")}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}
