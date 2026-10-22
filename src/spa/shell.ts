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
 * with the CURRENT path's workspace marked.
 *
 * A path segment addresses a workspace by EITHER identifier — the stable `id`
 * or the readable `slug` (they are equal until an owner renames it) — so the
 * current row matches on both while the value shown and navigated to is always
 * the `slug` (a switch target must be the readable ref, never a stale one).
 * Null when the login belongs to at most one workspace — a one-entry select is
 * not a choice, so the shell renders no control at all — and null when the path
 * has no workspace segment to rewrite, where a control would render and then
 * no-op every choice.
 *
 * `currentRef` is the `slug` of the membership the pathname names, else null:
 * the path can carry an identifier this login no longer lists (a slug renamed
 * away, a revoked membership). Then the control marks NO row — a wrong current
 * row is worse than none, so there is no fallback to the first membership.
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
  const options = memberships.map(({ slug, name }) => ({ ref: slug, name }));
  const pathRef = workspaceRefOf(pathname);
  // ONE predicate for "this path can be switched": the path grammar the route
  // matcher and the API base read, plus the rewrite the switch itself performs.
  // A path outside either has no segment to rewrite, so the control would only
  // no-op every choice.
  if (pathRef === null || replaceWorkspaceRef(pathname, pathRef) === null) return null;
  const current = memberships.find((m) => pathRef === m.id || pathRef === m.slug);
  return {
    label: t(boot.locale, "nav.workspaceSwitcher"),
    currentRef: current?.slug ?? null,
    options,
  };
}

/**
 * The workspace's STORED slug for a path ref — what the settings rename control
 * shows and saves. The boot membership is authoritative (the path segment may
 * be the stable `id`, or a slug that this page's own rename has already moved
 * away from); the segment is only the fallback for a ref this login does not
 * list.
 *
 * shortcut: the boot is per-document, so after an in-page rename only the NEW
 * segment resolves (the boot still lists the old slug). Navigating back to the
 * stable id within that same document would show the pre-rename slug. Upgrade
 * to a per-rename boot patch if that path is ever reachable through the UI.
 */
export function storedSlugForRef(boot: SpaBoot, ref: string | null): string {
  if (ref === null) return "";
  const membership = (boot.memberships ?? []).find((m) => ref === m.id || ref === m.slug);
  return membership?.slug ?? ref;
}

export function buildNavbarModel(boot: SpaBoot): NavbarModel {
  return {
    languageLabel: t(boot.locale, "nav.language"),
    languageTarget: otherLocale(boot.locale),
    accountLabel: accountDisplay(boot),
    logoutLabel: t(boot.locale, "nav.logout"),
  };
}
