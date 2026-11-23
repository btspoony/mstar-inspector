---
category: Fixed
---

- **Shared-bot installations belong to one workspace.** A shared bot's installation is now bound to the workspace whose manager proves, with their own GitHub token, that they administer the installation's account; the repository walk, target creation and the bind read only installations bound to the caller's workspace, so one tenant can no longer list, claim or bind another tenant's repositories. Installations of a shared bot that exist at upgrade start unbound: a manager must bind each one again (Settings → the App → Waiting to be bound) with a GitHub account that administers the installation's account before its repositories appear in Add repository. Each installation binds to exactly one workspace; once bound, it no longer appears in other workspaces' Waiting to be bound list, so they need their own installation on an account they administer.
- **Deleting a workspace releases its repositories.** Workspace deletion now retires the workspace's review targets, and a migration retires the targets earlier deletions left live, so a workspace that rebinds the installation can add those repositories.

<!-- CN -->
- **共享 bot 的安装只归属一个工作区。** 共享 bot 的安装现在只绑定到其管理员用自己的 GitHub 令牌证明管理该安装账号的工作区；仓库遍历、创建 target 和绑定只读取绑定到调用方工作区的安装，一个租户不再能列出、认领或绑定其他租户的仓库。升级时已有的共享 bot 安装一律处于未绑定状态：管理员需用管理该安装账号的 GitHub 账号逐个重新绑定（设置 → 该 App → 等待绑定），其仓库才会出现在“添加仓库”中。每个安装只绑定一个工作区；绑定后它不再出现在其他工作区的“等待绑定”列表中，其他工作区需要在其管理的账号上另行安装。
- **删除工作区会释放其仓库。** 删除工作区现在会同时停用该工作区的 review target，并由迁移停用此前删除遗留的 target，重新绑定该安装的工作区可以添加这些仓库。
