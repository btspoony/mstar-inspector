/**
 * Pure shell models: sidebar carries page nav; navbar is slim
 * (Lang + username + logout). Tested without a DOM runner.
 */
import { NAV_ITEMS, t, type Locale } from "../i18n";
import type { SpaBoot } from "./boot";
import { replaceWorkspaceRef, workspaceRefOf } from "./routes";

export type ShellNavItem = { href: string; label: string; current: boolean };

export type SidebarModel = {
  brand: string;
  /** Same target as the Apps entry: the root is a dead end under `strict`. */
  brandHref: string;
  navLabel: string;
  items: ShellNavItem[];
};

export type NavbarModel = {
  languageLabel: string;
  languageTarget: Locale;
  accountLabel: string | null;
  logoutLabel: string;
};

export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "zh_CN" : "en";
}

export function visibleNavItems(role: SpaBoot["role"]): typeof NAV_ITEMS {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === "admin");
}

/** Locked chrome copy: `{name (login)}` when both differ, else login. */
export function accountDisplay(boot: Pick<SpaBoot, "login" | "name">): string | null {
  if (!boot.login) return null;
  if (boot.name && boot.name !== boot.login) return `${boot.name} (${boot.login})`;
  return boot.login;
}

/**
 * Apps → `/dashboard`, `/dashboard/apps` (+ settings under
 * `/dashboard/apps/:slug`) — the root lands on Apps, so the brand href and
 * `/dashboard/apps` highlight the same entry. Remaining entries follow the
 * generic rule below.
 *
 * On a workspace-scoped page BOTH entries follow that workspace: Apps becomes
 * `/dashboard/<ref>/apps` and Members `/dashboard/<ref>/members`, because both
 * route families are workspace-scoped. The workspace comes from
 * the pathname, else from the boot (`SpaBoot.workspaceRef`, the server-resolved
 * sole workspace under `strict`). The generic prefix rule then also marks the
 * scoped Apps entry current on its own detail pages.
 */
export function isNavCurrent(href: string, pathname: string): boolean {
  if (href === "/dashboard/apps") {
    return (
      pathname === "/dashboard" ||
      pathname === "/dashboard/apps" ||
      pathname.startsWith("/dashboard/apps/")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** One nav entry's href under a resolved workspace ref (null = legacy). */
function navHref(baseHref: string, workspaceRef: string | null): string {
  return workspaceRef === null ? baseHref : `/dashboard/${workspaceRef}${baseHref.slice("/dashboard".length)}`;
}

export function buildSidebarModel(boot: SpaBoot, pathname: string): SidebarModel {
  // The page's own prefix wins (it is the route the request was matched
  // against); the boot ref covers the mode-independent pages, whose pathname
  // names no workspace. Both absent → the legacy targets.
  const workspaceRef = workspaceRefOf(pathname) ?? boot.workspaceRef ?? null;
  // No workspace yet → every nav target would 404; the shell keeps its
  // wordmark and drops the entries (creation surface).
  const items = boot.needsWorkspace === true ? [] : visibleNavItems(boot.role);
  return {
    brand: t(boot.locale, "nav.brand"),
    // The root workbench 404s its data reads under `strict`, so the wordmark
    // follows the same workspace Apps target as the nav entry there.
    brandHref: workspaceRef === null ? "/dashboard" : `/dashboard/${workspaceRef}/apps`,
    navLabel: t(boot.locale, "nav.primary"),
    items: items.map((item) => {
      const href = navHref(item.href, workspaceRef);
      return {
        href,
        label: t(boot.locale, item.labelKey),
        current: isNavCurrent(href, pathname),
      };
    }),
  };
}

/**
 * The switcher's list: the login's memberships in the boot (server-resolved)
 * with the CURRENT path's workspace marked. Null when the login belongs to at
 * most one workspace — a one-entry select is not a choice, so the shell renders
 * no control at all — and null when the path has no workspace segment to
 * rewrite (`/dashboard`, `/dashboard/apps`, `/index.html`), where a control
 * would render and then no-op every choice. `currentRef` is the membership the
 * pathname already names (detected by the same substitution the switch uses),
 * else null when the path names a ref this login no longer lists, so the
 * control must fall back to a deterministic value rather than a false
 * selection.
 */
export type WorkspaceSwitcherModel = {
  label: string;
  currentRef: string | null;
  options: Array<{ ref: string; name: string }>;
};

export function buildWorkspaceSwitcherModel(
  boot: SpaBoot,
  pathname: string,
): WorkspaceSwitcherModel | null {
  const memberships = boot.memberships ?? [];
  if (memberships.length < 2) return null;
  const options = memberships.map(({ ref, name }) => ({ ref, name }));
  // A path with no workspace segment to rewrite (`/dashboard`, `/dashboard/apps`,
  // `/index.html`) renders NO control: one that rendered could only no-op, and
  // `/dashboard` is the post-login landing of a multi-workspace deployment.
  if (replaceWorkspaceRef(pathname, options[0]!.ref) === null) return null;
  // The current ref is the option whose substitution leaves the path unchanged
  // (same grammar as the switch itself). A path can still carry a ref this
  // login no longer lists (a renamed slug, a revoked membership): the control
  // then marks nothing, so it must render a deterministic value (the component
  // falls back to the first membership).
  const currentRef = options.find((option) => replaceWorkspaceRef(pathname, option.ref) === pathname)?.ref ?? null;
  return {
    label: t(boot.locale, "nav.workspaceSwitcher"),
    currentRef,
    options,
  };
}

export function buildNavbarModel(boot: SpaBoot): NavbarModel {
  return {
    languageLabel: t(boot.locale, "nav.language"),
    languageTarget: otherLocale(boot.locale),
    accountLabel: accountDisplay(boot),
    logoutLabel: t(boot.locale, "nav.logout"),
  };
}
