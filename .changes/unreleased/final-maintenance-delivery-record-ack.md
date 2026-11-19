---
category: Fixed
---

- Keep a final maintenance-window delivery unacknowledged when its failure record cannot be saved, allowing queue failure handling and dead-letter routing instead of silently losing the review.

<!-- CN -->
- 维护窗口内最后一次投递的失败记录无法保存时，不再确认消息，让队列执行失败处理及死信路由，避免审查任务静默丢失。
