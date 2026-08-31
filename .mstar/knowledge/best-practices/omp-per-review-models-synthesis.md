---
module: review-runner-models
date: 2026-08-31
last_updated: 2026-08-31
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Per-review / per-App custom model provider configuration in the sandbox runner"
  - "Generating omp models.yml at runtime"
  - "Adding modules to the in-image runner (src/review) — import graph rules"
plan_id: 23-dashboard-consolidation
tags:
  - omp
  - models-yml
  - per-review-config
  - sandbox-image
  - module-boundary
  - byok
---

# Per-review omp models.yml synthesis in the sandbox runner

## Context

omp 18.0.4 的自定义 provider 声明只有两条路：烤进镜像（`sandbox-image/omp-models.yml` → Dockerfile COPY 到 `/opt/omp-agent/models.yml`，`PI_CODING_AGENT_DIR` 指向）或 per-App BYOK 动态声明（v0.8 plan 23 交付）。多 App BYOK 产品面下，镜像烤死不可扩展。

## Guidance（源码级核实的机制，AL-23-1）

1. **omp 无 include/merge 语义**：`ModelRegistry` 构造 `ModelsConfigFile.relocate(modelsPath ?? path.join(getAgentDir(), "models.yml"))`，`ConfigFile` 单文件解析（.yml/.yaml fallback）。任何「增量片段/include 指令」方案不成立——必须**合成完整 models.yml**。
2. **`getAgentDir()` = `PI_CODING_AGENT_DIR` 环境覆盖（模块加载时快照）**；`CreateAgentSessionOptions.agentDir` 是 18.0.4 公开选项（`dist/types/sdk.d.ts`）→ 合成目录通过它注入，不改全局 env。
3. **合成流程**（runner 内）：读镜像基础文件 → merge 自定义 providers（base-wins；碰撞计数走 `onCollision` 回调 → runner 结构化 stderr warn）→ 写 `/tmp/omp-agent-<uuid>/models.yml` → `createAgentSession({ agentDir: <dir> })`。每审查独立目录，镜像文件只读。
4. **零 secret 落盘**：`apiKey` 字段 = **env var 名引用形**（`CUSTOM_<UPPER_SNAKE(id)>_API_KEY`），SDK 请求时从 exec env 解析；key 明文只存在于 `resolveCustomProviders` 内存 + exec env，永不进合成文件/日志/runner input JSON。SEC-01 exact-redaction 用 `sessionSecretValues` 把自定义 key 纳入脱敏。
5. **校验/边界**：provider id `^[a-z0-9][a-z0-9-]{0,63}$`；18 个内置 PROVIDER_IDS **和** 镜像 base ids（`ark-plan`）在声明时 400 拒绝（否则 base-wins 静默吞掉 + key 白注入）；每 App 声明数 ≤8；baseUrl https-only；模型 id 非空 ≤128 字符。
6. **YAML 1.1 陷阱**：provider key 必须引号包裹——裸 `on:`/`yes:`/`true:` 会被解析成 boolean（值一律引号 + key 也要引号，pin 测试用 id `on`）。
7. **镜像模块图边界（HARD）**：Dockerfile 只 `COPY src/review` 进 runner 镜像——`src/review/**` 禁止相对 import `../pipeline|../store|../dashboard`。边界由静态守卫测试锁（`tests/review/runtime-boundary.test.ts` 解析相对 import 目标）。共享符号放 `src/review/runtime.ts`，Worker 侧模块 re-export（单一 SSOT、零复制字面量）。

## Why This Matters

两条静默失败链都被 QC 实测抓到：(a) 镜像内 import 出界 → **所有** in-image runner 启动即崩（本地 bun test 全绿，因为本地有全树）；(b) 脱敏/碰撞/布尔 key 全是「单测各自绿、组合才炸」的形态。合成机制一旦铺开，返工成本是全量 BYOK 用户。

## When to Apply

- 动 `sandbox-image/Dockerfile`、`src/review/` 任何 import、`omp-models.yml` 时
- 新增自定义 provider 字段/校验时（对齐 `MAX_CUSTOM_PROVIDER_COUNT`/id regex/env-name 映射）
- 排查「本地测试绿、容器内 runner 崩」类问题

## Examples

- 实现：`src/review/models-synthesis.ts` + `runtime.ts`（base ids + env-name 帮助函数）+ `src/pipeline/consumer.ts` 注入 + `src/dashboard/app-config-store.ts` 声明 CRUD
- 测试：`tests/review/models-synthesis.test.ts`（合成/引号/碰撞）、`tests/review/runtime-boundary.test.ts`（模块图守卫）
- DDL：`migrations/0012` `app_custom_providers`（AAD `app_custom_providers.api_key_enc:<app_id>:<provider_id>`）