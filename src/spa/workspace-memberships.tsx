import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { SpaBoot } from "./boot";

const WorkspaceMembershipsContext = createContext<{
  memberships: SpaBoot["memberships"];
  rename: (ref: string | null, name: string) => void;
} | null>(null);

export function WorkspaceMembershipsProvider({ boot, children }: { boot: SpaBoot; children: ReactNode }) {
  const [memberships, setMemberships] = useState(boot.memberships);
  const value = useMemo(
    () => ({
      memberships,
      rename: (ref: string | null, name: string) =>
        setMemberships((prev) => prev?.map((m) => (ref === m.id || ref === m.slug ? { ...m, name } : m))),
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

/** Patch one workspace's `name`; a no-op without the provider. */
export function useRenameMembership(): (ref: string | null, name: string) => void {
  return useContext(WorkspaceMembershipsContext)?.rename ?? noopRename;
}

function noopRename(): void {}
