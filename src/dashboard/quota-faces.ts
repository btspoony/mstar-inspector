import { quotaMonth, resolveMonthlyQuota } from "../store/quota-store";
import { readMonthlyRp } from "../store/usage-store";
import type { DashboardD1 } from "./users";

/** What the workspace card's credit block renders, all of it integer RP. */
export type WorkspaceQuota = {
  usedRp: number;
  limitRp: number | null;
  sharedRp: number;
  byokRp: number;
  rpPerCredit: number;
  profileVersion: number;
  profileFrom: string;
  resetOn: string;
};

export async function readWorkspaceQuota(
  db: DashboardD1,
  workspaceId: string,
  planId: string,
  now: Date,
): Promise<WorkspaceQuota> {
  const month = quotaMonth(now);
  const [{ profile, monthlyRp }, rows] = await Promise.all([
    resolveMonthlyQuota(db, month.startIso, planId),
    readMonthlyRp(db, workspaceId, month.startIso, month.endIso),
  ]);
  const usage = rows[0];
  return {
    usedRp: usage?.total ?? 0,
    limitRp: monthlyRp,
    sharedRp: usage?.sharedRp ?? 0,
    byokRp: usage?.byokRp ?? 0,
    rpPerCredit: profile.rpPerCredit,
    profileVersion: profile.version,
    profileFrom: profile.effectiveFrom.slice(0, 10),
    resetOn: month.endIso.slice(0, 10),
  };
}
