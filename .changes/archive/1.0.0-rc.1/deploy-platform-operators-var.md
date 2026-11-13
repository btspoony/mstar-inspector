---
category: Fixed
---

- **Deploy workflows now pass the platform-operator allowlist.** Both the staging and production deploys read the `PLATFORM_OPERATORS` repository variable and bind it as a Worker var, so setting it in GitHub actually grants the operator console; previously the workflows never read it and `/_internal_admin` answered 404 for every caller.

<!-- CN -->
- **部署工作流现在会传递平台运营 allowlist。** staging 与 production 部署都会读取 `PLATFORM_OPERATORS` 仓库变量并写入 Worker var；此前工作流从不读取它，导致 `/_internal_admin` 对任何调用者都返回 404。
