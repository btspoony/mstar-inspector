/**
 * Per-request SPA bootstrap.
 *
 * Channel: the Worker SPA dispatcher fetches `dist/spa/index.html` and
 * replaces `<!--SPA_BOOT-->` with `window.__BOOT__ = {…}` before returning
 * the document. The session cookie is HttpOnly, so the client cannot read the
 * login itself — this injection is the only bootstrap path.
 *
 * Shape is intentionally small (locale + identity + the addressed workspace ref
 * + the caller's create capability + the login's live memberships). Page data
 * comes from the dashboard API under the page's own workspace prefix
 * (`workspace-base.ts`) — the injected ref is navigation only, for the pages
 * whose pathname names no workspace.
 */
import type { Locale } from "../i18n";

export type SpaBoot = {
  locale: Locale;
  login: string | null;
  name: string | null;
  /**
   * The workspace ref (its slug) the boot was resolved for: the path's own
   * segment when it has one, else the deployment's sole live workspace. Absent
   * on a multi-workspace deployment whose page names none. A workspace-scoped
   * pathname always wins.
   */
  workspaceRef?: string;
  /**
   * The addressed workspace's plan NAME (`Free` / `Pro` / `Unlimited`), resolved
   * with the deployment mode on the same boot read. The top bar's plan chip
   * renders it in `saas` only (D15/D20) — the mode gates the rendering, never
   * the payload, so `self-hosted` carries the same shape.
   */
  workspacePlan?: string;
  /**
   * The deployment shape (`DEPLOYMENT_MODE`), resolved by the Worker: `saas`
   * or `self-hosted`. The SPA branches rendering on it (plan chip, members
   * plan card) instead of inferring a shape or asking for a second fetch. The
   * Worker sets it on every shell it serves; `EMPTY_BOOT` (no document) has
   * none.
   */
  deploymentMode?: "self-hosted" | "saas";
  /**
   * Absent or `true` = the caller may run the manifest Create flow. The server
   * sets `false` for a caller who is not owner/admin of the addressed
   * workspace, who would not be able to manage the App the flow creates
   * (I-000082); the SPA then renders the Create control disabled and names the
   * reason — `workspaceRequired` when the deployment could not be narrowed to
   * one workspace, the role otherwise.
   */
  canCreateApp?: boolean;
  /**
   * `true` = this login may create a workspace now. `saas` allows one free
   * workspace per login, so it is `false` once the login holds a free
   * membership; `self-hosted` always allows it. A UX mirror only: the creation
   * route re-checks under the write. Absent = anonymous boot, no answer.
   */
  canCreateWorkspace?: boolean;
  /**
   * Why {@link canCreateWorkspace} is `false`, for the disabled item's reason
   * copy. `null` whenever creation is allowed; absent with the capability.
   */
  createWorkspaceBlockedReason?: "free_slot" | null;
  /**
   * `true` = this deployment carries more than one live workspace and the
   * current path names none, so no single workspace can be attributed. The
   * shell renders the login's workspace list instead of guessing one.
   */
  workspaceRequired?: boolean;
  /**
   * The signed-in login's live workspace memberships — the switcher's list and
   * the settings slug card's stored value. A path segment may address the
   * workspace by EITHER identifier, so both ride the payload: `id` (stable) and
   * `slug` (the readable segment, equal to `id` until renamed). The switcher
   * matches the current row on either and rewrites the path to `slug`; `role`
   * decides nav visibility (the Members entry is for every workspace member).
   * Empty/absent for a login in no workspace, which renders no switcher.
   */
  memberships?: Array<{
    id: string;
    slug: string;
    name: string;
    role: "owner" | "admin" | "member";
  }>;
  /**
   * The signed-in login's live pending workspace invitations — the invitee's
   * discovery surface. Empty/absent for a login nobody invited.
   * Each row names the workspace ref plus the invite id the accept POST takes.
   */
  pendingInvites?: Array<{
    workspaceRef: string;
    inviteId: string;
    role: "admin" | "member";
    expiresAt: string;
  }>;
  /**
   * `true` = this login belongs to no live workspace yet, so the shell is the
   * creation surface: the SPA renders the workspace-creation page
   * instead of the workspace pages, which would 404.
   */
  needsWorkspace?: boolean;
  /**
   * `true` = a platform operator holding a live support grant on the boot's
   * workspace, with no membership anywhere. The shell shows the read-only
   * support face instead of the creation page — an operator's grant is a visit
   * to an existing workspace, not the start of one.
   */
  supportOnly?: boolean;
  /**
   * `true` = this sign-in created the first account on a `self-hosted`
   * instance, so the creation page also says the instance has no accounts
   * besides this one. Only the OAuth callback marks it (its own insert is what
   * makes `users` non-empty, so the shell cannot recompute the fact), and only
   * a `self-hosted` deployment ever carries it — a `saas` landing shows
   * workspace creation and nothing about the instance.
   */
  emptyInstance?: boolean;
};

export const EMPTY_BOOT: SpaBoot = { locale: "en", login: null, name: null };

export const SPA_BOOT_MARKER = "<!--SPA_BOOT-->";

export function readBoot(): SpaBoot {
  const boot = (globalThis as { window?: { __BOOT__?: SpaBoot } }).window?.__BOOT__;
  return boot ?? EMPTY_BOOT;
}

/**
 * Inject the boot script. `<` in JSON is escaped so a display name cannot
 * close the script tag.
 */
export function injectSpaBoot(html: string, boot: SpaBoot): string {
  const json = JSON.stringify(boot).replaceAll("<", "\\u003c");
  const tag = `<script>window.__BOOT__=${json};</script>`;
  if (html.includes(SPA_BOOT_MARKER)) return html.replace(SPA_BOOT_MARKER, tag);
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) return `${html.slice(0, headClose)}${tag}${html.slice(headClose)}`;
  return `${tag}${html}`;
}
