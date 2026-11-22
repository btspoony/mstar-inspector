---
category: Fixed
---

- Indexed the review threads whose line comment is not captured yet and drove the line-batch recovery selection from them, so the 15-minute lifecycle reconcile no longer walks every applied publication to find the few that still owe a line capture.

<!-- CN -->
- 为尚未捕获行评论的 review thread 添加部分索引，并让 line-batch recovery 从这些 thread 出发选择 publication，每 15 分钟的 lifecycle reconcile 不再遍历所有已 applied 的 publication。
