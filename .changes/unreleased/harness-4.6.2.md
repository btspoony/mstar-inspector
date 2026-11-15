---
category: Changed
---

- **Harness 4.6.2 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.6.2`, `packages/runner`'s exact pin to `4.6.2`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `e276cdac15a9bc5f91c8d6bea3c1f26895960a0c`, tag `v4.6.2`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.6.2 raises the DSH corridor to 0.2.2-rc.3, authorizes `milestone.assign` by seat and revision CAS rather than a session, closes residual engine/CLI/coordination findings from the 2026-11-14 iteration, and bumps several DSH/OpenCode/dev dependencies, plus the monorepo version alignment. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.

<!-- CN -->
- **harness 升至 4.6.2（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.6.2`，`packages/runner` 的精确 pin 改为 `4.6.2`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `e276cdac15a9bc5f91c8d6bea3c1f26895960a0c`，tag `v4.6.2`）与 Dockerfile 克隆 ref 一并向 4.6.2 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。4.6.2 将 DSH corridor 提升到 0.2.2-rc.3，把 `milestone.assign` 的授权改为按 seat 与 revision CAS 而非 session，收口 2026-11-14 iteration 残留的 engine/CLI/coordination 问题，并升级若干 DSH/OpenCode/开发依赖，同时完成 monorepo 版本对齐。本仓库已声明的语料布局，以及所消费的 review/seat 契约，不因这次 pin 升级而改变。
