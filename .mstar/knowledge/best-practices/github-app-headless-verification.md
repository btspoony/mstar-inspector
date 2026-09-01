---
title: GitHub App headless 验证模式（installation-tokens API）
category: best-practices
problem_type: best_practice
module: app-gateway
severity: low
date: 2026-08-26
status: active
created_at: 2026-08-26
last_updated: 2026-08-26
source_plan: 04-gateway-worker
iteration: v0.2
verified: true
---

# GitHub App headless 验证模式（installation-tokens API）

## Context

GitHub App 的 live 验收不依赖 smee 隧道：用 App 凭据（APP_ID + PRIVATE_KEY）走纯 API 路径即可验证「App 已创建、已安装、能拉真实数据」。mstar-inspector 用它闭合 roadmap M0 goal 1（真实 App + Installation Token 打通）。

## Guidance

1. **JWT**：`@octokit/auth-app` `createAppAuth({ appId, privateKey })` → `auth({ type: "app" })` 铸 App JWT（PKCS#1 私钥在 workerd 需先转 PKCS#8，见 `github-app-pem-workerd`）。
2. **列安装**：`GET /app/installations`（Bearer JWT）→ 找 `installation_id` + `account.login`。
3. **Installation Token**：`auth({ type: "installation", installationId })`（auth-app 默认按 installation 缓存至过期；实测 2 次 fetch → 1 次 access_tokens 调用）。
4. **拉真实数据**：`GET /installation/repositories` 列仓库 → `pulls.list(state=open)` 找 PR → `pulls.get` + `mediaType: { format: "diff" }` 拉 unified diff，断言非空且 `diff --git` 前缀。
5. **证据落盘**：installation_id / repo / pr_number / head_sha 前 8 位 / diff 字节数 / 时间戳写入 runbook「Live verification」节。

## Why This Matters

- 无 smee、无本地 webhook 转发——App 凭据齐备即可验证，CI/无头环境可跑。
- 与生产路径同构：Worker 网关的 `fetchPrDiff` 就是同一 token 流。
- 幂等键要素（installation_id/owner/repo/pr/head_sha）在验证中自然采集，供 D1/KV 使用。

## When to Apply

- 新建 GitHub App 后的首次 live 验收。
- 无 webhook 隧道环境下的 App 连通性回归。

## Examples

- 实测：一个 installation → 30 repos → 种子 PR（`GH_REPO#GH_PR`，见 scripts/sandbox-smoke.ts）→ 391B unified diff（`diff --git a/docs/...`）。
- 种子 PR 技巧：归档仓库不可推；选非归档仓库，`gh api` 建分支 + PUT contents + `gh pr create`（App 权限只读时用用户 gh 登录态）。
