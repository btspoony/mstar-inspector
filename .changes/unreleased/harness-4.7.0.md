---
category: Changed
---

- **Harness 4.7.0 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.7.0`, `packages/runner`'s exact pin to `4.7.0`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `cb14eb364c339c07318b4d2ae7ce25f004adb45c`, tag `v4.7.0`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs. 4.7.0 gates and describes the rc.3 Agent Teams surface in the dsh plugin and host skills, removes `spawn_teammate` and the roster-era Team carriers with no compatibility shim, and narrows host-detect vocabulary to rc.3's dsh channels (`subagent`, `team_task_create`), plus the monorepo version alignment. This repo's declared corpus layout and consumed review/seat contract are unchanged by the pin bump.

<!-- CN -->
- **harness 升至 4.7.0（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.7.0`，`packages/runner` 的精确 pin 改为 `4.7.0`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `cb14eb364c339c07318b4d2ae7ce25f004adb45c`，tag `v4.7.0`）与 Dockerfile 克隆 ref 一并向 4.7.0 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。4.7.0 在 dsh 插件与 host skills 中对 rc.3 Agent Teams 表面做门控与描述，无兼容垫片地移除 `spawn_teammate` 与 roster 时代的 Team carrier，并将 host-detect 词汇收窄到 rc.3 的 dsh 通道（`subagent`、`team_task_create`），同时完成 monorepo 版本对齐。本仓库已声明的语料布局，以及所消费的 review/seat 契约，不因这次 pin 升级而改变。
