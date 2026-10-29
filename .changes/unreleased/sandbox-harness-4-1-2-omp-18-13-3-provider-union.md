---
category: Changed
---

- **Review sandbox cohort moved to omp 18.13.3 / mstar-harness 4.1.2**: the image pin block (harness tag/ref and the preinstalled `@mstar-harness/cli`), the `@mstar-harness/engine` `^4.1.2` manifest range, the `@oh-my-pi/pi-coding-agent` pin, and the three regenerated lockfiles move together — the pin suite fails if the engine range, its lock resolution, the image CLI pin, or the derived skill version drift apart.
- **The provider picker now offers every omp API-key LLM provider**: a vendored snapshot of the omp catalog is merged into the generated provider catalog as `template` rows, so providers the models.dev snapshot lacks (Command Code, TypeSafe, Qianfan, SambaNova, LiteLLM, Ollama, vLLM, AIML API, CoreWeave, Fire Pass, Helmcode, Yolo-Auto, Qwen Portal and the two SingularityAPI gateways) are selectable without hand-writing a custom provider. Every added row is `template` tier, so the 19 built-in BYOK providers, their env-name allowlist and the models.yml synthesis are untouched.
- **`typesafe` joins the custom-provider protocol set**: a declaration may now name omp's TypeSafe wire, verified through the OpenAI-shaped Bearer models probe. Command Code is mixed-protocol per model, so it materializes as two rows — `commandcode` (Responses) and `commandcode-anthropic` (Messages).
- **A reachable endpoint no longer reads as a verified key**: Command Code's models endpoint answers 2xx without a valid key, so its declared rows now record `verified_status = "reachable"` and the settings row renders "endpoint reachable … — key not verified" instead of "verified …". Every provider whose probe can reject a bogus key keeps `ok`.
- **No operational change from this entry**: the change is pins, the generated catalog with its vendored input, protocol plumbing and tests — no image build, in-image replay, deployment, or smoke was run.

<!-- CN -->
- **审查沙箱的版本组合升至 omp 18.13.3 / mstar-harness 4.1.2**：镜像 pin 块（harness tag/ref 与预装的 `@mstar-harness/cli`）、`@mstar-harness/engine` `^4.1.2` 的 manifest 区间、`@oh-my-pi/pi-coding-agent` pin 与三个重新生成的 lock 一并移动——engine 区间、其 lock 解析、镜像 CLI pin 或派生的 skill 版本一旦不一致，pin 测试套件即失败。
- **提供方选择器现在覆盖 omp 支持的每一个 API-key LLM 提供方**：把 omp 目录的固化快照并入生成的提供方目录，作为 `template` 行，因此 models.dev 快照缺失的提供方（Command Code、TypeSafe、Qianfan、SambaNova、LiteLLM、Ollama、vLLM、AIML API、CoreWeave、Fire Pass、Helmcode、Yolo-Auto、Qwen Portal 以及两个 SingularityAPI 网关）无需手写自定义提供方即可选择。新增行全部为 `template` 层，19 个内置 BYOK 提供方、其 env-name 白名单与 models.yml 合成逻辑均未改变。
- **`typesafe` 加入自定义提供方协议集合**：声明现在可指定 omp 的 TypeSafe 协议，并通过 OpenAI 形态的 Bearer models 探测验证。Command Code 按模型混合协议，因此物化为两行——`commandcode`（Responses）与 `commandcode-anthropic`（Messages）。
- **端点可达不再等同于密钥已验证**：Command Code 的 models 端点无需有效密钥即返回 2xx，因此其声明行现在记录 `verified_status = "reachable"`，设置行显示「端点可达 … — 密钥未验证」而非「已验证 …」。探测能拒绝伪造密钥的提供方仍记录 `ok`。
- **本条目不涉及运维动作**：变更内容为 pin、带固化输入的生成目录、协议管线与测试——未执行镜像构建、镜像内回放、部署或 smoke。
