---
category: Fixed
---

- **Git-stage failures no longer echo a credential**: a failed diff, increment-diff or numstat step now removes the session's own secret values from the stderr tail it reports, not only credential-shaped text — so a credential that evades the pattern list cannot ride the failure message into the logs or the durable failure row.

<!-- CN -->
- **Git 阶段失败不再回显凭据**：diff、增量 diff 或 numstat 步骤失败时，上报的 stderr 尾部除了按形态抹除凭据样式的文本，还会精确抹除本次会话实际使用的密钥值——不匹配任何形态规则的凭据也不会随失败消息进入日志或持久化的失败记录。
