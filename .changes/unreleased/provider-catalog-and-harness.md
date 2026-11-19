---
category: Added
---

- **The provider catalogue refreshes itself, and a red gate blocks the publish**: a daily workflow rebuilds `scripts/provider-catalog/generated/` from its declared inputs, declares the directory's contract in `scripts/provider-catalog/README.md` (whose table's first column is the tracked file list), and runs typecheck plus the full suite before it pushes — a non-zero exit stops the run with nothing committed, nothing pushed, no PR opened. Overrides live in `inputs/overrides.json` so a bucket whose upstream data is staler or worse than the live API keeps its curated entries.
- **Hermes harness 4.7.3 with omp 18.22.2**: the engine/CLI pin, the image's `HARNESS_VERSION`/`harnessRef` anchor and every lockfile move as one release, and a new fingerprint gate (`scripts/check-image-inputs.ts`) fails when an image input changed without the marker line moving — the failure that let a deployed Worker keep using a stale runner.

<!-- CN -->
- **provider 目录自动刷新，门禁红了就不发布**：每日 workflow 从声明的输入重建 `scripts/provider-catalog/generated/`，在 `scripts/provider-catalog/README.md` 里声明目录契约（表格首列即受版本控制的文件清单），推送前先跑 typecheck 与全量测试——非零退出即中止，不提交、不推送、不开 PR。覆盖项放在 `inputs/overrides.json`，让上游数据比 live API 更旧或更差的桶保留精选条目。
- **harness 4.7.3 与 omp 18.22.2**：engine/CLI 的 pin、镜像的 `HARNESS_VERSION`/`harnessRef` 锚点与所有 lockfile 作为一次发布整体移动；新增指纹门禁（`scripts/check-image-inputs.ts`），镜像输入变了却没有移动标记行时失败——正是这个缺口让部署的 Worker 继续使用过期 runner。

