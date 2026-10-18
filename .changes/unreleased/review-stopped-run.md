---
category: Changed
---

- **A stopped review seat no longer fails the run**: when a quick/default review has any seat stopped by its wall-clock cap, the run now publishes an `incomplete` verdict stating the cause and the scope that was never covered — one entry per stopped seat, each naming that seat's assigned scope — instead of throwing the whole review away; findings collected from the seats that did return are retained, so the run is reported as not settled rather than lost.
- **The posted body states the cause/scope pair exactly once and bounded**: the cause and unscanned lines the renderer emits are capped per line with an ellipsis, and machine-written duplicates of those lines are stripped from the rendered summary only — the stored envelope keeps the validated values — while a run with no stopped seat stays byte-identical to before.

<!-- CN -->
- **停止的审查席位不再导致整轮失败**：quick/default 审查只要有席位被墙钟上限停止，就会发布 `incomplete` 结论，声明原因与从未覆盖的范围——每个被停止的席位一条，各自标明该席位被分配的范围——而不再丢弃整轮审查；已返回席位收集到的发现会被保留，因此该轮被如实报告为「未定论」而不是丢失。
- **发布正文中的原因/范围对只出现一次且有界**：渲染器输出的 cause 与 unscanned 行按行截断并加省略号，摘要中由模型写入的重复行仅在渲染时剔除（存储的 envelope 仍保留已验证的取值）；没有席位被停止的轮次与之前逐字节一致。
