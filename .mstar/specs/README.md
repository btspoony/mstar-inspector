# Specs Index（仓库级跨迭代契约）

本目录 = **仓库级规范**：已锁定契约与历史权威。迭代内仍在演进的草案 → `../iterations/<id>/specs/`（如 `../iterations/v1.1-dashboard-platform/specs/`）。

| Document | Status | 用途 |
|----------|--------|------|
| [github-review-comment-mapping.md](github-review-comment-mapping.md) | **locked**（v0.3 Phase 1，2026-08-28） | GitHub 发表面 SSOT：`mstar.review/v1` 词表、COMMENT-only event 纪律、评论体结构 |
| [findings-schema.md](findings-schema.md) | **write-retired**（v0.3 起） | M1 `ReviewOutput` 历史契约 — 只读旧 D1 行；新写入权威 = harness `mstar.review/v1` |
| [review-lifecycle.md](review-lifecycle.md) | **locked**（021 Phase 1，2026-09-12：产品、架构及修订、写作审查均返回，PM lock 完成；尚未实现） | Review lifecycle 契约 SSOT（**tracked、自洽**）：产品要求 RL-1–RL-12 + §7 规范技术契约（存储 schema、recheck wire/validator、线程关联与 resolve、token 分权、发表/恢复顺序与重试矩阵、Check 身份与收口、reconciler、新 App 面）；发表面词表/event 纪律仍由 mapping spec 持有 |

Status 语义：

- **locked** — 跨迭代契约；变更需显式评审。
- **write-retired** — 仅历史读；新写入路径禁止以本文件为 SSOT。
- **in-review** — 跨迭代契约；产品范围与技术契约（architect 细化，normative 内容落在该文档 §7 本体，不寄存在 plan）已评审/冻结，PM lock 尚未完成；变更需显式评审。
