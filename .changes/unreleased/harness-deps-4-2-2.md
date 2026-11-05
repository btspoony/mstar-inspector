---
category: Changed
---

- **Harness engine 4.2.2 across root and runner**: the root manifest's `@mstar-harness/engine` range moves to `^4.2.2` and `packages/runner`'s exact pin to `4.2.2`; both lockfiles regenerate, and `@oh-my-pi/pi-coding-agent` stays at 18.13.3.
- **Review sandbox image follows to 4.2.2**: the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `98504a71dcf09cfb551847b85e81d33e682e0bd9`, tag `v4.2.2`) and Dockerfile clone ref move to 4.2.2, and the image rebuild marker is touched in the same commit because the runner manifest, the CLI manifest and the pinned ref are image inputs.
- **No operational change from this entry**: the change is version pins, lockfiles, the pin contract and the rebuild marker — no image build, deployment, or smoke was run.

<!-- CN -->
- **harness engine 升至 4.2.2（根与 runner）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.2.2`，`packages/runner` 的精确 pin 改为 `4.2.2`；两份 lock 重新生成，`@oh-my-pi/pi-coding-agent` 仍为 18.13.3。
- **审查沙箱镜像跟进到 4.2.2**：镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `98504a71dcf09cfb551847b85e81d33e682e0bd9`，tag `v4.2.2`）与 Dockerfile 克隆 ref 一并移动，并在同一提交中更新镜像重建标记——runner manifest、CLI manifest 与所 pin 的 ref 都是镜像输入。
- **本条目不涉及运维动作**：变更内容为版本 pin、lock、pin 契约与重建标记——未执行镜像构建、部署或 smoke。
