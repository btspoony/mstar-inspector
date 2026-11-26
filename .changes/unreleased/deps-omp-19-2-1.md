---
category: Changed
---

- **omp SDK 19.2.1 across root and runner**: the root and `packages/runner` manifests both move `@oh-my-pi/pi-coding-agent` from `19.2.0` to `19.2.1`, and both lockfiles re-resolve so the entire `@oh-my-pi/*` family stays on a single 19.2.1 copy. The harness engine, CLI and image ref stay on 4.9.0. 19.2.1's advertised breaking change (several internal utility exports were removed from the coding-agent package) is not used by this repo's session options or review runner, so no runtime contract change is included. The vendored provider-catalog snapshots are re-extracted from the installed `@oh-my-pi/pi-catalog` 19.2.1; the provider and model vocabulary is unchanged, only the recorded source version and extraction date move. The `# image-inputs:` fingerprint is refreshed in the same commit because `packages/runner/package.json` and its lockfile are image inputs.

<!-- CN -->
- **omp SDK 升至 19.2.1（根与 runner）**：根目录与 `packages/runner` 的 `@oh-my-pi/pi-coding-agent` pin 均从 `19.2.0` 升到 `19.2.1`，两个 lock 重新解析，整组 `@oh-my-pi/*` 保持单一的 19.2.1 副本。harness engine、CLI 与镜像 ref 仍停留在 4.9.0。19.2.1 声明的破坏性变更（coding-agent 包移除了若干内部 utility 导出）未被本仓库的 session 选项或 review runner 使用，因此没有运行时契约改动。从已安装的 `@oh-my-pi/pi-catalog` 19.2.1 重新提取了 vendored provider-catalog 快照；提供方与模型词汇未变，仅记录的源版本与提取日期更新。同一提交中刷新了 `# image-inputs:` 指纹，因为 `packages/runner/package.json` 及其 lock 是镜像输入。
