# Breaking: per-App webhook URL is now `<workspace_id>/<app_id>`

The webhook delivery URL for every GitHub App is now
`<origin>/webhook/<workspace_id>/<app_id>` — the workspace's stable id and the
App's local row id, both immutable internal identifiers. The old single-segment
`/webhook/<uuid>` route is **retired with no compatibility path**: GitHub keeps
delivering to the old address and receives a **404** until the App's Webhook URL
is updated.

**Upgrade step (required).** After deploying, open each App's settings card
(`/dashboard/<workspace_id>/apps/<github_app_id>/settings`), copy the
**Webhook URL** it prints (both segments are shown on the card, including the
Local App ID), and paste it into the GitHub App's settings → Webhook → Webhook
URL. Until then the App receives no events.

Migration `0038` rebuilds `github_apps` to drop the now-duplicate
`webhook_path` column (SQLite cannot drop a `UNIQUE` column, so this is a
table rebuild inside the migration transaction — a brief write lock on a small
table; every row survives). No data is migrated: the two URL segments already
exist in the database.
