---
category: Changed
---

- **Harness 4.5.2 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.5.2`, `packages/runner`'s exact pin to `4.5.2`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `1a6a90c3fe097e618ec6ebd154b630857ad1f3be`, tag `v4.5.2`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.5.0 renamed the completion payload's `qa` carrier to `acceptance` and added an issue `obsolete` disposition on the harness's own surfaces; 4.5.1 moved tracked-corpus defaults to `.agents/<kind>/` (`.mstarc` remains authoritative). This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.

<!-- CN -->
- **harness 升至 4.5.2（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.5.2`，`packages/runner` 的精确 pin 改为 `4.5.2`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `1a6a90c3fe097e618ec6ebd154b630857ad1f3be`，tag `v4.5.2`）与 Dockerfile 克隆 ref 一并向 4.5.2 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。4.5.0 将完成载荷中的 `qa` 载体更名为 `acceptance`，并在 harness 自身表面上为 issue 增加 `obsolete` 终结态；4.5.1 将受控语料的默认路径改到 `.agents/<kind>/`（`.mstarc` 仍是权威配置）。本仓库已声明的语料布局，以及所消费的 review/seat 契约，不因这次 pin 升级而改变。
