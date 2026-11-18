/**
 * The installation-repository lookup a data upgrade uses to claim a target's
 * numeric `repo_id` (spec operator-data-upgrade § Ledger target alignment).
 *
 * A target named only by owner/name waits for the repository's first delivery to
 * claim its `repo_id` (migration 0067, D15). When the owner still has a live
 * installation of that bot, the upgrade can ask GitHub instead of waiting: mint
 * an installation token, list that installation's repositories, and match
 * `owner/name`.
 *
 * One listing per installation per call: the groups of one batch share install-
 * ations, and a listing is 1–5 upstream requests. The cache lives in this
 * closure, so it spans the batch it was built for.
 *
 * Every GitHub failure (no encryption key, an undecryptable PEM, a rejected
 * mint, a listing that could not be read) answers `failed` — never a throw, so
 * a batch completes and counts it. Only a listing that WAS read answers
 * `absent`, which the item reports as an unbound group.
 */
import { createSecretbox } from "../dashboard/secretbox";
import {
  fetchInstallationRepositories,
  mintInstallationAccessToken,
  mintInstallationJwt,
} from "../dashboard/github-app-metadata";
import type { DashboardD1 } from "../dashboard/users";
import type { RepoLookup, RepoLookupOutcome } from "./data-upgrades";

/**
 * Build the lookup for one batch. `encryptionKey` is the deployment's envelope
 * key; absent means no GitHub call is attempted and every query answers
 * `failed`, which the batch reports rather than treats as "repository absent".
 */
export function createRepoLookup(
  db: DashboardD1,
  encryptionKey: string | undefined,
): RepoLookup {
  /** `installation_id` → its repositories, or `null` once the read failed. */
  const listings = new Map<number, Map<string, number> | null>();
  const jwts = new Map<string, string | null>();

  const appJwt = async (botId: string): Promise<string | null> => {
    if (jwts.has(botId)) return jwts.get(botId)!;
    let jwt: string | null = null;
    if (encryptionKey !== undefined) {
      const row = await db
        .prepare("SELECT github_app_id, private_key_enc FROM review_bots WHERE id = ?1")
        .bind(botId)
        .first<{ github_app_id: number; private_key_enc: string }>();
      if (row !== null) {
        try {
          const pem = await createSecretbox(encryptionKey).decryptSecret(
            row.private_key_enc,
            `github_apps.private_key_enc:${botId}`,
          );
          jwt = await mintInstallationJwt(row.github_app_id, pem);
        } catch {
          jwt = null;
        }
      }
    }
    jwts.set(botId, jwt);
    return jwt;
  };

  const listing = async (
    botId: string,
    installationId: number,
  ): Promise<Map<string, number> | null> => {
    const cached = listings.get(installationId);
    if (cached !== undefined) return cached;
    const jwt = await appJwt(botId);
    let repos: Map<string, number> | null = null;
    if (jwt !== null) {
      const token = await mintInstallationAccessToken(installationId, jwt);
      const rows = token === null ? null : await fetchInstallationRepositories(token);
      if (rows !== null) {
        repos = new Map(rows.map((row) => [`${row.owner}/${row.name}`.toLowerCase(), row.repo_id]));
      }
    }
    listings.set(installationId, repos);
    return repos;
  };

  return async (
    botId: string,
    installationId: number,
    owner: string,
    repo: string,
  ): Promise<RepoLookupOutcome> => {
    const repos = await listing(botId, installationId);
    if (repos === null) return { kind: "failed" };
    const repoId = repos.get(`${owner}/${repo}`.toLowerCase());
    return repoId === undefined ? { kind: "absent" } : { kind: "found", repoId };
  };
}
