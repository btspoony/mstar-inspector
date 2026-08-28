# Specs Index（仓库级跨迭代契约）

本目录 = **仓库级规范**：已锁定契约与历史权威。迭代内仍在演进的草案 → `../iterations/<id>/specs/`（如 `../iterations/v0.3/specs/`）。

| Document | Status | 用途 |
|----------|--------|------|
| [github-review-comment-mapping.md](github-review-comment-mapping.md) | **locked**（v0.3 Phase 1，2026-08-28） | GitHub 发表面 SSOT：`mstar.review/v1` 词表、COMMENT-only event 纪律、评论体结构 |
| [findings-schema.md](findings-schema.md) | **write-retired**（v0.3 起） | M1 `ReviewOutput` 历史契约 — 只读旧 D1 行；新写入权威 = harness `mstar.review/v1` |

Status 语义：

- **locked** — 跨迭代契约；变更需显式评审。
- **write-retired** — 仅历史读；新写入路径禁止以本文件为 SSOT。
