---
category: Changed
---

- **Model sizes come from the catalog, not a hand-typed ritual**: the model picker pre-fills each model's context window and max token count from the provider catalog's snapshot. A value the operator leaves untouched is labelled with its snapshot and is not posted back as an override; only a model the catalog does not cover still asks for both sizes. A save whose sizes all come from the catalog stores no override field.
- **The size copy now states the effect, not a disclaimer**: the required-size line says what the two numbers set (when context gets compacted, how long one reply can run), and the incomplete-declaration note names the missing facts and the next step. The "we do not guess" wording is gone from both locales.
- **The sandbox image no longer declares a provider or a model**: the image registry is build inputs only. The per-review `models.yml` is synthesized from the App's own provider declarations, and a built-in provider resolves from the runtime's own catalog. The test fixture that had been shipped as a product capability host is gone; an App's model chain must name a provider it actually configured.
- **A chain that still names the retired `ark-plan` provider now says what to do**: it fails with "the ark-plan provider was removed — set the model chain to `ark/...`" instead of a bare "no configured key". Verified-model evidence the previous release wrote under the alias still reads as the `ark` pool's own, so that App's settings list does not silently empty. No data rewrite is performed: the runner declares no provider for the old prefix, so the selector itself must change (the review comment on the change carries the one-line upgrade step).

<!-- CN -->
- **模型尺寸来自目录，不再靠手工填写**：模型选择器会用提供方目录快照预填每个模型的上下文窗口与最大 token 数。操作者未改动的值会标注其快照来源，且不会作为覆盖写回；只有目录未收录的模型仍需填写这两项。若某项尺寸全部来自目录，保存时不会存储该覆盖字段。
- **尺寸文案改为说明影响，而不是免责声明**：必填说明现在讲清这两个数值的作用（上下文何时被压缩、单次回复最长能跑多久），未完整声明的提示则点名缺失项与下一步。两个语言里都不再出现「我们不会猜测」。
- **沙箱镜像不再声明 provider 或模型**：镜像 registry 只剩构建输入。每次审查的 `models.yml` 由 App 自己的 provider 声明合成，内置 provider 由运行时自身的目录解析。此前被当作产品能力塞进去的测试夹具已删除；App 的模型链必须写明它实际配置过的 provider。
- **仍写着 `ark-plan` 的模型链会直接给出下一步**：失败信息变为「the ark-plan provider was removed — set the model chain to `ark/...`」，不再是笼统的「没有配置 key」。上一版本写在别名下的模型校验证据仍按 `ark` 池读出，设置页的模型列表不会静默清空。不做数据改写：运行时不再为该前缀声明 provider，选择器本身必须改（升级步骤见本次变更的 review 评论）。
