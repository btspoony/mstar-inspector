/**
 * Worker fetchPrDiff — GitHub App installation-token authenticated PR diff
 * pull (plan 04 Task 3; contract along M0 `src/gateway/diff.ts`).
 *
 * Contract (plan Module contracts / compass contracts B):
 *   createDiffFetcher(auth) → { fetchPrDiff(installationId, owner, repo, prNumber): Promise<string> }
 *
 * `fetchPrDiff` keeps the 4-parameter contract; the octokit is obtained via
 * the injected `auth` (tests mock it; production binds `createAppAuthFromEnv`).
 * Success value is a non-empty string starting with "diff --git". Errors from
 * the octokit layer reject — never swallowed.
 *
 * Auth: `@octokit/auth-app` `createAppAuth` (JWT → installation access token,
 * cached per installation until expiry — auth-app default). The production
 * binding resolves `PRIVATE_KEY` in two forms (plan Clarify #3 / runbook):
 * inline PEM, or a `~`-expanded file path (read lazily via a dynamic
 * `node:fs` import — workerd local supports it; the key never enters logs or
 * the queue payload).
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Env } from "./env";

const DIFF_PREFIX = "diff --git";

/** Params accepted by `rest.pulls.get` (octokit REST API). */
export type PullsGetParams = {
  owner: string;
  repo: string;
  pull_number: number;
  mediaType?: { format?: string; previews?: string[] };
};

/**
 * Structural octokit surface sufficient for pulls.get (plan ASSUMPTION,
 * verified at T3). Keeps the fetcher mockable AND compatible with the real
 * octokit (the real `rest.pulls.get` is assignable to this shape).
 */
export type OctokitLike = {
  rest?: { pulls?: { get?: (params: PullsGetParams) => Promise<{ data: unknown }> } };
};

/**
 * Structural auth surface sufficient for installation-scoped octokit
 * creation. The real `createAppAuth` result is assignable: `auth({ type:
 * "installation", installationId, factory })` resolves with whatever the
 * factory returns — here an `Octokit` whose requests carry the installation
 * access token.
 */
export type AppAuth = (options: {
  type: "installation";
  installationId: number;
  factory: (options: unknown) => OctokitLike;
}) => Promise<OctokitLike>;

/** Extracts the unified-diff string from an octokit pulls.get response. */
function extractDiff(data: unknown): string {
  // octokit with mediaType.format "diff" returns the diff directly as `data`
  // (string) or nested under `data.data` (string) — handle both.
  const candidate = typeof data === "string" ? data : (data as { data?: unknown } | null)?.data;
  if (typeof candidate !== "string" || candidate.length === 0 || !candidate.startsWith(DIFF_PREFIX)) {
    throw new Error(
      "pulls.get did not return a unified diff (expected non-empty string starting with 'diff --git'); check the Accept/mediaType header",
    );
  }
  return candidate;
}

/** Expand a leading `~/` to the given home directory (pure, testable). */
export function expandHomePath(value: string, home: string): string {
  return value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
}

/**
 * Resolve the PRIVATE_KEY secret to PEM text. Two forms are accepted
 * (plan Clarify #3 / runbook direction):
 * - inline PEM (contains a BEGIN marker) → returned as-is;
 * - a file path (optionally `~`-prefixed) → expanded and read from disk.
 * The read is lazy (per call) so a rotated key file is picked up without a
 * redeploy; the resolved PEM is never logged or stored.
 */
export async function resolvePrivateKey(value: string): Promise<string> {
  if (value.includes("-----BEGIN")) {
    return value;
  }
  // Platform-specific: node:fs/node:os exist in workerd local dev and Bun,
  // but not in every Workers runtime — dynamic import keeps the module
  // boundary honest (no static Node-only imports in src/worker).
  const { readFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  return readFileSync(expandHomePath(value, homedir()), "utf8");
}

/** The `createAppAuth` strategy instance (owns the installation-token cache). */
type AppAuthStrategy = AppAuth;

/**
 * Production auth binding: `createAppAuth` (APP_ID + resolved PRIVATE_KEY)
 * → per-installation octokit via the documented factory pattern. The
 * `createAppAuth` instance is memoized so its installation-token cache is
 * shared across calls (auth-app default: tokens cached until expiry). The
 * key is resolved once, on first use; rotation requires a new binding
 * (redeploy).
 */
export function createAppAuthFromEnv(env: Pick<Env, "APP_ID" | "PRIVATE_KEY">): AppAuth {
  let appAuth: AppAuthStrategy | null = null;
  return async ({ type, installationId, factory }) => {
    if (appAuth === null) {
      const privateKey = await resolvePrivateKey(env.PRIVATE_KEY);
      appAuth = createAppAuth({ appId: env.APP_ID, privateKey });
    }
    return appAuth({ type, installationId, factory });
  };
}

export function createDiffFetcher(auth: AppAuth): {
  fetchPrDiff: (
    installationId: number,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<string>;
} {
  return {
    async fetchPrDiff(installationId, owner, repo, prNumber) {
      const octokit = await auth({
        type: "installation",
        installationId,
        factory: (options) => new Octokit({ authStrategy: createAppAuth, auth: options }),
      });
      const pullsGet = octokit.rest?.pulls?.get;
      if (!pullsGet) {
        throw new Error(
          "octokit is missing rest.pulls.get — cannot fetch the PR diff; check the injected auth surface",
        );
      }
      const response = await pullsGet({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
      });
      return extractDiff(response.data);
    },
  };
}
