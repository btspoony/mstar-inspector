---
category: Fixed
---

- **A repository shows its real install state, and the console says when an upgrade has nothing to do**: a `repo-backfill` run rebuilt one target per repository but wrote `repo_id = NULL`, and the dashboard reads that as 待安装 — so repositories with a full review history listed as uninstalled. A fourth operator upgrade, `repo-id-claim`, claims the numeric id from the bot's live installation without creating, retiring or re-pointing anything; it refuses a repository whose id two live targets both name, and tries every live installation for an owner rather than only the oldest. An upgrade card whose preflight is all zero now folds behind a "nothing to migrate" header instead of offering a disabled button.

<!-- CN -->
- **仓库显示真实安装状态，控制台会说明某项升级无事可做**：`repo-backfill` 为每个仓库重建了一个 target，但把 `repo_id` 写成 `NULL`，而 dashboard 把这种状态读作「待安装」——于是有完整审查历史的仓库被列成未安装。新增第四项运营升级 `repo-id-claim`：从 bot 的 live installation 认领数字 id，不创建、不退休、不重指任何 target；当同一仓库被两个 live target 同时命名时拒绝认领，并遍历所有 live installation 而不是只看最旧的一个。预检全零的升级卡片改为折叠，头部直接写「无需升级」，不再显示一个禁用的按钮。

