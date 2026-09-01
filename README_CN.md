<div align="center">

<img src="assets/logo.svg" alt="mstar-inspector" width="96">

自托管 GitHub App：面向自动化 PR 审查与 bug 检测，由可插拔的 coding-agent runtime 驱动。

[English](README.md) / 中文

[![CI](https://img.shields.io/github/actions/workflow/status/btspoony/mstar-inspector/ci.yml?branch=main&style=flat-square&label=CI&labelColor=black)](https://github.com/btspoony/mstar-inspector/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/btspoony/mstar-inspector?color=c4f042&labelColor=black&style=flat-square)](https://github.com/btspoony/mstar-inspector/commits/main)

</div>
**mstar-inspector** 是一个自托管的 GitHub App：PR 一旦打开或更新，即刻触发云端自动审查。每次审查作为真实的
多席位 coding-agent 会话运行在隔离的 Cloudflare Sandbox 容器中，结果以单条 upsert 评论回到 PR，结构化
findings 落入 D1 供后续分析。

- **一份部署，多 App 共用** —— 通过 dashboard 注册任意数量的 GitHub App；每个 App 拥有独立的 slug、加密凭据、BYOK provider keys 和模型链
- **隔离执行** —— 每次审查运行在一次性 Cloudflare Sandbox 容器中（clone → review → 销毁），镜像内零密钥
- **结构化结果** —— 审查产出 `mstar.review/v1` envelope（verdict + 分级 findings）持久化到 D1，为后续去重、复现统计和健康分析提供数据层
- **设计上 fail-closed** —— 全局 kill-switch 把总闸，每个 App 必须自带 provider key 与模型链：配置缺失的 App 审查会大声失败，绝不动用别人的凭据

## 架构（一行）

```
GitHub webhook → POST /webhook/:appSlug（验签 + 分类）→ Queue → Consumer → Sandbox（clone + agent 审查）→ Issues 评论 upsert + D1 存储
```

## 快速开始

> 前置：[Cloudflare](https://developers.cloudflare.com/workers/) 账号（Workers + D1 + Queues）、GitHub 账号、本地
> [Bun](https://bun.sh) ≥ 1.3.14。完整 runbook——含 Cloudflare 资源初始化与 D1 迁移——见
> [`docs/deploy.md`](docs/deploy.md)。

1. **部署 Worker**

   ```bash
   bun install
   wrangler deploy        # 应用 D1 迁移并部署；细节见 docs/deploy.md
   ```

2. **设置 dashboard 密钥**（三个；审查凭据不放在 Worker 层）：

   ```bash
   wrangler secret put DASHBOARD_ENCRYPTION_KEY     # openssl rand -base64 32 —— 加密 D1 中的 per-App 凭据
   wrangler secret put DASHBOARD_SESSION_SECRET     # openssl rand -base64 32 —— 会话 cookie HMAC key
   wrangler secret put GITHUB_OAUTH_CLIENT_ID       # 一个 GitHub OAuth App，回调地址为 {origin}/dashboard/oauth/callback
   wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   ```

3. **登录并注册 GitHub App** —— 访问 `https://<your-worker>/dashboard`，用 GitHub 登录，走 **Register App**
   manifest 流程。它会在你的账号上创建 GitHub App（per-App webhook URL 形如
   `{origin}/webhook/<slug>`），把 PEM 与 webhook secret 加密存入 D1，并展示需要你在 GitHub
   侧设置的准确 webhook URL。

4. **配置 App** —— 在该 App 的 dashboard Settings 页添加审查模型所需的 provider API key（BYOK，加密落
   D1）和模型链。缺这些的 App 审查会 fail-closed——见 [Per-App 配置](#per-app-配置)。

5. **开启审查并提交 PR** —— 打开 kill-switch，在安装了该 App 的仓库里开一个（或更新一个）PR：

   ```bash
   wrangler secret put REVIEW_ENABLED   # 精确设置为 "true"
   ```

   审查在 sandbox 容器内运行，结果以单条评论出现在 PR 上（upsert——force-push 不会产生评论刷屏）。

## 审查如何运作

- **Per-App 路由**：GitHub 把 webhook 送到 `POST /webhook/:appSlug`。Worker 解析 slug、用该 App
  解密出的 secret 验签，入队一条带 App 身份的审查任务。审查没有其他入口。
- **Queue → Sandbox**：Cloudflare Queue consumer 在一次性 Sandbox 容器里 clone PR 并运行多席位 agent 会话——见 [Agent 运行时](#agent-运行时)。
- **结果**：PR 上单条 upsert 评论（永不重复）+ 持久化到 D1 的 `mstar.review/v1` envelope（findings、所用模型、指纹）——这是后续复现统计与健康分析的数据层。

## Agent 运行时

审查 runtime 是一个极小的端口（`AgentRuntime.runReview()`——单方法，输入进、`mstar.review/v1`
出）。审查命令、席位编排与结构化 findings 全部来自
[mstar-harness](https://github.com/btspoony/mstar-harness) 插件；至于由哪个 coding agent
执行，是可插拔的：

| Runtime | 状态 |
|---------|------|
| [omp](https://github.com/oh-my-pi/omp) | **已内置** —— 当前适配器（`src/review/runtime-omp.ts`），覆盖全部审查档位（quick / default / deep） |
| dsh 及其它 | 尚未接入 —— 端口即扩展点；新适配器无需改动 webhook / queue / store 管线即可插入 |

## Per-App 配置

审查所需的一切都在 dashboard 的 Settings 页（`/dashboard/apps/<slug>/settings`）**按 App
配置**——不存在跨 App 泄漏的部署级 provider key 或模型链旋钮。

- **Provider key（BYOK）**—— 加密存 D1，只从该 App 自己的配置注入审查容器，经固定 provider
  白名单（Anthropic、OpenAI、Gemini、Ark、OpenRouter、Groq 等——dashboard 展示完整列表）。同一页面可声明自定义 provider。
- **模型链**——逗号分隔的模型选择器，首个 = 主模型，其余 = 回退链。这是唯一的链来源。
- **Fail-closed**——没有链的 App，或链引用了未配 key 的 provider 的 App，审查将以结构化错误 fail-closed（settings 页可见 + `review_failures` 表），且发生在任何 sandbox / token 工作之前。为 App 开启审查前先配齐。

## 运维

- **Kill-switch**：仅当 Worker 变量 `REVIEW_ENABLED` 精确为 `"true"` 时审查才会运行。未设置或任何其他值 →
  所有 webhook 被 2xx 确认后忽略，零入队。上线前保持未设置。
- **Secrets 清单、部署步骤、回滚、完整 Multi-App go-live checklist** → [`docs/deploy.md`](docs/deploy.md)。

## 本地开发

```bash
bun install
bun run typecheck
bun test
```

- 本地 `wrangler dev` 的 secrets 放 `.dev.vars`（gitignored）——见 `.env.example`。
- 审查 runner CLI（镜像内入口）：`bun run review --level <quick|default> --input <json-file>` —— 在 stdout 打印 `mstar.review/v1` envelope JSON。
- Sandbox 冒烟：`bun run scripts/sandbox-smoke.ts`（需 `SMOKE_APP_ID` / `SMOKE_PRIVATE_KEY`；见文件头）。

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/deploy.md`](docs/deploy.md) | 完整部署 runbook：Cloudflare 资源、D1 迁移、secrets 清单、部署步骤、Multi-App go-live checklist、回滚 |

## 许可

[MIT](LICENSE)