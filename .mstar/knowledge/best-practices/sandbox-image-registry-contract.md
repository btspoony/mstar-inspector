---
module: sandbox-runtime
date: 2026-09-04
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "Adding or changing a sandbox runtime image for review execution"
  - "Wiring App-selected runtime configuration into the review pipeline"
  - "Deciding what may be baked into a container image vs synthesized at runtime"
plan_id: 37-sandbox-image-registry
tags:
  - sandbox-image
  - registry
  - cloudflare-sandbox
  - omp
  - fail-closed
  - byok
---

# Sandbox image registry contract (App-selected runtime images)

## Context

Iteration 012-dashboard-sandbox (plan 37) 把 sandbox 运行时从「omp 专属 + 烤制 models.yml」改成 **App 选择的镜像 registry**：`github_apps.sandbox_image_id` 持久化选择、`src/contracts/sandbox-images.ts` 是零依赖 registry SSOT（dashboard Q2 不能 import `src/review`/`src/pipeline`）、部署仍只有一个 Cloudflare `Sandbox` container class（omp 镜像）。Future runtimes（Pi/AI SDK 等）按本契约扩展，不再改 omp 专属逻辑。

## Guidance

1. **Registry 形态**：`SandboxImageId` / `SandboxImageDefinition` / `DEFAULT_SANDBOX_IMAGE_ID="omp"` / `getSandboxImage(id)` / `enabledSandboxImages()` / `sandboxImageHostIds(id)`。closed lookup（未知/禁用 id 失败）、零 import（含 secrets、dashboard 数据）。omp entry 携带 Dockerfile/wrangler 路径 + capability hosts（如 `ark-plan`：catalogProviderId `ark`、`ARK_API_KEY`、baseUrl、models）。
2. **App 选择与校验**：`github_apps.sandbox_image_id TEXT NOT NULL DEFAULT 'omp'`（0018，无 CHECK，store-enforced；软删行一并 backfill）。保存仅限 `canManageApp` + enabled registry id（400 zero-write）。**Pipeline 在 `assertAppConfigComplete` 之前** `resolveSandboxImage`（结构化非 secret 错误、`stage=pipeline`），严格先于 `acquireReviewGuard` 与 `getSandbox`——未知/禁用 id 永不启动容器。
3. **`getSandbox(binding, instanceId)` 不是 image picker**：一个 Worker 一个 container class。本迭代校验持久化 id 后使用已部署 omp 镜像；第二 runtime 是后续 container-binding 变更（部署窗口 runner/input skew 契约见 `src/contracts/sandbox-images.ts:19-23`：旧 worker/新镜像瞬态失败 self-heal via retry，启用第二个镜像或改容器目标必须重新验证该契约）。
4. **镜像里只有运行时，没有 App 配置**：Dockerfile（`sandbox-image/omp/Dockerfile`）零 App secret/provider/model/`models.yml` COPY；`/opt/omp-agent` 仅空目录 + `PI_CODING_AGENT_DIR`；models.yml 每 review 合成（见 `omp-per-review-models-synthesis`）。parity 锁：`tests/contracts/sandbox-images.test.ts`（registry 路径 ↔ wrangler.jsonc + wrangler.smoke.jsonc、verify-synthesis.sh `ARK_PLAN_HOST` 字面量漂移锁、in-image 类型镜像 type-lock）。
5. **加第二个 runtime 的清单**（每条都有部署窗口验证义务）：独立 Dockerfile（`sandbox-image/<runtime>/`）→ registry entry（stable id + capability contract + hosts）→ 该 runtime 的 configuration synthesizer → runner 支持 → wrangler 双配置 + B-37-1 类 credentialed smoke（`scripts/sandbox-smoke.ts` + in-image `verify-synthesis.sh` U-001）→ enabled。**omp 不得出现在 Providers catalog**（runtime capability ≠ provider 目录 id；catalog id 是 `ark`）。

## Why This Matters

把「能跑」和「配了什么」分开后，App 配置（providers/models/keys）永不进入构建产物，镜像可以独立重建/部署；registry 的 closed lookup 让坏 id 在容器启动前 fail-closed。反例（本迭代修复前）：App 模型配置烤在镜像里 → 换 App 配置需要重建镜像、多 App 无法共存、capability host（`ark-plan`）与 App 配置边界模糊。

## When to Apply

- 任何 `src/contracts/sandbox-images.ts`、`sandbox-image/**`、`src/pipeline/consumer.ts` 镜像解析、`github_apps.sandbox_image_id` 相关改动
- 评估「要不要加新 runtime」时（先过上面第 5 条清单，产品决策见 compass Roadmap Position：user-approved runtime contract 前不启动）

## Examples

- Registry + 迁移 + 存取：`src/contracts/sandbox-images.ts`、`migrations/0018_app_sandbox_images.sql`、`src/dashboard/apps-store.ts`（`setSandboxImage`）
- 执行侧：`src/pipeline/consumer.ts`（`resolveSandboxImage`）、`src/review/models-synthesis.ts`
- 测试：`tests/contracts/sandbox-images.test.ts`、`tests/pipeline/consumer.test.ts`（invalid id fail-closed、zero-custom ark-plan 等价）
- 已知 open 项：B-37-1（部署窗口 credentialed build + in-image U-001 replay + sandbox smoke；`dev-dashboard/residuals.json` R1 defer）

## Promoted to

Source: `iteration:012-dashboard-sandbox/specs/dashboard-sandbox-configuration.md`（Runtime-image contract §§；结构化重写，非整文复制）
