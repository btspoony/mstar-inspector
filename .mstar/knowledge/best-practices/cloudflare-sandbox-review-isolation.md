---
title: Cloudflare Sandbox 审查隔离（证伪结论与使用模式）
category: best-practices
problem_type: best_practice
module: review-orchestrator
severity: medium
date: 2026-08-26
status: active
created_at: 2026-08-26
last_updated: 2026-10-14
source: sandbox review pipeline
iteration: v0.2
verified: true
---

# Cloudflare Sandbox 审查隔离

## Context

mstar-inspector 在 Cloudflare Workers 上编排每 PR 隔离的代码审查：Queue consumer 在 Sandbox 容器内 clone + `gh pr diff` + 跑 omp（Bun）审查。本迭代（v0.2）把 solution §5.6 的全部 ASSUMPTION 证伪为已核实。

## Guidance

### SDK 面（in-repo adapter，@cloudflare/sandbox 1.0.0，2026-10 实测）

- **1.0.0 移除了 `Sandbox` 类与 `getSandbox()`**：这两个符号在包内已不存在（现存导出是 `Files`/`S3Mount`/`DirectoryBackup`/`S3Gateway`/`DirectoryBackupGateway` 等运行期值与错误类，见 `node_modules/@cloudflare/sandbox/dist/index.d.mts` 的 export 行——本仓 `src/**` 一个都没 import）。该 npm 依赖保留的意义只是**版本锚**——镜像的 `sandbox-shim` 从同一 1.0.0 行 COPY（`sandbox-image/omp/Dockerfile`：`COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim …`），两条线的 tag 必须一起动。
- **适配层在仓内、不在 SDK 里**：`SandboxV1 extends DurableObject`（workerd 内置 `cloudflare:workers`），通过 `this.ctx.container` 亲自驱动容器——`container.start({ image, instance: "lite", enableInternet: true })` 启动、`container.setInactivityTimeout(30min)` 武装空闲界、`container.exec(argv, { cwd, env })` 跑单进程。`start()` 返回时容器未必就绪，首个 `exec()` 会等；执行类 RPC `runCommand()` 先过 `ensureRunning()`（`destroy()` 不启动容器，直接 `container.destroy()`）。
- **`getSandbox(binding, id)` 仍在**，但实现是 `namespace.getByName(id.toLowerCase())`（DO 名不接受大小写；0.12 的 `normalizeId` 已删），返回类型仍是锁定的 `ReviewSandbox`（`runCommand`/`destroy`）。
- **唯一 shell sink = `runCommand(command, opts)`**，argv 固定为 `["timeout", "--kill-after=5", <seconds>, "/bin/sh", "-lc", command]`：`command` 是 `ShellCommand` 品牌：由 pipeline/gitops 构建器（allowlist + fail-closed + 单引号纪律）**和仓内受审计入口**（冒烟入口 `src/pipeline/smoke-entry.ts` 对格式校验后的 `GH_REPO` 与常量 `GH_PR` 直接调 `shellCommand()`）经 `src/pipeline/shell-command.ts` 导出的 `shellCommand()` 铸造——品牌不是构建器专属；字符串恰好一次到达 `/bin/sh`；超时用 GNU coreutils `timeout`（秒，可小数，不取整），退出码 124 = 边界触发。`destroy()` → `container.destroy()`。
- **绑定形状与迁移**：`wrangler.jsonc` 的 `containers[].class_name` == `durable_objects.bindings[].class_name` == `"SandboxV1"`；容器应用名 `mstar-inspector-sandbox-v2`，`scheduling_policy: "durable_object"`，`images.sandbox` → `./sandbox-image/omp/Dockerfile`（`build_context: "."`）。迁移两条：`v1`（`new_sqlite_classes: ["Sandbox"]`）是历史；`v2`（`["SandboxV1"]`）是新类。**首部署会重放每条未应用的迁移**，所以 `Sandbox` 仍以 inert 兼容类导出（同文件、无容器、无路由、`durable_objects` 只指向 `SandboxV1`）——删掉它会让上传被拒。迁移 `v2` 必须是新类：容器应用不能原地改 `scheduling_policy`，也不能挂到 0.12 时代已占用的 DO 命名空间上。
- 需 `nodejs_compat`；旧容器应用 `mstar-inspector-sandbox` 被这次切换**孤儿化**，由 ops 删除。

### 受信任编排模式

- clone / `gh pr view` / `gh pr diff` 是 **Worker→`runCommand` 的受信任编排**，不是 agent 工具。
- `gh` 认证：`GH_TOKEN` 经 `runCommand` 的 `opts.env` 注入（实测 `gh pr diff` 对真实 PR 返回非空 diff）；**密钥不进镜像**（含 build args）。**该命令用的就是 `sandbox-read` 授权**，所以该授权必须含 `pull_requests: read`（其余仍只读、仅限单仓）——否则 diff 步会 403，review 直接失败。
- 每消息一个 sandbox，id 用 `randomUUID()`（per-attempt 唯一），`finally` 中 `destroy()`；禁止跨消息复用。
- 容器内 omp：`HARNESS_PLUGIN_ROOT` 指向镜像预装根（env 注入）；模型 key 仅来自 per-App BYOK：`resolveAppConfig` 产出的 keys 按 provider 装进凭据池 env（`MSTAR_POOL_<UPPER_SNAKE(id)>_COUNT` + `_01.._NN`），runner 在会话创建前写成 `<agentDir>/agent.db` 的 `source:"login"` 行；`key_source` ∈ `app|custom`（`buildRunnerEnv` 装配，无 env 参数）。注册表里的 env 名（`ark → ARK_API_KEY`）已退为白名单元数据，不再是注入变量——全局 `OMP_MODEL_KEY` 单一映射点已随 v0.9 / AL-24-5 退役（零全局回退，见 `perapp-zero-global-fallback.md`）。

### 网络出站控制面（v0.7 核实；2026-10 修订到 1.0 面）

- **1.0 的控制面就是 workerd 内置的 `ctx.container`**（`@cloudflare/workers-types` 的 `Container` 接口）：旧 SDK 那条经 `@cloudflare/containers` `Container` 超类的继承链随 0.12 线一起消失。本仓**不**直接 import 任何 egress SDK：开关只有 `container.start({ …, enableInternet })` 这一个字段（当前固定 `true`）。
- 类型面仍有更细的钩子（`interceptOutboundHttp(addr, binding)`、`interceptOutboundHttps(addr, binding)`、`interceptAllOutboundHttp(binding)`），但它们**不在**本仓代码里，属于「若要收紧可以怎么做」，不是现状。
- **启用白名单前先问 host 清单是否有仓内 SSOT**：BYOK 开放 provider 集时，漏一个 host = 全部该 App review 失败→DLQ，失败模式比不启用更差。先落 host SSOT + staging 验证，再收紧 `enableInternet`。
- 本仓事实（v0.7）：runtime 必需出站 = `github.com`/`api.github.com`（gh CLI）+ provider API host（镜像内 `models.yml`）；构建期安装不限（build-time only）。

### 性能口径（实测）

- 热容器 exec ~2.6s；真实 omp 审查 ~52s；部署 e2e enqueue→Review ~90s。
- `max_batch_size: 1` + `max_concurrency: 1`，且 `scheduling_policy: "durable_object"` 下的容器应用已无 `max_instances` 上限（`wrangler.jsonc` containers 注释；并发只能靠这个 pin 约束）→ 吞吐上限 ~40 reviews/h（M1 可接受；并发限流属 M2）。

## Why This Matters

Sandbox 是 M1 审查隔离的耐久指针；适配层（`src/pipeline/sandbox.ts` 全仓唯一 import 点）把容器 API 漂移隔离在单文件。绑定三键不一致是部署期最常见的静默失败点：`containers[].class_name` / `durable_objects.bindings[].class_name` 现在都必须是 `"SandboxV1"`，而 `Sandbox` 只作为 `v1` 迁移名保留。

## When to Apply

- 任何在 Workers 上编排容器内长任务的实现。
- 改 `wrangler.jsonc` 的 `containers` / `durable_objects` / `migrations`（三处 class_name 与迁移 tag 必须一起动）。
- 升级 `@cloudflare/sandbox`（本仓只作 shim 版本锚）前先跑 T1 冒烟（`scripts/sandbox-smoke.ts`）。

## Examples

- 证伪冒烟（`src/pipeline/smoke-entry.ts` T1）：`getSandbox(env.SANDBOX, "smoke-<uuid>")` → `sandbox.runCommand(shellCommand("gh pr diff …"), { env: { GH_TOKEN } })` → 判定成功 = `exitCode === 0 && stdout.trim().length > 0`（只打印前 40 字符，不断言 `diff --git`；git 失败腿同判据）→ `sandbox.destroy()`；`destroyEvidence.ok=true`。
- 失败路径：4 次坏 payload 演练 → 4 个 sandbox 全部 destroy（日志逐条含 idempotency_key + sandbox_id）。
