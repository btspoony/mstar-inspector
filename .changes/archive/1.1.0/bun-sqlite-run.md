---
category: Changed
---

- Switched the test helpers, test suites and benchmark scripts from `bun:sqlite`'s deprecated `Database.exec` alias to `Database.run`. Test and tooling only; no shipped code changes.

<!-- CN -->
- 测试辅助、测试套件与基准脚本中的 `bun:sqlite` 调用从已弃用的 `Database.exec` 别名改为 `Database.run`。仅涉及测试与工具，不影响发布代码。
