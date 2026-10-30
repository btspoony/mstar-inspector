---
category: Changed
---

- **Provider keys are verified without inference**: every dashboard key check is a `GET` against the provider's models/usage/identity endpoint — the remaining 1-token chat probes are gone. `kilo`, `zai` and `umans` are now `unsupported` (console-managed) because neither omp nor the provider documents a key-rejecting models/usage endpoint; nothing is stored on a failed check.
- **The built-in verify table is aligned with omp 18.13.3**: a new vendored snapshot (`scripts/provider-catalog/omp-provider-verify.json`) records every `validate "models-endpoint"` entry (28 endpoints, source version and extraction date in its header) and the built-in specs derive from it through the existing provider-id alias map.
- **Custom provider probes are normalized and identify themselves**: the declared base URL is resolved with `new URL()` (a base ending in `/`, `/v1`, `/v1/` or `/models` yields exactly one `…/models` probe; a carried query/fragment is dropped; an unparseable URL reports `unreachable` instead of throwing), and every verify request now sends `Accept: application/json` plus an explicit `User-Agent` — the common spurious "could not be reached" failures are gone.
- **Custom providers get the multi-key pool the other faces already had**: a new authenticated settings action appends a key to an existing custom declaration (verify-first against its stored endpoint, no declaration rewrite, the endpoint lock and the 8-key cap intact), with an "Add key" action and the same masked per-key rows on the custom-provider row.

<!-- CN -->
- **Provider 密钥验证不再产生推理调用**：dashboard 的每次密钥检查都是对 provider 的 models/usage/identity 端点发起 `GET`，剩余的 1-token chat 探测已移除。`kilo`、`zai`、`umans` 改为 `unsupported`（由控制台管理），因为 omp 与 provider 文档都没有可用于拒绝错误密钥的 models/usage 端点；验证失败不写入任何内容。
- **内置验证表与 omp 18.13.3 对齐**：新增 vendored 快照 `scripts/provider-catalog/omp-provider-verify.json`，记录全部 `validate "models-endpoint"` 条目（28 个端点，源版本与提取日期写在其头部），内置规格通过既有的 provider id 别名映射从该数据派生。
- **自定义 provider 探测 URL 归一化并显式声明身份**：声明的 base URL 用 `new URL()` 解析（以 `/`、`/v1`、`/v1/` 或 `/models` 结尾都得到唯一的 `…/models` 探测地址；携带的 query/fragment 被丢弃；无法解析时返回 `unreachable` 而不是抛错），所有验证请求现在都发送 `Accept: application/json` 与显式 `User-Agent`，常见的「无法连接」误报随之消失。
- **自定义 provider 获得其他入口已有的多密钥池**：新增需要身份验证的设置操作，向已存在的自定义声明追加密钥（先按已存储端点验证、不改写声明，端点锁与 8 把密钥上限保持有效），自定义 provider 行上新增「添加密钥」操作，并渲染与其他入口一致的掩码逐密钥行。
