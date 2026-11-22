import type { Locale } from "../i18n";

export type SpaBoot = {
  locale: Locale;
  login: string | null;
  name: string | null;
  workspaceRef?: string;
  deploymentMode?: "self-hosted" | "saas";
  isOperator?: boolean;
  canCreateApp?: boolean;
  canCreateWorkspace?: boolean;
  createWorkspaceBlockedReason?: "free_slot" | "flag" | null;
  workspaceRequired?: boolean;
  memberships?: Array<{
    id: string;
    slug: string;
    name: string;
    role: "owner" | "admin" | "member";
    plan: string;
  }>;
  pendingInvites?: Array<{
    workspaceRef: string;
    inviteId: string;
    role: "admin" | "member";
    expiresAt: string;
  }>;
  needsWorkspace?: boolean;
  supportOnly?: boolean;
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
