---
category: Changed
---

- **Engine 4.0.2 adopted**: `@mstar-harness/engine` 4.0.1 → 4.0.2, which adds the neutral fourth PR-review verdict `incomplete` and the engine-emitted tally `band`; both review output schemas now declare them, so a valid deep review yield is no longer refused for carrying them.
- **`incomplete` verdict with a mandatory fact**: a PR review can now report `incomplete` together with `{ reason, unscanned }` — the declared cause and the scope the run never reached (an empty scope list is legal). The fact is required exactly by that verdict, rejected on every other verdict, and a provided tally must echo it unchanged; both the deep parent-session yield schema and the envelope parser preserve it instead of dropping it. The posted review body renders it as `cause:` / `unscanned:` right below the verdict (and tally, when present), while every other verdict's body is byte-identical to before.
- **Sandbox image harness inputs moved to 4.0.2**: the omp image's plugin clone ref and its preinstalled `@mstar-harness/cli` pin now follow tag `v4.0.2`.

<!-- CN -->
- **采用 engine 4.0.2**：`@mstar-harness/engine` 4.0.1 → 4.0.2，新增 PR 审查的第四种中性结论 `incomplete` 与 engine 输出的 tally `band`；两处审查输出 schema 均已声明，合法深度审查 yield 不再因此被拒。
- **`incomplete` 结论及其必需事实**：PR 审查现在可报告 `incomplete` 并附带 `{ reason, unscanned }`——声明的原因与本次未覆盖的范围（范围列表可为空）。该事实仅由 `incomplete` 结论携带、在其他结论下被拒绝，若提供 tally 则必须原样回显；深度父会话 yield schema 与 envelope 解析器都会保留它，不再丢弃。发布的审查正文会在结论（及存在时的 tally）下方渲染 `cause:` / `unscanned:`，其他结论的正文与之前逐字节一致。
- **沙箱镜像的 harness 输入升至 4.0.2**：omp 镜像的插件 clone ref 与预装的 `@mstar-harness/cli` pin 均跟随标签 `v4.0.2`。
