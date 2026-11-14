---
category: Changed
---

- **Harness 4.6.0 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.6.0`, `packages/runner`'s exact pin to `4.6.0`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `109922bb7d4cae3b87956e7c14576500cdca25cf`, tag `v4.6.0`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.6.0 adds Guard 13/14, the `skill-corpus-audit` variant, Depth and Spec-Fidelity lenses on QC1, one-round frontier `clarify`, skill completion-criteria guidance, Evidence / Merge-danger on the PR body, and mechanical/judgement audit-finding classification. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.

<!-- CN -->
- **harness 升至 4.6.0（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.6.0`，`packages/runner` 的精确 pin 改为 `4.6.0`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `109922bb7d4cae3b87956e7c14576500cdca25cf`，tag `v4.6.0`）与 Dockerfile 克隆 ref 一并向 4.6.0 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。4.6.0 新增 Guard 13/14、`skill-corpus-audit` 审计变体、挂在 QC1 上的 Depth / Spec-Fidelity lens、一轮问完无前置条件的 frontier `clarify`、技能完成标准指引、PR 正文的 Evidence / Merge-danger，以及 audit finding 的 mechanical/judgement 分类。本仓库已声明的语料布局，以及所消费的 review/seat 契约，不因这次 pin 升级而改变。
