---
category: Fixed
---

- **Review conversations can now close**: a recheck round binds each prior finding's review thread before it captures that thread's discussion, so an association whose original send response was lost — and therefore had no stored thread id — can still earn a verified resolution instead of staying open forever. The pass is bounded per review round, and any association the bound could not reach stays queued for a later round. The created line review's comment ids are now read back from the review's own comments connection, because GitHub's create-review response carries no comments array — without them the posted comments could never be matched back to their findings. A failed read leaves the capture unconfirmed rather than failing the review, so nothing is fabricated.

<!-- CN -->
- **评审会话现在可以收尾**：复查轮会在抓取讨论之前，先绑定每条既有发现对应的评审会话；因此即使最初的发送响应丢失、没有存下会话 id，该对应关系也能获得经过验证的解决结果，而不是一直保持未关闭。该过程每轮审查有上限，未能覆盖到的对应关系会留待后续轮次。新建行内评审的评论 ID 改为从该评审自身的 comments 连接读回——GitHub 的 create-review 响应不带 comments 数组，没有这些 ID 就无法把已发布的评论匹配回对应发现。读取失败只会让捕获保持未确认，不会让整轮审查失败，也不会凭空编造结果。
