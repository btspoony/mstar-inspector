---
category: Changed
---

- **Provider catalog refreshed to the current omp/models.dev snapshots**: the review runner moves to omp `18.18.1` and mstar-harness `4.2.3` (engine + CLI + image pin), and the generated provider catalog is rebuilt from the `2026-11-06` models.dev snapshot plus omp `18.18.1`'s own bundled model registry. The vendored omp snapshot is now produced by `scripts/provider-catalog/extract-omp-snapshot.ts` (`bun run provider:catalog`), so a dependency bump refreshes the catalog in one command.
- **A provider's model list is complete**: the earlier extraction cap and the builtin representative-model cap are gone, a mixed-protocol provider (e.g. Command Code, OpenCode Go) ships one row per protocol with its full vocabulary, and the settings card's model disclosure shows the catalog's whole list instead of a truncated sample. A declaration may now carry up to 128 model ids (was 32), so a full provider vocabulary fits.

<!-- CN -->
- **提供方目录刷新到最新快照**：审查 runner 升级到 omp `18.18.1` 与 mstar-harness `4.2.3`（engine + CLI + 镜像 pin），生成的提供方目录改用 `2026-11-06` 的 models.dev 快照与 omp `18.18.1` 自带的模型注册表重建。omp 快照现在由 `scripts/provider-catalog/extract-omp-snapshot.ts` 生成（`bun run provider:catalog`），升级依赖后一条命令即可刷新目录。
- **提供方的模型列表完整呈现**：移除抽取阶段与内置提供方的代表模型上限；混合协议的提供方（如 Command Code、OpenCode Go）按协议拆成独立条目并携带完整模型表，设置页卡片的模型展开显示目录全量，而不是截断样本；单个声明可保存的模型 id 上限从 32 提高到 128，完整词表可以一次选中。
