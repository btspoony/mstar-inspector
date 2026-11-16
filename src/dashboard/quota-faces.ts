/**
 * The quota card's read — one workspace's UTC month in RP, the profile that
 * judges it and the ceiling that profile sets for the workspace's plan.
 *
 * Nothing here is a second aggregation: the month's RP comes from
 * `readMonthlyRp` (the same statement `sumMonthlyRp` — the enqueue's ceiling
 * read — answers from), and the ceiling and the profile come from
 * `resolveMonthlyQuota`, which resolves the profile covering the month's 1st
 * (D5). A profile published mid-month therefore never judges the month it was
 * published in, and the card names the judging profile, never "the profile
 * current at render time".
 *
 * `self-hosted` has no ceiling to report (its plan resolves before any read),
 * so the caller renders no card at all and never calls this.
 */
import { quotaMonth, resolveMonthlyQuota } from "../store/quota-store";
import { readMonthlyRp } from "../store/usage-store";
import type { DashboardD1 } from "./users";

/** What the workspace card's credit block renders, all of it integer RP. */
export type WorkspaceQuota = {
  usedRp: number;
  /** NULL = no monthly limit on this plan. */
  limitRp: number | null;
  /** The source split. Its parts sum to `usedRp` only for rows that recorded one. */
  sharedRp: number;
  byokRp: number;
  rpPerCredit: number;
  profileVersion: number;
  /** The judging profile's own start, `YYYY-MM-DD`. */
  profileFrom: string;
  /** The first instant of the next UTC month — the banner's reset, `YYYY-MM-DD`. */
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
