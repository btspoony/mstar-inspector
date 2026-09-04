---
module: review-runner-models
date: 2026-08-31
last_updated: 2026-09-04
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Per-review / per-App custom model provider configuration in the sandbox runner"
  - "Generating omp models.yml at runtime"
  - "Adding modules to the in-image runner (src/review) — import graph rules"
plan_id: 23-dashboard-consolidation
related_components:
  - "37-sandbox-image-registry (always-synthesize cutover; registry capability hosts)"
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

omp 18.0.4 的自定义 provider 声明只有两条路：烤进镜像或 per-App BYOK 动态声明。多 App BYOK 产品面下，镜像烤死不可扩展。**2026-09-04（plan 37）烤制路线已退役**：`sandbox-image/omp-models.yml` 已删除，base 由源码内 registry（`src/contracts/sandbox-images.ts`）的 capability hosts 现场生成——**每次** review 都合成完整 models.yml（含零自定义 provider 的 App），不再有 skip-synthesis 路径。

## Guidance（源码级核实的机制，AL-23-1；37 后更新）

1. **omp 无 include/merge 语义**：`ModelRegistry` 构造 `ModelsConfigFile.relocate(modelsPath ?? path.join(getAgentDir(), "models.yml"))`，`ConfigFile` 单文件解析（.yml/.yaml fallback）。任何「增量片段/include 指令」方案不成立——必须**合成完整 models.yml**。
2. **`getAgentDir()` = `PI_CODING_AGENT_DIR` 环境覆盖（模块加载时快照）**；`CreateAgentSessionOptions.agentDir` 是 18.0.4 公开选项 → 合成目录通过它注入。**37 起 `agentDir` 与 runner input 的 `capabilityHosts` 均为必填**（shape guard 拒绝缺失/空数组/非有限数值）。
3. **合成流程**（runner 内）：`capabilityHostsYaml`（capability hosts 来自 registry，随 runner input 进容器——in-image 模块图禁 import `src/contracts`，verify-synthesis.sh 内联 `ARK_PLAN_HOST` 字面量并有 source-contract 漂移锁）作 base → merge App 自定义 providers（**capability/base ids wins** 碰撞；计数走 `onCollision` 回调 → runner 结构化 stderr warn）→ 写 `/tmp/omp-agent-<uuid>/models.yml` → `createAgentSession({ agentDir })`。每审查独立目录。等价性由三层测试锁（generator、write helper、zero-custom bytes ≙ 旧烤制文件含 `ark-plan`）。
4. **零 secret 落盘**：`apiKey` 字段 = **env var 名引用形**（`CUSTOM_<UPPER_SNAKE(id)>_API_KEY`），SDK 请求时从 exec env 解析；key 明文只存在于 `resolveCustomProviders` 内存 + exec env，永不进合成文件/日志/runner input JSON。SEC-01 exact-redaction 用 `sessionSecretValues` 把自定义 key 纳入脱敏。
5. **校验/边界**：provider id `^[a-z0-9][a-z0-9-]{0,63}$`；内置 PROVIDER_IDS **和** 所选镜像 capability host ids（如 `ark-plan`，经 `sandboxImageHostIds(selectedImageId)`）在声明时 400 拒绝（否则 base-wins 静默吞掉 + key 白注入）；每 App 声明数 ≤8；baseUrl https-only；模型 id 非空 ≤128 字符。
6. **YAML 1.1 陷阱**：provider key 必须引号包裹——裸 `on:`/`yes:`/`true:` 会被解析成 boolean（值一律引号 + key 也要引号，pin 测试用 id `on`）。registry capability hosts 为受信源数据、emit 裸标量；**新增第二个 registry 条目时必须加引号/校验**（契约行见 `src/contracts/sandbox-images.ts` 头注）。
7. **镜像模块图边界（HARD）**：Dockerfile 只 `COPY src/review` 进 runner 镜像——`src/review/**` 禁止相对 import `../pipeline|../store|../dashboard|../contracts`。边界由静态守卫测试锁。共享符号放 `src/review/runtime.ts`；registry 镜像类型用测试侧 type-lock（`tests/contracts/sandbox-images.test.ts` 双向 assignability）防漂移。

## Why This Matters

两条静默失败链都被 QC 实测抓到：(a) 镜像内 import 出界 → **所有** in-image runner 启动即崩（本地 bun test 全绿，因为本地有全树）；(b) 脱敏/碰撞/布尔 key 全是「单测各自绿、组合才炸」的形态。37 的烤制文件删除进一步把「基础能力丢失」变成静默风险——故零自定义路径的 byte-equivalence 测试是硬门槛。

## When to Apply

- 动 `sandbox-image/omp/Dockerfile`、`src/review/` 任何 import、registry capability hosts、`verify-synthesis.sh` 时
- 新增自定义 provider 字段/校验时（对齐 `MAX_CUSTOM_PROVIDER_COUNT`/id regex/env-name 映射）
- 排查「本地测试绿、容器内 runner 崩」类问题
- 新增第二个 sandbox image registry 条目时（见 `sandbox-image-registry-contract`）

## Examples

- 实现：`src/review/models-synthesis.ts`（`capabilityHostsYaml` + `writePerReviewModelsYaml(capabilityHosts, customProviders?)`）+ `runtime.ts` + `src/pipeline/consumer.ts`（`resolveSandboxImage` fail-closed 先于 guard/`getSandbox`）+ `src/contracts/sandbox-images.ts`（registry SSOT）
- 测试：`tests/review/models-synthesis.test.ts`（合成/引号/碰撞/零自定义字节等价）、`tests/review/runtime-boundary.test.ts`（模块图守卫）、`tests/contracts/sandbox-images.test.ts`（registry↔verify-script/wrangler 漂移锁 + type-lock）
- DDL：`migrations/0012` `app_custom_providers`（AAD `app_custom_providers.api_key_enc:<app_id>:<provider_id>`）