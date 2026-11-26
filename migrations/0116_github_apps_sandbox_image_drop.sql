-- 0116_github_apps_sandbox_image_drop.sql — the sandbox image leaves the
-- GitHub App for the Review Bot.
--
-- 0115 split the entity and gave every new bot the default image: the split
-- file is the re-runnable repair and must not read a column a later file
-- removes (D9). The App's real value therefore copies onto its bot HERE, in
-- the apply-once file, immediately before the column falls (D37) — the same
-- bare `DROP COLUMN` shape as `migrations/0057_review_targets.sql:236-240`
-- and `0067_repo_target_identity.sql:57-59`. This file is never re-run: the
-- column is gone after it, which is exactly what keeps the 0115 repair
-- replayable afterwards.
--
-- In this release one App executes through exactly one bot — the one the
-- split created under the same id — so the copy is one value per bot and no
-- live review changes its runtime image.
--
-- Must apply AFTER 0115 (the bot rows it copies onto).

UPDATE review_bots
SET sandbox_image_id = (
  SELECT sandbox_image_id FROM github_apps WHERE github_apps.id = review_bots.id
);

ALTER TABLE github_apps DROP COLUMN sandbox_image_id;
