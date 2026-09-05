/**
 * Dashboard chrome (plan 33 T2): left sidebar (Apps / Insights / Members) +
 * slim navbar (theme + Lang + username + logout).
 */
import { useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { t } from "../i18n";
import type { SpaBoot } from "./boot";
import { AppSidebar } from "./components/AppSidebar";
import { matchSpaRoute } from "./routes";
import { buildNavbarModel, buildSidebarModel } from "./shell";

type LayoutProps = {
  boot: SpaBoot;
  pathname: string;
  children: ReactNode;
};

type Theme = "light" | "dark";

/** Same key the pre-paint bootstrap in index.html reads (plan 41). */
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

/** Stored choice wins; unset follows the OS (dark console default otherwise). */
function effectiveTheme(): Theme {
  return storedTheme() ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

function LoginChrome({ children }: { children: ReactNode }) {
  return <div className="min-h-svh bg-background text-foreground font-sans">{children}</div>;
}

function DashboardChrome({ boot, pathname, children }: LayoutProps) {
  const sidebar = buildSidebarModel(boot, pathname);
  const navbar = buildNavbarModel(boot);
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
        <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b border-border bg-background px-4">
          <Button type="button" variant="ghost" size="sm" onClick={toggleTheme} aria-label={t(boot.locale, "nav.themeToggleAria", { mode: t(boot.locale, theme === "dark" ? "nav.themeDark" : "nav.themeLight"), target: t(boot.locale, theme === "dark" ? "nav.themeLight" : "nav.themeDark") })}>
            {/* Icon-only (plan 44): the icon depicts the CURRENT mode; the aria-label carries the action. */}
            {theme === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
          </Button>
          <form className="m-0" method="post" action="/dashboard/locale">
            <input type="hidden" name="locale" value={navbar.languageTarget} />
            <Button type="submit" variant="ghost" size="sm">
              {navbar.languageLabel}
            </Button>
          </form>
          {navbar.accountLabel ? (
            <span className="hidden text-sm text-muted-foreground sm:inline">{navbar.accountLabel}</span>
          ) : null}
          {boot.login ? (
            <Button asChild variant="ghost" size="sm">
              <a href="/dashboard/logout">{navbar.logoutLabel}</a>
            </Button>
          ) : null}
        </header>
        <div className="flex flex-1 flex-col p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function Layout({ boot, pathname, children }: LayoutProps) {
  const route = matchSpaRoute(pathname);
  if (route?.page === "login") {
    return <LoginChrome>{children}</LoginChrome>;
  }
  return (
    <DashboardChrome boot={boot} pathname={pathname}>
      {children}
    </DashboardChrome>
  );
}
