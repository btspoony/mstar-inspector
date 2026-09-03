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
import { canViewMembers, inviteLoginNoticeKey, parseMembers, type MemberRow, type Role } from "./data";
import { LoadFailedNotice, LoadingNotice, PageNotice, type NoticeKind } from "./PageNotice";

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

  const load = useCallback(async () => {
    setState("loading");
    try {
      const parsed = parseMembers(await fetchJson("/dashboard/api/members"));
      if (!parsed) {
        setState("error");
        return;
      }
      setMembers(parsed);
      setState("ok");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  async function onInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const key = inviteLoginNoticeKey(inviteLogin);
    if (key) {
      setNotice({ kind: "error", message: t(locale, key, { login: inviteLogin }) });
      return;
    }
    const trimmed = inviteLogin.trim();
    const existed = members?.some((m) => m.github_login.toLowerCase() === trimmed.toLowerCase()) ?? false;
    const { status } = await postForm("/dashboard/members/invite", { login: trimmed, role: inviteRole });
    if (status >= 400) {
      setNotice({ kind: "error", message: t(locale, "notice.error.inviteFailed", { login: trimmed }) });
      return;
    }
    await load();
    setNotice({
      kind: existed ? "warn" : "success",
      message: t(locale, existed ? "notice.warn.alreadyMember" : "notice.success.invited", { login: trimmed }),
    });
    setInviteLogin("");
  }

  async function onConfirmAction(): Promise<void> {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (pending.kind === "role") {
        const { member, nextRole } = pending;
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
        const { member } = pending;
        const { status } = await postForm("/dashboard/members/remove", { userId: member.id });
        setNotice(
          status >= 400
            ? { kind: "error", message: t(locale, "notice.error.removeFailed", { login: member.github_login }) }
            : { kind: "success", message: t(locale, "notice.success.removedMember", { login: member.github_login }) },
        );
      }
      await load();
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const adminCount = members?.filter((m) => m.role === "admin").length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "members.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t(locale, "members.inviteOnlyNotice")}</p>
      </div>
      {!allowed ? <PageNotice kind="error" message={t(locale, "members.adminOnly")} /> : null}
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {allowed && state === "loading" ? <LoadingNotice locale={locale} /> : null}
      {allowed && state === "error" ? <LoadFailedNotice locale={locale} /> : null}
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
            <Button type="submit">{t(locale, "members.inviteButton")}</Button>
          </form>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(locale, "members.tableLogin")}</TableHead>
                  <TableHead>{t(locale, "members.roleLabel")}</TableHead>
                  <TableHead>{t(locale, "members.tableJoined")}</TableHead>
                  <TableHead className="text-right">{t(locale, "members.tableActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.length === 0 ? (
                  <TableRow>
                    <TableCell className="py-6 text-center text-muted-foreground" colSpan={4}>
                      {t(locale, "members.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((member) => {
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
                        <TableCell className="text-muted-foreground tabular-nums">{member.created_at}</TableCell>
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
                  })
                )}
              </TableBody>
            </Table>
          </div>
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
