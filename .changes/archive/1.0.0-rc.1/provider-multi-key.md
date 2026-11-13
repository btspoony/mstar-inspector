---
category: Added
---

- **Several API keys per provider**: an App can now store multiple keys for the same provider from dashboard Settings — each row shows its own last4, verification state and updated time, and can be deleted individually (up to 8 keys per provider). Re-submitting a key that is already stored re-verifies that row in place, and an App with a single key behaves exactly as before.
- **The sandbox rotates across an App's keys with omp's own credential pool**: the review container receives the App's keys over the runner's stdin pipe and hands them to the review agent's own credential store, so a rejected or rate-limited key falls through to the next one, with per-credential backoff and session affinity, instead of the run being pinned to a single key.
- **Upgrade note for the per-key model evidence**: migration `0025` deliberately does not carry the previous aggregate model cache forward (it cannot say which key contributed which model). An App whose provider was verified before the upgrade shows the probe-only face — an empty model dropdown — until **every** current key of that provider is re-verified and the per-key reports share at least one model, because the offered set is the intersection over the current pool. The loss is self-healing and touches only that rebuildable derived cache: credentials, provider declarations, model chains and seats are untouched.

<!-- CN -->
- **同一 provider 可保存多把 API Key**：应用现在可以在设置页为同一 provider 保存多把 key——每行显示自己的 last4、验证状态与更新时间，并可单独删除（每个 provider 最多 8 把）。重新提交已保存的 key 会就地重新验证该行；只有一把 key 的应用行为与之前完全一致。
- **沙箱用 omp 自带的凭据池在应用的多把 key 之间轮换**：审查容器通过 runner 的 stdin 管道接收该应用的 key 并交给审查 agent 自身的凭据存储，被拒绝或被限流的一把会退避并切到下一把（含逐凭据退避与会话亲和），而不是整次运行钉死在单把 key 上。
- **按 key 模型证据的升级说明**：迁移 `0025` 有意不搬运旧的聚合模型缓存（旧数据无法说明是哪个 key 贡献了哪个模型）。升级前验证过 provider 的应用会看到探测面——模型下拉为空——直到该 provider **每一把**当前 key 都重新验证过，且各 key 的报告至少共享一个模型（可选集合是当前 key 池的交集）。该丢失会自愈，且只涉及可重建的派生缓存：凭据、provider 声明、模型链与席位均不受影响。
