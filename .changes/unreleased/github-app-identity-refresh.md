---
category: Changed
---

- **Dashboard App URLs now use the GitHub App id (breaking)**: the App detail page and every App-scoped API path are keyed by the numeric `github_app_id` (`/dashboard/apps/{githubAppId}`, `/dashboard/{workspaceRef}/apps/{githubAppId}`). Old links and bookmarks built from the locally minted slug no longer match and there is no redirect. That local slug no longer exists — the column is renamed `webhook_path` and is used only as the opaque webhook route key, so existing webhook URLs keep working unchanged.
- **Apps show their own logo, not the owner's**: the settings identity card and the Apps list now render the avatar of the App's bot account (`GET /users/{slug}[bot]`), because the REST `GET /app` payload has no logo field — the previous image was the App owner's avatar.
- **Managers can refresh the App's GitHub metadata on demand**: a *Refresh from GitHub* control on the settings page re-fetches the cached name, description, settings URL, slug and logo, bypassing the 24-hour lazy refresh, so a rename or a new logo appears immediately. An upstream failure shows a keyed error and keeps the cached values.
- **The bot mention uses GitHub's real App slug**: the settings page displays the exact `@<slug>[bot]` mention built from the slug cached in `github_slug` (filled at registration and on every metadata refresh), and shows nothing until that first sync instead of a locally invented name. The mention grammar and its authorization rules are unchanged.
- **App names fall back through GitHub's facts**: the Apps list and settings card render `github_name`, then `github_slug`, then the numeric App id, with the cached App logo beside them.
- **Upgrade step for existing Apps: sync each App's metadata once after deploying**. `github_slug` has no backfill, so right after this deploy every App that already exists answers to no bot mention until its metadata is fetched once — open its settings page (the 24-hour lazy refresh fills it) or press *Refresh from GitHub*. An App on `manual` trigger mode reviews on the mention only and will not review until then. The webhook face logs a structured `mention_unresolved` warn (with `webhook_path` and app id) for a comment that mentioned a login while the App's slug is still unknown, so an unsynced App is visible instead of silently ignoring deliveries.

<!-- CN -->
- **Dashboard 的 App 链接改用 GitHub App id（破坏性变更）**：App 详情页与所有 App 级 API 路径都以数字 `github_app_id` 为键（`/dashboard/apps/{githubAppId}`、`/dashboard/{workspaceRef}/apps/{githubAppId}`）。用本地 slug 拼出的旧链接与书签不再匹配，且不提供重定向。该本地 slug 已不复存在——列已重命名为 `webhook_path`，仅作为不透明的 webhook 路由键，因此现有 webhook URL 保持不变。
- **App 显示自己的 logo，而不是所有者的头像**：设置页身份卡与 Apps 列表改为渲染 App 机器人账号的头像（`GET /users/{slug}[bot]`）——REST `GET /app` 没有 logo 字段，此前的图片是 App 所有者的头像。
- **管理者可按需刷新 App 的 GitHub 元数据**：设置页的「从 GitHub 刷新」会重新拉取缓存的名字、描述、设置页 URL、slug 与 logo，并绕过 24 小时懒刷新，因此重命名或更换 logo 会立即生效。上游失败时显示带键错误并保留缓存值。
- **Bot 提及使用 GitHub 的真实 App slug**：设置页展示由 `github_slug`（注册时与每次元数据刷新时写入）拼出的准确 `@<slug>[bot]` 提及；首次同步前不显示任何提及，而不是本地臆造的名字。提及语法与授权规则保持不变。
- **App 名称按 GitHub 事实逐级回退**：Apps 列表与设置卡依次渲染 `github_name`、`github_slug`、数字 App id，并在旁显示缓存的 App logo。
- **升级步骤：部署后为每个已有 App 同步一次元数据**：`github_slug` 没有回填，因此部署后所有已存在的 App 在元数据拉取一次之前都不响应 bot 提及——打开它的设置页（24 小时懒刷新会写入）或点击「从 GitHub 刷新」。处于 `manual` 触发模式的 App 只靠提及触发，在此之前不会进行审查。当 App 的 slug 仍未知而有评论提及了某个登录名时，webhook 面会记录结构化 `mention_unresolved` 警告（带 `webhook_path` 与 App id），因此未同步的 App 可见，而不是静默忽略投递。
