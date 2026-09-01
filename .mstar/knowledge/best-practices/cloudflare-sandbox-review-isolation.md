---
title: Cloudflare Sandbox 审查隔离（证伪结论与使用模式）
category: best-practices
problem_type: best_practice
module: review-orchestrator
severity: medium
date: 2026-08-26
status: active
created_at: 2026-08-26
last_updated: 2026-09-01
source_plan: 06-sandbox-review-pipeline
iteration: v0.2
verified: true
---

# Cloudflare Sandbox 审查隔离

## Context

mstar-inspector 在 Cloudflare Workers 上编排每 PR 隔离的代码审查：Queue consumer 在 Sandbox 容器内 clone + `gh pr diff` + 跑 omp（Bun）审查。本迭代（v0.2 / plan 06 T1）把 solution §5.6 的全部 ASSUMPTION 证伪为已核实。

## Guidance

### SDK 面（@cloudflare/sandbox 0.12.8 stable，2026-08 实测）

- `getSandbox(ns, id, opts)` **同步**返回；`ns` 是 `DurableObjectNamespace<Sandbox>`。
- `exec(cmd: string, { env?, cwd?, timeout? })` → `{ success, exitCode, stdout, stderr }`。
- `destroy()` 幂等，~50ms；空闲约 10 分钟 sleep（状态丢失，勿依赖）。
- **绑定形状三键一致**：`wrangler.jsonc` 的 `containers[].class_name` == `durable_objects.bindings[].class_name` == `migrations[].new_sqlite_classes[0]` == `"Sandbox"`；需 `nodejs_compat`。
- 镜像构建：`image_build_context` 指向含 Dockerfile 的目录；本地 `wrangler dev` 构建需 Docker（冷启动 ~3min，非每消息）。

### 受信任编排模式

- clone / `gh pr view` / `gh pr diff` 是 **Worker→exec 的受信任编排**，不是 agent 工具。
- `gh` 认证：`GH_TOKEN` 经 `exec` 的 `env` 注入（实测 `gh pr diff` 对真实 PR 返回非空 diff）；**密钥不进镜像**（含 build args）。
- 每消息一个 sandbox，id 用 `randomUUID()`（per-attempt 唯一），`finally` 中 `destroy()`；禁止跨消息复用。
- 容器内 omp：`HARNESS_PLUGIN_ROOT` 指向镜像预装根（env 注入）；模型 key 仅来自 per-App BYOK：`resolveAppConfig` 产出的 keys 经 PROVIDERS 注册表映射注入（`ark` → `ARK_API_KEY`），`key_source` ∈ `app|custom`（`buildRunnerEnv` 装配，无 env 参数）——全局 `OMP_MODEL_KEY` 单一映射点已随 v0.9 / AL-24-5 退役（零全局回退，见 `perapp-zero-global-fallback.md`）。

### 网络出站控制面（v0.7 / plan 19, AL-4 核实）

- `@cloudflare/sandbox` 0.12.8 自身 **无** egress 配置面（`SandboxOptions` 无网络字段）；控制面在其钉版依赖 **`@cloudflare/containers` 0.3.7** 的 `Container` 超类上：`allowedHosts`（白名单外 → 520 fail-closed）/ `deniedHosts` / `enableInternet` / `interceptHttps`。
- **启用前先问 host 清单是否有仓内 SSOT**：BYOK 开放 provider 集时，漏一个 host = 全部该 App review 520→DLQ，失败模式比不启用更差。先落 host SSOT + staging 验证，再启用。
- 本仓事实（v0.7）：runtime 必需出站 = `github.com`/`api.github.com`（gh CLI）+ provider API host（镜像内 `models.yml`）；构建期安装不限（build-time only）。

### 性能口径（实测）

- 热容器 exec ~2.6s；真实 omp 审查 ~52s；部署 e2e enqueue→Review ~90s。
- `max_batch_size: 1` + `max_instances: 1` → 吞吐上限 ~40 reviews/h（M1 可接受；并发限流属 M2）。

## Why This Matters

Sandbox 是 M1 审查隔离的耐久指针；SDK 是 preview 级快速迭代，薄适配层（`src/pipeline/sandbox.ts` 全仓唯一 import 点）把 API 漂移隔离在单文件。绑定三键不一致是部署期最常见的静默失败点。

## When to Apply

- 任何在 Workers 上编排容器内长任务的实现。
- 升级 `@cloudflare/sandbox` 前先跑 T1 冒烟（`scripts/sandbox-smoke.ts`）。

## Examples

- 证伪冒烟：`getSandbox` → `exec("gh pr diff ...", { env: { GH_TOKEN } })` → 断言非空 `diff --git` 前缀 → `destroy()`；`destroyEvidence.ok=true`。
- 失败路径：4 次坏 payload 演练 → 4 个 sandbox 全部 destroy（日志逐条含 idempotency_key + sandbox_id）。
