---
category: Changed
---

- **Review concurrency limits re-scaled**: the platform quota now defaults to and accepts up to **256**, each workspace is bounded by its own maximum of **32**, and the default admission therefore rises from **16 to 32 per workspace** (Cloudflare Queues delivers at most 250 at once; that aggregate is only reachable across at least eight workspaces at their own maximum). The workspace settings card no longer displays or returns the platform cap, and a workspace write is validated only against its own range (1..32) — the platform quota applies at admission, so no tenant request can reveal it by being refused. On upgrade, any workspace that stored a value above **32** under the previous 1..64 range is lowered to **32** by migration `0043_workspace_concurrency_bound.sql`, which records each previous value in `workspace_concurrency_clamp_0043`.

<!-- CN -->
- **审查并发上限调整**：平台配额默认值及可设置上限为 **256**，每个工作区受自身上限 **32** 约束，因此默认准入由**每个工作区 16 提升至 32**（Cloudflare Queues 同时最多投递 250 个，该总量只能由至少 8 个工作区各自跑满 32 聚合达到）。工作区设置不再显示或返回平台上限，写入只按自身范围（1..32）校验——平台配额在准入时生效，因此任何租户请求都不会因被拒绝而暴露它。升级时，此前在 1..64 范围内存储了大于 **32** 的工作区会被迁移 `0043_workspace_concurrency_bound.sql` 下调为 **32**，每个旧值都记录在 `workspace_concurrency_clamp_0043` 中。
