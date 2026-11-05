---
category: Fixed
---

- **Recheck rounds can finish inside their budget**: the recheck seat now runs on its review tier's own wall clock (quick 300 s, default 600 s, deep 900 s) instead of a fixed 180 s that killed it mid-read; the outer guard less a 60 s publication tail caps that clock, so the effective caps are 300 s, 540 s and 780 s. A lost round's status error now names the child's `abortReason`, its stderr tail or its exit code, so a timeout is attributable from D1 instead of a bare `unavailable`.

<!-- CN -->
- **复核轮次能在预算内完成**：复核席位改用所属审查档位自身的墙钟（quick 300 秒、default 600 秒、deep 900 秒），不再使用会在读取途中杀掉它的固定 180 秒；该墙钟再以外层守卫减去 60 秒发布尾部为上限，因此实际生效的上限为 300 秒、540 秒和 780 秒。失败轮次的状态错误现在会记录子进程的 `abortReason`、stderr 尾部或退出码，超时可直接从 D1 归因，而不再只有一句 `unavailable`。
