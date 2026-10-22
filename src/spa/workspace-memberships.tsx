/**
 * The login's workspace memberships as LIVE client state (the
 * workspace-identifier work, 2026-10).
 *
 * The boot is a per-document snapshot and the rename navigates with
 * `replaceState`, so nothing ever refreshes it. Patched in place, the switcher
 * would keep offering the retired slug (a 404 — a rename is not a redirect)
 * while its current row went empty on the new path.
 *
 * A context rather than a callback prop: `main.tsx` renders the page as
 * `Layout`'s already-built `children` — `<Layout><Router>{DashboardPage}</Router></Layout>`
 * — so `Layout` renders the switcher from its own props yet cannot pass a
 * renamer down to the slug card four levels inside that child subtree
 * (`DashboardPage → AppDetailPage → AppDetailView → SettingsView`). Only
 * context spans it.
 *
 * Consequence of the wiring: the card's `useRenameMembership` reads the nearest
 * provider, so a future change that renders the card OUTSIDE this provider gets
 * a silent no-op rename (not an error) and the stale-slug behaviour returns —
 * the switcher keeps offering the retired slug and marks no current row.
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
