/**
 * The login's workspace memberships as client state shared across the shell.
 *
 * A context rather than a callback prop: `main.tsx` renders the page as
 * `Layout`'s already-built `children` — `<Layout><Router>{DashboardPage}</Router></Layout>`
 * — so `Layout` renders the switcher from its own props yet cannot pass a
 * patcher down to a page in that child subtree (`WorkspaceSettingsPage`).
 * Only context spans it.
 *
 * The one write is a rename: the boot is a per-document snapshot and the name
 * card does not reload, so without patching this list the top-bar label would
 * keep the old name until the next document.
 */
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
      // The path segment may name the row by `id` or by a legacy `slug`; `id`
      // is the one that never changes.
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
