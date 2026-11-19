/**
 * Repository-id binding, shared by the upgrades that leave a target named only
 * by `owner/name`.
 *
 * A target in that shape waits for the repository's first delivery to claim its
 * `repo_id` (D15). When the owner still has a LIVE installation of the bot, an
 * upgrade can ask GitHub instead of waiting: mint an installation token, list
 * that installation's repositories once, match `owner/name`, and write the
 * numeric id. No live installation (a removed one is history), a repository the
 * installation does not grant, or a GitHub failure leaves `repo_id` NULL and is
 * counted — never thrown.
 */
import type { DashboardD1 } from "../../dashboard/users";
import type { UpgradeRunContext } from "../data-upgrades";

/**
 * Write the repository's numeric id onto the target. Guarded twice: only while
 * the claim is still absent, and never when another live target of the same bot
 * already holds that id — 0068's unique index would abort the whole batch on it.
 */
export const BIND_REPO_ID = `
  UPDATE review_targets SET repo_id = ?1, updated_at = datetime('now')
   WHERE deleted_at IS NULL AND bot_id = ?2
     AND repo_owner = ?3 COLLATE NOCASE AND repo_name = ?4 COLLATE NOCASE
     AND repo_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM review_targets o
                      WHERE o.bot_id = ?2 AND o.repo_id = ?1 AND o.deleted_at IS NULL
                        AND o.id <> review_targets.id)`;

/** The bot's live installation whose account login is `owner`, if any. */
export async function liveInstallation(
  db: DashboardD1,
  botId: string,
  owner: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MIN(installation_id) AS n FROM bot_installations
        WHERE bot_id = ?1 AND removed_at IS NULL AND account_login = ?2 COLLATE NOCASE`,
    )
    .bind(botId, owner)
    .first<{ n: number | null }>();
  return row?.n ?? null;
}

/** One repository whose target carries no numeric id yet. */
export type UnclaimedRepository = {
  botId: string;
  owner: string;
  repo: string;
};

/**
 * Bind one repository's target. The result is the batch log's bucket: `bound`,
 * `unbound` (no live installation, or a repository the installation does not
 * grant) or `binding_failed` (GitHub could not answer). Never throws.
 */
export async function bindRepository(
  db: DashboardD1,
  repository: UnclaimedRepository,
  context: UpgradeRunContext | undefined,
): Promise<"bound" | "unbound" | "binding_failed"> {
  const { botId, owner, repo } = repository;
  const lookup = context?.repoLookup;
  if (lookup === undefined) return "unbound";
  const installationId = await liveInstallation(db, botId, owner);
  // A removed installation is history: the first delivery claims the id.
  if (installationId === null) return "unbound";
  const found = await lookup(botId, installationId, owner, repo);
  if (found.kind === "failed") return "binding_failed";
  if (found.kind === "absent") return "unbound";
  const written = await db.prepare(BIND_REPO_ID).bind(found.repoId, botId, owner, repo).run();
  return written.meta.changes > 0 ? "bound" : "unbound";
}
