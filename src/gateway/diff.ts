/**
 * Unified-diff fetcher — Installation-Token authenticated PR diff pull
 * (plan 01 Task 3).
 *
 * Contract (plan Module contracts):
 *   createDiffFetcher(getOctokit) → { fetchPrDiff(installationId, owner, repo, prNumber): Promise<string> }
 *
 * `fetchPrDiff` is NOT a dependency-free free function: the octokit factory
 * is injected (tests mock it; production binds Probot installation auth via
 * `createInstallationAuth`). Success value is a non-empty string starting
 * with "diff --git". Errors from the octokit layer reject — never swallowed.
 *
 * Workers-compatible: this module performs no I/O of its own and imports no
 * Node-only APIs; it only calls the injected octokit.
 */

import type { GetOctokit, PullsGetParams } from "./auth";

const DIFF_PREFIX = "diff --git";

/** Extracts the unified-diff string from an octokit pulls.get response. */
function extractDiff(data: unknown): string {
  // octokit with mediaType.diff may return the diff directly as `data`
  // (string) or nested under `data.data` (string) — handle both.
  const candidate = typeof data === "string" ? data : (data as { data?: unknown } | null)?.data;
  if (typeof candidate !== "string" || candidate.length === 0 || !candidate.startsWith(DIFF_PREFIX)) {
    throw new Error(
      "pulls.get did not return a unified diff (expected non-empty string starting with 'diff --git'); check the Accept/mediaType header",
    );
  }
  return candidate;
}

export function createDiffFetcher(getOctokit: GetOctokit): {
  fetchPrDiff: (
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<string>;
} {
  return {
    async fetchPrDiff(installationId, owner, repo, prNumber) {
      const octokit = await getOctokit(installationId);
      const params: PullsGetParams = {
        owner,
        repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
      };
      const response = await octokit.rest!.pulls.get(params);
      return extractDiff(response.data);
    },
  };
}
