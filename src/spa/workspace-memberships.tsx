/**
 * The login's workspace memberships as LIVE client state (plan 98 fix 2).
 *
 * The boot is a per-document snapshot and the rename navigates with
 * `replaceState`, so nothing ever refreshes it. Patched in place, the switcher
 * would keep offering the retired slug (a 404 under D8) while its current row
 * went empty on the new path.
 *
 * A context rather than props: the renamer and the reader sit on opposite sides
 * of the router — `Layout` renders the switcher from its own props, while the
 * rename happens four levels down inside the settings card, whose page
 * (`DashboardPage`) is a child node `main.tsx` builds outside `Layout`.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { SpaBoot } from "./boot";
import { renameWorkspaceMembership } from "./shell";

const WorkspaceMembershipsContext = createContext<{
  memberships: SpaBoot["memberships"];
  rename: (ref: string | null, slug: string) => void;
} | null>(null);

export function WorkspaceMembershipsProvider({ boot, children }: { boot: SpaBoot; children: ReactNode }) {
  const [memberships, setMemberships] = useState(boot.memberships);
  const value = useMemo(
    () => ({
      memberships,
      rename: (ref: string | null, slug: string) =>
        setMemberships((prev) => renameWorkspaceMembership(prev, ref, slug)),
    }),
    [memberships],
  );
  return <WorkspaceMembershipsContext.Provider value={value}>{children}</WorkspaceMembershipsContext.Provider>;
}

/**
 * The live list. Without the provider (a page rendered on its own — tests,
 * static renders) the boot's own snapshot is the same value the provider
 * starts from.
 */
export function useLiveMemberships(boot?: SpaBoot): SpaBoot["memberships"] {
  return useContext(WorkspaceMembershipsContext)?.memberships ?? boot?.memberships;
}

/** Patch one workspace's `slug` (its `id` never changes); a no-op without the provider. */
export function useRenameMembership(): (ref: string | null, slug: string) => void {
  return useContext(WorkspaceMembershipsContext)?.rename ?? noopRename;
}

function noopRename(): void {}
