---
category: Changed
---

- **Sandbox SDK 0.12.8 → 1.0.0**: version 1.0 no longer ships the `Sandbox` class or `getSandbox()`, so `src/pipeline/sandbox.ts` now owns a Durable Object written in-repo that starts and drives its own container (`this.ctx.container`) and exposes the same `runCommand` / `destroy` RPCs to the Worker.
- **Container configuration moved to the Durable Object scheduling policy**: `wrangler.jsonc` / `wrangler.smoke.jsonc` use `scheduling_policy: "durable_object"` with a named image map (the instance size moves into `container.start()`), and the container application gets a NEW name — the 0.12-era application name cannot be reused.
- **Review sandbox image rebuilt on a base we control**: the SDK's runtime base image is gone, so the Dockerfile starts from a digest-pinned Debian base — linux/amd64, so rebuilds cannot silently change libc/coreutils/CA packages (plus the tools the pinned Bun/gh/harness steps need) — and copies `sandbox-shim` from the matching 1.0.0 image; a long-lived default command keeps the container alive.
- **The consumer contract is unchanged**: `ReviewSandbox`, `getSandbox(binding, id)`, the branded `ShellCommand` single-sink boundary and the per-command 600-second bound all keep their meaning — a fired bound now reports exit code 124 instead of throwing.

<!-- CN -->
- **Sandbox SDK 0.12.8 → 1.0.0**：1.0 不再提供 `Sandbox` 类与 `getSandbox()`，因此 `src/pipeline/sandbox.ts` 改为在仓库内自写 Durable Object，由其自行启动并驱动容器（`this.ctx.container`），对 Worker 暴露同样的 `runCommand` / `destroy` RPC。
- **容器配置改走 Durable Object 调度策略**：`wrangler.jsonc` / `wrangler.smoke.jsonc` 使用 `scheduling_policy: "durable_object"` 与具名镜像映射（实例规格移入 `container.start()`），容器应用启用一个**新的名称**——不能再复用 0.12 时代的应用名。
- **评审沙箱镜像改为自有基础镜像**：SDK 不再提供运行时基础镜像，Dockerfile 改从按 digest 固定的 Debian 基础镜像起步（linux/amd64，重建时不会静默变更 libc/coreutils/CA 包；并安装 Bun/gh/harness 固定步骤所需工具），再从对应的 1.0.0 镜像复制 `sandbox-shim`；长驻默认命令保证容器存活。
- **消费方契约不变**：`ReviewSandbox`、`getSandbox(binding, id)`、`ShellCommand` 品牌化的单一汇点边界与每命令 600 秒上限语义均保持不变——上限触发时改为返回退出码 124，而不再抛错。
