---
category: Fixed
---

- **Transformed credential echoes are removed from the retained review payload**: the write that stores a paid attempt's result now redacts every bounded transform of a credential the session held — raw, JSON-escaped, URL-encoded, base64, base64url and hex — inside the payload's string leaves. Structure, keys, `head_sha` and numeric/boolean leaves stay byte-identical; a payload carrying no credential serializes exactly as before.

<!-- CN -->
- **留存评审结果中的凭据变形回显已清除**：写入付费 attempt 结果的语句现在会在载荷的字符串叶子内清除会话所持凭据的有限变形集合——原文、JSON 转义、URL 编码、base64、base64url 与 hex。结构、键、`head_sha` 以及数值/布尔叶子保持逐字节不变；不含凭据的载荷仍与改动前逐字节相同。
