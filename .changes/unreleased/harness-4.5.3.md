---
category: Changed
---

- **Harness 4.5.3 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.5.3`, `packages/runner`'s exact pin to `4.5.3`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `bc33a78c6d4fbc079c3e954833ae0bdc93a1ac3c`, tag `v4.5.3`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.5.3 is a documentation, packaging and harness-internal release (the accepted-limits ADR is implemented with no behavior change; release prep now packs built CLI/OpenCode dist; the consumer-manifest digest gate and advisory artifact-byte comparisons are removed; `calibrate` missing-artifact errors go through the artifact helper). This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.

<!-- CN -->
- **harness 升至 4.5.3（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.5.3`，`packages/runner` 的精确 pin 改为 `4.5.3`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `bc33a78c6d4fbc079c3e954833ae0bdc93a1ac3c`，tag `v4.5.3`）与 Dockerfile 克隆 ref 一并向 4.5.3 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。4.5.3 是文档、打包与 harness 内部修复（accepted-limits ADR 落地且行为不变；release prep 改为打包已构建的 CLI/OpenCode dist；删除 consumer-manifest digest 门禁与 advisory artifact-byte 比对；`calibrate` 缺失产物错误改走 artifact helper）。本仓库已声明的语料布局，以及所消费的 review/seat 契约，不因这次 pin 升级而改变。
