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

export function WorkspaceSettingsPage({ boot }: { boot: SpaBoot }) {
  const ref = workspaceRefOf(usePathname());
  // The workspace controls are owner-only on the server; a non-owner gets a
  // refusal up front instead of an editable form whose save would 403.
  const isOwner = workspaceMembershipForRef(boot, ref)?.role === "owner";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(boot.locale, "workspace.settingsHeading")} />
      {isOwner ? null : (
        <p className="text-sm text-muted-foreground">{t(boot.locale, "workspace.settingsOwnerOnly")}</p>
      )}
    </div>
  );
}
