---
category: Fixed
---

- **Recovery timeout budgets:** Reuse the existing 500 ms terminal Check-update floor for reconciler request timeouts, and derive run minima from minimum request counts. Admin → Runtime rejects smaller values; stored invalid values safely fall back to unchanged defaults.

<!-- CN -->
- **恢复超时预算：** reconciler 单请求超时复用现有 Check 终态更新的 500 毫秒下限，整轮预算下限按最少请求数推导。Admin → Runtime 拒绝更小值，已存无效值安全回退至不变的默认值。
