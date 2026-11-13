---
category: Changed
---

- **Harness corpus moved onto the mstar 4.4.1 layout**: the tracked engineering corpus now splits three ways — `.agents/knowledge/` (experience and reusable patterns, moved verbatim from `.mstar/knowledge/` with history preserved), `.agents/adr/` (one decision per record, with its real alternatives and consequences, under `{bucket}/{class}/`), and `docs/specs/` (current-state contracts on the fixed `Scope` / `Current state` / `Invariants` / `Where it lives` / `Change obligations` skeleton). The old `.mstar/specs/` tree is gone; its normative content survives in the new specs, and its write-retired M1 review-output contract is preserved as an archived ADR.
- **`.mstarc` is now git-tracked** and declares the layout (`knowledge_dir`, `adr_dir`, `specs_dir`), so a clone resolves the same directories without per-host configuration.
- **Specs corrected against the code**: `webhook_path` is gone (migration `0038`; the webhook route is `/webhook/:workspaceId/:appId`), the platform `review_global` brake exists alongside the per-App switch, flag reads are point reads whose worker-side exceptions fail closed, the invite seat guard binds a named `:limit`, refusal copy carries the actual limit, and the pinned `@octokit/auth-app` is 8.3.1.

<!-- CN -->
- **Harness 语料迁入 mstar 4.4.1 布局**：受跟踪的工程语料拆成三层——`.agents/knowledge/`（工程经验与可复用范式，自 `.mstar/knowledge/` 原样迁移并保留历史）、`.agents/adr/`（一条记录一个决策，含真实备选与代价，按 `{bucket}/{class}/` 归档）、`docs/specs/`（当前状态契约，固定 `Scope` / `Current state` / `Invariants` / `Where it lives` / `Change obligations` 骨架）。旧 `.mstar/specs/` 树已删除；其规范内容在新 spec 中存续，已退役写入的 M1 review-output 契约保留为 archived ADR。
- **`.mstarc` 改为 git tracked**，声明目录布局（`knowledge_dir`、`adr_dir`、`specs_dir`），克隆后无需逐宿主配置即可解析到同一批目录。
- **spec 按代码校正**：`webhook_path` 已删除（迁移 `0038`；webhook 路由为 `/webhook/:workspaceId/:appId`）、平台级 `review_global` 总闸与 per-App 开关并存、flag 读取为点读且 worker 侧异常 fail-closed、邀请席位守卫绑定具名 `:limit`、拒绝文案携带实际限额、`@octokit/auth-app` pin 为 8.3.1。
