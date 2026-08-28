# GitHub 审查评论映射（github-review-comment-mapping）

> **状态：** 已锁定仓库级产品契约（v0.3 Phase 1，2026-08-28）。变更需显式评审。  
> **跨迭代：** 是 — 云端审查发表到 GitHub 的词表与 event 纪律，后续 plan 继续消费。  
> **SSOT：** 本文件（GitHub 发表面）；审查 JSON 权威形状 = harness `mstar.review/v1`（engine `validateMstarReviewV1` / `synthesizeReview`）。  
> **历史写入契约：** `.mstar/specs/findings-schema.md`（M1 `ReviewOutput`）— **只读旧行**；v0.3 起 **禁止**作为 persist/发表权威。

## 1. 权威词表（harness，禁止分叉）

| 面 | 合法值 | 非法（inspector M1，persist 必须拒） |
|----|--------|--------------------------------------|
| verdict | `ship it` \| `needs fixes` \| `blocked` | `comment` \| `request_changes` \| `approve` |
| finding class | `must-fix` \| `should-fix` \| `nit` | `critical` \| `warning` \| `suggestion` \| `info` |

`score_pct` 只作展示，**不得**覆盖 verdict。公式与 tally 键以 engine `computePrTally` 为准，inspector 不另发明。

## 2. GitHub Review `event` 映射（锁定）

对齐 mstar-harness 3.5.0 `skills/mstar-audit/references/pr-review.md` § Comment posting：

> `event` is the fixed literal `COMMENT` (**never** `APPROVE`, **never** `REQUEST_CHANGES`).

| `mstar.review/v1` verdict | GitHub `pulls.createReview` `event` | 说明 |
|---------------------------|--------------------------------------|------|
| `ship it` | `COMMENT` | **不**发 `APPROVE`（advisory；分数再高也不 APPROVE） |
| `needs fixes` | `COMMENT` | |
| `blocked` | `COMMENT` | **不**发 `REQUEST_CHANGES`（grill-me + harness 同一纪律） |

Issues Comments API（无 `event` 字段）同样满足本表：不得改走会发出 `APPROVE` / `REQUEST_CHANGES` 的路径。

v0.3 发表面允许二者之一（architect 锁实现，产品只锁结果）：

1. **保持** postdeploy T5：Issues comment **单线程 upsert**（marker `<!-- mstar-inspector:review:v1 round=N -->`）；或
2. `pulls.createReview` 且 `event` **字面量 `COMMENT`**，并仍保证同 PR **不**每轮新建一条重复评论。

**禁止：** 回退到「每轮 `pulls.createReview` 一条新 Review」的重复评论。

## 3. 评论体（用户可见）

- 正文结构对齐 `/amazing-pr-review` Stage 3 报告：verdict 行、tally（must-fix / should-fix / nit / unverified）、findings 按 merge class 列出。
- Verdict **原文**写入正文（`ship it` / `needs fixes` / `blocked`），不得再写成 M1 `approve` / `comment`。
- Findings 的 class 原文写入（`must-fix` 等），不得改写成 M1 severity。
- 仍只发**整体**评论；**零** line-level review comments（roadmap M3，本契约不开放）。
- `summary_md` 截断上限沿 M1：8000 字符。
- 模型正文进 GitHub / D1 前仍须 redact（SEC-02 不变）。

## 4. 时序与失败

沿 M1 / v0.2 compass（产品正确性，不改）：

1. 非空 `head_sha` 后 `findByIdempotencyKey` 命中 → 不审、不发、不写。
2. 解析 / `validateMstarReviewV1` 失败 → **不发、不 insert**，retry/DLQ。
3. **先** GitHub 评论，**后** persist。评论失败不落库。
4. UNIQUE `(installation_id, owner, repo, pr_number, head_sha)` 不得削弱。

## 5. 非目标

- 不把 GitHub `APPROVE` 当 `ship it` 的自动化合并许可。
- 不发 `REQUEST_CHANGES`。
- 不在本契约引入 line comments / Check Run。
- 不打开现网 `REVIEW_ENABLED`（ops residual R2）。
