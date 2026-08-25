/**
 * Installation-Token auth — binds the octokit factory to Probot's
 * installation auth (plan 01 Task 3).
 *
 * Contract (plan Module contracts):
 *   getOctokit(installationId) → Promise<OctokitLike>
 *
 * Production binding: Probot `app.auth(installationId)` returns an
 * installation-scoped octokit whose requests are authenticated with a
 * short-lived GitHub App Installation Token (permission set
 * pull_requests:read + contents:read + metadata:read — see .env.example).
 * PATs are never used as the primary auth path (plan Clarify decision 4).
 *
 * Workers-compatible: this module only wraps a passed-in `auth` function;
 * it performs no I/O and imports no Node-only APIs. The `Probot` reference
 * below is a type-only import (erased at runtime).
 */

import type { Probot } from "probot";

/** Params accepted by `rest.pulls.get` (octokit REST API). */
export type PullsGetParams = {
  owner: string;
  repo: string;
  pull_number: number;
  mediaType?: { format?: string; previews?: string[] };
};

/**
 * Structural octokit surface sufficient for pulls.get (plan ASSUMPTION,
 * verified at T3). The plan sketch used `(params: unknown) => Promise<unknown>`,
 * which the real ProbotOctokit is NOT assignable to (parameter contravariance);
 * typing the params structurally keeps the surface mockable AND compatible
 * with the real octokit. `request` was dropped: diff.ts never calls it, and
 * the real `request` signature is not assignable to `(...args: unknown[])`.
 */
export type OctokitLike = {
  rest?: { pulls: { get: (params: PullsGetParams) => Promise<{ data: unknown }> } };
};

export type GetOctokit = (installationId: number) => Promise<OctokitLike>;

/**
 * Production factory: `app.auth(installationId)` → installation octokit.
 * The returned function is what `createDiffFetcher` consumes; tests inject
 * their own mock instead of this binding.
 */
export function createInstallationAuth(app: Probot): GetOctokit {
  return (installationId: number) => app.auth(installationId);
}
