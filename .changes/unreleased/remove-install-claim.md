---
category: Fixed
---

- **Remove the install-claim flow from App settings.** The "Claim an installation" action existed to pre-record which target a GitHub App installation belonged to, because GitHub's setup redirect carries no `state`. The app-creation manifest sets no `setup_url`, so that redirect never happens and no claim was ever consumed. The button, its route, the `/bot/setup` callback, the `install_claims` table (migration `0081_drop_install_claims`) and the claim wording in the App settings are gone; an unbound shared bot now shows the same plain install link as an owned one, and installing on GitHub records the installation through the `installation.created` webhook.
- **"Bind to this target" binds directly.** The pending-installation action upserts `bot_installations` itself — the webhook's own conflict-tolerant upsert — instead of creating and consuming a claim, so a bind no longer depends on a table that nothing else reads.

<!-- CN -->
- **从应用设置中移除「认领安装」流程。** 该操作原本用于预先记录 GitHub App 安装所属的 target，因为 GitHub 的 Setup 重定向不携带 `state`。但创建 App 的 manifest 从未设置 `setup_url`，这条重定向根本不会发生，认领也从未被消费。按钮、其路由、`/bot/setup` 回调、`install_claims` 表（迁移 `0081_drop_install_claims`）以及应用设置中的认领文案均已删除；未绑定的共享 bot 现在与自有 bot 一样显示普通安装链接，在 GitHub 上安装后由 `installation.created` webhook 记录安装。
- **「绑定到本目标」改为直接绑定。** 待绑定安装的操作直接 upsert `bot_installations`——即 webhook 自己那套冲突容忍的 upsert——而不再先创建再消费一条认领，因此绑定不再依赖一张其余无人读取的表。
