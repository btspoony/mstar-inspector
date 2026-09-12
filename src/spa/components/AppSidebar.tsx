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
import type { SidebarModel } from "../shell";
import { spaClick } from "../spa-click";

const NAV_ICONS = {
  "/dashboard/apps": LayoutGrid,
  "/dashboard/insights": LineChart,
  "/dashboard/members": Users,
} as const;

/**
 * Brand mark (plan 58 A3): the sidebar wordmark mark is the single source —
 * the login face's wordmark echo imports this same silhouette instead of
 * duplicating it. Color rides `currentColor` (`text-primary` = brand-700
 * through the shadcn bridge); size is set at the usage site.
 */
export function Logo() {
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
      <SidebarHeader className="border-b border-sidebar-border p-3">
        <a
          className="flex items-center gap-2 rounded-sm px-2 py-1 text-sidebar-foreground no-underline outline-none transition-[color,background-color] duration-(--duration-base) ease-(--ease-in-out) hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          href="/dashboard"
          onClick={(event) => spaClick("/dashboard", event)}
        >
          <Logo />
          <span className="truncate text-sm font-semibold tracking-tight">{model.brand}</span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="p-3">
          <SidebarGroupContent>
            <SidebarMenu>
              {model.items.map((item) => {
                const Icon = NAV_ICONS[item.href as keyof typeof NAV_ICONS];
                return (
                  <SidebarMenuItem key={item.href}>
                    {/* Active face (plan 64 AD-641): low-alpha brand tint +
                        medium weight live in the SidebarMenuButton variant
                        string — no edge/fill className appendage here. */}
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
