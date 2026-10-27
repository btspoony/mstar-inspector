/**
 * Workspace settings (`/dashboard/<ref>/settings`): the workspace-level
 * controls. The server stays the SSOT for who may write them, so the page
 * gates on the caller's role before rendering any control.
 */
import { t } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import type { SpaBoot } from "../boot";
import { usePathname } from "../router";
import { workspaceRefOf } from "../routes";
import { workspaceMembershipForRef } from "../shell";
import { useLiveMemberships } from "../workspace-memberships";
import { WorkspaceNameCard } from "./SettingsPage";

export function WorkspaceSettingsPage({ boot }: { boot: SpaBoot }) {
  const live = { ...boot, memberships: useLiveMemberships(boot) };
  const ref = workspaceRefOf(usePathname());
  // Resolved through the LIVE list: a rename patches it, so a mount-time copy
  // would keep showing the old name on the card.
  const membership = workspaceMembershipForRef(live, ref);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(boot.locale, "workspace.settingsHeading")} />
      {/* The controls are owner-only on the server; a non-owner gets a refusal
          up front instead of an editable form whose save would 403. */}
      {membership?.role === "owner" ? (
        <WorkspaceNameCard locale={boot.locale} storedName={membership.name} />
      ) : (
        <p className="text-sm text-muted-foreground">{t(boot.locale, "workspace.settingsOwnerOnly")}</p>
      )}
    </div>
  );
}
