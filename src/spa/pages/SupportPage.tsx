import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchJson } from "../api";
import type { SpaBoot } from "../boot";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { apiBase } from "../workspace-base";
import { parseSupportView, type SupportGrantRow, type SupportWorkspaceView } from "./data";

/**
 * The platform operator's read-only support face (plan 99 AC2/AC3).
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
          {t(locale, "support.heading")}
        </h1>
        <p className="text-sm text-muted-foreground">{t(locale, "support.readOnly")}</p>
      </div>
      {state === "error" || view === null ? (
        <ErrorState locale={locale} onRetry={() => window.location.reload()} />
      ) : (
        <>
          <Card className="max-w-lg">
            <CardHeader>
              <CardTitle className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)">
                {view.workspace.name}
              </CardTitle>
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
          </Card>
          {view.grants.length > 0 ? (
            <Card className="max-w-lg">
              <CardHeader>
                <CardTitle className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)">
                  {t(locale, "support.grantsHeading")}
                </CardTitle>
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
            </Card>
          ) : null}
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader className="bg-(--background-200)">
                <TableRow className="hover:bg-inherit">
                  <TableHead className="text-xs tracking-(--typo-label-12-tracking)">
                    {t(locale, "support.tableLogin")}
                  </TableHead>
                  <TableHead className="text-xs tracking-(--typo-label-12-tracking)">
                    {t(locale, "support.tableRole")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.members.map((member) => (
                  <TableRow key={member.github_login}>
                    <TableCell className="font-medium">{member.github_login}</TableCell>
                    <TableCell>{t(locale, `members.role.${member.role}`)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
