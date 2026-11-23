---
category: Fixed
---

- **Shared App reads are scoped to the calling workspace.** A workspace that uses a shared App but does not own it no longer sees the App's installations, provider keys, model chains or custom providers on the bot page, and its webhook deliveries (rows, repository and event filters, and the delivery summary) list only repositories it has a live target for; the Apps list health column uses the same scoped summary.

<!-- CN -->
- **共享 App 的读取按调用方工作区限定。** 使用但不拥有共享 App 的工作区，在 bot 页面不再看到该 App 的安装、提供方密钥、模型链或自定义提供方；其 webhook 投递记录（列表、仓库与事件筛选项、投递摘要）只包含该工作区存在有效 target 的仓库；App 列表的健康状态列使用同样限定后的摘要。
