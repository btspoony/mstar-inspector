---
category: Fixed
---

- **Recheck rounds can finish inside their budget**: the recheck seat now runs on its review tier's own wall clock (quick 300 s, default 540 s, deep 780 s) instead of a fixed 180 s that killed it mid-read, bounded by the outer guard less a 60 s publication tail. A lost round's status error now names the child's `abortReason`, its stderr tail or its exit code, so a timeout is attributable from D1 instead of a bare `unavailable`.

<!-- CN -->
- **复核轮次能在预算内完成**：复核席位改用所属审查档位的墙钟（quick 300 秒、default 540 秒、deep 780 秒），不再使用会在读取途中杀掉它的固定 180 秒，并以外层守卫减去 60 秒发布尾部为界。失败轮次的状态错误现在会记录子进程的 `abortReason`、stderr 尾部或退出码，超时可直接从 D1 归因，而不再只有一句 `unavailable`。
