---
category: Changed
---

- **The App-owned schema now uses the bot vocabulary**: `github_apps` became `review_bots`, the tables it owns took the `bot_` prefix (`bot_installations`, `bot_workspaces`, `bot_provider_keys`, `bot_model_config`, `bot_model_roles`, `bot_model_chains`, `bot_model_chain_seats`, `bot_custom_providers`, `bot_custom_provider_keys`, `bot_provider_models`), and the `app_id` column on every table that records which bot acted is now `bot_id`. The three indexes that still named the App were recreated as `idx_reviews_bot_id`, `idx_webhook_deliveries_bot_created` and `idx_pull_requests_bot_pr`. Nothing else changed: no row was rewritten and no table was rebuilt, stored credentials and webhook URLs stay valid because the encryption AAD strings and public paths keep their old spelling, and `app_owner_allowlist` keeps its own name and column.

- **The deploy replay follows the rename**: the App-attribution repair every deploy replays moved from the historical `migrations/0027_workspace_backfill.sql` to `scripts/workspace-backfill.sql`, expressed against `review_bots` / `bot_workspaces`. `0027` still runs in the migration chain on a fresh database, and the zero-orphan gate's repair pointer names the new file.

<!-- CN -->
- **App 归属的 schema 改用评审机器人（bot）词汇**：`github_apps` 改名为 `review_bots`，它拥有的表加上 `bot_` 前缀（`bot_installations`、`bot_workspaces`、`bot_provider_keys`、`bot_model_config`、`bot_model_roles`、`bot_model_chains`、`bot_model_chain_seats`、`bot_custom_providers`、`bot_custom_provider_keys`、`bot_provider_models`），所有记录“由哪个机器人执行”的表上的 `app_id` 列改名为 `bot_id`；三个仍带 App 字样的索引重建为 `idx_reviews_bot_id`、`idx_webhook_deliveries_bot_created`、`idx_pull_requests_bot_pr`。行为没有任何变化：没有重写任何行，也没有重建任何表；加密 AAD 字符串与公开路径保持原拼写，因此已存储的凭据与 webhook URL 仍然有效；`app_owner_allowlist` 保留原有表名与列名。
- **部署重放跟随改名**：每次部署都会重放的 App 归属修复从历史迁移 `migrations/0027_workspace_backfill.sql` 移到 `scripts/workspace-backfill.sql`，改用 `review_bots` / `bot_workspaces` 表达；`0027` 仍在迁移链中按原位置为全新数据库执行，零孤儿门禁的修复提示指向新文件。
