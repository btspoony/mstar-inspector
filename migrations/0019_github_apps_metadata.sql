-- 0019_github_apps_metadata.sql — per-App GitHub profile columns (plan 53
-- Task 1, iteration 017-dashboard-ux, architect decision AD-531).
--
-- Five metadata-only ADD COLUMNs caching the App's public GitHub profile as
-- served by `GET https://api.github.com/app` (App-JWT auth, zero octokit —
-- src/dashboard/github-app-metadata.ts):
--   github_name               GitHub-side App name (distinct from the local
--                             `name` column recorded at manifest commit);
--   github_description        App description (nullable upstream too);
--   github_html_url           the App's GitHub settings-page URL (the
--                             `html_url` of GET /app — the info-card link);
--   github_avatar_url         owner avatar URL (rendered by <img> directly —
--                             no image proxy in this plan);
--   github_metadata_synced_at last successful sync, SQLite datetime('now')
--                             UTC TEXT — the 0008 last_webhook_at precedent
--                             (NULL = never synced; the settings read path's
--                             lazy 24h TTL refresh keys off this column).
--
-- All nullable, no default, no REFERENCES — the 0008 "Metadata-only ADD
-- COLUMN" form, safe to apply over a live production DB with existing rows
-- (old rows read as "never synced" and render local fields, per the plan-53
-- fail-open degradation). Must apply AFTER 0004 (the altered table must
-- exist).
--
-- Single writer: apps-store.saveGithubMetadata touches ONLY these columns —
-- never updated_at, which stays the operator mutation timestamp (the
-- touchLastWebhook L5 precedent: this write is machine-triggered by the
-- settings read path, at most once per App per 24h TTL window, with no
-- cron/queue retry by plan lock).

ALTER TABLE github_apps ADD COLUMN github_name TEXT;
ALTER TABLE github_apps ADD COLUMN github_description TEXT;
ALTER TABLE github_apps ADD COLUMN github_html_url TEXT;
ALTER TABLE github_apps ADD COLUMN github_avatar_url TEXT;
ALTER TABLE github_apps ADD COLUMN github_metadata_synced_at TEXT;
