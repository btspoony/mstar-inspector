---
category: Fixed
---

- **A malformed refusal param no longer prints `[object Object]` on the settings page.** Both readers of a mapped 400 body — the shared settings/pinned-op resolver and the key-verify path — cast `params` on a bare `typeof === "object"` check, so a server body whose param value was an object or an array interpolated `String(value)` into the localized sentence (`[object Object] is not a supported provider…`) or left `{provider}` bare. A param is now accepted only when every value is a string or a number; otherwise the keyed face is refused and the reader's own generic copy renders, never the raw JSON body.

<!-- CN -->
- **参数异常的拒绝响应不再在设置页打印 `[object Object]`。** 映射型 400 响应体的两个读取点——共享的设置/固定项操作解析器与密钥校验路径——此前仅凭 `typeof === "object"` 就把 `params` 断言成 `Record<string, string | number>`，于是当服务端返回的参数值是对象或数组时，本地化句子会把 `String(value)` 插进去（`[object Object] 不是受支持的 provider…`），或留下未填充的 `{provider}`。现在只有每个值都是字符串或数字时才接受该参数表；否则该读取点放弃 keyed 文案，改渲染自己的通用提示，绝不回落到原始 JSON 响应体。
