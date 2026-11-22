import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { Button, SidebarInset, SidebarProvider } from "@design-system";
import { t } from "../i18n";
import type { SpaBoot } from "./boot";
import { AppSidebar } from "./components/AppSidebar";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { SupportNotice } from "./components/SupportNotice";
import type { FlashKind } from "./flash";
import { PageNotice } from "./pages/PageNotice";
import { documentFaceOf, pageDocumentTitle } from "./document-title";
import { matchSpaRoute } from "./routes";
import { buildNavbarModel, buildSidebarModel, buildWorkspaceSwitcherModel } from "./shell";
import { useLiveMemberships, WorkspaceMembershipsProvider } from "./workspace-memberships";

type LayoutProps = {
  boot: SpaBoot;
  pathname: string;
  flash: FlashKind | null;
  children: ReactNode;
};

const FLASH_NOTICE: Record<
  FlashKind,
  { kind: "success" | "warn"; key: "notice.success.workspaceDeleted" | "notice.warn.workspaceUnavailable" }
> = {
  workspaceDeleted: { kind: "success", key: "notice.success.workspaceDeleted" },
  workspaceUnavailable: { kind: "warn", key: "notice.warn.workspaceUnavailable" },
};

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "mstar.dashboard.theme";

function storedTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function effectiveTheme(): Theme {
  return storedTheme() ?? "dark";
}

function LoginChrome({ children }: { children: ReactNode }) {
  return <div className="min-h-svh bg-(--surface-page) text-(--text-primary) font-sans">{children}</div>;
}

function DashboardChrome({ boot, pathname, flash, children }: LayoutProps) {
  const sidebar = buildSidebarModel(boot, pathname);
  const page = matchSpaRoute(pathname)?.page ?? null;
  const proseFace = boot.needsWorkspace === true || boot.supportOnly === true;
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
    }
  }

  return (
    <SidebarProvider defaultOpen className="h-svh overflow-hidden print:h-auto print:overflow-visible">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-(--radius-control) focus:bg-(--surface-raised) focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-(--text-primary) focus:no-underline"
      >
        {t(boot.locale, "nav.skipToContent")}
      </a>
      <AppSidebar model={sidebar} />
      <SidebarInset
        id="main"
        tabIndex={-1}
        className="h-svh overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:ring-inset print:h-auto print:overflow-visible"
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-(--surface-raised) px-4">
          <div className="flex min-w-0 items-center gap-2">
            <WorkspaceSwitcher model={switcher} boot={boot} />
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={toggleTheme} aria-label={t(boot.locale, "nav.themeToggleAria", { mode: t(boot.locale, theme === "dark" ? "nav.themeDark" : "nav.themeLight"), target: t(boot.locale, theme === "dark" ? "nav.themeLight" : "nav.themeDark") })}>
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6 print:overflow-visible">
          <div
            id="content"
            tabIndex={-1}
            className={`mx-auto w-full outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:ring-inset ${!proseFace && (page === "repos" || page === "apps" || page === "members") ? "max-w-[1200px]" : "max-w-[960px]"}`}
          >
            <SupportNotice boot={boot} pathname={pathname} />
            {flashNotice ? (
              <PageNotice kind={flashNotice.kind} message={t(boot.locale, flashNotice.key)} />
            ) : null}
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function Layout({ boot, pathname, flash: bootFlash, children }: LayoutProps) {
  const route = matchSpaRoute(pathname);
  const [flash, setFlash] = useState(bootFlash);
  const shownOn = useRef(pathname);
  useLayoutEffect(() => {
    if (shownOn.current === pathname) return;
    shownOn.current = pathname;
    setFlash(null);
  }, [pathname]);
  const announcedOn = useRef(pathname);
  const page = route?.page ?? null;
  useLayoutEffect(() => {
    if (announcedOn.current === pathname) return;
    announcedOn.current = pathname;
    document.title = pageDocumentTitle(boot.locale, page, documentFaceOf(boot));
    document.getElementById("main")?.focus();
  }, [pathname, boot.locale, page]);
  if (route?.page === "login") {
    return <LoginChrome>{children}</LoginChrome>;
  }
  return (
    <WorkspaceMembershipsProvider boot={boot}>
      <DashboardChrome boot={boot} pathname={pathname} flash={flash}>
        {children}
      </DashboardChrome>
    </WorkspaceMembershipsProvider>
  );
}
