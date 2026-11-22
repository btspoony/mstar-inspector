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
        <TabsList
          variant="line"
          className="group-data-[orientation=horizontal]/tabs:h-10 w-full justify-start gap-4 border-b border-border p-0"
        >
          <TabsTrigger value="quota">{t(boot.locale, "workspace.tabQuota")}</TabsTrigger>
          <TabsTrigger value="configuration">{t(boot.locale, "workspace.tabConfiguration")}</TabsTrigger>
        </TabsList>
        <TabsContent value="quota" forceMount>
          <ReviewUsageCard
            key={ref ?? ""}
            locale={boot.locale}
            deploymentMode={boot.deploymentMode}
          />
        </TabsContent>
        <TabsContent value="configuration" forceMount>
          <div key={ref ?? ""} className="flex flex-col">
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
