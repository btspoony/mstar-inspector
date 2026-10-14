---
category: Added
---

- **Several API keys per provider**: an App can now store multiple keys for the same provider from dashboard Settings — each row shows its own last4, verification state and updated time, and can be deleted individually (up to 8 keys per provider). Re-submitting a key that is already stored re-verifies that row in place, and an App with a single key behaves exactly as before.
- **The sandbox rotates across an App's keys with omp's own credential pool**: the review container receives the App's keys as an indexed pool and hands them to the review agent's own credential store, so a rejected or rate-limited key falls through to the next one, with per-credential backoff and session affinity, instead of the run being pinned to a single key.

<!-- CN -->
- **同一 provider 可保存多把 API Key**：应用现在可以在设置页为同一 provider 保存多把 key——每行显示自己的 last4、验证状态与更新时间，并可单独删除（每个 provider 最多 8 把）。重新提交已保存的 key 会就地重新验证该行；只有一把 key 的应用行为与之前完全一致。
- **沙箱用 omp 自带的凭据池在应用的多把 key 之间轮换**：审查容器以带索引的池接收该应用的 key 并交给审查 agent 自身的凭据存储，被拒绝或被限流的一把会退避并切到下一把（含逐凭据退避与会话亲和），而不是整次运行钉死在单把 key 上。
