/**
 * Workspace settings (`/dashboard/<ref>/settings`): the workspace-level
 * controls. The server stays the SSOT for who may write them, so the page
 * gates on the caller's role before rendering any control.
 *
 * The two gates differ because the routes do: the NAME is owner-only (one
 * label is what every teammate sees) while the review concurrency is
 * owner-or-admin (it is operations, not identity).
 *
 * Two faces, the same header + tabs + content shell the App and repository
 * detail pages mount: 额度 (the read-only spend of the addressed workspace)
 * and 配置 (the cards a manager may write). The active tab is local state —
 * this page derives nothing from `location.search`, so a `?tab=` param would
 * be a second convention no other reader of this URL knows.
 */
import { useState } from "react";
import { t } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@design-system";
import type { SpaBoot } from "../boot";
import { usePathname } from "../router";
import { workspaceRefOf } from "../routes";
import { workspaceMembershipForRef } from "../shell";
import { useLiveMemberships } from "../workspace-memberships";
import { ReviewUsageCard } from "./ReviewUsageCard";
import { WorkspaceCheckMinScoreCard, WorkspaceConcurrencyCard, WorkspaceNameCard } from "./SettingsPage";

type WorkspaceSettingsTab = "quota" | "configuration";

export function WorkspaceSettingsPage({ boot }: { boot: SpaBoot }) {
  const live = { ...boot, memberships: useLiveMemberships(boot) };
  const ref = workspaceRefOf(usePathname());
  // Resolved through the LIVE list: a rename patches it, so a mount-time copy
  // would keep showing the old name on the card.
  const membership = workspaceMembershipForRef(live, ref);
  const isOwner = membership?.role === "owner";
  const canManage = isOwner || membership?.role === "admin";
  const [tab, setTab] = useState<WorkspaceSettingsTab>("quota");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(boot.locale, "workspace.settingsHeading")} />
      <Tabs
        value={tab}
        onValueChange={(next) => setTab(next === "configuration" ? "configuration" : "quota")}
      >
        {/* Page-level tab face (DESIGN.md ### Tabs, line-tab idiom), the same bar
            the App and repository detail pages mount. */}
        <TabsList
          variant="line"
          className="group-data-[orientation=horizontal]/tabs:h-10 w-full justify-start gap-4 border-b border-border p-0"
        >
          <TabsTrigger value="quota">{t(boot.locale, "workspace.tabQuota")}</TabsTrigger>
          <TabsTrigger value="configuration">{t(boot.locale, "workspace.tabConfiguration")}</TabsTrigger>
        </TabsList>
        {/* forceMount on both panels: every card keeps its loaded value, draft
            and notice across a switch — no unmount, no refetch, and a save's
            refusal stays readable after the reader looks at the other tab. */}
        <TabsContent value="quota" forceMount>
          {/* Read-only usage of the addressed workspace — every member sees it,
              because it is not a setting. Keyed by the workspace for the same
              reason the configuration cards are: the card holds that
              workspace's loaded month while its read resolves the URL, so an
              in-app switch must remount it or A's spend would stay on screen
              for B. */}
          <ReviewUsageCard
            key={ref ?? ""}
            locale={boot.locale}
            deploymentMode={boot.deploymentMode}
          />
        </TabsContent>
        <TabsContent value="configuration" forceMount>
          {/* Keyed by the workspace: the cards hold that workspace's loaded value
              and draft, while their saves resolve the URL. An in-app switch must
              remount them, or A's state would be submitted to B. */}
          <div key={ref ?? ""} className="flex flex-col">
            {/* A plain member sees a refusal up front instead of forms whose saves
                would fail; each manager sees exactly the cards their role may write. */}
            {canManage ? (
              <>
                {isOwner ? <WorkspaceNameCard locale={boot.locale} storedName={membership.name} /> : null}
                <WorkspaceConcurrencyCard locale={boot.locale} />
                <WorkspaceCheckMinScoreCard locale={boot.locale} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t(boot.locale, "workspace.settingsOwnerOnly")}</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
