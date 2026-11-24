---
category: Fixed
---

- **Sandbox image-inputs fingerprint after the harness 4.8.2 merge**: `#346` landed on a main that already included the `#347` comment-cleanup image-input changes, but the merge kept the pre-merge `# image-inputs:` hash. The tree actually hashes to `79603ea40080b0644d37e71929b630d6`. Refreshing the marker lets the image rebuild gate pass and lets `wrangler deploy` see the harness 4.8.2 runner inputs.

<!-- CN -->
- **补记 harness 4.8.2 合入后的 sandbox image-inputs 指纹**：`#346` 合入时 main 已包含 `#347` comment-cleanup 的镜像输入变更，但合并结果保留了合入前的 `# image-inputs:` 哈希。当前树的指纹是 `79603ea40080b0644d37e71929b630d6`。刷新该标记后，镜像重建门禁可通过，`wrangler deploy` 也会看到 harness 4.8.2 的 runner 输入。
