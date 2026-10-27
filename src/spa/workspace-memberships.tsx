/**
 * The login's workspace memberships as client state shared across the shell.
 *
 * A context rather than a callback prop: `main.tsx` renders the page as
 * `Layout`'s already-built `children` — `<Layout><Router>{DashboardPage}</Router></Layout>`
 * — so `Layout` renders the switcher from its own props yet cannot pass a
 * patcher down to the settings card four levels inside that child subtree
 * (`DashboardPage → AppDetailPage → AppDetailView → SettingsView`). Only
 * context spans it.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { SpaBoot } from "./boot";

const WorkspaceMembershipsContext = createContext<SpaBoot["memberships"] | null>(null);

export function WorkspaceMembershipsProvider({ boot, children }: { boot: SpaBoot; children: ReactNode }) {
  return (
    <WorkspaceMembershipsContext.Provider value={boot.memberships}>{children}</WorkspaceMembershipsContext.Provider>
  );
}

/**
 * The live list. Without the provider (a page rendered on its own — tests,
 * static renders) the boot's own snapshot is the same value the provider
 * starts from.
 */
export function useLiveMemberships(boot?: SpaBoot): SpaBoot["memberships"] {
  return useContext(WorkspaceMembershipsContext) ?? boot?.memberships;
}
