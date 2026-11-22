---
category: Fixed
---

- **Recovery lane headroom:** Reject lifecycle budgets whose publication allowance plus thread-operation allowance exceeds the run total, so publication work cannot consume the thread lane's admission headroom. Stored invalid combinations fall back to defaults with key-only diagnostics.

<!-- CN -->
- **恢复通道余量：** 拒绝发布请求配额与线程操作配额之和超过整轮请求数的生命周期预算，为线程通道保留准入余量。已存储的无效组合回退默认值，诊断仅包含键名。
