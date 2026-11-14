---
category: Changed
---

- **Harness 4.6.1 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.6.1`, `packages/runner`'s exact pin to `4.6.1`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `8ff83b33141b67a353886d5ac18457ba08cc4dd5`, tag `v4.6.1`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.6.1 is a harness-internal patch: the dashboard generated asset is a gitignored build output again, `--adopt` redacts pasted credentials, the Linear label-discovery recovery names the real repair, `plan.bind`'s caller-identity refusal is host-neutral, and the harness pins bun 1.4.4. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.

<!-- CN -->
- **harness 升至 4.6.1（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.6.1`，`packages/runner` 的精确 pin 改为 `4.6.1`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `8ff83b33141b67a353886d5ac18457ba08cc4dd5`，tag `v4.6.1`）与 Dockerfile 克隆 ref 一并向 4.6.1 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。4.6.1 是 harness 内部补丁：dashboard 生成资源重新作为 gitignore 的构建产物、`--adopt` 会脱敏粘贴的凭据、Linear 标签发现失败的恢复指向真正的修复、`plan.bind` 的调用方身份拒绝改为 host-neutral，以及 harness 将 bun 钉到 1.4.4。本仓库已声明的语料布局，以及所消费的 review/seat 契约，不因这次 pin 升级而改变。
