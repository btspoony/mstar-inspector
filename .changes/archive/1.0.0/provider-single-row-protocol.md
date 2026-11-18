---
category: Changed
---

- **One provider row per provider, with the protocol as a choice when you add it**: a provider that serves several API protocols no longer appears as separate providers ("Command Code", "Command Code — anthropic-messages", …). It is one row under its own name, and the add-provider form offers its protocols as a selectable option; picking one points the base URL field at that protocol's endpoint and the saved declaration carries that protocol's model list. A provider that serves one protocol looks and behaves exactly as before. An App still uses one protocol per provider, and an existing declaration keeps the protocol it was saved with — switching means removing the provider and adding it again, which removes its keys with it.
- **Model sizes are pre-filled for providers that had none**: Command Code, OpenCode Go, ZenMux and DeepInfra now carry the directory's context-window and max-output numbers for every model they serve, so the model dialog pre-fills those fields and saves without hand-typed sizes. A model the directory does not size still asks for the number, and a declaration pointed at your own endpoint keeps its hand-typed values instead of borrowing the vendor's.
- **A provider you already configured keeps working**: a declaration saved under one of the old per-protocol names is still listed under the provider's real name, shows the matching protocol's model list, and gets the same pre-filled sizes. Its stored endpoint, protocol and keys are untouched.

<!-- CN -->
- **一个 provider 一行，协议在添加时选择**：同时提供多种 API 协议的 provider 不再拆成多个 provider（「Command Code」「Command Code — anthropic-messages」……），而是以自己的名称显示一行，并在添加表单里把协议作为可选项；选中某个协议会把 base URL 指向该协议的端点，保存的声明携带该协议的模型列表。只提供一种协议的 provider 外观与行为完全不变。一个 App 对某个 provider 仍然只使用一种协议；已存在的声明保持它保存时的协议——要换协议需先移除再重新添加，密钥也会随声明一起移除。
- **此前没有尺寸的 provider 现在会预填模型尺寸**：Command Code、OpenCode Go、ZenMux、DeepInfra 现在带有目录中其每个模型的上下文窗口与最大输出数字，模型对话框会预填这些字段，无需手输即可保存。目录未收录尺寸的模型仍会要求填写；指向自有端点的声明继续使用你填写的值，不会借用厂商数字。
- **已经配置好的 provider 照常工作**：保存在旧的分协议名称下的声明仍会以 provider 的真实名称列出，显示匹配协议的模型列表，并获得同样的预填尺寸；其存储的端点、协议与密钥均不受影响。
