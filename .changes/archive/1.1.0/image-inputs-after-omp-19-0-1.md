---
category: Fixed
---

- **Sandbox image-inputs fingerprint after the omp 19.0.1 merge**: `#333` landed on a main that already included the review-budget image-input changes, but the merge kept the pre-merge `# image-inputs:` hash. The tree actually hashes to `4a561c8ff56113083dd6f9b3636b41e1`. Refreshing the marker lets the image rebuild gate pass and lets `wrangler deploy` see the omp 19.0.1 runner inputs.

<!-- CN -->
- **补记 omp 19.0.1 合入后的 sandbox image-inputs 指纹**：`#333` 合入时 main 已包含 review-budget 的镜像输入变更，但合并结果保留了合入前的 `# image-inputs:` 哈希。当前树的指纹是 `4a561c8ff56113083dd6f9b3636b41e1`。刷新该标记后，镜像重建门禁可通过，`wrangler deploy` 也会看到 omp 19.0.1 的 runner 输入。
