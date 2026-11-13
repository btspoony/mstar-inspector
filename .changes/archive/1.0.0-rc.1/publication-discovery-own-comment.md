---
category: Fixed
---

- **A lost publication response now recovers instead of backing off**: when a review comment's send ends with an unknown outcome, recovery re-reads the PR conversation looking for the comment it may have posted. That read filtered out the Inspector's own publication comments — exactly the comment being looked for — so every such attempt reported "no exact publication match" and backed off until the attempt cap, leaving a published comment unrecorded for operator inspection. The read can now opt in per call, and only this recovery lane does; the discussion digest and the model context keep their existing filtered domain and are byte-identical for an unchanged PR.

<!-- CN -->
- **发布响应丢失时改为正常恢复，不再一路退避**：当审查评论的发送结果未知时，恢复流程会重读 PR 会话，寻找可能已经发出的那条评论。该读取此前会过滤掉 Inspector 自己发布的评论——恰恰就是它要找的那条——于是每次尝试都报告「未找到完全匹配的发布」并持续退避直至尝试上限，已发布的评论因此停留在未记录状态，只能由运维人工排查。现在该读取可按调用选择包含自身发布，且只有这条恢复通道这样做；讨论摘要与模型上下文的域保持不变，未变更的 PR 在改动前后摘要逐字节相同。
