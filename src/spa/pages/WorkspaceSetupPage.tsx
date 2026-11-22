import { useState, type FormEvent } from "react";
import { t, type DictionaryKey } from "../../i18n";
import { Button, FlowSection, Input } from "@design-system";
import { ListRow, ListRowGroup } from "@/components/ListRow";
import { PageHeader } from "@/components/PageHeader";
import { postForm } from "../api";
import type { SpaBoot } from "../boot";
import { formatRelativeTime } from "../relative-time";
import { parseCreatedWorkspace } from "./data";
import { PageNotice, type NoticeKind } from "./PageNotice";

type PendingInvite = NonNullable<SpaBoot["pendingInvites"]>[number];

/** The workspace-scoped accept POST — the invite row carries the ref the
    path must address (a `needsWorkspace` login's own path names none). */
export function inviteAcceptPath(workspaceRef: string, inviteId: string): string {
  return `/dashboard/${workspaceRef}/api/members/invites/${inviteId}/accept`;
}

/** A successful accept lands on the invited workspace's repository overview. */
export function inviteLanding(workspaceRef: string): string {
  return `/dashboard/${workspaceRef}/repos`;
}

/** The refusal body (`invite.expired` 409 / "no longer pending" 410, or an
    unknown failure) mapped onto a dictionary key — the notice channel of
    MembersPage's invite writes. */
export function inviteAcceptNotice(status: number, body: string): DictionaryKey {
  if (status === 409 && body.includes("invite.expired")) return "workspace.inviteExpired";
  if (status === 410) return "workspace.inviteGone";
  return "workspace.inviteAcceptFailed";
}

const NAME_MAX_LENGTH = 80;

/**
 * Where a creation POST sends the browser: the landing the 201 named, or null
 * when the response carries none (the caller surfaces the failure notice). The
 * page never derives the target itself — only the Worker knows whether the
 * deployment serves workspace routes, and `strict`'s sole-workspace resolver
 * cannot name a workspace once a second one exists.
 */
export function creationLanding(status: number, body: string): string | null {
  if (status !== 201) return null;
  return parseCreatedWorkspace(body)?.homePath ?? null;
}

/**
 * Workspace creation — the signed-in landing for a login that belongs to no
 * workspace yet. Sign-in never joins a workspace, so this page is
 * the only way into a first one; the creator becomes its `owner` and the POST
 * answers the workspace ref the shell then navigates to.
 *
 * Creation is NOT an invitation: no auto-join, and no "first user becomes
 * admin of the only workspace" fallback.
 */
export function WorkspaceSetupPage({ boot }: { boot: SpaBoot }) {
  const locale = boot.locale;
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<{ kind: NoticeKind; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  async function onAccept(invite: PendingInvite): Promise<void> {
    if (acceptingId !== null) return;
    setAcceptingId(invite.inviteId);
    try {
      const { status, body } = await postForm(inviteAcceptPath(invite.workspaceRef, invite.inviteId), {});
      if (status < 400) {
        window.location.assign(inviteLanding(invite.workspaceRef));
        return;
      }
      setNotice({ kind: "error", message: t(locale, inviteAcceptNotice(status, body)) });
    } catch {
      setNotice({ kind: "error", message: t(locale, "workspace.inviteAcceptFailed") });
    } finally {
      setAcceptingId(null);
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNotice({ kind: "error", message: t(locale, "workspace.nameRequired") });
      return;
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      setNotice({
        kind: "error",
        message: t(locale, "workspace.nameTooLong", { max: NAME_MAX_LENGTH }),
      });
      return;
    }
    setBusy(true);
    try {
      const { status, body } = await postForm("/dashboard/api/workspaces", { name: trimmed });
      const landing = creationLanding(status, body);
      if (landing !== null) {
        window.location.replace(landing);
        return;
      }
      setNotice({ kind: "error", message: t(locale, "workspace.createFailed") });
    } catch {
      setNotice({ kind: "error", message: t(locale, "workspace.createFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t(locale, "workspace.setupHeading")}
        description={t(locale, "workspace.setupDescription")}
      />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {boot.emptyInstance === true ? (
        <p className="text-sm text-muted-foreground">{t(locale, "workspace.emptyInstance")}</p>
      ) : null}
      <div className="flex flex-col">
        {boot.pendingInvites !== undefined && boot.pendingInvites.length > 0 ? (
          <FlowSection
            title={t(locale, "workspace.invitesHeading")}
            subtitle={t(locale, "workspace.invitesDescription")}
          >
            <ListRowGroup>
              {boot.pendingInvites.map((invite) => (
                <ListRow
                  key={invite.inviteId}
                  identity={invite.workspaceRef}
                  meta={t(locale, "workspace.inviteMeta", {
                    role: t(locale, `members.role.${invite.role}`),
                    expires: formatRelativeTime(invite.expiresAt, locale),
                  })}
                  actions={
                    <Button size="sm" onClick={() => void onAccept(invite)} disabled={acceptingId !== null}>
                      {t(locale, "workspace.inviteAccept")}
                    </Button>
                  }
                />
              ))}
            </ListRowGroup>
          </FlowSection>
        ) : null}
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void onCreate(event)}>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="workspace-name">
              {t(locale, "workspace.nameLabel")}
            </label>
            <Input
              id="workspace-name"
              className="w-64"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t(locale, "workspace.namePlaceholder")}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {t(locale, "workspace.create")}
          </Button>
        </form>
      </div>
    </div>
  );
}
