/**
 * Workspace settings (`/dashboard/<ref>/settings`): the workspace-level
 * controls. The server stays the SSOT for who may write them, so the page
 * gates on the caller's role before rendering any control.
 *
 * The two gates differ because the routes do: the NAME is owner-only (one
 * label is what every teammate sees) while the review concurrency is
 * owner-or-admin (it is operations, not identity).
 */
import { t } from "../../i18n";
import { PageHeader } from "@/components/PageHeader";
import type { SpaBoot } from "../boot";
import { usePathname } from "../router";
import { workspaceRefOf } from "../routes";
import { workspaceMembershipForRef } from "../shell";
import { useLiveMemberships } from "../workspace-memberships";
import { WorkspaceCheckMinScoreCard, WorkspaceConcurrencyCard, WorkspaceNameCard } from "./SettingsPage";

export function WorkspaceSettingsPage({ boot }: { boot: SpaBoot }) {
  const live = { ...boot, memberships: useLiveMemberships(boot) };
  const ref = workspaceRefOf(usePathname());
  // Resolved through the LIVE list: a rename patches it, so a mount-time copy
  // would keep showing the old name on the card.
  const membership = workspaceMembershipForRef(live, ref);
  const isOwner = membership?.role === "owner";
  const canManage = isOwner || membership?.role === "admin";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t(boot.locale, "workspace.settingsHeading")} />
      {/* A plain member sees a refusal up front instead of forms whose saves
          would fail; each manager sees exactly the cards their role may write. */}
      {canManage ? (
        // Keyed by the workspace: the cards hold that workspace's loaded value
        // and draft, while their saves resolve the URL. An in-app switch must
        // remount them, or A's state would be submitted to B.
        <div key={ref ?? ""} className="flex flex-col">
          {isOwner ? <WorkspaceNameCard locale={boot.locale} storedName={membership.name} /> : null}
          <WorkspaceConcurrencyCard locale={boot.locale} />
          <WorkspaceCheckMinScoreCard locale={boot.locale} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t(boot.locale, "workspace.settingsOwnerOnly")}</p>
      )}
    </div>
  );
}
