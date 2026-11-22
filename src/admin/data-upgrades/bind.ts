/**
 * why: Repository-id binding, shared by the upgrades that leave a target named only
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
 * note: The one live target that names the repository and has no id. Exactly one row
 * is required: with two, stamping both with the same `repo_id` would violate
 * 0068's `(bot_id, repo_id)` unique index and abort the whole batch.
 */
const UNCLAIMED_TARGET = `
  SELECT id FROM review_targets
   WHERE deleted_at IS NULL AND bot_id = ?1
     AND repo_owner = ?2 COLLATE NOCASE AND repo_name = ?3 COLLATE NOCASE
     AND repo_id IS NULL`;

/**
 * note: Write the repository's numeric id onto ONE target id. Guarded twice: only
 * while the claim is still absent, and never when another live target of the
 * same bot already holds that id.
 */
const BIND_BY_ID = `
  UPDATE review_targets SET repo_id = ?1, updated_at = datetime('now')
   WHERE id = ?2 AND repo_id IS NULL AND deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM review_targets o
                      WHERE o.bot_id = review_targets.bot_id AND o.repo_id = ?1
                        AND o.deleted_at IS NULL AND o.id <> review_targets.id)`;

/**
 * note: Every live installation of this bot under `owner`, oldest first. The table's
 * unique key is `(app_id, installation_id)`, so a re-install can leave two live
 * rows for one account; the caller tries each until one grants the repository.
 */
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

  // why: Two live targets naming one repository is the shape this item refuses to
  // guess at: the operator merges them and runs again.
  const candidates = await db
    .prepare(UNCLAIMED_TARGET)
    .bind(botId, owner, repo)
    .all<{ id: string }>();
  if (candidates.results.length !== 1) return "unbound";
  const targetId = candidates.results[0]!.id;

  const installationIds = await liveInstallations(db, botId, owner);
  // why: A removed installation is history: the first delivery claims the id.
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
