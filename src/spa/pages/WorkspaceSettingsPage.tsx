/**
 * Workspace settings (`/dashboard/<ref>/settings`): the workspace-level
 * controls that used to be reachable only from the App settings view. Today
 * that is the readable URL (slug) rename; the card was moved out of the App
 * settings view and this page is its only entry point, and the server stays
 * the SSOT for who may write it.
 */
import { t } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import type { SpaBoot } from "../boot";
import { usePathname } from "../router";
import { workspaceRefOf } from "../routes";
import { storedSlugForRef, workspaceMembershipForRef } from "../shell";
import { useLiveMemberships } from "../workspace-memberships";
import { WorkspaceSlugCard } from "./SettingsPage";

export function WorkspaceSettingsPage({ boot }: { boot: SpaBoot }) {
  // Resolved through the LIVE list for the same reason as the App settings
  // view: a rename patches that list and replaces the path, and a mount-time
  // copy would keep showing the retired slug.
  const memberships = useLiveMemberships(boot);
  const live = { ...boot, memberships };
  const ref = workspaceRefOf(usePathname());
  // The rename is owner-only on the server; a non-owner gets the refusal copy
  // up front instead of an editable form whose save would 403.
  const isOwner = workspaceMembershipForRef(live, ref)?.role === "owner";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(boot.locale, "workspace.settingsHeading")} />
      {isOwner ? (
        <WorkspaceSlugCard locale={boot.locale} storedSlug={storedSlugForRef(live, ref)} />
      ) : (
        <p className="text-sm text-muted-foreground">{t(boot.locale, "workspace.slugForbidden")}</p>
      )}
    </div>
  );
}
