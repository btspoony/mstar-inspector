/**
 * Dashboard chrome (plan 33 T2): left sidebar (Apps / Insights / Members) +
 * slim navbar (Lang + username + logout).
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { SpaBoot } from "./boot";
import { AppSidebar } from "./components/AppSidebar";
import { matchSpaRoute } from "./routes";
import { buildNavbarModel, buildSidebarModel } from "./shell";

type LayoutProps = {
  boot: SpaBoot;
  pathname: string;
  children: ReactNode;
};

function LoginChrome({ children }: { children: ReactNode }) {
  return <div className="min-h-svh bg-background text-foreground font-sans">{children}</div>;
}

function DashboardChrome({ boot, pathname, children }: LayoutProps) {
  const sidebar = buildSidebarModel(boot, pathname);
  const navbar = buildNavbarModel(boot);

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar model={sidebar} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b border-border bg-background px-4">
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
