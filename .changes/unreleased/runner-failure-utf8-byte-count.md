---
category: Fixed
---

- **The durable runner-failure text now reports stdout in real UTF-8 bytes.** `runnerFailureDetail` printed `String.length` with a `B` suffix, so a run that emitted non-ASCII output under-reported its size — one multi-byte character counted as one. The count now matches the sibling git-stage detail, and an empty stdout still reads `0B`.

<!-- CN -->
- **持久化的 runner 失败文本现在按真实 UTF-8 字节数报告 stdout。** `runnerFailureDetail` 之前用 `String.length` 加 `B` 后缀，因此输出过非 ASCII 内容的 run 会被低估——一个多字节字符只算作 1。现在与相邻的 git 阶段详情一致，统计方式相同；stdout 为空时仍显示 `0B`。
