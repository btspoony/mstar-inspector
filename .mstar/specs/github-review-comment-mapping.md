# GitHub 审查评论映射（github-review-comment-mapping）

> **状态：** 已锁定仓库级产品契约（v0.3 Phase 1，2026-08-28；2026-09-12 经 021-review-lifecycle Review & Edit 显式评审修订：§3 收尾小节、§4 降级时序与发表后副作用、§5 Check Run 授权）。变更需显式评审。  
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
- 整体评论仍是每轮发表 SSOT；line-level comments 已由 v0.7（plan 18）交付——锚定契约见 knowledge `github-pr-review-line-comments.md`（本文件不重复其细节）。
- 总评可含**「上一轮收尾」小节**（021 起；产品契约 → `review-lifecycle.md` RL-8）：逐 finding 带类型化状态与证据；repeat 不计入新 tally；finding 处置（addressed）与线程实际 resolve 分开陈述；verdict/score 权威仍在 engine。
- `summary_md` 截断上限沿 M1：8000 字符。
- 模型正文进 GitHub / D1 前仍须 redact（SEC-02 不变）。

## 4. 时序与失败

沿 M1 / v0.2 compass（产品正确性，不改）：

1. 非空 `head_sha` 后 `findByIdempotencyKey` 命中 → 不审、不发、不写。
2. 解析 / `validateMstarReviewV1` 失败 → **降级发表**（v0.7 plan 18 起的已部署行为；2026-09-12 措辞对齐，非重新引入 retry）：best-effort 发表仅 summary 的降级评论并 ACK；不 insert 正常 review 行、不自动重跑付费 review、不进 DLQ。降级评论不是正常 review，不得作为收尾/resolve 依据。降级发表的结果是**类型化的（posted / not posted）并作为持久证据记录**（`review-lifecycle.md` §7.7/§7.9）——只有确认发表才可作为 Check `neutral` 的依据，发表失败必须如实记为失败而非“已降级”。
3. **先** GitHub 评论，**后** persist。评论失败不落库。
4. UNIQUE `(installation_id, owner, repo, pr_number, head_sha)` 不得削弱。
5. 线程 resolve 与 Check 收口都是**审查结果类副作用**：它们不得早于主评论发表成功，也不得因失败而回滚或伪造主评论/持久化结果（021 起；记录类分离、顺序、身份与失败恢复 → `review-lifecycle.md` RL-9/RL-10 + §7.7/§7.9）。例外有二：**不含任何 verdict / findings / disposition 的执行尝试记录**（attempt class）与**私有 pre-publication 恢复日志**（publication journal：完整 payload，但无 dashboard/insights/报告读出口，不构成“已发表结果”）都允许在发表前写入，用于崩溃恢复与失败/超时 Check 的诚实收口；跳过路径（paused / guard-held / 幂等 ack）不建立任何 check。`reviews` / `findings` / 生命周期行与线程关联只在**取得发表成功证据后**才应用（apply 幂等，重放不重复）。

## 5. 非目标

- 不把 GitHub `APPROVE` 当 `ship it` 的自动化合并许可。
- 不发 `REQUEST_CHANGES`。
- Check Run 由 `review-lifecycle.md`（021 交互裁决 D3；产品范围已评审）授权引入：conclusion 只表执行结果（正常发表=success / 确认降级发表=neutral / 执行失败、更新未确认、本地错误=failure），**结论由持久证据判定**而非代码路径（`review-lifecycle.md` §7.9 结论矩阵），永不映射或替代 `APPROVE` / `REQUEST_CHANGES`，checks 失败不阻塞 review 发表；line comments 已交付（见 §3 与 knowledge `github-pr-review-line-comments.md`）。
- 不打开现网 `REVIEW_ENABLED`（`2026-08-26-postdeploy-feedback` R2：kill-switch ships OFF）。
