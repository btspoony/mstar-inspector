---
category: Fixed
---

- **Every failed recheck round names its cause**: a single row's `error` no longer short-circuits the seat's attribution, and a thrown seat rejection keeps the settled child's abort reason, stderr tail and exit code, so both failure exits report the same chain (`structuredOutput.error` → `abortReason` → `error` → stderr tail → exit code) instead of a bare seat-failed text.

<!-- CN -->
- **每一次失败的复核轮次都会说明原因**：单行的 `error` 不再越过席位归因链，被拒绝的席位调用也会保留已结束子进程的中止原因、stderr 尾部与退出码；两条失败出口共用同一条归因链（`structuredOutput.error` → `abortReason` → `error` → stderr 尾部 → 退出码），不再只给出一句 seat-failed 文本。
