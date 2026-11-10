---
category: Fixed
---

- **A Check whose begin budget expires while its run is being attached no longer waits out the execution deadline.** The consumer's 2 s bound can elapse between the create and the attach write; the created run was then attached and the handle returned into a promise nobody awaited, leaving the attempt on a live 900 s lease that nothing could terminalize. Measured on production before this change: 108 of 269 attempts closed at `terminal - created = 904–965 s`, i.e. the deadline, with nothing in the 615–900 s range. The attempt is now released to recovery like the pre-attach case — the run id is already persisted, so the reconciler adopts that run within about a minute instead of at the deadline.

<!-- CN -->
- **begin 预算在 attach 期间耗尽时，Check 不再等到执行期限。** consumer 的 2 秒预算可能在 create 与 attach 写之间耗尽，于是已创建的 run 被 attach、handle 却被交回一个无人等待的 promise，attempt 便挂在一份 900 秒的活租约上，无人能收口。改动前的生产数据：269 次 attempt 中有 108 次落在 `terminal - created = 904–965 秒`（即执行期限），615–900 秒区间为空。现在与 attach 之前的情形一样交回 recovery——run id 已持久化，reconciler 会直接接管该 run，约一分钟内收口，而不是等到期限。
