---
category: Fixed
---

- **Shared-bot installations belong to one workspace.** A shared bot's installation is now bound to the workspace whose manager proves, with their own GitHub token, that they administer the installation's account; the repository walk, target creation and the bind read only installations bound to the caller's workspace, so one tenant can no longer list, claim or bind another tenant's repositories.
- **Deleting a workspace releases its repositories.** Workspace deletion now retires the workspace's review targets, and a migration retires the targets earlier deletions left live, so a workspace that rebinds the installation can add those repositories.

<!-- CN -->
- **共享 bot 的安装只归属一个工作区。** 共享 bot 的安装现在只绑定到其管理员用自己的 GitHub 令牌证明管理该安装账号的工作区；仓库遍历、创建 target 和绑定只读取绑定到调用方工作区的安装，一个租户不再能列出、认领或绑定其他租户的仓库。
- **删除工作区会释放其仓库。** 删除工作区现在会同时停用该工作区的 review target，并由迁移停用此前删除遗留的 target，重新绑定该安装的工作区可以添加这些仓库。
