import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MoreHorizontal } from "lucide-react";
import { t, type Locale } from "../../i18n";
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
import { apiBase } from "../workspace-base";
import {
  canInviteMembers,
  inviteLoginNoticeKey,
  parseInvites,
  parseMembers,
  type InviteRow,
  type MemberRow,
  type WorkspaceRole,
} from "./data";
import { PageNotice, type NoticeKind } from "./PageNotice";

/** DESIGN.md Table: header band on background-200, headers at label-12
    (12px; the primitive's font-medium supplies the 500 weight). */
const TABLE_HEADER = "bg-(--background-200)";
const TABLE_HEAD_LABEL = "text-xs tracking-(--typo-label-12-tracking)";

/** Row action awaiting manager confirmation in the shared dialog. */
type PendingAction =
  | { kind: "role"; member: MemberRow; nextRole: "admin" | "member" }
  | { kind: "remove"; member: MemberRow }
  | { kind: "revoke"; invite: InviteRow };

/**
 * Workspace members + pending invitations. Every read/write hangs off
 * the page's workspace base (`apiBase`), so the same component serves
 * `/dashboard/<ref>/members` and its data never escapes the workspace.
 *
 * Inviting and the pending list are `owner`/`admin` only; the member list is
 * visible to every member. The client gate mirrors the server one —
 * the routes remain the SSOT for every decision.
 */

/** The page's loaded state; null when the member list itself did not parse. */
export type MembersPageData = {
  members: MemberRow[];
  role: WorkspaceRole;
  invites: InviteRow[];
};

/**
 * The one read path: the member list, then — for a manager only — the pending
 * invites. Both requests hang off `base`, so a plain member costs ONE request
 * and never asks for a list the server would 403.
 */
export async function loadMembersPage(base: string): Promise<MembersPageData | null> {
  const payload = parseMembers(await fetchJson(`${base}/api/members`));
  if (!payload) return null;
  const invites = canInviteMembers(payload.viewer.role)
    ? (parseInvites(await fetchJson(`${base}/api/members/invites`)) ?? [])
    : [];
  return { members: payload.members, role: payload.viewer.role, invites };
}

/**
 * How an invite POST refusal reads to the actor. `409 invite.pending_exists`
 * is the one refusal that is not an error: the invite is already pending, so
 * the notice warns instead of asking for a retry. A target the list already
 * showed as a member is the same class.
 */
export function inviteFailureNotice(
  status: number,
  body: string,
  existed: boolean,
): { kind: NoticeKind; key: "notice.warn.invitePending" | "notice.warn.alreadyMember" | "notice.error.inviteFailed" } {
  const duplicate = status === 409 && body.includes("invite.pending_exists");
  if (duplicate) return { kind: "warn", key: "notice.warn.invitePending" };
  if (existed) return { kind: "warn", key: "notice.warn.alreadyMember" };
  return { kind: "error", key: "notice.error.inviteFailed" };
}

/**
 * Whether the pending-invitation section renders: manager-only AND non-empty,
 * so a plain member — who never loads the list — shows no empty heading either.
 */
export function showsPendingInvites(role: WorkspaceRole | null, invites: readonly InviteRow[]): boolean {
  return canInviteMembers(role) && invites.length > 0;
}

/** The four member writes the page issues, before the URL is resolved. */
export type MemberWrite =
  | { kind: "invite"; login: string; role: "admin" | "member" }
  | { kind: "revoke"; inviteId: string }
  | { kind: "role"; userId: string; nextRole: "admin" | "member" }
  | { kind: "remove"; userId: string };

/**
 * The one write path: every member mutation POSTs under `base`, so no write
 * can reach the retired deployment-level paths (`/dashboard/api/members`,
 * `/dashboard/members/…`) that the workspace-only route family dropped.
 */
export function postMemberWrite(
  base: string,
  write: MemberWrite,
): Promise<{ status: number; body: string }> {
  switch (write.kind) {
    case "invite":
      return postForm(`${base}/api/members/invites`, { login: write.login, role: write.role });
    case "revoke":
      return postForm(`${base}/api/members/invites/${write.inviteId}/revoke`, {});
    case "role":
      return postForm(`${base}/members/role`, { userId: write.userId, role: write.nextRole });
    case "remove":
      return postForm(`${base}/members/remove`, { userId: write.userId });
  }
}

/**
 * The member list table, split out of the stateful page so a real row — the
 * "Joined" cell's relative text and its absolute-stamp tooltip included —
 * is assertable under static render (the `AppsView` precedent; the page's
 * own state lives in `useState`, so it renders as the skeleton under SSR).
 */
export function MembersTable({
  locale,
  members,
  viewerLogin,
  memberRole,
  canInvite,
  onAction,
}: {
  locale: Locale;
  members: MemberRow[];
  viewerLogin: string | null;
  memberRole: WorkspaceRole | null;
  canInvite: boolean;
  onAction: (action: PendingAction) => void;
}) {
  const ownerCount = members.filter((m) => m.role === "owner").length;
  return (
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
              viewerLogin !== null && member.github_login.toLowerCase() === viewerLogin.toLowerCase();
            // Client-side mirror of the server guards: the sole owner
            // cannot be demoted or removed; an `admin` may only remove
            // plain members and may not change any role.
            // The routes remain the SSOT (conditional UPDATE/DELETE
            // close the race); this only greys out the actions the
            // server would refuse anyway.
            const soleOwner = member.role === "owner" && ownerCount === 1;
            const roleBlocked = memberRole !== "owner";
            const protectedMember = soleOwner || (memberRole === "admin" && member.role !== "member");
            const nextRole: "admin" | "member" = member.role === "member" ? "admin" : "member";
            return (
              <TableRow key={member.id}>
                <TableCell className="font-medium">
                  {member.github_login}
                  {self ? (
                    <span className="ml-2 text-muted-foreground">({t(locale, "members.you")})</span>
                  ) : null}
                </TableCell>
                <TableCell>{t(locale, `members.role.${member.role}`)}</TableCell>
                {/* Shared relative-time copy (F-07); the raw SQLite
                    UTC stamp stays reachable as the native tooltip. */}
                <TableCell className="text-muted-foreground tabular-nums" title={member.created_at}>
                  {formatRelativeTime(member.created_at, locale)}
                </TableCell>
                <TableCell className="text-right">
                  {self || !canInvite ? null : (
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
                          disabled={protectedMember || roleBlocked}
                          onSelect={() => onAction({ kind: "role", member, nextRole })}
                        >
                          {t(locale, member.role === "member" ? "members.makeAdmin" : "members.makeMember")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={protectedMember}
                          onSelect={() => onAction({ kind: "remove", member })}
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
  );
}

export function MembersPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const base = apiBase();
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [memberRole, setMemberRole] = useState<WorkspaceRole | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const [inviteLogin, setInviteLogin] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const roleLabel = (role: WorkspaceRole): string => t(locale, `members.role.${role}`);

  // Background reloads (op-triggered refreshes) keep the loaded page mounted:
  // they must not flip state back to "loading" — that unmount would replace
  // the whole page (heading, invite form, tables and any visible op PageNotice)
  // with the skeleton for one API round trip (background-reload
  // contract, mirroring SettingsPage; QC fix round 1 F-58-1). A failed
  // background refresh surfaces through the notice channel instead of the
  // page-level error state.
  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}): Promise<void> => {
      if (!background) setState("loading");
      try {
        const payload = await loadMembersPage(base);
        if (!payload) {
          if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
          else setState("error");
          return;
        }
        setMembers(payload.members);
        setMemberRole(payload.role);
        setInvites(payload.invites);
        setState("ok");
      } catch {
        if (background) setNotice({ kind: "error", message: t(locale, "common.loadFailed") });
        else setState("error");
      }
    },
    [base, locale],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const canInvite = canInviteMembers(memberRole);

  async function onInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return; // in-flight guard — no double-submit
    const key = inviteLoginNoticeKey(inviteLogin);
    if (key) {
      setNotice({ kind: "error", message: t(locale, key, { login: inviteLogin }) });
      return;
    }
    const trimmed = inviteLogin.trim();
    const existed = members?.some((m) => m.github_login.toLowerCase() === trimmed.toLowerCase()) ?? false;
    setBusy(true);
    try {
      const { status, body } = await postMemberWrite(base, { kind: "invite", login: trimmed, role: inviteRole });
      if (status >= 400) {
        // 409 `invite.pending_exists` is the one refusal with its own copy —
        // the invite is already pending, which is not an error the actor must
        // retry.
        const failure = inviteFailureNotice(status, body, existed);
        setNotice({ kind: failure.kind, message: t(locale, failure.key, { login: trimmed }) });
        return;
      }
      // Background reload: the page (and this op's notice) stays mounted —
      // no skeleton flash while the lists refresh (F-58-1).
      await load({ background: true });
      setNotice({
        kind: existed ? "warn" : "success",
        message: t(locale, existed ? "notice.warn.alreadyMember" : "notice.success.invited", { login: trimmed }),
      });
      setInviteLogin("");
    } catch {
      // Network failure — postForm throws on fetch rejection.
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
      if (action.kind === "revoke") {
        const { invite } = action;
        const { status } = await postMemberWrite(base, { kind: "revoke", inviteId: invite.id });
        setNotice(
          status >= 400
            ? { kind: "error", message: t(locale, "notice.error.revokeFailed", { login: invite.github_login }) }
            : { kind: "success", message: t(locale, "notice.success.revoked", { login: invite.github_login }) },
        );
      } else if (action.kind === "role") {
        const { member, nextRole } = action;
        const { status } = await postMemberWrite(base, {
          kind: "role",
          userId: member.id,
          nextRole,
        });
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
        const { status } = await postMemberWrite(base, { kind: "remove", userId: member.id });
        setNotice(
          status >= 400
            ? { kind: "error", message: t(locale, "notice.error.removeFailed", { login: member.github_login }) }
            : { kind: "success", message: t(locale, "notice.success.removedMember", { login: member.github_login }) },
        );
      }
      // Background reload: the outcome notice above stays visible — no
      // skeleton flash while the lists refresh (F-58-1).
      await load({ background: true });
    } catch {
      // Network failure — postForm throws on fetch rejection.
      setNotice({
        kind: "error",
        message: t(
          locale,
          action.kind === "revoke"
            ? "notice.error.revokeFailed"
            : action.kind === "role"
              ? "notice.error.roleChangeFailed"
              : "notice.error.removeFailed",
          { login: action.kind === "revoke" ? action.invite.github_login : action.member.github_login },
        ),
      });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  // Loading rides the shared skeleton as the page's full loading face —
  // the component's heading placeholder stands in for the real h1 (AD-582).
  // Foreground only: `load` flips to "loading" solely on the initial/retry
  // load, so op-triggered background reloads never reach this gate (F-58-1).
  if (state === "loading") {
    return <PageSkeleton locale={locale} kind="table" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">
          {t(locale, "members.heading")}
        </h1>
        <p className="text-sm text-muted-foreground">{t(locale, "members.visibleToMembers")}</p>
      </div>
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {state === "error" ? <ErrorState locale={locale} onRetry={() => void load()} /> : null}
      {state === "ok" && members ? (
        <>
          {canInvite ? (
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
                <Select
                  value={inviteRole}
                  onValueChange={(value) => setInviteRole(value as "admin" | "member")}
                >
                  <SelectTrigger className="w-32" aria-labelledby="member-invite-role-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t(locale, "members.role.member")}</SelectItem>
                    <SelectItem value="admin">{t(locale, "members.role.admin")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={busy}>
                {t(locale, "members.inviteButton")}
              </Button>
            </form>
          ) : null}
          {members.length === 0 ? (
            // Composed empty state (no-action variant): a member sees only this.
            <EmptyState
              title={t(locale, "members.emptyTitle")}
              description={t(locale, canInvite ? "members.emptyDescription" : "members.emptyDescriptionMember")}
            />
          ) : (
            <MembersTable
              locale={locale}
              members={members}
              viewerLogin={boot.login}
              memberRole={memberRole}
              canInvite={canInvite}
              onAction={setPending}
            />
          )}
          {showsPendingInvites(memberRole, invites) ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-medium text-base">{t(locale, "members.pendingHeading")}</h2>
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader className={TABLE_HEADER}>
                    <TableRow className="hover:bg-inherit">
                      <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "members.tableLogin")}</TableHead>
                      <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "members.roleLabel")}</TableHead>
                      <TableHead className={TABLE_HEAD_LABEL}>{t(locale, "members.tableExpires")}</TableHead>
                      <TableHead className={`text-right ${TABLE_HEAD_LABEL}`}>
                        {t(locale, "members.tableActions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invites.map((invite) => (
                      <TableRow key={invite.id}>
                        <TableCell className="font-medium">{invite.github_login}</TableCell>
                        <TableCell>{roleLabel(invite.role)}</TableCell>
                        <TableCell className="text-muted-foreground tabular-nums" title={invite.expires_at}>
                          {formatRelativeTime(invite.expires_at, locale)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setPending({ kind: "revoke", invite })}
                          >
                            {t(locale, "members.revoke")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ) : null}
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
                  {t(
                    locale,
                    pending.kind === "role"
                      ? "members.confirmRoleTitle"
                      : pending.kind === "remove"
                        ? "members.confirmRemoveTitle"
                        : "members.confirmRevokeTitle",
                    {
                      login:
                        pending.kind === "revoke" ? pending.invite.github_login : pending.member.github_login,
                    },
                  )}
                </DialogTitle>
                <DialogDescription>
                  {pending.kind === "role"
                    ? t(locale, "members.confirmRoleBody", {
                        login: pending.member.github_login,
                        role: roleLabel(pending.nextRole),
                      })
                    : pending.kind === "remove"
                      ? t(locale, "members.confirmRemoveBody", { login: pending.member.github_login })
                      : t(locale, "members.confirmRevokeBody", { login: pending.invite.github_login })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={busy}>
                    {t(locale, "common.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  variant={pending.kind === "role" ? "default" : "destructive"}
                  disabled={busy}
                  onClick={() => void onConfirmAction()}
                >
                  {t(
                    locale,
                    pending.kind === "role"
                      ? "members.confirmRoleButton"
                      : pending.kind === "remove"
                        ? "members.remove"
                        : "members.revoke",
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
