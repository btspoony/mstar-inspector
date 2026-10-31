import { useState, type FormEvent } from "react";
import { t, type DictionaryKey } from "../../i18n";
import { Button, CardContent, CardDescription, CardHeader, Input } from "@design-system";
import { PageHeader } from "@/components/PageHeader";
import { SectionCard, SectionCardTitle } from "@/components/SectionCard";
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

/** A successful accept lands on the invited workspace's Apps page. */
export function inviteLanding(workspaceRef: string): string {
  return `/dashboard/${workspaceRef}/apps`;
}

/** The refusal body (`invite.expired` 409 / "no longer pending" 410, or an
    unknown failure) mapped onto a dictionary key — the notice channel of
    MembersPage's invite writes. */
export function inviteAcceptNotice(status: number, body: string): DictionaryKey {
  if (status === 409 && body.includes("invite.expired")) return "workspace.inviteExpired";
  if (status === 410) return "workspace.inviteGone";
  return "workspace.inviteAcceptFailed";
}

/** Server-side cap (src/dashboard/index.ts WORKSPACE_NAME_MAX_LENGTH). */
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
  return parseCreatedWorkspace(body)?.appsPath ?? null;
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

  // Accepting one invite joins the workspace: a full navigation lands the
  // shell on the invited workspace, whose next document boot carries the
  // fresh membership (the boot snapshot in memory is pre-accept).
  async function onAccept(invite: PendingInvite): Promise<void> {
    if (acceptingId !== null) return; // in-flight guard — no double submit
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
    if (busy) return; // in-flight guard — no double submit
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
      <PageHeader title={t(locale, "workspace.setupHeading")} />
      {notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}
      {/* The `self-hosted` first-account line: the boot carries `emptyInstance`
          only for the sign-in that created this instance's first account, so
          neither `saas` nor a later sign-in may claim the instance story. */}
      {boot.emptyInstance === true ? (
        <p className="text-sm text-muted-foreground">{t(locale, "workspace.emptyInstance")}</p>
      ) : null}
      {/* Pending invitations are the boot-built discovery surface (MF-2):
          an invited login sees the invites above the create form — accepting
          joins the workspace, so creation stays only for the uninvited. */}
      {boot.pendingInvites !== undefined && boot.pendingInvites.length > 0 ? (
        <div className="flex max-w-lg flex-col gap-3">
          <h2 className="font-semibold text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)">
            {t(locale, "workspace.invitesHeading")}
          </h2>
          <p className="text-sm text-muted-foreground">{t(locale, "workspace.invitesDescription")}</p>
          <ul className="flex flex-col gap-3">
            {boot.pendingInvites.map((invite) => (
              <li key={invite.inviteId}>
                <SectionCard tier="secondary">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <p className="text-sm font-medium">{invite.workspaceRef}</p>
                      <p className="text-sm text-muted-foreground">
                        {t(locale, "workspace.inviteMeta", {
                          role: t(locale, `members.role.${invite.role}`),
                          expires: formatRelativeTime(invite.expiresAt, locale),
                        })}
                      </p>
                    </div>
                    <Button onClick={() => void onAccept(invite)} disabled={acceptingId !== null}>
                      {t(locale, "workspace.inviteAccept")}
                    </Button>
                  </CardContent>
                </SectionCard>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <SectionCard tier="primary" className="max-w-lg">
        <CardHeader>
          <SectionCardTitle>{t(locale, "workspace.setupHeading")}</SectionCardTitle>
          <CardDescription>{t(locale, "workspace.setupDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </SectionCard>
    </div>
  );
}
