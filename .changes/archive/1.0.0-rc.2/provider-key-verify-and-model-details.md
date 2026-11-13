---
category: Fixed
---

- **Any configured provider can take another key**: the App settings add-key flow no longer refuses a `template`-tier or custom provider — its key is verified against that provider's own declaration (the base URL, protocol and model ids it was declared with) and appended to the same pool, so a provider with a single key no longer has to be re-declared to hold a second one. A provider the App never declared stays refused, with the copy naming it.
- **Model details fold away in the model picker**: the dialog now shows the search field, the model list and the save controls by default; an "Edit model details" control opens one model picker and that one model's fields, so selecting several models no longer fills the dialog with empty form rows. What is typed for one model survives switching to another.
- **Mixed-protocol providers are distinguishable in the provider picker**: a provider that ships one row per protocol (e.g. OpenCode Go, Command Code, ZenMux) now names the protocol in each row's label instead of showing identical entries.

<!-- CN -->
- **已配置的提供方都可以再添加密钥**：应用设置里的「添加密钥」不再拒绝 `template` 层或自定义提供方——密钥会按该提供方自己的声明（声明的 base URL、协议与模型 id）验证并追加到同一个密钥池，因此只有一个密钥的提供方不必重新声明就能存第二把。App 从未声明的提供方仍会被拒绝，并在提示中指名该提供方。
- **模型详情在模型选择器中折叠起来**：对话框默认只显示搜索框、模型列表与保存控件；「编辑模型详情」控件展开后显示一个模型选择器与该模型的字段，因此勾选多个模型不再让对话框被空表单行填满。为某个模型填写的内容在切换到另一个模型后仍然保留。
- **混合协议的提供方在选择器中可以区分**：按协议拆成多行的提供方（例如 OpenCode Go、Command Code、ZenMux）现在会在每一行的标签中带上协议，不再出现完全相同的条目。
