---
module: ops-release
date: 2026-09-07
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 50-release-pr-chain
tags:
  - github-actions
  - release
  - versioning
  - changelog
  - cloudflare-workers
  - deploy-decoupling
applies_when:
  - building a GitHub Actions release/tagging flow decoupled from continuous deploy
  - porting the mstar-harness Release PR chain to a single-surface repo
  - wiring version surfaces (package.json + generated code) into bump/validate gates
---

# GitHub Actions Release PR chain（与持续部署解耦的定版打 tag 流程）

## Context

mstar-inspector 的 staging 部署已由 main-push 自动化（`deploy.yml`，见 [`github-actions-deploy-automation.md`](github-actions-deploy-automation.md)）。发版流程只为**定版发版打 tag**：与部署完全解耦，`ci.yml`/`deploy.yml` 零改动。CF 官方 CI/CD 文档只覆盖 push-to-main 部署，release 侧取 GitHub OSS 共识的 **Release PR 模式**（release-please / changesets / mstar-harness 自研链三者收敛）。本仓从 `../mstar-harness` 简化移植：单版本面（`package.json` + 生成文件）、双语片段 changelog、无 npm publish（迭代 016，plans 50/51/52，2026-09-07）。

## Guidance

### 链条结构

- **Release prep**（`workflow_dispatch`，可选版本号）: 汇稿 `.changes/unreleased/*.md` 片段进 `CHANGELOG.md` + `CHANGELOG_CN.md`（节头 `## [X.Y.Z] - date`，裸版本）→ bump 全部版本面 → `release:validate` → typecheck + build sanity → bot identity 推 `release/vX.Y.Z` 分支（`checkout -B` + `--force-with-lease`）→ `gh pr create/edit`（title `release vX.Y.Z`）。`concurrency: release-prep, cancel-in-progress: false`。
- **Release**（`pull_request closed + branches: [main]` + `merged && title 前缀 release v`）: checkout **merge_commit_sha** → validate → typecheck/test/build → annotated tag `vX.Y.Z` + push（已存在则 skip）→ 双语 notes（`EN\n\n---\n\nCN`）→ GitHub Release。

### 非显而易见的坑（全部在 QC 中被抓出或裁定）

- **auto-bump 从 `package.json#version` 推导（patch+1 / `--minor`），绝不从 tag 推导** —— 零 tag 仓库里 tag-derived 在首切前是死代码；双闸 = `version > current`（compareSemver，含 prerelease graduation）+ tag-exists 早失败。
- **tag-exists 自愈语义**：validate 只在「tag 存在于**不同** commit」时失败；tag 已在 HEAD → 通过（re-run-after-tag-push 收敛：validate 过 → tag 步 skip → Release 创建）。避免「tag 步幂等 skip 永远不可达，因为 validate 先挡」的假自愈。
- **GITHUB_TOKEN 事件抑制**：bot 开的 release PR **不触发 `ci.yml`** —— prep 自带的 validate/typecheck/build 就是该 PR 的验证面；release 在打 tag 前重验证兜底。勿在 runbook 里声称「release PR 走正常 CI」。
- **权限面**：prep = `contents: write` + `pull-requests: write`（无 label 步则**不需要** `issues: write`）；release = `contents: write`（+ evidence artifact 下载时 `actions: read`）。全程 GITHUB_TOKEN 零 secrets。
- **`run:` 内零裸 `${{ }}`**：dispatch input / step output 一律经 step-level `env:` 间接（与部署链同纪律）。
- **notes 分隔符的字节形**：extract 脚本输出**无尾换行**的 trimmed body → 组装用 `printf '\n\n---\n\n'` 才能得到 `EN / 空行 / --- / 空行 / CN`；差一个 `\n` 会把 setext 标题语义引入渲染。追加 evidence 等后续节用**同分隔符**。
- **AD-3 单次幂等重写**：evidence/后续追加 = workspace notes 文件重组（经 step output 传递路径，勿重建路径字符串）→ **一次** `gh release edit --notes-file`；绝不 read-modify-write live body（操作员编辑竞争 + JSON 解码坑）。全 workflow `gh release edit` 计数 === 1 由 guard test 钉住。
- **版本面 SSOT**：`VERSION_SURFACES` 清单由 prepare（bump 写者）与 validate（一致性闸）共用——「never validates an un-bumped surface」；生成面（`src/version.ts`，single writer + do-not-edit header + 模板再生 deterministic 无日期戳）进 Worker `/healthz`（additive 字段 `version: vX.Y.Z`，`ok` 契约不动）与 SPA；读取 RE 必须**行锚定**（`^export const APP_VERSION = "…"$`/m，防注释行误读）。
- **evidence 对账**（tag↔部署）：collector 对 merge SHA 有界等待 deploy run（默认 15min/30s，双 flag 可调）→ 下载既有 `deploy-evidence` artifact → 节内记 Worker Version ID + 镜像 digest + run link；**退出码恒 0**（evidence 缺失绝不阻断 release），四态显式（success/deploy-failed/pending/no-run）+ error 降级节；artifact 派生字符串过 shape 门（单行/无反引号/长度帽）再进公开 release body。
- **超时预算算术**：job `timeout-minutes: 30`、evidence 步独立 `timeout-minutes: 18`（15min 等待 + 下载/编辑余量）——否则 job 超时会在等待中段击穿 evidence 步；edit 失败 `exit 1`（step 红）+ 步级 `continue-on-error`（job 绿）+ `set -euo pipefail`。
- **Action pin 约定**：**新引入本仓**的第三方 action 一律 SHA pin；既有 action 沿用仓库 tag-pin 惯例（与 ci/deploy 一致——分叉惯例才是违例）。
- **守卫测试**：YAML 结构化 parse 测试钉住 triggers / job guard 表达式 / 权限面 / 步骤顺序（evidence 在 Release 创建之后）/ 单 edit 计数 / timeout / 零裸 `${{ }}`——比注释便宜且防漂移（本仓 `tests/scripts/release-workflow-guards.test.ts`，16 断言）。

### 片段协议（简化自隔壁仓）

`.changes/unreleased/<slug>.md`：frontmatter 仅 `category`（默认 `Changed`；无 `packages` 路由）+ EN bullets + `<!-- CN -->` + CN bullets；无 CN 段时 EN 复用进中文文件。frontmatter 值剥离行内 ` # comment`。空片段目录需 `--allow-empty`。v1.0.0 首节 = 一次性 curated 基线摘要（双语成对、无内部 plan/finding 编号）。

## Why This Matters

- 定版动作变成**可审阅的 PR**：changelog、版本 bump、验证都在 merge 前可见；tag 只落在 CI 验证过的 merge commit 上，杜绝「本地手 tag 未验证 commit」。
- 上述坑（事件抑制、tag 推导死路、假自愈、分隔符字节形、超时击穿、权限面）没有一个是显而易见的——每一个都被 QC tri 抓出并修复；复用本链的仓库可直接省掉这几轮 review。

## When to Apply

- 任何「部署已自动化（push-to-main）+ 需要定版 tag/Release」的仓库；从隔壁仓移植到单面仓库时的简化清单；给持续部署服务加版本可见性与 tag↔部署对账时。

## Examples

- 本仓库 `.github/workflows/{release-prep,release}.yml` + `scripts/{prepare-release,validate-release-version,extract-changelog-section,release-surfaces,collect-deploy-evidence}.ts` + `tests/scripts/*`（迭代 016，2026-09-07 交付，QC tri Approve ×3 + QA PASS ×3）。
- 首切实跑 = live 验收事件（`docs/release.md` first-cut checklist：tag / bilingual Release / `/healthz` v1.0.0 / evidence 节）。
