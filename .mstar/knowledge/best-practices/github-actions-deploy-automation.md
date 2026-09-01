---
module: ops-deploy
date: 2026-09-01
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 26-deploy-automation
tags:
  - github-actions
  - wrangler
  - cloudflare-workers
  - d1
  - deploy-automation
  - secrets
  - digest
applies_when:
  - automating Cloudflare Workers deploys via GitHub Actions
  - push-to-main deploy with secrets injection and post-deploy verification
---

# GitHub Actions 部署自动化（Cloudflare Workers）

## Context

mstar-inspector 的 live 部署从手动 runbook（`docs/deploy.md`：D1 migrations → `wrangler secret put` → `wrangler deploy` → 手工冒烟 → 手工 digest 记录）改为 GitHub Actions 自动化主路径（plan 26，2026-09-01）。用户裁决：部署必须自动化、secrets 经 GitHub Secrets 管理、失败 STOP 不自动回滚（D1 forward-only 迁移已应用时回滚 = schema 错配）。

## Guidance

### Workflow 结构（AL-26-1）

- **独立 `deploy.yml`，自含 test job**（复刻 ci.yml 四步：checkout → setup-bun → install → typecheck → test），`deploy` job `needs: test`。不用 `workflow_run`（head_sha pinning 问题：两 push 的 CI 完成顺序无保证，旧 SHA 后完成会覆盖新部署）；不合入 ci.yml（保持 ci.yml 契约不动）。
- **双通道**：`push: branches: [main]` + `workflow_dispatch`（紧急/回滚通道）。
- **`concurrency: group: <name>` + `cancel-in-progress: false`**：按 push 顺序串行部署。
- **`workflow_dispatch` 必须加 main-ref 守卫**：`deploy` job `if: github.ref == 'refs/heads/main'`——否则任何分支 dispatch 都会部署到生产（QC2 F-002）。

### Secrets 注入（AL-26-4）

- 命令名是 **`wrangler secret bulk`**（单数；v0.4 的 API 端点 `secrets-bulk` 是另一回事）。
- **`secret bulk` 的 JSON `null` 值 = 删除语义**——缺 env 会得到 null 而非空串，必须先非空断言：`: "${VAR:?required}"`。
- jq 从 env 构造 JSON（值不经 argv、payload 不落盘）：`jq -n '{NAME: env.NAME}' | bunx wrangler secret bulk`。
- 可选 secret（如 `ALERT_WEBHOOK_URL`）：GitHub Actions 的 `if:` 不能用 `secrets` context → job 级 env 映射后 `if: env.ALERT_WEBHOOK_URL != ''`；**缺失时显式删除**（`jq -n '{NAME: null}' | wrangler secret bulk`）以匹配「unset = 关闭」语义（QC2 F-003）。
- 账户校验：repo variable `vars.CLOUDFLARE_ACCOUNT_ID` 声明部署账户（不硬编码进 workflow），`test -n` 空值 fail-closed + `test "$CLOUDFLARE_ACCOUNT_ID" = "${{ vars.CLOUDFLARE_ACCOUNT_ID }}"` stale-env trap（knowledge `runtime-errors/wrangler-stale-account-id.md`）。

### 部署序列与失败语义

- 顺序：账户校验 → secrets bulk → D1 migrations `--remote`（失败 STOP）→ `wrangler deploy` → post-deploy smoke → digest 写回。
- **GitHub Actions 默认 shell 是 `bash -e {0}`，无 `-o pipefail`**——`wrangler deploy 2>&1 | tee deploy.log` 在 deploy 失败时可能 step 仍绿。修复：该 step 显式 `shell: bash`（含 pipefail）+ `test -s version_id.txt` 守卫（QC3 F-002）。
- 失败语义：全部 step 失败传播（不 `continue-on-error`）；**不自动回滚**（`wrangler rollback` 是人工动作——D1 forward-only 迁移已应用时回滚 = schema 错配）。

### Post-deploy smoke

- healthz：重试 3×5s，最后一次失败才红。
- cron 注册：**grep deploy 输出** `schedule: */15 * * * *` 行（wrangler 4.125.0 在 cron PUT 成功后打印于 `Deployed … triggers` 块；`wrangler deployments list` 无 cron 面、`wrangler triggers` 仅实验性 deploy 子命令——均不可用）。
- digest 提取：主源 = `wrangler containers list --json` jq 取 `mstar-inspector-sandbox` 应用 image 的 `@sha256:<64hex>`（container app name = `<worker>-<class>` 小写，wrangler 默认生成；live 状态对「镜像未重建」也准确）；备源 = deploy.log 锚定 `registry.cloudflare.com/<account>/<worker>-<class>@sha256:...` 行。

### Digest 写回（DOCS-01 自动化）

- `docs/deploy.md` 用机器管理块：`<!-- deploy-record:start/end -->`，块内容由 workflow 重生成（日期 + Worker version + digest + Actions run URL）。
- **merge 顺序**：`git fetch origin main && git merge --no-edit origin/main` 必须在 python 改写 docs/deploy.md **之前**——先 dirty 再 merge 会在 main 上恰有 docs-only push 时 abort（「local changes would be overwritten」，QC2/QC3 F-001）。
- 幂等：`git diff --quiet -- docs/deploy.md` 无变化则短路退出。
- **防递归**：push 触发 `paths-ignore: ['docs/**', '.mstar/**', '*.md', 'LICENSE', '.env.example']`（content-based，判「改了什么」而非「谁改的」——actor 检查会误杀未来合法 bot 代码提交）。注意 `*.md` 只匹配根目录（GitHub 模式 `*` 不跨 `/`）。
- 写回失败 = job 红（诚实信号：部署成功但记录未写 = 自动化不完整）；手工 digest 粘贴保留为兜底。

## Why This Matters

- 部署自动化消除了「对着 runbook 敲命令」的人为错误面；secrets 只出现在 GitHub Secrets。
- 上述 gotchas（pipefail、null=delete、merge 顺序、main-ref 守卫）都是**非显而易见**的——每个都在 QC tri 中被抓出并修复，未来同类 workflow 直接复用可省一轮 review。

## When to Apply

- 任何 Cloudflare Workers + GitHub Actions 的自动部署；D1 迁移 + secrets + 冒烟 + digest 记录的完整链路。
- 复用点：workflow 骨架、secrets bulk 模式、smoke 检查命令、digest 写回脚本。

## Examples

- 本仓库 `.github/workflows/deploy.yml`（plan 26，2026-09-01 交付，QC Approve 3/3 + QA PASS）。
- 完整决策记录：`{ITERATION_DIR}/v1.0-deploy-automation/specs/v1.0-deploy-automation.md` §4（AL-26-1…AL-26-5 RESOLVED）。
