---
category: Fixed
---

- **A provider refusal that means "the account is out of credit" no longer reads as a broken provider.** Key verification classified only 401/403 as `invalid_key` and turned every other non-2xx into `unexpected_response`, so a spent account (402, or a 4xx whose error body names credits/quota/billing) told the operator "The provider returned an unexpected response — nothing was stored". The three verify paths — built-in models endpoint, built-in probe and custom-provider probe — now share ONE classifier: 401/403 stay `invalid_key`, 402 and any other non-2xx whose body carries a credit/quota/billing signal become `quota_exhausted`, and everything else (a throttled 429 included) stays `unexpected_response`. That reason reaches the settings form as its own structured value, and its copy now says the account is out of quota or credit, that nothing was stored, and that the key itself may still be valid — in both locales. The body read happens only on the failure path and stops after the first 512 bytes.

<!-- CN -->
- **表示“账户余额或额度耗尽”的 provider 拒绝，不再被报告成 provider 异常。** 密钥验证此前只把 401/403 归类为 `invalid_key`，其余所有非 2xx 一律变成 `unexpected_response`，因此账户额度耗尽（402，或错误体指明 credits/quota/billing 的 4xx）会告诉操作者“provider 返回了意外响应 — 未存储任何内容”。内置 models 端点、内置探活与自定义 provider 探活这三条验证路径现在共用一个分类器：401/403 仍为 `invalid_key`，402 以及任何错误体带额度/配额/账单信号的非 2xx 变为 `quota_exhausted`，其余情况（包括被限流的 429）仍为 `unexpected_response`。该原因以其独立的结构化值到达设置表单，文案会说明 provider 账户额度或余额已耗尽、未存储任何内容、且密钥本身可能仍然有效（中英双语）。错误体只在失败路径上读取，且最多读前 512 字节。
