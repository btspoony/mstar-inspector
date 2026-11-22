import type { DashboardD1 } from "../../dashboard/users";
import type { UpgradeRunContext } from "../data-upgrades";

const UNCLAIMED_TARGET = `
  SELECT id FROM review_targets
   WHERE deleted_at IS NULL AND bot_id = ?1
     AND repo_owner = ?2 COLLATE NOCASE AND repo_name = ?3 COLLATE NOCASE
     AND repo_id IS NULL`;

const BIND_BY_ID = `
  UPDATE review_targets SET repo_id = ?1, updated_at = datetime('now')
   WHERE id = ?2 AND repo_id IS NULL AND deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM review_targets o
                      WHERE o.bot_id = review_targets.bot_id AND o.repo_id = ?1
                        AND o.deleted_at IS NULL AND o.id <> review_targets.id)`;

async function liveInstallations(
  db: DashboardD1,
  botId: string,
  owner: string,
): Promise<number[]> {
  const res = await db
    .prepare(
      `SELECT installation_id FROM bot_installations
        WHERE bot_id = ?1 AND removed_at IS NULL AND account_login = ?2 COLLATE NOCASE
        ORDER BY installation_id`,
    )
    .bind(botId, owner)
    .all<{ installation_id: number }>();
  return res.results.map((row) => row.installation_id);
}

/** One repository whose target carries no numeric id yet. */
export type UnclaimedRepository = {
  botId: string;
  owner: string;
  repo: string;
};

/**
 * Bind one repository's target. The result is the batch log's bucket: `bound`,
 * `unbound` (no live installation, no single target to write, or a repository
 * the installation does not grant) or `binding_failed` (GitHub could not
 * answer). Never throws.
 */
export async function bindRepository(
  db: DashboardD1,
  repository: UnclaimedRepository,
  context: UpgradeRunContext | undefined,
): Promise<"bound" | "unbound" | "binding_failed"> {
  const { botId, owner, repo } = repository;
  const lookup = context?.repoLookup;
  if (lookup === undefined) return "unbound";

  const candidates = await db
    .prepare(UNCLAIMED_TARGET)
    .bind(botId, owner, repo)
    .all<{ id: string }>();
  if (candidates.results.length !== 1) return "unbound";
  const targetId = candidates.results[0]!.id;

  const installationIds = await liveInstallations(db, botId, owner);
  if (installationIds.length === 0) return "unbound";

  let sawFailure = false;
  for (const installationId of installationIds) {
    const found = await lookup(botId, installationId, owner, repo);
    if (found.kind === "failed") {
      sawFailure = true;
      continue;
    }
    if (found.kind === "absent") continue;
    const written = await db.prepare(BIND_BY_ID).bind(found.repoId, targetId).run();
    if (written.meta.changes > 0) return "bound";
  }
  return sawFailure ? "binding_failed" : "unbound";
}
