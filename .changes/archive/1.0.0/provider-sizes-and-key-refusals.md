---
category: Fixed
---

- **A provider with no catalog row no longer implies its sizes are unsavable**: the model dialog showed two blank size fields under a "these sizes come from the catalog snapshot" line for every provider the vendor directory does not describe, which read as "the catalog has not loaded" rather than "there is nothing to load". It now states that the provider has no catalog sizes and that a blank field saves as unstated, with the runtime's own defaults applying. A partial set already saved as-is — the server skips an absent size before any shape check — so neither field was ever a precondition; a test now pins that, one field at a time.
- **The add-key dialog says what actually failed**: every non-2xx answer and every unparsable body used to collapse into one "unexpected response" sentence, so a permission problem, a retired App, a shared bot and a provider refusal all read the same. The dialog now resolves the status first and the body second: 400 keeps the provider's own per-reason faces, 403 separates a shared bot from a non-manager, 404/409/429 name their own cause, and 500 splits a missing `DASHBOARD_ENCRYPTION_KEY` from a rejected write. None of the new sentences echo the key, the response body or the status code.

<!-- CN -->
- **没有目录行的提供方不再显得尺寸不可保存**：对厂商目录未收录的每个提供方，模型对话框此前会在「这些数值来自模型目录快照」一行下面显示两个空白尺寸字段，读起来像「目录还没加载」，而不是「本来就没有可加载的」。现在它明确说明该提供方没有目录尺寸、留空即按未声明保存、运行时使用自身默认值。部分填写本来就能原样保存——服务端在任何形状校验之前就跳过未填写的尺寸——两个字段从来都不是保存前置条件；现在用测试按字段逐个固定这一行为。
- **添加密钥对话框会说明实际失败原因**：此前所有非 2xx 响应和所有无法解析的响应体都收敛成同一句「意外的响应」，于是权限问题、已退役的 App、共享机器人与提供方拒绝读起来完全一样。现在先看状态、再看响应体：400 保留提供方自身按原因给出的文案，403 区分共享机器人与非管理员，404/409/429 各自说明原因，500 区分缺少 `DASHBOARD_ENCRYPTION_KEY` 与写库被拒。新增文案都不回显密钥、响应体或状态码。
