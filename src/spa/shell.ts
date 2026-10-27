/**
 * Pure shell models: sidebar carries page nav; navbar is slim
 * (Lang + username + logout). Tested without a DOM runner.
 */
import { NAV_ITEMS, t, type Locale } from "../i18n";
import type { SpaBoot } from "./boot";
import { workspaceRefOf } from "./routes";

export type ShellNavItem = { href: string; label: string; current: boolean };

export type SidebarModel = {
  brand: string;
  /** Same target as the Apps entry: the root is a dead end under `strict`. */
  brandHref: string;
  navLabel: string;
  items: ShellNavItem[];
  /**
   * Footer entry to the platform console. Present only for a `saas` boot whose
   * viewer is a platform operator — the Worker combines both conjuncts into
   * `SpaBoot.isOperator`, so this model never evaluates the allowlist.
   */
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
 * Apps → `/dashboard`, `/dashboard/apps` (+ settings under
 * `/dashboard/apps/:slug`) — the root lands on Apps, so the brand href and
 * `/dashboard/apps` highlight the same entry. Remaining entries follow the
 * generic rule below.
 *
 * On a workspace-scoped page BOTH entries follow that workspace: Apps becomes
 * `/dashboard/<ref>/apps` and Members `/dashboard/<ref>/members`, because both
 * route families are workspace-scoped. The workspace comes from the pathname,
 * else from the boot (`SpaBoot.workspaceRef`), else from the login's first
 * membership — so no entry ever points at the retired `/dashboard/apps`
 * family. The generic prefix rule then also marks the scoped Apps entry
 * current on its own detail pages.
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
  // names no workspace. Both absent (a multi-workspace deployment has no sole
  // workspace to name) → the login's own first membership, the same target the
  // landing uses, so no entry points at the retired `/dashboard/apps` family.
  const workspaceRef =
    workspaceRefOf(pathname) ?? boot.workspaceRef ?? boot.memberships?.[0]?.id ?? null;
  // No workspace yet → every nav target would 404; the shell keeps its
  // wordmark and drops the entries (creation surface). An operator under a
  // support grant gets the same treatment: its one page is the support view,
  // and every other entry would only 403 that page's reads. Otherwise every
  // entry renders for every workspace member — Members is readable by all, and
  // the page's own actions stay role-gated.
  const items = boot.needsWorkspace === true || boot.supportOnly === true ? [] : NAV_ITEMS;
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
    // Footer entry, never a nav item: the console lives outside the SPA route
    // table, and NAV_ITEMS order stays the workspace IA.
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
 * no workspace segment (the root workbench, `/index.html`) has nothing to
 * rewrite — there the control is a NAVIGATOR and a pick opens that workspace's
 * Apps page.
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
  target: "replace" | "apps";
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
    target: pathRef === null ? "apps" : "replace",
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
