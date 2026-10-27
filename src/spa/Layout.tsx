/**
 * Dashboard chrome: left sidebar (Apps / Members) +
 * slim navbar (theme + Lang + username + logout).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { t } from "../i18n";
import type { SpaBoot } from "./boot";
import { AppSidebar } from "./components/AppSidebar";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { SupportNotice } from "./components/SupportNotice";
import type { FlashKind } from "./flash";
import { PageNotice } from "./pages/PageNotice";
import { matchSpaRoute } from "./routes";
import { buildNavbarModel, buildSidebarModel, buildWorkspaceSwitcherModel } from "./shell";
import { useLiveMemberships, WorkspaceMembershipsProvider } from "./workspace-memberships";

type LayoutProps = {
  boot: SpaBoot;
  pathname: string;
  /** One-shot outcome read at boot (`./flash`): shown until the pathname changes. */
  flash: FlashKind | null;
  children: ReactNode;
};

/** The one-shot outcome copy: tone plus the dictionary key that states it. */
const FLASH_NOTICE: Record<
  FlashKind,
  { kind: "success" | "warn"; key: "notice.success.workspaceDeleted" | "notice.warn.workspaceUnavailable" }
> = {
  workspaceDeleted: { kind: "success", key: "notice.success.workspaceDeleted" },
  workspaceUnavailable: { kind: "warn", key: "notice.warn.workspaceUnavailable" },
};

type Theme = "light" | "dark";

/** Same key the pre-paint bootstrap in index.html reads. */
const THEME_STORAGE_KEY = "mstar.dashboard.theme";

/** Whitelist — a corrupted/unreadable stored value behaves as unset. */
function storedTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

/** Stored choice wins; unset = dark default (deterministic — the OS
 * preference is never consulted, v0.3.4). */
function effectiveTheme(): Theme {
  return storedTheme() ?? "dark";
}

function LoginChrome({ children }: { children: ReactNode }) {
  return <div className="min-h-svh bg-background text-foreground font-sans">{children}</div>;
}

function DashboardChrome({ boot, pathname, flash, children }: LayoutProps) {
  const sidebar = buildSidebarModel(boot, pathname);
  // The shell reads the shared membership list, not a second boot copy.
  const memberships = useLiveMemberships(boot);
  const switcher = buildWorkspaceSwitcherModel({ ...boot, memberships }, pathname);
  const navbar = buildNavbarModel(boot);
  const flashNotice = flash === null ? null : FLASH_NOTICE[flash];
  const [theme, setTheme] = useState<Theme>(effectiveTheme);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Unavailable storage (e.g. private mode) — the flip still applies this session.
    }
  }

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar model={sidebar} />
      <SidebarInset>
        {/* v0.3 (DESIGN.md): navbar sits on background-200, one step above the
            page canvas, matching the sidebar chrome layer. Two clusters: the
            workspace switcher names what the whole shell is scoped to (left),
            the account/locale/theme controls stay right. Control states
            (hover/active/focus-visible) come from the restyled ghost Button. */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-(--background-200) px-4">
          <div className="flex min-w-0 items-center gap-2">
            <WorkspaceSwitcher model={switcher} boot={boot} />
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={toggleTheme} aria-label={t(boot.locale, "nav.themeToggleAria", { mode: t(boot.locale, theme === "dark" ? "nav.themeDark" : "nav.themeLight"), target: t(boot.locale, theme === "dark" ? "nav.themeLight" : "nav.themeDark") })}>
              {/* Icon-only: the icon depicts the CURRENT mode; the aria-label carries the action. */}
              {theme === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </Button>
            <form className="m-0" method="post" action="/dashboard/locale">
              <input type="hidden" name="locale" value={navbar.languageTarget} />
              <Button type="submit" variant="ghost" size="sm">
                {navbar.languageLabel}
              </Button>
            </form>
            {navbar.accountLabel ? (
              <span className="hidden max-w-48 truncate text-sm text-muted-foreground sm:inline">{navbar.accountLabel}</span>
            ) : null}
            {boot.login ? (
              <Button asChild variant="ghost" size="sm">
                <a href="/dashboard/logout">{navbar.logoutLabel}</a>
              </Button>
            ) : null}
          </div>
        </header>
        <div className="flex flex-1 flex-col p-4 md:p-6">
          {/* The undismissable support notice sits above every workspace page:
              the tenant must see an active operator grant on any screen, and it
              carries no control (AC4). */}
          <SupportNotice boot={boot} pathname={pathname} />
          {/* One-shot outcome from the page just left (the delete flow): the
              boot read and cleared its key, so this load shows it once. */}
          {flashNotice ? (
            <PageNotice kind={flashNotice.kind} message={t(boot.locale, flashNotice.key)} />
          ) : null}
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function Layout({ boot, pathname, flash: bootFlash, children }: LayoutProps) {
  const route = matchSpaRoute(pathname);
  // One-shot per NAVIGATION, not per mount: the boot's flash stays on screen
  // through any re-render of the same pathname (it rendered, so it must be
  // seen), and the first move away clears it — which is what keeps an
  // A → B → A walk from showing a spent outcome again.
  const [flash, setFlash] = useState(bootFlash);
  const shownOn = useRef(pathname);
  // Layout effect, not passive: the frame that presents the NEW pathname must
  // not still carry the previous page's outcome. A same-pathname re-render
  // returns early, so the copy is cleared by navigation only.
  useLayoutEffect(() => {
    if (shownOn.current === pathname) return;
    shownOn.current = pathname;
    setFlash(null);
  }, [pathname]);
  if (route?.page === "login") {
    return <LoginChrome>{children}</LoginChrome>;
  }
  // Provider above the chrome: the switcher reads the live list here, and the
  // page's rename card (rendered as `children`) writes it.
  return (
    <WorkspaceMembershipsProvider boot={boot}>
      <DashboardChrome boot={boot} pathname={pathname} flash={flash}>
        {children}
      </DashboardChrome>
    </WorkspaceMembershipsProvider>
  );
}
