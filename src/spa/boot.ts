/**
 * Per-request SPA bootstrap.
 *
 * Channel: the Worker SPA dispatcher fetches `dist/spa/index.html` and
 * replaces `<!--SPA_BOOT-->` with `window.__BOOT__ = {…}` before returning
 * the document. The session cookie is HttpOnly, so the client cannot read
 * login/role itself — this injection is the only bootstrap path.
 *
 * Shape is intentionally small (locale + identity + the deployment's sole
 * workspace slug + the caller's create capability). Page data comes from the
 * dashboard API under the page's own workspace prefix (`workspace-base.ts`) —
 * the injected slug is navigation only, for the pages whose pathname names no
 * workspace (Members).
 */
import type { Locale } from "../i18n";

export type SpaBoot = {
  locale: Locale;
  login: string | null;
  name: string | null;
  role: "admin" | "member" | null;
  /**
   * The deployment's sole live workspace under `strict`, resolved server-side
   * through the sign-in landing's resolver. Absent under `off` and whenever the
   * deployment cannot name exactly one — the shell then keeps its legacy
   * targets. A workspace-scoped pathname always wins over this value.
   */
  workspaceSlug?: string;
  /**
   * Absent or `true` = the caller may run the manifest Create flow. The server
   * sets `false` under `strict` for a plain workspace member, who would not be
   * able to manage the App the flow creates (I-000082); the SPA then renders no
   * Create action. `off` never sets it, so its output is unchanged.
   */
  canCreateApp?: boolean;
  /**
   * The signed-in login's live pending workspace invitations — the invitee's
   * discovery surface. Empty/absent for a login nobody invited.
   * Each row names the workspace ref plus the invite id the accept POST takes.
   */
  /**
   * `true` = this login belongs to no live workspace yet, so the shell is the
   * creation surface: the SPA renders the workspace-creation page
   * instead of the workspace pages, which would 404.
   */
  needsWorkspace?: boolean;
  pendingInvites?: Array<{
    workspaceRef: string;
    inviteId: string;
    role: "admin" | "member";
    expiresAt: string;
  }>;
};

export const EMPTY_BOOT: SpaBoot = { locale: "en", login: null, name: null, role: null };

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
