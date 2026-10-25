import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard, SectionCardTitle } from "@/components/SectionCard";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { apiBase } from "../workspace-base";
import { parseSupportView, type SupportGrantRow, type SupportWorkspaceView } from "./data";

/**
 * The platform operator's read-only support face (platform-operator support,
 * 2026-10).
 *
 * One request, one screen: the workspace's four identity fields, each member's
 * GitHub login and role, and the active grants with their reason and expiry.
 * There is deliberately NO control on this page — every App read, credential,
 * model chain, settings write, role change, member removal and invite answers
 * 403 to a granted operator, so offering one would only render a button that
 * cannot work. The tenant sees the same grant through the undismissable
 * notice in the shell (`SupportNotice`).
 */
export function SupportPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const base = apiBase();
  const [view, setView] = useState<SupportWorkspaceView | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const parsed = parseSupportView(await fetchJson(`${base}/api/support/workspace`));
        if (!live) return;
        setView(parsed);
        setState(parsed === null ? "error" : "ok");
      } catch {
        if (live) setState("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [base]);

  if (state === "loading") return <PageSkeleton locale={locale} kind="table" />;

  const columns: DataTableColumn<SupportWorkspaceView["members"][number]>[] = [
    {
      header: t(locale, "support.tableLogin"),
      cell: (member) => <span className="font-medium">{member.github_login}</span>,
    },
    {
      header: t(locale, "support.tableRole"),
      cell: (member) => t(locale, `members.role.${member.role}`),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(locale, "support.heading")} description={t(locale, "support.readOnly")} />
      {state === "error" || view === null ? (
        <ErrorState locale={locale} onRetry={() => window.location.reload()} />
      ) : (
        <>
          <SectionCard tier="primary" className="max-w-lg">
            <CardHeader>
              <SectionCardTitle>{view.workspace.name}</SectionCardTitle>
              <CardDescription>{view.workspace.slug}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">
                {t(locale, "support.workspaceId")}: <span className="text-foreground">{view.workspace.id}</span>
              </span>
              <span className="text-muted-foreground">
                {t(locale, "support.createdAt")}:{" "}
                <span className="text-foreground tabular-nums">{view.workspace.created_at}</span>
              </span>
            </CardContent>
          </SectionCard>
          {view.grants.length > 0 ? (
            <SectionCard tier="secondary" className="max-w-lg">
              <CardHeader>
                <SectionCardTitle>{t(locale, "support.grantsHeading")}</SectionCardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {view.grants.map((grant: SupportGrantRow) => (
                  <span key={`${grant.operator_login}:${grant.expires_at}`} className="text-muted-foreground">
                    {t(locale, "support.grantLine", {
                      login: grant.operator_login,
                      reason: grant.reason,
                      expires: grant.expires_at,
                    })}
                  </span>
                ))}
              </CardContent>
            </SectionCard>
          ) : null}
          <DataTable columns={columns} rows={view.members} rowKey={(member) => member.github_login} />
          <div>
            <Button asChild variant="ghost" size="sm">
              <a href="/dashboard/logout">{t(locale, "nav.logout")}</a>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
