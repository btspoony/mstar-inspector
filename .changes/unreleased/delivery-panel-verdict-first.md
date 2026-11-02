---
category: Fixed
---

- **App detail's recent-deliveries panel leads with review verdicts**: the panel was a raw last-5 timeline, so bypass traffic (`check_run`, `ping`) — orders of magnitude more frequent than review traffic and always `ignored` — filled every row and made a healthy App look stuck on "Ignored". It now ranks by the same outcome tier as the Apps list health column (`ok` / `paused` / `rejected` ahead of `ignored`), newest first within each tier; stored rows are untouched, and an App whose only traffic is bypass still lists its newest rows. The heading copy stops claiming "the last 5 deliveries".

<!-- CN -->
- **应用详情页「最近投递」面板以审查结论优先**：该面板原为原始「最近 5 条」时间线，而旁路事件（`check_run`、`ping`）比审查流量高几个数量级且恒为「已忽略」，五行全被它占满，健康的 App 也看起来卡在「已忽略」。现在按与应用列表健康列相同的结论分层排序（`ok` / `paused` / `rejected` 优先于 `ignored`），层内仍按时间从新到旧；存储行不变，仅有旁路流量的 App 也照常列出最新几条。面板说明文案不再声称「最近 5 次投递」。
