---
category: Added
---

- **Per-key usage action in App settings**: every stored model-provider key row now carries a usage action that asks the provider's own quota endpoint with that key and answers, in one dialog, both whether the key is still accepted and what remains of its allowance — a window's remaining share with its reset time, or an account-wide balance, labelled as shared so several keys drawing on one pool do not read as separate allowances. The covered families are those whose quota endpoint accepts a plain API key: Command Code, OpenCode Go, Z.AI/Zhipu, the MiniMax token plan, ClinePass, Synthetic, Umans, Charm Hyper, and Kimi for coding. A provider whose usage surface is OAuth-only is not covered and shows no usage action, and neither does a provider with no quota endpoint. The dialog probes when it opens, and its refresh control probes the provider again — nothing is cached, so every look reports the key's state at that moment.

<!-- CN -->
- **应用设置中的单 key 用量操作**：每一行已存储的模型提供方密钥新增「用量」操作，用该密钥请求提供方自己的配额端点，并在一个对话框中同时回答两件事——该密钥是否仍被接受，以及额度还剩多少：窗口型的剩余占比与重置时间，或账户级余额（标记为共享，避免多把 key 共用同一额度池时被误读为各自独立的额度）。覆盖范围是那些配额端点接受纯 API Key 的族：Command Code、OpenCode Go、Z.AI/智谱、MiniMax token plan、ClinePass、Synthetic、Umans、Charm Hyper 与 Kimi for coding。仅支持 OAuth 的用量面不在覆盖范围内，不显示用量操作；没有配额端点的提供方同样不显示。对话框在打开时探测，其「刷新」控件会再次请求提供方——不做缓存，每次查看反映的都是该时刻密钥的状态。
