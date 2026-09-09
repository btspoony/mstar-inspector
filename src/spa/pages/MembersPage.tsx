import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MoreHorizontal } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchJson, postForm } from "../api";
import type { SpaBoot } from "../boot";
import { EmptyState } from "../components/state/EmptyState";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import { formatRelativeTime } from "../relative-time";
import { canViewMembers, inviteLoginNoticeKey, parseMembers, type MemberRow, type Role } from "./data";
import { PageNotice, type NoticeKind } from "./PageNotice";

/** DESIGN.md Table: header band on background-200, headers at label-12
    (12px; the primitive's font-medium supplies the 500 weight). */
const TABLE_HEADER = "bg-(--background-200)";
const TABLE_HEAD_LABEL = "text-xs tracking-(--typo-label-12-tracking)";

/** Row action awaiting admin confirmation in the shared dialog. */
type PendingAction = { kind: "role"; member: MemberRow; nextRole: Role } | { kind: "remove"; member: MemberRow };

export function MembersPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const [inviteLogin, setInviteLogin] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = canViewMembers(boot.role);
  const roleLabel = (role: Role): string => t(locale, role === "admin" ? "members.roleAdmin" : "members.roleMember");

  // Background reloads (op-triggered refreshes) keep the loaded page mounted:
  // they must not flip state back to "loading" — that unmount would replace
  // the whole page (heading, invite form, table and any visible op PageNotice)
  // with the skeleton for one API round trip (plan-38 background-reload
  // contract, mirroring SettingsPage; plan 58 QC fix round 1 F-58-1). A failed
  // background refresh surfaces through the notice channel instead of the
  // page-level error state.
  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<void> => {
      if (!background) setState("loading");
      try {
        const parsed = parseMembers(await fetchJson("/dashboard/api/members"));
        if (!parsed) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return;
        }
        setMembers(parsed);
        setState("ok");
      } catch {
        if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
      }
    },
    [locale],
  );

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  async function onInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double-submit (qc2/qc3 S-001)
    const key = inviteLoginNoticeKey(inviteLogin);
    if (key) {
      setNotice({ kind: "error", message: t(locale, key, { login: inviteLogin }) });
      return;
    }
    const trimmed = inviteLogin.trim();
    const existed = members?.some((m) => m.github_login.toLowerCase() === trimmed.toLowerCase()) ?? false;
    setBusy(true);
    try {
      const { status } = await postForm("/dashboard/members/invite", { login: trimmed, role: inviteRole });
      if (status >= 400) {
        setNotice({ kind: "error", message: t(locale, "notice.error.inviteFailed", { login: trimmed }) });
        return;
      }
      // Background reload: the page (and this op's notice) stays mounted —
      // no skeleton flash while the members list refreshes (plan-38; F-58-1).
      await load({ background: true });
      setNotice({
        kind: existed ? "warn" : "success",
        message: t(locale, existed ? "notice.warn.alreadyMember" : "notice.success.invited", { login: trimmed }),
      });
      setInviteLogin("");
    } catch {
      // Network failure — postForm throws on fetch rejection (qc2/qc3 S-002).
      setNotice({ kind: "error", message: t(locale, "notice.error.inviteFailed", { login: trimmed }) });
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmAction(): Promise<void> {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    try {
      if (action.kind === "role") {
        const { member, nextRole } = action;
        const { status } = await postForm("/dashboard/members/role", { userId: member.id, role: nextRole });
        setNotice(
          status >= 400
            ? { kind: "error", message: t(locale, "notice.error.roleChangeFailed", { login: member.github_login }) }
            : {
                kind: "success",
                message: t(locale, "notice.success.roleChanged", { login: member.github_login, role: roleLabel(nextRole) }),
              },
        );
      } else {
        const { member } = action;
        const { status } = await postForm("/dashboard/members/remove", { userId: member.id });
        setNotice(
          status >= 400
            ? { kind: "error", message: t(locale, "notice.error.removeFailed", { login: member.github_login }) }
            : { kind: "success", message: t(locale, "notice.success.removedMember", { login: member.github_login }) },
        );
      }
      // Background reload: the outcome notice above stays visible — no
      // skeleton flash while the members list refreshes (plan-38; F-58-1).
      await load({ background: true });
    } catch {
      // Network failure — postForm throws on fetch rejection (qc2/qc3 S-002).
      setNotice({
        kind: "error",
        message: t(
          locale,
          action.kind === "role" ? "notice.error.roleChangeFailed" : "notice.error.removeFailed",
          { login: action.member.github_login },
        ),
      });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const adminCount = members?.filter((m) => m.role === "admin").length ?? 0;

  // Loading rides the plan-57 skeleton as the page's full loading face —
  // the component's heading placeholder stands in for the real h1 (AD-582).
  // Foreground only: `load` flips to "loading" solely on the initial/retry
  // load, so op-triggered background reloads never reach this gate (F-58-1).
  // Non-admins never load, so they keep the adminOnly notice face below.
  if (allowed && state === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
          {t(locale, "members.heading")}
        </h1>
        <p className="text-sm text-muted-foreground">{t(locale, "members.inviteOnlyNotice")}</p>
      </div>
      {!allowed ? <PageNotice kind="error" message={t(locale, "members.adminOnly")} /> : null}
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {allowed && state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {allowed && state === "ok" && members ? (
        <>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void onInvite(event)}>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="member-invite-login">
                {t(locale, "members.inviteLabel")}
              </label>
              <Input
                id="member-invite-login"
                className="w-64"
                autoComplete="off"
                value={inviteLogin}
                onChange={(event) => setInviteLogin(event.target.value)}
                placeholder={t(locale, "members.invitePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium" id="member-invite-role-label">
                {t(locale, "members.roleLabel")}
              </span>
              <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as Role)}>
                <SelectTrigger className="w-32" aria-labelledby="member-invite-role-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">{t(locale, "members.roleMember")}</SelectItem>
                  <SelectItem value="admin">{t(locale, "members.roleAdmin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={busy}>
              {t(locale, "members.inviteButton")}
            </Button>
          </form>
          {members.length === 0 ? (
            // Composed empty state (no-action variant): the invite form
            // above is the path, so the guidance only points at it.
            <EmptyState
              title={t(locale, "members.emptyTitle")}
              description={t(locale, "members.emptyDescription")}
            />
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className={TABLE_HEADER}>
                  <TableRow className="hover:bg-inherit">
                    <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "members.tableLogin")}</TableHead>
                    <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "members.roleLabel")}</TableHead>
                    <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "members.tableJoined")}</TableHead>
                    <TableHead className={`text-right ${TABLE_HEAD_LABEL}`}>{t(locale, "members.tableActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => {
                    const self =
                      boot.login !== null && member.github_login.toLowerCase() === boot.login.toLowerCase();
                    // Client-side mirror of the server guard: the last admin
                    // cannot be demoted or removed. The pinned POST routes
                    // remain the SSOT (conditional UPDATE/DELETE close the
                    // TOCTOU race); this only greys out the doomed actions.
                    const protectedAdmin = member.role === "admin" && adminCount === 1;
                    const nextRole: Role = member.role === "admin" ? "member" : "admin";
                    return (
                      <TableRow key={member.id}>
                        <TableCell className="font-medium">
                          {member.github_login}
                          {self ? (
                            <span className="ml-2 text-muted-foreground">({t(locale, "members.you")})</span>
                          ) : null}
                        </TableCell>
                        <TableCell>{roleLabel(member.role)}</TableCell>
                        {/* Shared relative-time copy (F-07); the raw SQLite
                            UTC stamp stays reachable as the native tooltip. */}
                        <TableCell
                          className="text-muted-foreground tabular-nums"
                          title={member.created_at}
                        >
                          {formatRelativeTime(member.created_at, locale)}
                        </TableCell>
                        <TableCell className="text-right">
                          {self ? null : (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t(locale, "members.actionsMenuLabel", { login: member.github_login })}
                                >
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  disabled={protectedAdmin}
                                  onSelect={() => setPending({ kind: "role", member, nextRole })}
                                >
                                  {t(locale, member.role === "admin" ? "members.makeMember" : "members.makeAdmin")}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={protectedAdmin}
                                  onSelect={() => setPending({ kind: "remove", member })}
                                >
                                  {t(locale, "members.remove")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      ) : null}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent>
          {pending ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t(locale, pending.kind === "role" ? "members.confirmRoleTitle" : "members.confirmRemoveTitle", {
                    login: pending.member.github_login,
                  })}
                </DialogTitle>
                <DialogDescription>
                  {pending.kind === "role"
                    ? t(locale, "members.confirmRoleBody", {
                        login: pending.member.github_login,
                        role: roleLabel(pending.nextRole),
                      })
                    : t(locale, "members.confirmRemoveBody", { login: pending.member.github_login })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={busy}>
                    {t(locale, "common.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  variant={pending.kind === "remove" ? "destructive" : "default"}
                  disabled={busy}
                  onClick={() => void onConfirmAction()}
                >
                  {t(locale, pending.kind === "remove" ? "members.remove" : "members.confirmRoleButton")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
