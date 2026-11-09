---
category: Changed
---

- **Harness 4.4.0 across root, runner and the review image**: the root manifest's `@mstar-harness/engine` range moves to `^4.4.0`, `packages/runner`'s exact pin to `4.4.0`, and the image's `@mstar-harness/cli` global install, `HARNESS_VERSION` / `harnessRef` pin (ref `a6721f5231e74ade74e80af5b1596edc6898f4be`, tag `v4.4.0`) and Dockerfile clone ref move with them; every lockfile regenerates and the image rebuild marker is touched in the same commit because those manifests and the pinned ref are image inputs.
- **Review bodies no longer carry an unverified count**: the engine retired that tally bucket, so the seat wire contract, the seat merge, the parent output contract and the inspector's envelope schema drop it, and a published review body renders only the must-fix / should-fix / may-fix / nit rows. Envelopes already stored keep every field they were written with — reads are not re-validated against the new shape.

<!-- CN -->
- **harness 升至 4.4.0（根、runner 与审查镜像）**：根 manifest 的 `@mstar-harness/engine` 区间改为 `^4.4.0`，`packages/runner` 的精确 pin 改为 `4.4.0`，镜像全局安装的 `@mstar-harness/cli`、`HARNESS_VERSION` / `harnessRef` pin（ref `a6721f5231e74ade74e80af5b1596edc6898f4be`，tag `v4.4.0`）与 Dockerfile 克隆 ref 一并向 4.4.0 移动；所有 lock 重新生成，并在同一提交中更新镜像重建标记——这些 manifest 与所 pin 的 ref 都是镜像输入。
- **审查正文不再携带 unverified 计数**：引擎移除了该统计分桶，因此席位线契约、席位合并、父级输出契约与 inspector 的信封 schema 一并去掉该字段，已发布的审查正文只渲染 must-fix / should-fix / may-fix / nit 四行。已存储的信封保留写入时的全部字段——读取路径不会按新形状重新校验。
