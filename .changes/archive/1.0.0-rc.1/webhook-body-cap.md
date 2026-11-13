---
category: Changed
---

- **Webhook body cap enforced on streamed bytes**: the 413 request-size cap no longer trusts the client-supplied `content-length` header — oversized bodies are rejected mid-stream the moment the limit is exceeded, even when the header is missing or lying.

<!-- CN -->
- **Webhook 体积上限按流式字节生效**：413 请求体积上限不再信任客户端提供的 `content-length` 头——即使该头缺失或造假，请求体也会在流式读取超过上限的瞬间被拒绝。
