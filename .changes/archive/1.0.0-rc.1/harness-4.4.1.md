---
category: Changed
---

- **Harness 4.4.1 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.4.1`, `packages/runner`'s exact pin to `4.4.1`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `e834dce3ff66403463207e267fd4bcf62c8d4d55`, tag `v4.4.1`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. No API change reaches this repo: 4.4.1 only adds the specs/ADR document-layer lints and skill-corpus errata to the harness's own surfaces.

<!-- CN -->
- **harness 升至 4.4.1（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.4.1`，`packages/runner` 的精确 pin 改为 `4.4.1`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `e834dce3ff66403463207e267fd4bcf62c8d4d55`，tag `v4.4.1`）与 Dockerfile 克隆 ref 一并向 4.4.1 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。本仓库没有需要适配的 API 变化：4.4.1 只在 harness 自身的表面上新增 specs/ADR 文档层 lint 与 skill 语料的勘误。
