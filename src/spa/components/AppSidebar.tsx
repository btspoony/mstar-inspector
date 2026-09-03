import type { MouseEvent } from "react";
import { LayoutGrid, LineChart, Users } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { matchSpaRoute } from "../routes";
import { navigate } from "../router";
import type { SidebarModel } from "../shell";

const NAV_ICONS = {
  "/dashboard/apps": LayoutGrid,
  "/dashboard/insights": LineChart,
  "/dashboard/members": Users,
} as const;

function spaClick(href: string, event: MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!matchSpaRoute(href)) return;
  event.preventDefault();
  navigate(href);
}

function Logo() {
  return (
    <svg className="size-6 shrink-0 text-primary" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 4 L13.2 10.2 L20 12 L13.2 13.8 L12 20 L10.8 13.8 L4 12 L10.8 10.2 Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function AppSidebar({ model }: { model: SidebarModel }) {
  return (
    <Sidebar collapsible="none" aria-label={model.navLabel}>
      <SidebarHeader className="border-b border-sidebar-border">
        <a
          className="flex items-center gap-2 px-2 py-1 text-sidebar-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring rounded-md"
          href="/dashboard"
          onClick={(event) => spaClick("/dashboard", event)}
        >
          <Logo />
          <span className="truncate font-semibold text-sm">{model.brand}</span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {model.items.map((item) => {
                const Icon = NAV_ICONS[item.href as keyof typeof NAV_ICONS];
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={item.current} tooltip={item.label}>
                      <a
                        href={item.href}
                        aria-current={item.current ? "page" : undefined}
                        onClick={(event) => spaClick(item.href, event)}
                      >
                        {Icon ? <Icon /> : null}
                        <span>{item.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
