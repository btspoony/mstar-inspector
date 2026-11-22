---
category: Changed
---

- **harness engine, CLI and image ref move to 4.8.2**: the root and `packages/runner` manifests move `@mstar-harness/engine` from `^4.8.1`/`4.8.1` to `^4.8.2`/`4.8.2`, and both lockfiles re-resolve. The image pin moves with them — `HARNESS_VERSION`/`harnessRef` (tag v4.8.2, deref `a3b2763a7f33a14c1193aee5ac8880dda970d218`), the global-install `@mstar-harness/cli` 4.8.2 and its lock, and the Dockerfile clone ref. The omp SDK stays on 19.0.1. The `# image-inputs:` fingerprint is refreshed in the same commit because `packages/runner/package.json` and its lockfile are image inputs.

<!-- CN -->
- **harness engine、CLI 与镜像 ref 升至 4.8.2**：根目录与 `packages/runner` 的 `@mstar-harness/engine` pin 从 `^4.8.1`/`4.8.1` 升到 `^4.8.2`/`4.8.2`，两个 lock 重新解析。镜像 pin 一并移动——`HARNESS_VERSION`/`harnessRef`（tag v4.8.2，deref `a3b2763a7f33a14c1193aee5ac8880dda970d218`）、全局安装的 `@mstar-harness/cli` 4.8.2 及其 lock、以及 Dockerfile 克隆 ref。omp SDK 仍停留在 19.0.1。同一提交中刷新了 `# image-inputs:` 指纹，因为 `packages/runner/package.json` 及其 lock 是镜像输入。
