import { NAV_ITEMS, t, type Locale } from "../i18n";
import type { SpaBoot } from "./boot";
import { workspaceRefOf } from "./routes";

export type ShellNavItem = { href: string; label: string; current: boolean };

export type SidebarModel = {
  brand: string;
  brandHref: string;
  navLabel: string;
  items: ShellNavItem[];
  operatorLink?: { href: string; label: string };
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

/** Locked chrome copy: `{name (login)}` when both differ, else login. */
export function accountDisplay(boot: Pick<SpaBoot, "login" | "name">): string | null {
  if (!boot.login) return null;
  if (boot.name && boot.name !== boot.login) return `${boot.name} (${boot.login})`;
  return boot.login;
}

/**
 * The sidebar nav is workspace-scoped throughout: Repositories →
 * `/dashboard/<ref>/repos`, Apps → `/dashboard/<ref>/apps` (+ settings under
 * `/dashboard/<ref>/apps/:appId`), Members and Settings likewise. The
 * repository overview is the dashboard default, so the brand href and the
 * Repositories entry point at the same page.
 *
 * The workspace comes from the pathname, else from the boot
 * (`SpaBoot.workspaceRef`), else from the login's first membership — so no
 * entry ever points at a retired family. The generic prefix rule marks an
 * entry current on its own detail pages too.
 */
export function isNavCurrent(href: string, pathname: string): boolean {
  if (href === "/dashboard/repos") {
    return (
      pathname === "/dashboard" ||
      pathname === "/dashboard/apps" ||
      pathname === "/dashboard/repos" ||
      pathname.startsWith("/dashboard/repos/")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function navHref(baseHref: string, workspaceRef: string | null): string {
  return workspaceRef === null ? baseHref : `/dashboard/${workspaceRef}${baseHref.slice("/dashboard".length)}`;
}

export function buildSidebarModel(boot: SpaBoot, pathname: string): SidebarModel {
  const workspaceRef =
    workspaceRefOf(pathname) ?? boot.workspaceRef ?? boot.memberships?.[0]?.id ?? null;
  const items = boot.needsWorkspace === true || boot.supportOnly === true ? [] : NAV_ITEMS;
  return {
    brand: t(boot.locale, "nav.brand"),
    brandHref: workspaceRef === null ? "/dashboard" : `/dashboard/${workspaceRef}/repos`,
    navLabel: t(boot.locale, "nav.primary"),
    items: items.map((item) => {
      const href = navHref(item.href, workspaceRef);
      return {
        href,
        label: t(boot.locale, item.labelKey),
        current: isNavCurrent(href, pathname),
      };
    }),
    ...(boot.isOperator === true
      ? { operatorLink: { href: "/_internal_admin", label: t(boot.locale, "nav.platformOperations") } }
      : {}),
  };
}

/**
 * The switcher's list: the login's workspace memberships (the boot's
 * server-resolved rows, patched in place by an in-page rename) with the CURRENT
 * path's workspace marked.
 *
 * A path segment addresses a workspace by EITHER identifier — the stable `id`
 * or the readable `slug` (they are equal until a platform operator sets one) —
 * so the current row matches on both while the value shown and navigated to is
 * always the `id` (a switch target never depends on a value someone can change).
 * Null only when the login belongs to no workspace at all: an empty list is not
 * a choice.
 *
 * `target` is how a pick moves: `replace` rewrites the current path's workspace
 * segment, so the page stays the same page under another workspace. A path with
 * no workspace segment (the dashboard root, `/index.html`) has nothing to
 * rewrite — there the control is a NAVIGATOR and a pick opens that workspace's
 * repository overview, the dashboard default.
 *
 * `currentRef` is the `id` of the membership the pathname names, else null:
 * the path can carry an identifier this login no longer lists (a renamed slug,
 * a revoked membership), or name no workspace at all. Then the control
 * marks NO row — a wrong current row is worse than none, so there is no
 * fallback to the first membership.
 *
 * `currentPlan` is that same membership row's plan NAME: the URL decides which
 * workspace the shell is scoped to, so the plan chip has to follow the URL, not
 * the document's boot-time workspace. Absent when no row is current, and on
 * `self-hosted`, whose rows carry no plan (no chip there).
 */
export type WorkspaceSwitcherModel = {
  label: string;
  currentRef: string | null;
  currentPlan?: string;
  target: "replace" | "repos";
  options: Array<{ ref: string; name: string }>;
};

export function buildWorkspaceSwitcherModel(
  boot: SpaBoot,
  pathname: string,
): WorkspaceSwitcherModel | null {
  const memberships = boot.memberships ?? [];
  if (memberships.length === 0) return null;
  const options = memberships.map(({ id, name }) => ({ ref: id, name }));
  const label = t(boot.locale, "nav.workspaceSwitcher");
  const pathRef = workspaceRefOf(pathname);
  const current =
    pathRef === null ? undefined : memberships.find((m) => pathRef === m.id || pathRef === m.slug);
  return {
    label,
    currentRef: current?.id ?? null,
    currentPlan: current?.plan,
    target: pathRef === null ? "repos" : "replace",
    options,
  };
}

/**
 * The live membership row a path ref names, or null when this login lists no
 * such workspace. A segment may address the workspace by EITHER identifier
 * (the stable `id` or the readable `slug`), which is why every caller that
 * needs the row's role resolves it here.
 */
export function workspaceMembershipForRef(
  boot: SpaBoot,
  ref: string | null,
): NonNullable<SpaBoot["memberships"]>[number] | null {
  if (ref === null) return null;
  return (boot.memberships ?? []).find((m) => ref === m.id || ref === m.slug) ?? null;
}

export function buildNavbarModel(boot: SpaBoot): NavbarModel {
  return {
    languageLabel: t(boot.locale, "nav.language"),
    languageTarget: otherLocale(boot.locale),
    accountLabel: accountDisplay(boot),
    logoutLabel: t(boot.locale, "nav.logout"),
  };
}
